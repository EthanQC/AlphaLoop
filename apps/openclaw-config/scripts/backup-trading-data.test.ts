import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SCHEMA_VERSION, openTradingDatabase } from "../../../packages/shared-types/dist/index.js";

const backup = await import("./backup-trading-data.mjs");
const restore = await import("./restore-trading-data.mjs");

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function seedTradingDb(dbPath: string): void {
  const db = openTradingDatabase(dbPath);
  db.prepare(`
    INSERT INTO audit_log (id, category, action, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run("audit_seed", "backup-test", "seed", "{}", Date.now());
  db.close();
}

describe("formatLocalDate", () => {
  it("converts a UTC instant near midnight to the correct Asia/Shanghai calendar date", () => {
    // 2026-07-12T20:15:00Z is 2026-07-13 04:15 in Shanghai (UTC+8).
    expect(backup.formatLocalDate(new Date("2026-07-12T20:15:00.000Z"), "Asia/Shanghai")).toBe("2026-07-13");
    expect(backup.formatLocalDate(new Date("2026-07-12T10:00:00.000Z"), "Asia/Shanghai")).toBe("2026-07-12");
  });
});

describe("escapeSqliteLiteral", () => {
  it("doubles embedded single quotes for safe SQL string-literal interpolation", () => {
    expect(backup.escapeSqliteLiteral("O'Brien")).toBe("O''Brien");
    expect(backup.escapeSqliteLiteral("plain")).toBe("plain");
  });
});

describe("backup -> mutate -> restore end-to-end", () => {
  it("snapshots a live trading db via VACUUM INTO, then restores the pre-mutation state", () => {
    const dbDir = makeTempDir("alphaloop-backup-db-");
    const destDir = makeTempDir("alphaloop-backup-dest-");
    const dbPath = join(dbDir, "trading.sqlite");
    seedTradingDb(dbPath);

    const now = new Date("2026-07-12T01:00:00.000Z");
    const result = backup.runBackup({ dbPath, dest: destDir, retentionDays: 30, now });

    expect(result.ok).toBe(true);
    expect(result.files).toEqual([join(destDir, "trading-2026-07-12.sqlite")]);
    expect(result.skipped).toEqual([]);
    expect(existsSync(result.files[0])).toBe(true);

    // Confirm the snapshot is a real, independently-queryable sqlite file with full schema.
    const snapshotDb = new DatabaseSync(result.files[0]);
    const row = snapshotDb.prepare("SELECT id FROM audit_log WHERE id = ?").get("audit_seed") as { id: string } | undefined;
    expect(row?.id).toBe("audit_seed");
    snapshotDb.close();

    // Mutate the live db after the backup was taken.
    const liveDb = openTradingDatabase(dbPath);
    liveDb.prepare(`
      INSERT INTO audit_log (id, category, action, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("audit_after_backup", "backup-test", "mutate", "{}", Date.now());
    liveDb.close();

    const restoredPath = join(dbDir, "restored.sqlite");
    const restoreResult = restore.runRestore({ from: result.files[0], to: restoredPath });

    expect(restoreResult.ok).toBe(true);
    expect(restoreResult.schemaVersion).toBe(SCHEMA_VERSION);

    const restoredDb = new DatabaseSync(restoredPath);
    const seededRow = restoredDb.prepare("SELECT id FROM audit_log WHERE id = ?").get("audit_seed") as { id: string } | undefined;
    const mutatedRow = restoredDb.prepare("SELECT id FROM audit_log WHERE id = ?").get("audit_after_backup") as { id: string } | undefined;
    expect(seededRow?.id).toBe("audit_seed");
    expect(mutatedRow).toBeUndefined();
    restoredDb.close();
  });

  it("refuses to overwrite an existing restore target without --force, but succeeds with it", () => {
    const dbDir = makeTempDir("alphaloop-restore-db-");
    const destDir = makeTempDir("alphaloop-restore-dest-");
    const dbPath = join(dbDir, "trading.sqlite");
    seedTradingDb(dbPath);

    const result = backup.runBackup({ dbPath, dest: destDir, retentionDays: 30, now: new Date("2026-07-12T01:00:00.000Z") });
    const targetPath = join(dbDir, "target.sqlite");
    writeFileSync(targetPath, "not a real sqlite file");

    expect(() => restore.runRestore({ from: result.files[0], to: targetPath })).toThrow(/already exists/u);

    const forced = restore.runRestore({ from: result.files[0], to: targetPath, force: true });
    expect(forced.ok).toBe(true);
    expect(forced.schemaVersion).toBe(SCHEMA_VERSION);
  });
});

