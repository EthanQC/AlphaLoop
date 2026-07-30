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
// is denominated in MILLIONS - multiplying it here keeps every consumer on
// one unit (raw currency units), the same unit Nasdaq's MarketCap string
// parses to.
//
// THE CURRENCY IS NOT ALWAYS USD, and until 2026-07-30 this file assumed it
// was. Measured that day against the mini's own FINNHUB_API_KEY:
//
//   /stock/profile2?symbol=TSM  -> currency "TWD", exchange
//       "TAIWAN STOCK EXCHANGE", marketCapitalization 59125801.64
//   /stock/metric?symbol=TSM    -> marketCapitalization 59125800,
//       epsTTM 87.3818, 52WeekHigh 2535   (all TWD)
//   /stock/profile2?symbol=NVDA -> currency "USD", exchange "NASDAQ NMS"
//
// Finnhub resolves a bare ADR ticker to the company's HOME listing, so for
// TSM it answers in New Taiwan dollars. Those numbers were written to
// stock_facts with unit "USD" and shipped: the 2026-07-27 batch told the
// operator "TSM.US ... EPS 为 87.38 美元，市值为 60,941,068,000,000 美元" and
// /stock/TSM.US rendered 市值 60.94 万亿美元 - a number labelled in dollars
// that was never dollars, and one the card's own PE (26.89) against its own
// price (394.52 USD, from Longbridge) contradicts outright: 394.52/26.89
// implies an EPS near 14.7, not 87.4.
//
// So the currency-denominated fields are now gated on a MEASURED currency,
// and the ratios are not. PE and PB are dimensionless (price and earnings
// are in the same currency, and the ratio survives), so they stay whatever
// the listing is. marketCap, EPS and the 52-week range are amounts; without
// proof they are dollars they do not ship, and the reason - naming the
// currency - travels out on `failures` so summarizeValuation renders
// 不可得（来源未提供该字段：…）instead of a wrong number. There is
// deliberately no FX conversion: inventing a rate to relabel a foreign
// amount as dollars would be fabricating the very number this is protecting.
//
// The reasons are FIELD-SCOPED (`fieldFailures`), not dumped on the snapshot's
// general `failures` list: `renderMissingValuationDisclosure` joins every
// general failure into every missing field's parenthetical, so a shared list
// would have TSM's 一年目标价 - a field Finnhub never returns for anybody -
// blaming New Taiwan dollars for its absence.
//
// Keys are the disclosure field names summarizeValuation asks for ("eps",
// "marketCap"), not the snapshot's own property names, so a reason can reach
// the reader at all. `fiftyTwoWeekHighLow` has no rendered slot anywhere
// (merged and then never read - grep it), hence no entry.
const FINNHUB_MONEY_FIELDS = [
  { key: "marketCap", disclosure: "marketCap" },
  { key: "epsTrailingTwelveMonths", disclosure: "eps" },
  { key: "fiftyTwoWeekHighLow", disclosure: null }
];

/**
 * One declared shape for both branches, so callers (and this directory's
 * `pnpm typecheck`, which type-checks the .mjs) get named optional fields
 * instead of a two-member union nothing can read a property off.
 *
 * @typedef {{
 *   source: string,
 *   error?: string,
 *   trailingPE?: number,
 *   priceToBook?: number,
 *   epsTrailingTwelveMonths?: number,
 *   marketCap?: number,
 *   fiftyTwoWeekHighLow?: string,
 *   fieldFailures?: Record<string, string[]>
 * }} FinnhubMetricSnapshot
 *
 * @param {unknown} payload Raw /stock/metric response.
 * @param {{reportingCurrency?: unknown}} [options] `reportingCurrency` comes
 *   from /stock/profile2 - see the block comment above.
 * @returns {FinnhubMetricSnapshot}
 */
