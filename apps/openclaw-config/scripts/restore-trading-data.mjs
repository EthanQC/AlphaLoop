#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getSchemaVersion, openTradingDatabase } from "../../../packages/shared-types/dist/index.js";

/**
 * Opens `path` read-only and runs a trivial query against it, purely to confirm it is a legal,
 * readable SQLite database BEFORE any destructive step (sidecar removal, copy) touches the
 * restore target. Without this, a corrupt/truncated/non-sqlite backup file only failed once
 * `openTradingDatabase(to)` ran the migration chain AFTER `to` had already been overwritten -
 * destroying whatever good database used to live there, then reporting the error too late to
 * matter. Throws with a clear message on anything that isn't a valid SQLite file; never mutates
 * `path` (opened read-only).
 */
function assertLegalSqliteBackup(path) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.prepare("SELECT count(*) AS c FROM sqlite_master").get();
  } catch (error) {
    throw new Error(
      `Backup file is not a valid SQLite database: ${path} ` +
      `(${error instanceof Error ? error.message : String(error)})`
    );
  } finally {
    db?.close();
  }
}

/**
 * Restores a `VACUUM INTO` trading-db snapshot at `from` onto `to`.
 * Refuses to clobber an existing target unless `force` is set. After copying, opens the
 * restored file through `openTradingDatabase` (which runs the migration chain) and reports
 * the resulting schema version.
 */
export function runRestore({ from, to, force = false }) {
  if (!from) {
    throw new Error("Missing required --from <backup-file>");
  }
  if (!to) {
    throw new Error("Missing required --to <db-path>");
  }
  if (!existsSync(from)) {
    throw new Error(`Backup file not found: ${from}`);
  }
  if (existsSync(to) && !force) {
    throw new Error(`Target database already exists: ${to} (use --force to overwrite)`);
  }

  // Validate BEFORE any of the destructive steps below (sidecar removal, copy) - this is the one
  // guard that stands between a corrupt/bogus backup file and a good target database it would
  // otherwise clobber first and only report as broken afterward.
  assertLegalSqliteBackup(from);

  mkdirSync(dirname(to), { recursive: true });

  // Drop any stale WAL/SHM sidecars for the target so the restored file isn't shadowed by
  // leftover write-ahead-log state from whatever used to live at `to`.
  for (const suffix of ["-wal", "-shm"]) {
    const sidecarPath = `${to}${suffix}`;
    if (existsSync(sidecarPath)) {
      rmSync(sidecarPath, { force: true });
    }
  }

  copyFileSync(from, to);

  const db = openTradingDatabase(to);
  const schemaVersion = getSchemaVersion(db);
  db.close();

  return { ok: true, schemaVersion };
}

function readFlagValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const from = readFlagValue(args, "--from");
  const to = readFlagValue(args, "--to");
  const force = args.includes("--force");

  try {
    const result = runRestore({ from, to, force });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}

const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  await main();
}
