#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRuntimePaths } from "../../../packages/shared-types/dist/index.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const BACKUP_FILE_PATTERN = /^(?:trading|memoryd)-(\d{4}-\d{2}-\d{2})\.(?:sqlite|tgz)$/u;

/**
 * Formats a date as a YYYY-MM-DD calendar date in the given IANA time zone.
 * Defaults to Asia/Shanghai since backups are stamped by local trading-desk date.
 */
export function formatLocalDate(date, timeZone = "Asia/Shanghai") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

/** Doubles embedded single quotes so a path can be safely inlined into a SQL string literal. */
export function escapeSqliteLiteral(value) {
  return String(value).replace(/'/gu, "''");
}

/** Extracts the YYYY-MM-DD stamp encoded in a `trading-*.sqlite` / `memoryd-*.tgz` backup file name. */
export function parseBackupFileDate(fileName) {
  const match = BACKUP_FILE_PATTERN.exec(fileName);
  return match ? match[1] : null;
}

/**
 * Deletes backup files in `dest` whose *file-name* date is older than `retentionDays`,
 * relative to `now`. Deliberately ignores mtime so retention stays deterministic and testable.
 */
export function applyRetention(dest, retentionDays, now = new Date(), timeZone = "Asia/Shanghai") {
  const deleted = [];
  if (!existsSync(dest)) {
    return deleted;
  }

  const todayMs = Date.parse(`${formatLocalDate(now, timeZone)}T00:00:00Z`);
  let firstError;

  for (const entry of readdirSync(dest)) {
    const dateStamp = parseBackupFileDate(entry);
    if (!dateStamp) {
      continue;
    }

    const fileMs = Date.parse(`${dateStamp}T00:00:00Z`);
    const ageDays = Math.floor((todayMs - fileMs) / 86_400_000);
    if (ageDays > retentionDays) {
      const filePath = join(dest, entry);
      try {
        rmSync(filePath, { force: true });
        deleted.push(filePath);
      } catch (error) {
        // Keep cleaning up the rest of the eligible files; surface the first failure once
        // the sweep is done instead of abandoning cleanup after a single bad entry.
        firstError ??= error;
      }
    }
  }

  if (firstError) {
    firstError.deleted = deleted;
    throw firstError;
  }

  return deleted;
}

/** Snapshots `dbPath` into `destPath` using VACUUM INTO (safe for a live WAL-mode database). */
export function backupTradingDatabase(dbPath, destPath) {
  if (destPath.includes("\0")) {
    throw new Error(`Refusing to back up to an invalid path: ${destPath}`);
  }

  // VACUUM INTO refuses to run if its output file already exists, so write to a sibling `.tmp`
  // path and atomically rename it over `destPath` once VACUUM INTO succeeds. This keeps same-day
  // re-runs idempotent (rename overwrites today's existing snapshot) without ever deleting a
  // previously-good same-day backup up front: if a re-run's VACUUM INTO fails partway through
  // (disk full, busy timeout), `destPath` is never touched, so the last good backup survives.
  const tmpPath = `${destPath}.tmp`;

  // Clean up any stale tmp file left behind by a previous crashed/interrupted run.
  if (existsSync(tmpPath)) {
    rmSync(tmpPath, { force: true });
  }

  const sourceDb = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
  try {
    try {
      sourceDb.exec(`VACUUM INTO '${escapeSqliteLiteral(tmpPath)}'`);
    } finally {
      sourceDb.close();
    }
  } catch (error) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup only; the VACUUM failure below is the error that actually matters.
    }
    throw error;
  }

  // VACUUM INTO succeeded; atomically replace the destination with the finished snapshot.
  renameSync(tmpPath, destPath);
}

/** Archives `memorydRoot` into a gzip tarball at `destPath`. */
export function backupMemorydRoot(memorydRoot, destPath) {
  const result = spawnSync("tar", ["-czf", destPath, "-C", memorydRoot, "."], {
    stdio: ["ignore", "ignore", "pipe"]
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`tar exited with status ${result.status}: ${result.stderr?.toString("utf8") ?? ""}`);
  }
}

/**
 * Runs a full daily backup: trading DB snapshot, optional memoryd tarball, then retention cleanup.
 * Returns `{ ok, files, skipped, deleted }` and never touches process state — callers decide how
 * to report/exit.
 */
export function runBackup({
  dbPath,
  dest,
  retentionDays = 30,
  memorydRoot,
  now = new Date(),
  timeZone = "Asia/Shanghai"
}) {
  if (!dbPath) {
    throw new Error("dbPath is required");
  }
  if (!existsSync(dbPath)) {
    throw new Error(`Trading database not found: ${dbPath}`);
  }

  mkdirSync(dest, { recursive: true });
  const dateStamp = formatLocalDate(now, timeZone);

  const files = [];
  const skipped = [];

  const tradingBackupPath = join(dest, `trading-${dateStamp}.sqlite`);
  backupTradingDatabase(dbPath, tradingBackupPath);
  files.push(tradingBackupPath);

  if (memorydRoot) {
    if (existsSync(memorydRoot) && statSync(memorydRoot).isDirectory()) {
      const memorydBackupPath = join(dest, `memoryd-${dateStamp}.tgz`);
      backupMemorydRoot(memorydRoot, memorydBackupPath);
      files.push(memorydBackupPath);
    } else {
      skipped.push({ path: memorydRoot, reason: "memoryd-root-missing" });
    }
  }

  // Retention is best-effort housekeeping: a fresh trading/memoryd snapshot has already been
  // written to disk above, so a cleanup failure (e.g. a permission error deleting an old file)
  // must not be reported as "backup failed" and must not hide the files that did get created.
  let deleted = [];
  let retentionError;
  try {
    deleted = applyRetention(dest, retentionDays, now, timeZone);
  } catch (error) {
    deleted = Array.isArray(error?.deleted) ? error.deleted : [];
    retentionError = error instanceof Error ? error.message : String(error);
  }

  return {
    ok: true,
    files,
    skipped,
    deleted,
    ...(retentionError ? { retentionError } : {})
  };
}

function readFlagValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const dest = resolve(readFlagValue(args, "--dest") ?? join(repoRoot, "runtime", "backups"));
  const retentionDaysArg = readFlagValue(args, "--retention-days");
  const retentionDays = retentionDaysArg !== undefined && Number.isFinite(Number(retentionDaysArg))
    ? Number(retentionDaysArg)
    : 30;
  const memorydRoot = readFlagValue(args, "--memoryd-root");
  const dbPath = resolveRuntimePaths(repoRoot).dbPath;

  try {
    const result = runBackup({ dbPath, dest, retentionDays, memorydRoot });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      files: [],
      skipped: [],
      deleted: []
    }));
    process.exitCode = 1;
  }
}

const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  await main();
}
