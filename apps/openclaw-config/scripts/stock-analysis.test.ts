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
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MemberRepository,
  buildDeepLink,
  openTradingDatabase,
  type DeepLinkKind,
  type ReportDeliveryPayload
} from "../../../packages/shared-types/dist/index.js";
import { parseConclusionBox } from "./conclusion-box.mjs";
import { REPORT_DEGRADED_HEADER } from "./narrative-engine.mjs";
import {
  STOCK_NEWS_SECTION_TITLE,
  validateStockAnalysisMarkdown,
  validateStockNarrativeNumbers
} from "./report-quality.mjs";
import { getStockFacts } from "./stock-facts-store.mjs";

const stockAnalysis = await import("./stock-analysis.mjs");
// Task 23: the probability formatter/disclosure/clamp constants the renderer
// above imports - asserted from the same module the producer uses, so the
// tests cannot pin a hand-typed copy of a literal that has since changed.
const metrics = await import("./stock-analysis-metrics.mjs");

/**
 * H3 (2026-07-28, round-5): this file left the typecheck backlog. Its 27 errors
 * were four shapes, and each is answered by asserting what the checker could
 * not know rather than by widening a type until it stops complaining.
 *
 *  1. stock-analysis.mjs is plain JS, so a parameter's type is inferred from
 *     its destructuring default (`failedSymbols = []` -> never[]) and a return
 *     type from a dynamically built object literal. `renderBatch` /
 *     `fetchRecords` below declare the contract the .mjs implements. What that
 *     buys is precise: this file's CALL SITES get checked; it cannot verify the
 *     .mjs still has that shape, because checkJs is off for scripts/. The
 *     lasting fix is JSDoc types on the .mjs itself.
 *  2. `attachNarrativeSections` MUTATES each record, attaching `narrative` -
 *     invisible to the type of the fixture that was passed in. narrativeOf
 *     reads it and fails by name if the mutation did not happen, which today
 *     would be a bare TypeError inside a matcher.
 *  3. noUncheckedIndexedAccess makes every indexed read `T | undefined`;
 *     `at` and `factOf` say WHICH row or fact was missing.
 *  4. the delivery payloads carry `reportKind` widened to `string`, which is
 *     not the `DeepLinkKind` ReportDeliveryPayload declares.
 */
type SectionEntry = { key: string; narrative: boolean; text: string };
interface NarrativeState {
  degraded: boolean;
  degradedReason?: string;
  degradedSections: unknown[];
  sections: SectionEntry[];
}

function narrativeOf(record: unknown): NarrativeState {
  const attached = (record as { narrative?: NarrativeState }).narrative;
  if (attached === undefined) {
    throw new Error("attachNarrativeSections attached no `narrative` to this record");
  }
  return attached;
}

function at<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`${what}: expected an entry at index ${index}, got ${items.length}`);
  }
  return item;
}

function factOf(facts: object, key: string): { valueNum: number | null; valueText?: string } {
  const fact = (facts as Record<string, unknown>)[key] as { valueNum: number | null; valueText?: string } | undefined;
  if (fact === undefined) {
    throw new Error(`no stock fact "${key}" was written (have: ${Object.keys(facts).join(", ") || "none"})`);
  }
  return fact;
}

const renderBatch = stockAnalysis.renderBatchStockAnalysis as (input: {
  label: string;
  generatedAt: string;
  records: unknown[];
  failedSymbols?: Array<{ symbol: string; error: string }>;
}) => string;

const fetchRecords = stockAnalysis.fetchStockAnalysisRecords as (
  symbols: string[],
  options?: { fetchRecord?: (symbol: string, generatedAt?: string) => Promise<unknown> }
) => Promise<{ records: Array<{ symbol: string }>; failedSymbols: Array<{ symbol: string; error: string }> }>;


/**
 * `buildStockAnalysisDeliveryPayload` is plain JS, so its `reportKind` widens to
 * `string` and the payload does not satisfy ReportDeliveryPayload. Rather than
 * casting the check away, this asserts the producer's value: buildDeepLink
 * throws a TypeError for a kind the router cannot address, so a payload naming a
 * page that does not exist fails here instead of type-widening (H3).
 */
function asDeliveryPayload(payload: object): ReportDeliveryPayload {
  const kind = (payload as { reportKind?: unknown }).reportKind;
  expect(typeof kind, "the payload carries no reportKind").toBe("string");
  expect(
    () => buildDeepLink(kind as DeepLinkKind, "2026-07-28"),
    `reportKind ${String(kind)} is not a page the platform can address`
  ).not.toThrow();
  return payload as unknown as ReportDeliveryPayload;
}

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

    const { records, failedSymbols } = await fetchRecords(
      ["AAPL.US", "BAD.US", "MSFT.US"],
      { fetchRecord }
    );

    expect(records.map((r: { symbol: string }) => r.symbol)).toEqual(["AAPL.US", "MSFT.US"]);
    expect(failedSymbols).toEqual([{ symbol: "BAD.US", error: "BAD.US 行情格式异常。" }]);
  });

  it("returns every record when nothing fails", async () => {
    const fetchRecord = async (symbol: string) => ({ symbol, analysis: {} });

    const { records, failedSymbols } = await fetchRecords(["AAPL.US"], { fetchRecord });

    expect(records).toHaveLength(1);
    expect(failedSymbols).toEqual([]);
  });

  it("reports every failure when the whole batch fails", async () => {
    const fetchRecord = async () => {
      throw new Error("行情读取失败。");
    };

    const { records, failedSymbols } = await fetchRecords(["AAPL.US", "MSFT.US"], { fetchRecord });

    expect(records).toEqual([]);
    expect(failedSymbols).toEqual([
      { symbol: "AAPL.US", error: "行情读取失败。" },
      { symbol: "MSFT.US", error: "行情读取失败。" }
    ]);
  });
});

