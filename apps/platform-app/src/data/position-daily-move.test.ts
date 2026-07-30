/**
 * §1.6's 持仓当日涨跌条形图 reader, tested against THE REAL PRODUCER.
 *
 * The card this feeds replaced a hard-coded 「数据不足——当日涨跌需行情接入
 * （P6）」 that had been wrong for weeks: `quote.pct` was already in the table.
 * The reader therefore depends on two facts about the producer that a
 * hand-written INSERT would let us get wrong silently, which is exactly the
 * failure mode eight prior rounds of this project kept hitting:
 *
 *   1. the fact_key is literally `quote.pct` - not `quote.changePct`, not
 *      `quote.pctChange`;
 *   2. its `value_num` is a SIGNED PERCENTAGE (`-2.20` for -2.2%), not a
 *      decimal ratio (`-0.022`). Reading a ratio as a percentage would draw
 *      every bar at ~1/100th of its length and label it 「-0.02%」, and no
 *      hand-authored fixture would ever notice.
 *
 * So nothing here writes `stock_facts` by hand. Rows are produced by
 * report-facts.mjs's `buildStockFacts` (the function stock-analysis.mjs calls)
 * and persisted by its `persistStockFacts`, from a Longbridge quote payload in
 * the shape `_longbridge.mjs` returns. The one payload below is the REAL
 * TSM.US quote behind the deployed mini's 2026-07-27 stock analysis
 * (`reports/stock-analysis/2026-07-27.md` prints exactly these numbers:
 * "最新报394.52美元，跌幅为-2.20%...开盘价为405.94美元...前收403.41...
 * 388.81美元至407.43美元...成交量8,570,295股"), and the mini's own
 * `stock_facts` row for it reads `quote.last = 394.525`.
 */
import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import { migrate } from "@packages/shared-types";

import { loadPositionDailyMoves } from "./stock-facts.js";

// eslint-disable-next-line import/no-unresolved -- plain .mjs, no dist
const reportFacts = await import("../../../openclaw-config/scripts/report-facts.mjs");

/** The real Longbridge quote payload shape (snake_case keys - `_longbridge.mjs`
 * passes the API's own field names through), TSM.US on 2026-07-27. */
const TSM_QUOTE = {
  last: 394.525,
  prev_close: 403.41,
  open: 405.94,
  high: 407.43,
  low: 388.81,
  volume: 8570295,
  timestamp: "2026-07-27T16:36:22.000Z"
};

/** Same day, a symbol whose quote came back WITHOUT a previous close - the
 * producer's own 数据不可得 branch (report-facts.mjs's buildStockQuoteFacts
 * stamps that source when an input is absent), which is how a real feed gap
 * reaches this reader. */
const NO_PREV_CLOSE_QUOTE = { last: 210.5, volume: 1000 };

const DAY = "2026-07-27";

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

/** Writes one symbol's facts the way the production pipeline does. */
function produceFacts(db: DatabaseSync, symbol: string, quote: Record<string, unknown>): void {
  const facts = reportFacts.buildStockFacts({
    symbol,
    quote,
    history: {},
    fundamentals: {},
    optionChain: {},
    news: [],
    tradingDay: DAY
  });
  reportFacts.persistStockFacts(db, DAY, symbol, facts);
}

describe("loadPositionDailyMoves: reads the producer's own quote.pct", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = memoryDb();
  });

  it("agrees with the number the report prints, as a signed PERCENTAGE not a ratio", () => {
    produceFacts(db, "TSM.US", TSM_QUOTE);

    const [move] = loadPositionDailyMoves(db, ["TSM.US"]);

    // (394.525 - 403.41) / 403.41 * 100 = -2.2025...%, which the shipped
    // report rounds to "-2.20%". The guard that matters: the magnitude is
    // percent-scaled, so a ratio (-0.022) would fail both bounds below.
    expect(move?.pct).toBeCloseTo(-2.2025, 3);
    expect(Math.abs(move?.pct ?? 0)).toBeGreaterThan(1);
    expect(Math.abs(move?.pct ?? 0)).toBeLessThan(10);
    expect(move?.tradingDay).toBe(DAY);
    // The producer stamps the quote's own instant, not the trading day, when
    // the payload carries a timestamp - the page labels its data time from it.
    expect(move?.dataTime).toBe(TSM_QUOTE.timestamp);
    expect(move?.reason).toBeUndefined();
  });

  it("reports a missing quote.pct as null WITH the producer's reason - never as 0%", () => {
    produceFacts(db, "AAPL.US", NO_PREV_CLOSE_QUOTE);

    const [move] = loadPositionDailyMoves(db, ["AAPL.US"]);

    expect(move?.pct).toBeNull();
    expect(move?.pct).not.toBe(0);
    expect(move?.reason).toContain("当日涨跌不可得");
    // Still dated: the symbol HAS facts for this day, just not a usable pct.
    expect(move?.tradingDay).toBe(DAY);
  });

  it("distinguishes 'no facts at all' from 'facts without a pct'", () => {
    produceFacts(db, "AAPL.US", NO_PREV_CLOSE_QUOTE);

    const [known, unknown] = loadPositionDailyMoves(db, ["AAPL.US", "NEVER.US"]);

    expect(known?.tradingDay).toBe(DAY);
    expect(unknown?.pct).toBeNull();
    expect(unknown?.tradingDay).toBeNull();
    expect(unknown?.reason).toBe("没有任何行情事实行");
  });

  it("preserves the caller's symbol order (the page orders by position value)", () => {
    produceFacts(db, "TSM.US", TSM_QUOTE);
    produceFacts(db, "AAPL.US", NO_PREV_CLOSE_QUOTE);

    expect(loadPositionDailyMoves(db, ["AAPL.US", "TSM.US"]).map((m) => m.symbol)).toEqual(["AAPL.US", "TSM.US"]);
    expect(loadPositionDailyMoves(db, ["TSM.US", "AAPL.US"]).map((m) => m.symbol)).toEqual(["TSM.US", "AAPL.US"]);
  });

  it("reads the NEWEST trading day when a symbol has several", () => {
    produceFacts(db, "TSM.US", TSM_QUOTE);
    const laterFacts = reportFacts.buildStockFacts({
      symbol: "TSM.US",
      quote: { last: 375.2, prev_close: 394.525, volume: 5_000_000, timestamp: "2026-07-30T16:36:00.000Z" },
      history: {},
      fundamentals: {},
      optionChain: {},
      news: [],
      tradingDay: "2026-07-30"
    });
    reportFacts.persistStockFacts(db, "2026-07-30", "TSM.US", laterFacts);

    const [move] = loadPositionDailyMoves(db, ["TSM.US"]);
    expect(move?.tradingDay).toBe("2026-07-30");
    expect(move?.pct).toBeCloseTo(-4.8983, 3);
  });
});
