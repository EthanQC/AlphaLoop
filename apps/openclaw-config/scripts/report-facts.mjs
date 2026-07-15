// Phase 4 Task 6: deterministic extraction of every number the daily/weekly
// report narrative renders (QQQ price/change, official-paper net assets/cash/
// exposure/remaining budget, macro event count), persisted to the
// daily_facts table (news-store.mjs's replaceDailyFacts/getDailyFacts,
// schema v8) BEFORE the report is rendered - report-quality.mjs's
// facts.numeric_match gate (validateNarrativeNumbers) needs an
// independently-computed ground truth already sitting in the database by
// the time anything downstream inspects the rendered narrative, so a
// hand-edited or fabricated number in the markdown has something concrete to
// be caught against.
//
// Deliberately mirrors the exact formulas scheduled-report.mjs's own
// summarizePaperBudget/renderCoreSummary/renderQqqSection use (the same
// attachPriceSource/estimateMarketValue pair official-paper-monitor.mjs
// exports) rather than reinventing a second valuation path - the "fact" this
// module records is genuinely "what the report generator's own formula
// computes from the same raw snapshot/quote inputs", so a divergence
// between that and the rendered text can only come from the markdown being
// edited/fabricated after generation, which is exactly what the gate exists
// to catch (not a computation disagreement between two independently
// re-derived formulas).
import { attachPriceSource, estimateMarketValue } from "./official-paper-monitor.mjs";
import { toNumber } from "./report-data.mjs";
import { replaceDailyFacts } from "./news-store.mjs";
import { replaceStockFacts } from "./stock-facts-store.mjs";
import { summarizeHistory, summarizeOptionChainStats } from "./stock-analysis-metrics.mjs";

// Same 10%-of-net-assets ceiling summarizePaperBudget (scheduled-report.mjs)
// and buildStrategyReflection (official-paper-monitor.mjs) already hard-code.
const PAPER_BUDGET_RATIO = 0.1;

// @param {{
//   snapshot: object,      // officialPaperSnapshot shape (report-data.mjs)
//   qqqQuote: object,      // qqqQuote shape (report-data.mjs)
//   macroEntries?: Array,  // normalizeMacroCalendarPayload() entries
//   tradingDay: string     // e.g. '2026-07-15' - the report's window label
// }} input
// @returns {Array<{factKey: string, valueNum: number|null, valueText: string|null, unit: string, source: string, dataTime: string}>}
export function buildDailyFacts({ snapshot, qqqQuote, macroEntries = [], tradingDay }) {
  return [
    ...buildQqqFacts(qqqQuote, tradingDay),
    ...buildPaperFacts(snapshot, qqqQuote, tradingDay),
    buildMacroFact(macroEntries, tradingDay)
  ];
}

function buildQqqFacts(qqqQuote, tradingDay) {
  // Degraded quote (buildDegradedQuoteSnapshot in report-data.mjs) carries no
  // last/prev_close at all - the fact is still WRITTEN (never dropped), just
  // with a null value and a source suffix disclosing the degradation, per
  // the task brief ("degraded snapshot -> facts still written but source
  // suffixed '(降级估值)'"). renderQqqSection's own degraded branch never
  // prints a "最新价："/"涨跌" number in that case either (it takes an early
  // return with none of those phrases), so facts.numeric_match naturally has
  // nothing to compare against and never false-fails on a degraded report.
  const degraded = Boolean(qqqQuote?.degraded);
  const source = withDegradedSuffix("longbridge-quote", degraded);
  const dataTime = qqqQuote?.timestamp
    ?? qqqQuote?.post_market_quote?.timestamp
    ?? qqqQuote?.pre_market_quote?.timestamp
    ?? tradingDay;

  const last = toNumber(qqqQuote?.last ?? qqqQuote?.last_done ?? qqqQuote?.lastDone);
  const prevClose = toNumber(qqqQuote?.prev_close ?? qqqQuote?.prevClose);
  // Mirrors summarizeQqqMove/renderQqqSection: both render the UNSIGNED
  // percentage change (Math.abs), never a signed one - the fact must match
  // what's actually printed, not a signed variant nothing ever renders.
  const changePct = last !== undefined && prevClose !== undefined && prevClose !== 0
    ? Math.abs(last - prevClose) / prevClose * 100
    : undefined;

  return [
    numberFact("qqq.price", last, "USD", source, dataTime),
    numberFact("qqq.changePct", changePct, "pct", source, dataTime)
  ];
}

