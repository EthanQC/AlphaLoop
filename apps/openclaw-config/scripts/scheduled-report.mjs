#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deliverReportToFeishu, loadLocalEnv, openTradingDatabase } from "../../../packages/shared-types/dist/index.js";
import { renderDailyRoutineChecklist } from "./daily-routine.mjs";
import { runLongbridgeJsonWithRetry } from "./_longbridge.mjs";
import { collectL1News } from "./news-sources.mjs";
import {
  renderDetailedNewsLine,
  selectDiverseNewsArticles,
  summarizeNewsSourceBreakdown
} from "./report-news.mjs";
import {
  assertOfficialPaperReportEnvironment,
  buildDegradedOfficialPaperSnapshot,
  buildDegradedQuoteSnapshot,
  buildTrackedSymbols,
  normalizeOfficialPaperSnapshot,
  normalizeQuotePayload,
  toNumber
} from "./report-data.mjs";
import { attachPriceSource, estimateMarketValue } from "./official-paper-monitor.mjs";
import { normalizeReportMacroCalendarPayload } from "./report-macro.mjs";
import { assertReportQuality } from "./report-quality.mjs";
import { writeMarkdownPdf } from "./report-rendering.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
loadLocalEnv(repoRoot);
const runtimeDir = join(repoRoot, "runtime");
const dbPath = join(runtimeDir, "trading.sqlite");
const statePath = join(runtimeDir, "report-delivery-state.json");
const timezone = process.env.TRADING_TIMEZONE ?? "Asia/Shanghai";

// Task H7 (2026-07-14 legacy audit): this CLI dispatch used to run
// UNCONDITIONALLY at module load time, parsing real `process.argv` via
// assertKind/assertAction/assertDateLabel - which made the module
// impossible to `import` for testing at all (any importer, e.g. a seam
// test that only wants the pure renderDailyReport/renderWeeklyReport/
// isPreparedReportMarkdownComplete functions, would crash on import
// because those asserts validate whatever argv the TEST RUNNER happens to
// be invoked with, not "daily"/"weekly"/etc). Guarded the same way every
// other testable CLI script in this directory already is (stock-analysis.mjs,
// market-alerts-poll.mjs, official-paper-monitor.mjs) - kind/action/
// windowInfo/reportPath/reportPdfPath are declared here (prepareReport/
// deliverReport close over them) but only ever COMPUTED inside the guard,
// exactly as before when actually run as a CLI.
let kind;
let action;
let windowInfo;
let reportPath;
let reportPdfPath;

const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  const [kindArg = "daily", actionArg = "run", dateArg] = process.argv.slice(2).filter((arg) => arg !== "--");
  kind = assertKind(kindArg);
  action = assertAction(actionArg);
  windowInfo = resolveReportWindow(kind, dateArg);
  reportPath = join(repoRoot, "reports", kind, `${windowInfo.label}.md`);
  reportPdfPath = join(repoRoot, "reports", kind, `${windowInfo.label}.pdf`);

  mkdirSync(join(repoRoot, "reports", kind), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });

  if (action === "prepare") {
    const report = await prepareReport(kind, windowInfo);
    console.log(report.path);
  } else if (action === "deliver") {
    await deliverReport(kind, windowInfo, false);
  } else {
    await prepareReport(kind, windowInfo);
    await deliverReport(kind, windowInfo, true);
  }
}

async function prepareReport(reportKind, info) {
  assertOfficialPaperReportEnvironment();
  const db = openTradingDatabase(dbPath);
  const executionRows = selectExecutionReports(db, info);
  const marketData = await fetchRequiredReportMarketData(info);

  const report = reportKind === "daily"
    ? renderDailyReport(info, {
        executionRows,
        ...marketData
      })
    : renderWeeklyReport(info, {
        executionRows,
        ...marketData
      });

  assertReportQuality(report, { kind: reportKind });
  writeFileSync(reportPath, `${report}\n`, "utf8");
  const pdfPath = await writeMarkdownPdf({ repoRoot, runtimeDir, markdownPath: reportPath, pdfPath: reportPdfPath, markdown: report });
  updateState(info, {
    preparedAt: new Date().toISOString(),
    path: reportPath,
    pdfPath,
    kind: reportKind,
    requiredDataSources: {
      officialPaperSnapshot: true,
      marketNews: true,
      macroCalendar: true,
      qqqQuote: true
    },
    sourceEvidence: marketData.sourceEvidence,
    deliveredAt: undefined,
    chunks: undefined,
    deliveries: undefined,
    pdfUploaded: undefined,
    regeneratedDuringDelivery: undefined,
    preparedInSameRun: undefined
  });

  return {
    path: reportPath,
    pdfPath,
    markdown: report
  };
}

async function deliverReport(reportKind, info, alreadyPrepared) {
  let markdown = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
  let regeneratedDuringDelivery = false;
  if (!isPreparedReportMarkdownComplete(markdown)) {
    const prepared = await prepareReport(reportKind, info);
    markdown = prepared.markdown;
    alreadyPrepared = true;
    regeneratedDuringDelivery = true;
  }

  const titlePrefix = reportKind === "daily" ? "OpenClaw 日报" : "OpenClaw 周报";
  assertReportQuality(markdown, { kind: reportKind });
  const pdfPath = existsSync(reportPdfPath)
    ? reportPdfPath
    : await writeMarkdownPdf({ repoRoot, runtimeDir, markdownPath: reportPath, pdfPath: reportPdfPath, markdown });
  const result = await deliverReportToFeishu({
    title: `${titlePrefix} ${info.label}`,
    markdown,
    markdownPath: reportPath,
    pdfPath
  });
  if (!result.sent) {
    throw new Error(result.reason ?? "Report delivery was not sent.");
  }
  const deliveries = result.deliveries.map((entry) => ({
    ...entry,
    deliveredAt: new Date().toISOString()
  }));
  const chapterMessages = deliveries.filter((entry) => entry.kind === "chapter");

  updateState(info, {
    deliveredAt: new Date().toISOString(),
    path: reportPath,
    pdfPath,
    kind: reportKind,
    chunks: chapterMessages.length,
    deliveries,
    pdfUploaded: deliveries.some((entry) => entry.kind === "file" && entry.sent),
    regeneratedDuringDelivery,
    preparedInSameRun: alreadyPrepared
  });

  console.log(JSON.stringify({
    delivered: true,
    kind: reportKind,
    label: info.label,
    chunks: chapterMessages.length,
    targets: deliveries.map((entry) => entry.target),
    fallbackUsed: deliveries.some((entry) => entry.fallback),
    pdfUploaded: deliveries.some((entry) => entry.kind === "file" && entry.sent),
    path: reportPath,
    pdfPath
  }, null, 2));
}

