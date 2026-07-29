import { DatabaseSync } from "node:sqlite";

import { beforeEach, describe, expect, it } from "vitest";

import { createId, migrate } from "@packages/shared-types";

import { loadLatestFactSheet } from "./stock-facts.js";

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function insertFact(
  db: DatabaseSync,
  opts: {
    symbol: string;
    tradingDay: string;
    factKey: string;
    valueNum?: number | null;
    valueText?: string | null;
    unit?: string | null;
    source?: string;
    dataTime?: string;
  }
): void {
  db.prepare(`
    INSERT INTO stock_facts (id, trading_day, symbol, fact_key, value_num, value_text, unit, source, data_time, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    createId("stock_fact"),
    opts.tradingDay,
    opts.symbol,
    opts.factKey,
    opts.valueNum ?? null,
    opts.valueText ?? null,
    opts.unit ?? null,
    opts.source ?? "longbridge-quote",
    opts.dataTime ?? opts.tradingDay,
    opts.tradingDay
  );
}

describe("loadLatestFactSheet", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = memoryDb();
  });

  it("returns null for a symbol with no facts at all - never an empty sheet that reads as 'we looked and it's zero'", () => {
    expect(loadLatestFactSheet(db, "TSM.US")).toBeNull();
  });

  it("returns ONE trading day's facts, never a newest-per-key composite", () => {
    // The invariant that matters: mixing a fresh quote with a stale valuation
    // under a single 数据时间 header is exactly the silently-stale composite
    // this reader exists to avoid.
    insertFact(db, { symbol: "TSM.US", tradingDay: "2026-07-20", factKey: "valuation.pe", valueNum: 20 });
    insertFact(db, { symbol: "TSM.US", tradingDay: "2026-07-20", factKey: "quote.last", valueNum: 300 });
    insertFact(db, { symbol: "TSM.US", tradingDay: "2026-07-27", factKey: "quote.last", valueNum: 394.525 });

    const sheet = loadLatestFactSheet(db, "TSM.US");

    expect(sheet?.tradingDay).toBe("2026-07-27");
    expect(sheet?.byKey.get("quote.last")?.valueNum).toBe(394.525);
    // The older day's P/E is NOT carried forward into the newest day's sheet.
    expect(sheet?.byKey.has("valuation.pe")).toBe(false);
  });

  it("keeps each fact's own source and data_time (§0.4: 每个数字标注数据时间)", () => {
    insertFact(db, {
      symbol: "TSM.US",
      tradingDay: "2026-07-27",
      factKey: "quote.last",
      valueNum: 394.525,
      unit: "USD",
      source: "longbridge-quote",
      dataTime: "2026-07-27T16:36:22.000Z"
    });
    insertFact(db, {
      symbol: "TSM.US",
      tradingDay: "2026-07-27",
      factKey: "valuation.pe",
      valueNum: 26.8943,
      unit: "",
      source: "finnhub-metric、nasdaq-summary、stockanalysis-statistics",
      dataTime: "2026-07-27"
    });

    const sheet = loadLatestFactSheet(db, "TSM.US");

    // The live table really does hold both an instant and a bare day here.
    expect(sheet?.byKey.get("quote.last")?.dataTime).toBe("2026-07-27T16:36:22.000Z");
    expect(sheet?.byKey.get("valuation.pe")?.dataTime).toBe("2026-07-27");
    expect(sheet?.byKey.get("valuation.pe")?.source).toContain("finnhub-metric");
  });

  it("preserves a producer's own unavailability disclosure as text, never as a number", () => {
    // The live TSM.US row, verbatim.
    insertFact(db, {
      symbol: "TSM.US",
      tradingDay: "2026-07-27",
      factKey: "institutional.holdings",
      valueText: "不可得",
      source: "数据不可得（EDGAR 13F 已裁）"
    });

    const fact = loadLatestFactSheet(db, "TSM.US")?.byKey.get("institutional.holdings");

    expect(fact?.valueText).toBe("不可得");
    expect(fact?.valueNum).toBeNull(); // not coerced to 0
    expect(fact?.source).toContain("EDGAR 13F 已裁");
  });

  it("does not leak another symbol's facts", () => {
    insertFact(db, { symbol: "NVDA.US", tradingDay: "2026-07-27", factKey: "quote.last", valueNum: 180 });
    expect(loadLatestFactSheet(db, "TSM.US")).toBeNull();
  });
});
