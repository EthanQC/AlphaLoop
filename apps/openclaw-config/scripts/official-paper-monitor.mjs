#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createId,
  deliverReportToFeishu,
  loadLocalEnv,
  MemberRepository,
  openTradingDatabase
} from "../../../packages/shared-types/dist/index.js";
import { runLongbridgeJsonWithRetry } from "./_longbridge.mjs";
import { computeExposure } from "./portfolio-exposure.mjs";
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
const defaultDbPath = join(runtimeDir, "trading.sqlite");
mkdirSync(runtimeDir, { recursive: true });
mkdirSync(reportsDir, { recursive: true });

// Task H4 (phase2.5 hardening): sentinel for official_paper_snapshots.owner_id
// when the writer can't attribute a snapshot to exactly one member (0 or >1
// active members). Deliberately a DIFFERENT string from stock_analysis_
// targets' '__legacy_shared__' sentinel - these are two independently
// evolving tables/columns (this one is nullable with no FK, no CHECK; that
// one is NOT NULL with a composite PK) and P6 will read this one
// differently (per-member fetch) once multi-account support lands, per the
// task brief ("P6 接入多账户时会按成员分别拉取").
export const SHARED_OWNER_SENTINEL = "__shared__";

// Resolves which member a freshly-fetched snapshot belongs to. Today there is
// exactly one shared Longbridge paper account, so the common case is exactly
// one active member -> that member's id. 0 active members (e.g. a fresh
// install before anyone is seeded) or >1 (P6's eventual multi-account state)
// can't be attributed to a single owner, so they get the shared sentinel
// instead of guessing wrong. Every write from this file must go through this
// - historical rows written before this task keep their legacy NULL owner_id
// unchanged (see schema v4's migration comment: "历史行 NULL 是合法的...但新写入必须带 owner").
export function resolveSnapshotOwnerId(db) {
  const activeMembers = new MemberRepository(db).listActive();
  return activeMembers.length === 1 ? activeMembers[0].id : SHARED_OWNER_SENTINEL;
}

async function pollOfficialPaper(db, forceRun = false) {
  if (!forceRun && !shouldRunOfficialPaperHourlyPoll(new Date())) {
    console.log(JSON.stringify({ skipped: true, reason: "outside_us_hourly_poll_window" }, null, 2));
    return;
  }

  assertOfficialPaperReportEnvironment();
  const snapshot = await fetchOfficialPaperSnapshot();
  const snapshotId = saveSnapshot(db, snapshot, "hourly_poll");
  const reflection = buildStrategyReflection(snapshot);
  const reflectionId = createId("paper_reflection");
  db.prepare(`
    INSERT INTO paper_strategy_reflections (id, snapshot_id, created_at, summary, payload)
    VALUES (?, ?, ?, ?, ?)
  `).run(reflectionId, snapshotId, snapshot.fetchedAt, reflection.summary, JSON.stringify(reflection));

  console.log(JSON.stringify({ polled: true, snapshotId, reflectionId, summary: reflection.summary }, null, 2));
}

