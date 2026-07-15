import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openTradingDatabase } from "../../../packages/shared-types/dist/index.js";

const store = await import("./stock-facts-store.mjs");

const tempDirs: string[] = [];

function makeDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-stock-facts-store-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "trading.sqlite");
  return openTradingDatabase(dbPath);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function fact(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    factKey: "quote.last",
    valueNum: 210.5,
    unit: "USD",
    source: "longbridge-quote",
    dataTime: "2026-07-14T20:00:00.000Z",
    ...overrides
  };
}

describe("replaceStockFacts + getStockFacts", () => {
  it("round-trips facts keyed by fact_key", () => {
    const db = makeDb();

    store.replaceStockFacts(db, "2026-07-14", "AAPL.US", [
      fact(),
      fact({ factKey: "quote.pct", valueNum: 1.23, unit: "pct" })
    ]);

    const facts = store.getStockFacts(db, "2026-07-14", "AAPL.US");
    expect(facts["quote.last"].valueNum).toBe(210.5);
    expect(facts["quote.last"].source).toBe("longbridge-quote");
    expect(facts["quote.pct"].valueNum).toBe(1.23);
  });

  it("getStockFacts returns an empty object for a (day, symbol) with no facts", () => {
    const db = makeDb();
    expect(store.getStockFacts(db, "2026-01-01", "AAPL.US")).toEqual({});
  });

  it("replaces THIS symbol's facts on a subsequent call for the same trading_day - stale keys disappear", () => {
    const db = makeDb();

    store.replaceStockFacts(db, "2026-07-14", "AAPL.US", [
      fact({ factKey: "quote.last", valueNum: 1 }),
      fact({ factKey: "stale.key", valueNum: 2 })
    ]);
    store.replaceStockFacts(db, "2026-07-14", "AAPL.US", [
      fact({ factKey: "quote.last", valueNum: 3 })
    ]);

    const facts = store.getStockFacts(db, "2026-07-14", "AAPL.US");
    expect(facts["quote.last"].valueNum).toBe(3);
    expect(facts["stale.key"]).toBeUndefined();
  });

  // The exact trap replaceDailyFacts' whole-day delete would set for a
  // per-symbol table: a batch run analyzing many symbols on the same
  // trading_day must never let one symbol's refresh wipe out a SIBLING
  // symbol's facts for that same day. Pinned directly.
  it("does NOT touch a sibling symbol's facts for the same trading_day", () => {
    const db = makeDb();

    store.replaceStockFacts(db, "2026-07-14", "AAPL.US", [fact({ factKey: "quote.last", valueNum: 210.5 })]);
    store.replaceStockFacts(db, "2026-07-14", "MSFT.US", [fact({ factKey: "quote.last", valueNum: 430.1 })]);

    // Re-writing AAPL.US's facts must leave MSFT.US's row(s) for the SAME
    // trading_day completely untouched.
    store.replaceStockFacts(db, "2026-07-14", "AAPL.US", [fact({ factKey: "quote.last", valueNum: 212.0 })]);

    expect(store.getStockFacts(db, "2026-07-14", "AAPL.US")["quote.last"].valueNum).toBe(212.0);
    expect(store.getStockFacts(db, "2026-07-14", "MSFT.US")["quote.last"].valueNum).toBe(430.1);
  });

  it("does not touch a different trading_day's facts for the same symbol", () => {
    const db = makeDb();

    store.replaceStockFacts(db, "2026-07-13", "AAPL.US", [fact({ factKey: "quote.last", valueNum: 500.0 })]);
    store.replaceStockFacts(db, "2026-07-14", "AAPL.US", [fact({ factKey: "quote.last", valueNum: 522.31 })]);

    expect(store.getStockFacts(db, "2026-07-13", "AAPL.US")["quote.last"].valueNum).toBe(500.0);
    expect(store.getStockFacts(db, "2026-07-14", "AAPL.US")["quote.last"].valueNum).toBe(522.31);
  });

  it("round-trips a null valueNum with a valueText and disclosing source (missing-data facts)", () => {
    const db = makeDb();

    store.replaceStockFacts(db, "2026-07-14", "AAPL.US", [
      fact({ factKey: "institutional.holdings", valueNum: null, valueText: "不可得", unit: null, source: "数据不可得（EDGAR 13F 已裁）" })
    ]);

    const facts = store.getStockFacts(db, "2026-07-14", "AAPL.US");
    expect(facts["institutional.holdings"]).toEqual({
      valueNum: null,
      valueText: "不可得",
      unit: null,
      source: "数据不可得（EDGAR 13F 已裁）",
      dataTime: "2026-07-14T20:00:00.000Z"
    });
  });
});
