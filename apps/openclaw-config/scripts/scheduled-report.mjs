#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deliverReportToFeishu, loadLocalEnv, openTradingDatabase } from "../../../packages/shared-types/dist/index.js";
import { renderDailyRoutineChecklist } from "./daily-routine.mjs";
import { runLongbridgeJsonWithRetry } from "./_longbridge.mjs";
import {
  normalizeExternalRssNews,
  mergeNewsArticles,
  normalizeYahooSearchNews,
  renderDetailedNewsLine,
  selectDiverseNewsArticles,
  summarizeNewsSourceBreakdown
} from "./report-news.mjs";
import {
  assertOfficialPaperReportEnvironment,
  buildTrackedSymbols,
  normalizeNewsPayload,
  normalizeOfficialPaperSnapshot,
  normalizeQuotePayload,
  toNumber
} from "./report-data.mjs";
import { normalizeReportMacroCalendarPayload } from "./report-macro.mjs";
import { assertReportQuality } from "./report-quality.mjs";
import { writeMarkdownPdf } from "./report-rendering.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
loadLocalEnv(repoRoot);
const runtimeDir = join(repoRoot, "runtime");
const dbPath = join(runtimeDir, "trading.sqlite");
const statePath = join(runtimeDir, "report-delivery-state.json");
const timezone = process.env.TRADING_TIMEZONE ?? "Asia/Shanghai";

const [kindArg = "daily", actionArg = "run", dateArg] = process.argv.slice(2).filter((arg) => arg !== "--");
const kind = assertKind(kindArg);
const action = assertAction(actionArg);
const windowInfo = resolveReportWindow(kind, dateArg);
const reportPath = join(repoRoot, "reports", kind, `${windowInfo.label}.md`);
const reportPdfPath = join(repoRoot, "reports", kind, `${windowInfo.label}.pdf`);

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
  const pdfPath = writeMarkdownPdf({ repoRoot, runtimeDir, markdownPath: reportPath, pdfPath: reportPdfPath, markdown: report });
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
    : writeMarkdownPdf({ repoRoot, runtimeDir, markdownPath: reportPath, pdfPath: reportPdfPath, markdown });
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

function renderDailyReport(info, data) {
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
    renderDailyRoutineCompliance(),
    "",
    renderDataSourceSummary(data),
    "",
    renderDailyRoutineClassification(data),
    "",
    renderMarketIntelligence(data),
    "",
    "## 3. 大盘 -> 板块 -> 个股影响判断",
    "",
    "- 大盘：以 QQQ、宏观日历、多源市场新闻和风险情绪为主线，先判断风险偏好。",
    "- 板块：优先关注科技、半导体、AI、金融条件、能源/黄金/汇率等对美股估值的传导。",
    "- 个股：仅把信息分类为利好、利空或待验证；必须说明是否可能改变企业基本面。",
    "- 行动含义：如果只是情绪噪声，不提高仓位；如果改变基本面或流动性，再进入个股分析模板。",
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
    "- 继续按 daily-routine.md 分类新闻、企业近况、科研/技术成果、大宗商品、汇率、情绪、经济指标和市场涨跌。",
    "- 如需要扩展到具体标的，进入三日一次的个股分析流程。"
  ].join("\n");
}

