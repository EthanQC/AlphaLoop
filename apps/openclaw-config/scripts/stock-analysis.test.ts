// Task H4 (phase2.5 hardening): stock-analysis.mjs's `targets` CLI + its
// setTargets() writer previously operated on a globally-shared watchlist
// (stock_analysis_targets.symbol was the sole PRIMARY KEY pre-v7) and wrote
// owner-less rows. Schema v7 (task H3) rebuilt the table with a composite
// PRIMARY KEY (symbol, owner_id), owner_id NOT NULL - so the old setTargets
// would now fail loudly against every real db (no owner_id to bind). This
// file is the first direct test coverage stock-analysis.mjs has ever had;
// see market-alerts-seam.test.ts for the writer (setTargets) <-> reader
// (isSymbolWatched) cross-module seam test, per this task's "writer-side
// and reader-side must be tested against each other" instruction.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { MemberRepository, openTradingDatabase } from "../../../packages/shared-types/dist/index.js";
import { parseConclusionBox } from "./conclusion-box.mjs";
import { validateStockAnalysisMarkdown } from "./report-quality.mjs";
import { getStockFacts } from "./stock-facts-store.mjs";

const stockAnalysis = await import("./stock-analysis.mjs");

const tempDirs: string[] = [];

function makeDb(): { db: DatabaseSync; dbPath: string; options: { dbPath: string } } {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-stock-analysis-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "trading.sqlite");
  const db = openTradingDatabase(dbPath);
  return { db, dbPath, options: { dbPath } };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function seedMember(db: DatabaseSync, id = "member_1", overrides: Partial<{ status: string }> = {}): void {
  new MemberRepository(db).upsert({
    id,
    email: `${id}@example.com`,
    displayName: id,
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: (overrides.status as "active" | "revoked") ?? "active",
    createdAt: "2026-07-01T00:00:00.000Z"
  });
}

function activeTargets(db: DatabaseSync, ownerId: string): string[] {
  const rows = db
    .prepare(`SELECT symbol FROM stock_analysis_targets WHERE owner_id = ? AND active = 1 ORDER BY symbol ASC`)
    .all(ownerId) as Array<{ symbol: string }>;
  return rows.map((r) => r.symbol);
}

describe("runTargetsCommand: --owner is required", () => {
  it("throws (does not silently operate on a global pool) when --owner is missing", () => {
    const { options } = makeDb();
    expect(() => stockAnalysis.runTargetsCommand(["NVDA"], options)).toThrow(/owner/);
  });

  it("throws when --owner is present but empty", () => {
    const { options } = makeDb();
    expect(() => stockAnalysis.runTargetsCommand(["--owner", "NVDA"], options)).toThrow(/owner/);
  });
});

describe("runTargetsCommand: owner validation", () => {
  it("rejects an owner id that does not exist in members", () => {
    const { options } = makeDb();
    expect(() => stockAnalysis.runTargetsCommand(["--owner", "no_such_member", "NVDA"], options)).toThrow(/成员/);
  });

  it("rejects a revoked (non-active) member", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1", { status: "revoked" });
    expect(() => stockAnalysis.runTargetsCommand(["--owner", "member_1", "NVDA"], options)).toThrow(/成员/);
  });

  it("rejects the legacy shared-pool sentinel as an --owner value", () => {
    const { db, options } = makeDb();
    expect(() => stockAnalysis.runTargetsCommand(["--owner", "__legacy_shared__", "NVDA"], options)).toThrow(/只读/);
    expect(db.prepare("SELECT COUNT(*) AS c FROM stock_analysis_targets").get()).toMatchObject({ c: 0 });
  });
});

