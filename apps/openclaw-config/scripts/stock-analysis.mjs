#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createId,
  deliverReportToFeishu,
  loadLocalEnv,
  openTradingDatabase
} from "../../../packages/shared-types/dist/index.js";
import { runLongbridgeJsonWithRetry } from "./_longbridge.mjs";
import { normalizeNewsPayload, normalizeQuotePayload, normalizeSymbol, toNumber } from "./report-data.mjs";
import {
  normalizeExternalRssNews,
  mergeNewsArticles,
  normalizeYahooSearchNews,
  renderDetailedNewsLine,
  selectDiverseNewsArticles,
  summarizeNewsSourceBreakdown
} from "./report-news.mjs";
import { assertStockAnalysisQuality } from "./report-quality.mjs";
import { buildYahooOptionChainUrls } from "./stock-analysis-sources.mjs";
import { writeMarkdownPdf } from "./report-rendering.mjs";
import {
  extractStockAnalysisStatistics,
  mergeFundamentalSnapshots,
  normalizeNasdaqSummary,
  summarizeOptionChainStats,
  summarizeUpsidePotential,
  summarizeValuation
} from "./stock-analysis-metrics.mjs";
import { loadStockAnalysisTemplate } from "./stock-analysis-template.mjs";
import { shouldRunStockAnalysis } from "./trading-schedule.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
loadLocalEnv(repoRoot);

const runtimeDir = join(repoRoot, "runtime");
const dbPath = join(runtimeDir, "trading.sqlite");
const reportsDir = join(repoRoot, "reports", "stock-analysis");
const statePath = join(runtimeDir, "stock-analysis-state.json");
mkdirSync(runtimeDir, { recursive: true });
mkdirSync(reportsDir, { recursive: true });

const [command = "scheduled", ...args] = process.argv.slice(2);
const db = openTradingDatabase(dbPath);
ensureStockAnalysisTables(db);

if (command === "targets") {
  setTargets(args);
} else if (command === "list-targets") {
  console.log(JSON.stringify(listTargets(), null, 2));
} else if (command === "run") {
  await runAnalysis({ force: args.includes("--force") });
} else if (command === "prepare") {
  await runAnalysis({
    deliver: false,
    targetsOverride: args.filter((arg) => !arg.startsWith("--"))
  });
} else if (command === "scheduled") {
  await runScheduled(args.includes("--force"));
} else {
  throw new Error("Usage: stock-analysis.mjs <targets|list-targets|prepare|run|scheduled> [SYMBOL...] [--force]");
}

function setTargets(symbols) {
  const normalized = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))];
  if (normalized.length === 0) {
    throw new Error("请至少提供一个美股标的，例如：stock-analysis.mjs targets AAPL MSFT NVDA。");
  }

  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    db.prepare("UPDATE stock_analysis_targets SET active = 0, updated_at = ? WHERE active = 1").run(now);
    const insert = db.prepare(`
      INSERT INTO stock_analysis_targets (symbol, active, created_at, updated_at)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET active = 1, updated_at = excluded.updated_at
    `);
    for (const symbol of normalized) {
      insert.run(symbol, now, now);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  console.log(JSON.stringify({ saved: normalized }, null, 2));
}

async function runScheduled(force = false) {
  const state = readState();
  const targets = listTargets();
  if (targets.length === 0) {
    console.log(JSON.stringify({ skipped: true, reason: "no_targets", lastRunAt: state.lastRunAt ?? null }, null, 2));
    return;
  }
  const cronTriggered = process.env.OPENCLAW_CRON_TRIGGERED === "1";
  if (!force && !shouldRunStockAnalysis(new Date(), state.lastRunAt, { cronTriggered })) {
    console.log(JSON.stringify({ skipped: true, reason: "not_due", lastRunAt: state.lastRunAt ?? null }, null, 2));
    return;
  }
  await runAnalysis({ force });
}

