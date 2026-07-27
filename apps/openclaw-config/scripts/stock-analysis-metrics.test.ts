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

  // 2026-07-27 adversarial review of ca4cc52: this line still shipped bare
  // placeholders ("目标价缺失", "PE 暂无") and a DERIVED "趋势分 0.00" that reads
  // like a measured value, while the rest of the commit had already switched
  // to reason-carrying disclosures.
  describe("summarizeUpsidePotential: no bare placeholders, no fabricated zero", () => {
    it("states WHY each missing metric is missing, and never prints a trend score it could not compute", () => {
      const summary = metrics.summarizeUpsidePotential({
        lastPrice: 295,
        valuation: { sources: ["nasdaq-summary"], failures: ["finnhub-metric：Finnhub 指标接口返回 429"] },
        historyStats: metrics.summarizeHistory({ error: "Nasdaq 历史行情触发限流，当前维度待验证" }, 295),
        optionStats: { summary: "期权链读取失败：Nasdaq 期权链未返回合约。" }
      });

      // Brief form here (the full source-by-source reason lives on the
      // 估值补充 bullet; this line repeats in three sections per symbol).
      expect(summary).toContain("PE 不可得（估值来源未返回该字段，原因见估值补充）");
      expect(summary).toContain("PB 不可得（估值来源未返回该字段，原因见估值补充）");
      expect(summary).toContain("目标价隐含空间 不可得（");
      expect(summary).toContain("趋势分 不可得（历史走势读取失败：");
      expect(summary).not.toContain("暂无");
      expect(summary).not.toContain("目标价缺失");
      expect(summary).not.toContain("趋势分 0.00");
    });

    it("uses the ETF's structural wording here too, so both valuation lines agree", () => {
      const summary = metrics.summarizeUpsidePotential({
        lastPrice: 281,
        valuation: { sources: ["nasdaq-summary"], failures: [], marketCap: 97_291_489_986 },
        historyStats: metrics.summarizeHistory([{ date: "2026-07-15", close: 280 }], 281),
        optionStats: { summary: "期权链读取失败：无合约。" },
        instrumentKind: "etf"
      });

      expect(summary).toContain("PE 不适用（ETF 无市盈率口径");
      expect(summary).toContain("目标价隐含空间 不适用（ETF 无卖方一年目标价");
      expect(summary).not.toContain("不可得");
    });

    // 2026-07-27, second adversarial pass: `targetUpside` is undefined for
    // three distinct causes (no target, no/invalid price, ETF), and the
    // disclosure used to blame the valuation source for all of them.
    it("names the missing PRICE - not a missing valuation field - when the target exists but the quote carries no price", () => {
      const summary = metrics.summarizeUpsidePotential({
        lastPrice: undefined,
        valuation: { sources: ["nasdaq-summary"], failures: [], oneYearTarget: 340, trailingPE: 24, priceToBook: 5 },
        historyStats: { ma20: 290, ma60: 275, trendScore: 1, available: true },
        optionStats: { summary: "期权链只读补充。" }
      });

      expect(summary).toContain("目标价隐含空间 不可得（已取到一年目标价，但行情未返回可用现价，无法计算隐含空间）");
      expect(summary).not.toContain("目标价隐含空间 不可得（估值来源未返回该字段");
    });

    it("names a non-positive price explicitly rather than calling the field unreturned", () => {
      const summary = metrics.summarizeUpsidePotential({
        lastPrice: 0,
        valuation: { sources: ["nasdaq-summary"], failures: [], oneYearTarget: 340 },
        historyStats: { ma20: 290, ma60: 275, trendScore: 1, available: true },
        optionStats: { summary: "期权链只读补充。" }
      });

      expect(summary).toContain("目标价隐含空间 不可得（已取到一年目标价，但行情返回的现价不是正数，无法计算隐含空间）");
    });

    it("keeps blaming the valuation source only when the TARGET itself is the missing piece", () => {
      const summary = metrics.summarizeUpsidePotential({
        lastPrice: 295,
        valuation: { sources: ["nasdaq-summary"], failures: [], trailingPE: 24, priceToBook: 5 },
        historyStats: { ma20: 290, ma60: 275, trendScore: 1, available: true },
        optionStats: { summary: "期权链只读补充。" }
      });

      expect(summary).toContain("目标价隐含空间 不可得（估值来源未返回该字段，原因见估值补充）");
    });

    it("still prints a real trend score of exactly 0 when history WAS available", () => {
      const summary = metrics.summarizeUpsidePotential({
        lastPrice: 295,
        valuation: { trailingPE: 24, priceToBook: 5, oneYearTarget: 340 },
        historyStats: { ma20: 290, ma60: 275, trendScore: 0, available: true },
        optionStats: { summary: "期权链只读补充。" }
      });

      expect(summary).toContain("趋势分 0.00");
    });
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

    // 2026-07-27, second adversarial pass: closes.slice(-20)/slice(-60) return
    // the WHOLE array when the sample is shorter than the window, so a
    // 12-session mean used to be published under a "20 日" label - the exact
    // mislabeling this file's own header comment documents (and fixed) for the
    // 180-day average.
    it("never passes a short sample off as a full 20/60-day average - it discloses the real sample size", () => {
      const result = metrics.summarizeHistory(closes(12), 205);

      expect(result.sampleDays).toBe(12);
      expect(result.ma20).toBeUndefined();
      expect(result.ma60).toBeUndefined();
      expect(result.movingAverageDisclosures.ma20).toBe("样本不足 20 日，实际仅 12 个交易日");
      expect(result.movingAverageDisclosures.ma60).toBe("样本不足 60 日，实际仅 12 个交易日");
      // The long window keeps its existing, already-truthful label.
      expect(result.longWindowDays).toBe(12);
      expect(result.ma180).toEqual(expect.any(Number));
    });

    it("carries no moving-average disclosure once the full window is really available", () => {
      const result = metrics.summarizeHistory(closes(60), 205);

      expect(result.movingAverageDisclosures.ma20).toBeUndefined();
      expect(result.movingAverageDisclosures.ma60).toBeUndefined();
    });

    // 2026-07-28: same "no silent mislabeling" rule applied to support/
    // resistance. `closes.slice(-20)` on a 12-element array is the WHOLE
    // array, so the min/max published as the conclusion box's "近20日支撑位"
    // was really a 12-session extreme. Publish the window that was really
    // used so the renderer can label it truthfully.
    it("reports the REAL window the support/resistance extremes were taken over", () => {
      expect(metrics.summarizeHistory(closes(126), 212).supportWindowDays).toBe(20);
      expect(metrics.summarizeHistory(closes(12), 205).supportWindowDays).toBe(12);
      expect(metrics.summarizeHistory([], 100).supportWindowDays).toBeUndefined();
      expect(metrics.summarizeHistory({ error: "读取失败" }, 100).supportWindowDays).toBeUndefined();
    });

    it("computes ma20/ma60 as plain trailing averages of the closes", () => {
      const result = metrics.summarizeHistory(closes(60), 205.9);
      const allCloses = closes(60).map((row) => row.close);
      const expectedMa20 = allCloses.slice(-20).reduce((sum, v) => sum + v, 0) / 20;
      const expectedMa60 = allCloses.slice(-60).reduce((sum, v) => sum + v, 0) / 60;

      expect(result.ma20).toBeCloseTo(expectedMa20, 6);
      expect(result.ma60).toBeCloseTo(expectedMa60, 6);
    });

    it("accepts the {rows, source} envelope the multi-source chain returns and names the source it used", () => {
      const result = metrics.summarizeHistory({ source: "nasdaq-historical", rows: closes(60) }, 205.9);

      expect(result.source).toBe("nasdaq-historical");
      expect(result.summary).toContain("来源 nasdaq-historical");
      expect(result.ma20).toEqual(expect.any(Number));
    });

    it("discloses a REASON when no history source returned rows, never a bare placeholder", () => {
      const allFailed = metrics.summarizeHistory({ error: "Nasdaq 历史行情（assetclass=stocks）触发限流，当前维度待验证；Yahoo chart 历史走势接口触发限流，当前维度待验证" }, 100);
      expect(allFailed.summary).toContain("历史走势读取失败：");
      expect(allFailed.summary).toContain("Nasdaq");

      const emptyRows = metrics.summarizeHistory({ source: "nasdaq-historical", rows: [] }, 100);
      expect(emptyRows.summary).toContain("历史走势暂无可用数据（");
      expect(emptyRows.summary).toContain("0 条日线");
    });
  });
});