describe("memoryd archiving", () => {
  it("tars the memoryd root into the dest directory when it exists", () => {
    const dbDir = makeTempDir("alphaloop-memoryd-db-");
    const destDir = makeTempDir("alphaloop-memoryd-dest-");
    const memorydRoot = makeTempDir("alphaloop-memoryd-root-");
    const dbPath = join(dbDir, "trading.sqlite");
    seedTradingDb(dbPath);
    writeFileSync(join(memorydRoot, "notes.md"), "# memoryd notes");

    const now = new Date("2026-07-12T01:00:00.000Z");
    const result = backup.runBackup({ dbPath, dest: destDir, retentionDays: 30, memorydRoot, now });

    const tgzPath = join(destDir, "memoryd-2026-07-12.tgz");
    expect(result.files).toContain(tgzPath);
    expect(result.skipped).toEqual([]);
    expect(existsSync(tgzPath)).toBe(true);

    const listing = spawnSync("tar", ["-tzf", tgzPath], { encoding: "utf8" });
    expect(listing.status).toBe(0);
    expect(listing.stdout).toContain("notes.md");
  });

  it("skips the memoryd archive with a note instead of failing when the root is missing", () => {
    const dbDir = makeTempDir("alphaloop-memoryd-missing-db-");
    const destDir = makeTempDir("alphaloop-memoryd-missing-dest-");
    const dbPath = join(dbDir, "trading.sqlite");
    seedTradingDb(dbPath);
    const missingRoot = join(destDir, "does-not-exist");

    const result = backup.runBackup({ dbPath, dest: destDir, retentionDays: 30, memorydRoot: missingRoot, now: new Date("2026-07-12T01:00:00.000Z") });

    expect(result.ok).toBe(true);
    expect(result.files).toEqual([join(destDir, "trading-2026-07-12.sqlite")]);
    expect(result.skipped).toEqual([{ path: missingRoot, reason: "memoryd-root-missing" }]);
    expect(existsSync(join(destDir, "memoryd-2026-07-12.tgz"))).toBe(false);
  });
});

describe("retention cleanup", () => {
  it("deletes backups older than retentionDays by file-name date, ignoring mtime", () => {
    const dbDir = makeTempDir("alphaloop-retention-db-");
    const destDir = makeTempDir("alphaloop-retention-dest-");
    const dbPath = join(dbDir, "trading.sqlite");
    seedTradingDb(dbPath);

    // Freshly-written files (recent mtime) but with old file-name dates: retention must key
    // off the name, not the filesystem mtime, or this assertion would fail.
    const staleSqlite = join(destDir, "trading-2020-01-01.sqlite");
    const staleTarball = join(destDir, "memoryd-2020-01-01.tgz");
    const recentSqlite = join(destDir, "trading-2026-06-20.sqlite");
    writeFileSync(staleSqlite, "stale");
    writeFileSync(staleTarball, "stale");
    writeFileSync(recentSqlite, "recent");

    const now = new Date("2026-07-12T01:00:00.000Z");
    const result = backup.runBackup({ dbPath, dest: destDir, retentionDays: 30, now });

    expect(result.deleted.sort()).toEqual([staleSqlite, staleTarball].sort());
    expect(existsSync(staleSqlite)).toBe(false);
    expect(existsSync(staleTarball)).toBe(false);
    expect(existsSync(recentSqlite)).toBe(true);
    expect(existsSync(join(destDir, "trading-2026-07-12.sqlite"))).toBe(true);
  });

  it("ignores unrelated files in the destination directory", () => {
    const destDir = makeTempDir("alphaloop-retention-unrelated-dest-");
    writeFileSync(join(destDir, "README.md"), "not a backup");
    writeFileSync(join(destDir, "trading-not-a-date.sqlite"), "malformed name");

    const deleted = backup.applyRetention(destDir, 30, new Date("2026-07-12T01:00:00.000Z"));

    expect(deleted).toEqual([]);
    expect(readdirSync(destDir).sort()).toEqual(["README.md", "trading-not-a-date.sqlite"].sort());
  });
});