function buildPaperFacts(snapshot, qqqQuote, tradingDay) {
  // Degraded snapshot (buildDegradedOfficialPaperSnapshot) has an all-zero
  // primaryAsset and an empty positions array - facts are still written
  // (net assets/cash come back as 0, not null, per that builder's shape),
  // but the source is suffixed to disclose the degradation. Same reasoning
  // as buildQqqFacts: renderOfficialPaperSnapshot's own degraded branch
  // never prints a "净资产"/"现金" number either, so there is nothing for
  // facts.numeric_match to false-fail against.
  const degraded = Boolean(snapshot?.degraded);
  const source = withDegradedSuffix("longbridge-official-paper", degraded);
  const dataTime = snapshot?.fetchedAt ?? tradingDay;
  const asset = snapshot?.primaryAsset ?? {};
  const netAssets = toNumber(asset.net_assets ?? asset.netAssets);
  const totalCash = toNumber(asset.total_cash ?? asset.totalCash);

  // Same attachPriceSource/estimateMarketValue pairing summarizePaperBudget
  // uses: only pass the QQQ quote through when it is itself usable, exactly
  // like summarizePaperBudget's `qqqQuote ? [qqqQuote] : []` (a degraded
  // quote object has no `last`, so attachPriceSource would fall through to
  // cost/zero for QQQ anyway - excluding it outright keeps this function's
  // intent explicit rather than relying on that fallback silently doing the
  // same thing).
  const quotes = qqqQuote && !qqqQuote.degraded ? [qqqQuote] : [];
  const { positions: pricedPositions } = attachPriceSource(snapshot?.positions ?? [], quotes);
  const marketValue = estimateMarketValue({ positions: pricedPositions });

  // Same "netAssets <= 0 -> undefined" guard summarizePaperBudget uses
  // ("无法计算模拟盘暴露比例") - an exposure/remaining-budget fact computed
  // against a zero/negative net-assets denominator is not a real number.
  const exposurePct = netAssets !== undefined && netAssets > 0
    ? marketValue / netAssets * 100
    : undefined;
  const remainingBudget = netAssets !== undefined && netAssets > 0
    ? Math.max(0, netAssets * PAPER_BUDGET_RATIO - marketValue)
    : undefined;

  return [
    numberFact("paper.netAssets", netAssets, "USD", source, dataTime),
    numberFact("paper.totalCash", totalCash, "USD", source, dataTime),
    numberFact("paper.marketValue", marketValue, "USD", source, dataTime),
    numberFact("paper.exposurePct", exposurePct, "pct", source, dataTime),
    numberFact("paper.remainingBudget", remainingBudget, "USD", source, dataTime)
  ];
}

function buildMacroFact(macroEntries, tradingDay) {
  return numberFact(
    "macro.eventCount",
    (macroEntries ?? []).length,
    "count",
    "longbridge-macro-calendar",
    tradingDay
  );
}

function withDegradedSuffix(source, degraded) {
  return degraded ? `${source}（降级估值）` : source;
}

function numberFact(factKey, valueNum, unit, source, dataTime) {
  return {
    factKey,
    valueNum: valueNum === undefined ? null : valueNum,
    valueText: valueNum === undefined ? "不可用" : null,
    unit,
    source,
    dataTime
  };
}

// Thin wrapper around news-store.mjs's replaceDailyFacts - kept as its own
// exported function (rather than inlining the store call at every call
// site) so scheduled-report.mjs's "build then persist" step reads as one
// intent-named call, and so a future caller never needs to know this
// currently delegates straight to the store's full-day replace semantics.
export function persistDailyFacts(db, tradingDay, facts) {
  return replaceDailyFacts(db, tradingDay, facts);
}

// ---------------------------------------------------------------------------
// Phase 5 Task 1 (2026-07-15 plan): per-stock facts (stock_facts, schema v9).
//
// Same rationale as buildDailyFacts above, one level down: stock-analysis.mjs
// generates a per-symbol narrative that cites concrete numbers (quote,
// valuation, moving averages, option open interest, news volume) - this
// extracts those same numbers independently, straight from the inputs
// stock-analysis.mjs's own fetchStockAnalysisRecord already assembled
// (quote/history/fundamentals/optionChain/news), so a later quality gate
// (stock.numeric_match, Task 4) has an independently-computed ground truth
// to catch a fabricated or hand-edited number against.
//
// `fundamentals` here is ALREADY the mergeFundamentalSnapshots() output
// (stock-analysis.mjs's fetchFundamentalSnapshots calls that merge and
// hands the result straight through as the record's `fundamentals` field) -
// this function does not re-merge raw per-source snapshots itself.
//
// Every fact keeps this file's `{factKey, valueNum, valueText, unit, source,
// dataTime}` shape and always carries a source + dataTime, even when the
// underlying value could not be computed (missing/degraded upstream data is
// disclosed via a `数据不可得`-prefixed source, never silently dropped -
// same "still write the fact" convention buildQqqFacts/buildPaperFacts use
// for a degraded quote/snapshot above).
// ---------------------------------------------------------------------------

