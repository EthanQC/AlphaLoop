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
import { getMemberById, LEGACY_SHARED_OWNER } from "./market-alerts-store.mjs";
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
import { buildStockFacts, persistStockFacts } from "./report-facts.mjs";
import { parseConclusionBox, renderConclusionBox } from "./conclusion-box.mjs";
import { buildYahooOptionChainUrls } from "./stock-analysis-sources.mjs";
import { writeMarkdownPdf } from "./report-rendering.mjs";
import {
  extractStockAnalysisStatistics,
  mergeFundamentalSnapshots,
  normalizeNasdaqSummary,
  summarizeHistory,
  summarizeOptionChainStats,
  summarizeUpsidePotential,
  summarizeValuation
} from "./stock-analysis-metrics.mjs";
import { loadStockAnalysisTemplate } from "./stock-analysis-template.mjs";
import { shouldRunStockAnalysis } from "./trading-schedule.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
loadLocalEnv(repoRoot);

const runtimeDir = join(repoRoot, "runtime");
const defaultDbPath = join(runtimeDir, "trading.sqlite");
const reportsDir = join(repoRoot, "reports", "stock-analysis");
const statePath = join(runtimeDir, "stock-analysis-state.json");
mkdirSync(runtimeDir, { recursive: true });
mkdirSync(reportsDir, { recursive: true });

// Task H4 (phase2.5 hardening): schema v7 (task H3) rebuilt
// stock_analysis_targets with a composite PK (symbol, owner_id) so each
// member maintains their own pool - capped at 20 symbols per the spec.
// setTargets() fully REPLACES the calling owner's active set in one call (it
// always has - see the soft-delete-then-reinsert transaction below), so the
// cap applies directly to the size of the submitted list.
const MAX_TARGETS_PER_OWNER = 20;

// ---------------------------------------------------------------------------
// CLI entry point. Guarded by isMainModule (bottom of file) so importing
// this module - e.g. market-alerts-seam.test.ts's writer/reader seam test -
// never opens the real runtime db or dispatches a command as a side effect
// of `import`. Every db-touching function below takes `db` explicitly instead
// of closing over a module-level connection, mirroring market-alerts.mjs /
// market-alerts-poll.mjs's existing testable-CLI pattern.
// ---------------------------------------------------------------------------

function parseTargetsArgs(argv) {
  let owner;
  const symbols = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--owner") {
      owner = argv[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`未知参数：${token}。`);
    }
    symbols.push(token);
  }
  return { owner, symbols };
}

// Follows market-alerts.mjs's --actor validation pattern (runAdd): the
// caller must be a real, active member - not just any string - before any
// write happens. The read-only sentinel is rejected explicitly first (it's
// never a `members` row, so it would fail this check anyway, but a named
// error is clearer than "not a valid active member" for what is actually a
// "this pool is shared and read-only" situation).
function assertActiveOwner(db, ownerId) {
  if (ownerId === LEGACY_SHARED_OWNER) {
    throw new Error(`${LEGACY_SHARED_OWNER} 是只读共享池标识，不能作为 --owner 使用，请使用真实成员 id。`);
  }
  const member = getMemberById(db, ownerId);
  if (!member || member.status !== "active") {
    throw new Error(`owner ${ownerId} 不是有效的在职成员，无法设置个股分析标的池。`);
  }
}