// ---------------------------------------------------------------------------
// 2026-07-27: multi-source wiring. Every payload fixture below is a trimmed
// copy of a REAL response captured from the deployed mini on 2026-07-27, so
// the parsers are pinned against the shape the endpoints actually return
// (not a guess at it).
// ---------------------------------------------------------------------------

describe("normalizeNasdaqHistorical", () => {
  const NASDAQ_HISTORICAL_PAYLOAD = {
    data: {
      symbol: "AMZN",
      totalRecords: 3,
      tradesTable: {
        headers: { date: "Date", close: "Close/Last" },
        rows: [
          { date: "07/24/2026", close: "$232.11", volume: "35,017,360", open: "$234.38", high: "$234.95", low: "$231.34" },
          { date: "07/23/2026", close: "$233.66", volume: "47,465,340", open: "$236.26", high: "$238.3499", low: "$232.0516" },
          { date: "07/22/2026", close: "$244.85", volume: "34,112,730", open: "$248.265", high: "$248.45", low: "$242.45" }
        ]
      }
    },
    status: { rCode: 200 }
  };

  it("parses $-prefixed closes and US dates, returning rows OLDEST first", () => {
    const result = metrics.normalizeNasdaqHistorical(NASDAQ_HISTORICAL_PAYLOAD);

    expect(result.source).toBe("nasdaq-historical");
    expect(result.rows).toEqual([
      { date: "2026-07-22", close: 244.85 },
      { date: "2026-07-23", close: 233.66 },
      { date: "2026-07-24", close: 232.11 }
    ]);
  });

  it("parses a fund's plain (non-$) closes too", () => {
    const result = metrics.normalizeNasdaqHistorical({
      data: { tradesTable: { rows: [{ date: "07/24/2026", close: "281.68" }] } }
    });

    expect(result.rows).toEqual([{ date: "2026-07-24", close: 281.68 }]);
  });

  it("carries the API's own reason out when the asset class does not match the symbol", () => {
    const result = metrics.normalizeNasdaqHistorical({
      data: null,
      status: { rCode: 400, bCodeMessage: [{ code: 1001, errorMessage: "Symbol not exists." }] }
    });

    expect(result.rows).toBeUndefined();
    expect(result.error).toContain("Symbol not exists.");
  });
});