// @param {{
//   symbol: string,               // not baked into factKey - stock_facts
//                                  // scopes by its own `symbol` column
//                                  // (UNIQUE(trading_day, symbol, fact_key)),
//                                  // kept in the input shape for call-site
//                                  // clarity/parity with fetchStockAnalysisRecord.
//   quote: object,                // normalizeQuotePayload(...) shape
//   history: Array|{error:string}, // fetchYahooHistory(...) shape
//   fundamentals: object|{error:string}, // mergeFundamentalSnapshots(...) output
//   optionChain: object|{error:string},  // Yahoo optionChain.result[0] shape
//   news: Array,                  // merged news articles (only .length used)
//   tradingDay: string            // e.g. '2026-07-15'
// }} input
// @returns {Array<{factKey: string, valueNum: number|null, valueText: string|null, unit: string|null, source: string, dataTime: string}>}
export function buildStockFacts({ symbol, quote, history, fundamentals, optionChain, news, tradingDay }) {
  void symbol; // not used in factKey - see doc comment above.
  return [
    ...buildStockQuoteFacts(quote, tradingDay),
    ...buildStockValuationFacts(fundamentals, tradingDay),
    ...buildStockHistoryFacts(history, quote, tradingDay),
    ...buildStockOptionFacts(optionChain, tradingDay),
    buildStockNewsFact(news, tradingDay),
    buildStockInstitutionalFact(tradingDay)
  ];
}

function buildStockQuoteFacts(quote, tradingDay) {
  const last = toNumber(quote?.last ?? quote?.last_done ?? quote?.lastDone);
  const prevClose = toNumber(quote?.prev_close ?? quote?.prevClose);
  const volume = toNumber(quote?.volume ?? quote?.turnover_volume);
  // Signed percentage change (matches stock-analysis.mjs's buildDeterministicAnalysis
  // `pct` - that narrative renders a SIGNED "涨跌幅", unlike the daily report's
  // qqq.changePct above, which is unsigned - the fact must match what's
  // actually printed for THIS report).
  const pct = last !== undefined && prevClose ? ((last - prevClose) / prevClose) * 100 : undefined;
  const dataTime = quote?.timestamp ?? tradingDay;
  const source = "longbridge-quote";

  return [
    numberFact("quote.last", last, "USD", source, dataTime),
    numberFact("quote.pct", pct, "pct", source, dataTime),
    numberFact("quote.volume", volume, "shares", source, dataTime)
  ];
}

function buildStockValuationFacts(fundamentals, tradingDay) {
  const whollyMissing = !fundamentals || Boolean(fundamentals.error);
  const mergedSourceLabel = !whollyMissing && Array.isArray(fundamentals.sources) && fundamentals.sources.length
    ? fundamentals.sources.join("、")
    : undefined;

  const pe = whollyMissing ? undefined : toNumber(fundamentals.trailingPE ?? fundamentals.forwardPE);
  const pb = whollyMissing ? undefined : toNumber(fundamentals.priceToBook);
  const eps = whollyMissing ? undefined : toNumber(fundamentals.epsTrailingTwelveMonths);
  const marketCap = whollyMissing ? undefined : toNumber(fundamentals.marketCap);
  const targetPrice = whollyMissing ? undefined : toNumber(fundamentals.oneYearTarget);

  // Per-field, not just per-category: a field that mergeFundamentalSnapshots
  // never actually found across ANY of its sources (e.g. no source reported
  // an EPS) must disclose '数据不可得' too, even when other fields on the
  // SAME `fundamentals` object are present - a fabricated source label on a
  // genuinely-missing field would be worse than an honest gap.
  return [
    valuationFact("valuation.pe", pe, null, mergedSourceLabel, tradingDay),
    valuationFact("valuation.pb", pb, null, mergedSourceLabel, tradingDay),
    valuationFact("valuation.eps", eps, "USD", mergedSourceLabel, tradingDay),
    valuationFact("valuation.marketCap", marketCap, "USD", mergedSourceLabel, tradingDay),
    valuationFact("valuation.targetPrice", targetPrice, "USD", mergedSourceLabel, tradingDay)
  ];
}