// Exported for the seam test (scheduled-report.test.ts): generates a real
// report from realistic fixture data and runs isPreparedReportMarkdownComplete
// against it, so the marker text and the completeness check can never
// silently diverge again (see that function's own doc comment).
export function renderDailyReport(info, data) {
  const tradeRows = data.executionRows.filter((row) => row.category === "trade");
  const dailyRows = data.executionRows.filter((row) => row.category === "daily");
  const rejectedRows = tradeRows.filter((row) => /rejected|拒绝|not allowed|disabled|未执行|不允许/iu.test(`${row.title}\n${row.body}`));

  return [
    `# OpenClaw 日报 ${info.label}`,
    "",
    `窗口：${formatWindow(info)}`,
    "",
    "- 语言：中文。",
    "- 投递：飞书摘要卡片 + PDF。",
    "",
    "## 1. 今日结论",
    "",
    ...renderCoreSummary(data, {
      period: "今日",
      tradeCount: tradeRows.length,
      adviceCount: dailyRows.length,
      rejectedCount: rejectedRows.length
    }),
    "",
    "## 2. 信息收集与分类",
    "",
    renderDataSourceSummary(data),
    "",
    renderDailyRoutineClassification(data),
    "",
    renderMarketIntelligence(data),
    "",
    "## 3. 影响路径",
    "",
    renderImpactPath(data),
    "",
    "## 4. QQQ 固定观察",
    "",
    renderQqqSection(data.qqqQuote),
    "",
    "## 5. 官方模拟盘",
    "",
    renderOfficialPaperSnapshot(data.officialPaperSnapshot),
    "",
    renderExecutionDigest(data.executionRows),
    "",
    "## 6. 风险与异常",
    "",
    "- 实盘：禁止自动提交真实资金订单。",
    "- 官方模拟盘：只使用长桥官方模拟盘，OpenClaw 最多使用总仓 10%。",
    "- 期权：不生成、不预览、不执行任何期权自动化。",
    "- 渠道：飞书只发送摘要卡片 + PDF。",
    "",
    "## 7. 明日跟踪",
    "",
    renderNextTracking(data, "明日")
  ].join("\n");
}

export function renderWeeklyReport(info, data) {
  const tradeRows = data.executionRows.filter((row) => row.category === "trade");
  const dailyRows = data.executionRows.filter((row) => row.category === "daily");

  return [
    `# OpenClaw 周报 ${info.label}`,
    "",
    `窗口：${formatWindow(info)}`,
    "",
    "- 语言：中文。",
    "- 投递：飞书摘要卡片 + PDF。",
    "",
    "## 1. 本周结论",
    "",
    ...renderCoreSummary(data, {
      period: "本周",
      tradeCount: tradeRows.length,
      adviceCount: dailyRows.length,
      rejectedCount: tradeRows.filter((row) => /rejected|拒绝|not allowed|disabled|未执行|不允许/iu.test(`${row.title}\n${row.body}`)).length
    }),
    "",
    "## 2. 市场主线回顾与分类",
    "",
    renderDataSourceSummary(data),
    "",
    renderDailyRoutineClassification(data),
    "",
    renderMarketIntelligence(data),
    "",
    "## 3. QQQ 与美股风险温度",
    "",
    renderQqqSection(data.qqqQuote),
    "",
    "## 4. 模拟盘与执行复盘",
    "",
    renderOfficialPaperSnapshot(data.officialPaperSnapshot),
    "",
    renderExecutionDigest(data.executionRows),
    "",
    "## 5. 风险与异常",
    "",
    "- 实盘：禁止自动提交真实资金订单。",
    "- 官方模拟盘：只使用长桥官方模拟盘，OpenClaw 最多使用总仓 10%。",
    "- 期权：不生成、不预览、不执行任何期权自动化。",
    "- 渠道：飞书只发送摘要卡片 + PDF。",
    "",
    "## 6. 下周跟踪",
    "",
    renderNextTracking(data, "下周")
  ].join("\n");
}

function renderCoreSummary(data, counts) {
  const officialPositions = data.officialPaperSnapshot.positions;
  const officialSummary = summarizeOfficialPositions(officialPositions);
  const accountSummary = summarizeOfficialAccount(data.officialPaperSnapshot);
  const qqqSummary = summarizeQqqMove(data.qqqQuote);
  const newsSignal = summarizeNewsSignals(data.marketNews);
  const macroSignal = summarizeMacroSignal(data.macroEvents);
  const paperBudget = summarizePaperBudget(data.officialPaperSnapshot, data.qqqQuote);
  return [
    `- 市场信号：${qqqSummary}；新闻主线：${newsSignal.summary}。`,
    `- 宏观信号：${macroSignal}。`,
    `- 模拟盘：当前持仓 ${officialSummary}；${accountSummary}；${paperBudget}。`,
    `- 操作含义：${newsSignal.action}；新增模拟盘仓位仍必须通过总仓 10% 预算检查。`,
    `- 执行边界：${counts.period}没有自动提交实盘订单；交易/执行报告 ${counts.tradeCount} 条，其中拒绝或未执行 ${counts.rejectedCount} 条；期权自动化保持禁用。`
  ];
}

function renderImpactPath(data) {
  const newsSignal = summarizeNewsSignals(data.marketNews);
  const macroSignal = summarizeMacroSignal(data.macroEvents);
  const qqqSummary = summarizeQqqMove(data.qqqQuote);
  const technologyNews = data.marketNews.find((article) => /ai|nvidia|semiconductor|chip|technology|人工智能|半导体/iu.test(article.title));
  const companyNews = data.marketNews.find((article) => /earnings|revenue|profit|guidance|shares|acquires|公司|财报|指引/iu.test(article.title));

  return [
    `- 大盘：${qqqSummary}；新闻分类为 ${newsSignal.bias}，但操作上仍按“新闻验证，不直接加仓”处理。`,
    `- 宏观：${macroSignal}；如果后续利率或制造业数据反向变化，需要重新评估成长股估值压力。`,
    `- 板块：${technologyNews ? `${newsEvent(technologyNews)}是本窗口最明确的科技线索。` : "没有读到足以单独驱动板块的高置信科技线索。"}半导体、AI、利率和美元仍是 QQQ 的主要传导变量。`,
    `- 个股：${companyNews ? `${newsEvent(companyNews)}需要进入个股模板复核。` : "没有读到足以直接触发个股模板的新公司基本面事件。"}实盘动作继续停在人工复核前。`
  ].join("\n");
}