// Owner-scoped: only this owner's active rows are soft-deleted (active=0)
// before the submitted list is (re)inserted as active - a full replace of
// THIS owner's pool, never touching another owner's rows or the legacy
// shared-pool sentinel's rows (guarded below; also independently rejected by
// assertActiveOwner above, since callers are expected to go through
// runTargetsCommand - this is belt-and-suspenders for any future direct
// caller of setTargets itself, per this task's invariant-push-down theme).
export function setTargets(db, ownerId, symbols) {
  if (ownerId === LEGACY_SHARED_OWNER) {
    throw new Error(`${LEGACY_SHARED_OWNER} 是只读共享池，setTargets 不能写入或软删除它的行。`);
  }

  const normalized = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))];
  if (normalized.length === 0) {
    throw new Error("请至少提供一个美股标的，例如：stock-analysis.mjs targets --owner member_1 AAPL MSFT NVDA。");
  }
  if (normalized.length > MAX_TARGETS_PER_OWNER) {
    throw new Error(`每位成员最多设置 ${MAX_TARGETS_PER_OWNER} 个标的，本次提交了 ${normalized.length} 个。`);
  }

  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    db.prepare("UPDATE stock_analysis_targets SET active = 0, updated_at = ? WHERE owner_id = ? AND active = 1").run(now, ownerId);
    const insert = db.prepare(`
      INSERT INTO stock_analysis_targets (symbol, owner_id, active, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(symbol, owner_id) DO UPDATE SET active = 1, updated_at = excluded.updated_at
    `);
    for (const symbol of normalized) {
      insert.run(symbol, ownerId, now, now);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return normalized;
}

// `targets --owner <id> SYMBOL...` is REQUIRED to go through here (not
// setTargets directly) so the active-member check always runs first. Opens
// and closes its own db connection - testable in isolation, and matches
// market-alerts.mjs's runAdd/withDb pattern.
export function runTargetsCommand(argv, options = {}) {
  const { owner, symbols } = parseTargetsArgs(argv);
  const ownerId = String(owner ?? "").trim();
  if (!ownerId) {
    throw new Error("缺少 --owner 参数，请指定成员 id，例如：stock-analysis.mjs targets --owner member_1 AAPL MSFT NVDA。");
  }
  const db = openTradingDatabase(options.dbPath ?? defaultDbPath);
  try {
    assertActiveOwner(db, ownerId);
    const saved = setTargets(db, ownerId, symbols);
    return { ownerId, saved };
  } finally {
    db.close();
  }
}

export function runListTargetsCommand(options = {}) {
  const db = openTradingDatabase(options.dbPath ?? defaultDbPath);
  try {
    return listTargets(db);
  } finally {
    db.close();
  }
}

async function runScheduled(db, force = false) {
  const state = readState();
  const targets = listTargets(db);
  if (targets.length === 0) {
    console.log(JSON.stringify({ skipped: true, reason: "no_targets", lastRunAt: state.lastRunAt ?? null }, null, 2));
    return;
  }
  const cronTriggered = process.env.OPENCLAW_CRON_TRIGGERED === "1";
  if (!force && !shouldRunStockAnalysis(new Date(), state.lastRunAt, { cronTriggered })) {
    console.log(JSON.stringify({ skipped: true, reason: "not_due", lastRunAt: state.lastRunAt ?? null }, null, 2));
    return;
  }
  await runAnalysis(db, { force });
}

