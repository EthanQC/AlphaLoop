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