function renderNextTracking(data, label) {
  const qqq = data.qqqQuote;
  const last = toNumber(qqq.last ?? qqq.last_done ?? qqq.lastDone);
  const high = toNumber(qqq.high);
  const low = toNumber(qqq.low);
  const post = toNumber(qqq.post_market_quote?.last);
  const nextMacro = data.macroEvents[0];
  const newsThemes = selectDiverseNewsArticles(data.marketNews, 3)
    .map((article) => newsEvent(article))
    .join("；") || "暂无高置信新闻主线";

  return [
    `- QQQ：${label}先看 ${formatOptionalNumber(low)} - ${formatOptionalNumber(high)} 区间是否被放量突破；最新价 ${formatOptionalNumber(last)}，盘后 ${formatOptionalNumber(post)}。`,
    `- 新闻：复核 ${newsThemes}；只有当新闻能落到收入、利润、指引、订单或监管约束时，才升级为个股基本面事件。`,
    `- 宏观：${nextMacro ? `${nextMacro.date} ${nextMacro.time || ""} ${nextMacro.title}` : "未来窗口没有高重要性宏观事件"}；关注是否改变利率、通胀或制造业景气预期。`,
    `- 仓位：${summarizePaperBudget(data.officialPaperSnapshot, data.qqqQuote)}；任何新增模拟盘动作仍需通过人工复核和 10% 总仓上限。`
  ].join("\n");
}

function renderDataSourceSummary(data) {
  return [
    "### 证据与来源",
    "",
    `- 数据底座：本地交易数据库、长桥官方模拟盘账户、长桥行情（QQQ 行情）、美国宏观日历、多源新闻检索；跟踪标的 ${formatTrackedSymbols(data.trackedSymbols)}。`,
    `- 新闻检索：每个标的最多读取 ${Number(process.env.REPORT_NEWS_COUNT_PER_SYMBOL ?? 5)} 条长桥新闻，并补充 Yahoo Finance 搜索、Yahoo Finance RSS 和 Google News RSS；本次共读取 ${data.marketNews.length} 条。`,
    `- 新闻来源分布：${summarizeNewsSourceBreakdown(data.marketNews)}。`,
    ...(data.longbridgeWarnings?.length ? [`- 长桥降级：${data.longbridgeWarnings.join("；")}；报告继续生成，但任何新增动作必须人工复核。`] : []),
    ...(data.newsWarnings.length ? [`- 新闻降级：${data.newsWarnings.join("；")}。`] : []),
    `- 宏观与行情：美国二星/三星宏观事件窗口从 ${data.sourceEvidence.fetchedAt.slice(0, 10)} 起向后 ${Number(process.env.REPORT_MACRO_LOOKAHEAD_DAYS ?? 14)} 天；${formatQuoteTimestamp(data.qqqQuote)}。`,
    ...(data.macroWarnings?.length ? [`- 宏观日历降级：${data.macroWarnings.join("；")}。`] : []),
    `- 审计状态：账户模式 ${translateAccountMode(data.sourceEvidence.accountMode)}；令牌 ${translateSessionStatus(data.sourceEvidence.longbridgeSessionStatus)}；可用区域 ${formatRegions(data.sourceEvidence.longbridgeOkRegions)}；账户资产 ${data.sourceEvidence.assetRows} 行；官方持仓 ${data.sourceEvidence.officialPositions} 个；宏观事件 ${data.sourceEvidence.macroEventsCount} 条。`
  ].join("\n");
}

function renderDailyRoutineCompliance() {
  return [
    "### daily-routine.md 检查清单",
    "",
    "本报告按以下信息检索与分类框架组织，若某项当天没有高置信来源，仍保留为待跟踪项：",
    "",
    renderDailyRoutineChecklist()
  ].join("\n");
}

function renderDailyRoutineClassification(data) {
  const qqqSummary = summarizeQqqMove(data.qqqQuote);
  const newsSignal = summarizeNewsSignals(data.marketNews);
  const macroSignal = summarizeMacroSignal(data.macroEvents);
  const commodityNews = data.marketNews.find((article) => /crude|oil|gold|commodity|能源|黄金|原油/iu.test(article.title));
  const currencyNews = data.marketNews.find((article) => /dollar|yuan|currency|fx|汇率|美元/iu.test(article.title));
  const technologyNews = data.marketNews.find((article) => /ai|nvidia|semiconductor|chip|technology|人工智能|半导体/iu.test(article.title));
  const companyNews = data.marketNews.find((article) => /earnings|revenue|profit|guidance|shares|acquires|公司|财报|指引/iu.test(article.title));

  return [
    "### 市场叙事与分类结论",
    "",
    `- 主线：${newsSignal.summary}；整体情绪 ${newsSignal.bias}。`,
    `- 基本面：${companyNews ? `${newsEvent(companyNews)}需要等公司公告或财报验证。` : "没有读到足以直接改变单一公司基本面的高置信更新。"}${technologyNews ? `技术线索集中在${newsEvent(technologyNews)}，主要传导到科技权重和 QQQ 情绪。` : "技术/科研突破项没有形成可审计的新证据。"}`,
    `- 宏观与资产联动：${macroSignal}；${commodityNews ? `商品线索为${newsEvent(commodityNews)}。` : "商品端没有足以进入结论的新增压力。"}${currencyNews ? ` 汇率线索为${newsEvent(currencyNews)}。` : "汇率端没有足以进入结论的新增压力。"}`,
    `- 大盘确认：${qqqSummary}；${newsSignal.action}`
  ].join("\n");
}

function renderExecutionDigest(rows) {
  if (rows.length === 0) {
    return "- 本窗口没有交易执行报告。";
  }

  const shownRows = rows.slice(-8);
  const omitted = rows.length - shownRows.length;
  const header = [
    `- 本窗口共有 ${rows.length} 条执行记录。`,
    omitted > 0
      ? `- 下方只列最近 ${shownRows.length} 条用于人工核对；更早 ${omitted} 条保留在本地数据库的执行报告表。`
      : "- 下方列出全部记录。"
  ];

  return [
    ...header,
    ...shownRows.map((row, index) => {
    const summary = summarizeExecutionRow(row);
    return [
    `### 记录 ${index + 1}：${summary.heading}`,
    "",
    `- 时间：${formatReportDateTime(row.created_at)}`,
    `- 类别：${translateReportCategory(row.category)}`,
    `- 状态：${summary.status}`,
    `- 摘要：${summary.summary}`,
    `- 审计索引：执行报告编号 ${row.id}`
    ].join("\n");
  })].join("\n\n");
}

