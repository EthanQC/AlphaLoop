#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadLocalEnv, openTradingDatabase, sendNotification } from "../../../packages/shared-types/dist/index.js";
import { runLongbridgeJson } from "./_longbridge.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const runtimeDir = join(repoRoot, "runtime");
const dbPath = join(runtimeDir, "trading.sqlite");
const statePath = join(runtimeDir, "report-delivery-state.json");
const timezone = process.env.TRADING_TIMEZONE ?? "Asia/Shanghai";
loadLocalEnv(repoRoot);

const [kindArg = "daily", actionArg = "run", dateArg] = process.argv.slice(2);
const kind = assertKind(kindArg);
const action = assertAction(actionArg);
const windowInfo = resolveReportWindow(kind, dateArg);
const reportPath = join(repoRoot, "reports", kind, `${windowInfo.label}.md`);

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
  const db = openTradingDatabase(dbPath);
  const [executionRows, approvalRows, proposalRows, paperPositions, latestPreference, qqqQuote] = await Promise.all([
    Promise.resolve(selectExecutionReports(db, info)),
    Promise.resolve(selectApprovalRows(db, info)),
    Promise.resolve(selectProposalRows(db, info)),
    Promise.resolve(selectPaperPositions(db)),
    Promise.resolve(selectLatestPreference(db)),
    fetchQqqQuote()
  ]);

  const report = reportKind === "daily"
    ? renderDailyReport(info, {
        executionRows,
        approvalRows,
        proposalRows,
        paperPositions,
        latestPreference,
        qqqQuote
      })
    : renderWeeklyReport(info, {
        executionRows,
        approvalRows,
        proposalRows,
        paperPositions,
        latestPreference,
        qqqQuote
      });

  writeFileSync(reportPath, `${report}\n`, "utf8");
  updateState(info, {
    preparedAt: new Date().toISOString(),
    path: reportPath,
    kind: reportKind
  });

  return {
    path: reportPath,
    markdown: report
  };
}