describe("renderBatchStockAnalysis: discloses failed symbols instead of hiding the gap", () => {
  it("includes a data-gap disclosure line naming the failed symbol and reason", () => {
    const markdown = renderBatch({
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
    const markdown = renderBatch({
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
// standalone, network-free persistStockFactsForRecords (the exact
// function runAnalysis calls) rather than runAnalysis itself, which also
// fetches live Longbridge data and delivers to Feishu - see
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
    expect(factOf(aaplFacts, "quote.last").valueNum).toBe(210.5);
    expect(factOf(msftFacts, "quote.last").valueNum).toBe(430.1);
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

    expect(factOf(getStockFacts(db, "2026-07-14", "MSFT.US"), "quote.last").valueNum).toBe(430.1);
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

describe("renderBatchStockAnalysis: embeds the conclusion box inside the frozen '结论与置信度' section", () => {
  function renderFixture(symbol: string, generatedAt = GENERATED_AT) {
    const analysis = stockAnalysis.buildDeterministicAnalysis(
      symbol,
      stockQuote({ symbol }),
      stockNewsList(),
      { history: stockHistorySeries(130, 180, 0.3), fundamentals: stockFundamentals(), optionChain: stockOptionChain() },
      generatedAt
    );
    const markdown = renderBatch({
      label: generatedAt.slice(0, 10),
      generatedAt,
      records: [{ symbol, analysis, news: stockNewsList() }],
      failedSymbols: []
    });
    return { analysis, markdown };
  }

  it("places '### 结论框' after the existing prose bullets, before the next section", () => {
    const { markdown } = renderFixture("AAPL.US");

    const conclusionHeadingIndex = markdown.indexOf("### 结论与置信度");
    const boxHeadingIndex = markdown.indexOf("### 结论框");
    // §3.4 (2026-07-30) reordered the sections: 新闻事件 and 多路径推演 now come
    // BEFORE 结论与置信度, which is the last section, so the box's upper bound is
    // the end of this symbol's block rather than a following "###" heading.
    const pathsHeadingIndex = markdown.indexOf("### 多路径推演");
    const newsHeadingIndex = markdown.indexOf(`### ${STOCK_NEWS_SECTION_TITLE}`);

    expect(conclusionHeadingIndex).toBeGreaterThan(-1);
    expect(newsHeadingIndex).toBeGreaterThan(-1);
    expect(pathsHeadingIndex).toBeGreaterThan(newsHeadingIndex);
    expect(conclusionHeadingIndex).toBeGreaterThan(pathsHeadingIndex);
    expect(boxHeadingIndex).toBeGreaterThan(conclusionHeadingIndex);
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
    const markdown = renderBatch({
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
    expect(at(rows, 0, "analysis_predictions rows for this report_path").review_date).toBe(
      second.analysis.conclusionBox.reviewDate
    );
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
    const brokenMarkdown = "## BAD.US\n\n### 结论与置信度\n\n- 无结论框。\n";

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
    const baselineMarkdown = renderBatch({
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

    expect(narrativeOf(narrativeRecord).degraded).toBe(true);
    expect(narrativeOf(narrativeRecord).degradedReason).toMatch(/openclaw gateway/);
    expect(narrativeOf(narrativeRecord).degradedSections).toHaveLength(7);

    const withNarrativeMarkdown = renderBatch({
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

  it("renderBatchStockAnalysis renders unchanged when `narrativeOf(record)` was never attached at all (pre-P5 direct callers)", () => {
    const record = narrativeFixtureRecord();
    const label = GENERATED_AT.slice(0, 10);

    const markdown = renderBatch({ label, generatedAt: GENERATED_AT, records: [record], failedSymbols: [] });

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

    const rewrittenFundamentals = "本段已由叙事引擎重写：基本面整体保持稳健，无需额外担忧。";
    // Every OTHER section's fake backend call simply echoes its own
    // deterministicText back verbatim - always mostly-Chinese by
    // construction (buildDeterministicAnalysis's own prose), so it either
    // validates as narrative (numbers already trace back to real facts) or,
    // for any derived (non-raw-fact) number, falls back to that SAME
    // deterministicText plus a marker bullet - either way the original
    // content survives untouched, only `fundamentals` is genuinely rewritten.
    const narrativeBackend = async ({ sectionKey, deterministicText }: { sectionKey: string; deterministicText: string }) =>
      sectionKey === "fundamentals" ? { text: rewrittenFundamentals } : { text: deterministicText };

    await stockAnalysis.attachNarrativeSections(db, label, [record], { narrativeBackend });

    expect(narrativeOf(record).degraded).toBe(false);
    const fundamentalsResult = narrativeOf(record).sections.find((entry: { key: string }) => entry.key === "fundamentals");
    expect(fundamentalsResult).toMatchObject({ narrative: true, text: rewrittenFundamentals });

    const markdown = renderBatch({ label, generatedAt: GENERATED_AT, records: [record], failedSymbols: [] });

    expect(markdown).toContain(`- 叙事：${rewrittenFundamentals}`);
    // The deterministic bullet the model rewrote is STILL there, above it.
    expect(markdown).toContain(`- ${record.analysis.fundamentals[0]}`);
    expect(markdown).not.toContain(REPORT_DEGRADED_HEADER);
    // Gate-critical phrases (PE/PB, 均线：20 日, 期权链只读补充, 综合上行潜力) all
    // live in sections OTHER than fundamentals and survive regardless of
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
  // otherwise-valid text is what actually reaches narrativeOf(record).sections.
  // This regression test locks that existing protection in place rather
  // than reapplying a redundant second defuse pass in this file.
  it("a backend section containing markdown-link injection syntax is already defused by the time it reaches narrativeOf(record) (existing protection in narrative-engine.mjs, not stock-analysis.mjs)", async () => {
    const { db } = makeDb();
    const label = GENERATED_AT.slice(0, 10);
    const record = narrativeFixtureRecord();
    stockAnalysis.persistStockFactsForRecords(db, label, [record]);

    const maliciousText = "看似正常的分析文本 [点击查看](https://evil.example.com/phish) 请勿轻信。";
    const narrativeBackend = async ({ sectionKey, deterministicText }: { sectionKey: string; deterministicText: string }) =>
      sectionKey === "fundamentals" ? { text: maliciousText } : { text: deterministicText };

    await stockAnalysis.attachNarrativeSections(db, label, [record], { narrativeBackend });

    const fundamentalsResult = narrativeOf(record).sections.find((entry) => entry.key === "fundamentals");
    expect(fundamentalsResult, "no catalysts section came back from attachNarrativeSections").toBeDefined();
    expect(fundamentalsResult?.text).not.toContain("[点击查看](https://evil.example.com/phish)");
    expect(fundamentalsResult?.text).toContain("［点击查看］(https://evil.example.com/phish)");

    const markdown = renderBatch({ label, generatedAt: GENERATED_AT, records: [record], failedSymbols: [] });
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
  // Task 14 (§0.4 PDF 已退役): the resolver used to return a `pdfPath` beside
  // the markdown one, and every batch really did spawn Chrome to render it.
  // markdown is now the ONLY artifact a batch writes - asserted with toEqual
  // (not toMatchObject) so a re-added artifact path fails here.
  it("resolves the plain <label>.md archive name when deliver=true", () => {
    expect(stockAnalysis.resolveReportPaths("/reports/stock-analysis", "2026-07-15", true)).toEqual({
      markdownPath: join("/reports/stock-analysis", "2026-07-15.md")
    });
  });

  it("resolves the <label>-preview.md name when deliver=false (prepare dry-run)", () => {
    expect(stockAnalysis.resolveReportPaths("/reports/stock-analysis", "2026-07-15", false)).toEqual({
      markdownPath: join("/reports/stock-analysis", "2026-07-15-preview.md")
    });
  });

  it("the preview path never equals the delivered archive path for the same label", () => {
    const delivered = stockAnalysis.resolveReportPaths("/reports/stock-analysis", "2026-07-15", true);
    const preview = stockAnalysis.resolveReportPaths("/reports/stock-analysis", "2026-07-15", false);
    expect(preview.markdownPath).not.toBe(delivered.markdownPath);
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
    const markdown = renderBatch({
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
      // Typed as `{}` to match what TypeScript infers for the .mjs's
      // `extraHeaders` parameter; the cast is where this test states what the
      // production caller actually passes.
      fetchJson: async (_url: unknown, headers: {} = {}) => {
        sentHeaders = headers as Record<string, string>;
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

  // 2026-07-30, the TSM/TWD defect: /stock/metric has no currency field, so
  // the amounts it returns were being written to stock_facts as USD whatever
  // exchange Finnhub resolved the ticker to. The fetcher must actually ASK
  // profile2 and act on the answer.
  it("probes /stock/profile2 for the reporting currency and drops the amounts when it is not USD", async () => {
    const requested: string[] = [];
    const result = await stockAnalysis.fetchFinnhubMetrics("TSM.US", {
      apiKey: "test-key",
      fetchJson: async (url: unknown) => {
        const href = String(url);
        requested.push(href);
        if (href.includes("/stock/profile2")) {
          return { currency: "TWD", exchange: "TAIWAN STOCK EXCHANGE" };
        }
        return { metric: { peTTM: 26.0932, pbQuarterly: 9.7158, epsTTM: 87.3818, marketCapitalization: 59_125_800 } };
      }
    });

    expect(requested.some((href) => href.includes("/stock/profile2") && href.includes("symbol=TSM"))).toBe(true);
    expect(result.trailingPE).toBe(26.0932);
    expect(result.marketCap).toBeUndefined();
    expect(result.epsTrailingTwelveMonths).toBeUndefined();
    expect(JSON.stringify(result.fieldFailures)).toContain("TWD");
  });

  it("still returns the metrics when only the currency probe fails, and says the currency is unconfirmed", async () => {
    const result = await stockAnalysis.fetchFinnhubMetrics("AMZN.US", {
      apiKey: "test-key",
      fetchJson: async (url: unknown) => {
        if (String(url).includes("/stock/profile2")) {
          throw new Error("503 Service Unavailable");
        }
        return { metric: { peTTM: 27.4988, marketCapitalization: 2_496_832.8 } };
      }
    });

    expect(result.error).toBeUndefined();
    expect(result.trailingPE).toBe(27.4988);
    expect(result.marketCap).toBeUndefined();
    expect(JSON.stringify(result.fieldFailures)).toContain("未能确认");
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
    // fetchFundamentalSnapshots returns either a merged snapshot or `{error}`;
    // reaching for `sources` without deciding which would read as a merge that
    // silently produced nothing.
    if ("error" in merged) {
      throw new Error(`fetchFundamentalSnapshots degraded instead of merging: ${String(merged.error)}`);
    }
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
    expect(narrativeOf(record).degraded).toBe(false);
    expect(narrativeOf(record).sections.every((entry: { narrative: boolean }) => entry.narrative)).toBe(true);

    const markdown = renderBatch({ label: LABEL, generatedAt: GENERATED_AT, records: [record], failedSymbols: [] });

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

    const markdown = renderBatch({ label: LABEL, generatedAt: GENERATED_AT, records: [record], failedSymbols: [] });
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
      sectionKey === "fundamentals" ? { text: "基本面方面，本季度预计增长 4321.99 个基点。" } : { text: "本段改写为中文叙述。" };

    await stockAnalysis.attachNarrativeSections(db, LABEL, [record], { narrativeBackend: fabricatingBackend });

    const markdown = renderBatch({ label: LABEL, generatedAt: GENERATED_AT, records: [record], failedSymbols: [] });
    const fundamentalsBlock = at(
      at(markdown.split("### 基本面"), 1, "the rendered markdown has no 基本面 section").split("###"),
      0,
      "the 基本面 section is empty"
    );

    expect(fundamentalsBlock).toContain("（叙事降级：数字比对未通过）");
    expect(fundamentalsBlock).not.toContain("4321.99");
    // The deterministic bullet appears exactly once - the marker is appended,
    // the bullets are not re-emitted alongside it.
    const firstFundamentalsBullet = at(record.analysis.fundamentals as string[], 0, "the fixture has no fundamentals bullets");
    expect(fundamentalsBlock.split(firstFundamentalsBullet).length - 1).toBe(1);
    expect(validateStockAnalysisMarkdown(markdown).ok).toBe(true);
  });
});

// 2026-07-28 (spec drift A3). The scheduled run handed deliverReportToFeishu
// only {title, markdown, markdownPath}. That was harmless while a
// report was delivered as summary-plus-chapters, but the payload is now a
// conclusion card whose ONLY route to the full text is the deep link built from
// reportKind + reportDate - so with those absent the reader got a card with no
// way to reach the analysis. The payload is the contract that decides this, so
// it is built by a named function and asserted directly.
describe("stock-analysis Feishu delivery payload (spec drift A3)", () => {
  it("names the stock-analysis platform page and the batch date so the card gets a deep link", () => {
    const payload = stockAnalysis.buildStockAnalysisDeliveryPayload({
      label: "2026-07-28",
      markdown: "# OpenClaw 个股分析 2026-07-28\n\n## 本批次结论\n\n- AAPL.US：支撑位 276.83。",
      markdownPath: "/tmp/reports/2026-07-28.md"
    });

    expect(payload).not.toHaveProperty("pdfPath");
    expect(payload.reportKind).toBe("stock-analysis");
    expect(payload.reportDate).toBe("2026-07-28");
    expect(payload.title).toBe("OpenClaw 个股分析 2026-07-28");
    expect(payload.markdown).toContain("AAPL.US：支撑位 276.83。");
  });

  it("produces a card carrying both the batch conclusion and a working deep link", async () => {
    const notifications = await import("../../../packages/shared-types/dist/index.js");
    const previousBaseUrl = process.env.PLATFORM_PUBLIC_BASE_URL;
    process.env.PLATFORM_PUBLIC_BASE_URL = "https://reports.qingverse.com";
    try {
      const card = notifications.buildReportConclusionCard(asDeliveryPayload(stockAnalysis.buildStockAnalysisDeliveryPayload({
        label: "2026-07-28",
        markdown: "# OpenClaw 个股分析 2026-07-28\n\n## 本批次结论\n\n- AAPL.US：支撑位 276.83；阻力位 312.51。",
        markdownPath: "/tmp/reports/2026-07-28.md"
      })));

      expect(card.url).toEqual({ text: "查看完整报告", href: "https://reports.qingverse.com/stock-analysis/2026-07-28" });
      expect(card.lines.join("\n")).toContain("AAPL.US：支撑位 276.83；阻力位 312.51。");
      expect(card.lines.join("\n")).not.toContain("未指定平台页面");
    } finally {
      if (previousBaseUrl === undefined) {
        delete process.env.PLATFORM_PUBLIC_BASE_URL;
      } else {
        process.env.PLATFORM_PUBLIC_BASE_URL = previousBaseUrl;
      }
    }
  });
});

// 2026-07-28 (spec drift R3/F7). 个股分析 was the only report producer that
// declared no `scope`, so the delivery layer classified it "undeclared" and
// both channels got it wrong - measured, on this exact payload, before the fix:
//
//   app credentials + FEISHU_GROUP_CHAT_ID=oc_public_group
//     -> {sent:true, target:"feishu-app-open-id"}, receive_id ou_global_member.
//        The 公共资产 (§1.2/§1.4) went to the operator's DM and the group never
//        saw it, with groupFallback UNSET so nothing in the run log said so.
//   legacy shared-chat channel
//     -> {sent:false, reason:"...未经声明的内容一律不进共享会话"}, plugin never
//        spawned. R2 made undeclared fail closed, so on a deployment with no
//        FEISHU_APP_ID/SECRET the batch silently stopped being delivered.
//
// These drive the REAL producer through the REAL delivery layer (the built
// dist the .mjs scripts import) on both channels, because the payload's own
// shape is what the previous test pair asserted and that is exactly what could
// be true while delivery still landed in the wrong chat.
describe("stock-analysis delivery scope (spec drift R3/F7)", () => {
  const envKeys = [
    "LARK_APP_ID",
    "LARK_APP_SECRET",
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_ACCOUNT_ID",
    "FEISHU_GROUP_CHAT_ID",
    "FEISHU_NOTIFY_OPEN_ID",
    "FEISHU_NOTIFY_CHAT_ID",
    "FEISHU_WEBHOOK_URL",
    "FEISHU_USER_PLUGIN_BOT_CHAT_ID",
    "FEISHU_USER_PLUGIN_COMMAND",
    "FEISHU_USER_PLUGIN_ARGS",
    "FEISHU_USER_PLUGIN_DISABLED",
    "FEISHU_NOTIFICATION_RETRY_ATTEMPTS",
    "PLATFORM_PUBLIC_BASE_URL",
    "HOME"
  ] as const;
  const savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};
  const savedCwd = process.cwd();
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      if (key !== "HOME") {
        delete process.env[key];
      }
    }
    process.env.FEISHU_NOTIFICATION_RETRY_ATTEMPTS = "1";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (process.cwd() !== savedCwd) {
      process.chdir(savedCwd);
    }
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  /** The payload runAnalysis itself hands deliverReportToFeishu. */
  function realBatchPayload(): Record<string, unknown> {
    return stockAnalysis.buildStockAnalysisDeliveryPayload({
      label: "2026-07-28",
      markdown: "# OpenClaw 个股分析 2026-07-28\n\n## 本批次结论\n\n- AAPL.US：支撑位 276.83；阻力位 312.51。",
      markdownPath: "/tmp/reports/2026-07-28.md"
    }) as Record<string, unknown>;
  }

  /** Isolates both sqlite/credential sources resolveFeishuAppTarget can reach
   * (cwd-derived notification_targets, $HOME-derived ~/.openclaw) into a temp
   * dir, so nothing here can read or write runtime/trading.sqlite. */
  function isolateHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "alphaloop-stock-analysis-delivery-"));
    tempDirs.push(dir);
    process.env.HOME = dir;
    process.chdir(dir);
    return dir;
  }

  it("declares itself 圈子公开, per §1.2「个股分析是公共资产，谁都能看」", () => {
    expect(realBatchPayload().scope).toEqual({ visibility: "circle-public" });
    expect(realBatchPayload().audience).toBe("group");
    // Not owner-scoped in any form: a batch covers the union of every member's
    // target list, so there is no member it could belong to.
    expect(realBatchPayload().openId).toBeUndefined();
  });

  it("lands in the circle's group chat on the app-credential channel, not the operator's DM", async () => {
    const notifications = await import("../../../packages/shared-types/dist/index.js");
    isolateHome();
    process.env.FEISHU_APP_ID = "cli_trading_copilot";
    process.env.FEISHU_APP_SECRET = "app-secret-x";
    process.env.FEISHU_GROUP_CHAT_ID = "oc_public_group";
    // The DM target the undeclared payload used to be delivered to. It stays
    // configured on purpose: the assertion is that the group wins over it.
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_global_member";

    const sends: Array<{ url: string; receiveId: string }> = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("tenant_access_token")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-token", expire: 7200 }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { receive_id: string };
      sends.push({ url: href, receiveId: body.receive_id });
      return new Response(JSON.stringify({ code: 0, msg: "success", data: { message_id: "om_batch" } }), { status: 200 });
    }) as typeof fetch;

    const result = await notifications.deliverReportToFeishu(asDeliveryPayload(realBatchPayload()));

    expect(result.sent).toBe(true);
    expect(result.target).toBe("feishu-app-chat-id");
    expect(result.groupFallback).toBeFalsy();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.url).toContain("receive_id_type=chat_id");
    expect(sends[0]!.receiveId).toBe("oc_public_group");
  });

  // 2026-07-28 (R4, I13). On the fallback path `delivery.sent` was TRUE, so the
  // producer took its success branch and logged {delivered:true, ...} with
  // `groupFallback`/`groupFallbackReason` never read - the one signal that a
  // 公共资产 went to one person's DM instead of the circle survived only inside
  // the JSON blob in stock_analysis_runs.delivery. Its sibling
  // (scheduled-report.mjs) wrote both into the state file and the envelope all
  // along.
  //
  // 2026-07-29 (J2). The fallback itself is gone - an unconfigured
  // FEISHU_GROUP_CHAT_ID is a refusal now, since DMing a 公共资产 to the
  // operator and returning sent:true is a wrong audience dressed as a success.
  // The preconditions below therefore assert the OPPOSITE of what they used to;
  // what this case is actually about - both fields reaching both sinks - is
  // unchanged, which is why it is updated rather than deleted.
  //
  // The `delivery` fed to the producer's summarizer here is NOT hand-written:
  // it is what the REAL delivery layer returns for the REAL batch payload on a
  // deployment with no FEISHU_GROUP_CHAT_ID, so the field names and the reason
  // text cannot drift from what production actually produces.
  it("surfaces groupFallback in both the state file and the stdout envelope when the group never got the card", async () => {
    const notifications = await import("../../../packages/shared-types/dist/index.js");
    isolateHome();
    process.env.FEISHU_APP_ID = "cli_trading_copilot";
    process.env.FEISHU_APP_SECRET = "app-secret-x";
    // No FEISHU_GROUP_CHAT_ID - the deployment shape that produces the fallback.
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_global_member";

    const sends: string[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("tenant_access_token")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-token", expire: 7200 }), { status: 200 });
      }
      sends.push((JSON.parse(String(init?.body)) as { receive_id: string }).receive_id);
      return new Response(JSON.stringify({ code: 0, msg: "success", data: { message_id: "om_batch" } }), { status: 200 });
    }) as typeof fetch;

    const delivery = await notifications.deliverReportToFeishu(asDeliveryPayload(realBatchPayload()));

    // Preconditions, measured rather than assumed: the card was NOT sent, the
    // group did not get it, and - the point of the refusal - neither did the
    // operator's DM. Not one outbound message.
    expect(delivery.sent).toBe(false);
    expect(delivery.groupFallback).toBe(true);
    expect(sends).toEqual([]);

    const { state, envelope } = stockAnalysis.buildStockAnalysisRunSummary({
      delivery,
      runId: "stock_analysis_run_test",
      generatedAt: "2026-07-28T12:00:00.000Z",
      deliveredSymbols: ["AAPL.US"],
      failedSymbols: [],
      markdownPath: "/tmp/reports/2026-07-28.md"
    });

    // stdout envelope: "delivered" is false, and the two fields say which
    // audience was missed rather than leaving a bare failure.
    expect(envelope.delivered).toBe(false);
    expect(envelope.groupFallback).toBe(true);
    expect(envelope.groupFallbackReason).toContain("FEISHU_GROUP_CHAT_ID");
    expect(envelope.deliveryReason).toContain("FEISHU_GROUP_CHAT_ID");
    // State file: the same two fields, same names as scheduled-report.mjs's.
    expect(state.groupFallback).toBe(true);
    expect(state.groupFallbackReason).toBe(delivery.groupFallbackReason);
    expect(state.groupFallbackReason).toContain("公共报告卡没有发出");
  });

  it("records groupFallback:false with no reason when the card did reach the group", async () => {
    const notifications = await import("../../../packages/shared-types/dist/index.js");
    isolateHome();
    process.env.FEISHU_APP_ID = "cli_trading_copilot";
    process.env.FEISHU_APP_SECRET = "app-secret-x";
    process.env.FEISHU_GROUP_CHAT_ID = "oc_public_group";

    globalThis.fetch = (async (url: string | URL) => {
      const body = String(url).includes("tenant_access_token")
        ? { code: 0, tenant_access_token: "t-token", expire: 7200 }
        : { code: 0, msg: "success", data: { message_id: "om_batch" } };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    const delivery = await notifications.deliverReportToFeishu(asDeliveryPayload(realBatchPayload()));
    const { state, envelope } = stockAnalysis.buildStockAnalysisRunSummary({
      delivery,
      runId: "stock_analysis_run_test",
      generatedAt: "2026-07-28T12:00:00.000Z",
      deliveredSymbols: ["AAPL.US"],
      failedSymbols: [],
      markdownPath: "/tmp/reports/2026-07-28.md"
    });

    // Written even on the good path: an absent key cannot be told apart from an
    // older build that never wrote one.
    expect(state.groupFallback).toBe(false);
    expect(state).not.toHaveProperty("groupFallbackReason");
    expect(envelope.groupFallback).toBe(false);
    expect(envelope).not.toHaveProperty("groupFallbackReason");
  });

  it("is published again on the legacy shared-chat channel instead of being refused as undeclared", async () => {
    const notifications = await import("../../../packages/shared-types/dist/index.js");
    const dir = isolateHome();
    const markerPath = join(dir, "plugin-was-spawned.log");
    const scriptPath = join(dir, "fake-plugin.mjs");
    writeFileSync(
      scriptPath,
      [
        `import { writeFileSync } from "node:fs";`,
        `writeFileSync(${JSON.stringify(markerPath)}, "spawned", "utf8");`,
        `import { createInterface } from "node:readline";`,
        `const rl = createInterface({ input: process.stdin, terminal: false });`,
        `rl.on("line", (line) => {`,
        `  const trimmed = line.trim();`,
        `  if (!trimmed) return;`,
        `  let message;`,
        `  try { message = JSON.parse(trimmed); } catch { return; }`,
        `  if (message.id === undefined) return;`,
        `  const result = message.method === "initialize"`,
        `    ? {}`,
        `    : { content: [{ type: "text", text: "Message sent (bot): om_batch_summary" }] };`,
        `  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");`,
        `});`,
        ""
      ].join("\n"),
      "utf8"
    );
    // App credentials must be genuinely unresolvable, or the machine running
    // the suite decides which channel this exercises.
    process.env.LARK_APP_ID = "test_app_id";
    process.env.LARK_APP_SECRET = "test_app_secret";
    process.env.FEISHU_ACCOUNT_ID = "__no_such_account__";
    process.env.FEISHU_USER_PLUGIN_BOT_CHAT_ID = "oc_shared_group_chat";
    process.env.FEISHU_USER_PLUGIN_COMMAND = process.execPath;
    process.env.FEISHU_USER_PLUGIN_ARGS = JSON.stringify([scriptPath]);

    const result = await notifications.deliverReportToFeishu(asDeliveryPayload(realBatchPayload()));

    expect(result.sent).toBe(true);
    expect(result.target).toBe("feishu-user-plugin-bot-post");
    expect(existsSync(markerPath)).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2026-07-30: what the report carries about its OWN age, and what a skipped
// scheduled slot does about it.
//
// The operator opened /stock/TSM.US and read "支撑位 398.37" - a level from the
// 2026-07-27 batch - while TSM traded near 375. Two things had to be true for
// that screen to exist: production had stopped (trading-schedule.mjs's cadence
// gate, fixed and pinned in trading-schedule.test.ts), and nothing on either
// side said how old the number was.
// ---------------------------------------------------------------------------

describe("renderBatchStockAnalysis: every symbol section states its own as-of before any price", () => {
  function renderWithQuote(quoteOverrides: Partial<Record<string, unknown>> = {}) {
    const symbol = "AAPL.US";
    // The record shape the REAL producer builds: fetchStockAnalysisRecord
    // returns {symbol, instrumentKind, quote, history, fundamentals,
    // optionChain, news, analysis} and passes that object straight into
    // renderBatchStockAnalysis - `quote` is normalizeQuotePayload's output,
    // which is the broker payload verbatim (report-data.mjs returns `quote`
    // unchanged). Its `timestamp` is the same field buildStockQuoteFacts
    // writes as every quote fact's `data_time`; on the mini that column holds
    // '2026-07-27T16:36:22.000Z' for TSM.US's quote.* rows, i.e. a full ISO
    // instant, which is what stockQuote() carries too.
    const quote = stockQuote({ symbol, ...quoteOverrides });
    const analysis = stockAnalysis.buildDeterministicAnalysis(
      symbol,
      quote,
      stockNewsList(),
      { history: stockHistorySeries(130, 180, 0.3), fundamentals: stockFundamentals(), optionChain: stockOptionChain() },
      GENERATED_AT
    );
    return renderBatch({
      label: GENERATED_AT.slice(0, 10),
      generatedAt: GENERATED_AT,
      records: [{ symbol, quote, news: stockNewsList(), analysis }],
      failedSymbols: []
    });
  }

  /** The line the platform app's stock page shows as this symbol's summary:
   * routes/stock.ts takes the first non-empty, non-heading line of the
   * `## SYMBOL` section. Re-implemented here (it is TypeScript in another
   * app's build, unreachable from this package) so a change to the section's
   * opening lines is caught on THIS side too. */
  function firstSummaryLine(markdown: string, symbol: string): string {
    const body = markdown.split(`## ${symbol}\n`)[1] ?? "";
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (!line || /^#{1,6}\s+/u.test(line)) {
        continue;
      }
      return line.replace(/^[-*]\s+/u, "");
    }
    return "";
  }

  it("makes the as-of the FIRST thing a reader of the section sees", () => {
    const summary = firstSummaryLine(renderWithQuote(), "AAPL.US");

    expect(summary).toContain("数据截至");
    expect(summary).toContain("本批次 2026-07-15");
    expect(summary).toContain("不是实时价");
  });

  it("carries the quote's own timestamp, not the batch date, as the quote as-of", () => {
    // stockQuote()'s timestamp is 2026-07-14T20:00:00.000Z - the trading day
    // BEFORE this batch's label, which is the normal case for a 21:00
    // Asia/Shanghai batch reading a US close. A stamp that quietly reused the
    // batch label here would overstate the price's freshness by a day.
    const summary = firstSummaryLine(renderWithQuote(), "AAPL.US");

    expect(summary).toContain("2026-07-15 04:00");
    expect(summary).not.toContain("行情时点：数据源未提供时间戳");
  });

  it("says the timestamp is missing rather than back-stamping it with the batch date", () => {
    const summary = firstSummaryLine(renderWithQuote({ timestamp: undefined }), "AAPL.US");

    expect(summary).toContain("行情时点：数据源未提供时间戳");
  });

  it("puts the as-of ahead of every support/resistance number in the section", () => {
    const markdown = renderWithQuote();
    const sectionStart = markdown.indexOf("## AAPL.US");
    const asOfIndex = markdown.indexOf("数据截至", sectionStart);
    const supportIndex = markdown.indexOf("支撑位", sectionStart);

    expect(asOfIndex).toBeGreaterThan(sectionStart);
    expect(supportIndex).toBeGreaterThan(asOfIndex);
  });

  it("stamps the batch-level summary too, so a quoted 本批次结论 carries its date", () => {
    const markdown = renderWithQuote();
    const batchStamp = markdown.slice(0, markdown.indexOf("## 本批次结论"));

    expect(batchStamp).toContain("数据截至：2026-07-15");
    expect(batchStamp).toContain("每 3 天一次");
  });

  it("still passes every existing stock-analysis quality gate with the stamps in place", () => {
    const result = validateStockAnalysisMarkdown(renderWithQuote());

    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("reportSkippedStockAnalysisSlot: a slot that produces nothing stops looking like health", () => {
  const reportsDir = "/tmp/alphaloop-stock-analysis-reports";

  function archiveBatch(db: DatabaseSync, generatedAt: string): void {
    const label = generatedAt.slice(0, 10);
    const paths = (stockAnalysis.resolveReportPaths as (
      dir: string,
      label: string,
      deliver: boolean
    ) => { markdownPath: string })(reportsDir, label, true);
    db.prepare(`
      INSERT INTO stock_analysis_runs (id, created_at, symbols, markdown_path, delivery)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      `stock_analysis_run_${label}`,
      generatedAt,
      JSON.stringify(["TSM.US"]),
      paths.markdownPath,
      JSON.stringify({ sent: true })
    );
  }

  function captureStdout(run: () => void): { lines: string[]; thrown: Error | null } {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    };
    let thrown: Error | null = null;
    try {
      run();
    } catch (error) {
      thrown = error as Error;
    } finally {
      console.log = original;
    }
    return { lines, thrown };
  }

  const skip = stockAnalysis.reportSkippedStockAnalysisSlot as (
    db: DatabaseSync,
    reason: string,
    state: { lastRunAt?: string },
    now?: Date
  ) => void;

  it("prints the measured age of what is on display, not just the skip reason", () => {
    const { db } = makeDb();
    archiveBatch(db, "2026-07-27T16:35:02.483Z");

    const { lines, thrown } = captureStdout(() => {
      skip(db, "not_due", { lastRunAt: "2026-07-27T16:35:02.483Z" }, new Date("2026-07-29T13:00:00.000Z"));
    });

    expect(thrown).toBeNull();
    const printed = JSON.parse(lines.join("\n")) as {
      skipped: boolean;
      reason: string;
      freshness: { latestLabel: string; ageDays: number; stale: boolean };
    };
    expect(printed.skipped).toBe(true);
    expect(printed.reason).toBe("not_due");
    expect(printed.freshness.latestLabel).toBe("2026-07-27");
    expect(printed.freshness.ageDays).toBe(2);
    expect(printed.freshness.stale).toBe(false);
  });

  it("THROWS once the analysis on display has gone stale, so the cron runner records a failure", () => {
    // This is the live failure reproduced: the mini's state file said
    // lastRunAt 2026-07-27T16:35:02.483Z and the 07-28 / 07-29 / 07-30 slots
    // all skipped `not_due` and exited 0. From the 4th day on, the slot now
    // exits non-zero instead - the only signal openclaw-cron-runner.mjs
    // escalates to Feishu.
    const { db } = makeDb();
    archiveBatch(db, "2026-07-27T16:35:02.483Z");

    const { thrown } = captureStdout(() => {
      skip(db, "not_due", { lastRunAt: "2026-07-27T16:35:02.483Z" }, new Date("2026-07-31T13:00:00.000Z"));
    });

    expect(thrown).not.toBeNull();
    expect(thrown?.message).toContain("个股分析已停摆");
    expect(thrown?.message).toContain("2026-07-27");
    expect(thrown?.message).toContain("not_due");
  });

  it("judges the archive, not the state file - a state file claiming a recent run does not buy silence", () => {
    // The exact dishonesty this guard exists to defeat: `lastRunAt` says the
    // pipeline ran an hour ago; the delivered archive says the newest batch is
    // a week old. The archive is what the platform app renders, so the archive
    // decides.
    const { db } = makeDb();
    archiveBatch(db, "2026-07-20T13:04:00.000Z");

    const { thrown } = captureStdout(() => {
      skip(db, "not_due", { lastRunAt: "2026-07-30T12:00:00.000Z" }, new Date("2026-07-30T13:00:00.000Z"));
    });

    expect(thrown?.message).toContain("最新批次为 2026-07-20");
  });

  it("fails a no-targets slot too when nothing has ever been produced", () => {
    const { db } = makeDb();

    const { thrown } = captureStdout(() => {
      skip(db, "no_targets", {}, new Date("2026-07-30T13:00:00.000Z"));
    });

    expect(thrown?.message).toContain("从未产出过个股分析批次");
    expect(thrown?.message).toContain("no_targets");
  });
});

// ---------------------------------------------------------------------------
// Task 23 (2026-07-30): honest rendering of the three-path probabilities
// ---------------------------------------------------------------------------
//
// Driven through the REAL producer (`buildDeterministicAnalysis`) with the
// same fixtures the confidence-heuristic cases above use, not against a
// re-typed copy of the format. The defect these pin was live on the mini:
// reports/stock-analysis/2026-07-27.md rendered
// 「- 上行路径（约 +31.00%）：…」 - a probability carrying the SIGNED
// two-decimal formatter meant for price change, with nothing anywhere saying
// the number is a hand-written heuristic rather than a model output.
describe("buildDeterministicAnalysis: three-path probability disclosure", () => {
  function conclusionOf(overrides: Partial<Record<string, unknown>> = {}): string[] {
    const analysis = stockAnalysis.buildDeterministicAnalysis(
      "AAPL.US",
      stockQuote(overrides),
      stockNewsList(),
      { history: stockHistorySeries(130, 180, 0.3), fundamentals: stockFundamentals(), optionChain: stockOptionChain() },
      GENERATED_AT
    );
    // §3.4 gave 多路径推演 its own section; the bullets used to sit in
    // `conclusion`. Read where the renderer actually puts them now.
    return analysis.paths as string[];
  }

  it("renders each path probability unsigned and without decimals", () => {
    const bullets = conclusionOf();
    const paths = bullets.filter((line) => /路径（约/u.test(line));
    expect(paths).toHaveLength(3);
    for (const line of paths) {
      expect(line).toMatch(/路径（约 \d{1,3}%）/u);
      // The exact defect: a `+` or a `.00` in front of a probability.
      expect(line).not.toMatch(/路径（约 [+-]/u);
      expect(line).not.toMatch(/路径（约 [\d.]*\.\d/u);
    }
  });

  it("prints the heuristic disclosure alongside the three paths", () => {
    const bullets = conclusionOf();
    expect(bullets).toContain(metrics.PATH_PROBABILITY_DISCLOSURE);
    // The disclosure must name what it is, its inputs and its clamp range -
    // asserted on the shipped literal, not on a paraphrase.
    expect(metrics.PATH_PROBABILITY_DISCLOSURE).toContain("确定性启发式");
    expect(metrics.PATH_PROBABILITY_DISCLOSURE).toContain("不是模型概率");
    expect(metrics.PATH_PROBABILITY_DISCLOSURE).toContain("当日涨跌幅");
    expect(metrics.PATH_PROBABILITY_DISCLOSURE).toContain("趋势分");
    expect(metrics.PATH_PROBABILITY_DISCLOSURE).toContain("20-60%");
    expect(metrics.PATH_PROBABILITY_DISCLOSURE).toContain("20-55%");
  });

  it("states clamp bounds that the arithmetic actually honours", () => {
    // A violently positive day cannot push the bullish path past its stated
    // ceiling, and cannot push the bearish path below its stated floor.
    const bullets = conclusionOf({ last: "400.00", prev_close: "200.00" });
    const bullish = Number(/上行路径（约 (\d+)%）/u.exec(bullets.join("\n"))?.[1]);
    const bearish = Number(/回撤路径（约 (\d+)%）/u.exec(bullets.join("\n"))?.[1]);
    expect(bullish).toBeLessThanOrEqual(metrics.PATH_PROBABILITY_BOUNDS.bullishMax);
    expect(bearish).toBeGreaterThanOrEqual(metrics.PATH_PROBABILITY_BOUNDS.bearishMin);
  });

  it("renders the conclusion box's headline probability the same way", () => {
    const analysis = stockAnalysis.buildDeterministicAnalysis(
      "AAPL.US",
      stockQuote(),
      stockNewsList(),
      { history: stockHistorySeries(130, 180, 0.3), fundamentals: stockFundamentals(), optionChain: stockOptionChain() },
      GENERATED_AT
    );
    expect(analysis.conclusionBox.coreConclusion).toMatch(/概率约 \d{1,3}%。$/u);
    expect(analysis.conclusionBox.coreConclusion).not.toContain("+");
  });
});

// ---------------------------------------------------------------------------
// Task 24 (2026-07-28 spec-drift remediation): on-demand `analyze <SYMBOL>`.
//
// Spec §3.4 produces 个股分析 "每 3 天批量 + 按需 + 站内研究触发" and §4 lists
// 分析请求 as a Feishu conversation capability, but the only two entry points
// were the 3-day batch and `prepare`'s file-writing dry run. These tests drive
// the REAL renderer and the REAL quality gate; only the network fetch is
// injected, and what it returns is the exact shape fetchStockAnalysisRecord
// builds (same keys, and `analysis` really is buildDeterministicAnalysis's
// output, not a hand-written stand-in).
// ---------------------------------------------------------------------------
describe("runAnalyzeOnDemand: single-symbol analysis a member can ask for in Feishu", () => {
  const analyzeOnDemand = stockAnalysis.runAnalyzeOnDemand as (
    symbols: string[],
    options?: {
      fetchRecords?: (
        targets: string[],
        options: { generatedAt: string }
      ) => Promise<{ records: unknown[]; failedSymbols: { symbol: string; error: string }[] }>;
      now?: Date;
    }
  ) => Promise<{
    ok: boolean;
    onDemand: boolean;
    symbol: string;
    generatedAt: string;
    published: boolean;
    note: string;
    markdown: string;
  }>;

  function realRecord(symbol: string, generatedAt: string) {
    const quote = stockQuote({ symbol });
    const history = stockHistorySeries(130, 180, 0.3);
    const fundamentals = stockFundamentals();
    const optionChain = stockOptionChain();
    const news = stockNewsList();
    return {
      symbol,
      instrumentKind: "stock",
      quote,
      history,
      fundamentals,
      optionChain,
      news,
      analysis: stockAnalysis.buildDeterministicAnalysis(
        symbol,
        quote,
        news,
        { history, fundamentals, optionChain, instrumentKind: "stock" },
        generatedAt
      )
    };
  }

  function fetchOne(symbol: string) {
    return async (_targets: string[], { generatedAt }: { generatedAt: string }) => ({
      records: [realRecord(symbol, generatedAt)],
      failedSymbols: []
    });
  }

  it("renders the full analysis for one symbol and passes the same quality gate a delivered batch does", async () => {
    const result = await analyzeOnDemand(["nvda.us"], {
      fetchRecords: fetchOne("NVDA.US"),
      now: new Date("2026-07-30T13:00:00.000Z")
    });

    expect(result.ok).toBe(true);
    expect(result.symbol).toBe("NVDA.US");
    expect(result.markdown).toContain("## NVDA.US");
    expect(result.markdown).toContain("### 结论框");
    // The gate the delivered batch has to pass, run against this exact output.
    expect(validateStockAnalysisMarkdown(result.markdown).ok).toBe(true);
  });

  it("says out loud that the answer is not published and carries no model prose", async () => {
    const result = await analyzeOnDemand(["NVDA.US"], {
      fetchRecords: fetchOne("NVDA.US"),
      now: new Date("2026-07-30T13:00:00.000Z")
    });

    expect(result.published).toBe(false);
    expect(result.note).toContain("未写入公共分析库");
    expect(result.note).toContain("没有叠加模型叙述");
    expect(result.note).toContain("/stock/NVDA.US");
  });

  it("writes nothing to reports/stock-analysis - the day's delivered batch is untouched", async () => {
    const reportsDir = join(process.cwd(), "reports", "stock-analysis");
    const before = existsSync(reportsDir) ? readdirSync(reportsDir).sort() : [];

    await analyzeOnDemand(["NVDA.US"], {
      fetchRecords: fetchOne("NVDA.US"),
      now: new Date("2026-07-30T13:00:00.000Z")
    });

    const after = existsSync(reportsDir) ? readdirSync(reportsDir).sort() : [];
    expect(after).toEqual(before);
  });

  it("refuses zero or multiple symbols instead of quietly analysing the wrong thing", async () => {
    await expect(analyzeOnDemand([])).rejects.toThrow(/一次只分析一只标的/u);
    await expect(analyzeOnDemand(["NVDA.US", "AAPL.US"])).rejects.toThrow(/一次只分析一只标的/u);
  });

  it("reports the fetch failure honestly instead of returning an empty analysis", async () => {
    await expect(
      analyzeOnDemand(["NVDA.US"], {
        fetchRecords: async () => ({ records: [], failedSymbols: [{ symbol: "NVDA.US", error: "行情读取失败。" }] })
      })
    ).rejects.toThrow(/行情读取失败/u);
  });
});