function summarizeExecutionRow(row) {
  const text = `${row.title ?? ""}\n${row.body ?? ""}`;
  const symbol = extractSymbol(text) ?? "未标明标的";
  const side = extractSide(text);
  const quantity = extractQuantity(text);
  const price = extractPrice(text);
  const strategy = extractOptionStrategy(text);
  const facts = [`标的 ${symbol}`];

  if (side) {
    facts.push(`方向 ${side}`);
  }
  if (quantity) {
    facts.push(`数量 ${quantity}`);
  }
  if (price) {
    facts.push(`参考价格 ${price}`);
  }
  if (strategy) {
    facts.push(`检测到${translateOptionStrategy(strategy)}，期权自动化保持禁用`);
  }
  if (/token empty|401001/iu.test(text)) {
    facts.push("鉴权为空导致官方模拟盘提交失败");
  }
  if (/not valid JSON|Unexpected token/iu.test(text)) {
    facts.push("返回内容不是结构化响应，记录为解析失败");
  }
  if (/No real-money order was submitted/iu.test(text)) {
    facts.push("回查记录声明没有提交真实资金订单");
  }
  if (/Status:\s*NotReported/iu.test(text)) {
    facts.push("订单状态为未上报");
  }
  if (facts.length === 1) {
    facts.push("详细内容保存在本地数据库，中文报告不直接展开旧英文正文");
  }

  return {
    heading: side ? `${symbol} ${side}记录` : `${symbol} 记录`,
    status: classifyExecutionStatus(row, text),
    summary: `${facts.join("；")}。`
  };
}

function classifyExecutionStatus(row, text) {
  if (/Option trading is disabled|Option strategy .* not allowed|期权/iu.test(text)) {
    return "期权相关请求已拦截，未执行。";
  }
  if (/failed|API error|token empty|not valid JSON|Unexpected token/iu.test(text)) {
    return "写入或回查失败，未确认为新成交。";
  }
  if (/was found in Longbridge order list|reconciliation/iu.test(text)) {
    return "官方模拟盘回查到记录；不涉及实盘自动下单。";
  }
  if (/rejected|not allowed|disabled|未执行|不允许/iu.test(text)) {
    return "规则或风控拦截，未执行。";
  }
  if (row.category === "daily") {
    return "报告记录已入库。";
  }
  return "执行记录已入库。";
}

function extractSymbol(text) {
  const patterns = [
    /\bSymbol:\s*([A-Z]{1,5}(?:\.US)?)/iu,
    /\bfor\s+([A-Z]{1,5}(?:\.US)?)/iu,
    /\border\s+(?:buy|sell)\s+([A-Z]{1,5}(?:\.US)?)/iu,
    /\b([A-Z]{1,5}\.US)\b/u
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].toUpperCase();
    }
  }
  return null;
}

function extractSide(text) {
  const match = text.match(/\b(?:Side:\s*|order\s+)(buy|sell)\b/iu);
  if (!match?.[1]) {
    return null;
  }
  return match[1].toLowerCase() === "buy" ? "买入" : "卖出";
}

function extractQuantity(text) {
  return text.match(/\bQuantity:\s*([0-9.]+)/iu)?.[1] ?? null;
}

function extractPrice(text) {
  return text.match(/--price\s+([0-9.]+)/iu)?.[1] ?? text.match(/\bprice[:\s]+([0-9.]+)/iu)?.[1] ?? null;
}

function extractOptionStrategy(text) {
  return text.match(/\b(covered_call|cash_secured_put|long_call|long_put)\b/iu)?.[1]?.toLowerCase() ?? null;
}

function translateOptionStrategy(strategy) {
  const labels = {
    covered_call: "备兑看涨策略",
    cash_secured_put: "现金担保看跌策略",
    long_call: "买入看涨期权策略",
    long_put: "买入看跌期权策略"
  };
  return labels[strategy] ?? "期权策略";
}

function translateReportCategory(category) {
  return category === "trade" ? "交易/执行" : "报告";
}

function translateAssetClass(assetClass) {
  const labels = {
    stock: "股票",
    etf: "交易型开放式指数基金"
  };
  return labels[assetClass] ?? String(assetClass ?? "资产");
}

function translateDataSource(source) {
  const labels = {
    "longbridge-official-paper": "长桥官方模拟盘"
  };
  return labels[String(source ?? "")] ?? "已验证来源";
}

function translateAccountMode(mode) {
  const labels = {
    paper: "模拟盘",
    live: "实盘"
  };
  return labels[String(mode ?? "").toLowerCase()] ?? "未知模式";
}

function translateSessionStatus(status) {
  const labels = {
    valid: "有效",
    expired: "过期",
    unknown: "未知"
  };
  return labels[String(status ?? "").toLowerCase()] ?? String(status ?? "未知");
}

function translateRiskLevel(value) {
  const labels = {
    safe: "安全",
    normal: "正常",
    warning: "警示",
    danger: "高风险"
  };
  return labels[String(value ?? "").toLowerCase()] ?? "未知";
}

function translateCurrency(value) {
  const labels = {
    USD: "美元",
    HKD: "港元",
    CNH: "离岸人民币",
    CNY: "人民币"
  };
  const key = String(value ?? "USD").toUpperCase();
  return labels[key] ?? key;
}

function translateQuoteStatus(value) {
  const labels = {
    normal: "正常",
    halted: "停牌",
    delisted: "退市"
  };
  return labels[String(value ?? "").toLowerCase()] ?? "未知";
}

function translateMarket(value) {
  const labels = {
    US: "美国",
    HK: "香港",
    CN: "中国内地"
  };
  return labels[String(value ?? "").toUpperCase()] ?? String(value ?? "");
}

function shouldShowMarketPrefix(market, title) {
  const label = translateMarket(market);
  return Boolean(label) && !String(title ?? "").startsWith(label);
}

function translateSecurityName(symbol, name) {
  const labels = {
    "QQQ.US": "纳指 100 交易型开放式指数基金",
    AAPL: "苹果公司",
    MSFT: "微软公司"
  };
  return labels[String(symbol ?? "").toUpperCase()] ?? labels[String(name ?? "").toUpperCase()] ?? "持仓标的";
}

function formatTrackedSymbols(symbols) {
  return symbols.length ? symbols.join("、") : "未配置";
}

function formatRegions(regions) {
  const labels = {
    cn: "中国区",
    global: "全球区",
    hk: "香港区"
  };
  return Array.isArray(regions) && regions.length
    ? regions.map((region) => labels[String(region).toLowerCase()] ?? String(region)).join("、")
    : "未返回";
}

function summarizeOfficialPositions(rows) {
  if (!rows.length) {
    return "空仓";
  }
  return rows.map((row) => `${row.symbol} ${formatNumber(row.quantity, 4)} 份`).join("、");
}

