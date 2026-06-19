#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createId,
  deliverReportToFeishu,
  loadLocalEnv,
  openTradingDatabase
} from "../../../packages/shared-types/dist/index.js";
import { runLongbridgeJsonWithRetry } from "./_longbridge.mjs";
import { assertOfficialPaperReportEnvironment, normalizeOfficialPaperSnapshot, normalizeQuotePayload, toNumber } from "./report-data.mjs";
import { writeMarkdownPdf } from "./report-rendering.mjs";
import {
  shouldRunOfficialPaperHourlyPoll,
  shouldRunOfficialPaperPnlReport
} from "./trading-schedule.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
loadLocalEnv(repoRoot);

const runtimeDir = join(repoRoot, "runtime");
const reportsDir = join(repoRoot, "reports", "official-paper");
const dbPath = join(runtimeDir, "trading.sqlite");
mkdirSync(runtimeDir, { recursive: true });
mkdirSync(reportsDir, { recursive: true });

const db = openTradingDatabase(dbPath);
ensureOfficialPaperTables(db);

const [command = "poll", ...args] = process.argv.slice(2);
const force = args.includes("--force");

if (command === "poll") {
  await pollOfficialPaper(force);
} else if (command === "pnl") {
  await sendPnlReport(force);
} else if (command === "snapshot") {
  const snapshot = await fetchOfficialPaperSnapshot();
  saveSnapshot(snapshot, "manual");
  console.log(JSON.stringify(snapshot, null, 2));
} else {
  throw new Error("Usage: official-paper-monitor.mjs <poll|pnl|snapshot> [--force]");
}

async function pollOfficialPaper(forceRun = false) {
  if (!forceRun && !shouldRunOfficialPaperHourlyPoll(new Date())) {
    console.log(JSON.stringify({ skipped: true, reason: "outside_us_hourly_poll_window" }, null, 2));
    return;
  }

  assertOfficialPaperReportEnvironment();
  const snapshot = await fetchOfficialPaperSnapshot();
  const snapshotId = saveSnapshot(snapshot, "hourly_poll");
  const reflection = buildStrategyReflection(snapshot);
  const reflectionId = createId("paper_reflection");
  db.prepare(`
    INSERT INTO paper_strategy_reflections (id, snapshot_id, created_at, summary, payload)
    VALUES (?, ?, ?, ?, ?)
  `).run(reflectionId, snapshotId, snapshot.fetchedAt, reflection.summary, JSON.stringify(reflection));

  console.log(JSON.stringify({ polled: true, snapshotId, reflectionId, summary: reflection.summary }, null, 2));
}

async function sendPnlReport(forceRun = false) {
  if (!forceRun && !shouldRunOfficialPaperPnlReport(new Date())) {
    console.log(JSON.stringify({ skipped: true, reason: "outside_post_open_pnl_window" }, null, 2));
    return;
  }

  assertOfficialPaperReportEnvironment();
  const snapshot = await fetchOfficialPaperSnapshot();
  const snapshotId = saveSnapshot(snapshot, "post_open_pnl");
  const previousDay = findComparisonSnapshot(snapshot.fetchedAt, "previous_day");
  const previousWeek = findComparisonSnapshot(snapshot.fetchedAt, "previous_week");
  const markdown = renderPnlReport(snapshot, previousDay, previousWeek);
  const label = snapshot.fetchedAt.slice(0, 10);
  const markdownPath = join(reportsDir, `${label}-post-open.md`);
  const pdfPath = join(reportsDir, `${label}-post-open.pdf`);
  writeFileSync(markdownPath, `${markdown}\n`, "utf8");
  await writeMarkdownPdf({ repoRoot, runtimeDir, markdownPath, pdfPath, markdown });

  const delivery = await deliverReportToFeishu({
    title: `OpenClaw 模拟盘收支变化 ${label}`,
    markdown,
    markdownPath,
    pdfPath
  });
  if (!delivery.sent) {
    throw new Error(delivery.reason ?? "模拟盘收支变化报告未发送。");
  }

  console.log(JSON.stringify({ delivered: true, snapshotId, markdownPath, pdfPath }, null, 2));
}

