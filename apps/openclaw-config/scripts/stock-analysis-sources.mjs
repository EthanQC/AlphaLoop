// URL/asset-class builders for every external market-data source the
// stock-analysis pipeline reads. Kept as a pure, side-effect-free module (no
// fetch, no env mutation, no fs) so every URL shape and every asset-class
// fallback ORDER is directly unit-testable without touching the network -
// the same convention stock-analysis-metrics.mjs follows for the payload
// normalizers that consume these URLs' responses.
//
// 2026-07-27 (facts-coverage repair): before this change the only history
// source was Yahoo chart and the only option-chain source was Yahoo options.
// The mini's IP is hard-rate-limited by Yahoo (every query1/query2 endpoint
// returns 429 regardless of user-agent), so BOTH domains returned literally
// zero bytes on every scheduled run. Nasdaq's public quote API serves both
// (asset-class aware) and stockanalysis.com serves history as a clean JSON
// fallback; Finnhub's free tier serves valuation metrics. Yahoo is kept as
// the LAST link of each chain rather than deleted - it costs nothing when the
// earlier sources succeed, and it is the only one of the three that has ever
// worked from a non-rate-limited IP.

export function buildYahooOptionChainUrls(symbol) {
  const yahooSymbol = String(symbol ?? "").toUpperCase().replace(/\.US$/u, "");
  if (!yahooSymbol) {
    throw new Error("symbol is required for Yahoo option-chain URLs.");
  }
  return [
    new URL(`https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(yahooSymbol)}`),
    new URL(`https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(yahooSymbol)}`)
  ];
}

// `AAPL.US` -> `AAPL`. Deliberately NOT the same as stock-analysis.mjs's
// toYahooSymbol (which additionally rewrites `BRK.B` -> `BRK-B`, a
// Yahoo-only convention): Nasdaq/StockAnalysis/Finnhub all keep the dotted
// class-share form, so rewriting the dot here would break exactly the
// tickers toYahooSymbol was written to fix.
export function toBareSymbol(symbol) {
  return String(symbol ?? "").toUpperCase().replace(/\.US$/u, "");
}

// Instrument kinds this pipeline distinguishes. "etf" exists because three
// separate sources need a DIFFERENT path/param for an ETF (Nasdaq
// assetclass=etf, StockAnalysis /etf/<sym>/ instead of /stocks/<sym>/,
// and Finnhub's free tier simply has no PE/PB for a fund at all), and
// because several equity-only metrics (PE/PB/EPS/一年目标价) are
// structurally INAPPLICABLE to a fund - they must be disclosed with that
// reason, never rendered as a bare "暂无".
export const INSTRUMENT_KIND_STOCK = "stock";
export const INSTRUMENT_KIND_ETF = "etf";

// Static table of the ETFs this deployment actually watches plus the most
// common US funds. A wrong/missing entry is NOT fatal: every Nasdaq fetch
// tries the OTHER asset class as a fallback (nasdaqAssetClassOrder below), so
// the table is a latency optimization + the source of truth for the
// "ETF 无此指标" disclosure wording, not a hard dependency.
export const KNOWN_ETF_SYMBOLS = new Set([
  "QQQ", "QQQM", "QQQJ", "SPY", "VOO", "IVV", "VTI", "VUG", "VTV", "VYM", "VIG",
  "IWM", "DIA", "MDY", "RSP", "SCHD", "SCHG", "JEPI", "JEPQ", "ARKK", "SOXX",
  "SMH", "XLK", "XLF", "XLE", "XLV", "XBI", "TLT", "IEF", "BND", "AGG", "HYG",
  "LQD", "GLD", "SLV", "IBIT", "EFA", "EEM", "VXUS", "VEA", "VWO"
]);

// Env escape hatch (comma/space separated tickers, with or without `.US`):
// lets an operator classify a fund the static table above has never heard of
// without a code change - e.g. STOCK_ANALYSIS_ETF_SYMBOLS="FNGU,GRNY".
export function resolveInstrumentKind(symbol, { env = process.env } = {}) {
  const bare = toBareSymbol(symbol);
  if (!bare) {
    return INSTRUMENT_KIND_STOCK;
  }
  const overrides = String(env?.STOCK_ANALYSIS_ETF_SYMBOLS ?? "")
    .split(/[\s,;]+/u)
    .map((entry) => toBareSymbol(entry))
    .filter(Boolean);
  if (overrides.includes(bare)) {
    return INSTRUMENT_KIND_ETF;
  }
  return KNOWN_ETF_SYMBOLS.has(bare) ? INSTRUMENT_KIND_ETF : INSTRUMENT_KIND_STOCK;
}

// Nasdaq's API rejects a wrong asset class outright (verified 2026-07-27 on
// the mini: `QQQM/historical?assetclass=stocks` answers HTTP 400 with
// `{"code":1001,"errorMessage":"Symbol not exists."}`), so every Nasdaq
// fetch walks BOTH classes, preferred one first. That makes a stale
// KNOWN_ETF_SYMBOLS entry self-healing instead of a silent data gap.
export function nasdaqAssetClassOrder(instrumentKind) {
  return instrumentKind === INSTRUMENT_KIND_ETF ? ["etf", "stocks"] : ["stocks", "etf"];
}