describe("normalizeStockAnalysisHistory", () => {
  it("parses the {status, data:[{t,c}]} history feed, oldest first", () => {
    const result = metrics.normalizeStockAnalysisHistory({
      status: 200,
      data: [
        { t: "2026-07-24", o: 234.38, h: 234.95, l: 231.34, c: 232.11, v: 34663457 },
        { t: "2026-07-23", o: 236.26, h: 238.35, l: 232.052, c: 233.66, v: 46865497 }
      ]
    });

    expect(result.source).toBe("stockanalysis-history");
    expect(result.rows).toEqual([
      { date: "2026-07-23", close: 233.66 },
      { date: "2026-07-24", close: 232.11 }
    ]);
  });

  it("reports an error (never an empty success) when the feed carries no rows", () => {
    expect(metrics.normalizeStockAnalysisHistory({ status: 200, data: [] }).error).toContain("StockAnalysis");
  });
});

describe("normalizeNasdaqOptionChain", () => {
  // Nasdaq announces each expiry with a `expirygroup` header row whose other
  // fields are all null; the contracts that follow carry an empty expirygroup.
  const NASDAQ_OPTION_CHAIN_PAYLOAD = {
    data: {
      lastTrade: "LAST TRADE: $232.11 (AS OF JUL 27, 2026)",
      table: {
        rows: [
          { expirygroup: "July 27, 2026", expiryDate: null, c_Openinterest: null, p_Openinterest: null, strike: null },
          { expirygroup: "", expiryDate: "Jul 27", c_Openinterest: "27", p_Openinterest: "68", strike: "160.00" },
          { expirygroup: "", expiryDate: "Jul 27", c_Openinterest: "74", p_Openinterest: "--", strike: "165.00" },
          { expirygroup: "August 21, 2026", expiryDate: null, c_Openinterest: null, p_Openinterest: null, strike: null },
          { expirygroup: "", expiryDate: "Aug 21", c_Openinterest: "9999", p_Openinterest: "8888", strike: "170.00" }
        ]
      }
    }
  };

  it("sums open interest for the NEAREST expiry only, skipping '--' placeholders", () => {
    const result = metrics.normalizeNasdaqOptionChain(NASDAQ_OPTION_CHAIN_PAYLOAD);

    expect(result).toMatchObject({
      source: "nasdaq-option-chain",
      expiration: "2026-07-27",
      callOpenInterest: 101,
      putOpenInterest: 68,
      contractCount: 2
    });
  });

  it("errors with the API's reason when no contracts came back", () => {
    const result = metrics.normalizeNasdaqOptionChain({
      data: null,
      status: { bCodeMessage: [{ errorMessage: "Symbol not exists." }] }
    });

    expect(result.error).toContain("Symbol not exists.");
    expect(result.callOpenInterest).toBeUndefined();
  });
});