async function fetchOfficialPaperSnapshot() {
  const fetchedAt = new Date().toISOString();
  const check = await runLongbridgeJsonWithRetry("trade", ["check"], { label: "Longbridge 连通性/令牌检查" });
  const [assets, positions] = await Promise.all([
    runLongbridgeJsonWithRetry("trade", ["assets"], { label: "Longbridge 官方模拟盘资产" }),
    runLongbridgeJsonWithRetry("trade", ["positions"], { label: "Longbridge 官方模拟盘持仓" })
  ]);
  const snapshot = normalizeOfficialPaperSnapshot({ check, assets, positions, fetchedAt });
  const quotes = [];
  for (const position of snapshot.positions) {
    try {
      const payload = await runLongbridgeJsonWithRetry("quote", ["quote", position.symbol], { label: `Longbridge ${position.symbol} 行情` });
      quotes.push(normalizeQuotePayload(payload, position.symbol));
    } catch (error) {
      quotes.push({ symbol: position.symbol, error: String(error?.message ?? error).slice(0, 160) });
    }
  }
  return { ...snapshot, quotes };
}

function saveSnapshot(snapshot, reason) {
  const id = createId("official_paper_snapshot");
  const primary = snapshot.primaryAsset ?? {};
  const netAssets = toNumber(primary.net_assets ?? primary.netAssets);
  const totalCash = toNumber(primary.total_cash ?? primary.totalCash);
  const marketValue = estimateMarketValue(snapshot);
  db.prepare(`
    INSERT INTO official_paper_snapshots
    (id, fetched_at, reason, net_assets, total_cash, market_value, positions, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    snapshot.fetchedAt,
    reason,
    netAssets ?? null,
    totalCash ?? null,
    marketValue,
    JSON.stringify(snapshot.positions),
    JSON.stringify(snapshot)
  );
  return id;
}

function buildStrategyReflection(snapshot) {
  const primary = snapshot.primaryAsset ?? {};
  const netAssets = toNumber(primary.net_assets ?? primary.netAssets) ?? 0;
  const marketValue = estimateMarketValue(snapshot);
  const exposurePercent = netAssets > 0 ? (marketValue / netAssets) * 100 : 0;
  const budgetPercent = 10;
  const remainingBudget = Math.max(0, netAssets * budgetPercent / 100 - marketValue);
  const summary = `官方模拟盘当前暴露 ${exposurePercent.toFixed(2)}%，剩余 OpenClaw 自由发挥预算约 ${remainingBudget.toFixed(2)} USD。`;
  return {
    summary,
    exposurePercent,
    budgetPercent,
    remainingBudget,
    positionCount: snapshot.positions.length,
    action: exposurePercent > budgetPercent ? "停止新增并等待降仓" : "允许继续观察，新增前仍需通过 broker-executor 预算检查"
  };
}

function renderPnlReport(current, previousDay, previousWeek) {
  const currentAsset = summarizeAsset(current);
  const dayAsset = previousDay ? summarizeAsset(previousDay) : null;
  const weekAsset = previousWeek ? summarizeAsset(previousWeek) : null;
  const reflection = buildStrategyReflection(current);

  return [
    `# OpenClaw 模拟盘收支变化 ${current.fetchedAt.slice(0, 10)}`,
    "",
    `生成时间：${formatShanghaiTime(current.fetchedAt)}`,
    "",
    "- 语言：中文。",
    "- 投递：飞书摘要卡片 + PDF。",
    "- 账户：长桥官方模拟盘。",
    "- 范围：OpenClaw 最多使用总仓 10%；剩余 90% 不动。",
    "- 实盘：禁止自动提交真实资金订单。",
    "",
    "## 收支变化表",
    "",
    "| 对比项 | 净资产 | 现金 | 持仓估值 | 净资产变化 | 现金变化 |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    renderComparisonRow("当前", currentAsset, null),
    renderComparisonRow("跟前一日", currentAsset, dayAsset),
    renderComparisonRow("跟上一周最后一个交易日", currentAsset, weekAsset),
    "",
    "## 持仓",
    "",
    ...renderPositionLines(current),
    "",
    "## 策略反思",
    "",
    `- ${reflection.summary}`,
    `- 动作：${reflection.action}。`,
    "- 若模型鉴权、券商鉴权或飞书渠道异常，停止自动动作并降级为只读报告。"
  ].join("\n");
}

