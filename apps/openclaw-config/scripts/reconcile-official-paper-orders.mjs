#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { runLongbridgeJson } from "./_longbridge.mjs";

const repoRoot = process.cwd();
const dbPath = join(repoRoot, "runtime", "trading.sqlite");
const symbolFilters = new Set(process.argv.slice(2).map((entry) => entry.toUpperCase()));

if (process.env.LONGBRIDGE_ACCOUNT_MODE !== "paper") {
  console.error("Refusing to reconcile official paper orders unless LONGBRIDGE_ACCOUNT_MODE=paper.");
  process.exit(1);
}

if (process.env.ALLOW_LIVE_EXECUTION === "true") {
  console.error("Refusing to reconcile official paper orders while ALLOW_LIVE_EXECUTION=true.");
  process.exit(1);
}

mkdirSync(join(repoRoot, "runtime"), { recursive: true });
const db = new DatabaseSync(dbPath);
ensureLifecycleSchema(db);

const ordersPayload = await runLongbridgeJson("trade", ["order"]);
const executionsPayload = await runLongbridgeJson("trade", ["order", "executions"]);
const orders = asArray(ordersPayload)
  .filter((order) => symbolFilters.size === 0 || symbolFilters.has(String(order.symbol ?? "").toUpperCase()));
const executions = asArray(executionsPayload);
const observedAt = new Date().toISOString();
const saved = [];

