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
