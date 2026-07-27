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
import { REPORT_DEGRADED_HEADER } from "./narrative-engine.mjs";
import { validateStockAnalysisMarkdown, validateStockNarrativeNumbers } from "./report-quality.mjs";
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

  // 2026-07-28: the 合理价值区间 basis hard-coded "近20日支撑位" regardless of
  // where rangeSupport actually came from. With history unavailable it is the
  // day's intraday LOW (`low ?? prevClose ?? last`), and with a short sample it
  // is an N-session min - both were published under a 20-day label. Same
  // "no silent mislabeling" rule this file's 20/60 日均线 handling already
  // applies (stock-analysis-metrics.mjs, defect 5).
  describe("合理价值区间 names the support level it really used", () => {
    it("labels the intraday low as the intraday low when no history is available", () => {
      const analysis = stockAnalysis.buildDeterministicAnalysis(
        "AAPL.US",
        stockQuote(),
        stockNewsList(),
        { history: { error: "Yahoo chart 历史走势接口触发限流" }, fundamentals: stockFundamentals(), optionChain: stockOptionChain() },
        GENERATED_AT
      );

      expect(analysis.conclusionBox.valueRange.basis).not.toContain("近20日支撑位");
      expect(analysis.conclusionBox.valueRange.basis).toContain("日内最低价 207.50 美元");
    });

    it("labels a short-sample support with the sessions it really covered", () => {
      const analysis = stockAnalysis.buildDeterministicAnalysis(
        "AAPL.US",
        stockQuote(),
        stockNewsList(),
        { history: stockHistorySeries(12, 180, 0.3), fundamentals: stockFundamentals(), optionChain: stockOptionChain() },
        GENERATED_AT
      );

      expect(analysis.conclusionBox.valueRange.basis).toContain("近12日支撑位");
      expect(analysis.conclusionBox.valueRange.basis).not.toContain("近20日支撑位");
    });

    it("still says 近20日支撑位 when a full 20-session window really exists", () => {
      const analysis = stockAnalysis.buildDeterministicAnalysis(
        "AAPL.US",
        stockQuote(),
        stockNewsList(),
        { history: stockHistorySeries(130, 180, 0.3), fundamentals: stockFundamentals(), optionChain: stockOptionChain() },
        GENERATED_AT
      );

      expect(analysis.conclusionBox.valueRange.basis).toContain("近20日支撑位");
    });
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

// ---------------------------------------------------------------------------
// Phase 5 Task 3 (2026-07-15 plan): narrative orchestration wiring.
// attachNarrativeSections is the standalone, exported piece runAnalysis calls
// (same "test the exported piece, not the CLI orchestrator" convention as
// persistStockFactsForRecords above) - it needs stock_facts already
// persisted for the same (tradingDay, symbol), so every test here calls
// persistStockFactsForRecords first, exactly mirroring runAnalysis's own
// ordering.
// ---------------------------------------------------------------------------

function narrativeFixtureRecord(symbol = "AAPL.US", generatedAt = GENERATED_AT) {
  const analysis = stockAnalysis.buildDeterministicAnalysis(
    symbol,
    stockQuote({ symbol }),
    stockNewsList(),
    { history: stockHistorySeries(130, 180, 0.3), fundamentals: stockFundamentals(), optionChain: stockOptionChain() },
    generatedAt
  );
  return { symbol, analysis, news: stockNewsList() };
}

describe("attachNarrativeSections: a globally-degraded narrative run keeps rendered output byte-equivalent except the header disclosure", () => {
  it("globally degrades, discloses REPORT_DEGRADED_HEADER once per symbol, and leaves every section's bullets identical to the pre-P5 deterministic output", async () => {
    const { db } = makeDb();
    const label = GENERATED_AT.slice(0, 10);

    const baseRecord = narrativeFixtureRecord();
    stockAnalysis.persistStockFactsForRecords(db, label, [baseRecord]);
    const baselineMarkdown = stockAnalysis.renderBatchStockAnalysis({
      label,
      generatedAt: GENERATED_AT,
      records: [baseRecord],
      failedSymbols: []
    });

    // Run against a FRESH record object (attachNarrativeSections mutates its
    // input with a `.narrative` field) so `baseRecord`/`baselineMarkdown`
    // above stay an untouched "what pre-P5 would have rendered" reference.
    const narrativeRecord = narrativeFixtureRecord();
    // Post-P10-ignition the DEFAULT narrative backend is the live OpenClaw
    // gateway (createNarrativeLlmBackend → chat completions). To keep this
    // rendering-invariant test deterministic regardless of ambient gateway
    // config, inject a backend that throws exactly as the real gateway client
    // does when the gateway is unreachable — a backend throw drives the SAME
    // global-degrade path (REPORT_DEGRADED_HEADER + byte-equivalent fallback)
    // this test actually asserts, independent of which backend produced it.
    const unavailableBackend = async () => {
      throw new Error("openclaw gateway unavailable: gateway not reachable");
    };
    await stockAnalysis.attachNarrativeSections(db, label, [narrativeRecord], { narrativeBackend: unavailableBackend });

    expect(narrativeRecord.narrative.degraded).toBe(true);
    expect(narrativeRecord.narrative.degradedReason).toMatch(/openclaw gateway/);
    expect(narrativeRecord.narrative.degradedSections).toHaveLength(8);

    const withNarrativeMarkdown = stockAnalysis.renderBatchStockAnalysis({
      label,
      generatedAt: GENERATED_AT,
      records: [narrativeRecord],
      failedSymbols: []
    });

    expect(withNarrativeMarkdown).toContain(REPORT_DEGRADED_HEADER);
    // Stripping out EXACTLY the inserted disclosure line (+ its trailing
    // blank line) must reproduce the pre-P5 baseline byte-for-byte - the
    // ONLY addition this task makes to an already-degraded run's rendering.
    const stripped = withNarrativeMarkdown.replace(`> ${REPORT_DEGRADED_HEADER}\n\n`, "");
    expect(stripped).toBe(baselineMarkdown);

    // The pre-existing quality gate keeps passing on the new output too.
    expect(validateStockAnalysisMarkdown(withNarrativeMarkdown).ok).toBe(true);
  });

  it("renderBatchStockAnalysis renders unchanged when `record.narrative` was never attached at all (pre-P5 direct callers)", () => {
    const record = narrativeFixtureRecord();
    const label = GENERATED_AT.slice(0, 10);

    const markdown = stockAnalysis.renderBatchStockAnalysis({ label, generatedAt: GENERATED_AT, records: [record], failedSymbols: [] });

    expect(markdown).not.toContain(REPORT_DEGRADED_HEADER);
  });
});

describe("attachNarrativeSections: fake backend's validated narrative flows into the rendered markdown", () => {
  // 2026-07-27: this used to assert the OPPOSITE ("replaces one section's
  // rendered bullets with the backend's own text"). Substitution is exactly
  // what broke the live report - a real model paraphrases the frozen evidence
  // sentences away - so the contract is now: deterministic bullets always
  // render, adopted prose is appended after them under the 叙事 prefix.
  it("appends the backend's own text after the section's deterministic bullets, never replacing them", async () => {
    const { db } = makeDb();
    const label = GENERATED_AT.slice(0, 10);
    const record = narrativeFixtureRecord();
    stockAnalysis.persistStockFactsForRecords(db, label, [record]);

    const rewrittenCatalysts = "本段已由叙事引擎重写：催化剂整体保持稳健，无需额外担忧。";
    // Every OTHER section's fake backend call simply echoes its own
    // deterministicText back verbatim - always mostly-Chinese by
    // construction (buildDeterministicAnalysis's own prose), so it either
    // validates as narrative (numbers already trace back to real facts) or,
    // for any derived (non-raw-fact) number, falls back to that SAME
    // deterministicText plus a marker bullet - either way the original
    // content survives untouched, only `catalysts` is genuinely rewritten.
    const narrativeBackend = async ({ sectionKey, deterministicText }: { sectionKey: string; deterministicText: string }) =>
      sectionKey === "catalysts" ? { text: rewrittenCatalysts } : { text: deterministicText };

    await stockAnalysis.attachNarrativeSections(db, label, [record], { narrativeBackend });

    expect(record.narrative.degraded).toBe(false);
    const catalystsResult = record.narrative.sections.find((entry: { key: string }) => entry.key === "catalysts");
    expect(catalystsResult).toMatchObject({ narrative: true, text: rewrittenCatalysts });

    const markdown = stockAnalysis.renderBatchStockAnalysis({ label, generatedAt: GENERATED_AT, records: [record], failedSymbols: [] });

    expect(markdown).toContain(`- 叙事：${rewrittenCatalysts}`);
    // The deterministic bullet the model rewrote is STILL there, above it.
    expect(markdown).toContain(`- ${record.analysis.catalysts[0]}`);
    expect(markdown).not.toContain(REPORT_DEGRADED_HEADER);
    // Gate-critical phrases (PE/PB, 均线：20 日, 期权链只读补充, 综合上行潜力) all
    // live in sections OTHER than catalysts and survive regardless of
    // whether their own echoed narrative validated or locally fell back.
    expect(validateStockAnalysisMarkdown(markdown).ok).toBe(true);
  });

  // 2026-07 audit review: the audit item claimed stock-analysis.mjs writes
  // narrative text into the report .md without running it through
  // defuseMarkdownInText first. Verified NOT a defect: narrative-engine.mjs's
  // validateBackendOutput (called from generateOneSection, which
  // attachNarrativeSections above always goes through) already calls
  // defuseMarkdownInText on the backend's raw output BEFORE accepting it as
  // `narrative: true` text (see narrative-engine.mjs:201) - a defused-but-
  // otherwise-valid text is what actually reaches record.narrative.sections.
  // This regression test locks that existing protection in place rather
  // than reapplying a redundant second defuse pass in this file.
  it("a backend section containing markdown-link injection syntax is already defused by the time it reaches record.narrative (existing protection in narrative-engine.mjs, not stock-analysis.mjs)", async () => {
    const { db } = makeDb();
    const label = GENERATED_AT.slice(0, 10);
    const record = narrativeFixtureRecord();
    stockAnalysis.persistStockFactsForRecords(db, label, [record]);

    const maliciousText = "看似正常的分析文本 [点击查看](https://evil.example.com/phish) 请勿轻信。";
    const narrativeBackend = async ({ sectionKey, deterministicText }: { sectionKey: string; deterministicText: string }) =>
      sectionKey === "catalysts" ? { text: maliciousText } : { text: deterministicText };

    await stockAnalysis.attachNarrativeSections(db, label, [record], { narrativeBackend });

    const catalystsResult = record.narrative.sections.find((entry: { key: string }) => entry.key === "catalysts");
    expect(catalystsResult.text).not.toContain("[点击查看](https://evil.example.com/phish)");
    expect(catalystsResult.text).toContain("［点击查看］(https://evil.example.com/phish)");

    const markdown = stockAnalysis.renderBatchStockAnalysis({ label, generatedAt: GENERATED_AT, records: [record], failedSymbols: [] });
    expect(markdown).not.toContain("[点击查看](https://evil.example.com/phish)");
  });
});

// ---------------------------------------------------------------------------
// Phase 5 Task 5 (2026-07-15 plan): 平台结论框摘要卡 + deferred minors.
// ---------------------------------------------------------------------------

describe("toYahooSymbol: strips .US, then converts any remaining dot to a hyphen (minor a)", () => {
  it("strips the .US suffix from a bare US ticker with no dots", () => {
    expect(stockAnalysis.toYahooSymbol("AAPL.US")).toBe("AAPL");
    expect(stockAnalysis.toYahooSymbol("nvda.us")).toBe("NVDA");
  });

  it("converts a dot-class-share ticker's remaining dot to a hyphen after stripping .US", () => {
    // normalizeSymbol (report-data.mjs) leaves a dotted class-share ticker
    // like BRK.B untouched (it never gets a .US suffix appended - it's
    // neither a bare 1-6-letter ticker nor already dot-suffixed with a
    // 2-4-letter market code) - so this input never actually carries .US,
    // but the dot->hyphen conversion still applies.
    expect(stockAnalysis.toYahooSymbol("BRK.B")).toBe("BRK-B");
  });

  it("strips .US AND converts a remaining dot to a hyphen when both are present", () => {
    expect(stockAnalysis.toYahooSymbol("BRK.B.US")).toBe("BRK-B");
  });

  it("leaves a plain ticker with no dots and no .US suffix unchanged (aside from uppercasing)", () => {
    expect(stockAnalysis.toYahooSymbol("tsla")).toBe("TSLA");
  });
});

describe("nextUsMonthlyOptionExpiry: same-day behavior (minor c)", () => {
  // 2026-08-21 is the third Friday of August 2026 (verified independently:
  // Aug 1 2026 is a Saturday, so the first Friday is Aug 7, the third is
  // Aug 21).
  const THIRD_FRIDAY_AUG_2026 = "2026-08-21";

  it("returns TODAY when 'now' is later the same day as the third Friday (the bug this task fixes)", () => {
    // Before this task's fix, comparing full timestamps (candidate is always
    // midnight UTC, `date` is whatever wall-clock instant the caller passed)
    // meant any time-of-day past midnight on the expiry day itself rolled
    // forward to NEXT month instead of returning today.
    const laterSameDay = new Date(`${THIRD_FRIDAY_AUG_2026}T15:00:00.000Z`);
    expect(stockAnalysis.nextUsMonthlyOptionExpiry(laterSameDay)).toBe(THIRD_FRIDAY_AUG_2026);

    const almostMidnightSameDay = new Date(`${THIRD_FRIDAY_AUG_2026}T23:59:59.000Z`);
    expect(stockAnalysis.nextUsMonthlyOptionExpiry(almostMidnightSameDay)).toBe(THIRD_FRIDAY_AUG_2026);
  });

  it("returns the exact same day at midnight too (edge case, was already correct)", () => {
    expect(stockAnalysis.nextUsMonthlyOptionExpiry(new Date(`${THIRD_FRIDAY_AUG_2026}T00:00:00.000Z`))).toBe(
      THIRD_FRIDAY_AUG_2026
    );
  });

  it("rolls forward to next month's third Friday the day AFTER expiry", () => {
    const dayAfter = new Date(`${THIRD_FRIDAY_AUG_2026}T00:00:00.000Z`);
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
    expect(stockAnalysis.nextUsMonthlyOptionExpiry(dayAfter)).toBe("2026-09-18");
  });

  it("still returns the same month's expiry the day BEFORE it", () => {
    const dayBefore = new Date(`${THIRD_FRIDAY_AUG_2026}T12:00:00.000Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    expect(stockAnalysis.nextUsMonthlyOptionExpiry(dayBefore)).toBe(THIRD_FRIDAY_AUG_2026);
  });
});

describe("resolveReportPaths: prepare writes -preview files, never the delivered archive name (minor b)", () => {
  it("resolves the plain <label>.md/.pdf archive name when deliver=true", () => {
    expect(stockAnalysis.resolveReportPaths("/reports/stock-analysis", "2026-07-15", true)).toEqual({
      markdownPath: join("/reports/stock-analysis", "2026-07-15.md"),
      pdfPath: join("/reports/stock-analysis", "2026-07-15.pdf")
    });
  });

  it("resolves the <label>-preview.md/.pdf name when deliver=false (prepare dry-run)", () => {
    expect(stockAnalysis.resolveReportPaths("/reports/stock-analysis", "2026-07-15", false)).toEqual({
      markdownPath: join("/reports/stock-analysis", "2026-07-15-preview.md"),
      pdfPath: join("/reports/stock-analysis", "2026-07-15-preview.pdf")
    });
  });

  it("the preview path never equals the delivered archive path for the same label", () => {
    const delivered = stockAnalysis.resolveReportPaths("/reports/stock-analysis", "2026-07-15", true);
    const preview = stockAnalysis.resolveReportPaths("/reports/stock-analysis", "2026-07-15", false);
    expect(preview.markdownPath).not.toBe(delivered.markdownPath);
    expect(preview.pdfPath).not.toBe(delivered.pdfPath);
  });
});

describe("persistPredictionsIfDelivered: predictions only ever written for a real delivered run (minor b)", () => {
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

  it("writes nothing to analysis_predictions when deliver=false (a `prepare` dry-run)", () => {
    const { db } = makeDb();
    const { markdown } = renderFixture("AAPL.US");
    const reportPath = "/tmp/2026-07-15-preview.md";

    stockAnalysis.persistPredictionsIfDelivered(db, false, reportPath, markdown, [{ symbol: "AAPL.US" }]);

    const row = db.prepare("SELECT * FROM analysis_predictions WHERE report_path = ?").get(reportPath);
    expect(row).toBeUndefined();
  });

  it("writes the row when deliver=true (a real delivered run), matching persistPredictionsForRecords directly", () => {
    const { db } = makeDb();
    const { markdown } = renderFixture("AAPL.US");
    const reportPath = "/tmp/2026-07-15.md";

    stockAnalysis.persistPredictionsIfDelivered(db, true, reportPath, markdown, [{ symbol: "AAPL.US" }]);

    const row = db.prepare("SELECT * FROM analysis_predictions WHERE report_path = ?").get(reportPath) as
      | Record<string, unknown>
      | undefined;
    expect(row).toBeDefined();
    expect(row?.symbol).toBe("AAPL.US");
  });
});

// ---------------------------------------------------------------------------
// 2026-07-27 facts-coverage repair.
//
// Two independent defects were fixed together, and both are pinned here:
//   1. the narrative layer REPLACED each section's deterministic bullets, so
//      once the real gateway came up every gate-critical evidence sentence
//      (and every honest "…读取失败：…" disclosure) got paraphrased away and
//      per-symbol facts coverage collapsed to 2/8;
//   2. history and the option chain had Yahoo as their ONLY source, and this
//      deployment's IP is 429'd by Yahoo on every request, so both domains
//      came back empty on every single run. Nasdaq (asset-class aware) +
//      StockAnalysis + Finnhub are now wired ahead of it.
// ---------------------------------------------------------------------------

describe("fetchStockHistory: Nasdaq -> StockAnalysis -> Yahoo, with the reason for every failure", () => {
  const NOW = new Date("2026-07-27T12:00:00.000Z");

  function nasdaqHistoryPayload(close: number) {
    return { data: { tradesTable: { rows: [{ date: "07/24/2026", close: String(close) }] } } };
  }

  it("uses Nasdaq first for an equity and never falls through when it answers", async () => {
    const seen: string[] = [];
    const result = await stockAnalysis.fetchStockHistory("AMZN.US", {
      instrumentKind: "stock",
      now: NOW,
      fetchJson: async (url: unknown) => {
        seen.push(String(url));
        return nasdaqHistoryPayload(232.11);
      }
    });

    expect(result.source).toBe("nasdaq-historical");
    expect(result.rows).toEqual([{ date: "2026-07-24", close: 232.11 }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("api.nasdaq.com");
    expect(seen[0]).toContain("assetclass=stocks");
  });

  it("asks Nasdaq for assetclass=etf FIRST for a fund (assetclass=stocks answers 400 'Symbol not exists.')", async () => {
    const seen: string[] = [];
    const result = await stockAnalysis.fetchStockHistory("QQQM.US", {
      instrumentKind: "etf",
      now: NOW,
      fetchJson: async (url: unknown) => {
        seen.push(String(url));
        return nasdaqHistoryPayload(281.68);
      }
    });

    expect(seen[0]).toContain("assetclass=etf");
    expect(result.rows).toEqual([{ date: "2026-07-24", close: 281.68 }]);
  });

  it("falls through Nasdaq(both classes) -> StockAnalysis when Nasdaq rejects the symbol", async () => {
    const seen: string[] = [];
    const result = await stockAnalysis.fetchStockHistory("AMZN.US", {
      instrumentKind: "stock",
      now: NOW,
      fetchJson: async (url: unknown) => {
        seen.push(String(url));
        if (String(url).includes("api.nasdaq.com")) {
          throw new Error("400 Bad Request");
        }
        return { status: 200, data: [{ t: "2026-07-24", c: 232.11 }] };
      }
    });

    expect(seen.filter((url) => url.includes("api.nasdaq.com"))).toHaveLength(2);
    expect(result.source).toBe("stockanalysis-history");
    expect(result.rows).toEqual([{ date: "2026-07-24", close: 232.11 }]);
  });

  it("still reaches Yahoo chart as the last link", async () => {
    const result = await stockAnalysis.fetchStockHistory("AMZN.US", {
      instrumentKind: "stock",
      now: NOW,
      fetchJson: async (url: unknown) => {
        if (String(url).includes("query1.finance.yahoo.com")) {
          return { chart: { result: [{ timestamp: [1_753_315_200], indicators: { quote: [{ close: [232.11] }] } }] } };
        }
        throw new Error("429 Too Many Requests");
      }
    });

    expect(result.source).toBe("yahoo-chart-history");
    expect(result.rows).toHaveLength(1);
  });

  it("returns ONE aggregated error naming every source it tried when nothing worked", async () => {
    const result = await stockAnalysis.fetchStockHistory("AMZN.US", {
      instrumentKind: "stock",
      now: NOW,
      fetchJson: async () => {
        throw new Error("429 Too Many Requests");
      }
    });

    expect(result.rows).toBeUndefined();
    expect(result.error).toContain("Nasdaq 历史行情");
    expect(result.error).toContain("StockAnalysis 历史接口");
    expect(result.error).toContain("Yahoo chart 历史走势接口");
    expect(result.error).toContain("触发限流");
  });
});

describe("fetchStockOptionChain: Nasdaq -> Yahoo", () => {
  it("summarizes the nearest Nasdaq expiry without touching Yahoo", async () => {
    const seen: string[] = [];
    const result = await stockAnalysis.fetchStockOptionChain("AMZN.US", {
      instrumentKind: "stock",
      fetchJson: async (url: unknown) => {
        seen.push(String(url));
        return {
          data: {
            table: {
              rows: [
                { expirygroup: "July 31, 2026", c_Openinterest: null, p_Openinterest: null },
                { expirygroup: "", c_Openinterest: "27", p_Openinterest: "68" }
              ]
            }
          }
        };
      }
    });

    expect(result).toMatchObject({ source: "nasdaq-option-chain", expiration: "2026-07-31", callOpenInterest: 27, putOpenInterest: 68 });
    expect(seen.every((url) => url.includes("api.nasdaq.com"))).toBe(true);
  });

  it("aggregates every source's reason when the whole chain fails (Yahoo 429 included)", async () => {
    const result = await stockAnalysis.fetchStockOptionChain("AMZN.US", {
      instrumentKind: "stock",
      fetchJson: async () => {
        throw new Error("429 Too Many Requests");
      }
    });

    expect(result.error).toContain("Nasdaq 期权链");
    expect(result.error).toContain("Yahoo options query2.finance.yahoo.com");
  });
});

describe("fetchFinnhubMetrics / fetchFundamentalSnapshots", () => {
  it("sends the key as a header and normalizes the free-tier metrics", async () => {
    let sentHeaders: Record<string, string> = {};
    const result = await stockAnalysis.fetchFinnhubMetrics("AMZN.US", {
      apiKey: "test-key",
      fetchJson: async (_url: unknown, headers: Record<string, string>) => {
        sentHeaders = headers;
        return { metric: { peTTM: 27.4988, pbQuarterly: 5.0684, marketCapitalization: 2_496_832.8 } };
      }
    });

    expect(sentHeaders["X-Finnhub-Token"]).toBe("test-key");
    expect(result).toMatchObject({ source: "finnhub-metric", trailingPE: 27.4988 });
  });

  it("discloses a missing key instead of silently skipping the source", async () => {
    const result = await stockAnalysis.fetchFinnhubMetrics("AMZN.US", { apiKey: "", fetchJson: async () => ({}) });

    expect(result.error).toContain("FINNHUB_API_KEY");
  });

  it("merges Finnhub valuation with Nasdaq's one-year target and carries each failed source's reason", async () => {
    const merged = await stockAnalysis.fetchFundamentalSnapshots("AMZN.US", {
      instrumentKind: "stock",
      finnhubApiKey: "test-key",
      fetchText: async () => {
        throw new Error("404 Not Found");
      },
      fetchJson: async (url: unknown) => {
        const href = String(url);
        if (href.includes("finnhub.io")) {
          return { metric: { peTTM: 27.4988, pbQuarterly: 5.0684, epsTTM: 8.3676, marketCapitalization: 2_496_832.8 } };
        }
        if (href.includes("api.nasdaq.com")) {
          return { data: { summaryData: { OneYrTarget: { value: "$320.00" }, MarketCap: { value: "2,530,072,139,347" } } } };
        }
        throw new Error("429 Too Many Requests");
      }
    });

    expect(merged).toMatchObject({ trailingPE: 27.4988, priceToBook: 5.0684, oneYearTarget: 320 });
    expect(merged.sources).toEqual(["finnhub-metric", "nasdaq-summary"]);
    expect(merged.failures.join("；")).toContain("stockanalysis-statistics");
    expect(merged.failures.join("；")).toContain("yahoo-quote");
  });
});

describe("rendering keeps every checkpoint visible no matter how the narrative layer rewrites the prose", () => {
  const LABEL = GENERATED_AT.slice(0, 10);

  // The exact failure mode observed on the mini: a compliant model returns
  // fluent Chinese with no numbers of its own, so it passes every narrative
  // pre-check - and used to take the whole evidence section with it.
  const paraphrasingBackend = async () => ({ text: "本段已改写为流畅的中文叙述，仅做语言润色，不重复具体数值。" });

  it("adopts all eight sections and STILL passes every stock gate, with facts coverage intact", async () => {
    const { db } = makeDb();
    const record = narrativeFixtureRecord();
    stockAnalysis.persistStockFactsForRecords(db, LABEL, [record]);

    await stockAnalysis.attachNarrativeSections(db, LABEL, [record], { narrativeBackend: paraphrasingBackend });
    expect(record.narrative.degraded).toBe(false);
    expect(record.narrative.sections.every((entry: { narrative: boolean }) => entry.narrative)).toBe(true);

    const markdown = stockAnalysis.renderBatchStockAnalysis({ label: LABEL, generatedAt: GENERATED_AT, records: [record], failedSymbols: [] });

    expect(markdown).toContain("- 叙事：本段已改写为流畅的中文叙述");
    // Every frozen evidence phrase the gates read is still in the document.
    expect(markdown).toMatch(/最新价格：[0-9]/u);
    expect(markdown).toMatch(/涨跌幅：[+-]?[0-9]/u);
    expect(markdown).toMatch(/PE\s+[0-9]/u);
    expect(markdown).toMatch(/均线：20 日 [0-9]/u);
    expect(markdown).toContain("期权链只读补充");
    expect(markdown).toContain("综合上行潜力");
    expect(validateStockAnalysisMarkdown(markdown)).toEqual({ ok: true, failures: [] });
  });

  it("passes the delivery-time numeric gate: derived deterministic numbers are backed by the record, a tampered one is not", async () => {
    const { db } = makeDb();
    const record = narrativeFixtureRecord();
    stockAnalysis.persistStockFactsForRecords(db, LABEL, [record]);
    await stockAnalysis.attachNarrativeSections(db, LABEL, [record], { narrativeBackend: paraphrasingBackend });

    const markdown = stockAnalysis.renderBatchStockAnalysis({ label: LABEL, generatedAt: GENERATED_AT, records: [record], failedSymbols: [] });
    const factsBySymbol = { "AAPL.US": getStockFacts(db, LABEL, "AAPL.US") };
    const deterministicTextBySymbol = { "AAPL.US": stockAnalysis.deterministicTextForRecord(record) };

    expect(validateStockNarrativeNumbers(markdown, factsBySymbol, { deterministicTextBySymbol })).toEqual({ ok: true, failures: [] });

    const tampered = markdown.replace("最新价格：210.50", "最新价格：918.70");
    const tamperedResult = validateStockNarrativeNumbers(tampered, factsBySymbol, { deterministicTextBySymbol });
    expect(tamperedResult.ok).toBe(false);
    expect(tamperedResult.failures).toContain("stock.numeric_match:AAPL.US:918.70");
  });

  it("appends only the degrade marker (not a duplicated copy of the bullets) when a section's narrative is rejected", async () => {
    const { db } = makeDb();
    const record = narrativeFixtureRecord();
    stockAnalysis.persistStockFactsForRecords(db, LABEL, [record]);

    // A backend that keeps inventing an unbacked number exhausts its retries
    // and degrades that section locally.
    const fabricatingBackend = async ({ sectionKey }: { sectionKey: string }) =>
      sectionKey === "catalysts" ? { text: "催化剂方面，本季度预计增长 4321.99 个基点。" } : { text: "本段改写为中文叙述。" };

    await stockAnalysis.attachNarrativeSections(db, LABEL, [record], { narrativeBackend: fabricatingBackend });

    const markdown = stockAnalysis.renderBatchStockAnalysis({ label: LABEL, generatedAt: GENERATED_AT, records: [record], failedSymbols: [] });
    const catalystsBlock = markdown.split("### 催化剂")[1].split("###")[0];

    expect(catalystsBlock).toContain("（叙事降级：数字比对未通过）");
    expect(catalystsBlock).not.toContain("4321.99");
    // The deterministic bullet appears exactly once - the marker is appended,
    // the bullets are not re-emitted alongside it.
    expect(catalystsBlock.split(record.analysis.catalysts[0]).length - 1).toBe(1);
    expect(validateStockAnalysisMarkdown(markdown).ok).toBe(true);
  });
});