async function runAnalysis({ deliver = true, targetsOverride = null } = {}) {
  const targets = Array.isArray(targetsOverride) && targetsOverride.length
    ? [...new Set(targetsOverride.map(normalizeSymbol).filter(Boolean))]
    : listTargets();
  if (targets.length === 0) {
    throw new Error("没有已启用的个股分析标的。先运行：stock-analysis.mjs targets AAPL MSFT。");
  }

  const generatedAt = new Date().toISOString();
  const records = [];
  for (const symbol of targets) {
    records.push(await fetchStockAnalysisRecord(symbol));
  }

  const label = generatedAt.slice(0, 10);
  const markdown = renderBatchStockAnalysis({ label, generatedAt, records });
  assertStockAnalysisQuality(markdown);
  const markdownPath = join(reportsDir, `${label}.md`);
  const pdfPath = join(reportsDir, `${label}.pdf`);
  writeFileSync(markdownPath, `${markdown}\n`, "utf8");
  await writeMarkdownPdf({ repoRoot, runtimeDir, markdownPath, pdfPath, markdown });

  if (!deliver) {
    console.log(JSON.stringify({ prepared: true, delivered: false, symbols: targets, markdownPath, pdfPath }, null, 2));
    return;
  }

  const delivery = await deliverReportToFeishu({
    title: `OpenClaw 个股分析 ${label}`,
    markdown,
    markdownPath,
    pdfPath
  });
  if (!delivery.sent) {
    throw new Error(delivery.reason ?? "个股分析报告未发送。");
  }

  const runId = createId("stock_analysis_run");
  db.prepare(`
    INSERT INTO stock_analysis_runs (id, created_at, symbols, markdown_path, pdf_path, delivery)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(runId, generatedAt, JSON.stringify(targets), markdownPath, pdfPath, JSON.stringify(delivery));

  writeState({ lastRunAt: generatedAt, lastRunId: runId, symbols: targets });
  console.log(JSON.stringify({ delivered: true, runId, symbols: targets, markdownPath, pdfPath }, null, 2));
}

async function fetchStockAnalysisRecord(symbol) {
  const quotePayload = await runLongbridgeJsonWithRetry("quote", ["quote", symbol], { label: `Longbridge ${symbol} 行情` });
  const quote = normalizeQuotePayload(quotePayload, symbol);
  const [history, fundamentals, optionChain] = await Promise.all([
    fetchYahooHistory(symbol),
    fetchFundamentalSnapshots(symbol),
    fetchYahooOptionChain(symbol)
  ]);
  const news = await fetchStockNews(symbol);

  return {
    symbol,
    quote,
    history,
    fundamentals,
    optionChain,
    news,
    analysis: buildDeterministicAnalysis(symbol, quote, news, { history, fundamentals, optionChain })
  };
}

function buildDeterministicAnalysis(symbol, quote, news, extraData = {}) {
  const last = toNumber(quote.last ?? quote.last_done ?? quote.lastDone);
  const open = toNumber(quote.open);
  const high = toNumber(quote.high);
  const low = toNumber(quote.low);
  const prevClose = toNumber(quote.prev_close ?? quote.prevClose);
  const volume = toNumber(quote.volume ?? quote.turnover_volume);
  const pct = last !== undefined && prevClose ? ((last - prevClose) / prevClose) * 100 : undefined;
  const support = low ?? prevClose ?? last;
  const resistance = high ?? last;
  const historyStats = summarizeHistory(extraData.history, last);
  const valuation = summarizeValuation(extraData.fundamentals);
  const optionStats = summarizeOptionChainStats(extraData.optionChain);
  const upsidePotential = summarizeUpsidePotential({
    lastPrice: last,
    valuation: extraData.fundamentals,
    historyStats,
    optionStats
  });
  const newsTitles = selectDiverseNewsArticles(news, 6).map((entry) => entry.titleZh ?? entry.title).join("；");
  const nextMonthlyExpiry = nextUsMonthlyOptionExpiry(new Date());
  const trendBias = historyStats.trendScore;
  const bullishProbability = Math.round(Math.min(60, Math.max(20, 35 + (pct ?? 0) + trendBias)));
  const bearishProbability = Math.round(Math.min(55, Math.max(20, 32 - (pct ?? 0) - trendBias)));
  const neutralProbability = Math.max(0, 100 - bullishProbability - bearishProbability);

  return {
    basic: [
      `最新价格：${formatNumber(last)}；涨跌幅：${formatPercent(pct)}；成交量：${formatNumber(volume)}。`,
      `日内区间：${formatNumber(low)} - ${formatNumber(high)}；开盘：${formatNumber(open)}；前收：${formatNumber(prevClose)}。`,
      `6 个月走势：${historyStats.summary}`,
      `数据来源：Longbridge 行情；Longbridge/Yahoo Finance 多源新闻；Yahoo chart/options、Nasdaq、StockAnalysis 作为只读补充。`
    ],
    thesis: [
      "短线判断以价格相对前收、日内区间和新闻催化为主；中期判断仍需结合财报、指引和行业景气。",
      `当前新闻主线：${newsTitles || "暂未读取到有效新闻标题"}。`,
      `便宜程度：${historyStats.cheapness}；${valuation.cheapness}。`,
      upsidePotential
    ],
    fundamentals: [
      "已验证：Longbridge 实时行情、日内高低点、成交量、多源新闻标题、媒体、链接与发布时间。",
      `估值补充：${valuation.summary}`,
      upsidePotential,
      "待验证：最新财报原文、管理层指引、同行估值分位和盈利释放节奏；缺失项不会进入自动交易。",
      "报告中所有预测均视为待验证路径，不作为实盘自动执行依据。"
    ],
    catalysts: [
      "近期催化剂来自公司新闻、财报窗口、宏观利率预期、行业景气和同类股票联动。",
      "若新闻标题集中在指引上修、订单增长、监管缓和或行业需求改善，偏正向；反之偏负向。"
    ],
    risks: [
      "若价格跌破支撑且成交量放大，需要重新评估短线方向。",
      "若新闻只影响情绪而不改变基本面，应降低结论权重。",
      "任何实盘动作都必须停在建议卡和人工复核。"
    ],
    trading: [
      `短线支撑位参考：${formatNumber(historyStats.support ?? support)}；短线阻力位参考：${formatNumber(historyStats.resistance ?? resistance)}。`,
      `均线：20 日 ${formatNumber(historyStats.ma20)}；60 日 ${formatNumber(historyStats.ma60)}；180 日 ${formatNumber(historyStats.ma180)}。`,
      `日内强弱：${pct === undefined ? "缺少前收数据" : pct >= 0 ? "相对前收偏强" : "相对前收偏弱"}。`,
      "大单、卖压和做空比例必须分开验证，不能用盘口现象直接推断做空。"
    ],
    options: [
      `下一次美股月度期权到期日参考：${nextMonthlyExpiry}；到期日前后重点看价格钉仓、Gamma 暴露和流动性变化。`,
      `期权链只读补充：${optionStats.summary}`,
      "当前系统不执行、不模拟、不建议任何期权自动化，仅把期权交割作为现货波动影响因素。"
    ],
    conclusion: [
      `上行路径（约 ${formatPercent(bullishProbability)}）：若守住 ${formatNumber(historyStats.support ?? support)} 并放量突破 ${formatNumber(historyStats.resistance ?? resistance)}，短线偏上行。`,
      `震荡路径（约 ${formatPercent(neutralProbability)}）：若价格继续围绕日内区间运行且新闻没有改变基本面，维持观察。`,
      `回撤路径（约 ${formatPercent(bearishProbability)}）：若跌破 ${formatNumber(historyStats.support ?? support)} 且新闻/宏观共振转弱，短线偏回撤。`,
      upsidePotential,
      "复盘标签：stock-analysis、support-resistance、options-expiry-watch、prediction-review。"
    ]
  };
}

function renderBatchStockAnalysis({ label, generatedAt, records }) {
  const template = loadStockAnalysisTemplate();
  const lines = [
    `# OpenClaw 个股分析 ${label}`,
    "",
    `生成时间：${formatShanghaiTime(generatedAt)}`,
    "",
    "- 语言：中文。",
    "- 范围：仅美股；不覆盖中概/港股。",
    "- 投递：飞书摘要卡片 + PDF。",
    "- 风控：不触发实盘交易；期权只作为交割影响分析，不自动化。",
    "",
    "## 本批次结论",
    "",
    ...records.map((record) => `- ${record.symbol}：支撑位 ${extractTradingLevel(record.analysis.trading[0], "support")}；阻力位 ${extractTradingLevel(record.analysis.trading[0], "resistance")}；需要按新闻与成交量继续验证。`),
    ""
  ];

  for (const record of records) {
    lines.push(`## ${record.symbol}`, "");
    for (const section of template.sections) {
      lines.push(`### ${section.title}`, "");
      const values = sectionValues(record.analysis, section.title);
      for (const value of values) {
        lines.push(`- ${value}`);
      }
      lines.push("");
    }
    lines.push("### 近期新闻", "");
    const visibleNews = selectDiverseNewsArticles(record.news, 6);
    lines.push(`- 来源分布：${summarizeNewsSourceBreakdown(record.news)}。`);
    if (!visibleNews.some(hasNonLongbridgeNewsSource)) {
      lines.push("- 来源提示：本批次未读取到可展示的非 Longbridge 新闻，已保留来源降级状态。");
    }
    for (const entry of visibleNews) {
      lines.push(renderDetailedNewsLine(entry, formatShanghaiTime));
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function hasNonLongbridgeNewsSource(article) {
  const sources = Array.isArray(article?.sourceEvidence)
    ? article.sourceEvidence
    : [article?.source];
  return sources.some((source) => source && source !== "longbridge-news");
}

function sectionValues(analysis, title) {
  const map = {
    "标的基本信息": analysis.basic,
    "投资逻辑": analysis.thesis,
    "基本面分析": analysis.fundamentals,
    "催化剂": analysis.catalysts,
    "风险点": analysis.risks,
    "市场表现与交易层面": analysis.trading,
    "期权交割与阻力支撑": analysis.options,
    "结论与复盘标签": analysis.conclusion
  };
  return map[title] ?? [];
}

function extractTradingLevel(line, side) {
  const pattern = side === "support"
    ? /支撑位参考：([^；]+)/u
    : /阻力位参考：(.+)。/u;
  return formatNumber(String(line ?? "").match(pattern)?.[1]);
}

function listTargets() {
  return db.prepare(`
    SELECT symbol FROM stock_analysis_targets
    WHERE active = 1
    ORDER BY updated_at ASC, symbol ASC
  `).all().map((row) => String(row.symbol));
}

function ensureStockAnalysisTables(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS stock_analysis_targets (
      symbol TEXT PRIMARY KEY,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_analysis_runs (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      symbols TEXT NOT NULL,
      markdown_path TEXT NOT NULL,
      pdf_path TEXT NOT NULL,
      delivery TEXT NOT NULL
    );
  `);
}

function readState() {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
}

function writeState(next) {
  writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function formatShanghaiTime(value) {
  const timestamp = new Date(String(value ?? "")).getTime();
  if (!Number.isFinite(timestamp)) {
    return "时间不可用";
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(timestamp));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`;
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : "暂无";
}

function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number >= 0 ? "+" : ""}${number.toFixed(2)}%` : "暂无";
}

async function fetchYahooHistory(symbol) {
  const yahooSymbol = toYahooSymbol(symbol);
  try {
    const payload = await fetchJsonWithTimeout(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=6mo&interval=1d&includePrePost=false`
    );
    const result = payload?.chart?.result?.[0];
    const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
    const closes = Array.isArray(result?.indicators?.quote?.[0]?.close)
      ? result.indicators.quote[0].close
      : [];
    return timestamps
      .map((timestamp, index) => ({
        date: new Date(Number(timestamp) * 1000).toISOString().slice(0, 10),
        close: toNumber(closes[index])
      }))
      .filter((row) => row.close !== undefined);
  } catch (error) {
    return { error: formatFetchError(error, "Yahoo chart 历史走势接口") };
  }
}