for (const order of orders) {
  const externalOrderId = String(order.order_id ?? order.orderId ?? order.id ?? "");
  if (!externalOrderId) {
    continue;
  }

  const symbol = String(order.symbol ?? "");
  const side = normalizeSide(order.side);
  const quantity = toNumber(order.quantity) ?? 0;
  const limitPrice = toNumber(order.price);
  const brokerStatus = String(order.status ?? "unknown");
  const lifecycleStage = mapBrokerStatusToStage(brokerStatus);
  const localStatus = mapLifecycleStageToLocalStatus(lifecycleStage);
  const ticketId = findRecentTicketId(db, symbol);
  const submittedAt = String(order.created_at ?? order.createdAt ?? observedAt);
  const matchingExecutions = executions.filter((execution) => {
    const executionOrderId = String(execution.order_id ?? execution.orderId ?? "");
    return executionOrderId === externalOrderId;
  });
  const raw = { order, executions: matchingExecutions };
  const notes = [
    "Official Longbridge Demo A/C paper order observed via CLI reconciliation.",
    "This is an equity/ETF paper lifecycle record; options automation remains disabled.",
    "No real-money order was submitted by this reconciliation."
  ];

  db.prepare(`
    INSERT INTO official_paper_order_lifecycle
    (id, ticket_id, external_order_id, provider, environment, account_mode, symbol, asset_class,
     side, quantity, limit_price, broker_status, local_status, lifecycle_stage, submitted_at,
     last_observed_at, raw, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_order_id) DO UPDATE SET
      ticket_id = COALESCE(excluded.ticket_id, official_paper_order_lifecycle.ticket_id),
      broker_status = excluded.broker_status,
      local_status = excluded.local_status,
      lifecycle_stage = excluded.lifecycle_stage,
      last_observed_at = excluded.last_observed_at,
      raw = excluded.raw,
      notes = excluded.notes
  `).run(
    `lb_order_${externalOrderId}`,
    ticketId,
    externalOrderId,
    "longbridge-paper",
    "paper",
    "paper",
    symbol,
    guessAssetClass(symbol),
    side,
    quantity,
    limitPrice ?? null,
    brokerStatus,
    localStatus,
    lifecycleStage,
    submittedAt,
    observedAt,
    JSON.stringify(raw),
    JSON.stringify(notes)
  );

  const reportId = `report_official_paper_reconcile_${externalOrderId}`;
  db.prepare(`
    INSERT OR REPLACE INTO execution_reports
    (id, category, title, body, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    reportId,
    "trade",
    `Official Longbridge paper order reconciliation for ${symbol}`,
    buildReportBody({ ticketId, externalOrderId, symbol, side, quantity, limitPrice, brokerStatus, lifecycleStage, localStatus }),
    JSON.stringify({
      ticketId,
      externalOrderId,
      symbol,
      side,
      quantity,
      limitPrice,
      brokerStatus,
      lifecycleStage,
      localStatus,
      environment: "paper",
      provider: "longbridge-paper",
      accountMode: "paper",
      order,
      executions: matchingExecutions
    }),
    observedAt
  );

  saved.push({
    reportId,
    externalOrderId,
    ticketId,
    symbol,
    side,
    quantity,
    brokerStatus,
    lifecycleStage,
    localStatus,
    executions: matchingExecutions.length
  });
}

console.log(JSON.stringify({
  saved: saved.length,
  observedAt,
  orders: saved
}, null, 2));

function ensureLifecycleSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS official_paper_order_lifecycle (
      id TEXT PRIMARY KEY,
      ticket_id TEXT,
      external_order_id TEXT NOT NULL UNIQUE,
      provider TEXT NOT NULL,
      environment TEXT NOT NULL,
      account_mode TEXT NOT NULL,
      symbol TEXT NOT NULL,
      asset_class TEXT NOT NULL,
      side TEXT NOT NULL,
      quantity REAL NOT NULL,
      limit_price REAL,
      broker_status TEXT NOT NULL,
      local_status TEXT NOT NULL,
      lifecycle_stage TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      raw TEXT NOT NULL,
      notes TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS official_paper_order_lifecycle_status_idx
      ON official_paper_order_lifecycle(symbol, lifecycle_stage, last_observed_at);

    CREATE TABLE IF NOT EXISTS execution_reports (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      metadata TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

function findRecentTicketId(database, symbol) {
  const row = database
    .prepare(`
      SELECT json_extract(metadata, '$.ticketId') AS ticket_id
      FROM execution_reports
      WHERE category = 'trade'
        AND title = ?
      ORDER BY created_at DESC
      LIMIT 1
    `)
    .get(`Execution report for ${symbol}`);

  return row?.ticket_id ? String(row.ticket_id) : null;
}

function buildReportBody(input) {
  const lines = [
    `Ticket: ${input.ticketId ?? "unknown"}`,
    `External order id: ${input.externalOrderId}`,
    `Symbol: ${input.symbol}`,
    `Side: ${input.side}`,
    `Quantity: ${input.quantity}`,
    `Broker status: ${input.brokerStatus}`,
    `Lifecycle stage: ${input.lifecycleStage}`,
    `Local status: ${input.localStatus}`
  ];

  if (typeof input.limitPrice === "number") {
    lines.push(`Limit price: ${input.limitPrice.toFixed(2)}`);
  }

  lines.push(
    "",
    "Reasons:",
    "- Official Demo A/C order was found in Longbridge order list.",
    "- The order is recorded in SQLite official_paper_order_lifecycle.",
    "- This corrects prior local parser errors without submitting any new broker order."
  );

  return lines.join("\n");
}

function asArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (Array.isArray(value?.orders)) {
    return value.orders;
  }
  if (Array.isArray(value?.executions)) {
    return value.executions;
  }
  return [];
}

function normalizeSide(value) {
  const normalized = String(value ?? "").toLowerCase();
  return normalized === "sell" ? "sell" : "buy";
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function guessAssetClass(symbol) {
  return ["SPY.US", "QQQ.US", "IWM.US", "DIA.US"].includes(symbol) ? "etf" : "stock";
}

function mapBrokerStatusToStage(status) {
  const normalized = status.toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (["notreported", "submitted", "new", "waittosubmit", "waittoreport", "waittonew"].includes(normalized)) {
    return "submitted";
  }
  if (["pending", "partialfilled", "partiallyfilled", "partialdealt", "waittodeal"].includes(normalized)) {
    return "pending";
  }
  if (["filled", "fullfilled", "executed", "dealt"].includes(normalized)) {
    return "filled";
  }
  if (["cancelled", "canceled", "withdrawn", "deleted"].includes(normalized)) {
    return "cancelled";
  }
  if (["rejected", "failed", "expired"].includes(normalized)) {
    return "rejected";
  }
  return "unknown";
}

function mapLifecycleStageToLocalStatus(stage) {
  if (stage === "rejected") {
    return "rejected";
  }
  if (stage === "pending") {
    return "pending";
  }
  if (stage === "submitted") {
    return "submitted";
  }
  return "accepted";
}
