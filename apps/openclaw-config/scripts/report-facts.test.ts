import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openTradingDatabase } from "../../../packages/shared-types/dist/index.js";
import {
  buildDegradedOfficialPaperSnapshot,
  buildDegradedQuoteSnapshot,
  normalizeMacroCalendarPayload,
  normalizeOfficialPaperSnapshot,
  normalizeQuotePayload
} from "./report-data.mjs";
import { getDailyFacts } from "./news-store.mjs";
import { getStockFacts } from "./stock-facts-store.mjs";

const facts = await import("./report-facts.mjs");

const tempDirs: string[] = [];

function makeDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-report-facts-"));
  tempDirs.push(dir);
  return openTradingDatabase(join(dir, "trading.sqlite"));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function factMap(list: Array<Record<string, unknown>>): Record<string, Record<string, unknown>> {
  return Object.fromEntries(list.map((entry) => [entry.factKey as string, entry]));
}

function healthySnapshot() {
  return normalizeOfficialPaperSnapshot({
    check: {
      session: { token: "valid" },
      region: { active: "global", cached: "global" },
      connectivity: { global: { ok: true } }
    },
    assets: [{ net_assets: "100000", total_cash: "20000", buy_power: "50000", currency: "USD", risk_level: "low" }],
    positions: [
      { symbol: "QQQ.US", name: "Invesco QQQ", market: "US", currency: "USD", quantity: "10", available: "10", cost_price: "600" }
    ],
    fetchedAt: "2026-07-14T05:00:00.000Z"
  });
}

function healthyQuote() {
  return normalizeQuotePayload(
    { symbol: "QQQ.US", last: "700", prev_close: "693", open: "695", high: "705", low: "690", volume: "1000" },
    "QQQ.US"
  );
}

function macroEntries() {
  return normalizeMacroCalendarPayload({
    list: [
      {
        date: "2026-07-18",
        infos: [
          { id: "evt-1", content: "美国费城联储制造业指数", date: "20:30", market: "US", star: 2, type: "macrodata", datetime: "1752863400" }
        ]
      }
    ]
  });
}

describe("buildDailyFacts", () => {
  it("extracts every number the daily/weekly narrative renders from a healthy snapshot/quote", () => {
    const result = facts.buildDailyFacts({
      snapshot: healthySnapshot(),
      qqqQuote: healthyQuote(),
      macroEntries: macroEntries(),
      tradingDay: "2026-07-14"
    });

    const byKey = factMap(result);
    expect(byKey["qqq.price"].valueNum).toBe(700);
    expect(byKey["qqq.price"].unit).toBe("USD");
    expect(byKey["qqq.price"].source).toBe("longbridge-quote");
    // (700 - 693) / 693 * 100
    expect(byKey["qqq.changePct"].valueNum).toBeCloseTo((700 - 693) / 693 * 100, 6);
    expect(byKey["paper.netAssets"].valueNum).toBe(100000);
    expect(byKey["paper.totalCash"].valueNum).toBe(20000);
    // marketValue = 10 * 700 (live QQQ quote)
    expect(byKey["paper.marketValue"].valueNum).toBe(7000);
    // exposurePct = 7000 / 100000 * 100
    expect(byKey["paper.exposurePct"].valueNum).toBeCloseTo(7, 6);
    // remainingBudget = max(0, 100000 * 0.1 - 7000)
    expect(byKey["paper.remainingBudget"].valueNum).toBe(3000);
    expect(byKey["macro.eventCount"].valueNum).toBe(1);

    for (const entry of result) {
      expect(entry.source).toBeTruthy();
      expect(entry.dataTime).toBeTruthy();
    }
  });

  it("still writes every fact key for a degraded official-paper snapshot, with the source suffixed to disclose it", () => {
    const degradedSnapshot = buildDegradedOfficialPaperSnapshot({ fetchedAt: "2026-07-14T05:00:00.000Z", reason: "Longbridge 官方模拟盘资产返回为空。" });

    const result = facts.buildDailyFacts({
      snapshot: degradedSnapshot,
      qqqQuote: healthyQuote(),
      macroEntries: [],
      tradingDay: "2026-07-14"
    });

    const byKey = factMap(result);
    expect(byKey["paper.netAssets"]).toBeDefined();
    expect(byKey["paper.netAssets"].source).toContain("降级估值");
    expect(byKey["paper.totalCash"].source).toContain("降级估值");
    // netAssets is 0 (buildDegradedOfficialPaperSnapshot's shape), so
    // exposure/remaining-budget cannot be computed - null, not fabricated.
    expect(byKey["paper.exposurePct"].valueNum).toBeNull();
    expect(byKey["paper.remainingBudget"].valueNum).toBeNull();
  });

  it("still writes qqq.price/qqq.changePct for a degraded quote, with a null value and a disclosed source", () => {
    const result = facts.buildDailyFacts({
      snapshot: healthySnapshot(),
      qqqQuote: buildDegradedQuoteSnapshot("QQQ.US", { fetchedAt: "2026-07-14T05:00:00.000Z", reason: "行情读取失败" }),
      macroEntries: [],
      tradingDay: "2026-07-14"
    });

    const byKey = factMap(result);
    expect(byKey["qqq.price"].valueNum).toBeNull();
    expect(byKey["qqq.price"].valueText).toBe("不可用");
    expect(byKey["qqq.price"].source).toContain("降级估值");
    expect(byKey["qqq.changePct"].valueNum).toBeNull();
  });

  it("is deterministic - the same inputs always produce the same facts", () => {
    const input = {
      snapshot: healthySnapshot(),
      qqqQuote: healthyQuote(),
      macroEntries: macroEntries(),
      tradingDay: "2026-07-14"
    };

    expect(facts.buildDailyFacts(input)).toEqual(facts.buildDailyFacts(input));
  });
});