async function fetchYahooFundamentals(symbol) {
  const yahooSymbol = toYahooSymbol(symbol);
  try {
    const payload = await fetchJsonWithTimeout(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(yahooSymbol)}`
    );
    return {
      source: "yahoo-quote",
      ...(payload?.quoteResponse?.result?.[0] ?? {})
    };
  } catch (error) {
    return { source: "yahoo-quote", error: formatFetchError(error, "Yahoo quote 估值接口") };
  }
}

async function fetchFundamentalSnapshots(symbol) {
  const [yahoo, nasdaq, stockAnalysis] = await Promise.all([
    fetchYahooFundamentals(symbol),
    fetchNasdaqSummary(symbol),
    fetchStockAnalysisStatistics(symbol)
  ]);
  const merged = mergeFundamentalSnapshots([yahoo, nasdaq, stockAnalysis]);
  if (merged.sources.length === 0) {
    return {
      error: [yahoo, nasdaq, stockAnalysis]
        .map((entry) => entry?.error)
        .filter(Boolean)
        .join("；") || "估值来源均未返回可用数据"
    };
  }
  return merged;
}

async function fetchNasdaqSummary(symbol) {
  const yahooSymbol = toYahooSymbol(symbol).toLowerCase();
  try {
    const payload = await fetchJsonWithTimeout(
      `https://api.nasdaq.com/api/quote/${encodeURIComponent(yahooSymbol.toUpperCase())}/summary?assetclass=stocks`,
      {
        "accept": "application/json, text/plain, */*",
        "origin": "https://www.nasdaq.com",
        "referer": `https://www.nasdaq.com/market-activity/stocks/${encodeURIComponent(yahooSymbol)}`
      }
    );
    return normalizeNasdaqSummary(payload);
  } catch (error) {
    return { source: "nasdaq-summary", error: formatFetchError(error, "Nasdaq 摘要接口") };
  }
}