describe("runTargetsCommand: successful writes are owner-scoped", () => {
  it("adds symbols under the given owner", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");

    const result = stockAnalysis.runTargetsCommand(["--owner", "member_1", "NVDA", "msft"], options);

    expect(result).toEqual({ ownerId: "member_1", saved: ["NVDA.US", "MSFT.US"] });
    expect(activeTargets(db, "member_1")).toEqual(["MSFT.US", "NVDA.US"]);
  });

  it("does not touch a different owner's rows", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");

    stockAnalysis.runTargetsCommand(["--owner", "member_1", "NVDA"], options);
    stockAnalysis.runTargetsCommand(["--owner", "member_2", "TSLA"], options);

    expect(activeTargets(db, "member_1")).toEqual(["NVDA.US"]);
    expect(activeTargets(db, "member_2")).toEqual(["TSLA.US"]);
  });

  it("soft-deletes (active=0) only THIS owner's previously-active rows on a subsequent call, scoped to that owner", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    stockAnalysis.runTargetsCommand(["--owner", "member_1", "NVDA"], options);
    stockAnalysis.runTargetsCommand(["--owner", "member_2", "AAPL"], options);

    stockAnalysis.runTargetsCommand(["--owner", "member_1", "MSFT"], options);

    expect(activeTargets(db, "member_1")).toEqual(["MSFT.US"]);
    // member_2's row must survive untouched - the soft-delete in setTargets
    // must be scoped by owner_id, not global (the pre-H4 behavior).
    expect(activeTargets(db, "member_2")).toEqual(["AAPL.US"]);

    const nvdaRow = db.prepare("SELECT active FROM stock_analysis_targets WHERE symbol = ? AND owner_id = ?").get("NVDA.US", "member_1") as { active: number };
    expect(nvdaRow.active).toBe(0);
  });

  it("never writes to or soft-deletes the legacy shared-pool sentinel's rows", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    db.prepare(`
      INSERT INTO stock_analysis_targets (symbol, owner_id, active, created_at, updated_at)
      VALUES ('AAPL.US', '__legacy_shared__', 1, ?, ?)
    `).run("2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");

    stockAnalysis.runTargetsCommand(["--owner", "member_1", "NVDA"], options);

    const legacyRow = db.prepare("SELECT active FROM stock_analysis_targets WHERE symbol = ? AND owner_id = ?").get("AAPL.US", "__legacy_shared__") as { active: number };
    expect(legacyRow.active).toBe(1);
  });
});

describe("runTargetsCommand: per-owner cap of 20", () => {
  it("rejects a submission of more than 20 symbols", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    const symbols = Array.from({ length: 21 }, (_, i) => `${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)}`);

    expect(() => stockAnalysis.runTargetsCommand(["--owner", "member_1", ...symbols], options)).toThrow(/20/);
    expect(activeTargets(db, "member_1")).toEqual([]);
  });

  it("accepts exactly 20 symbols", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    const symbols = Array.from({ length: 20 }, (_, i) => `${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)}`);

    const result = stockAnalysis.runTargetsCommand(["--owner", "member_1", ...symbols], options);
    expect(result.saved).toHaveLength(20);
    expect(activeTargets(db, "member_1")).toHaveLength(20);
  });
});

describe("setTargets (direct writer call)", () => {
  it("requires at least one symbol", () => {
    const { db } = makeDb();
    expect(() => stockAnalysis.setTargets(db, "member_1", [])).toThrow();
  });

  it("rejects the legacy shared-pool sentinel as an ownerId regardless of caller", () => {
    const { db } = makeDb();
    expect(() => stockAnalysis.setTargets(db, "__legacy_shared__", ["NVDA"])).toThrow(/只读/);
  });
});

// Task H7 (2026-07-14 legacy audit): one bad target used to kill the whole
// analysis batch with no isolation - see fetchStockAnalysisRecords's own
// doc comment. These tests exercise the isolation directly via dependency
// injection (an in-memory fetchRecord) rather than real network/Longbridge
// calls.
describe("fetchStockAnalysisRecords: per-symbol isolation", () => {
  it("isolates one symbol's failure and still returns the others' records", async () => {
    const fetchRecord = async (symbol: string) => {
      if (symbol === "BAD.US") {
        throw new Error("BAD.US 行情格式异常。");
      }
      return { symbol, analysis: {} };
    };

    const { records, failedSymbols } = await stockAnalysis.fetchStockAnalysisRecords(
      ["AAPL.US", "BAD.US", "MSFT.US"],
      { fetchRecord }
    );

    expect(records.map((r: { symbol: string }) => r.symbol)).toEqual(["AAPL.US", "MSFT.US"]);
    expect(failedSymbols).toEqual([{ symbol: "BAD.US", error: "BAD.US 行情格式异常。" }]);
  });

  it("returns every record when nothing fails", async () => {
    const fetchRecord = async (symbol: string) => ({ symbol, analysis: {} });

    const { records, failedSymbols } = await stockAnalysis.fetchStockAnalysisRecords(["AAPL.US"], { fetchRecord });

    expect(records).toHaveLength(1);
    expect(failedSymbols).toEqual([]);
  });

  it("reports every failure when the whole batch fails", async () => {
    const fetchRecord = async () => {
      throw new Error("行情读取失败。");
    };

    const { records, failedSymbols } = await stockAnalysis.fetchStockAnalysisRecords(["AAPL.US", "MSFT.US"], { fetchRecord });

    expect(records).toEqual([]);
    expect(failedSymbols).toEqual([
      { symbol: "AAPL.US", error: "行情读取失败。" },
      { symbol: "MSFT.US", error: "行情读取失败。" }
    ]);
  });
});