function summarizeOfficialAccount(snapshot) {
  if (snapshot.degraded) {
    return `官方模拟盘读取降级：${snapshot.degradedReason ?? "原因未返回"}；本报告不据此提出新增仓位`;
  }
  const asset = snapshot.primaryAsset ?? {};
  const netAssets = formatOptionalNumber(toNumber(asset.net_assets ?? asset.netAssets));
  const cash = formatOptionalNumber(toNumber(asset.total_cash ?? asset.totalCash));
  const risk = translateRiskLevel(asset.risk_level ?? asset.riskLevel);
  return `净资产 ${netAssets} ${translateCurrency(asset.currency)}，现金 ${cash}，风险等级 ${risk}`;
}

function summarizeQqqMove(quote) {
  const last = toNumber(quote.last ?? quote.last_done ?? quote.lastDone);
  const prevClose = toNumber(quote.prev_close ?? quote.prevClose);
  if (last === undefined || prevClose === undefined || prevClose === 0) {
    return "QQQ 行情可读取，但缺少涨跌幅字段";
  }
  const change = last - prevClose;
  const direction = change > 0 ? "上涨" : change < 0 ? "下跌" : "持平";
  return `QQQ 最新价 ${formatNumber(last)}，较前收${direction} ${formatNumber(Math.abs(change))}（${formatPercent(Math.abs(change) / prevClose)}）`;
}

function renderChineseNewsLine(article) {
  const classification = classifyMarketNews(article);
  const line = compactReportNewsLink(renderDetailedNewsLine(article, formatReportDateTime));
  const linkSeparator = line.lastIndexOf("；链接：");
  const sourceSeparator = line.lastIndexOf("；来源索引：");
  const separator = Math.max(linkSeparator, sourceSeparator);
  const extra = `；分类：${classification.bias}；基本面：${classification.fundamentalImpact}`;
  if (separator === -1) {
    return line.replace(/。$/u, `${extra}。`);
  }
  return `${line.slice(0, separator)}${extra}${line.slice(separator)}`;
}

function compactReportNewsLink(line) {
  return String(line ?? "").replace(/链接：(https?:\/\/\S+?)(?=。$|；)/gu, "链接：[原文]($1)");
}

function summarizeMarketNewsTitle(title) {
  const text = String(title ?? "");
  if (/trade representative|ustr|tariff|trade policy/iu.test(text)) {
    return {
      event: "美国贸易政策或关税相关消息更新",
      impact: "关注贸易政策变化对科技股估值和纳指风险偏好的影响"
    };
  }
  if (/wall street extends rally|tech strength|tech leaps|technology/iu.test(text)) {
    return {
      event: "美股在科技板块带动下延续上涨",
      impact: "对 QQQ 偏正面，但需防止短线追高"
    };
  }
  if (/week ahead|monday|what to watch/iu.test(text)) {
    return {
      event: "下周市场前瞻更新",
      impact: "关注周一开盘、宏观数据和科技股消息对 QQQ 的影响"
    };
  }
  if (/global markets|crude|iran|truce|middle east/iu.test(text)) {
    return {
      event: "全球市场和地缘风险预期变化",
      impact: "若避险需求下降，成长股风险偏好可能改善；若反复则波动上升"
    };
  }
  if (/stock market indicator|warning|buffett|2007/iu.test(text)) {
    return {
      event: "市场风险指标出现警示信号",
      impact: "提示不要只看短线上涨，需同时关注回撤和仓位上限"
    };
  }
  if (/nvidia|huang|ai|artificial intelligence/iu.test(text)) {
    return {
      event: "人工智能和英伟达增长预期相关消息",
      impact: "对纳指和 QQQ 的科技权重股情绪有直接影响"
    };
  }
  if (/micron|semiconductor|chip|\bmu\b/iu.test(text)) {
    return {
      event: "半导体板块相关消息",
      impact: "可能影响纳指科技链条情绪，需观察是否扩散到 QQQ"
    };
  }
  if (/linde|nasdaq|underperform/iu.test(text)) {
    return {
      event: "个股相对纳指表现偏弱的讨论",
      impact: "作为市场宽度参考，暂不直接改变 QQQ 持仓判断"
    };
  }
  if (/hedge|shorted|crash/iu.test(text)) {
    return {
      event: "市场风险对冲和高空头股票反弹相关消息",
      impact: "说明风险偏好回升，但也可能放大短期波动"
    };
  }
  if (/market|stocks|wall street|nasdaq|qqq/iu.test(text)) {
    return {
      event: "美股市场走势相关消息",
      impact: "作为 QQQ 趋势和风险偏好的辅助证据"
    };
  }
  if (/earnings|revenue|profit|guidance/iu.test(text)) {
    return {
      event: "公司业绩或指引相关消息",
      impact: "关注是否影响科技股盈利预期"
    };
  }
  if (/[\u3400-\u9fff]/u.test(text)) {
    return {
      event: singleLine(text, 120),
      impact: "媒体、渠道和链接已列在新闻明细中；先作为可核对线索，不单独触发加仓"
    };
  }
  return {
    event: "多源检索返回的一般市场新闻",
    impact: "媒体、渠道和链接已列在新闻明细中；先作为可核对线索，不单独触发加仓"
  };
}

function summarizeNewsSignals(articles) {
  const classified = articles.map(classifyMarketNews);
  const positive = classified.filter((item) => item.bias === "利好").length;
  const negative = classified.filter((item) => item.bias === "利空").length;
  const watch = classified.length - positive - negative;
  const concreteThemes = classified
    .filter((item) => !/一般市场新闻/u.test(item.event))
    .slice(0, 3)
    .map((item) => item.event);
  const topThemes = (concreteThemes.length ? concreteThemes : classified.slice(0, 3).map((item) => item.event)).join("；") || "暂无可用新闻主线";
  const bias = positive > negative
    ? "中性偏多"
    : negative > positive
      ? "中性偏谨慎"
      : "中性，等待更多确认";
  const action = negative > positive
    ? "不追高，优先观察风险事件是否扩散"
    : positive > negative
      ? "可以继续观察强势延续，但不因单日新闻直接加仓"
      : "保持轻仓观察，把新闻作为验证项而不是交易触发器";
  return {
    summary: `${topThemes}；分类 ${positive} 条偏利好、${negative} 条偏利空、${watch} 条待验证`,
    bias,
    action
  };
}

function summarizeMacroSignal(entries) {
  if (entries.length === 0) {
    return "未来窗口没有返回二星/三星美国宏观事件，宏观项暂不提供新增交易触发";
  }
  const next = entries[0];
  const values = next.values
    .filter((item) => item.key && item.value)
    .slice(0, 3)
    .map((item) => `${item.key}${item.value}`)
    .join(" / ");
  return `${next.date} ${next.time || ""} ${next.title}${values ? `（${values}）` : ""}；关注是否改变利率、通胀或制造业景气预期`;
}

