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
});