describe("renderBatchStockAnalysis: discloses failed symbols instead of hiding the gap", () => {
  it("includes a data-gap disclosure line naming the failed symbol and reason", () => {
    const markdown = stockAnalysis.renderBatchStockAnalysis({
      label: "2026-07-14",
      generatedAt: "2026-07-14T05:00:00.000Z",
      records: [],
      failedSymbols: [{ symbol: "BAD.US", error: "BAD.US 行情格式异常。" }]
    });

    expect(markdown).toContain("数据缺口");
    expect(markdown).toContain("BAD.US");
    expect(markdown).toContain("BAD.US 行情格式异常。");
  });

  it("omits the disclosure line when nothing failed", () => {
    const markdown = stockAnalysis.renderBatchStockAnalysis({
      label: "2026-07-14",
      generatedAt: "2026-07-14T05:00:00.000Z",
      records: [],
      failedSymbols: []
    });

    expect(markdown).not.toContain("数据缺口");
  });
});

describe("listTargets: collapses per-owner duplicates into one global distinct set", () => {
  it("returns a symbol once even when two different owners both have it active", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    stockAnalysis.runTargetsCommand(["--owner", "member_1", "NVDA"], options);
    stockAnalysis.runTargetsCommand(["--owner", "member_2", "NVDA"], options);

    expect(stockAnalysis.listTargets(db)).toEqual(["NVDA.US"]);
  });

  it("runListTargetsCommand exposes the same global view via its own db handle", () => {
    const { options } = makeDb();
    const db2 = openTradingDatabase(options.dbPath);
    seedMember(db2, "member_1");
    db2.close();

    stockAnalysis.runTargetsCommand(["--owner", "member_1", "AAPL", "NVDA"], options);

    expect(stockAnalysis.runListTargetsCommand(options)).toEqual(["AAPL.US", "NVDA.US"]);
  });
});

