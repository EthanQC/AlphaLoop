#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deliverReportToFeishu, loadLocalEnv, openTradingDatabase } from "../../../packages/shared-types/dist/index.js";
import { runLongbridgeJsonWithRetry } from "./_longbridge.mjs";
import {
  assertOfficialPaperReportEnvironment,
  buildTrackedSymbols,
  normalizeMacroCalendarPayload,
  normalizeNewsPayload,
  normalizeOfficialPaperSnapshot,
  normalizeQuotePayload,
  selectLocalNewsEvents,
  toNumber
} from "./report-data.mjs";

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
  const [executionRows, approvalRows, proposalRows, localPaperPositions, latestPreference, localNewsEvents] = await Promise.all([
    Promise.resolve(selectExecutionReports(db, info)),
    Promise.resolve(selectApprovalRows(db, info)),
    Promise.resolve(selectProposalRows(db, info)),
    Promise.resolve(selectLocalPaperPositions(db)),
    Promise.resolve(selectLatestPreference(db)),
    Promise.resolve(selectLocalNewsEvents(db, info))
  ]);
  const marketData = await fetchRequiredReportMarketData(info);

  const report = reportKind === "daily"
    ? renderDailyReport(info, {
        executionRows,
        approvalRows,
        proposalRows,
        localPaperPositions,
        latestPreference,
        localNewsEvents,
        ...marketData
      })
    : renderWeeklyReport(info, {
        executionRows,
        approvalRows,
        proposalRows,
        localPaperPositions,
        latestPreference,
        localNewsEvents,
        ...marketData
      });

  writeFileSync(reportPath, `${report}\n`, "utf8");
  const pdfPath = writeReportPdf(reportPath, reportPdfPath, report);
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
  const pdfPath = existsSync(reportPdfPath)
    ? reportPdfPath
    : writeReportPdf(reportPath, reportPdfPath, markdown);
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
    "## 1. 今日结论",
    "",
    ...renderCoreSummary(data, {
      period: "今日",
      tradeCount: tradeRows.length,
      adviceCount: dailyRows.length,
      rejectedCount: rejectedRows.length,
      approvalCount: data.approvalRows.length,
      proposalCount: data.proposalRows.length
    }),
    "- 期权自动化：已禁用，不纳入日报生成、建议或执行。",
    "",
    "## 2. 市场资讯与宏观日历",
    "",
    renderDataSourceSummary(data),
    "- 噪声过滤：系统心跳、健康检查和已禁用期权影子链路不计入交易判断。",
    "",
    renderMarketIntelligence(data),
    "",
    "## 3. 执行与模拟盘",
    "",
    renderExecutionDigest(data.executionRows),
    "",
    "## 4. QQQ 固定观察",
    "",
    renderQqqSection(data.qqqQuote),
    "",
    "## 5. 当前持仓",
    "",
    renderOfficialPaperSnapshot(data.officialPaperSnapshot),
    "",
    "### 本地模拟盘历史持仓核对",
    "",
    renderLocalPaperPositions(data.localPaperPositions),
    "",
    "## 6. 风险与异常",
    "",
    "- 实盘：禁止自动提交真实资金订单。",
    "- 官方模拟盘：报告以长桥官方模拟盘账户快照为准；本地模拟盘只作为历史审计层。",
    "- 期权：不生成、不预览、不执行任何期权自动化。",
    "- 渠道：飞书交付链路探测健康；报告由现有自动化链路推送到炒股群。",
    "",
    "## 7. 规则提案摘要",
    "",
    renderProposalDigest(data.proposalRows),
    "",
    "## 8. 需要人工确认事项",
    "",
    "- 是否接受本窗口内的规则提案，需要人工确认；未确认前规则保持未激活。",
    "- 若要临时分析具体个股，直接点名标的即可；日报固定标的保持 QQQ。"
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
    "## 1. 本周结论",
    "",
    ...renderCoreSummary(data, {
      period: "本周",
      tradeCount: tradeRows.length,
      adviceCount: dailyRows.length,
      rejectedCount: tradeRows.filter((row) => /rejected|拒绝|not allowed|disabled|未执行|不允许/iu.test(`${row.title}\n${row.body}`)).length,
      approvalCount: data.approvalRows.length,
      proposalCount: data.proposalRows.length
    }),
    "- 期权自动化：已禁用，周报只保留历史风险提示，不提供任何期权行动建议。",
    "",
    "## 2. 市场主线回顾",
    "",
    renderDataSourceSummary(data),
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
    "### 本地模拟盘历史持仓核对",
    "",
    renderLocalPaperPositions(data.localPaperPositions),
    "",
    renderExecutionDigest(data.executionRows),
    "",
    "## 5. 规则提案与策略学习",
    "",
    renderProposalDigest(data.proposalRows),
    "",
    "## 6. 偏好/策略变化",
    "",
    renderPreferenceSnapshot(data.latestPreference),
    "",
    "## 7. 下周跟踪",
    "",
    "- 固定观察 QQQ 的趋势、成交量和盘前/盘后偏离。",
    "- 检查长桥官方模拟盘鉴权令牌状态、账户快照、新闻/宏观日历抓取能力。",
    "- 检查系统版本、模型目录和飞书交付链路。",
    "",
    "## 8. 需要人工确认事项",
    "",
    "- 周报中的规则提案只作为策略学习草案，必须人工确认后才会激活。",
    "- 若你要扩展固定跟踪标的，后续可以在日报模板里显式加入。"
  ].join("\n");
}

