import { describe, expect, it } from "vitest";

const metrics = await import("./stock-analysis-metrics.mjs");

describe("stock analysis metrics", () => {
  it("extracts PE, PB, target price, and market cap from fallback sources", () => {
    const fundamentals = metrics.mergeFundamentalSnapshots([
      { source: "yahoo-quote", error: "401 Unauthorized" },
      metrics.normalizeNasdaqSummary({
        data: {
          summaryData: {
            OneYrTarget: { value: "$312.50" },
            MarketCap: { value: "4,275,929,952,280" }
          }
        }
      }),
      metrics.extractStockAnalysisStatistics(`
        <tr><td><span>PE Ratio</span></td><td title="35.293">35.29</td></tr>
        <tr><td><span>PB Ratio</span></td><td title="40.099">40.10</td></tr>
      `)
    ]);

    expect(fundamentals).toMatchObject({
      trailingPE: 35.293,
      priceToBook: 40.099,
      oneYearTarget: 312.5,
      marketCap: 4_275_929_952_280
    });
    expect(fundamentals.sources).toEqual(["nasdaq-summary", "stockanalysis-statistics"]);
  });

  it("summarizes upside potential from valuation, trend, target price, and option pressure", () => {
    const summary = metrics.summarizeUpsidePotential({
      lastPrice: 295,
      valuation: {
        trailingPE: 24,
        priceToBook: 5,
        oneYearTarget: 340,
        sources: ["nasdaq-summary", "stockanalysis-statistics"]
      },
      historyStats: {
        ma20: 290,
        ma60: 275,
        ma180: 260,
        trendScore: 8
      },
      optionStats: {
        callOpenInterest: 120_000,
        putOpenInterest: 60_000,
        expiration: "2026-06-19"
      }
    });

    expect(summary).toContain("综合上行潜力：偏强");
    expect(summary).toContain("目标价隐含空间 +15.25%");
    expect(summary).toContain("PE 24.00");
    expect(summary).toContain("PB 5.00");
    expect(summary).toContain("期权链");
  });

  // Task H7 (2026-07-14 legacy audit) fixed this function to label the
  // ACTUAL window (`longWindowDays`) instead of hardcoding "180 日" - these
  // tests pin that behavior in its new home (relocated here, verbatim, by
  // Phase 5 Task 1 so report-facts.mjs's buildStockFacts can reuse it).
  describe("summarizeHistory", () => {
    function closes(days: number, start = 200): Array<{ date: string; close: number }> {
      const startMs = new Date("2026-01-05T00:00:00.000Z").getTime();
      return Array.from({ length: days }, (_, i) => ({
        date: new Date(startMs + i * 86_400_000).toISOString().slice(0, 10),
        close: start + i * 0.1
      }));
    }

    it("labels longWindowDays as the REAL number of sessions available when fewer than 180 exist", () => {
      const result = metrics.summarizeHistory(closes(126), 212);

      expect(result.longWindowDays).toBe(126);
      expect(result.ma180).toEqual(expect.any(Number));
      expect(result.summary).not.toContain("180 日");
    });

    it("caps longWindowDays at 180 when more sessions are available", () => {
      const result = metrics.summarizeHistory(closes(220), 240);

      expect(result.longWindowDays).toBe(180);
    });

    it("returns an all-undefined shape with trendScore 0 when history is missing or empty", () => {
      const missing = metrics.summarizeHistory({ error: "读取失败" }, 100);
      expect(missing.trendScore).toBe(0);
      expect(missing.ma20).toBeUndefined();
      expect(missing.ma60).toBeUndefined();
      expect(missing.ma180).toBeUndefined();
      expect(missing.longWindowDays).toBeUndefined();
      expect(missing.summary).toContain("读取失败");

      const empty = metrics.summarizeHistory([], 100);
      expect(empty.longWindowDays).toBeUndefined();
    });

    it("computes ma20/ma60 as plain trailing averages of the closes", () => {
      const result = metrics.summarizeHistory(closes(60), 205.9);
      const allCloses = closes(60).map((row) => row.close);
      const expectedMa20 = allCloses.slice(-20).reduce((sum, v) => sum + v, 0) / 20;
      const expectedMa60 = allCloses.slice(-60).reduce((sum, v) => sum + v, 0) / 60;

      expect(result.ma20).toBeCloseTo(expectedMa20, 6);
      expect(result.ma60).toBeCloseTo(expectedMa60, 6);
    });
  });
});