async function runAnalysis(db, { deliver = true, targetsOverride = null } = {}) {
  const targets = Array.isArray(targetsOverride) && targetsOverride.length
    ? [...new Set(targetsOverride.map(normalizeSymbol).filter(Boolean))]
    : listTargets(db);
  if (targets.length === 0) {
    throw new Error("没有已启用的个股分析标的。先运行：stock-analysis.mjs targets --owner <id> AAPL MSFT。");
  }

  const generatedAt = new Date().toISOString();
  const label = generatedAt.slice(0, 10);
  const { records, failedSymbols } = await fetchStockAnalysisRecords(targets, { generatedAt });
  if (records.length === 0) {
    throw new Error(
      `全部标的数据获取失败，无法生成个股分析报告：${failedSymbols.map((entry) => `${entry.symbol}（${entry.error}）`).join("；")}`
    );
  }

  // Phase 5 Task 1 (2026-07-15 plan): build + persist this trading day's
  // per-symbol stock_facts BEFORE rendering, mirroring scheduled-report.mjs's
  // daily_facts ordering (report-facts.mjs's buildDailyFacts/persistDailyFacts,
  // see its own "build + persist before render" comment) - a later quality
  // gate (facts.numeric_match, Task 4) needs an independently-computed
  // ground truth already sitting in stock_facts by the time anything
  // downstream inspects the rendered narrative. `records` only ever holds
  // symbols fetchStockAnalysisRecords successfully fetched (see Task H7's
  // per-symbol isolation above) - a failedSymbols entry never reaches here,
  // so it correctly gets no facts row instead of a fabricated/stale one.
  persistStockFactsForRecords(db, label, records);

  const markdown = renderBatchStockAnalysis({ label, generatedAt, records, failedSymbols });
  assertStockAnalysisQuality(markdown);
  const markdownPath = join(reportsDir, `${label}.md`);
  const pdfPath = join(reportsDir, `${label}.pdf`);
  writeFileSync(markdownPath, `${markdown}\n`, "utf8");

  // Phase 5 Task 2 (2026-07-15 plan): predictions are written "生成时" (at
  // generation time), same as persistStockFactsForRecords above - not gated
  // behind `deliver`, so a `prepare` dry-run and a delivered `run` behave
  // identically here (matching this file's pre-existing, Task 5-deferred
  // fact that `prepare` writes to the very same markdownPath a `run` would).
  persistPredictionsForRecords(db, markdownPath, markdown, records);

  await writeMarkdownPdf({ repoRoot, runtimeDir, markdownPath, pdfPath, markdown });

  const deliveredSymbols = records.map((record) => record.symbol);
  if (!deliver) {
    console.log(JSON.stringify({ prepared: true, delivered: false, symbols: deliveredSymbols, failedSymbols, markdownPath, pdfPath }, null, 2));
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
  `).run(runId, generatedAt, JSON.stringify(deliveredSymbols), markdownPath, pdfPath, JSON.stringify(delivery));

  writeState({ lastRunAt: generatedAt, lastRunId: runId, symbols: deliveredSymbols });
  console.log(JSON.stringify({ delivered: true, runId, symbols: deliveredSymbols, failedSymbols, markdownPath, pdfPath }, null, 2));
}

// Task H7 (2026-07-14 legacy audit): one bad target (delisted/suspended
// symbol, a typo `normalizeSymbol` happily turns into a bogus ticker, a
// transient Longbridge quote failure) used to kill the ENTIRE batch with no
// try/catch anywhere in this loop - every OTHER healthy symbol in the same
// run also got no report, no delivery, and no state update, repeating every
// scheduled trigger until a human edited the shared target list. Every
// OTHER data source in fetchStockAnalysisRecord already degrades per-symbol
// to an {error} object (history/fundamentals/options/news) - only the quote
// fetch was fatal. Isolating it here means a bad symbol is disclosed in the
// rendered output (see renderBatchStockAnalysis's failedSymbols handling)
// instead of silently taking down every other target's analysis.
export async function fetchStockAnalysisRecords(targets, { fetchRecord = fetchStockAnalysisRecord, generatedAt } = {}) {
  const records = [];
  const failedSymbols = [];
  for (const symbol of targets) {
    try {
      records.push(await fetchRecord(symbol, generatedAt));
    } catch (error) {
      failedSymbols.push({ symbol, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { records, failedSymbols };
}

// Phase 5 Task 1 (2026-07-15 plan): builds and persists stock_facts for each
// SUCCESSFULLY fetched record (never for a failedSymbols entry - those never
// appear in `records` in the first place, per fetchStockAnalysisRecords'
// per-symbol isolation above). Exported and kept as a standalone,
// dependency-injectable-free function (only db + plain data in, no network)
// so it is directly unit-testable without exercising runAnalysis's heavier
// network/PDF/delivery side effects - mirrors this file's existing pattern
// of testing fetchStockAnalysisRecords/renderBatchStockAnalysis in isolation
// rather than the CLI-facing runAnalysis orchestrator itself.
export function persistStockFactsForRecords(db, tradingDay, records) {
  for (const record of records) {
    const facts = buildStockFacts({
      symbol: record.symbol,
      quote: record.quote,
      history: record.history,
      fundamentals: record.fundamentals,
      optionChain: record.optionChain,
      news: record.news,
      tradingDay
    });
    persistStockFacts(db, tradingDay, record.symbol, facts);
  }
}

async function fetchStockAnalysisRecord(symbol, generatedAt) {
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
    analysis: buildDeterministicAnalysis(symbol, quote, news, { history, fundamentals, optionChain }, generatedAt)
  };
}

// Phase 5 Task 2 (2026-07-15 plan): writes one analysis_predictions row per
// record by re-parsing THIS RUN'S OWN rendered markdown (not the pre-render
// param object buildDeterministicAnalysis assembled) through
// conclusion-box.mjs's parseConclusionBox - the exact same parser Task 4's
// stock.conclusion_box gate and Task 5's platform summary card also use, so
// what gets persisted is guaranteed to match what a reader of the delivered
// report actually sees, never a theoretically-different pre-render value.
//
// Idempotent by report_path: a same-day re-run (`prepare`/`run` against the
// same label, hence the same markdownPath) deletes this path's
// previously-written rows first, rather than accumulating duplicates or
// leaving stale rows behind from an earlier, now-superseded render of the
// same report - mirrors setTargets'/replaceStockFacts' "delete scoped rows,
// then insert fresh" transaction shape elsewhere in this codebase.
//
// A record whose OWN box fails to parse is simply skipped (no row written)
// rather than aborting the whole batch's persistence - this run's own
// deterministic renderer always emits a well-formed box, so this should not
// happen in practice; Task 4's stock.conclusion_box gate is the hard
// fail-loud backstop that keeps a genuinely malformed report from ever
// reaching delivery in the first place.
export function persistPredictionsForRecords(db, reportPath, markdown, records) {
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    db.prepare(`DELETE FROM analysis_predictions WHERE report_path = ?`).run(reportPath);
    const insert = db.prepare(`
      INSERT INTO analysis_predictions (id, symbol, report_path, conclusion, confidence, review_trigger, review_date, outcome, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `);
    for (const record of records) {
      const section = extractSymbolMarkdownSection(markdown, record.symbol);
      const box = parseConclusionBox(section);
      if (!box) {
        continue;
      }
      insert.run(createId("analysis_prediction"), record.symbol, reportPath, box.coreConclusion, box.confidence, box.reviewTrigger, box.reviewDate, now);
    }
    db.exec("COMMIT");
  } catch (error) {
    // Same "the real error, not the rollback's" rationale as
    // stock-facts-store.mjs's replaceStockFacts.
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore: best-effort only.
    }
    throw error;
  }
}

// Slices the full rendered batch markdown down to just ONE symbol's own
// `## SYMBOL` section (up to the next level-2 heading, or end of the
// document) - parseConclusionBox must only ever see ONE box, and a full
// multi-symbol document can contain several.
function extractSymbolMarkdownSection(markdown, symbol) {
  const heading = `## ${symbol}\n`;
  const startIndex = markdown.indexOf(heading);
  if (startIndex === -1) {
    return "";
  }
  const afterHeading = markdown.slice(startIndex + heading.length);
  const nextHeadingMatch = afterHeading.match(/\n##\s+/u);
  return nextHeadingMatch ? afterHeading.slice(0, nextHeadingMatch.index) : afterHeading;
}

// Phase 5 Task 2 (2026-07-15 plan): exported (was previously module-local)
// so this pure, network-free function can be exercised directly with
// controlled quote/history/fundamentals/optionChain/news fixtures - the same
// "test the exported piece, not the CLI/network orchestrator" convention
// this file already follows for fetchStockAnalysisRecords/
// renderBatchStockAnalysis/persistStockFactsForRecords. `generatedAt`
// defaults to "now" so every pre-existing call shape (and every existing
// test that constructs a record's `analysis` by hand) keeps working
// unchanged; only fetchStockAnalysisRecord/runAnalysis thread the real
// batch-wide generatedAt through.
export function buildDeterministicAnalysis(symbol, quote, news, extraData = {}, generatedAt = new Date().toISOString()) {
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

  const conclusionBoxParams = buildConclusionBoxParams({
    symbol,
    quote,
    news,
    extraData,
    last,
    historyStats,
    upsidePotential,
    support,
    resistance,
    bullishProbability,
    neutralProbability,
    bearishProbability,
    generatedAt
  });
  const conclusionBoxMarkdown = renderConclusionBox(conclusionBoxParams);

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
      `均线：20 日 ${formatNumber(historyStats.ma20)}；60 日 ${formatNumber(historyStats.ma60)}；${historyStats.longWindowDays ?? "180"} 日 ${formatNumber(historyStats.ma180)}。`,
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
    ],
    // Not rendered as a bullet-per-line array like the sections above -
    // renderBatchStockAnalysis embeds conclusionBoxMarkdown verbatim inside
    // the "结论与复盘标签" section, after the conclusion[] bullets (see its
    // own comment). conclusionBox (the pre-render params) is kept alongside
    // purely for direct test assertions (e.g. confidence branch fixtures)
    // without needing to re-parse the rendered markdown.
    conclusionBox: conclusionBoxParams,
    conclusionBoxMarkdown
  };
}

// Phase 5 Task 2 (2026-07-15 plan): confidence heuristic - deterministic and
// documented, per the plan's "确定性规则，文档化" requirement (no LLM/narrative
// involvement - Task 3 is the separate, later, LLM-backed narrative layer).
//
// Coverage counts how many of 8 representative stock_facts keys (one
// checkpoint per quote/valuation/history/options/news data domain) come
// back with a real (non-null) value from buildStockFacts - the SAME
// extraction report-facts.mjs's buildStockFacts already performs for
// persistence (Task 1) and Task 4's stock.facts_coverage gate will also
// inspect, so "covered" can never mean two different things across this
// heuristic and that later gate:
//   quote.last, quote.pct, valuation.pe, valuation.targetPrice,
//   history.ma20, history.ma60, options.callOi, news.count
// A checkpoint's valueNum is null exactly when buildStockFacts already
// disclosed that domain as degraded/unavailable (its own "数据不可得"
// convention) - so "coverage >= 6 of 8" and "at least 6 non-degraded
// checkpoints" are the same condition here, not two separate ones.
const CONFIDENCE_COVERAGE_CHECKPOINTS = [
  "quote.last", "quote.pct", "valuation.pe", "valuation.targetPrice",
  "history.ma20", "history.ma60", "options.callOi", "news.count"
];
const CONFIDENCE_COVERAGE_THRESHOLD = 6;

function computeFactsCoverage({ symbol, quote, news, extraData, generatedAt }) {
  const facts = buildStockFacts({
    symbol,
    quote,
    history: extraData.history,
    fundamentals: extraData.fundamentals,
    optionChain: extraData.optionChain,
    news,
    tradingDay: String(generatedAt).slice(0, 10)
  });
  const byKey = Object.fromEntries(facts.map((fact) => [fact.factKey, fact]));
  return CONFIDENCE_COVERAGE_CHECKPOINTS.filter((key) => byKey[key]?.valueNum !== null && byKey[key]?.valueNum !== undefined).length;
}

// "加上行/趋势信号一致→high": the valuation-driven upside label
// (summarizeUpsidePotential's "偏强"/"中性偏强"/"中性"/"偏弱") and the
// technical trend score (summarizeHistory's trendScore, positive = price
// above its short/medium moving averages) must point the SAME direction -
// both bullish, or both bearish - for the extra "high" tier; a neutral
// upside label, or a bullish/bearish label pointing opposite the trend
// score, is treated as "not consistent" and stays at medium.
function upsideAndTrendConsistent(upsidePotentialText, trendScore) {
  const label = upsidePotentialText.match(/综合上行潜力：([^；]+)；/u)?.[1] ?? "";
  const upsideBullish = label.includes("偏强");
  const upsideBearish = label === "偏弱";
  const trendBullish = trendScore > 0;
  const trendBearish = trendScore < 0;
  return (upsideBullish && trendBullish) || (upsideBearish && trendBearish);
}

function computeConfidence({ symbol, quote, news, extraData, generatedAt, historyStats, upsidePotential }) {
  const coverage = computeFactsCoverage({ symbol, quote, news, extraData, generatedAt });
  if (coverage < CONFIDENCE_COVERAGE_THRESHOLD) {
    return "low";
  }
  return upsideAndTrendConsistent(upsidePotential, historyStats.trendScore) ? "high" : "medium";
}

// 合理价值区间: bounded by the same short-term support/resistance the
// existing three-path conclusion text already cites (historyStats.support/
// resistance, falling back to the day's low/high/last - see `support`/
// `resistance` in buildDeterministicAnalysis) and the sell-side one-year
// target price when available. Math.min/max (rather than "support is
// always low, target is always high") guards the case where the target
// price implies a value BELOW current support (a genuine downside call) -
// the range must stay a valid [low, high] pair regardless of which side
// the target price lands on.
function computeValueRange({ rangeSupport, rangeResistance, targetPrice, valuationSources }) {
  const candidateHigh = targetPrice !== undefined ? targetPrice : rangeResistance;
  const candidates = [rangeSupport, candidateHigh].filter((value) => Number.isFinite(value));
  if (candidates.length === 0) {
    return { low: undefined, high: undefined, basis: "近20日支撑位、阻力位与一年目标价均数据不可得" };
  }
  const low = Math.min(...candidates);
  const high = Math.max(...candidates);
  const basis = targetPrice !== undefined
    ? `近20日支撑位 ${formatNumber(rangeSupport)} 美元与卖方一年目标价 ${formatNumber(targetPrice)} 美元${valuationSources ? `（来源：${valuationSources}）` : ""}`
    : `近20日支撑位 ${formatNumber(rangeSupport)} 美元与阻力位 ${formatNumber(rangeResistance)} 美元（目标价数据不可得）`;
  return { low, high, basis };
}

function computePricePosition(last, low, high) {
  if (!Number.isFinite(last)) {
    return "现价数据不可得";
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    return `现价 ${formatNumber(last)} 美元，合理价值区间数据不可得`;
  }
  if (last < low) {
    return `现价 ${formatNumber(last)} 美元，低于合理区间下沿（${formatNumber(low)} 美元）`;
  }
  if (last > high) {
    return `现价 ${formatNumber(last)} 美元，高于合理区间上沿（${formatNumber(high)} 美元）`;
  }
  return `现价 ${formatNumber(last)} 美元，位于合理区间内（${formatNumber(low)}–${formatNumber(high)} 美元）`;
}

// 复盘触发: an invalidation-style condition anchored to the SAME support
// level the value range and three-path conclusion text use - "if price
// breaks below this level, or the fundamental/news picture reverses
// direction, the conclusion needs re-evaluating", mirroring the risks[]
// section's existing "若价格跌破支撑且成交量放大" phrasing rather than
// inventing a new vocabulary for the same idea.
function computeReviewTrigger(rangeSupport) {
  if (!Number.isFinite(rangeSupport)) {
    return "若基本面或新闻面出现方向性反转，需重新评估当前结论";
  }
  return `若价格跌破支撑位 ${formatNumber(rangeSupport)} 美元，或基本面/新闻面出现方向性反转，需重新评估当前结论`;
}

// reviewDate = generation date + 1 CALENDAR month, on the US Eastern
// calendar date (per the plan: "生成日 +1 个月（美东日历日）") - not "+30 days"
// and not the UTC calendar date, since this report analyzes US-listed
// equities. Date.UTC's month argument is 0-based, so passing the current
// month's 1-based number directly already IS "+1 month" in UTC-anchored
// arithmetic (e.g. July = 7 one-based; UTC month index 7 = August) - this
// keeps the addition a pure calendar operation, immune to any local-TZ/DST
// step, at the cost of JS Date's ordinary day-overflow normalization for
// short months (e.g. Jan 31 -> Mar 3), an accepted, documented edge case
// for a monthly review cadence.
function computeReviewDate(generatedAt) {
  const timestamp = new Date(String(generatedAt ?? "")).getTime();
  if (!Number.isFinite(timestamp)) {
    return "待确认";
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(timestamp));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const next = new Date(Date.UTC(Number(map.year), Number(map.month), Number(map.day)));
  return next.toISOString().slice(0, 10);
}

// 核心结论: picks the highest-probability of the three existing paths
// (bullish/neutral/bearish, from buildDeterministicAnalysis's own
// probability model) as the report's single headline stance, phrased with
// the same support/resistance levels the three-path conclusion[] bullets
// already cite - the box's core conclusion is a condensed pointer to that
// existing prose, never a second, independently-derived judgement.
function computeCoreConclusion({ bullishProbability, neutralProbability, bearishProbability, rangeSupport, rangeResistance }) {
  const max = Math.max(bullishProbability, neutralProbability, bearishProbability);
  if (max === bullishProbability) {
    return `短线偏上行：若守住支撑位 ${formatNumber(rangeSupport)} 美元并放量突破 ${formatNumber(rangeResistance)} 美元，上行概率约 ${formatPercent(bullishProbability)}。`;
  }
  if (max === bearishProbability) {
    return `短线偏回撤：若跌破支撑位 ${formatNumber(rangeSupport)} 美元，回撤概率约 ${formatPercent(bearishProbability)}。`;
  }
  return `短线震荡：价格围绕当前区间运行，观察概率约 ${formatPercent(neutralProbability)}。`;
}

function buildConclusionBoxParams({
  symbol,
  quote,
  news,
  extraData,
  last,
  historyStats,
  upsidePotential,
  support,
  resistance,
  bullishProbability,
  neutralProbability,
  bearishProbability,
  generatedAt
}) {
  const rangeSupport = historyStats.support ?? support;
  const rangeResistance = historyStats.resistance ?? resistance;
  const targetPrice = toNumber(extraData.fundamentals?.oneYearTarget);
  const valuationSources = Array.isArray(extraData.fundamentals?.sources) && extraData.fundamentals.sources.length
    ? extraData.fundamentals.sources.join("、")
    : undefined;

  const valueRange = computeValueRange({ rangeSupport, rangeResistance, targetPrice, valuationSources });
  const confidence = computeConfidence({ symbol, quote, news, extraData, generatedAt, historyStats, upsidePotential });

  return {
    coreConclusion: computeCoreConclusion({ bullishProbability, neutralProbability, bearishProbability, rangeSupport, rangeResistance }),
    confidence,
    valueRange,
    pricePosition: computePricePosition(last, valueRange.low, valueRange.high),
    reviewTrigger: computeReviewTrigger(rangeSupport),
    reviewDate: computeReviewDate(generatedAt)
  };
}

export function renderBatchStockAnalysis({ label, generatedAt, records, failedSymbols = [] }) {
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
    // Task H7: per-symbol isolation (see fetchStockAnalysisRecords) means a
    // batch can partially fail - disclose exactly which symbols were
    // skipped and why, instead of the previous all-or-nothing behavior
    // where a bad symbol silently took the whole report down with it.
    ...(failedSymbols.length > 0
      ? [`- 数据缺口：${failedSymbols.map((entry) => `${entry.symbol}（获取失败：${entry.error}）`).join("；")}；已跳过，仅呈现可用标的分析。`]
      : []),
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
      // Phase 5 Task 2 (2026-07-15 plan): the structured "### 结论框" block
      // is embedded INSIDE the existing, frozen "结论与复盘标签" section,
      // after its existing prose bullets - the section TITLE and the
      // bullets above are untouched (the quality-gate/template/sectionValues
      // three-way coupling this section's title is part of stays frozen);
      // the box is purely additive content within it.
      if (section.title === CONCLUSION_SECTION_TITLE && record.analysis.conclusionBoxMarkdown) {
        lines.push("", record.analysis.conclusionBoxMarkdown);
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

// Frozen contract (see stock-analysis-template.mjs/report-quality.mjs): the
// exact title string coupling this section's title/quality-gate/
// sectionValues three-way match - kept as one named constant so
// renderBatchStockAnalysis's conclusion-box embedding above and this map's
// key can never independently typo-diverge from each other.
const CONCLUSION_SECTION_TITLE = "结论与复盘标签";

function sectionValues(analysis, title) {
  const map = {
    "标的基本信息": analysis.basic,
    "投资逻辑": analysis.thesis,
    "基本面分析": analysis.fundamentals,
    "催化剂": analysis.catalysts,
    "风险点": analysis.risks,
    "市场表现与交易层面": analysis.trading,
    "期权交割与阻力支撑": analysis.options,
    [CONCLUSION_SECTION_TITLE]: analysis.conclusion
  };
  return map[title] ?? [];
}

function extractTradingLevel(line, side) {
  const pattern = side === "support"
    ? /支撑位参考：([^；]+)/u
    : /阻力位参考：(.+)。/u;
  return formatNumber(String(line ?? "").match(pattern)?.[1]);
}

// Task H4: schema v7 (task H3) rebuilt stock_analysis_targets with a
// composite PK (symbol, owner_id) - two different owners can now both have
// an active row for the same symbol. This still returns the GLOBAL set of
// distinct active symbols (used by runAnalysis/runScheduled for the single
// shared batch report - true per-member reports are P6 territory), but a
// naive `SELECT symbol WHERE active = 1` would now return the SAME symbol
// once per owner who has it active, feeding runAnalysis a duplicate and
// producing a doubled-up report section. The inner GROUP BY collapses that
// back to one row per symbol (using the most recently updated owner's
// updated_at for ordering) so a symbol shared by multiple owners' pools
// still appears exactly once here, matching this function's pre-v7 contract.
export function listTargets(db) {
  return db.prepare(`
    SELECT symbol FROM (
      SELECT symbol, MAX(updated_at) AS updated_at
      FROM stock_analysis_targets
      WHERE active = 1
      GROUP BY symbol
    )
    ORDER BY updated_at ASC, symbol ASC
  `).all().map((row) => String(row.symbol));
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

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const [command = "scheduled", ...args] = process.argv.slice(2);
  // Test/ops-only override (unset in normal operation, where it's a no-op):
  // lets a live verification run this exact binary against a disposable temp
  // db instead of the real runtime/trading.sqlite - e.g.
  // `STOCK_ANALYSIS_DB_PATH=/tmp/x.sqlite node stock-analysis.mjs targets --owner m1 NVDA`.
  const dbPath = process.env.STOCK_ANALYSIS_DB_PATH ?? defaultDbPath;

  if (command === "targets") {
    const result = runTargetsCommand(args, { dbPath });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "list-targets") {
    console.log(JSON.stringify(runListTargetsCommand({ dbPath }), null, 2));
    return;
  }

  const db = openTradingDatabase(dbPath);
  try {
    if (command === "run") {
      await runAnalysis(db, { force: args.includes("--force") });
    } else if (command === "prepare") {
      await runAnalysis(db, {
        deliver: false,
        targetsOverride: args.filter((arg) => !arg.startsWith("--"))
      });
    } else if (command === "scheduled") {
      await runScheduled(db, args.includes("--force"));
    } else {
      throw new Error("Usage: stock-analysis.mjs <targets|list-targets|prepare|run|scheduled> [SYMBOL...] [--force]");
    }
  } finally {
    db.close();
  }
}

const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  try {
    await main();
  } catch (error) {
    // Single-line JSON error envelope + non-zero exit, matching
    // market-alerts.mjs's buildCliResult contract - a control agent (or an
    // operator) reading this CLI's output must never have to parse a raw
    // Node stack trace to learn that `--owner` was missing. (Same lesson as
    // P2's live-binary check: unit tests exercise exported functions, not
    // the process entry path.)
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
