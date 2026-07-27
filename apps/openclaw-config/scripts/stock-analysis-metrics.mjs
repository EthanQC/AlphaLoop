import { toNumber } from "./report-data.mjs";

// 2026-07-27: `payload.data` is null (and `status.bCodeMessage` carries
// "Symbol not exists.") whenever the requested assetclass does not match the
// instrument - the exact response `QQQM/summary?assetclass=stocks` returns.
// This used to fall through to `?? {}` and produce a snapshot with NO error
// and EVERY field undefined, which mergeFundamentalSnapshots then counted as
// a contributing source: the resulting `fundamentals` object was neither an
// error nor carried a single value, so summarizeValuation rendered a bare
// "PE 暂无" with no reason at all. That is precisely the silent gap the
// facts-coverage gate exists to catch, so an empty payload is now an explicit,
// reason-carrying error snapshot.
export function normalizeNasdaqSummary(payload) {
  const summaryData = payload?.data?.summaryData;
  if (!summaryData || typeof summaryData !== "object") {
    const apiMessage = payload?.status?.bCodeMessage?.[0]?.errorMessage ?? payload?.message;
    return {
      source: "nasdaq-summary",
      error: `Nasdaq 摘要未返回该标的数据（${String(apiMessage ?? "响应缺少 summaryData").slice(0, 80)}）`
    };
  }
  return {
    source: "nasdaq-summary",
    oneYearTarget: parseMoney(summaryData.OneYrTarget?.value),
    marketCap: parseMoney(summaryData.MarketCap?.value),
    fiftyTwoWeekHighLow: String(summaryData.FiftTwoWeekHighLow?.value ?? "").trim() || undefined,
    previousClose: parseMoney(summaryData.PreviousClose?.value)
  };
}

export function extractStockAnalysisStatistics(html) {
  const text = String(html ?? "");
  return {
    source: "stockanalysis-statistics",
    trailingPE: extractMetric(text, "PE Ratio"),
    priceToBook: extractMetric(text, "PB Ratio"),
    epsTrailingTwelveMonths: extractMetric(text, "EPS \\(ttm\\)"),
    marketCap: extractMetric(text, "Market Cap")
  };
}

// Finnhub free tier, /stock/metric?metric=all (verified 2026-07-27 with the
// production key on the mini: AMZN -> 128 metrics; QQQM -> 19 metrics with no
// pe/pb at all, because a fund structurally has none). marketCapitalization
// is denominated in MILLIONS of USD - multiplying it here keeps every
// consumer on one unit (raw USD), the same unit Nasdaq's MarketCap string
// parses to.
export function normalizeFinnhubMetrics(payload) {
  const metric = payload?.metric;
  if (!metric || typeof metric !== "object") {
    return { source: "finnhub-metric", error: "Finnhub 指标接口未返回 metric 字段" };
  }
  const marketCapMillions = toNumber(metric.marketCapitalization);
  return {
    source: "finnhub-metric",
    trailingPE: toNumber(metric.peTTM ?? metric.peBasicExclExtraTTM ?? metric.peAnnual),
    priceToBook: toNumber(metric.pbQuarterly ?? metric.pbAnnual),
    epsTrailingTwelveMonths: toNumber(metric.epsTTM ?? metric.epsBasicExclExtraItemsTTM),
    marketCap: marketCapMillions === undefined ? undefined : marketCapMillions * 1_000_000,
    fiftyTwoWeekHighLow: formatFiftyTwoWeekRange(metric["52WeekHigh"], metric["52WeekLow"])
  };
}

function formatFiftyTwoWeekRange(high, low) {
  const highValue = toNumber(high);
  const lowValue = toNumber(low);
  if (highValue === undefined || lowValue === undefined) {
    return undefined;
  }
  return `$${highValue}/$${lowValue}`;
}