function renderCoreSummary(data, counts) {
  const officialPositions = data.officialPaperSnapshot.positions;
  const officialSummary = summarizeOfficialPositions(officialPositions);
  const accountSummary = summarizeOfficialAccount(data.officialPaperSnapshot);
  const qqqSummary = summarizeQqqMove(data.qqqQuote);
  return [
    `- 核心结论：${counts.period}没有自动提交实盘订单；官方模拟盘当前持仓为 ${officialSummary}。`,
    `- 账户状态：${accountSummary}。`,
    `- 市场状态：${qqqSummary}。`,
    `- 记录状态：交易/执行报告 ${counts.tradeCount} 条，其中拒绝或未执行 ${counts.rejectedCount} 条；建议/偏好报告 ${counts.adviceCount} 条；人工审批编辑 ${counts.approvalCount} 条；规则提案 ${counts.proposalCount} 条。`,
    `- 数据覆盖：长桥新闻 ${data.marketNews.length} 条；美国宏观日历 ${data.macroEvents.length} 条；本地模拟盘历史持仓 ${data.localPaperPositions.length} 个。`
  ];
}

function renderDataSourceSummary(data) {
  return [
    "- 已验证来源：本地交易数据库、长桥官方模拟盘账户快照、长桥行情、长桥新闻、长桥美国宏观日历。",
    "- 本地交易数据库读取：执行/建议报告、人工审批记录、规则提案、本地模拟盘历史持仓、已落库新闻/日历事件。",
    "- 长桥账户读取：连通性与令牌检查、官方模拟盘资产、官方模拟盘持仓。",
    "- 长桥行情读取：QQQ 的最新价、前收、日内高低、盘前/盘后价格与时间。",
    `- 长桥资讯读取：跟踪标的 ${formatTrackedSymbols(data.trackedSymbols)}；每个标的最多读取 ${Number(process.env.REPORT_NEWS_COUNT_PER_SYMBOL ?? 5)} 条新闻。`,
    `- 长桥宏观读取：美国二星和三星宏观事件，窗口从 ${data.sourceEvidence.fetchedAt.slice(0, 10)} 起向后 ${Number(process.env.REPORT_MACRO_LOOKAHEAD_DAYS ?? 14)} 天。`,
    `- 本次证据：账户模式 ${translateAccountMode(data.sourceEvidence.accountMode)}；令牌状态 ${translateSessionStatus(data.sourceEvidence.longbridgeSessionStatus)}；可用区域 ${formatRegions(data.sourceEvidence.longbridgeOkRegions)}；账户资产 ${data.sourceEvidence.assetRows} 行；官方持仓 ${data.sourceEvidence.officialPositions} 个；新闻 ${data.sourceEvidence.newsCount} 条；宏观事件 ${data.sourceEvidence.macroEventsCount} 条；${formatQuoteTimestamp(data.qqqQuote)}。`
  ].join("\n");
}