describe("persistDailyFacts", () => {
  it("wraps replaceDailyFacts - writes land in daily_facts and are readable back via getDailyFacts", () => {
    const db = makeDb();
    const built = facts.buildDailyFacts({
      snapshot: healthySnapshot(),
      qqqQuote: healthyQuote(),
      macroEntries: macroEntries(),
      tradingDay: "2026-07-14"
    });

    facts.persistDailyFacts(db, "2026-07-14", built);

    const stored = getDailyFacts(db, "2026-07-14");
    expect(stored["qqq.price"].valueNum).toBe(700);
    expect(stored["paper.netAssets"].valueNum).toBe(100000);
    expect(Object.keys(stored)).toHaveLength(built.length);
  });

  it("replaces the whole day's facts rather than merging (matches replaceDailyFacts semantics)", () => {
    const db = makeDb();
    facts.persistDailyFacts(db, "2026-07-14", [
      { factKey: "qqq.price", valueNum: 1, unit: "USD", source: "test", dataTime: "2026-07-14T00:00:00.000Z" },
      { factKey: "stale.key", valueNum: 2, unit: "USD", source: "test", dataTime: "2026-07-14T00:00:00.000Z" }
    ]);

    facts.persistDailyFacts(db, "2026-07-14", [
      { factKey: "qqq.price", valueNum: 3, unit: "USD", source: "test", dataTime: "2026-07-14T00:00:00.000Z" }
    ]);

    const stored = getDailyFacts(db, "2026-07-14");
    expect(stored["qqq.price"].valueNum).toBe(3);
    expect(stored["stale.key"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 5 Task 1: buildStockFacts / persistStockFacts
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

// 130 daily closes - deliberately LESS than 180, so longWindowDays (and the
// history.maLong fact's unit) must read "130日", never a hardcoded "180日".
function stockHistory(days = 130): Array<{ date: string; close: number }> {
  const rows: Array<{ date: string; close: number }> = [];
  const start = new Date("2026-01-05T00:00:00.000Z").getTime();
  for (let i = 0; i < days; i += 1) {
    rows.push({
      date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      close: 200 + i * 0.1
    });
  }
  return rows;
}

function stockFundamentals(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sources: ["yahoo-quote", "nasdaq-summary"],
    trailingPE: 28.5,
    priceToBook: 45.2,
    epsTrailingTwelveMonths: 6.5,
    marketCap: 3_200_000_000_000,
    oneYearTarget: 250,
    ...overrides
  };
}

function stockOptionChain() {
  return {
    expirationDates: [1755820800],
    options: [
      {
        calls: [{ openInterest: 1000 }, { openInterest: 500 }],
        puts: [{ openInterest: 700 }]
      }
    ]
  };
}

function stockNews(count = 3) {
  return Array.from({ length: count }, (_, i) => ({ id: `n${i}`, title: `新闻 ${i}`, source: "longbridge-news" }));
}

function stockFactMap(list: Array<Record<string, unknown>>): Record<string, Record<string, unknown>> {
  return Object.fromEntries(list.map((entry) => [entry.factKey as string, entry]));
}

describe("buildStockFacts", () => {
  it("extracts quote/valuation/history/options/news facts from healthy inputs", () => {
    const result = facts.buildStockFacts({
      symbol: "AAPL.US",
      quote: stockQuote(),
      history: stockHistory(),
      fundamentals: stockFundamentals(),
      optionChain: stockOptionChain(),
      news: stockNews(),
      tradingDay: "2026-07-14"
    });

    const byKey = stockFactMap(result);

    expect(byKey["quote.last"].valueNum).toBe(210.5);
    expect(byKey["quote.last"].unit).toBe("USD");
    expect(byKey["quote.last"].source).toBe("longbridge-quote");
    // (210.5 - 208) / 208 * 100
    expect((byKey["quote.pct"].valueNum as number)).toBeCloseTo((210.5 - 208) / 208 * 100, 6);
    expect(byKey["quote.volume"].valueNum).toBe(50_000_000);

    expect(byKey["valuation.pe"].valueNum).toBe(28.5);
    expect(byKey["valuation.pb"].valueNum).toBe(45.2);
    expect(byKey["valuation.eps"].valueNum).toBe(6.5);
    expect(byKey["valuation.marketCap"].valueNum).toBe(3_200_000_000_000);
    expect(byKey["valuation.targetPrice"].valueNum).toBe(250);
    expect(byKey["valuation.pe"].source).toBe("yahoo-quote、nasdaq-summary");

    expect(byKey["history.ma20"].valueNum).toEqual(expect.any(Number));
    expect(byKey["history.ma60"].valueNum).toEqual(expect.any(Number));
    expect(byKey["history.maLong"].valueNum).toEqual(expect.any(Number));

    expect(byKey["options.nextExpiry"].valueText).toBe(new Date(1755820800 * 1000).toISOString().slice(0, 10));
    expect(byKey["options.callOi"].valueNum).toBe(1500);
    expect(byKey["options.putOi"].valueNum).toBe(700);

    expect(byKey["news.count"].valueNum).toBe(3);

    for (const entry of result) {
      expect(entry.source).toBeTruthy();
      expect(entry.dataTime).toBeTruthy();
    }
  });

  it("history.maLong's unit carries the REAL window day count, never a hardcoded 180", () => {
    const result = facts.buildStockFacts({
      symbol: "AAPL.US",
      quote: stockQuote(),
      history: stockHistory(130),
      fundamentals: stockFundamentals(),
      optionChain: stockOptionChain(),
      news: stockNews(),
      tradingDay: "2026-07-14"
    });

    const byKey = stockFactMap(result);
    expect(byKey["history.maLong"].unit).toBe("130日");
    expect(byKey["history.maLong"].unit).not.toBe("180日");
  });

  it("history.maLong's window caps at 180 when more than 180 sessions are available", () => {
    const result = facts.buildStockFacts({
      symbol: "AAPL.US",
      quote: stockQuote(),
      history: stockHistory(220),
      fundamentals: stockFundamentals(),
      optionChain: stockOptionChain(),
      news: stockNews(),
      tradingDay: "2026-07-14"
    });

    expect(stockFactMap(result)["history.maLong"].unit).toBe("180日");
  });

  it("fundamentals wholly missing (fetch error) - every valuation fact is null with source '数据不可得'", () => {
    const result = facts.buildStockFacts({
      symbol: "AAPL.US",
      quote: stockQuote(),
      history: stockHistory(),
      fundamentals: { error: "估值来源均未返回可用数据" },
      optionChain: stockOptionChain(),
      news: stockNews(),
      tradingDay: "2026-07-14"
    });

    const byKey = stockFactMap(result);
    for (const key of ["valuation.pe", "valuation.pb", "valuation.eps", "valuation.marketCap", "valuation.targetPrice"]) {
      expect(byKey[key].valueNum).toBeNull();
      expect(byKey[key].source).toBe("数据不可得");
    }
  });

  it("a single missing fundamentals field is disclosed as '数据不可得' while sibling fields keep their real source", () => {
    const fundamentals = stockFundamentals();
    delete (fundamentals as Record<string, unknown>).epsTrailingTwelveMonths;

    const result = facts.buildStockFacts({
      symbol: "AAPL.US",
      quote: stockQuote(),
      history: stockHistory(),
      fundamentals,
      optionChain: stockOptionChain(),
      news: stockNews(),
      tradingDay: "2026-07-14"
    });

    const byKey = stockFactMap(result);
    expect(byKey["valuation.eps"].valueNum).toBeNull();
    expect(byKey["valuation.eps"].source).toBe("数据不可得");
    expect(byKey["valuation.pe"].valueNum).toBe(28.5);
    expect(byKey["valuation.pe"].source).toBe("yahoo-quote、nasdaq-summary");
  });

  it("history read failure - ma20/ma60/maLong are null, source '数据不可得', unit null", () => {
    const result = facts.buildStockFacts({
      symbol: "AAPL.US",
      quote: stockQuote(),
      history: { error: "Yahoo chart 历史走势接口读取失败" },
      fundamentals: stockFundamentals(),
      optionChain: stockOptionChain(),
      news: stockNews(),
      tradingDay: "2026-07-14"
    });

    const byKey = stockFactMap(result);
    for (const key of ["history.ma20", "history.ma60", "history.maLong"]) {
      expect(byKey[key].valueNum).toBeNull();
      expect(byKey[key].source).toBe("数据不可得");
    }
    expect(byKey["history.maLong"].unit).toBeNull();
  });

  it("option chain read failure - nextExpiry/callOi/putOi are null with source '数据不可得'", () => {
    const result = facts.buildStockFacts({
      symbol: "AAPL.US",
      quote: stockQuote(),
      history: stockHistory(),
      fundamentals: stockFundamentals(),
      optionChain: { error: "Yahoo options 期权链接口读取失败" },
      news: stockNews(),
      tradingDay: "2026-07-14"
    });

    const byKey = stockFactMap(result);
    expect(byKey["options.nextExpiry"].valueText).toBe("不可得");
    expect(byKey["options.nextExpiry"].source).toBe("数据不可得");
    expect(byKey["options.callOi"].valueNum).toBeNull();
    expect(byKey["options.putOi"].valueNum).toBeNull();
  });

  it("institutional.holdings is always disclosed as unavailable (EDGAR 13F cut from scope), regardless of other inputs", () => {
    const result = facts.buildStockFacts({
      symbol: "AAPL.US",
      quote: stockQuote(),
      history: stockHistory(),
      fundamentals: stockFundamentals(),
      optionChain: stockOptionChain(),
      news: stockNews(),
      tradingDay: "2026-07-14"
    });

    const byKey = stockFactMap(result);
    expect(byKey["institutional.holdings"].valueNum).toBeNull();
    expect(byKey["institutional.holdings"].source).toBe("数据不可得（EDGAR 13F 已裁）");
  });

  it("is deterministic - the same inputs always produce the same facts", () => {
    const input = {
      symbol: "AAPL.US",
      quote: stockQuote(),
      history: stockHistory(),
      fundamentals: stockFundamentals(),
      optionChain: stockOptionChain(),
      news: stockNews(),
      tradingDay: "2026-07-14"
    };

    expect(facts.buildStockFacts(input)).toEqual(facts.buildStockFacts(input));
  });
});

describe("persistStockFacts", () => {
  it("wraps replaceStockFacts - writes land in stock_facts and are readable back via getStockFacts", () => {
    const db = makeDb();
    const built = facts.buildStockFacts({
      symbol: "AAPL.US",
      quote: stockQuote(),
      history: stockHistory(),
      fundamentals: stockFundamentals(),
      optionChain: stockOptionChain(),
      news: stockNews(),
      tradingDay: "2026-07-14"
    });

    facts.persistStockFacts(db, "2026-07-14", "AAPL.US", built);

    const stored = getStockFacts(db, "2026-07-14", "AAPL.US");
    expect(stored["quote.last"].valueNum).toBe(210.5);
    expect(Object.keys(stored)).toHaveLength(built.length);
  });

  it("does not touch a sibling symbol's facts for the same trading_day", () => {
    const db = makeDb();
    const aaplFacts = facts.buildStockFacts({
      symbol: "AAPL.US",
      quote: stockQuote(),
      history: stockHistory(),
      fundamentals: stockFundamentals(),
      optionChain: stockOptionChain(),
      news: stockNews(),
      tradingDay: "2026-07-14"
    });
    const msftFacts = facts.buildStockFacts({
      symbol: "MSFT.US",
      quote: stockQuote({ symbol: "MSFT.US", last: "430.10" }),
      history: stockHistory(),
      fundamentals: stockFundamentals(),
      optionChain: stockOptionChain(),
      news: stockNews(),
      tradingDay: "2026-07-14"
    });

    facts.persistStockFacts(db, "2026-07-14", "AAPL.US", aaplFacts);
    facts.persistStockFacts(db, "2026-07-14", "MSFT.US", msftFacts);
    // Re-writing AAPL.US must not disturb MSFT.US's rows for the same day.
    facts.persistStockFacts(db, "2026-07-14", "AAPL.US", aaplFacts);

    expect(getStockFacts(db, "2026-07-14", "MSFT.US")["quote.last"].valueNum).toBe(430.1);
  });
});