describe("path handling for VACUUM INTO", () => {
  it("backs up correctly even when the destination directory name contains a single quote", () => {
    const dbDir = makeTempDir("alphaloop-quote-db-");
    const parentDir = makeTempDir("alphaloop-quote-parent-");
    const destDir = join(parentDir, "back'up");
    mkdirSync(destDir, { recursive: true });
    const dbPath = join(dbDir, "trading.sqlite");
    seedTradingDb(dbPath);

    const result = backup.runBackup({ dbPath, dest: destDir, retentionDays: 30, now: new Date("2026-07-12T01:00:00.000Z") });

    expect(result.ok).toBe(true);
    expect(existsSync(result.files[0])).toBe(true);
    const snapshotDb = new DatabaseSync(result.files[0]);
    const row = snapshotDb.prepare("SELECT id FROM audit_log WHERE id = ?").get("audit_seed") as { id: string } | undefined;
    expect(row?.id).toBe("audit_seed");
    snapshotDb.close();
  });
});

describe("runBackup error handling", () => {
  it("throws a clear error when the source trading database does not exist", () => {
    const destDir = makeTempDir("alphaloop-missing-db-dest-");
    expect(() => backup.runBackup({
      dbPath: join(destDir, "does-not-exist.sqlite"),
      dest: destDir,
      retentionDays: 30
    })).toThrow(/not found/u);
  });
});

describe("same-day re-runs", () => {
  it("is idempotent: running the backup twice for the same calendar day overwrites rather than failing", () => {
    // VACUUM INTO refuses to run if its destination file already exists, so without an
    // explicit overwrite this would throw "output file already exists" on the second call
    // (e.g. a manual re-run, or launchd catching up a missed run after sleep/wake).
    const dbDir = makeTempDir("alphaloop-rerun-db-");
    const destDir = makeTempDir("alphaloop-rerun-dest-");
    const dbPath = join(dbDir, "trading.sqlite");
    seedTradingDb(dbPath);
    const now = new Date("2026-07-12T01:00:00.000Z");

    const first = backup.runBackup({ dbPath, dest: destDir, retentionDays: 30, now });
    expect(first.ok).toBe(true);

    const second = backup.runBackup({ dbPath, dest: destDir, retentionDays: 30, now });
    expect(second.ok).toBe(true);
    expect(second.files).toEqual(first.files);

    const snapshotDb = new DatabaseSync(second.files[0]);
    const row = snapshotDb.prepare("SELECT id FROM audit_log WHERE id = ?").get("audit_seed") as { id: string } | undefined;
    expect(row?.id).toBe("audit_seed");
    snapshotDb.close();
  });
});

describe("retention failure isolation", () => {
  it("still reports ok:true with the files it created when retention cleanup itself errors", () => {
    const dbDir = makeTempDir("alphaloop-retention-fail-db-");
    const destDir = makeTempDir("alphaloop-retention-fail-dest-");
    const dbPath = join(dbDir, "trading.sqlite");
    seedTradingDb(dbPath);

    // A directory sitting where a stale backup file is expected makes `rmSync` (without
    // `recursive: true`) throw a real, non-ENOENT error - a stand-in for e.g. a permission
    // failure during cleanup of one old file among many.
    const stubbornEntry = join(destDir, "trading-2020-01-01.sqlite");
    mkdirSync(stubbornEntry);
    const staleFile = join(destDir, "memoryd-2020-01-01.tgz");
    writeFileSync(staleFile, "stale");

    const now = new Date("2026-07-12T01:00:00.000Z");
    const result = backup.runBackup({ dbPath, dest: destDir, retentionDays: 30, now });

    expect(result.ok).toBe(true);
    expect(result.files).toEqual([join(destDir, "trading-2026-07-12.sqlite")]);
    expect(existsSync(result.files[0])).toBe(true);
    expect(result.retentionError).toBeTruthy();
    // The stubborn directory survives, but cleanup still made progress on the other stale file.
    expect(existsSync(stubbornEntry)).toBe(true);
    expect(existsSync(staleFile)).toBe(false);
    expect(result.deleted).toEqual([staleFile]);
  });
});