function renderExecutionDigest(rows) {
  if (rows.length === 0) {
    return "- 本窗口没有交易执行报告或建议报告。";
  }

  const shownRows = rows.slice(-8);
  const omitted = rows.length - shownRows.length;
  const header = [
    `- 本窗口共有 ${rows.length} 条执行/建议记录。`,
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

function renderProposalDigest(rows) {
  if (rows.length === 0) {
    return "- 本窗口没有新的规则提案。";
  }

  return rows.map((row) => [
    `### ${singleLine(row.title) || `${translateRuleScope(row.scope)}：${translateRuleRecommendation(row.recommendation)}`}`,
    "",
    `- 提案编号：${row.id}`,
    `- 时间：${row.created_at}`,
    `- 版本：${row.current_version} -> ${row.candidate_version}`,
    `- 生命周期：${translateProposalStatus(row.status)}；${renderProposalActivationNotice(row.status)}`,
    `- 推荐动作：${translateRuleRecommendation(row.recommendation)}`,
    `- 触发原因：${renderChineseProposalText(row.trigger_reason || row.summary)}`,
    `- 摘要：${renderChineseProposalSummary(row.summary)}`,
    `- 旧新对比：${renderChineseRuleComparison(row)}`,
    `- 风险：${renderChineseRisks(row.risks)}`,
    "- 激活状态：报告只做摘要；必须人工运行带确认参数的激活脚本后才会生效。"
  ].join("\n")).join("\n\n");
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
    return "建议或偏好记录已入库。";
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
  return category === "trade" ? "交易/执行" : "建议/偏好";
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

function translateEventSource(value) {
  const labels = {
    "longbridge-news": "长桥新闻",
    "longbridge-calendar": "长桥日历",
    "longbridge-quote": "长桥行情"
  };
  return labels[String(value ?? "")] ?? "本地事件";
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

function translateRuleScope(scope) {
  const labels = {
    live: "实盘规则",
    paper: "模拟盘规则"
  };
  return labels[scope] ?? `规则范围 ${scope}`;
}

function translateRuleRecommendation(recommendation) {
  const labels = {
    suggest_activation: "建议激活（仍需人工确认）",
    continue_observe: "继续观察",
    promote: "建议形成候选版本",
    hold: "继续观察",
    reject: "不建议采用"
  };
  return labels[recommendation] ?? `建议 ${recommendation}`;
}

function translateProposalStatus(status) {
  const labels = {
    pending_confirmation: "待人工确认",
    activation_requested: "已一审建议激活，等待二次确认",
    continued_observation: "人工确认继续观察",
    activated: "已由人工确认激活",
    rejected: "已由人工拒绝",
    archived: "已归档"
  };
  return labels[status] ?? "待人工确认";
}

function renderProposalActivationNotice(status) {
  const notices = {
    pending_confirmation: "未确认不生效",
    activation_requested: "尚未生效，必须二次确认 HUMAN_APPROVED",
    continued_observation: "未激活，不改变规则行为",
    activated: "已通过人工确认生效",
    rejected: "已拒绝，不生效",
    archived: "已归档，不进入本轮应用"
  };
  return notices[status] ?? "未确认不生效";
}

function renderChineseProposalSummary(value) {
  const text = String(value ?? "");
  if (containsCjk(text)) {
    return singleLine(text);
  }
  if (/live rules have enough local evidence/iu.test(text)) {
    return "本地证据支持生成实盘候选更新，但不会自动激活。";
  }
  if (/paper rules remain on hold/iu.test(text)) {
    return "模拟盘规则继续观察，当前证据仍支持保留现有护栏。";
  }
  return "规则提案已入库；人工激活前需要复核证据、旧新差异和影响范围。";
}

function renderChineseRuleComparison(row) {
  const comparisons = normalizeComparisonRows(row.old_vs_new);
  if (comparisons.length > 0) {
    return comparisons
      .slice(0, 4)
      .map((entry) => `${entry.field}：${entry.oldValue} -> ${entry.newValue}（${entry.reason}）`)
      .join("；");
  }

  const delta = translateKnownRuleDelta(row.old_vs_new);
  const parts = [
    `旧版本 ${row.current_version ?? "未知"}`,
    `候选版本 ${row.candidate_version ?? "未知"}`
  ];
  parts.push(delta ?? "差异字段已入库，人工激活前需复核原始证据。");
  return parts.join("；");
}

function translateKnownRuleDelta(value) {
  const text = String(value ?? "");
  if (/Tighten live entry discipline/iu.test(text)) {
    return "收紧实盘入场纪律：只有确认性更强的表述才可呈现高置信度想法。";
  }
  if (/No rule delta recommended yet/iu.test(text)) {
    return "本窗口暂不推荐修改规则，继续收集执行和审批证据。";
  }
  return null;
}

function renderChineseProposalText(value) {
  const text = singleLine(value);
  return containsCjk(text) ? text : "触发原因已入库；旧英文模板已清理，不会在报告中展开。";
}

function renderChineseRisks(value) {
  const risks = parseJsonArray(value)
    .filter((entry) => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => singleLine(entry, 100));
  if (risks.length === 0) {
    return "风险已入库；人工确认前必须复核完整提案。";
  }
  return risks.slice(0, 3).join("；");
}

function normalizeComparisonRows(value) {
  const parsed = parseJsonArray(value);
  return parsed
    .map((entry) => {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        return {
          field: singleLine(entry.field ?? "规则项", 60),
          oldValue: singleLine(entry.oldValue ?? "", 80),
          newValue: singleLine(entry.newValue ?? "", 80),
          reason: singleLine(entry.reason ?? "人工确认前复核。", 100)
        };
      }
      if (typeof entry === "string") {
        const translated = translateKnownRuleDelta(entry);
        return translated
          ? {
              field: "旧格式提案",
              oldValue: "旧模板",
              newValue: translated,
              reason: "历史英文模板已清理，不作为可激活提案。"
            }
          : null;
      }
      return null;
    })
    .filter(Boolean);
}

function parseJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function containsCjk(value) {
  return /[\u3400-\u9fff]/u.test(String(value ?? ""));
}

function renderPreferenceSnapshot(row) {
  if (!row) {
    return "- 暂无偏好/策略快照。";
  }

  return [
    `- 更新时间：${formatReportDateTime(row.created_at)}`,
    "- 策略偏好：保持有意义的现金缓冲，控制单一标的与行业集中度；优先使用“宏观 -> 行业 -> 个股”的自上而下流程；事件质量不清晰时等待确认。",
    "- 使用方式：仅作为观察和建议风格输入，不自动改变交易规则。"
  ].join("\n");
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
  const summary = summarizeMarketNewsTitle(article.title);
  return [
    `- ${formatReportDateTime(article.publishedAt)} ${article.symbol}：${summary.event}`,
    `影响：${summary.impact}`,
    `来源：长桥新闻编号 ${article.id}`
  ].join("；") + "。";
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
  return {
    event: "长桥返回的市场资讯，已归类为一般市场新闻",
    impact: "原文标题保留在长桥新闻编号对应页面，报告正文不直接展示英文标题"
  };
}

function renderMarketIntelligence(data) {
  const newsLines = data.marketNews.length > 0
    ? data.marketNews.slice(0, 8).map(renderChineseNewsLine)
    : ["- 本窗口没有抓取到长桥新闻；报告生成会在抓取失败时直接报错，因此这里为空代表来源返回空列表。"];

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

  const localLines = data.localNewsEvents.length > 0
    ? data.localNewsEvents.slice(0, 5).map((event) => {
        const title = event.payload?.title ?? event.payload?.content ?? event.payload?.note ?? event.dedupe_key;
        return `- ${formatReportDateTime(event.ts)} ${translateEventSource(event.source)}：${summarizeMarketNewsTitle(title).event}；来源索引 ${event.dedupe_key ?? event.id}。`;
      })
    : ["- 本地事件库暂无额外新闻/日历事件。"];

  return [
    "### 长桥新闻（中文摘要）",
    "",
    ...newsLines,
    "",
    "### 宏观日历",
    "",
    ...macroLines,
    "",
    "### 本地事件库补充",
    "",
    ...localLines
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

function renderLocalPaperPositions(rows) {
  if (rows.length === 0) {
    return "- 当前没有本地模拟盘未平仓持仓。";
  }

  return rows.map((row) => {
    const avg = formatNumber(row.avg_price);
    const pnl = formatNumber(row.realized_pnl);
    return `- ${row.symbol}：${row.quantity} ${translateAssetClass(row.asset_class)}，均价 ${avg}，已实现盈亏 ${pnl}`;
  }).join("\n");
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

function selectApprovalRows(db, info) {
  return db
    .prepare(`
      SELECT advice_card_id, editor, summary, created_at
      FROM approval_edits
      ORDER BY created_at ASC
    `)
    .all()
    .filter((row) => isWithinWindow(row.created_at, info));
}

function selectProposalRows(db, info) {
  ensureProposalReportColumns(db);
  return db
    .prepare(`
      SELECT id, title, scope, summary, trigger_reason, old_vs_new, evidence, expected_benefit,
             risks, rollback_plan, recommendation, status, current_version, candidate_version, created_at
      FROM rule_proposals
      WHERE COALESCE(status, 'pending_confirmation') != 'archived'
        AND NOT (
          COALESCE(title, '') = ''
          AND (
            summary LIKE 'live rules have enough local evidence%'
            OR summary LIKE 'paper rules remain on hold%'
            OR old_vs_new LIKE '%No rule delta recommended yet%'
            OR old_vs_new LIKE '%Tighten live entry discipline%'
          )
        )
      ORDER BY created_at ASC
    `)
    .all()
    .filter((row) => isWithinWindow(row.created_at, info));
}

function ensureProposalReportColumns(db) {
  ensureReportColumn(db, "rule_proposals", "title", "TEXT NOT NULL DEFAULT ''");
  ensureReportColumn(db, "rule_proposals", "trigger_reason", "TEXT NOT NULL DEFAULT ''");
  ensureReportColumn(db, "rule_proposals", "expected_benefit", "TEXT NOT NULL DEFAULT ''");
  ensureReportColumn(db, "rule_proposals", "risks", "TEXT NOT NULL DEFAULT '[]'");
  ensureReportColumn(db, "rule_proposals", "rollback_plan", "TEXT NOT NULL DEFAULT ''");
  ensureReportColumn(db, "rule_proposals", "status", "TEXT NOT NULL DEFAULT 'pending_confirmation'");
}

function ensureReportColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((entry) => entry.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

function selectLocalPaperPositions(db) {
  return db
    .prepare(`
      SELECT symbol, asset_class, quantity, avg_price, realized_pnl
      FROM paper_positions
      WHERE status = 'open'
      ORDER BY symbol ASC, created_at ASC
    `)
    .all();
}

function selectLatestPreference(db) {
  return db
    .prepare(`SELECT summary, traits, created_at FROM preference_snapshots ORDER BY created_at DESC LIMIT 1`)
    .get();
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
  const [marketNews, macroEvents] = await Promise.all([
    fetchMarketNews(trackedSymbols),
    fetchMacroCalendar(info)
  ]);

  return {
    officialPaperSnapshot,
    qqqQuote,
    trackedSymbols,
    marketNews,
    macroEvents,
    sourceEvidence: {
      fetchedAt,
      accountMode: officialPaperSnapshot.accountMode,
      longbridgeSessionStatus: officialPaperSnapshot.check.sessionStatus,
      longbridgeOkRegions: officialPaperSnapshot.check.okRegions,
      assetRows: officialPaperSnapshot.assets.length,
      officialPositions: officialPaperSnapshot.positions.length,
      trackedSymbols,
      newsCount: marketNews.length,
      macroEventsCount: macroEvents.length,
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
  const batches = await Promise.all(symbols.map(async (symbol) => {
    const payload = await fetchRequiredLongbridgeJson("quote", ["news", symbol, "--count", String(count)], `Longbridge 新闻 ${symbol}`);
    return normalizeNewsPayload(symbol, payload);
  }));
  const articles = batches.flat().sort((a, b) => b.publishedAtMs - a.publishedAtMs);
  if (articles.length === 0) {
    throw new Error("Longbridge 新闻返回为空；报告需要至少一条已验证新闻。");
  }
  return articles;
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
  const entries = normalizeMacroCalendarPayload(payload);
  if (entries.length === 0) {
    throw new Error("Longbridge 美国宏观日历返回为空；报告需要至少一条已验证宏观事件。");
  }
  return entries;
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
    "长桥新闻",
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

function writeReportPdf(markdownPath, pdfPath, markdown) {
  const htmlPath = join(runtimeDir, "report-html", `${basename(markdownPath, ".md")}.html`);
  mkdirSync(join(runtimeDir, "report-html"), { recursive: true });
  writeFileSync(htmlPath, renderReportHtml(markdown), "utf8");

  const chromePath = resolveChromePath();
  execFileSync(chromePath, [
    "--headless",
    "--disable-gpu",
    "--no-first-run",
    `--print-to-pdf=${pdfPath}`,
    `file://${htmlPath}`
  ], {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "pipe"]
  });

  if (!existsSync(pdfPath)) {
    throw new Error(`PDF 生成失败：${pdfPath}`);
  }
  return pdfPath;
}

function resolveChromePath() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  ].filter(Boolean);

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error("未找到可用于生成 PDF 的 Chrome/Chromium。请安装 Google Chrome 或设置 CHROME_BIN。");
  }
  return found;
}

function renderReportHtml(markdown) {
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<style>",
    "@page { size: A4; margin: 18mm 16mm; }",
    "body { font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif; color: #111827; font-size: 13px; line-height: 1.58; }",
    "h1 { font-size: 24px; margin: 0 0 14px; padding-bottom: 10px; border-bottom: 2px solid #111827; }",
    "h2 { font-size: 18px; margin: 22px 0 10px; padding-bottom: 4px; border-bottom: 1px solid #d1d5db; }",
    "h3 { font-size: 15px; margin: 16px 0 8px; }",
    "p { margin: 7px 0; }",
    "ul { margin: 7px 0 10px 20px; padding: 0; }",
    "li { margin: 4px 0; }",
    "code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #f3f4f6; padding: 1px 3px; border-radius: 3px; }",
    "</style>",
    "</head>",
    "<body>",
    markdownToHtml(markdown),
    "</body>",
    "</html>"
  ].join("\n");
}

function markdownToHtml(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      closeList();
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(3, heading[1].length);
      html.push(`<h${level}>${formatInlineHtml(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = /^-\s+(.+)$/u.exec(line);
    if (bullet) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${formatInlineHtml(bullet[1])}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${formatInlineHtml(line)}</p>`);
  }
  closeList();
  return html.join("\n");
}

function formatInlineHtml(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
    .replace(/`([^`]+)`/gu, "<code>$1</code>");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
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
