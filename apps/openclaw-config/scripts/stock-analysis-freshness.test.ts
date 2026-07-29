import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openTradingDatabase } from "../../../packages/shared-types/dist/index.js";
import type { DatabaseSync } from "node:sqlite";

const freshness = await import("./stock-analysis-freshness.mjs");
const stockAnalysis = await import("./stock-analysis.mjs");

const resolveReportPaths = stockAnalysis.resolveReportPaths as (
  reportsDir: string,
  label: string,
  deliver: boolean
) => { markdownPath: string; pdfPath: string };

const tempDirs: string[] = [];

function makeDb(): { db: DatabaseSync; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-stock-freshness-"));
  tempDirs.push(dir);
  return { db: openTradingDatabase(join(dir, "trading.sqlite")), dir };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/**
 * Writes a `stock_analysis_runs` row the way the ONLY producer of that table
 * writes one.
 *
 * The two load-bearing columns here are `created_at` and `markdown_path`, and
 * neither is authored by this test:
 *   - `created_at` is `generatedAt` verbatim (stock-analysis.mjs's insert
 *     passes `generatedAt`, the same ISO string that becomes the report label
 *     via `generatedAt.slice(0, 10)`);
 *   - `markdown_path` is whatever `resolveReportPaths` returns - the exact
 *     exported function runAnalysis calls to compute it, imported here rather
 *     than re-typed, so a change to the archive's path convention breaks this
 *     test instead of silently going unnoticed by it.
 *
 * The INSERT column list is copied from stock-analysis.mjs's own statement;
 * `symbols`/`pdf_path`/`delivery` are not read by anything under test.
 */
function insertRunLikeTheProducer(db: DatabaseSync, reportsDir: string, generatedAt: string): string {
  const label = generatedAt.slice(0, 10);
  const { markdownPath, pdfPath } = resolveReportPaths(reportsDir, label, true);
  const id = `stock_analysis_run_${label}`;
  db.prepare(`
    INSERT INTO stock_analysis_runs (id, created_at, symbols, markdown_path, pdf_path, delivery)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, generatedAt, JSON.stringify(["TSM.US"]), markdownPath, pdfPath, JSON.stringify({ sent: true }));
  return id;
}

describe("reportLabelFromPath", () => {
  it("reads the batch label off the archive path the producer actually wrote", () => {
    const { dir } = makeDb();
    const { markdownPath } = resolveReportPaths(join(dir, "reports", "stock-analysis"), "2026-07-27", true);

    expect(freshness.reportLabelFromPath(markdownPath)).toBe("2026-07-27");
  });

  it("reads the label off the literal path stored on the deployed mini", () => {
    // Verbatim from the live db:
    //   sqlite3 runtime/trading.sqlite 'SELECT markdown_path FROM stock_analysis_runs'
    //   -> /Users/qingchang/AlphaLoop/reports/stock-analysis/2026-07-27.md
    expect(freshness.reportLabelFromPath("/Users/qingchang/AlphaLoop/reports/stock-analysis/2026-07-27.md"))
      .toBe("2026-07-27");
  });

  it("returns null rather than guessing for a path that is not a dated report", () => {
    expect(freshness.reportLabelFromPath("/x/reports/stock-analysis/2026-07-27-preview.md")).toBeNull();
    expect(freshness.reportLabelFromPath("/x/reports/stock-analysis/latest.md")).toBeNull();
    expect(freshness.reportLabelFromPath(undefined)).toBeNull();
  });
});

describe("computeStockAnalysisFreshness: judges what is on display, not what the state file claims", () => {
  it("calls a never-produced pipeline stale and says so", () => {
    const { db } = makeDb();

    const result = freshness.computeStockAnalysisFreshness(db, new Date("2026-07-30T13:00:00.000Z"));

    expect(result.latestLabel).toBeNull();
    expect(result.ageDays).toBeNull();
    expect(result.stale).toBe(true);
    expect(result.reason).toBe("从未产出过个股分析批次");
  });

  it("is not stale while the batch is merely due", () => {
    const { db, dir } = makeDb();
    insertRunLikeTheProducer(db, join(dir, "reports", "stock-analysis"), "2026-07-27T16:35:02.483Z");

    // 3 days: the next batch is due today, and today's run is about to produce
    // it. Nothing has gone wrong yet.
    const result = freshness.computeStockAnalysisFreshness(db, new Date("2026-07-30T13:00:00.000Z"));

    expect(result.latestLabel).toBe("2026-07-27");
    expect(result.ageDays).toBe(3);
    expect(result.stale).toBe(false);
  });

  it("calls it stale once a whole scheduled slot has passed with no new batch", () => {
    const { db, dir } = makeDb();
    insertRunLikeTheProducer(db, join(dir, "reports", "stock-analysis"), "2026-07-27T16:35:02.483Z");

    const result = freshness.computeStockAnalysisFreshness(db, new Date("2026-07-31T13:00:00.000Z"));

    expect(result.ageDays).toBe(4);
    expect(result.staleAfterDays).toBe(4);
    expect(result.stale).toBe(true);
    expect(result.reason).toBe("最新批次为 2026-07-27，已过去 4 天，超过 4 天上限");
  });

  it("reads the NEWEST batch when several are archived", () => {
    const { db, dir } = makeDb();
    const reportsDir = join(dir, "reports", "stock-analysis");
    insertRunLikeTheProducer(db, reportsDir, "2026-07-21T13:04:00.000Z");
    insertRunLikeTheProducer(db, reportsDir, "2026-07-27T16:35:02.483Z");
    insertRunLikeTheProducer(db, reportsDir, "2026-07-24T13:11:00.000Z");

    const result = freshness.computeStockAnalysisFreshness(db, new Date("2026-07-28T13:00:00.000Z"));

    expect(result.latestLabel).toBe("2026-07-27");
    expect(result.latestRunAt).toBe("2026-07-27T16:35:02.483Z");
    expect(result.ageDays).toBe(1);
    expect(result.stale).toBe(false);
  });

  it("refuses to vouch for a future-dated batch instead of reading it as fresh", () => {
    const { db, dir } = makeDb();
    insertRunLikeTheProducer(db, join(dir, "reports", "stock-analysis"), "2026-08-02T13:00:00.000Z");

    const result = freshness.computeStockAnalysisFreshness(db, new Date("2026-07-30T13:00:00.000Z"));

    expect(result.ageDays).toBe(-3);
    expect(result.stale).toBe(true);
    expect(result.reason).toContain("晚于当前日期");
  });
});

describe("describeStockAnalysisFreshness", () => {
  it("tells the operator, in Chinese, that displayed levels are not current prices", () => {
    const { db, dir } = makeDb();
    insertRunLikeTheProducer(db, join(dir, "reports", "stock-analysis"), "2026-07-27T16:35:02.483Z");

    const text = freshness.describeStockAnalysisFreshness(
      freshness.computeStockAnalysisFreshness(db, new Date("2026-07-31T13:00:00.000Z"))
    );

    expect(text).toContain("个股分析已停摆");
    expect(text).toContain("2026-07-27");
    expect(text).toContain("不可当作当前价位使用");
  });

  it("does not cry stall when the pipeline is inside its cadence", () => {
    const { db, dir } = makeDb();
    insertRunLikeTheProducer(db, join(dir, "reports", "stock-analysis"), "2026-07-27T16:35:02.483Z");

    const text = freshness.describeStockAnalysisFreshness(
      freshness.computeStockAnalysisFreshness(db, new Date("2026-07-29T13:00:00.000Z"))
    );

    expect(text).toContain("未超期");
    expect(text).not.toContain("停摆");
  });
});