describe("normalizeFinnhubMetrics", () => {
  it("maps the free-tier TTM ratios and converts marketCapitalization out of millions", () => {
    const result = metrics.normalizeFinnhubMetrics({
      metric: {
        peTTM: 27.4988,
        peAnnual: 32.1467,
        pbQuarterly: 5.0684,
        pbAnnual: 6.0027,
        epsTTM: 8.3676,
        marketCapitalization: 2_496_832.8,
        "52WeekHigh": 278.56,
        "52WeekLow": 196
      }
    });

    expect(result).toMatchObject({
      source: "finnhub-metric",
      trailingPE: 27.4988,
      priceToBook: 5.0684,
      epsTrailingTwelveMonths: 8.3676,
      marketCap: 2_496_832.8 * 1_000_000,
      fiftyTwoWeekHighLow: "$278.56/$196"
    });
  });

  it("leaves PE/PB undefined for a fund (Finnhub's free tier returns neither), without inventing a value", () => {
    const result = metrics.normalizeFinnhubMetrics({ metric: { "52WeekHigh": 308.21, "52WeekLow": 227 } });

    expect(result.trailingPE).toBeUndefined();
    expect(result.priceToBook).toBeUndefined();
    expect(result.fiftyTwoWeekHighLow).toBe("$308.21/$227");
  });
});

describe("normalizeNasdaqSummary: an empty payload is an ERROR, not a value-less 'source'", () => {
  it("returns a reason-carrying error when the API answers with data:null", () => {
    const result = metrics.normalizeNasdaqSummary({
      data: null,
      status: { bCodeMessage: [{ errorMessage: "Symbol not exists." }] }
    });

    expect(result.error).toContain("Symbol not exists.");
  });

  it("does not count a value-less snapshot as a contributing source", () => {
    const merged = metrics.mergeFundamentalSnapshots([
      { source: "finnhub-metric", trailingPE: 27.4988, priceToBook: 5.0684 },
      { source: "nasdaq-summary" }
    ]);

    expect(merged.sources).toEqual(["finnhub-metric"]);
    expect(merged.failures.join("；")).toContain("nasdaq-summary");
  });
});

