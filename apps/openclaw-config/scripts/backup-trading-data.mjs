#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRuntimePaths } from "../../../packages/shared-types/dist/index.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const BACKUP_FILE_PATTERN = /^(?:trading|memoryd)-(\d{4}-\d{2}-\d{2})\.(?:sqlite|tgz)$/u;

// Matches the sibling `.tmp` file backupTradingDatabase() writes mid-VACUUM-INTO. Its OWN crash
// recovery only ever cleans up the exact tmpPath for the run it's about to start (same day) - a
// tmp file stamped with a PREVIOUS day's date is a hard-crash leftover (process killed mid-VACUUM
// before the rename) that nothing else will ever revisit, so without this it lingers forever.
const TMP_BACKUP_FILE_PATTERN = /^(?:trading|memoryd)-(\d{4}-\d{2}-\d{2})\.(?:sqlite|tgz)\.tmp$/u;

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
 * Rejects a `retentionDays` that cannot possibly mean "how many days of backups to keep": NaN,
 * Infinity, or negative. A negative value used to sail straight through `ageDays > retentionDays`
 * (e.g. -1 makes even TODAY's just-written backup, ageDays 0, satisfy `0 > -1`) and delete the
 * backup runBackup() had just created moments earlier, all while `runBackup()` still returned
 * `ok: true`. Thrown eagerly, before the sweep loop below ever runs, so an invalid value can never
 * delete anything - not even one file - before being rejected.
 */
function assertValidRetentionDays(retentionDays) {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new Error(`retentionDays must be a finite number >= 0 (received ${retentionDays})`);
  }
}

/**
 * Deletes backup files in `dest` whose *file-name* date is older than `retentionDays`,
 * relative to `now`. Deliberately ignores mtime so retention stays deterministic and testable.
 * Also sweeps up stale cross-day `.tmp` leftovers from a hard-crashed VACUUM INTO run (see
 * TMP_BACKUP_FILE_PATTERN above) - these are pure garbage regardless of `retentionDays`, so ANY
 * `.tmp` file stamped with a date other than today's gets removed, unconditionally. A `.tmp` file
 * stamped with TODAY's date is left alone: it may be another backup run genuinely in flight right
 * now.
 */
export function applyRetention(dest, retentionDays, now = new Date(), timeZone = "Asia/Shanghai") {
  assertValidRetentionDays(retentionDays);

  const deleted = [];
  if (!existsSync(dest)) {
    return deleted;
  }

  const todayStamp = formatLocalDate(now, timeZone);
  const todayMs = Date.parse(`${todayStamp}T00:00:00Z`);
  let firstError;

  const tryDelete = (filePath) => {
    try {
      rmSync(filePath, { force: true });
      deleted.push(filePath);
    } catch (error) {
      // Keep cleaning up the rest of the eligible files; surface the first failure once
      // the sweep is done instead of abandoning cleanup after a single bad entry.
      firstError ??= error;
    }
  };

  for (const entry of readdirSync(dest)) {
    const dateStamp = parseBackupFileDate(entry);
    if (dateStamp) {
      const fileMs = Date.parse(`${dateStamp}T00:00:00Z`);
      const ageDays = Math.floor((todayMs - fileMs) / 86_400_000);
      if (ageDays > retentionDays) {
        tryDelete(join(dest, entry));
      }
      continue;
    }

    const tmpMatch = TMP_BACKUP_FILE_PATTERN.exec(entry);
    if (tmpMatch && tmpMatch[1] !== todayStamp) {
      tryDelete(join(dest, entry));
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
  // Validated here too (applyRetention validates it again below) so an invalid retentionDays is
  // rejected BEFORE this call does any work at all - not just before the retention sweep - and a
  // caller relying on runBackup's contract gets one consistent error regardless of which internal
  // step happens to notice first.
  assertValidRetentionDays(retentionDays);

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

/**
 * Parses the CLI's `--retention-days` value. `undefined` (flag omitted entirely) legitimately
 * means "use the default" - but a flag that WAS given and doesn't parse as a number (a typo, a
 * missing value swallowed by another flag, etc.) used to silently fall back to that same default
 * instead of telling the operator their flag was ignored. Only the lower-bound (>= 0) check is
 * left to runBackup/applyRetention (assertValidRetentionDays) - this function's job is strictly
 * "did the operator's input parse as a number at all".
 */
export function parseRetentionDaysArg(rawValue, defaultValue = 30) {
  if (rawValue === undefined) {
    return defaultValue;
  }
  // Number("") is 0 and Number("  ") is also 0 - JS's own coercion quirk, not a value any operator
  // actually typed - so an all-whitespace/empty string is treated as unparseable too, not "0 days".
  const parsed = rawValue.trim() === "" ? NaN : Number(rawValue);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--retention-days must be a number; received "${rawValue}"`);
  }
  return parsed;
}

async function main() {
  const args = process.argv.slice(2);
  const dest = resolve(readFlagValue(args, "--dest") ?? join(repoRoot, "runtime", "backups"));
  const memorydRoot = readFlagValue(args, "--memoryd-root");
  const dbPath = resolveRuntimePaths(repoRoot).dbPath;

  try {
    const retentionDays = parseRetentionDaysArg(readFlagValue(args, "--retention-days"));
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