export function buildNasdaqHeaders(symbol, assetClass) {
  const path = assetClass === "etf" ? "etf" : "stocks";
  return {
    "accept": "application/json, text/plain, */*",
    "origin": "https://www.nasdaq.com",
    "referer": `https://www.nasdaq.com/market-activity/${path}/${encodeURIComponent(toBareSymbol(symbol).toLowerCase())}`
  };
}

export function buildNasdaqSummaryUrl(symbol, assetClass) {
  return new URL(
    `https://api.nasdaq.com/api/quote/${encodeURIComponent(toBareSymbol(symbol))}/summary?assetclass=${encodeURIComponent(assetClass)}`
  );
}

// Nasdaq's historical endpoint is inclusive on both ends and returns rows
// NEWEST first (normalizeNasdaqHistorical reverses them). `limit` is a hard
// row cap - 250 comfortably covers the ~126 sessions a 6-month window holds
// while leaving room for the 180-session long average summarizeHistory
// labels honestly.
export function buildNasdaqHistoricalUrl(symbol, assetClass, { fromDate, toDate, limit = 250 } = {}) {
  const url = new URL(`https://api.nasdaq.com/api/quote/${encodeURIComponent(toBareSymbol(symbol))}/historical`);
  url.searchParams.set("assetclass", assetClass);
  url.searchParams.set("fromdate", fromDate);
  url.searchParams.set("todate", toDate);
  url.searchParams.set("limit", String(limit));
  return url;
}

export function buildNasdaqOptionChainUrl(symbol, assetClass) {
  const url = new URL(`https://api.nasdaq.com/api/quote/${encodeURIComponent(toBareSymbol(symbol))}/option-chain`);
  url.searchParams.set("assetclass", assetClass);
  url.searchParams.set("fromdate", "all");
  url.searchParams.set("excode", "oprac");
  url.searchParams.set("callput", "callput");
  url.searchParams.set("money", "all");
  url.searchParams.set("type", "all");
  return url;
}

// StockAnalysis routes funds under /etf/<sym>/ and its JSON history API
// under /api/symbol/e/<sym>/ (`s` for stocks) - requesting the equity path
// for a fund answers 404, which is exactly the silent-gap the QQQM statistics
// fetch used to hit.
export function buildStockAnalysisStatisticsUrl(symbol, instrumentKind) {
  const segment = instrumentKind === INSTRUMENT_KIND_ETF ? "etf" : "stocks";
  const suffix = instrumentKind === INSTRUMENT_KIND_ETF ? "" : "statistics/";
  return new URL(`https://www.stockanalysis.com/${segment}/${encodeURIComponent(toBareSymbol(symbol).toLowerCase())}/${suffix}`);
}

export function buildStockAnalysisHistoryUrl(symbol, instrumentKind, { range = "6M", period = "Daily" } = {}) {
  const kindSegment = instrumentKind === INSTRUMENT_KIND_ETF ? "e" : "s";
  const url = new URL(
    `https://stockanalysis.com/api/symbol/${kindSegment}/${encodeURIComponent(toBareSymbol(symbol).toLowerCase())}/history`
  );
  url.searchParams.set("range", range);
  url.searchParams.set("period", period);
  return url;
}

// Finnhub free tier: /stock/metric IS available (verified 2026-07-27 with the
// production key: AMZN returns 128 metrics including peTTM/pbQuarterly/
// epsTTM/marketCapitalization), and so is /stock/recommendation (verified
// 2026-07-30, see buildFinnhubRecommendationUrl). /stock/candle,
// /stock/option-chain and /stock/price-target are all 403 on the free tier -
// they are deliberately NOT wired anywhere; their absence is disclosed in prose.
export function buildFinnhubMetricUrl(symbol) {
  const url = new URL("https://finnhub.io/api/v1/stock/metric");
  url.searchParams.set("symbol", toBareSymbol(symbol));
  url.searchParams.set("metric", "all");
  return url;
}

// /stock/profile2 is the only free-tier endpoint that states which CURRENCY
// /stock/metric answered in - `metric=all` has no currency field at all
// (measured 2026-07-30 on the mini's key: `currency` is absent from the
// metric object for both TSM and NVDA, while profile2 returns "TWD" for TSM
// and "USD" for NVDA). See normalizeFinnhubMetrics for what depends on it.
export function buildFinnhubProfileUrl(symbol) {
  const url = new URL("https://finnhub.io/api/v1/stock/profile2");
  url.searchParams.set("symbol", toBareSymbol(symbol));
  return url;
}

// /stock/recommendation IS on the free tier - measured 2026-07-30 with the
// mini's FINNHUB_API_KEY: TSM returns four monthly periods (the newest
// strongBuy 13 / buy 28 / hold 2 / sell 0 / strongSell 0) and every row echoes
// symbol "2330.TW", NVDA returns four periods echoing "NVDA", QQQM returns [].
// The counts carry no currency, which is why this is the one analyst figure
// this deployment can state outright - see normalizeFinnhubRecommendation.
export function buildFinnhubRecommendationUrl(symbol) {
  const url = new URL("https://finnhub.io/api/v1/stock/recommendation");
  url.searchParams.set("symbol", toBareSymbol(symbol));
  return url;
}