describe("summarizeValuation: every missing metric states WHY", () => {
  it("discloses an ETF's structurally-inapplicable PE/PB/EPS/target instead of rendering '暂无'", () => {
    const result = metrics.summarizeValuation(
      { sources: ["nasdaq-summary", "finnhub-metric"], failures: [], marketCap: 97_291_489_986 },
      { instrumentKind: "etf" }
    );

    expect(result.summary).toContain("PE 不适用（ETF 无市盈率口径");
    expect(result.summary).toContain("PB 不适用（ETF 无市净率口径");
    expect(result.summary).toContain("一年目标价 不适用（ETF 无卖方一年目标价");
    expect(result.summary).toContain("市值 97.29 十亿美元");
    expect(result.summary).not.toContain("暂无");
  });

  it("names the failing sources when an equity's metric is missing for a non-structural reason", () => {
    const result = metrics.summarizeValuation(
      { sources: ["nasdaq-summary"], failures: ["finnhub-metric：Finnhub 指标接口触发限流，当前维度待验证"], oneYearTarget: 320 },
      { instrumentKind: "stock" }
    );

    expect(result.summary).toContain("PE 不可得（来源未提供该字段：finnhub-metric");
    expect(result.summary).toContain("一年目标价 320.00");
  });

  it("marks an ETF's metrics 不适用 (structural) and a source outage 不可得 (data), so a reader can tell them apart", () => {
    const etf = metrics.summarizeValuation(
      { sources: ["nasdaq-summary"], failures: [], marketCap: 97_291_489_986 },
      { instrumentKind: "etf" }
    );
    const outage = metrics.summarizeValuation(
      { sources: ["nasdaq-summary"], failures: ["finnhub-metric：Finnhub 指标接口返回 429"], marketCap: 3_000_000_000_000 },
      { instrumentKind: "stock" }
    );

    expect(etf.summary).toContain("PE 不适用（ETF 无市盈率口径");
    expect(etf.summary).not.toContain("PE 不可得");
    expect(outage.summary).toContain("PE 不可得（来源未提供该字段：finnhub-metric");
    expect(outage.summary).not.toContain("不适用");
  });

  it("still renders real numbers untouched when every metric is present", () => {
    const result = metrics.summarizeValuation(
      { sources: ["finnhub-metric"], trailingPE: 27.76, priceToBook: 5.648, epsTrailingTwelveMonths: 8.37, marketCap: 2_496_832_800_000, oneYearTarget: 320 },
      { instrumentKind: "stock" }
    );

    expect(result.summary).toContain("PE 27.76；PB 5.65；EPS 8.37");
    expect(result.summary).not.toContain("不可得");
  });
});

describe("summarizeOptionChainStats", () => {
  it("renders an already-summed Nasdaq snapshot, naming the source", () => {
    const stats = metrics.summarizeOptionChainStats({
      source: "nasdaq-option-chain",
      expiration: "2026-07-31",
      callOpenInterest: 45_231,
      putOpenInterest: 38_004
    });

    expect(stats.summary).toContain("最近到期 2026-07-31，Call 未平仓约 45231.00");
    expect(stats.summary).toContain("来源 nasdaq-option-chain");
    expect(stats.callOpenInterest).toBe(45_231);
  });

  it("discloses an empty payload instead of reporting a fabricated 0 open interest", () => {
    const stats = metrics.summarizeOptionChainStats({});

    expect(stats.callOpenInterest).toBeUndefined();
    expect(stats.summary).toContain("期权链暂无可用数据（");
  });

  it("keeps rendering Yahoo's raw chain shape (the last link of the chain)", () => {
    const stats = metrics.summarizeOptionChainStats({
      expirationDates: [1755820800],
      options: [{ calls: [{ openInterest: 1000 }], puts: [{ openInterest: 500 }] }]
    });

    expect(stats.callOpenInterest).toBe(1000);
    expect(stats.summary).toContain("Call 未平仓约 1000.00");
  });
});