async function deliverReport(reportKind, info, alreadyPrepared) {
  let markdown = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
  if (!markdown.trim()) {
    const report = await prepareReport(reportKind, info);
    markdown = report.markdown;
  }

  const titlePrefix = reportKind === "daily" ? "OpenClaw 日报" : "OpenClaw 周报";
  const chunks = chunkMarkdown(markdown, 5600);
  for (const [index, chunk] of chunks.entries()) {
    const suffix = chunks.length > 1 ? `（${index + 1}/${chunks.length}）` : "";
    const result = await sendNotification({
      title: `${titlePrefix} ${info.label}${suffix}`,
      body: chunk,
      format: "post"
    });
    if (!result.sent) {
      throw new Error(result.reason ?? `Report delivery was not sent; target=${result.target}`);
    }
  }

  updateState(info, {
    deliveredAt: new Date().toISOString(),
    path: reportPath,
    kind: reportKind,
    chunks: chunks.length,
    regeneratedDuringDelivery: !alreadyPrepared && !existsSync(reportPath)
  });

  console.log(JSON.stringify({
    delivered: true,
    kind: reportKind,
    label: info.label,
    chunks: chunks.length,
    path: reportPath
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
    `- 交易/执行报告：${tradeRows.length} 条，其中拒绝/未执行 ${rejectedRows.length} 条。`,
    `- 建议/偏好报告：${dailyRows.length} 条。`,
    `- 人工审批编辑：${data.approvalRows.length} 条。`,
    `- 规则提案：${data.proposalRows.length} 条。`,
    `- 当前本地模拟盘持仓：${data.paperPositions.length} 个。`,
    "- 期权自动化：已禁用，不纳入日报生成、建议或执行。",
    "",
    "## 2. 信息检索与分类",
    "",
    "- 已验证：本报告使用本地 SQLite 交易事实、OpenClaw 执行报告、规则提案和 Longbridge QQQ 行情快照。",
    "- 待验证：外部宏观/新闻流尚未接入可审计来源，本报告不会把未落库新闻当作事实。",
    "- 噪声过滤：系统心跳、健康检查和已禁用期权影子链路不计入交易判断。",
    "",
    "## 3. 执行与模拟盘",
    "",
    renderExecutionDigest(data.executionRows),
    "",
    "## 4. 规则学习与提案",
    "",
    renderProposalDigest(data.proposalRows),
    "",
    "## 5. 风险与异常",
    "",
    "- 实盘：禁止自动提交真实资金订单。",
    "- 官方模拟盘：只有确认 Longbridge token 属于官方模拟盘后，才允许走官方 paper write 测试。",
    "- 期权：不生成、不预览、不执行任何期权自动化。",
    "- 渠道：Feishu app 探测健康；富文本交付由本报告链路直接推送到炒股群。",
    "",
    "## 6. QQQ 固定观察",
    "",
    renderQqqSection(data.qqqQuote),
    "",
    "## 7. 持仓与关注标的",
    "",
    renderPaperPositions(data.paperPositions),
    "",
    "## 8. 需要你决策",
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
    `- 执行/交易报告：${tradeRows.length} 条。`,
    `- 日常建议/偏好报告：${dailyRows.length} 条。`,
    `- 规则提案：${data.proposalRows.length} 条。`,
    `- 当前本地模拟盘持仓：${data.paperPositions.length} 个。`,
    "- 期权自动化：已禁用，周报只保留历史风险提示，不提供任何期权行动建议。",
    "",
    "## 2. 市场主线回顾",
    "",
    "- 本地目前没有可审计的外部新闻/宏观数据入库，因此周报只汇总交易事实、执行记录和 QQQ 行情快照。",
    "- 后续若接入新闻源/宏观源，会按“已验证、部分验证、未验证”分层纳入。",
    "",
    "## 3. QQQ 与美股风险温度",
    "",
    renderQqqSection(data.qqqQuote),
    "",
    "## 4. 模拟盘与执行复盘",
    "",
    renderExecutionDigest(data.executionRows),
    "",
    "## 5. 规则提案与策略学习",
    "",
    renderProposalDigest(data.proposalRows),
    "",
    "## 6. 偏好快照",
    "",
    data.latestPreference
      ? `- 更新时间：${data.latestPreference.created_at}\n- 摘要：${singleLine(data.latestPreference.summary)}`
      : "- 暂无偏好快照。",
    "",
    "## 7. 下周跟踪",
    "",
    "- 固定观察 QQQ 的趋势、成交量和盘前/盘后偏离。",
    "- 检查 Longbridge 官方模拟盘 token 状态和 paper write 能力。",
    "- 检查 OpenClaw 版本、模型目录和 Feishu 交付链路。",
    "",
    "## 8. 需要你确认",
    "",
    "- 周报中的规则提案只作为策略学习草案，必须人工确认后才会激活。",
    "- 若你要扩展固定跟踪标的，后续可以在日报模板里显式加入。"
  ].join("\n");
}

function renderExecutionDigest(rows) {
  if (rows.length === 0) {
    return "- 本窗口没有交易执行报告或建议报告。";
  }

  return rows.map((row) => [
    `### ${row.title}`,
    "",
    `- 时间：${row.created_at}`,
    `- 类别：${row.category}`,
    `- 内容：${singleLine(row.body, 420)}`
  ].join("\n")).join("\n\n");
}

function renderProposalDigest(rows) {
  if (rows.length === 0) {
    return "- 本窗口没有新的规则提案。";
  }

  return rows.map((row) => [
    `### ${row.scope} / ${row.recommendation}`,
    "",
    `- 时间：${row.created_at}`,
    `- 版本：${row.current_version} -> ${row.candidate_version}`,
    `- 摘要：${singleLine(row.summary, 420)}`,
    `- 旧新对比：${singleLine(row.old_vs_new, 420)}`
  ].join("\n")).join("\n\n");
}

function renderPaperPositions(rows) {
  if (rows.length === 0) {
    return "- 当前没有本地模拟盘 open 持仓。";
  }

  return rows.map((row) => {
    const avg = formatNumber(row.avg_price);
    const pnl = formatNumber(row.realized_pnl);
    return `- ${row.symbol}：${row.quantity} ${row.asset_class}，均价 ${avg}，已实现 PnL ${pnl}`;
  }).join("\n");
}

function renderQqqSection(quote) {
  if (!quote) {
    return "- QQQ.US 行情暂不可用；报告已保留固定观察位，等待下一次 Longbridge quote 成功。";
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
    `- 状态：${quote.status ?? "unknown"}`
  ];

  const post = quote.post_market_quote;
  if (post && typeof post === "object") {
    lines.push(`- 盘后：${formatOptionalNumber(toNumber(post.last))}，时间 ${post.timestamp ?? "unknown"}`);
  }

  const pre = quote.pre_market_quote;
  if (pre && typeof pre === "object") {
    lines.push(`- 盘前：${formatOptionalNumber(toNumber(pre.last))}，时间 ${pre.timestamp ?? "unknown"}`);
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
  return db
    .prepare(`
      SELECT scope, summary, old_vs_new, evidence, recommendation, current_version, candidate_version, created_at
      FROM rule_proposals
      ORDER BY created_at ASC
    `)
    .all()
    .filter((row) => isWithinWindow(row.created_at, info));
}

function selectPaperPositions(db) {
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

async function fetchQqqQuote() {
  try {
    const payload = await runLongbridgeJson("quote", ["quote", "QQQ.US"]);
    return Array.isArray(payload) ? payload[0] : payload?.quotes?.[0] ?? null;
  } catch {
    return null;
  }
}

function resolveReportWindow(reportKind, explicitDate) {
  const label = explicitDate ?? formatDateLabel(new Date(), timezone);
  const startLabel = reportKind === "daily"
    ? addDays(label, -1)
    : addDays(label, -4);
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
  return `${info.startLabel} 20:00 - ${info.endLabel} 20:00 (${timezone})`;
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

function chunkMarkdown(markdown, maxChars) {
  const chunks = [];
  const sections = markdown.split(/\n(?=##\s)/u);
  let current = "";
  for (const section of sections) {
    if (current && current.length + section.length + 1 > maxChars) {
      chunks.push(current.trim());
      current = "";
    }
    current = current ? `${current}\n${section}` : section;
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }
  return chunks.length > 0 ? chunks : [markdown.trim()];
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

function singleLine(value, maxChars = 260) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
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