// Nasdaq historical (api.nasdaq.com/api/quote/<SYM>/historical): rows are
// NEWEST first with US-formatted dates ("07/24/2026") and $-prefixed closes
// for equities (plain numbers for funds). Returned ascending so every
// downstream consumer (summarizeHistory's slice(-20)/slice(-60)) keeps
// reading "most recent last", exactly as it did for the Yahoo chart payload.
export function normalizeNasdaqHistorical(payload) {
  const rows = payload?.data?.tradesTable?.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    const apiMessage = payload?.status?.bCodeMessage?.[0]?.errorMessage ?? payload?.message;
    return { source: "nasdaq-historical", error: `Nasdaq 历史行情未返回日线（${String(apiMessage ?? "空 tradesTable").slice(0, 80)}）` };
  }
  const normalized = rows
    .map((row) => ({ date: parseUsDate(row?.date), close: parseMoney(row?.close) }))
    .filter((row) => row.date !== undefined && row.close !== undefined)
    .sort((left, right) => left.date.localeCompare(right.date));
  if (normalized.length === 0) {
    return { source: "nasdaq-historical", error: "Nasdaq 历史行情返回的日线无法解析（日期/收盘价字段为空）" };
  }
  return { source: "nasdaq-historical", rows: normalized };
}

// stockanalysis.com/api/symbol/{s|e}/<sym>/history: {status, data:[{t,o,h,l,c,...}]},
// also newest-first, ISO dates, plain numeric closes.
export function normalizeStockAnalysisHistory(payload) {
  const rows = payload?.data;
  if (!Array.isArray(rows) || rows.length === 0) {
    return { source: "stockanalysis-history", error: "StockAnalysis 历史接口未返回日线数据" };
  }
  const normalized = rows
    .map((row) => ({ date: String(row?.t ?? "").slice(0, 10), close: toNumber(row?.c) }))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/u.test(row.date) && row.close !== undefined)
    .sort((left, right) => left.date.localeCompare(right.date));
  if (normalized.length === 0) {
    return { source: "stockanalysis-history", error: "StockAnalysis 历史接口返回的日线无法解析" };
  }
  return { source: "stockanalysis-history", rows: normalized };
}

const NASDAQ_MONTHS = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12"
};

// Nasdaq option chain (api.nasdaq.com/api/quote/<SYM>/option-chain): one flat
// row list where an expiry GROUP is announced by a row whose `expirygroup` is
// e.g. "July 27, 2026" (all other fields null) and every following row with an
// empty `expirygroup` belongs to that expiry. Only the NEAREST expiry (the
// first group) is summed - the same "最近到期" figure the Yahoo path reported.
export function normalizeNasdaqOptionChain(payload) {
  const rows = payload?.data?.table?.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    const apiMessage = payload?.status?.bCodeMessage?.[0]?.errorMessage ?? payload?.message;
    return { source: "nasdaq-option-chain", error: `Nasdaq 期权链未返回合约（${String(apiMessage ?? "空 table").slice(0, 80)}）` };
  }

  let expiration;
  let started = false;
  let callOpenInterest = 0;
  let putOpenInterest = 0;
  let contractCount = 0;
  for (const row of rows) {
    const group = String(row?.expirygroup ?? "").trim();
    if (group) {
      if (started) {
        break;
      }
      expiration = parseNasdaqExpiryGroup(group);
      started = true;
      continue;
    }
    if (!started) {
      continue;
    }
    const callOi = parseCount(row?.c_Openinterest);
    const putOi = parseCount(row?.p_Openinterest);
    if (callOi === undefined && putOi === undefined) {
      continue;
    }
    callOpenInterest += callOi ?? 0;
    putOpenInterest += putOi ?? 0;
    contractCount += 1;
  }

  if (!started || contractCount === 0) {
    return { source: "nasdaq-option-chain", error: "Nasdaq 期权链未返回最近到期日的未平仓数据" };
  }
  return {
    source: "nasdaq-option-chain",
    expiration: expiration ?? "待确认",
    callOpenInterest,
    putOpenInterest,
    contractCount
  };
}