// Task H7 (2026-07-14 legacy audit): this used to read `snapshot.quotes`,
// a field NO producer of officialPaperSnapshot (normalizeOfficialPaperSnapshot/
// buildDegradedOfficialPaperSnapshot in report-data.mjs) ever sets - the
// lookup was always undefined, so every non-QQQ position silently fell back
// to its cost basis (or 0 when cost_price was missing), understating or
// zeroing real exposure in the "今日结论"/"明日跟踪" budget line. Fix: reuse
// H4's attachPriceSource/estimateMarketValue (official-paper-monitor.mjs) -
// the same position.price/priceSource-aware valuation already used for the
// trusted official_paper_snapshots table - instead of a second, dead
// hand-rolled computation. The only live quote this pipeline fetches is
// QQQ.US, so non-QQQ positions still price at cost when that's all that's
// available, but it is now EXPLICIT (priceSource: 'cost'/'zero') and
// disclosed in the rendered line, rather than a silently-wrong number
// presented as ground truth.
export function summarizePaperBudget(snapshot, qqqQuote) {
  const asset = snapshot.primaryAsset ?? {};
  const netAssets = toNumber(asset.net_assets ?? asset.netAssets) ?? 0;
  const quotes = qqqQuote ? [qqqQuote] : [];
  const { positions: pricedPositions, degradedSymbols } = attachPriceSource(snapshot.positions, quotes);
  const marketValue = estimateMarketValue({ positions: pricedPositions });
  if (netAssets <= 0) {
    return "无法计算模拟盘暴露比例";
  }
  const exposure = marketValue / netAssets * 100;
  const remaining = Math.max(0, netAssets * 0.1 - marketValue);
  const degradedNote = degradedSymbols.length > 0
    ? `（${degradedSymbols.join("、")}未取得实时行情，按估算价计入，非真实市价）`
    : "";
  return `模拟盘暴露 ${exposure.toFixed(2)}%，剩余自由发挥预算约 ${formatNumber(remaining)} 美元${degradedNote}`;
}

function classifyMarketNews(article) {
  const summary = summarizeMarketNewsTitle(article.titleZh ?? article.title);
  const text = `${article.title ?? ""} ${article.titleZh ?? ""} ${summary.event} ${summary.impact}`;
  let bias = "待验证";
  if (/rally|strength|leaps|growth|truce|improve|上行|上涨|改善|正面|增长|缓和/iu.test(text)) {
    bias = "利好";
  }
  if (/warning|tariff|crude|iran|crash|underperform|risk event|geopolitical risk|下跌|警示|关税|风险事件|地缘风险|偏弱/iu.test(text)) {
    bias = bias === "利好" ? "待验证" : "利空";
  }
  const fundamentalImpact = /earnings|revenue|profit|guidance|ai|semiconductor|chip|财报|营收|利润|指引|人工智能|半导体/iu.test(text)
    ? "可能影响基本面，需原始公告确认"
    : "更多影响情绪/风险偏好，暂不视为基本面变化";
  return {
    ...summary,
    bias,
    fundamentalImpact,
    article
  };
}

function newsEvent(article) {
  return article.titleZh ?? summarizeMarketNewsTitle(article.title).event;
}

function renderClassifiedNewsLine(article) {
  const item = classifyMarketNews(article);
  return `- ${formatReportDateTime(article.publishedAt)} ${article.symbol}：${newsEvent(article)}；媒体：${article.publisher ?? article.sourceName ?? article.source}；分类：${item.bias}；基本面：${item.fundamentalImpact}；影响：${item.impact}。`;
}

function renderMarketIntelligence(data) {
  const newsLines = data.marketNews.length > 0
    ? selectDiverseNewsArticles(data.marketNews, 8).map(renderChineseNewsLine)
    : ["- 本窗口没有抓取到可用新闻；报告生成会在所有新闻来源同时为空时直接报错。"];

  const macroLines = data.macroEvents.length > 0
    ? data.macroEvents.slice(0, 8).map((entry) => {
        const values = entry.values
          .filter((item) => item.key && item.value)
          .slice(0, 3)
          .map((item) => `${item.key}${item.value}`)
          .join(" / ");
        const market = shouldShowMarketPrefix(entry.market, entry.title) ? `${translateMarket(entry.market)} ` : "";
        return `- ${entry.date} ${entry.time || ""} ${market}${entry.title}${values ? `（${values}）` : ""}`;
      })
    : ["- 未来宏观日历没有返回高重要性事件。"];

  return [
    "### 多源新闻（中文摘要与来源）",
    "",
    ...newsLines,
    "",
    "### 宏观日历",
    "",
    ...macroLines
  ].join("\n");
}

function renderOfficialPaperSnapshot(snapshot) {
  if (snapshot.degraded) {
    return [
      `- 来源：${translateDataSource(snapshot.source)}；账户模式：${translateAccountMode(snapshot.accountMode)}；抓取时间：${formatReportDateTime(snapshot.fetchedAt)}`,
      `- 状态：读取降级；原因：${snapshot.degradedReason ?? "原因未返回"}`,
      "- 净资产/现金/购买力：本次不可用，禁止据此扩大模拟盘仓位。",
      "- 当前长桥官方模拟盘持仓：本次不可核验；以最近成功报告和人工复核为准。"
    ].join("\n");
  }
  const asset = snapshot.primaryAsset ?? {};
  const header = [
    `- 来源：${translateDataSource(snapshot.source)}；账户模式：${translateAccountMode(snapshot.accountMode)}；抓取时间：${formatReportDateTime(snapshot.fetchedAt)}`,
    `- 净资产：${formatOptionalNumber(toNumber(asset.net_assets ?? asset.netAssets))} ${translateCurrency(asset.currency)}；现金：${formatOptionalNumber(toNumber(asset.total_cash ?? asset.totalCash))}；购买力：${formatOptionalNumber(toNumber(asset.buy_power ?? asset.buyPower))}`,
    `- 风险等级：${translateRiskLevel(asset.risk_level ?? asset.riskLevel)}`
  ];

  if (snapshot.positions.length === 0) {
    return [...header, "- 当前长桥官方模拟盘没有持仓。"].join("\n");
  }

  return [
    ...header,
    ...snapshot.positions.map((row) => {
      const available = row.available === undefined ? "" : `，可用 ${formatNumber(row.available, 4)}`;
      const cost = row.costPrice === undefined ? "成本不可用" : `成本 ${formatNumber(row.costPrice, 3)}`;
      return `- ${row.symbol}（${translateSecurityName(row.symbol, row.name)}）：${formatNumber(row.quantity, 4)} ${translateAssetClass(row.assetClass)}${available}，${cost}，币种 ${translateCurrency(row.currency)}`;
    })
  ].join("\n");
}

