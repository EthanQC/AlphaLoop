import { describe, expect, it } from "vitest";

import {
  buildFinnhubMetricUrl,
  buildNasdaqHeaders,
  buildNasdaqHistoricalUrl,
  buildNasdaqOptionChainUrl,
  buildNasdaqSummaryUrl,
  buildStockAnalysisHistoryUrl,
  buildStockAnalysisStatisticsUrl,
  buildYahooOptionChainUrls,
  nasdaqAssetClassOrder,
  resolveInstrumentKind
} from "./stock-analysis-sources.mjs";

describe("stock analysis external sources", () => {
  it("uses both Yahoo option-chain hosts to reduce single-endpoint rate-limit failures", () => {
    expect(buildYahooOptionChainUrls("AAPL.US").map(String)).toEqual([
      "https://query2.finance.yahoo.com/v7/finance/options/AAPL",
      "https://query1.finance.yahoo.com/v7/finance/options/AAPL"
    ]);
  });
});

describe("resolveInstrumentKind", () => {
  it("classifies a known fund as an ETF and an ordinary ticker as a stock", () => {
    expect(resolveInstrumentKind("QQQM.US", { env: {} })).toBe("etf");
    expect(resolveInstrumentKind("SPY", { env: {} })).toBe("etf");
    expect(resolveInstrumentKind("NVDA.US", { env: {} })).toBe("stock");
  });

  it("accepts an operator-supplied ETF list for funds the static table has never heard of", () => {
    expect(resolveInstrumentKind("GRNY.US", { env: {} })).toBe("stock");
    expect(resolveInstrumentKind("GRNY.US", { env: { STOCK_ANALYSIS_ETF_SYMBOLS: "grny, fngu" } })).toBe("etf");
  });
});

describe("Nasdaq asset-class handling", () => {
  // Verified live 2026-07-27: `QQQM/historical?assetclass=stocks` answers
  // HTTP 400 "Symbol not exists." - so the wrong class is a hard failure, and
  // the fallback order is what keeps a stale classification from becoming a
  // silent data gap.
  it("tries the instrument's own class first and the other one as a fallback", () => {
    expect(nasdaqAssetClassOrder("etf")).toEqual(["etf", "stocks"]);
    expect(nasdaqAssetClassOrder("stock")).toEqual(["stocks", "etf"]);
  });

  it("builds historical/option-chain/summary URLs carrying the requested asset class", () => {
    expect(String(buildNasdaqHistoricalUrl("AMZN.US", "stocks", { fromDate: "2026-01-08", toDate: "2026-07-27", limit: 250 })))
      .toBe("https://api.nasdaq.com/api/quote/AMZN/historical?assetclass=stocks&fromdate=2026-01-08&todate=2026-07-27&limit=250");

    const optionChain = buildNasdaqOptionChainUrl("QQQM.US", "etf");
    expect(optionChain.pathname).toBe("/api/quote/QQQM/option-chain");
    expect(optionChain.searchParams.get("assetclass")).toBe("etf");
    expect(optionChain.searchParams.get("callput")).toBe("callput");

    expect(String(buildNasdaqSummaryUrl("QQQM.US", "etf"))).toBe("https://api.nasdaq.com/api/quote/QQQM/summary?assetclass=etf");
  });

  it("sends an ETF referer for a fund so the API accepts the request the same way the website does", () => {
    expect(buildNasdaqHeaders("QQQM.US", "etf").referer).toBe("https://www.nasdaq.com/market-activity/etf/qqqm");
    expect(buildNasdaqHeaders("AMZN.US", "stocks").referer).toBe("https://www.nasdaq.com/market-activity/stocks/amzn");
  });
});

describe("StockAnalysis / Finnhub URLs", () => {
  it("routes a fund to /etf/ and /api/symbol/e/, an equity to /stocks/ and /api/symbol/s/", () => {
    expect(String(buildStockAnalysisStatisticsUrl("QQQM.US", "etf"))).toBe("https://www.stockanalysis.com/etf/qqqm/");
    expect(String(buildStockAnalysisStatisticsUrl("AMZN.US", "stock"))).toBe("https://www.stockanalysis.com/stocks/amzn/statistics/");
    expect(String(buildStockAnalysisHistoryUrl("QQQM.US", "etf"))).toBe("https://stockanalysis.com/api/symbol/e/qqqm/history?range=6M&period=Daily");
    expect(String(buildStockAnalysisHistoryUrl("AMZN.US", "stock"))).toBe("https://stockanalysis.com/api/symbol/s/amzn/history?range=6M&period=Daily");
  });

  it("asks Finnhub for the full free-tier metric set (the key travels as a header, never in the URL)", () => {
    const url = buildFinnhubMetricUrl("AMZN.US");
    expect(String(url)).toBe("https://finnhub.io/api/v1/stock/metric?symbol=AMZN&metric=all");
    expect(String(url)).not.toMatch(/token/iu);
  });
});
