import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scanReports } from "./scanner.js";

let repoRoot: string;

function reportsDir(type: string): string {
  return join(repoRoot, "reports", type);
}

function writeReport(type: string, filename: string, content: string): void {
  const dir = reportsDir(type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, "utf8");
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "platform-app-scanner-"));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe("scanReports", () => {
  it("scans daily/weekly/stock-analysis/official-paper, mirroring the real reports/ layout", () => {
    writeReport("daily", "2026-06-19.md", "# 日报 2026-06-19\n\n内容。\n");
    writeReport("daily", "2026-06-14.md", "# 日报 2026-06-14\n\n内容。\n");
    writeReport("weekly", "2026-05-25.md", "# 周报 2026-05-25\n\n内容。\n");
    writeReport("stock-analysis", "2026-06-19.md", "# 个股分析 2026-06-19\n\n内容。\n");
    writeReport("official-paper", "2026-06-17-post-open.md", "# 模拟盘收支变化 2026-06-17\n\n内容。\n");

    const entries = scanReports(repoRoot);

    expect(entries).toHaveLength(5);
    expect(entries.map((e) => e.type).sort()).toEqual(
      ["daily", "daily", "official-paper", "stock-analysis", "weekly"].sort()
    );
  });

  it("excludes README.md from every directory", () => {
    writeReport("daily", "README.md", "# OpenClaw 日报\n\n说明文档，不是报告。\n");
    writeReport("daily", "2026-06-19.md", "# 日报 2026-06-19\n\n内容。\n");

    const entries = scanReports(repoRoot);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.mdPath).toContain("2026-06-19.md");
  });

  it("ignores .pdf siblings (PDF is retired)", () => {
    writeReport("daily", "2026-06-19.md", "# 日报 2026-06-19\n\n内容。\n");
    writeFileSync(join(reportsDir("daily"), "2026-06-19.pdf"), "not a real pdf", "utf8");

    const entries = scanReports(repoRoot);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.mdPath).toMatch(/\.md$/u);
  });

  it("parses official-paper's <date>-post-open.md naming and rejects the plain-date pattern for it", () => {
    writeReport("official-paper", "2026-06-17-post-open.md", "# 模拟盘收支变化 2026-06-17\n\n内容。\n");
    // A plain `<date>.md` (no `-post-open` suffix) in official-paper/ should
    // NOT be picked up - it doesn't match this type's naming convention.
    writeReport("official-paper", "2026-06-18.md", "# 不应被识别\n\n内容。\n");

    const entries = scanReports(repoRoot);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: "official-paper", date: "2026-06-17" });
  });

  it("extracts the title from the first `# ` heading line", () => {
    writeReport(
      "daily",
      "2026-06-19.md",
      "窗口：2026-06-18 20:00 - 2026-06-19 20:00\n\n# OpenClaw 日报 2026-06-19\n\n内容。\n"
    );

    const entries = scanReports(repoRoot);

    // The first `# ` line anywhere in the file counts, even if preceded by
    // non-heading text.
    expect(entries[0]?.title).toBe("OpenClaw 日报 2026-06-19");
  });

  it("falls back to the filename when there is no `# ` heading", () => {
    writeReport("daily", "2026-06-19.md", "没有标题的报告。\n");

    const entries = scanReports(repoRoot);

    expect(entries[0]?.title).toBe("2026-06-19");
  });

  it("marks every current report as legacy (pre-P4/P5 format)", () => {
    writeReport("daily", "2026-06-19.md", "# 日报\n");

    const entries = scanReports(repoRoot);

    expect(entries[0]?.legacy).toBe(true);
  });

  it("sorts entries by date descending", () => {
    writeReport("daily", "2026-06-14.md", "# 日报 06-14\n");
    writeReport("daily", "2026-06-19.md", "# 日报 06-19\n");
    writeReport("weekly", "2026-05-25.md", "# 周报 05-25\n");

    const entries = scanReports(repoRoot);
    const dates = entries.map((e) => e.date);

    expect(dates).toEqual([...dates].sort().reverse());
  });

  it("returns an empty array for a report type whose directory doesn't exist", () => {
    // Only create daily/ - the other three type directories are absent.
    writeReport("daily", "2026-06-19.md", "# 日报\n");

    expect(() => scanReports(repoRoot)).not.toThrow();
    const entries = scanReports(repoRoot);
    expect(entries.every((e) => e.type === "daily")).toBe(true);
  });

  it("caches per-directory and does not pick up a new file until the directory's mtime changes", () => {
    writeReport("daily", "2026-06-14.md", "# 日报 06-14\n");
    const dir = reportsDir("daily");

    // Pin the directory's mtime to a value WE control (a whole-second Date,
    // no sub-millisecond component) rather than relying on whatever the OS
    // produced from the write above - real filesystem mtimes can carry
    // sub-millisecond precision that a round-trip through a JS Date loses,
    // making "restore the exact previous mtime" flaky. A round value we set
    // ourselves has nothing to lose in that round-trip.
    const pinned = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(dir, pinned, pinned);

    const first = scanReports(repoRoot);
    expect(first).toHaveLength(1);

    // Add a second file (this necessarily bumps the real mtime), then pin
    // the directory back to the SAME value the cache already has -
    // simulating "directory mtime did not change" deterministically.
    writeReport("daily", "2026-06-19.md", "# 日报 06-19\n");
    utimesSync(dir, pinned, pinned);

    const stale = scanReports(repoRoot);
    expect(stale).toHaveLength(1);

    // Now bump the directory's mtime forward to a distinct new value -
    // cache must invalidate and pick up the second file.
    const later = new Date("2030-01-01T00:00:00.000Z");
    utimesSync(dir, later, later);

    const fresh = scanReports(repoRoot);
    expect(fresh).toHaveLength(2);
  });
});