async function sendPnlReport(db, forceRun = false) {
  if (!forceRun && !shouldRunOfficialPaperPnlReport(new Date())) {
    console.log(JSON.stringify({ skipped: true, reason: "outside_post_open_pnl_window" }, null, 2));
    return;
  }

  assertOfficialPaperReportEnvironment();
  const snapshot = await fetchOfficialPaperSnapshot();
  const snapshotId = saveSnapshot(db, snapshot, "post_open_pnl");
  const previousDay = findComparisonSnapshot(db, snapshot.fetchedAt, "previous_day");
  const previousWeek = findComparisonSnapshot(db, snapshot.fetchedAt, "previous_week");
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

// Audit item (b), 2026-07-14 (task H4): the manual `snapshot` subcommand used
// to skip assertOfficialPaperReportEnvironment entirely - poll/pnl both
// asserted it, but a wrong-environment manual run (not a paper account) would
// write that account's data straight into the trusted official_paper_snapshots
// table with no gate at all. Extracted into its own function (rather than
// inlined at the CLI dispatch site) so the assertion-then-fetch-then-save
// order is directly testable without spawning a process.
export async function runManualSnapshot(db) {
  assertOfficialPaperReportEnvironment();
  const snapshot = await fetchOfficialPaperSnapshot();
  saveSnapshot(db, snapshot, "manual");
  return snapshot;
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
  const { positions: pricedPositions, degradedSymbols } = attachPriceSource(snapshot.positions, quotes);
  return {
    ...snapshot,
    positions: pricedPositions,
    quotes,
    degraded: degradedSymbols.length > 0,
    degradedReason: degradedSymbols.length > 0 ? `行情读取失败：${degradedSymbols.join("、")}` : null
  };
}

// Audit item (a), 2026-07-14 (task H4): a per-symbol quote fetch failure used
// to be silently folded into cost-price (or 0 if cost was also missing)
// inside estimateMarketValue, with NO marker anywhere in the persisted
// snapshot - the `reason` column (hourly_poll/post_open_pnl/manual) implies
// "this ran to completion", not "N positions are degraded estimates", so
// nothing downstream (exposure, PnL deltas, the rendered report) could tell
// a real market price from a stale cost-basis guess. Every position now
// carries an explicit, persisted `priceSource`:
//   'live' - a usable last/last_done price came back from the quote fetch.
//   'cost' - the quote fetch failed/was unusable, but the position's own
//            cost basis was available as a fallback.
//   'zero' - quote fetch failed AND cost basis is missing/unusable; this
//            position contributes 0 to market value (the worst case).
// Reuses the existing `degraded`/`degradedReason` field convention from
// report-data.mjs's buildDegradedOfficialPaperSnapshot/buildDegradedQuoteSnapshot
// (a DIFFERENT failure mode - total Longbridge fetch failure - but the same
// shape) rather than inventing new field names for the same concept.
export function attachPriceSource(positions, quotes) {
  const degradedSymbols = [];
  const priced = positions.map((position) => {
    const quote = quotes.find((entry) => String(entry.symbol ?? "").toUpperCase() === position.symbol);
    const last = toNumber(quote?.last ?? quote?.last_done ?? quote?.lastDone);
    if (last !== undefined) {
      return { ...position, priceSource: "live", price: last };
    }
    const cost = toNumber(position.costPrice);
    if (cost !== undefined) {
      degradedSymbols.push(`${position.symbol}(按成本估值)`);
      return { ...position, priceSource: "cost", price: cost };
    }
    degradedSymbols.push(`${position.symbol}(按0估值)`);
    return { ...position, priceSource: "zero", price: 0 };
  });
  return { positions: priced, degradedSymbols };
}

export function saveSnapshot(db, snapshot, reason) {
  const id = createId("official_paper_snapshot");
  const primary = snapshot.primaryAsset ?? {};
  const netAssets = toNumber(primary.net_assets ?? primary.netAssets);
  const totalCash = toNumber(primary.total_cash ?? primary.totalCash);
  const marketValue = estimateMarketValue(snapshot);
  const ownerId = resolveSnapshotOwnerId(db);
  db.prepare(`
    INSERT INTO official_paper_snapshots
    (id, fetched_at, reason, net_assets, total_cash, market_value, positions, raw, owner_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    snapshot.fetchedAt,
    reason,
    netAssets ?? null,
    totalCash ?? null,
    marketValue,
    JSON.stringify(snapshot.positions),
    JSON.stringify(snapshot),
    ownerId
  );
  return id;
}

// Audit item (a) follow-through: this is the "exposure computation" the task
// brief names - it must disclose degradation instead of silently trusting
// estimateMarketValue's number as ground truth. countDegradedPositions/
// snapshot.degraded (set by fetchOfficialPaperSnapshot's attachPriceSource
// call) drive an explicit note appended to the summary whenever any position
// was priced by fallback (cost/zero) rather than a live quote.
export function buildStrategyReflection(snapshot) {
  const primary = snapshot.primaryAsset ?? {};
  const netAssets = toNumber(primary.net_assets ?? primary.netAssets) ?? 0;
  const marketValue = estimateMarketValue(snapshot);
  const exposure = computeExposure({ netAssets, marketValue, positions: snapshot.positions });
  // netAssets was already coerced to 0 above, so exposure.exposureRatio is never
  // actually null here; the `?? 0` only guards the type (computeExposure allows a
  // null netAssets for other callers, e.g. the alert engine) without changing behavior.
  const exposurePercent = (exposure.exposureRatio ?? 0) * 100;
  const budgetPercent = exposure.budgetRatio * 100;
  const remainingBudget = Math.max(0, netAssets * budgetPercent / 100 - marketValue);
  const degraded = Boolean(snapshot.degraded);
  const degradedCount = countDegradedPositions(snapshot.positions);
  const degradedNote = degraded
    ? `（含 ${degradedCount} 笔持仓因行情读取失败按成本/0 估值，敞口与市值为估计值，非真实值）`
    : "";
  const summary = `官方模拟盘当前暴露 ${exposurePercent.toFixed(2)}%${degradedNote}，剩余 OpenClaw 自由发挥预算约 ${remainingBudget.toFixed(2)} USD。`;
  return {
    summary,
    exposurePercent,
    budgetPercent,
    remainingBudget,
    positionCount: snapshot.positions.length,
    degraded,
    action: exposure.overBudget ? "停止新增并等待降仓" : "允许继续观察，新增前仍需通过 broker-executor 预算检查"
  };
}

function countDegradedPositions(positions) {
  return (positions ?? []).filter((position) => position?.priceSource && position.priceSource !== "live").length;
}

export function renderPnlReport(current, previousDay, previousWeek) {
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
    const quote = snapshot.quotes?.find((entry) => String(entry.symbol ?? "").toUpperCase() === position.symbol);
    const last = toNumber(quote?.last ?? quote?.last_done ?? quote?.lastDone);
    // Audit item (a): "最新价" keeps showing the raw quote result (still
    // "暂无" when the quote fetch failed - truthful, not hidden) but now
    // appends an explicit note when this position's contribution to market
    // value/exposure above came from a fallback, not a real quote.
    const degradedNote = position.priceSource && position.priceSource !== "live"
      ? `（估值降级：行情读取失败，按${position.priceSource === "cost" ? "成本价" : "0"}代替，非真实市价）`
      : "";
    return `- ${position.symbol}：数量 ${position.quantity}，成本 ${formatMoney(position.costPrice)}，最新价 ${formatMoney(last)}${degradedNote}。`;
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

// Trusts `position.price` (set by attachPriceSource for every position that
// passes through fetchOfficialPaperSnapshot - live/cost/zero, always a
// finite number) as the single source of truth, rather than independently
// re-deriving a price from quotes the way this function used to. Falls back
// to the pre-H4 `costPrice ?? 0` derivation for legacy raw snapshots (parsed
// from official_paper_snapshots.raw by findComparisonSnapshot) that predate
// this task and never had `.price`/`.priceSource` attached - so historical
// PnL comparisons keep computing exactly the same number they always did.
export function estimateMarketValue(snapshot) {
  return snapshot.positions.reduce((sum, position) => {
    const price = typeof position.price === "number" && Number.isFinite(position.price)
      ? position.price
      : toNumber(position.costPrice) ?? 0;
    return sum + position.quantity * price;
  }, 0);
}

function findComparisonSnapshot(db, fetchedAt, mode) {
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

// ---------------------------------------------------------------------------
// CLI entry point. Guarded by isMainModule so importing this module (tests)
// never opens the real runtime db or dispatches a command as a side effect
// of `import` - mirrors stock-analysis.mjs/market-alerts.mjs/market-alerts-
// poll.mjs's existing testable-CLI pattern (task H4).
// ---------------------------------------------------------------------------

async function main() {
  const [command = "poll", ...args] = process.argv.slice(2);
  const force = args.includes("--force");

  const db = openTradingDatabase(defaultDbPath);
  try {
    if (command === "poll") {
      await pollOfficialPaper(db, force);
    } else if (command === "pnl") {
      await sendPnlReport(db, force);
    } else if (command === "snapshot") {
      const snapshot = await runManualSnapshot(db);
      console.log(JSON.stringify(snapshot, null, 2));
    } else {
      throw new Error("Usage: official-paper-monitor.mjs <poll|pnl|snapshot> [--force]");
    }
  } finally {
    db.close();
  }
}

const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  await main();
}