export function normalizeFinnhubMetrics(payload, { reportingCurrency } = {}) {
  const metric = payload?.metric;
  if (!metric || typeof metric !== "object") {
    return { source: "finnhub-metric", error: "Finnhub 指标接口未返回 metric 字段" };
  }
  const marketCapMillions = toNumber(metric.marketCapitalization);
  const snapshot = {
    source: "finnhub-metric",
    trailingPE: toNumber(metric.peTTM ?? metric.peBasicExclExtraTTM ?? metric.peAnnual),
    priceToBook: toNumber(metric.pbQuarterly ?? metric.pbAnnual),
    epsTrailingTwelveMonths: toNumber(metric.epsTTM ?? metric.epsBasicExclExtraItemsTTM),
    marketCap: marketCapMillions === undefined ? undefined : marketCapMillions * 1_000_000,
    fiftyTwoWeekHighLow: formatFiftyTwoWeekRange(metric["52WeekHigh"], metric["52WeekLow"])
  };

  const currency = String(reportingCurrency ?? "").trim().toUpperCase();
  if (currency === "USD") {
    return snapshot;
  }

  // Deliberately free of full-width parentheses, for the same reason
  // INSUFFICIENT_SAMPLE_PREFIX is: report-quality.mjs's disclosure detectors
  // wrap a reason in 「（…）」 and match the inside with `[^）]{4,}`, so a
  // nested full-width pair is a hazard not worth carrying for a comma's worth
  // of prose.
  const reason = currency
    ? `finnhub-metric：该标的在 Finnhub 以 ${currency} 计价，Finnhub 把 ADR 代码解析到了公司本土上市地，金额类指标不是美元，已丢弃不用`
    : "finnhub-metric：未能确认该标的在 Finnhub 的计价货币，金额类指标可能不是美元，已丢弃不用";

  // Only report a dropped field if there was actually a value to drop -
  // otherwise every ETF (Finnhub returns no EPS for a fund) would collect a
  // currency complaint on top of its correct 不适用 reason.
  const fieldFailures = {};
  for (const { key, disclosure } of FINNHUB_MONEY_FIELDS) {
    if (snapshot[key] === undefined) {
      continue;
    }
    snapshot[key] = undefined;
    const slot = disclosure ?? key;
    fieldFailures[slot] = [reason];
  }
  if (Object.keys(fieldFailures).length > 0) {
    snapshot.fieldFailures = fieldFailures;
  }
  return snapshot;
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
  const merged = { sources: [], failures: [], fieldFailures: {} };
  for (const snapshot of snapshots.filter(Boolean)) {
    if (snapshot.error) {
      merged.failures.push(`${snapshot.source ?? "未知来源"}：${snapshot.error}`);
      continue;
    }
    const normalized = normalizeFundamentalSnapshot(snapshot);
    if (!normalized) {
      continue;
    }
    // A source's own per-field reasons carry regardless of whether it went on
    // to contribute anything, so "why is 市值 missing" is answerable even when
    // the only source that had one withheld it.
    const withheld = Object.entries(normalized.fieldFailures);
    for (const [field, reasons] of withheld) {
      merged.fieldFailures[field] = [...(merged.fieldFailures[field] ?? []), ...reasons];
    }
    if (!hasUsableFundamentalValues(normalized)) {
      // ...but do not ALSO claim it returned nothing when it already said why
      // it withheld what it had - "没有任何估值字段" would contradict the
      // currency reason sitting next to it.
      if (withheld.length === 0) {
        merged.failures.push(`${normalized.source ?? "未知来源"}：返回结构完整但没有任何估值字段`);
      }
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
  // A field that some LATER source did supply is not missing, so its withheld
  // reason must not be rendered - the reader would be told 市值 is unavailable
  // next to a 市值. Only reasons for still-absent fields survive.
  merged.fieldFailures = Object.fromEntries(
    Object.entries(merged.fieldFailures)
      .filter(([field]) => merged[DISCLOSURE_FIELD_TO_MERGED_KEY[field] ?? field] === undefined)
      .map(([field, reasons]) => [field, Array.from(new Set(reasons))])
  );
  return merged;
}

// summarizeValuation asks for disclosure field names ("eps"); the merged
// object stores snapshot property names ("epsTrailingTwelveMonths"). Fields
// whose two names already agree need no entry.
const DISCLOSURE_FIELD_TO_MERGED_KEY = {
  eps: "epsTrailingTwelveMonths",
  pe: "trailingPE",
  pb: "priceToBook",
  targetPrice: "oneYearTarget"
};

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

// 2026-07-27 (second adversarial pass, defect 5): the honest wording for "this
// metric needs an N-session window and the sample is shorter than that". Same
// contract as every disclosure above - a stated reason, never a placeholder,
// and never a shorter mean published under a longer window's label. Exported
// because report-quality.mjs's facts-coverage detector for history.ma20/ma60
// is built from this exact literal instead of a hand-typed copy.
// Deliberately parenthesis-free: the detectors wrap a disclosure reason in
// "（…）" and match it with `[^）]+`, which a nested full-width pair breaks.
export const INSUFFICIENT_SAMPLE_PREFIX = "样本不足";

export function insufficientSampleReason(windowDays, sampleDays) {
  return `${INSUFFICIENT_SAMPLE_PREFIX} ${windowDays} 日，实际仅 ${sampleDays} 个交易日`;
}

// ---------------------------------------------------------------------------
// 多路径概率的诚实呈现 (Task 23, 2026-07-30)
// ---------------------------------------------------------------------------
//
// The three-path numbers stock-analysis.mjs computes are a HAND-WRITTEN
// arithmetic rule, not a model output and not a historical frequency:
//
//   bullish = round(clamp(35 + 当日涨跌幅 + trendScore, 20, 60))
//   bearish = round(clamp(32 - 当日涨跌幅 - trendScore, 20, 55))
//   neutral = max(0, 100 - bullish - bearish)
//
// Two separate honesty defects were live in the shipped reports until this
// task (verified against reports/stock-analysis/2026-07-27.md on the mini):
//
//   1. They were rendered by `formatPercent`, the SIGNED two-decimal
//      formatter meant for price CHANGE (`上行路径（约 +31.00%）`). A
//      probability is not signed and is not measured to a hundredth of a
//      percent; the `+` in front of it reads like a return.
//   2. Nothing anywhere said where the number came from, so a reader had no
//      way to tell this heuristic apart from a model probability.
//
// `formatPathProbability` is the unsigned integer-percent form ("31%"), and
// `PATH_PROBABILITY_DISCLOSURE` is the one line every renderer that prints
// these numbers must print alongside them. Both live here (not in
// stock-analysis.mjs) so the report renderer, the conclusion box and the
// tests all quote the SAME literal instead of hand-typed copies.
//
// The clamp bounds in the sentence are read from the constants below, which
// stock-analysis.mjs imports for the arithmetic itself - the disclosure
// therefore cannot drift from the computation it describes.
export const PATH_PROBABILITY_BOUNDS = {
  bullishBase: 35,
  bullishMin: 20,
  bullishMax: 60,
  bearishBase: 32,
  bearishMin: 20,
  bearishMax: 55
};

export const PATH_PROBABILITY_DISCLOSURE =
  `概率口径：确定性启发式，不是模型概率也不是历史频率——` +
  `输入只有当日涨跌幅与 6 个月趋势分，` +
  `上行=${PATH_PROBABILITY_BOUNDS.bullishBase}+涨跌幅+趋势分并钳制在 ${PATH_PROBABILITY_BOUNDS.bullishMin}-${PATH_PROBABILITY_BOUNDS.bullishMax}%，` +
  `回撤=${PATH_PROBABILITY_BOUNDS.bearishBase}-涨跌幅-趋势分并钳制在 ${PATH_PROBABILITY_BOUNDS.bearishMin}-${PATH_PROBABILITY_BOUNDS.bearishMax}%，` +
  `震荡取 100% 减去两者的余量。`;

/**
 * Unsigned, integer-percent rendering of a path probability ("31%").
 * A non-finite input renders 暂无 rather than "NaN%" or a fabricated 0.
 */
export function formatPathProbability(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${Math.round(number)}%` : "暂无";
}

// 2026-07-27 (second adversarial pass, defect 6): `目标价隐含空间` needs BOTH a
// one-year target and a usable current price, so it can be unavailable for
// three unrelated reasons. Naming the true one is the difference between "the
// valuation sources are down" and "the quote had no price" for whoever reads
// the report next.
export const TARGET_UPSIDE_UNAVAILABLE_REASONS = {
  missingPrice: "已取到一年目标价，但行情未返回可用现价，无法计算隐含空间",
  invalidPrice: "已取到一年目标价，但行情返回的现价不是正数，无法计算隐含空间"
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
// `fieldFailures` are reasons scoped to THIS field (a source that answered but
// withheld this one value - see normalizeFinnhubMetrics' currency gate). They
// win over the general per-source list, which is what makes 一年目标价 stop
// blaming a currency it has nothing to do with.
export function renderMissingValuationDisclosure(
  field,
  { instrumentKind = "stock", failures = [], fieldFailures = {}, error, brief = false } = {}
) {
  if (instrumentKind === "etf" && ETF_INAPPLICABLE_REASONS[field]) {
    return `${VALUATION_DISCLOSURE.inapplicable}（${ETF_INAPPLICABLE_REASONS[field]}）`;
  }
  if (brief) {
    return `${VALUATION_DISCLOSURE.unavailable}（估值来源未返回该字段，原因见估值补充）`;
  }
  const scoped = Array.isArray(fieldFailures[field]) ? fieldFailures[field] : [];
  const reason = scoped.length > 0
    ? `来源未提供该字段：${scoped.join("；")}`
    : error
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
  const fieldFailures =
    valuation.fieldFailures && typeof valuation.fieldFailures === "object" ? valuation.fieldFailures : {};
  const reasonFor = (field) =>
    renderMissingValuationDisclosure(field, { instrumentKind, failures, fieldFailures });

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
  // Defect 6: only the "no target came back" case is the valuation source's
  // fault. When the target IS here and the PRICE is what's missing (or is not
  // a positive number), say so - blaming the valuation source there sends the
  // reader to the wrong bullet, and the ETF sentence would be plainly false.
  const targetUpsideDisclosure = () => {
    if (target === undefined) {
      return disclose("targetPrice");
    }
    const reason = price === undefined
      ? TARGET_UPSIDE_UNAVAILABLE_REASONS.missingPrice
      : TARGET_UPSIDE_UNAVAILABLE_REASONS.invalidPrice;
    return `${VALUATION_DISCLOSURE.unavailable}（${reason}）`;
  };
  const details = [
    targetUpside === undefined
      ? `目标价隐含空间 ${targetUpsideDisclosure()}`
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
      supportWindowDays: undefined,
      ma20: undefined,
      ma60: undefined,
      ma180: undefined,
      longWindowDays: undefined,
      sampleDays: 0,
      movingAverageDisclosures: {}
    };
  }

  const closes = rows.map((row) => row.close).filter((value) => Number.isFinite(value));
  const first = closes[0];
  const lastClose = currentPrice ?? closes.at(-1);
  const sixMonthReturn = first && lastClose ? ((lastClose - first) / first) * 100 : undefined;
  // 2026-07-27 (second adversarial pass, defect 5): `closes.slice(-20)` on a
  // 12-element array is the WHOLE array, so a 12-session mean used to be
  // published as "20 日均线" - the identical mislabeling this file's own header
  // comment (see summarizeHistory's block above) documents and fixed for the
  // 180-day average. Same treatment, opposite direction: the long window is
  // labeled with the sessions it really had (`longWindowDays`), while the two
  // FIXED-label windows below refuse to compute at all when the sample is
  // short, and disclose the real count instead. Both are honest; only these
  // two carry a hard-coded "20 日"/"60 日" label in the rendered text, which is
  // what makes a shortened sample a lie rather than a narrower window.
  const sampleDays = closes.length;
  const ma20 = sampleDays >= 20 ? average(closes.slice(-20)) : undefined;
  const ma60 = sampleDays >= 60 ? average(closes.slice(-60)) : undefined;
  const movingAverageDisclosures = {
    ma20: sampleDays >= 20 ? undefined : insufficientSampleReason(20, sampleDays),
    ma60: sampleDays >= 60 ? undefined : insufficientSampleReason(60, sampleDays)
  };
  const longWindowDays = Math.min(sampleDays, 180);
  const ma180 = average(closes.slice(-longWindowDays));
  // 2026-07-28: `closes.slice(-20)` on a shorter array is the WHOLE array, so
  // these extremes are only a 20-session support/resistance when at least 20
  // sessions exist. `supportWindowDays` publishes the window they were REALLY
  // taken over so the renderer can label it truthfully instead of hard-coding
  // "近20日" - the same treatment ma20/ma60 got for their fixed labels above.
  // (One count covers both extremes: they come from the same `recent` slice.)
  const recent = closes.slice(-20);
  const supportWindowDays = recent.length || undefined;
  const support = recent.length ? Math.min(...recent) : undefined;
  const resistance = recent.length ? Math.max(...recent) : undefined;
  const vsMa180 = lastClose !== undefined && ma180 !== undefined && ma180 > 0
    ? ((lastClose - ma180) / ma180) * 100
    : undefined;
  // An UNKNOWN moving average is not a bearish one: with ma20/ma60 now
  // deliberately undefined for a short sample, the old `? 4 : -2` / `? 3 : -1`
  // shape would have scored "we could not compute this" as a downtrend. A leg
  // that cannot be evaluated contributes 0.
  const trendScore = [
    ma20 === undefined || lastClose === undefined ? 0 : lastClose > ma20 ? 4 : -2,
    ma60 === undefined || lastClose === undefined ? 0 : lastClose > ma60 ? 3 : -1,
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
    supportWindowDays,
    ma20,
    ma60,
    ma180,
    longWindowDays,
    sampleDays,
    movingAverageDisclosures
  };
}

// The rendered value for a fixed-label moving average: the number when the
// full window really exists, otherwise the reason it does not (defect 5).
// A caller-built historyStats with no `movingAverageDisclosures` (every
// pre-2026-07-27 test/fixture) keeps the previous formatting exactly.
export function formatMovingAverage(historyStats, key) {
  const value = historyStats?.[key];
  if (Number.isFinite(Number(value))) {
    return formatNumber(value);
  }
  const reason = historyStats?.movingAverageDisclosures?.[key];
  return reason ? `${VALUATION_DISCLOSURE.unavailable}（${reason}）` : formatNumber(value);
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
    fiftyTwoWeekHighLow: snapshot.fiftyTwoWeekHighLow,
    // PER-FIELD reasons from a source that answered but withheld some fields
    // on purpose (currently only normalizeFinnhubMetrics' non-USD gate). Kept
    // separate from `snapshot.error`, which means the whole source failed:
    // finnhub still supplies PE/PB for TSM, so it must keep counting as a
    // contributing source while still explaining the two amounts it dropped.
    fieldFailures:
      snapshot.fieldFailures && typeof snapshot.fieldFailures === "object" ? snapshot.fieldFailures : {}
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
