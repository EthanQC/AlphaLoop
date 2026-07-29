// Earnings calendar for the report's 「宏观与财报日历」 section - Task 20
// (2026-07-28 spec-drift plan), requirements §3.1/§2.
//
// The report has always carried a macro calendar (report-macro.mjs, over
// Longbridge's US macro releases) under a heading that said 「宏观日历」. The
// spec's section is 「宏观与财报日历」 - the second half, "when does anything in
// the tracked pool actually report", was never built. This module is that
// half: normalization, ordering and rendering of Finnhub's earnings calendar
// for the SAME tracked-symbol pool the news search uses (§0.4's union of every
// member's watchlist plus held positions).
//
// SHAPE OF THIS MODULE, and why it mirrors report-macro.mjs: the wire call
// lives in news-sources.mjs (`fetchFinnhubEarningsCalendar` - one module owns
// the Finnhub key, its limiter and its redaction), and everything that decides
// what a usable row is, how rows are ordered, and what the reader sees lives
// here, as pure functions a test can drive without a network.
//
// HONESTY RULES (Global Constraints §0.4 - 取不到就如实披露原因):
//   · no FINNHUB_API_KEY               -> the section says the calendar was not
//                                         queried, and names the missing key.
//   · a symbol's fetch failed          -> that symbol is named, with the
//                                         (redacted) reason, not silently
//                                         dropped into "no earnings".
//   · every symbol answered, none had  -> "没有已确认的财报日期" AND the list of
//     a date in the window                symbols that were actually queried,
//                                         so "nothing scheduled" can never be
//                                         confused with "nothing asked".
// There is no code path here that renders an empty or zero-filled earnings row.

import { fetchFinnhubEarningsCalendar } from "./news-sources.mjs";

// Finnhub's `hour` field. Verified values on the live API: "bmo" (before
// market open), "amc" (after market close), "dmh" (during market hours); the
// field can also come back empty when the issuer has not announced a time.
const EARNINGS_HOUR_LABELS = {
  bmo: "盘前",
  amc: "盘后",
  dmh: "盘中"
};

export const UNKNOWN_EARNINGS_HOUR_LABEL = "时段未公布";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * One raw Finnhub `earningsCalendar` row -> the shape the renderer consumes,
 * or `null` when the row cannot be trusted.
 *
 * A row with no parseable `date` is DROPPED rather than defaulted: the whole
 * point of this section is the date, and a made-up one is worse than a
 * shorter list. Missing eps/revenue estimates stay `null` (rendered as an
 * explicit 「未提供」), never 0 - a computed 0 is a fabrication.
 *
 * @param {unknown} row
 * @param {{queriedSymbol?: string}} [context]
 */
export function normalizeEarningsRow(row, context = {}) {
  if (!row || typeof row !== "object") {
    return null;
  }
  const date = String(row.date ?? "").trim();
  if (!DATE_PATTERN.test(date)) {
    return null;
  }
  const reportedSymbol = String(row.symbol ?? "").trim();
  const queriedSymbol = String(context.queriedSymbol ?? "").trim();
  return {
    // The pool symbol we asked about (e.g. "TSM.US"), kept because Finnhub may
    // answer with a different listing's ticker - see fetchFinnhubEarningsCalendar's
    // own note on TSM -> 2330.TW.
    queriedSymbol: queriedSymbol || reportedSymbol,
    symbol: reportedSymbol || queriedSymbol,
    date,
    hour: String(row.hour ?? "").trim().toLowerCase(),
    quarter: toFiniteNumber(row.quarter),
    year: toFiniteNumber(row.year),
    epsEstimate: toFiniteNumber(row.epsEstimate),
    epsActual: toFiniteNumber(row.epsActual),
    revenueEstimate: toFiniteNumber(row.revenueEstimate),
    revenueActual: toFiniteNumber(row.revenueActual)
  };
}

/**
 * Normalizes one symbol's payload and orders it by date ascending. Finnhub
 * returns rows unsorted (verified on the live API: 2026-11-17 arrived before
 * 2026-08-26), and this section is read as "what is coming up next", so the
 * order is not cosmetic.
 */