function renderWeeklyReport(info, data) {
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
    renderDailyRoutineCompliance(),
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
    "- 固定观察 QQQ 的趋势、成交量、盘前/盘后偏离和 VIX/利率/汇率联动。",
    "- 对本周高频出现的行业主题，进入大盘 -> 板块 -> 个股的拆解。",
    "- 对用户指定的一批股票，按个股分析模板每三天复盘一次。"
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

function renderDataSourceSummary(data) {
  return [
    "- 已验证来源：本地交易数据库、长桥官方模拟盘账户快照、长桥行情、多源新闻检索、长桥美国宏观日历。",
    "- 本地交易数据库读取：执行报告、日报/周报记录、官方模拟盘订单生命周期。",
    "- 长桥账户读取：连通性与令牌检查、官方模拟盘资产、官方模拟盘持仓。",
    "- 长桥行情读取：QQQ 的最新价、前收、日内高低、盘前/盘后价格与时间。",
    `- 多源资讯读取：跟踪标的 ${formatTrackedSymbols(data.trackedSymbols)}；每个标的最多读取 ${Number(process.env.REPORT_NEWS_COUNT_PER_SYMBOL ?? 5)} 条长桥新闻，并补充 Yahoo Finance 搜索、Yahoo Finance RSS 和 Google News RSS。`,
    `- 新闻来源分布：${summarizeNewsSourceBreakdown(data.marketNews)}。`,
    ...(data.newsWarnings.length ? [`- 新闻降级：${data.newsWarnings.join("；")}。`] : []),
    `- 长桥宏观读取：美国二星和三星宏观事件，窗口从 ${data.sourceEvidence.fetchedAt.slice(0, 10)} 起向后 ${Number(process.env.REPORT_MACRO_LOOKAHEAD_DAYS ?? 14)} 天。`,
    ...(data.macroWarnings?.length ? [`- 宏观日历降级：${data.macroWarnings.join("；")}。`] : []),
    `- 本次证据：账户模式 ${translateAccountMode(data.sourceEvidence.accountMode)}；令牌状态 ${translateSessionStatus(data.sourceEvidence.longbridgeSessionStatus)}；可用区域 ${formatRegions(data.sourceEvidence.longbridgeOkRegions)}；账户资产 ${data.sourceEvidence.assetRows} 行；官方持仓 ${data.sourceEvidence.officialPositions} 个；新闻 ${data.sourceEvidence.newsCount} 条；宏观事件 ${data.sourceEvidence.macroEventsCount} 条；${formatQuoteTimestamp(data.qqqQuote)}。`
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
    "### 信息源完整性与分类结论",
    "",
    `- 新闻：已读取 ${data.marketNews.length} 条多源新闻；来源分布 ${summarizeNewsSourceBreakdown(data.marketNews)}；主线为 ${newsSignal.summary}。`,
    `- 企业近况：${companyNews ? `${newsEvent(companyNews)}，基本面影响需等公司公告/财报验证。` : "本窗口没有读到可直接改变单一公司基本面的高置信更新。"}`,
    `- 最新科研/技术成果：${technologyNews ? `${newsEvent(technologyNews)}，对科技权重和 QQQ 情绪有传导。` : "本窗口没有读到可审计的科研/技术突破类更新。"}`,
    `- 大宗商品价格变动：${commodityNews ? `${newsEvent(commodityNews)}，作为通胀和风险偏好的辅助变量。` : "未读到足以进入结论的大宗商品变动。"}`,
    `- 货币汇率变化：${currencyNews ? `${newsEvent(currencyNews)}，需观察美元和利率对成长股估值的影响。` : "未读到足以进入结论的汇率变动。"}`,
    `- 市场情绪：${newsSignal.bias}；${newsSignal.action}`,
    "- 行业淡旺季：本窗口没有足以改变行业季节性判断的新证据。",
    `- 经济指标：${macroSignal}`,
    `- 大盘走势：${qqqSummary}。`,
    "",
    "### 利好/利空/基本面影响",
    "",
    ...selectDiverseNewsArticles(data.marketNews, 6).map(renderClassifiedNewsLine)
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
  return renderDetailedNewsLine(article, formatReportDateTime);
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

function summarizePaperBudget(snapshot, qqqQuote) {
  const asset = snapshot.primaryAsset ?? {};
  const netAssets = toNumber(asset.net_assets ?? asset.netAssets) ?? 0;
  const marketValue = snapshot.positions.reduce((sum, row) => {
    const quote = row.symbol === "QQQ.US" ? qqqQuote : snapshot.quotes?.find((item) => item.symbol === row.symbol);
    const last = toNumber(quote?.last ?? quote?.last_done ?? quote?.lastDone) ?? row.costPrice ?? 0;
    return sum + row.quantity * last;
  }, 0);
  if (netAssets <= 0) {
    return "无法计算模拟盘暴露比例";
  }
  const exposure = marketValue / netAssets * 100;
  const remaining = Math.max(0, netAssets * 0.1 - marketValue);
  return `模拟盘暴露 ${exposure.toFixed(2)}%，剩余自由发挥预算约 ${formatNumber(remaining)} 美元`;
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
  const check = await fetchRequiredLongbridgeJson("trade", ["check"], "Longbridge 连通性/令牌检查");
  const [assets, positions, quotePayload] = await Promise.all([
    fetchRequiredLongbridgeJson("trade", ["assets"], "Longbridge 官方模拟盘资产"),
    fetchRequiredLongbridgeJson("trade", ["positions"], "Longbridge 官方模拟盘持仓"),
    fetchRequiredLongbridgeJson("quote", ["quote", "QQQ.US"], "Longbridge QQQ 行情")
  ]);
  const officialPaperSnapshot = normalizeOfficialPaperSnapshot({ check, assets, positions, fetchedAt });
  const qqqQuote = normalizeQuotePayload(quotePayload, "QQQ.US");
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

async function fetchMarketNews(symbols) {
  const count = Math.max(1, Number(process.env.REPORT_NEWS_COUNT_PER_SYMBOL ?? 5));
  const warnings = [];
  const batches = await Promise.all(symbols.map(async (symbol) => {
    const [longbridgeResult, yahooResult, yahooRssResult, googleRssResult] = await Promise.allSettled([
      fetchRequiredLongbridgeJson("quote", ["news", symbol, "--count", String(count)], `Longbridge 新闻 ${symbol}`)
        .then((payload) => normalizeNewsPayload(symbol, payload)),
      fetchYahooSearchNews(symbol, count),
      fetchYahooRssNews(symbol, count),
      fetchGoogleNewsRss(symbol, count)
    ]);

    const rows = [];
    if (longbridgeResult.status === "fulfilled") {
      rows.push(...longbridgeResult.value);
    } else {
      warnings.push(`${symbol} 长桥新闻读取失败：${singleLine(longbridgeResult.reason?.message ?? longbridgeResult.reason, 120)}`);
    }
    if (yahooResult.status === "fulfilled") {
      rows.push(...yahooResult.value);
    } else {
      warnings.push(`${symbol} Yahoo Finance 新闻读取失败：${singleLine(yahooResult.reason?.message ?? yahooResult.reason, 120)}`);
    }
    if (yahooRssResult.status === "fulfilled") {
      rows.push(...yahooRssResult.value);
    } else {
      warnings.push(`${symbol} Yahoo Finance RSS 读取失败：${singleLine(yahooRssResult.reason?.message ?? yahooRssResult.reason, 120)}`);
    }
    if (googleRssResult.status === "fulfilled") {
      rows.push(...googleRssResult.value);
    } else {
      warnings.push(`${symbol} Google News RSS 读取失败：${singleLine(googleRssResult.reason?.message ?? googleRssResult.reason, 120)}`);
    }
    return rows;
  }));
  const articles = mergeNewsArticles(batches.flat());
  if (articles.length === 0) {
    throw new Error("多源新闻返回为空；报告需要至少一条已验证新闻。");
  }
  return { articles, warnings };
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
  url.searchParams.set("q", `${yahooSymbol} stock OR Nasdaq 100 ETF when:7d`);
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("gl", "US");
  url.searchParams.set("ceid", "US:en");
  const xml = await fetchTextWithTimeout(url);
  return normalizeExternalRssNews(symbol, xml, {
    source: "google-news-rss",
    sourceName: "Google News"
  }).slice(0, count);
}

async function fetchMacroCalendar(info) {
  const start = info.label;
  const end = addDays(info.label, Number(process.env.REPORT_MACRO_LOOKAHEAD_DAYS ?? 14));
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
}

function formatQuoteTimestamp(quote) {
  const timestamps = [
    quote?.timestamp,
    quote?.post_market_quote?.timestamp,
    quote?.pre_market_quote?.timestamp
  ].filter(Boolean);
  return timestamps.length > 0 ? `行情时间 ${formatReportDateTime(timestamps[0])}` : "行情时间未提供";
}

function isPreparedReportMarkdownComplete(markdown) {
  const text = String(markdown ?? "");
  return [
    "长桥官方模拟盘",
    "多源新闻",
    "宏观日历",
    "长桥行情",
    "QQQ 行情"
  ].every((marker) => text.includes(marker));
}

function resolveReportWindow(reportKind, explicitDate) {
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

function toYahooSymbol(symbol) {
  return String(symbol ?? "").toUpperCase().replace(/\.US$/u, "");
}

async function fetchJsonWithTimeout(url) {
  return JSON.parse(await fetchTextWithTimeout(url));
}

async function fetchTextWithTimeout(url) {
  const attempts = Math.max(1, Number(process.env.REPORT_NEWS_FETCH_ATTEMPTS ?? 2));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.REPORT_NEWS_FETCH_TIMEOUT_MS ?? 12000));
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/125 Safari/537.36 OpenClaw",
          "accept": "application/rss+xml,application/json,text/xml,text/plain,*/*",
          "accept-language": "en-US,en;q=0.9"
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
