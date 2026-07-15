import { toNumber } from "./report-data.mjs";

export function normalizeNasdaqSummary(payload) {
  const summaryData = payload?.data?.summaryData ?? {};
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

export function mergeFundamentalSnapshots(snapshots) {
  const merged = { sources: [] };
  for (const snapshot of snapshots.filter(Boolean)) {
    if (snapshot.error) {
      continue;
    }
    const normalized = normalizeFundamentalSnapshot(snapshot);
    if (!normalized) {
      continue;
    }
    for (const key of [
      "trailingPE",
      "forwardPE",
      "priceToBook",
      "epsTrailingTwelveMonths",
      "marketCap",
      "oneYearTarget",
      "previousClose"
    ]) {
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
  return merged;
}

export function summarizeValuation(valuation) {
  if (!valuation || valuation.error) {
    return {
      summary: valuation?.error ? `估值读取失败：${valuation.error}` : "估值数据暂无可用。",
      cheapness: "PE/PB 缺失，估值便宜程度待验证"
    };
  }

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

  return {
    summary: `PE ${formatNumber(pe)}；PB ${formatNumber(pb)}；EPS ${formatNumber(eps)}；市值 ${formatCompactMoney(marketCap)}；一年目标价 ${formatNumber(oneYearTarget)}${sourceText}。`,
    cheapness: cheapSignals.length
      ? `估值信号：${cheapSignals.join("，")}，仍需同行分位确认`
      : "PE/PB 未触发明显便宜信号，或数据缺失"
  };
}

export function summarizeOptionChainStats(optionChain) {
  if (!optionChain || optionChain.error) {
    const summary = optionChain?.error ? `期权链读取失败：${optionChain.error}` : "期权链暂无可用数据。";
    return {
      summary,
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
    expiration,
    callOpenInterest,
    putOpenInterest,
    summary: `最近到期 ${expiration}，Call 未平仓约 ${formatNumber(callOpenInterest)}，Put 未平仓约 ${formatNumber(putOpenInterest)}；仅作现货波动参考。`
  };
}

export function summarizeUpsidePotential({ lastPrice, valuation, historyStats, optionStats }) {
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
  const details = [
    targetUpside === undefined ? "目标价缺失" : `目标价隐含空间 ${formatPercent(targetUpside)}`,
    `PE ${formatNumber(pe)}`,
    `PB ${formatNumber(pb)}`,
    `趋势分 ${formatNumber(trendScore)}`,
    optionStats?.summary ? `期权链：${optionStats.summary}` : "期权链暂无可用数据"
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
export function summarizeHistory(history, currentPrice) {
  if (!Array.isArray(history) || history.length === 0) {
    return {
      summary: history?.error ? `历史走势读取失败：${history.error}` : "历史走势暂无可用数据。",
      cheapness: "长期均线不可用，便宜程度暂记为待验证",
      trendScore: 0,
      support: undefined,
      resistance: undefined,
      ma20: undefined,
      ma60: undefined,
      ma180: undefined,
      longWindowDays: undefined
    };
  }

  const closes = history.map((row) => row.close).filter((value) => Number.isFinite(value));
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

  return {
    summary: `${history[0]?.date} 到 ${history.at(-1)?.date}，区间涨跌 ${formatPercent(sixMonthReturn)}，样本 ${closes.length} 个交易日。`,
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