export function normalizeEarningsCalendarPayload(rows, context = {}) {
  const list = Array.isArray(rows) ? rows : [];
  return list
    .map((row) => normalizeEarningsRow(row, context))
    // Not `.filter(Boolean)` - TS's inferred type predicate narrows this form,
    // so callers (and the repo's typecheck of these .mjs files) see the entry
    // type rather than `entry | null`.
    .filter((entry) => entry !== null)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function formatEstimate(value) {
  if (value === null) {
    return "未提供";
  }
  return String(Math.round(value * 10000) / 10000);
}

// Revenue arrives in raw currency units (93_606_383_310). 亿 is the unit a
// Chinese-language reader scans fastest at this magnitude.
function formatRevenue(value) {
  if (value === null) {
    return "未提供";
  }
  return `${(value / 1e8).toFixed(2)} 亿`;
}

function formatPeriodLabel(entry) {
  if (entry.year === null && entry.quarter === null) {
    return "财报";
  }
  const year = entry.year === null ? "" : `${entry.year} 财年`;
  const quarter = entry.quarter === null ? "" : `Q${entry.quarter}`;
  return `${year}${year && quarter ? " " : ""}${quarter} 财报`;
}

/**
 * One rendered bullet for one upcoming report.
 *
 * `epsActual`/`revenueActual` are rendered only when they exist (a row inside
 * the window that has ALREADY reported), so a not-yet-reported row never shows
 * an "actual" of any kind.
 */
export function renderEarningsLine(entry) {
  // Only annotate a GENUINELY different listing. The pool carries the `.US`
  // suffix and Finnhub answers without it, so comparing the raw strings would
  // tag every ordinary row with a pointless "AMZN.US（Finnhub 代码 AMZN）".
  // Observed on 2026-07-30 against the live pool: of the symbols that returned
  // any row, AMZN and NVDA came back as the bare ticker, and TSM came back as
  // 2330.TW - only the last is worth telling the reader about.
  const bare = (value) => String(value ?? "").toUpperCase().replace(/\.US$/u, "");
  const symbolLabel = entry.queriedSymbol && entry.symbol && bare(entry.queriedSymbol) !== bare(entry.symbol)
    ? `${entry.queriedSymbol}（Finnhub 代码 ${entry.symbol}）`
    : entry.queriedSymbol || entry.symbol;
  const hourLabel = EARNINGS_HOUR_LABELS[entry.hour] ?? UNKNOWN_EARNINGS_HOUR_LABEL;
  const parts = [
    `- ${entry.date} ${hourLabel} ${symbolLabel} ${formatPeriodLabel(entry)}`,
    `EPS 预期 ${formatEstimate(entry.epsEstimate)}`,
    `营收预期 ${formatRevenue(entry.revenueEstimate)}`
  ];
  if (entry.epsActual !== null) {
    parts.push(`EPS 实际 ${formatEstimate(entry.epsActual)}`);
  }
  if (entry.revenueActual !== null) {
    parts.push(`营收实际 ${formatRevenue(entry.revenueActual)}`);
  }
  return `${parts.join("；")}。`;
}

/**
 * The earnings half of the 「宏观与财报日历」 section.
 *
 * Never returns an empty array: when there is nothing to list it returns the
 * reason there is nothing, which is the whole difference between "no company
 * in the pool reports in this window" and "we did not look".
 *
 * @param {{entries: object[], queriedSymbols: string[], lookaheadDays: number,
 *          warnings: string[], skippedReason?: string|null}} result
 */
export function renderEarningsCalendarLines(result) {
  const entries = Array.isArray(result?.entries) ? result.entries : [];
  const queried = Array.isArray(result?.queriedSymbols) ? result.queriedSymbols : [];
  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
  const lookahead = Number(result?.lookaheadDays);
  const windowLabel = Number.isFinite(lookahead) ? `未来 ${lookahead} 天` : "查询窗口";

  if (result?.skippedReason) {
    return [`- 财报日历本次未查询：${result.skippedReason}`];
  }

  const lines = entries.length > 0
    ? entries.map(renderEarningsLine)
    : [
      `- ${windowLabel}内，标的池中没有已确认的财报日期（已查询：${queried.length > 0 ? queried.join("、") : "无标的"}）。`
    ];

  return [
    ...lines,
    ...warnings.map((warning) => `- 财报日历降级：${warning}`)
  ];
}

/**
 * Fetches the earnings calendar for every pool symbol.
 *
 * Per-symbol failures are collected into `warnings` and never thrown: this is
 * ONE section of a report whose other sources may all be fine, and the same
 * source-level-health discipline collectL1News already follows (a single
 * source failing is a disclosed warning, not an aborted report).
 *
 * @param {{symbols: string[], from: string, to: string, lookaheadDays: number,
 *          env?: object, fetchImpl?: typeof fetch, limiter?: object}} options
 */
export async function fetchEarningsCalendar({
  symbols = [],
  from,
  to,
  lookaheadDays,
  env = process.env,
  fetchImpl = fetch,
  limiter
} = {}) {
  const queriedSymbols = symbols.map((symbol) => String(symbol ?? "").trim()).filter(Boolean);
  const apiKey = String(env?.FINNHUB_API_KEY ?? "").trim();

  if (!apiKey) {
    return {
      entries: [],
      queriedSymbols,
      lookaheadDays,
      warnings: [],
      skippedReason: "未配置 FINNHUB_API_KEY，本次没有向 Finnhub 查询任何标的的财报日期。"
    };
  }
  if (queriedSymbols.length === 0) {
    return {
      entries: [],
      queriedSymbols,
      lookaheadDays,
      warnings: [],
      skippedReason: "本次没有可查询的标的（标的池为空）。"
    };
  }

  const settled = await Promise.allSettled(
    queriedSymbols.map((symbol) =>
      fetchFinnhubEarningsCalendar(symbol, { apiKey, from, to, fetchImpl, limiter })
    )
  );

  const entries = [];
  const warnings = [];
  settled.forEach((result, index) => {
    const symbol = queriedSymbols[index];
    if (result.status === "fulfilled") {
      entries.push(...normalizeEarningsCalendarPayload(result.value, { queriedSymbol: symbol }));
      return;
    }
    const reason = String(result.reason?.message ?? result.reason ?? "原因未知").replace(/\s+/gu, " ").slice(0, 180);
    warnings.push(`${symbol} 财报日期读取失败：${reason}`);
  });

  entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return { entries, queriedSymbols, lookaheadDays, warnings, skippedReason: null };
}