function renderComparisonRow(label, current, base) {
  return [
    label,
    formatMoney(current.netAssets),
    formatMoney(current.totalCash),
    formatMoney(current.marketValue),
    base ? formatDelta(current.netAssets - base.netAssets) : "基准",
    base ? formatDelta(current.totalCash - base.totalCash) : "基准"
  ].join(" | ").replace(/^/u, "| ").replace(/$/u, " |");
}

function renderPositionLines(snapshot) {
  if (snapshot.positions.length === 0) {
    return ["- 当前无持仓。"];
  }
  return snapshot.positions.map((position) => {
    const quote = snapshot.quotes.find((entry) => String(entry.symbol ?? "").toUpperCase() === position.symbol);
    const last = toNumber(quote?.last ?? quote?.last_done ?? quote?.lastDone);
    return `- ${position.symbol}：数量 ${position.quantity}，成本 ${formatMoney(position.costPrice)}，最新价 ${formatMoney(last)}。`;
  });
}

function summarizeAsset(snapshot) {
  const primary = snapshot.primaryAsset ?? {};
  return {
    netAssets: toNumber(primary.net_assets ?? primary.netAssets) ?? 0,
    totalCash: toNumber(primary.total_cash ?? primary.totalCash) ?? 0,
    marketValue: estimateMarketValue(snapshot)
  };
}

function estimateMarketValue(snapshot) {
  return snapshot.positions.reduce((sum, position) => {
    const quote = snapshot.quotes?.find((entry) => String(entry.symbol ?? "").toUpperCase() === position.symbol);
    const last = toNumber(quote?.last ?? quote?.last_done ?? quote?.lastDone);
    const price = last ?? position.costPrice ?? 0;
    return sum + position.quantity * price;
  }, 0);
}

function findComparisonSnapshot(fetchedAt, mode) {
  const currentMs = new Date(fetchedAt).getTime();
  const offsetMs = mode === "previous_day" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const rows = db.prepare(`
    SELECT raw FROM official_paper_snapshots
    WHERE fetched_at < ?
    ORDER BY fetched_at DESC
    LIMIT 80
  `).all(fetchedAt);
  const target = rows.find((row) => currentMs - new Date(JSON.parse(String(row.raw)).fetchedAt).getTime() >= offsetMs);
  if (!target) {
    return null;
  }
  return JSON.parse(String(target.raw));
}

function ensureOfficialPaperTables(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS official_paper_snapshots (
      id TEXT PRIMARY KEY,
      fetched_at TEXT NOT NULL,
      reason TEXT NOT NULL,
      net_assets REAL,
      total_cash REAL,
      market_value REAL NOT NULL,
      positions TEXT NOT NULL,
      raw TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS official_paper_snapshots_time_idx
      ON official_paper_snapshots(fetched_at);

    CREATE TABLE IF NOT EXISTS paper_strategy_reflections (
      id TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload TEXT NOT NULL
    );
  `);
}

function formatMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(2)} USD` : "暂无";
}

function formatDelta(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number >= 0 ? "+" : ""}${number.toFixed(2)} USD` : "暂无";
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