function renderQqqSection(quote) {
  if (quote?.degraded) {
    return [
      `- 标的：${quote.symbol ?? "QQQ.US"}`,
      `- 状态：行情读取降级；原因：${quote.degradedReason ?? "原因未返回"}`,
      `- 时间：${formatReportDateTime(quote.timestamp)}`,
      "- 操作含义：不能用本次行情判断突破或加仓，只保留新闻/宏观观察。"
    ].join("\n");
  }
  const last = toNumber(quote.last ?? quote.last_done ?? quote.lastDone);
  const prevClose = toNumber(quote.prev_close ?? quote.prevClose);
  const open = toNumber(quote.open);
  const high = toNumber(quote.high);
  const low = toNumber(quote.low);
  const volume = toNumber(quote.volume);
  const change = last !== undefined && prevClose !== undefined
    ? `${formatNumber(last - prevClose)} / ${formatPercent((last - prevClose) / prevClose)}`
    : "不可用";

  const lines = [
    `- 标的：${quote.symbol ?? "QQQ.US"}`,
    `- 最新价：${formatOptionalNumber(last)}；前收：${formatOptionalNumber(prevClose)}；区间涨跌：${change}`,
    `- 日内：开 ${formatOptionalNumber(open)} / 高 ${formatOptionalNumber(high)} / 低 ${formatOptionalNumber(low)} / 量 ${formatOptionalNumber(volume, 0)}`,
    `- 状态：${translateQuoteStatus(quote.status)}`
  ];

  const post = quote.post_market_quote;
  if (post && typeof post === "object") {
    lines.push(`- 盘后：${formatOptionalNumber(toNumber(post.last))}，时间 ${formatReportDateTime(post.timestamp)}`);
  }

  const pre = quote.pre_market_quote;
  if (pre && typeof pre === "object") {
    lines.push(`- 盘前：${formatOptionalNumber(toNumber(pre.last))}，时间 ${formatReportDateTime(pre.timestamp)}`);
  }

  return lines.join("\n");
}

function selectExecutionReports(db, info) {
  return db
    .prepare(`
      SELECT id, category, title, body, metadata, created_at
      FROM execution_reports
      WHERE category IN ('trade', 'daily')
      ORDER BY created_at ASC
    `)
    .all()
    .filter((row) => isWithinWindow(row.created_at, info));
}


async function fetchRequiredReportMarketData(info) {
  const fetchedAt = new Date().toISOString();
  const longbridgeWarnings = [];
  const [checkResult, assetsResult, positionsResult, quoteResult] = await Promise.allSettled([
    fetchRequiredLongbridgeJson("trade", ["check"], "Longbridge 连通性/令牌检查"),
    fetchRequiredLongbridgeJson("trade", ["assets"], "Longbridge 官方模拟盘资产"),
    fetchRequiredLongbridgeJson("trade", ["positions"], "Longbridge 官方模拟盘持仓"),
    fetchRequiredLongbridgeJson("quote", ["quote", "QQQ.US"], "Longbridge QQQ 行情")
  ]);
  const officialPaperSnapshot = buildOfficialPaperSnapshotFromSettled({
    checkResult,
    assetsResult,
    positionsResult,
    fetchedAt,
    warnings: longbridgeWarnings
  });
  const qqqQuote = buildQqqQuoteFromSettled({
    quoteResult,
    fetchedAt,
    warnings: longbridgeWarnings
  });
  const trackedSymbols = buildTrackedSymbols(
    officialPaperSnapshot.positions,
    splitCsv(process.env.REPORT_NEWS_SYMBOLS ?? "")
  ).slice(0, Number(process.env.REPORT_NEWS_SYMBOL_LIMIT ?? 8));
  const [marketNewsResult, macroCalendarResult] = await Promise.all([
    fetchMarketNews(trackedSymbols),
    fetchMacroCalendar(info)
  ]);
  const marketNews = marketNewsResult.articles;
  const macroEvents = macroCalendarResult.entries;

  return {
    officialPaperSnapshot,
    qqqQuote,
    trackedSymbols,
    marketNews,
    newsWarnings: marketNewsResult.warnings,
    longbridgeWarnings,
    macroEvents,
    macroWarnings: macroCalendarResult.warnings,
    sourceEvidence: {
      fetchedAt,
      accountMode: officialPaperSnapshot.accountMode,
      longbridgeSessionStatus: officialPaperSnapshot.check.sessionStatus,
      longbridgeOkRegions: officialPaperSnapshot.check.okRegions,
      assetRows: officialPaperSnapshot.assets.length,
      officialPositions: officialPaperSnapshot.positions.length,
      trackedSymbols,
      newsCount: marketNews.length,
      newsSourceBreakdown: summarizeNewsSourceBreakdown(marketNews),
      newsWarnings: marketNewsResult.warnings,
      longbridgeWarnings,
      macroEventsCount: macroEvents.length,
      macroWarnings: macroCalendarResult.warnings,
      quoteSymbol: qqqQuote.symbol ?? "QQQ.US",
      quoteTimestamp: qqqQuote.timestamp ?? qqqQuote.post_market_quote?.timestamp ?? qqqQuote.pre_market_quote?.timestamp ?? null
    }
  };
}

async function fetchRequiredLongbridgeJson(category, args, label) {
  return runLongbridgeJsonWithRetry(category, args, { label });
}

function buildOfficialPaperSnapshotFromSettled({ checkResult, assetsResult, positionsResult, fetchedAt, warnings }) {
  const failures = [
    settledFailureLabel(checkResult, "连通性/令牌"),
    settledFailureLabel(assetsResult, "资产"),
    settledFailureLabel(positionsResult, "持仓")
  ].filter(Boolean);
  if (failures.length > 0) {
    warnings.push(`官方模拟盘读取降级：${failures.join("；")}`);
    return buildDegradedOfficialPaperSnapshot({
      fetchedAt,
      reason: failures.join("；")
    });
  }

  try {
    return normalizeOfficialPaperSnapshot({
      check: checkResult.value,
      assets: assetsResult.value,
      positions: positionsResult.value,
      fetchedAt
    });
  } catch (error) {
    const reason = singleLine(error?.message ?? error, 180);
    warnings.push(`官方模拟盘格式降级：${reason}`);
    return buildDegradedOfficialPaperSnapshot({ fetchedAt, reason });
  }
}

function buildQqqQuoteFromSettled({ quoteResult, fetchedAt, warnings }) {
  if (quoteResult.status === "rejected") {
    const reason = singleLine(quoteResult.reason?.message ?? quoteResult.reason, 180);
    warnings.push(`QQQ 行情读取降级：${reason}`);
    return buildDegradedQuoteSnapshot("QQQ.US", { fetchedAt, reason });
  }

  try {
    return normalizeQuotePayload(quoteResult.value, "QQQ.US");
  } catch (error) {
    const reason = singleLine(error?.message ?? error, 180);
    warnings.push(`QQQ 行情格式降级：${reason}`);
    return buildDegradedQuoteSnapshot("QQQ.US", { fetchedAt, reason });
  }
}