// Phase 5 Task 1 (2026-07-15 plan): runAnalysis persists stock_facts per
// SUCCESSFULLY-fetched record before rendering. Tested here against the
// standalone, network/PDF-free persistStockFactsForRecords (the exact
// function runAnalysis calls) rather than runAnalysis itself, which also
// spawns a real Chrome subprocess for PDF rendering (writeMarkdownPdf) - see
// this file's existing fetchStockAnalysisRecords/renderBatchStockAnalysis
// tests for the same "test the exported piece, not the CLI orchestrator"
// convention.
describe("persistStockFactsForRecords: writes stock_facts per successful record", () => {
  function fakeRecord(symbol: string, overrides: Partial<Record<string, unknown>> = {}) {
    return {
      symbol,
      quote: { symbol, last: "210.50", prev_close: "208.00", volume: "1000", timestamp: "2026-07-14T20:00:00.000Z" },
      history: [{ date: "2026-07-13", close: 209 }, { date: "2026-07-14", close: 210.5 }],
      fundamentals: { sources: ["yahoo-quote"], trailingPE: 28.5 },
      optionChain: { error: "Yahoo options 期权链接口读取失败" },
      news: [{ id: "n1", title: "新闻" }],
      analysis: {},
      ...overrides
    };
  }

  it("writes a stock_facts row set for each record, keyed by its own symbol", () => {
    const { db } = makeDb();

    stockAnalysis.persistStockFactsForRecords(db, "2026-07-14", [
      fakeRecord("AAPL.US"),
      fakeRecord("MSFT.US", { quote: { symbol: "MSFT.US", last: "430.10", prev_close: "425.00", volume: "2000", timestamp: "2026-07-14T20:00:00.000Z" } })
    ]);

    const aaplFacts = getStockFacts(db, "2026-07-14", "AAPL.US");
    const msftFacts = getStockFacts(db, "2026-07-14", "MSFT.US");
    expect(aaplFacts["quote.last"].valueNum).toBe(210.5);
    expect(msftFacts["quote.last"].valueNum).toBe(430.1);
  });

  it("never writes facts for a symbol that isn't in `records` (failedSymbols are simply absent from the input)", () => {
    const { db } = makeDb();

    stockAnalysis.persistStockFactsForRecords(db, "2026-07-14", [fakeRecord("AAPL.US")]);

    expect(getStockFacts(db, "2026-07-14", "BAD.US")).toEqual({});
  });

  it("re-persisting one symbol does not touch a sibling symbol's facts for the same trading_day", () => {
    const { db } = makeDb();
    const msft = fakeRecord("MSFT.US", { quote: { symbol: "MSFT.US", last: "430.10", prev_close: "425.00", volume: "2000", timestamp: "2026-07-14T20:00:00.000Z" } });

    stockAnalysis.persistStockFactsForRecords(db, "2026-07-14", [fakeRecord("AAPL.US"), msft]);
    // Re-run for AAPL.US alone (e.g. a subsequent single-symbol `prepare`).
    stockAnalysis.persistStockFactsForRecords(db, "2026-07-14", [fakeRecord("AAPL.US")]);

    expect(getStockFacts(db, "2026-07-14", "MSFT.US")["quote.last"].valueNum).toBe(430.1);
  });
});

// ---------------------------------------------------------------------------
// Phase 5 Task 2 (2026-07-15 plan): structured conclusion box + prediction
// persistence. buildDeterministicAnalysis is pure/network-free (was already
// module-local, now exported for exactly this reason) - fixtures below are
// tuned against the REAL summarizeHistory/summarizeUpsidePotential formulas
// (stock-analysis-metrics.mjs) so the confidence branches are hit for real,
// not asserted against a re-implementation of the heuristic.
// ---------------------------------------------------------------------------

function stockQuote(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    symbol: "AAPL.US",
    last: "210.50",
    prev_close: "208.00",
    open: "209.00",
    high: "211.00",
    low: "207.50",
    volume: "50000000",
    timestamp: "2026-07-14T20:00:00.000Z",
    ...overrides
  };
}

function stockHistorySeries(days: number, startClose: number, dailyDrift: number) {
  const rows: Array<{ date: string; close: number }> = [];
  const start = new Date("2026-01-05T00:00:00.000Z").getTime();
  for (let i = 0; i < days; i += 1) {
    rows.push({
      date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      close: startClose + i * dailyDrift
    });
  }
  return rows;
}

function stockFundamentals(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sources: ["yahoo-quote"],
    trailingPE: 22,
    priceToBook: 6,
    epsTrailingTwelveMonths: 8,
    marketCap: 1_000_000_000_000,
    oneYearTarget: 280,
    ...overrides
  };
}

function stockOptionChain() {
  return {
    expirationDates: [1755820800],
    options: [{ calls: [{ openInterest: 1000 }], puts: [{ openInterest: 500 }] }]
  };
}

function stockNewsList(count = 3) {
  return Array.from({ length: count }, (_, i) => ({ id: `n${i}`, title: `新闻 ${i}`, source: "longbridge-news" }));
}

const GENERATED_AT = "2026-07-15T13:00:00.000Z";

