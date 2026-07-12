#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getSchemaVersion, openTradingDatabase } from "../../../packages/shared-types/dist/index.js";

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
