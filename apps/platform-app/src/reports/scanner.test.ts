import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scanOwnerScopedReports, scanReports } from "./scanner.js";

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
  it("scans the circle-visible types (daily/weekly/stock-analysis), mirroring the real reports/ layout", () => {
    writeReport("daily", "2026-06-19.md", "# 日报 2026-06-19\n\n内容。\n");
    writeReport("daily", "2026-06-14.md", "# 日报 2026-06-14\n\n内容。\n");
    writeReport("weekly", "2026-05-25.md", "# 周报 2026-05-25\n\n内容。\n");
    writeReport("stock-analysis", "2026-06-19.md", "# 个股分析 2026-06-19\n\n内容。\n");

    const entries = scanReports(repoRoot);

    expect(entries).toHaveLength(4);
    expect(entries.map((e) => e.type).sort()).toEqual(["daily", "daily", "stock-analysis", "weekly"].sort());
  });

  // Defect B1 (2026-07-28 adversarial review): `official-paper` artifacts are
  // one member's account statement (净资产/现金/持仓明细), so a caller that has
  // NOT resolved ownership must not be able to obtain them by accident. Every
  // caller that only shows circle-visible material (routes/home.ts,
  // routes/stock.ts, the /reports library list) uses scanReports; the single
  // owner-gated caller has to ask for them by name.
  it("never returns official-paper entries - owner-scoped artifacts need the explicit call", () => {
    writeReport("daily", "2026-06-19.md", "# 日报 2026-06-19\n\n内容。\n");
    writeReport("official-paper", "2026-06-17-post-open.md", "# 模拟盘收支变化 2026-06-17\n\n内容。\n");

    const entries = scanReports(repoRoot);

    expect(entries.map((e) => e.type)).toEqual(["daily"]);
    expect(entries.some((e) => e.mdPath.includes("official-paper"))).toBe(false);
  });

  it("scanOwnerScopedReports returns ONLY the official-paper entries, same shape as scanReports", () => {
    writeReport("daily", "2026-06-19.md", "# 日报 2026-06-19\n\n内容。\n");
    writeReport("official-paper", "2026-06-17-post-open.md", "# 模拟盘收支变化 2026-06-17\n\n内容。\n");
    writeReport("official-paper", "2026-05-31-post-open.md", "# 模拟盘收支变化 2026-05-31\n\n内容。\n");

    const entries = scanOwnerScopedReports(repoRoot);

    expect(entries.map((e) => e.type)).toEqual(["official-paper", "official-paper"]);
    expect(entries.map((e) => e.date)).toEqual(["2026-06-17", "2026-05-31"]); // newest first
    expect(entries[0]?.title).toBe("模拟盘收支变化 2026-06-17");
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

    const entries = scanOwnerScopedReports(repoRoot);

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

  // Task 12 (2026-07-30): `legacy` is decided PER FILE, from its own family's
  // format marker (reports/format-era.ts - whose test proves the markers are
  // the producers' own), not from a module-level "everything is old" constant.
  // The markers here come from that module's documented sources; format-era's
  // own suite is what pins them to report-quality.mjs / renderPnlReport.
  it("marks a report carrying its family's current-format marker as NOT legacy", () => {
    writeReport("daily", "2026-07-30.md", "# 日报\n\n### 多源新闻（事件聚类）\n\n- 事件：X。\n");
    writeReport("weekly", "2026-07-28.md", "# 周报\n\n### 多源新闻（事件聚类）\n\n- 事件：X。\n");
    writeReport("stock-analysis", "2026-07-27.md", "# 个股分析\n\n## AMZN.US\n\n### 结论框\n\n- 核心结论：持有。\n");

    const entries = scanReports(repoRoot);

    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.legacy)).toBe(false);
    for (const entry of entries) {
      expect(entry.legacy, entry.type).toBe(false);
    }
  });

  it("still marks a genuinely old report legacy - and judges each family by ITS own marker", () => {
    writeReport("daily", "2026-06-19.md", "# 日报\n\n## 1. 今日结论\n");
    // A stock analysis never contains the daily/weekly news marker; judging it
    // by that marker is exactly the bug this replaced, so the new-format stock
    // report above must not depend on it.
    writeReport("stock-analysis", "2026-06-19.md", "# 个股分析\n\n## 本批次结论\n");

    const entries = scanReports(repoRoot);

    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.legacy, entry.type).toBe(true);
    }
  });

  it("decides owner-scoped official-paper entries per file too", () => {
    writeReport(
      "official-paper",
      "2026-07-29-post-open.md",
      "# 模拟盘收支变化\n\n## 收支变化表\n\n| 对比项 | 该行净资产 | 该行现金 | 该行持仓估值 | 净资产变化（当前 − 该行） | 现金变化（当前 − 该行） |\n"
    );
    writeReport(
      "official-paper",
      "2026-05-31-post-open.md",
      "# 模拟盘收支变化\n\n## 收支变化表\n\n| 对比项 | 净资产 | 现金 | 持仓估值 | 净资产变化 | 现金变化 |\n"
    );

    const entries = scanOwnerScopedReports(repoRoot);

    expect(entries.find((entry) => entry.date === "2026-07-29")?.legacy).toBe(false);
    expect(entries.find((entry) => entry.date === "2026-05-31")?.legacy).toBe(true);
  });

  it("makes no legacy claim about a file it could not read", () => {
    writeReport("daily", "2026-06-19.md", "# 日报\n");
    // Directory entry present, file gone by the time contents are read.
    rmSync(join(reportsDir("daily"), "2026-06-19.md"));
    mkdirSync(join(reportsDir("daily"), "2026-06-19.md"));

    const entries = scanReports(repoRoot);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.legacy).toBe(false);
    expect(entries[0]?.title).toBe("2026-06-19");
  });

  it("sorts entries by date descending", () => {
    writeReport("daily", "2026-06-14.md", "# 日报 06-14\n");
    writeReport("daily", "2026-06-19.md", "# 日报 06-19\n");
    writeReport("weekly", "2026-05-25.md", "# 周报 05-25\n");

    const entries = scanReports(repoRoot);
    const dates = entries.map((e) => e.date);

    expect(dates).toEqual([...dates].sort().reverse());
  });

  // Phase 5 Task 5 (2026-07-15 plan) minor (b): stock-analysis.mjs's
  // `prepare` dry-run writes `<label>-preview.md`/`.pdf` instead of
  // overwriting the delivered `<label>.md`/`.pdf` archive (see stock-
  // analysis.mjs's resolveReportPaths). PLAIN_DATE_RE is anchored
  // (`^(\d{4}-\d{2}-\d{2})\.md$`), so a `-preview` suffix already fails to
  // match by construction - this test pins that down as an explicit,
  // regression-proof contract rather than an incidental side effect of the
  // regex's anchoring.
  it("ignores a stock-analysis <label>-preview.md sibling (prepare dry-run output, never a real report)", () => {
    writeReport("stock-analysis", "2026-07-15.md", "# 个股分析 2026-07-15\n\n内容。\n");
    writeReport("stock-analysis", "2026-07-15-preview.md", "# 个股分析 2026-07-15（预览）\n\n内容。\n");
    writeFileSync(join(reportsDir("stock-analysis"), "2026-07-15-preview.pdf"), "not a real pdf", "utf8");

    const entries = scanReports(repoRoot);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.mdPath).toMatch(/\/2026-07-15\.md$/u);
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