function parseNasdaqExpiryGroup(value) {
  const match = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/u.exec(String(value ?? "").trim());
  if (!match) {
    return undefined;
  }
  const month = NASDAQ_MONTHS[match[1].toLowerCase()];
  if (!month) {
    return undefined;
  }
  return `${match[3]}-${month}-${match[2].padStart(2, "0")}`;
}

function parseUsDate(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/u.exec(String(value ?? "").trim());
  return match ? `${match[3]}-${match[1]}-${match[2]}` : undefined;
}

// Nasdaq renders "no reported value" as "--" (and occasionally null) - those
// must be skipped, never coerced to a 0 that would silently understate open
// interest.
function parseCount(value) {
  const text = String(value ?? "").replace(/,/gu, "").trim();
  if (!text || text === "--" || /^N\/A$/iu.test(text)) {
    return undefined;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const MERGED_FUNDAMENTAL_KEYS = [
  "trailingPE",
  "forwardPE",
  "priceToBook",
  "epsTrailingTwelveMonths",
  "marketCap",
  "oneYearTarget",
  "previousClose"
];

// A snapshot that carries NO usable field is not a source - counting it as
// one is what let `fundamentals` end up "not an error, but also not a single
// value" and rendered as an unexplained "暂无" (see normalizeNasdaqSummary's
// own comment). Its failure reason is carried out on `merged.failures` so the
// renderer can name WHY each field is missing instead of shrugging.
function hasUsableFundamentalValues(normalized) {
  return MERGED_FUNDAMENTAL_KEYS.some((key) => normalized[key] !== undefined) || Boolean(normalized.fiftyTwoWeekHighLow);
}

export function mergeFundamentalSnapshots(snapshots) {
  const merged = { sources: [], failures: [] };
  for (const snapshot of snapshots.filter(Boolean)) {
    if (snapshot.error) {
      merged.failures.push(`${snapshot.source ?? "未知来源"}：${snapshot.error}`);
      continue;
    }
    const normalized = normalizeFundamentalSnapshot(snapshot);
    if (!normalized) {
      continue;
    }
    if (!hasUsableFundamentalValues(normalized)) {
      merged.failures.push(`${normalized.source ?? "未知来源"}：返回结构完整但没有任何估值字段`);
      continue;
    }
    for (const key of MERGED_FUNDAMENTAL_KEYS) {
      if (merged[key] === undefined && normalized[key] !== undefined) {
        merged[key] = normalized[key];
      }
    }
    if (normalized.fiftyTwoWeekHighLow && !merged.fiftyTwoWeekHighLow) {
      merged.fiftyTwoWeekHighLow = normalized.fiftyTwoWeekHighLow;
    }
    if (normalized.source) {
      merged.sources.push(normalized.source);
    }
  }
  merged.sources = Array.from(new Set(merged.sources));
  merged.failures = Array.from(new Set(merged.failures));
  return merged;
}

// Equity-only metrics: an ETF has no earnings, no book value and no
// sell-side one-year target, so these are not "missing data" for a fund -
// they are structurally inapplicable, and the report must say exactly that
// (verified 2026-07-27: Finnhub free tier returns 19 metrics for QQQM with no
// pe/pb key at all; Nasdaq's ETF summary carries no OneYrTarget).
// Exported alongside VALUATION_DISCLOSURE below: report-quality.mjs accepts
// the structural branch ONLY for these exact sentences, so "an ETF has no
// P/E" can never be paraphrased into an excuse for an equity whose P/E simply
// failed to load.
export const ETF_INAPPLICABLE_REASONS = {
  pe: "ETF 无市盈率口径，Finnhub 免费版对基金不返回该指标",
  pb: "ETF 无市净率口径，基金不披露账面价值",
  eps: "ETF 不披露每股收益",
  targetPrice: "ETF 无卖方一年目标价，Nasdaq 基金摘要不含 OneYrTarget"
};

// 2026-07-27 (adversarial review of ca4cc52, defect 2): the two disclosure
// verbs are deliberately DIFFERENT words, because they mean different things
// to a reader and to the gate:
//   - 不适用: the instrument structurally HAS no such metric. Only ever
//     rendered for an ETF, and only for the four fields above, so every
//     不适用 reason literally starts with INAPPLICABLE_REASON_PREFIX.
//   - 不可得: the metric exists for this instrument, but no source returned
//     it (outage/rate-limit/coverage gap). The reason names the sources.
// Before this split both cases rendered "不可得（…）", so a total PE/PB outage
// across an all-equity batch was indistinguishable - in the report AND in the
// gate - from "a fund has no P/E".
//
// Exported because report-quality.mjs builds its stock.valuation_depth and
// facts-coverage detectors from these exact literals rather than a second,
// hand-typed copy: a phrasing change here can no longer silently stop
// satisfying the gate (see that file's VALUATION_FIELD_DETECTORS, and
// stock-analysis-metrics.test.ts / report-quality.test.ts, which assert both
// sides against the SAME rendered output).
export const VALUATION_DISCLOSURE = {
  inapplicable: "不适用",
  unavailable: "不可得"
};

// Renders an EXPLICIT "<不适用|不可得>（原因）" - never a bare "暂无", which
// report-quality.mjs's detectors deliberately refuse to count as a disclosure
// (a placeholder with no stated reason is a silent gap).
//
// `error` is summarizeValuation's whole-block failure (no source responded at
// all); `failures` are the per-source failures a partially-successful merge
// carried out on `merged.failures`.
//
// `brief` is for the SECOND place a missing metric is disclosed
// (summarizeUpsidePotential, which repeats PE/PB/目标价 in three sections):
// spelling every source's error out there would print the same multi-source
// failure list nine times per symbol. The brief form still states the reason -
// the source did not return the field - and points at the 估值补充 bullet that
// names which source failed and how. The structural (ETF) reason is short and
// self-contained, so it is rendered in full either way.
export function renderMissingValuationDisclosure(field, { instrumentKind = "stock", failures = [], error, brief = false } = {}) {
  if (instrumentKind === "etf" && ETF_INAPPLICABLE_REASONS[field]) {
    return `${VALUATION_DISCLOSURE.inapplicable}（${ETF_INAPPLICABLE_REASONS[field]}）`;
  }
  if (brief) {
    return `${VALUATION_DISCLOSURE.unavailable}（估值来源未返回该字段，原因见估值补充）`;
  }
  const reason = error
    ? `估值来源读取失败：${error}`
    : failures.length > 0
      ? `来源未提供该字段：${failures.join("；")}`
      : "已接入的估值来源均未返回该字段";
  return `${VALUATION_DISCLOSURE.unavailable}（${reason}）`;
}

function valuationValueOrReason(formatted, value, disclosure) {
  return value === undefined ? disclosure : formatted;
}

export function summarizeValuation(valuation, { instrumentKind = "stock" } = {}) {
  if (!valuation || valuation.error) {
    return {
      summary: valuation?.error
        ? `估值读取失败：${valuation.error}`
        : "估值数据暂无可用（未收到任何估值来源的响应）。",
      cheapness: "PE/PB 缺失，估值便宜程度待验证"
    };
  }

  const failures = Array.isArray(valuation.failures) ? valuation.failures : [];
  const pe = toNumber(valuation.trailingPE ?? valuation.forwardPE);
  const pb = toNumber(valuation.priceToBook);
  const marketCap = toNumber(valuation.marketCap);
  const eps = toNumber(valuation.epsTrailingTwelveMonths);
  const oneYearTarget = toNumber(valuation.oneYearTarget);
  const cheapSignals = [
    pb !== undefined && pb < 10 ? "PB < 10" : "",
    pe !== undefined && pe > 0 && pe < 30 ? "PE 低于 30" : ""
  ].filter(Boolean);
  const sourceText = valuation.sources?.length ? `；来源 ${valuation.sources.join("、")}` : "";
  const reasonFor = (field) => renderMissingValuationDisclosure(field, { instrumentKind, failures });

  const summary = [
    `PE ${valuationValueOrReason(formatNumber(pe), pe, reasonFor("pe"))}`,
    `PB ${valuationValueOrReason(formatNumber(pb), pb, reasonFor("pb"))}`,
    `EPS ${valuationValueOrReason(formatNumber(eps), eps, reasonFor("eps"))}`,
    `市值 ${valuationValueOrReason(formatCompactMoney(marketCap), marketCap, reasonFor("marketCap"))}`,
    `一年目标价 ${valuationValueOrReason(formatNumber(oneYearTarget), oneYearTarget, reasonFor("targetPrice"))}`
  ].join("；");

  return {
    summary: `${summary}${sourceText}。`,
    cheapness: cheapSignals.length
      ? `估值信号：${cheapSignals.join("，")}，仍需同行分位确认`
      : instrumentKind === "etf"
        ? "ETF 无市盈率/市净率口径，便宜程度改看均线折价与溢价"
        : "PE/PB 未触发明显便宜信号，或数据缺失"
  };
}

// Accepts EITHER shape:
//   - an already-summed snapshot ({source, expiration, callOpenInterest,
//     putOpenInterest}) - what normalizeNasdaqOptionChain returns;
//   - Yahoo's raw optionChain.result[0] ({expirationDates, options:[{calls,
//     puts}]}) - the original, still-supported last link of the chain.
// An `{error}` (or an empty/unrecognized object, which Yahoo returns as `{}`
// when its payload has no result at all) renders the DISCLOSED branch with a
// stated reason - never a fabricated "未平仓约 0.00", which is what the old
// `?? {}` fallthrough silently produced.
export function summarizeOptionChainStats(optionChain) {
  if (!optionChain || optionChain.error) {
    const summary = optionChain?.error
      ? `期权链读取失败：${optionChain.error}`
      : "期权链暂无可用数据（未收到任何期权来源的响应）。";
    return {
      summary,
      source: undefined,
      expiration: undefined,
      callOpenInterest: undefined,
      putOpenInterest: undefined
    };
  }

  const preSummedCall = toNumber(optionChain.callOpenInterest);
  const preSummedPut = toNumber(optionChain.putOpenInterest);
  if (preSummedCall !== undefined || preSummedPut !== undefined) {
    const expiration = optionChain.expiration ?? "待确认";
    const sourceText = optionChain.source ? `；来源 ${optionChain.source}` : "";
    return {
      source: optionChain.source,
      expiration,
      callOpenInterest: preSummedCall ?? 0,
      putOpenInterest: preSummedPut ?? 0,
      summary: `最近到期 ${expiration}，Call 未平仓约 ${formatNumber(preSummedCall ?? 0)}，Put 未平仓约 ${formatNumber(preSummedPut ?? 0)}；仅作现货波动参考${sourceText}。`
    };
  }

  const hasYahooShape = Array.isArray(optionChain.expirationDates) || Array.isArray(optionChain.options);
  if (!hasYahooShape) {
    return {
      summary: "期权链暂无可用数据（来源返回了空结构，既无到期日也无合约列表）。",
      source: undefined,
      expiration: undefined,
      callOpenInterest: undefined,
      putOpenInterest: undefined
    };
  }

  const expiration = Array.isArray(optionChain.expirationDates) && optionChain.expirationDates.length
    ? new Date(Number(optionChain.expirationDates[0]) * 1000).toISOString().slice(0, 10)
    : "待确认";
  const options = optionChain.options?.[0] ?? {};
  const calls = Array.isArray(options.calls) ? options.calls : [];
  const puts = Array.isArray(options.puts) ? options.puts : [];
  const callOpenInterest = calls.reduce((sum, row) => sum + (toNumber(row.openInterest) ?? 0), 0);
  const putOpenInterest = puts.reduce((sum, row) => sum + (toNumber(row.openInterest) ?? 0), 0);

  return {
    source: optionChain.source ?? "yahoo-options",
    expiration,
    callOpenInterest,
    putOpenInterest,
    summary: `最近到期 ${expiration}，Call 未平仓约 ${formatNumber(callOpenInterest)}，Put 未平仓约 ${formatNumber(putOpenInterest)}；仅作现货波动参考。`
  };
}

// 2026-07-27 (adversarial review of ca4cc52, defect 4): this line was the
// last place still shipping the exact placeholders the rest of that commit
// removed - "目标价缺失" (no reason), "PE 暂无"/"PB 暂无" (the bare placeholder
// the facts-coverage detectors refuse by design), and worst of all
// "趋势分 0.00", a DERIVED score that reads like a measurement but is really
// summarizeHistory's `?? 0` default when no history could be fetched at all.
// Every one of them now states why, using the SAME vocabulary
// summarizeValuation renders (so an ETF reads 不适用 in both places and a
// source outage reads 不可得 in both). `instrumentKind` is threaded in by
// buildDeterministicAnalysis, which already resolves it for summarizeValuation.
export function summarizeUpsidePotential({ lastPrice, valuation, historyStats, optionStats, instrumentKind = "stock" }) {
  const target = toNumber(valuation?.oneYearTarget);
  const price = toNumber(lastPrice);
  const targetUpside = target !== undefined && price !== undefined && price > 0
    ? ((target - price) / price) * 100
    : undefined;
  const pe = toNumber(valuation?.trailingPE ?? valuation?.forwardPE);
  const pb = toNumber(valuation?.priceToBook);
  const trendScore = toNumber(historyStats?.trendScore) ?? 0;
  const callOi = toNumber(optionStats?.callOpenInterest) ?? 0;
  const putOi = toNumber(optionStats?.putOpenInterest) ?? 0;
  const optionBias = callOi + putOi > 0 ? (callOi - putOi) / (callOi + putOi) : 0;
  const valuationScore = [
    targetUpside !== undefined ? clamp(targetUpside / 5, -4, 4) : 0,
    pe !== undefined && pe > 0 && pe < 30 ? 2 : pe !== undefined && pe > 45 ? -2 : 0,
    pb !== undefined && pb > 0 && pb < 10 ? 1 : pb !== undefined && pb > 25 ? -1 : 0
  ].reduce((sum, value) => sum + value, 0);
  const score = valuationScore + clamp(trendScore / 2, -4, 5) + clamp(optionBias * 3, -2, 2);
  const label = score >= 7 ? "偏强" : score >= 3 ? "中性偏强" : score <= -3 ? "偏弱" : "中性";
  const failures = Array.isArray(valuation?.failures) ? valuation.failures : [];
  const disclose = (field) =>
    renderMissingValuationDisclosure(field, { instrumentKind, failures, error: valuation?.error, brief: true });
  // summarizeHistory's no-rows branch marks itself `available: false` and
  // carries the reason in `summary`; a hand-built historyStats (every
  // pre-2026-07-27 caller/test) has no such flag and is treated as available,
  // so a genuine trendScore of exactly 0 still prints as 0.00.
  const trendUnavailableReason = historyStats?.available === false
    ? String(historyStats.summary ?? "历史走势不可用（原因未记录）").replace(/。$/u, "")
    : null;
  const details = [
    targetUpside === undefined
      ? `目标价隐含空间 ${disclose("targetPrice")}`
      : `目标价隐含空间 ${formatPercent(targetUpside)}`,
    `PE ${pe === undefined ? disclose("pe") : formatNumber(pe)}`,
    `PB ${pb === undefined ? disclose("pb") : formatNumber(pb)}`,
    trendUnavailableReason === null
      ? `趋势分 ${formatNumber(trendScore)}`
      : `趋势分 ${VALUATION_DISCLOSURE.unavailable}（${trendUnavailableReason}）`,
    // The option summary is a full sentence ending in "。"; this list is
    // itself joined with "；" and closed with one "。" below, so keeping the
    // inner full stop rendered "……参考。。" in every report.
    optionStats?.summary ? `期权链：${String(optionStats.summary).replace(/。$/u, "")}` : "期权链暂无可用数据"
  ];
  return `综合上行潜力：${label}；${details.join("；")}。`;
}

// Task H7 (2026-07-14 legacy audit): fetchYahooHistory requests range=6mo,
// which yields at most ~126 daily closes - closes.slice(-180) on a ~126-
// element array is silently the WHOLE array, so the value rendered/labeled
// "180 日均线" (and the "偏便宜" verdict derived from it) was never actually
// a 180-session average; it was a mislabeled full-range mean. Chosen fix:
// LABEL the actual window truthfully (`longWindowDays`, capped at 180 but
// reflecting however many sessions are really available) rather than
// widening the fetch range - ma20/ma60/sixMonthReturn/trendScore all
// deliberately key off this same 6-month sample, and widening the range
// would dilute/change those alongside the unrelated bug being fixed here.
// A future fetch of a full year (closes.slice(-180) on ~250 rows) would
// make the label consistently "180 日" - either fix is legitimate per this
// task's brief; this one has zero blast radius outside the mislabeled text.
//
// Phase 5 Task 1 (2026-07-15 plan): relocated here (verbatim, unmodified
// logic) from stock-analysis.mjs so report-facts.mjs's buildStockFacts can
// reuse the SAME longWindowDays/ma20/ma60/ma180 computation stock-analysis.mjs's
// own narrative uses, rather than re-deriving a second, potentially
// divergent formula. Living in this metrics module (which already has zero
// dependents of its own) avoids a stock-analysis.mjs <-> report-facts.mjs
// circular import: stock-analysis.mjs's runAnalysis needs to call INTO
// report-facts.mjs (to persist stock_facts), so report-facts.mjs cannot
// import back from stock-analysis.mjs.
// `history` may be a bare row array (every pre-2026-07-27 caller/test), or
// the {rows, source, error} envelope the multi-source fetch chain now returns
// so the rendered text can name WHICH source produced the numbers and, when
// nothing worked, WHY each source failed.
function normalizeHistoryInput(history) {
  if (Array.isArray(history)) {
    return { rows: history, source: undefined, error: undefined };
  }
  if (history && typeof history === "object") {
    return {
      rows: Array.isArray(history.rows) ? history.rows : [],
      source: history.source,
      error: history.error
    };
  }
  return { rows: [], source: undefined, error: undefined };
}

export function summarizeHistory(history, currentPrice) {
  const { rows, source, error } = normalizeHistoryInput(history);
  if (rows.length === 0) {
    return {
      summary: error
        ? `历史走势读取失败：${error}`
        : "历史走势暂无可用数据（历史来源返回 0 条日线，无法计算均线）。",
      cheapness: "长期均线不可用，便宜程度暂记为待验证",
      // trendScore stays 0 so every downstream arithmetic consumer
      // (buildDeterministicAnalysis's three-path probabilities, this module's
      // own upside score) keeps working on a number rather than NaN; the
      // `available: false` flag is what tells a RENDERER that the 0 is a
      // fallback, not a measurement (see summarizeUpsidePotential).
      available: false,
      trendScore: 0,
      source: undefined,
      support: undefined,
      resistance: undefined,
      ma20: undefined,
      ma60: undefined,
      ma180: undefined,
      longWindowDays: undefined
    };
  }

  const closes = rows.map((row) => row.close).filter((value) => Number.isFinite(value));
  const first = closes[0];
  const lastClose = currentPrice ?? closes.at(-1);
  const sixMonthReturn = first && lastClose ? ((lastClose - first) / first) * 100 : undefined;
  const ma20 = average(closes.slice(-20));
  const ma60 = average(closes.slice(-60));
  const longWindowDays = Math.min(closes.length, 180);
  const ma180 = average(closes.slice(-longWindowDays));
  const recent = closes.slice(-20);
  const support = recent.length ? Math.min(...recent) : undefined;
  const resistance = recent.length ? Math.max(...recent) : undefined;
  const vsMa180 = lastClose !== undefined && ma180 !== undefined && ma180 > 0
    ? ((lastClose - ma180) / ma180) * 100
    : undefined;
  const trendScore = [
    ma20 !== undefined && lastClose !== undefined && lastClose > ma20 ? 4 : -2,
    ma60 !== undefined && lastClose !== undefined && lastClose > ma60 ? 3 : -1,
    sixMonthReturn !== undefined ? Math.max(-5, Math.min(5, sixMonthReturn / 8)) : 0
  ].reduce((sum, value) => sum + value, 0);

  const sourceText = source ? `，来源 ${source}` : "";
  return {
    summary: `${rows[0]?.date} 到 ${rows.at(-1)?.date}，区间涨跌 ${formatPercent(sixMonthReturn)}，样本 ${closes.length} 个交易日${sourceText}。`,
    available: true,
    source,
    cheapness: vsMa180 === undefined
      ? "长期均线不可用，便宜程度待验证"
      : vsMa180 < -5
        ? `现价低于 ${longWindowDays} 日均线 ${formatPercent(Math.abs(vsMa180))}，按群聊口径偏便宜但需排除基本面恶化`
        : `现价相对 ${longWindowDays} 日均线 ${formatPercent(vsMa180)}，不属于明显均线折价`,
    trendScore,
    support,
    resistance,
    ma20,
    ma60,
    ma180,
    longWindowDays
  };
}

function average(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : undefined;
}

function normalizeFundamentalSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }
  return {
    source: snapshot.source ?? "yahoo-quote",
    trailingPE: toNumber(snapshot.trailingPE ?? snapshot.peRatio),
    forwardPE: toNumber(snapshot.forwardPE),
    priceToBook: toNumber(snapshot.priceToBook ?? snapshot.pbRatio),
    epsTrailingTwelveMonths: toNumber(snapshot.epsTrailingTwelveMonths ?? snapshot.eps),
    marketCap: toNumber(snapshot.marketCap),
    oneYearTarget: toNumber(snapshot.oneYearTarget ?? snapshot.targetMeanPrice),
    previousClose: toNumber(snapshot.previousClose),
    fiftyTwoWeekHighLow: snapshot.fiftyTwoWeekHighLow
  };
}