function settledFailureLabel(result, label) {
  if (result.status !== "rejected") {
    return "";
  }
  return `${label}失败：${singleLine(result.reason?.message ?? result.reason, 140)}`;
}

// Phase 4 Task 4: fetchMarketNews now delegates to news-sources.mjs's
// collectL1News instead of hand-rolling its own Promise.allSettled fan-out
// over 4 hardcoded sources. Behavior-preserving for the four pre-existing
// sources (same env var semantics, same "throw when everything came back
// empty" invariant) - RSSHub and Finnhub simply join the same pool as two
// more entries in collectL1News's source list, so they can only ADD
// articles/warnings, never change how the four original sources behave.
async function fetchMarketNews(symbols) {
  const { articles, warnings } = await collectL1News({ symbols, env: process.env });
  return { articles, warnings };
}

// Task H7 (2026-07-14 legacy audit): every OTHER required data source
// (official-paper snapshot, QQQ quote, each news feed) degrades gracefully
// via Promise.allSettled + a buildDegraded*/warnings path - this fetch had
// NO try/catch at all, and its caller (fetchRequiredReportMarketData)
// combined it with fetchMarketNews via a plain Promise.all, so an expired
// Longbridge token or unparseable CLI output (both non-transient, thrown on
// the FIRST attempt per _longbridge.mjs) crashed the entire daily/weekly
// report - exactly when the degradation notices would matter most. The
// quality gate already accepts "宏观日历降级" text (report-quality.mjs) and
// renderMarketIntelligence already renders an empty macroEvents list as
// "未来宏观日历没有返回高重要性事件" - this fetch just needed to stop being
// the one required source with no degradation path into that existing
// machinery.
export async function fetchMacroCalendar(info) {
  const start = info.label;
  const end = addDays(info.label, Number(process.env.REPORT_MACRO_LOOKAHEAD_DAYS ?? 14));
  try {
    const payload = await fetchRequiredLongbridgeJson("quote", [
      "finance-calendar",
      "macrodata",
      "--market",
      "US",
      "--star",
      "2",
      "--star",
      "3",
      "--start",
      start,
      "--end",
      end,
      "--count",
      String(Number(process.env.REPORT_MACRO_COUNT ?? 20))
    ], "Longbridge 美国宏观日历");
    return normalizeReportMacroCalendarPayload(payload);
  } catch (error) {
    const reason = singleLine(error?.message ?? error, 180);
    return { entries: [], warnings: [`宏观日历读取失败：${reason}`] };
  }
}

function formatQuoteTimestamp(quote) {
  const timestamps = [
    quote?.timestamp,
    quote?.post_market_quote?.timestamp,
    quote?.pre_market_quote?.timestamp
  ].filter(Boolean);
  return timestamps.length > 0 ? `行情时间 ${formatReportDateTime(timestamps[0])}` : "行情时间未提供";
}

// Task H7 (2026-07-14 legacy audit): the "长桥行情" marker never appeared in
// any rendered report - renderDataSourceSummary emitted "长桥 QQQ 行情"
// (note the space), which does not contain "长桥行情" as a contiguous
// substring. isPreparedReportMarkdownComplete therefore ALWAYS returned
// false on a genuine report, so every `deliver` regenerated the report from
// scratch (doubling every Longbridge/news/macro fetch and PDF render), and
// a delivery-time-only outage would fail delivery even though a valid,
// already-quality-checked report sat on disk. Fix, chosen side: the
// RENDERER now emits "长桥行情" literally (see renderDataSourceSummary's
// "长桥行情（QQQ 行情）" text) so both markers are satisfied by the same
// phrase - the check itself is unchanged, keeping this list the single
// definition of "a prepared report has everything deliver needs" (see the
// seam test in scheduled-report.test.ts, which generates a real report via
// renderDailyReport/renderWeeklyReport and runs this exact function against
// it, so the two sides can never silently diverge again).
export function isPreparedReportMarkdownComplete(markdown) {
  const text = String(markdown ?? "");
  return [
    "长桥官方模拟盘",
    "多源新闻",
    "宏观日历",
    "长桥行情",
    "QQQ 行情"
  ].every((marker) => text.includes(marker));
}

export function resolveReportWindow(reportKind, explicitDate) {
  const label = explicitDate ?? formatDateLabel(new Date(), timezone);
  assertDateLabel(label);
  const startOffsetDays = reportKind === "daily" ? -1 : -7;
  const startLabel = addDays(label, startOffsetDays);
  return {
    kind: reportKind,
    label,
    startLabel,
    endLabel: label,
    start: new Date(`${startLabel}T20:00:00+08:00`),
    end: new Date(`${label}T20:00:00+08:00`)
  };
}

function isWithinWindow(value, info) {
  const ts = new Date(String(value)).getTime();
  return Number.isFinite(ts) && ts > info.start.getTime() && ts <= info.end.getTime();
}

function formatWindow(info) {
  return `${info.startLabel} 20:00 - ${info.endLabel} 20:00（北京时间）`;
}

function formatReportDateTime(value) {
  const ts = new Date(String(value ?? "")).getTime();
  if (!Number.isFinite(ts)) {
    return "时间不可用";
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(ts));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`;
}

function formatDateLabel(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function addDays(label, days) {
  const [year, month, day] = label.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function updateState(info, patch) {
  let state = {};
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    state = {};
  }

  const key = `${info.kind}:${info.label}`;
  state[key] = {
    ...(state[key] ?? {}),
    window: {
      start: info.start.toISOString(),
      end: info.end.toISOString(),
      label: formatWindow(info)
    },
    ...patch
  };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function assertKind(value) {
  if (value === "daily" || value === "weekly") {
    return value;
  }
  throw new Error("Report kind must be daily or weekly.");
}

function assertAction(value) {
  if (value === "prepare" || value === "deliver" || value === "run") {
    return value;
  }
  throw new Error("Report action must be prepare, deliver, or run.");
}

function assertDateLabel(value) {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(String(value))) {
    return;
  }
  throw new Error(`Report date must use YYYY-MM-DD format; received ${JSON.stringify(value)}.`);
}

function singleLine(value, maxChars = 260) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function splitCsv(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function formatOptionalNumber(value, digits = 2) {
  return value === undefined ? "不可用" : formatNumber(value, digits);
}

function formatNumber(value, digits = 2) {
  return Number(value).toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  });
}

function formatPercent(value) {
  return Number(value).toLocaleString("en-US", {
    style: "percent",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  });
}