function valuationFact(factKey, value, unit, mergedSourceLabel, dataTime) {
  if (value === undefined || mergedSourceLabel === undefined) {
    return numberFact(factKey, undefined, unit, "数据不可得", dataTime);
  }
  return numberFact(factKey, value, unit, mergedSourceLabel, dataTime);
}

// Reuses stock-analysis-metrics.mjs's summarizeHistory - the SAME
// ma20/ma60/ma180/longWindowDays computation stock-analysis.mjs's own
// narrative (buildDeterministicAnalysis's "市场表现与交易层面" section) uses,
// rather than re-deriving a second, potentially divergent formula (see that
// module's relocation comment on summarizeHistory for why it lives there
// instead of stock-analysis.mjs, and why report-facts.mjs can safely import
// it without a circular dependency).
//
// history.maLong's `unit` carries the REAL window day count
// (`${longWindowDays}日`, e.g. "126日" when only ~126 sessions were
// available) - Task H7 already fixed stock-analysis.mjs's own narrative text
// to stop mislabeling this a flat "180 日均线"; this fact must not
// reintroduce that same false claim via a hardcoded unit.
function buildStockHistoryFacts(history, quote, tradingDay) {
  const currentPrice = toNumber(quote?.last ?? quote?.last_done ?? quote?.lastDone);
  const stats = summarizeHistory(history, currentPrice);
  const dataTime = Array.isArray(history) && history.length ? (history.at(-1)?.date ?? tradingDay) : tradingDay;
  const source = "yahoo-chart-history";
  const maLongUnit = stats.longWindowDays !== undefined ? `${stats.longWindowDays}日` : null;

  return [
    numberFact("history.ma20", stats.ma20, "USD", stats.ma20 === undefined ? "数据不可得" : source, dataTime),
    numberFact("history.ma60", stats.ma60, "USD", stats.ma60 === undefined ? "数据不可得" : source, dataTime),
    numberFact("history.maLong", stats.ma180, maLongUnit, stats.ma180 === undefined ? "数据不可得" : source, dataTime)
  ];
}

// Reuses stock-analysis-metrics.mjs's summarizeOptionChainStats - same
// expiration/callOpenInterest/putOpenInterest computation the narrative's
// "期权交割与阻力支撑" section renders from.
function buildStockOptionFacts(optionChain, tradingDay) {
  const stats = summarizeOptionChainStats(optionChain);
  const source = "yahoo-options";
  const hasExpiry = stats.expiration !== undefined;

  return [
    {
      factKey: "options.nextExpiry",
      valueNum: null,
      valueText: hasExpiry ? stats.expiration : "不可得",
      unit: null,
      source: hasExpiry ? source : "数据不可得",
      dataTime: tradingDay
    },
    numberFact("options.callOi", stats.callOpenInterest, "contracts", stats.callOpenInterest === undefined ? "数据不可得" : source, tradingDay),
    numberFact("options.putOi", stats.putOpenInterest, "contracts", stats.putOpenInterest === undefined ? "数据不可得" : source, tradingDay)
  ];
}

function buildStockNewsFact(news, tradingDay) {
  const count = Array.isArray(news) ? news.length : 0;
  return numberFact("news.count", count, "count", "多源新闻聚合", tradingDay);
}

// EDGAR 13F institutional-holdings ingestion was cut from this phase's scope
// (see the plan's "明确不做" section) - this key is reserved so a later
// phase can fill it in without a schema/shape change, but for now it is
// always disclosed as unavailable, never fabricated or silently omitted.
function buildStockInstitutionalFact(tradingDay) {
  return {
    factKey: "institutional.holdings",
    valueNum: null,
    valueText: "不可得",
    unit: null,
    source: "数据不可得（EDGAR 13F 已裁）",
    dataTime: tradingDay
  };
}

// Thin wrapper around stock-facts-store.mjs's replaceStockFacts - same
// "one intent-named call" rationale as persistDailyFacts above. Deliberately
// per-(tradingDay, symbol), NOT per-tradingDay: see replaceStockFacts' own
// doc comment for why a whole-day delete would be wrong for this table.
export function persistStockFacts(db, tradingDay, symbol, facts) {
  return replaceStockFacts(db, tradingDay, symbol, facts);
}