async function fetchStockAnalysisStatistics(symbol) {
  const yahooSymbol = toYahooSymbol(symbol).toLowerCase();
  try {
    const html = await fetchTextWithTimeout(`https://www.stockanalysis.com/stocks/${encodeURIComponent(yahooSymbol)}/statistics/`);
    return extractStockAnalysisStatistics(html);
  } catch (error) {
    return { source: "stockanalysis-statistics", error: formatFetchError(error, "StockAnalysis 估值页面") };
  }
}

async function fetchYahooOptionChain(symbol) {
  const failures = [];
  for (const url of buildYahooOptionChainUrls(symbol)) {
    try {
      const payload = await fetchJsonWithTimeout(url);
      return payload?.optionChain?.result?.[0] ?? {};
    } catch (error) {
      failures.push(formatFetchError(error, `Yahoo options ${url.hostname}`));
    }
  }
  return { error: failures.join("；") || "Yahoo options 期权链接口读取失败" };
}

async function fetchStockNews(symbol) {
  const [longbridgeResult, yahooResult, yahooRssResult, googleRssResult] = await Promise.allSettled([
    runLongbridgeJsonWithRetry("quote", ["news", symbol, "--count", "8"], { label: `Longbridge ${symbol} 新闻` })
      .then((payload) => normalizeNewsPayload(symbol, payload)),
    fetchYahooSearchNews(symbol, 8),
    fetchYahooRssNews(symbol, 8),
    fetchGoogleNewsRss(symbol, 8)
  ]);
  const news = [];
  const failures = [];
  if (longbridgeResult.status === "fulfilled") {
    news.push(...longbridgeResult.value);
  } else {
    failures.push(formatFetchError(longbridgeResult.reason, "Longbridge 新闻接口"));
  }
  if (yahooResult.status === "fulfilled") {
    news.push(...yahooResult.value);
  } else {
    failures.push(formatFetchError(yahooResult.reason, "Yahoo Finance 新闻接口"));
  }
  if (yahooRssResult.status === "fulfilled") {
    news.push(...yahooRssResult.value);
  } else {
    failures.push(formatFetchError(yahooRssResult.reason, "Yahoo Finance RSS"));
  }
  if (googleRssResult.status === "fulfilled") {
    news.push(...googleRssResult.value);
  } else {
    failures.push(formatFetchError(googleRssResult.reason, "Google News RSS"));
  }
  if (news.length === 0 && failures.length > 0) {
    news.push({
      id: "stock-news-error",
      symbol,
      title: `新闻读取失败：${failures.join("；")}`,
      publishedAt: new Date().toISOString(),
      publishedAtMs: Date.now(),
      source: "news-fetch",
      sourceName: "新闻读取"
    });
  }
  return mergeNewsArticles(news).slice(0, 12);
}