describe("buildDeterministicAnalysis: conclusion-box confidence heuristic", () => {
  it("is 'high' when facts coverage >= 6/8 AND the upside label + trend score both point bullish", () => {
    const analysis = stockAnalysis.buildDeterministicAnalysis(
      "AAPL.US",
      stockQuote({ last: "220.00" }),
      stockNewsList(),
      { history: stockHistorySeries(130, 180, 0.3), fundamentals: stockFundamentals(), optionChain: stockOptionChain() },
      GENERATED_AT
    );

    expect(analysis.conclusionBox.confidence).toBe("high");
  });

  it("is 'medium' when facts coverage >= 6/8 but the upside label is neutral (signals not consistent)", () => {
    const analysis = stockAnalysis.buildDeterministicAnalysis(
      "AAPL.US",
      stockQuote({ last: "200.00", prev_close: "200.00" }),
      stockNewsList(),
      {
        history: stockHistorySeries(130, 200, 0),
        fundamentals: stockFundamentals({ trailingPE: 20, priceToBook: 5, epsTrailingTwelveMonths: 10, oneYearTarget: 205 }),
        optionChain: stockOptionChain()
      },
      GENERATED_AT
    );

    expect(analysis.conclusionBox.confidence).toBe("medium");
  });

  it("is 'low' when facts coverage is below 6/8 (missing quote.last/pct and options.callOi)", () => {
    const quoteWithoutLast = {
      symbol: "AAPL.US", prev_close: "208.00", open: "209.00", high: "211.00", low: "207.50",
      volume: "50000000", timestamp: "2026-07-14T20:00:00.000Z"
    };
    const analysis = stockAnalysis.buildDeterministicAnalysis(
      "AAPL.US",
      quoteWithoutLast,
      stockNewsList(),
      {
        history: stockHistorySeries(130, 180, 0.3),
        fundamentals: stockFundamentals(),
        optionChain: { error: "Yahoo options 期权链接口读取失败" }
      },
      GENERATED_AT
    );

    expect(analysis.conclusionBox.confidence).toBe("low");
  });

  it("derives reviewDate as the generation date + 1 US-Eastern calendar month", () => {
    const analysis = stockAnalysis.buildDeterministicAnalysis(
      "AAPL.US",
      stockQuote(),
      stockNewsList(),
      { history: stockHistorySeries(130, 200, 0.1), fundamentals: stockFundamentals(), optionChain: stockOptionChain() },
      "2026-07-15T13:00:00.000Z"
    );

    expect(analysis.conclusionBox.reviewDate).toBe("2026-08-15");
  });
});