function extractMetric(html, labelPattern) {
  const pattern = new RegExp(`${labelPattern}[\\s\\S]{0,500}?title="([^"]+)"`, "iu");
  const match = html.match(pattern);
  return parseMoney(match?.[1]);
}

function parseMoney(value) {
  const text = String(value ?? "").replace(/[$,\s]/gu, "").trim();
  if (!text || /^N\/A$/iu.test(text)) {
    return undefined;
  }
  const suffix = text.match(/[KMBT]$/iu)?.[0]?.toUpperCase();
  const base = toNumber(text.replace(/[KMBT]$/iu, ""));
  if (base === undefined) {
    return undefined;
  }
  const multipliers = { K: 1_000, M: 1_000_000, B: 1_000_000_000, T: 1_000_000_000_000 };
  return base * (multipliers[suffix] ?? 1);
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : "暂无";
}

function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number >= 0 ? "+" : ""}${number.toFixed(2)}%` : "暂无";
}

function formatCompactMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "暂无";
  }
  if (Math.abs(number) >= 1_000_000_000_000) {
    return `${(number / 1_000_000_000_000).toFixed(2)} 万亿美元`;
  }
  if (Math.abs(number) >= 1_000_000_000) {
    return `${(number / 1_000_000_000).toFixed(2)} 十亿美元`;
  }
  if (Math.abs(number) >= 1_000_000) {
    return `${(number / 1_000_000).toFixed(2)} 百万美元`;
  }
  return `${number.toFixed(2)} 美元`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