async function fetchYahooSearchNews(symbol, count) {
  const yahooSymbol = toYahooSymbol(symbol);
  const url = new URL("https://query2.finance.yahoo.com/v1/finance/search");
  url.searchParams.set("q", yahooSymbol);
  url.searchParams.set("quotesCount", "0");
  url.searchParams.set("newsCount", String(count));
  url.searchParams.set("enableFuzzyQuery", "false");
  const payload = await fetchJsonWithTimeout(url);
  return normalizeYahooSearchNews(symbol, payload);
}

async function fetchYahooRssNews(symbol, count) {
  const yahooSymbol = toYahooSymbol(symbol);
  const url = new URL("https://feeds.finance.yahoo.com/rss/2.0/headline");
  url.searchParams.set("s", yahooSymbol);
  url.searchParams.set("region", "US");
  url.searchParams.set("lang", "en-US");
  const xml = await fetchTextWithTimeout(url);
  return normalizeExternalRssNews(symbol, xml, {
    source: "yahoo-finance-rss",
    sourceName: "Yahoo Finance"
  }).slice(0, count);
}

async function fetchGoogleNewsRss(symbol, count) {
  const yahooSymbol = toYahooSymbol(symbol);
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", `${yahooSymbol} stock earnings valuation analyst when:14d`);
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("gl", "US");
  url.searchParams.set("ceid", "US:en");
  const xml = await fetchTextWithTimeout(url);
  return normalizeExternalRssNews(symbol, xml, {
    source: "google-news-rss",
    sourceName: "Google News"
  }).slice(0, count);
}