describe("renderBatchStockAnalysis: embeds the conclusion box inside the frozen '结论与复盘标签' section", () => {
  function renderFixture(symbol: string, generatedAt = GENERATED_AT) {
    const analysis = stockAnalysis.buildDeterministicAnalysis(
      symbol,
      stockQuote({ symbol }),
      stockNewsList(),
      { history: stockHistorySeries(130, 180, 0.3), fundamentals: stockFundamentals(), optionChain: stockOptionChain() },
      generatedAt
    );
    const markdown = stockAnalysis.renderBatchStockAnalysis({
      label: generatedAt.slice(0, 10),
      generatedAt,
      records: [{ symbol, analysis, news: stockNewsList() }],
      failedSymbols: []
    });
    return { analysis, markdown };
  }

  it("places '### 结论框' after the existing prose bullets, before the next section", () => {
    const { markdown } = renderFixture("AAPL.US");

    const conclusionHeadingIndex = markdown.indexOf("### 结论与复盘标签");
    const boxHeadingIndex = markdown.indexOf("### 结论框");
    const newsHeadingIndex = markdown.indexOf("### 近期新闻");

    expect(conclusionHeadingIndex).toBeGreaterThan(-1);
    expect(boxHeadingIndex).toBeGreaterThan(conclusionHeadingIndex);
    expect(boxHeadingIndex).toBeLessThan(newsHeadingIndex);
    // Existing three-path prose bullets stay put, ahead of the box.
    expect(markdown.indexOf("复盘标签：stock-analysis")).toBeLessThan(boxHeadingIndex);
  });

  it("still passes validateStockAnalysisMarkdown (existing gates stay green on the new output)", () => {
    const { markdown } = renderFixture("AAPL.US");

    const result = validateStockAnalysisMarkdown(markdown);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("persistPredictionsForRecords: parses its OWN rendered output into analysis_predictions", () => {
  function renderFixture(symbol: string, generatedAt = GENERATED_AT) {
    const analysis = stockAnalysis.buildDeterministicAnalysis(
      symbol,
      stockQuote({ symbol }),
      stockNewsList(),
      { history: stockHistorySeries(130, 180, 0.3), fundamentals: stockFundamentals(), optionChain: stockOptionChain() },
      generatedAt
    );
    const markdown = stockAnalysis.renderBatchStockAnalysis({
      label: generatedAt.slice(0, 10),
      generatedAt,
      records: [{ symbol, analysis, news: stockNewsList() }],
      failedSymbols: []
    });
    return { analysis, markdown };
  }

  function predictionRow(db: DatabaseSync, reportPath: string, symbol: string) {
    return db
      .prepare("SELECT * FROM analysis_predictions WHERE report_path = ? AND symbol = ?")
      .get(reportPath, symbol) as Record<string, unknown> | undefined;
  }

  it("writes a row whose fields match parseConclusionBox on the record's own rendered output", () => {
    const { db } = makeDb();
    const { analysis, markdown } = renderFixture("AAPL.US");
    const reportPath = "/tmp/2026-07-15.md";
    const parsed = parseConclusionBox(markdown);
    expect(parsed).not.toBeNull();

    stockAnalysis.persistPredictionsForRecords(db, reportPath, markdown, [{ symbol: "AAPL.US", analysis }]);

    const row = predictionRow(db, reportPath, "AAPL.US");
    expect(row).toBeDefined();
    expect(row?.symbol).toBe("AAPL.US");
    expect(row?.report_path).toBe(reportPath);
    expect(row?.conclusion).toBe(parsed!.coreConclusion);
    expect(row?.confidence).toBe(parsed!.confidence);
    expect(row?.review_trigger).toBe(parsed!.reviewTrigger);
    expect(row?.review_date).toBe(parsed!.reviewDate);
    expect(row?.outcome).toBeNull();
  });

  it("is idempotent: re-running against the same report_path replaces rather than duplicates", () => {
    const { db } = makeDb();
    const reportPath = "/tmp/2026-07-15.md";
    const first = renderFixture("AAPL.US");

    stockAnalysis.persistPredictionsForRecords(db, reportPath, first.markdown, [{ symbol: "AAPL.US", analysis: first.analysis }]);
    // Second render for the SAME symbol/report_path but a different
    // generatedAt (-> a different reviewDate) - simulates a same-day
    // re-run (e.g. `prepare` run twice) producing a slightly different box.
    const second = renderFixture("AAPL.US", "2026-07-15T18:00:00.000Z");
    stockAnalysis.persistPredictionsForRecords(db, reportPath, second.markdown, [{ symbol: "AAPL.US", analysis: second.analysis }]);

    const rows = db.prepare("SELECT * FROM analysis_predictions WHERE report_path = ?").all(reportPath) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].review_date).toBe(second.analysis.conclusionBox.reviewDate);
  });

  it("does not touch a different report_path's rows", () => {
    const { db } = makeDb();
    const a = renderFixture("AAPL.US");
    const m = renderFixture("MSFT.US");

    stockAnalysis.persistPredictionsForRecords(db, "/tmp/aapl.md", a.markdown, [{ symbol: "AAPL.US", analysis: a.analysis }]);
    stockAnalysis.persistPredictionsForRecords(db, "/tmp/msft.md", m.markdown, [{ symbol: "MSFT.US", analysis: m.analysis }]);

    expect(predictionRow(db, "/tmp/aapl.md", "AAPL.US")).toBeDefined();
    expect(predictionRow(db, "/tmp/msft.md", "MSFT.US")).toBeDefined();

    // Re-running AAPL's path must not disturb MSFT's row under a different path.
    stockAnalysis.persistPredictionsForRecords(db, "/tmp/aapl.md", a.markdown, [{ symbol: "AAPL.US", analysis: a.analysis }]);
    expect(predictionRow(db, "/tmp/msft.md", "MSFT.US")).toBeDefined();
  });

  it("skips a record whose own section has no parseable box, without throwing", () => {
    const { db } = makeDb();
    const reportPath = "/tmp/broken.md";
    const brokenMarkdown = "## BAD.US\n\n### 结论与复盘标签\n\n- 无结论框。\n";

    expect(() =>
      stockAnalysis.persistPredictionsForRecords(db, reportPath, brokenMarkdown, [{ symbol: "BAD.US", analysis: {} }])
    ).not.toThrow();
    expect(predictionRow(db, reportPath, "BAD.US")).toBeUndefined();
  });
});