async function fetchJsonWithTimeout(url, extraHeaders = {}) {
  const text = await fetchTextWithTimeout(url, extraHeaders);
  return JSON.parse(text);
}

async function fetchTextWithTimeout(url, extraHeaders = {}) {
  const attempts = Math.max(1, Number(process.env.STOCK_ANALYSIS_FETCH_ATTEMPTS ?? 2));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.STOCK_ANALYSIS_FETCH_TIMEOUT_MS ?? 12000));
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/125 Safari/537.36 OpenClaw",
          "accept": "text/html,application/xhtml+xml,application/json,text/plain,*/*",
          "accept-language": "en-US,en;q=0.9",
          ...extraHeaders
        }
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(500 * attempt);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

function summarizeHistory(history, currentPrice) {
  if (!Array.isArray(history) || history.length === 0) {
    return {
      summary: history?.error ? `历史走势读取失败：${history.error}` : "历史走势暂无可用数据。",
      cheapness: "180 日均线不可用，便宜程度暂记为待验证",
      trendScore: 0,
      support: undefined,
      resistance: undefined,
      ma20: undefined,
      ma60: undefined,
      ma180: undefined
    };
  }

  const closes = history.map((row) => row.close).filter((value) => Number.isFinite(value));
  const first = closes[0];
  const lastClose = currentPrice ?? closes.at(-1);
  const sixMonthReturn = first && lastClose ? ((lastClose - first) / first) * 100 : undefined;
  const ma20 = average(closes.slice(-20));
  const ma60 = average(closes.slice(-60));
  const ma180 = average(closes.slice(-180));
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
      ? "180 日均线不可用，便宜程度待验证"
      : vsMa180 < -5
        ? `现价低于 180 日均线 ${formatPercent(Math.abs(vsMa180))}，按群聊口径偏便宜但需排除基本面恶化`
        : `现价相对 180 日均线 ${formatPercent(vsMa180)}，不属于明显均线折价`,
    trendScore,
    support,
    resistance,
    ma20,
    ma60,
    ma180
  };
}

function average(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : undefined;
}

function toYahooSymbol(symbol) {
  return String(symbol ?? "").toUpperCase().replace(/\.US$/u, "");
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

function formatFetchError(error, label) {
  const message = String(error?.message ?? error);
  if (/401|unauthorized/iu.test(message)) {
    return `${label}返回 401，当前维度待验证`;
  }
  if (/404|not found/iu.test(message)) {
    return `${label}未找到数据，当前维度待验证`;
  }
  if (/429|too many requests/iu.test(message)) {
    return `${label}触发限流，当前维度待验证`;
  }
  if (/abort|timeout/iu.test(message)) {
    return `${label}超时，当前维度待验证`;
  }
  return `${label}读取失败：${message.slice(0, 120)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextUsMonthlyOptionExpiry(date) {
  const cursor = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  for (let monthOffset = 0; monthOffset < 18; monthOffset += 1) {
    const candidate = thirdFridayUtc(cursor.getUTCFullYear(), cursor.getUTCMonth());
    if (candidate.getTime() >= date.getTime()) {
      return candidate.toISOString().slice(0, 10);
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
  }
  return "待确认";
}

function thirdFridayUtc(year, monthIndex) {
  const date = new Date(Date.UTC(year, monthIndex, 1));
  const day = date.getUTCDay();
  const firstFriday = 1 + ((5 - day + 7) % 7);
  date.setUTCDate(firstFriday + 14);
  return date;
}
