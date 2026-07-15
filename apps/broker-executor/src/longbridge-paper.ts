import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

import type {
  ExecutionResult,
  ExecutionResultStatus,
  JsonValue,
  OfficialPaperOrderLifecycleStage,
  OrderTicket
} from "@packages/shared-types";

import { mapBrokerStatusToStage as mapBrokerStatusToStageDetailed } from "./broker-status-map.js";

// Phase 6 Task 4 (2026-07-15 plan): the shape execFileSync itself has, narrowed
// to exactly what this module calls it with - lets tests inject a fake (no
// real longbridge CLI, no real subprocess) without reaching for module
// mocking. The real default IS execFileSync; its actual signature is
// structurally compatible with this narrower one.
export type LongbridgeExecFn = (
  command: string,
  args: readonly string[],
  options: { encoding: "utf8"; env: NodeJS.ProcessEnv; timeout: number }
) => string;

// Global Constraint ⑥: execFileSync now always carries an explicit timeout
// (LONGBRIDGE_CLI_TIMEOUT_MS, default 45s) - previously unbounded, a hung CLI
// process could block this whole (single-threaded) HTTP server forever.
function resolveCliTimeoutMs(): number {
  const raw = Number(process.env.LONGBRIDGE_CLI_TIMEOUT_MS ?? 45_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 45_000;
}

export function executeLongbridgePaperOrder(
  ticket: OrderTicket,
  execFn: LongbridgeExecFn = execFileSync
): ExecutionResult {
  if (ticket.environment !== "paper") {
    return {
      ticketId: ticket.id,
      environment: ticket.environment,
      status: "rejected",
      provider: "longbridge-paper",
      reasons: [
        "长桥官方模拟盘执行只接受 paper 环境工单。"
      ]
    };
  }

  if (ticket.assetClass !== "stock" && ticket.assetClass !== "etf") {
    return {
      ticketId: ticket.id,
      environment: ticket.environment,
      status: "rejected",
      provider: "longbridge-paper",
      reasons: [
        "长桥官方模拟盘执行只接受股票和 ETF 工单。",
        "期权自动化已按操作策略禁用。"
      ]
    };
  }

  const guardFailure = validateOfficialPaperGuard();
  if (guardFailure) {
    return {
      ticketId: ticket.id,
      environment: "paper",
      status: "rejected",
      provider: "longbridge-paper",
      reasons: guardFailure
    };
  }

  const price = ticket.side === "buy"
    ? ticket.marketSnapshot?.ask ?? ticket.marketSnapshot?.last
    : ticket.marketSnapshot?.bid ?? ticket.marketSnapshot?.last;

  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    return {
      ticketId: ticket.id,
      environment: "paper",
      status: "rejected",
      provider: "longbridge-paper",
      reasons: [
        "长桥官方模拟盘执行需要工单行情快照提供正数限价。"
      ]
    };
  }

  // Phase 6 Task 4 (2026-07-15 plan), Global Constraint ⑥: this call is
  // DELIBERATELY no longer wrapped in a try/catch that salvages a synthetic
  // "submitted"/"accepted" ExecutionResult out of a non-zero exit code. A
  // throw here (spawn failure, non-zero exit, or - now that `timeout` is
  // always passed - a killed-for-timeout process) propagates straight to the
  // caller: broker-executor's /v1/tickets handler is the one place that
  // decides what a failed CLI call means for the ALREADY-RECORDED lifecycle
  // row (record-before-execute: the row exists before this call ever runs),
  // and per the plan that meaning is uniformly "submit_unconfirmed" - the
  // order MAY exist at the broker despite the bad exit code, so this module
  // must not guess "probably fine" from whatever text happened to be in the
  // failed process's stdout/stderr. `readOrderDetail` below is a SEPARATE,
  // best-effort call made only after a confirmed-successful submit - its own
  // internal try/catch (swallow-and-continue) is unchanged, since a detail
  // lookup failing after a known-good order_id does not cast doubt on the
  // order's existence the way a failed SUBMIT call does.
  const observedAt = new Date().toISOString();
  const output = execFn(resolveLongbridgeCli(), [
    "order",
    ticket.side,
    ticket.symbol,
    String(ticket.quantity),
    "--price",
    price.toFixed(2),
    "--order-type",
    "LO",
    "--tif",
    "Day",
    "--remark",
    `OpenClaw paper ${ticket.id}`.slice(0, 255),
    "--yes",
    "--format",
    "json"
  ], {
    encoding: "utf8",
    env: buildLongbridgeCliEnv(),
    timeout: resolveCliTimeoutMs()
  });
  const submissionPayload = parseLongbridgeOutput(output);
  const externalOrderId = extractOrderId(submissionPayload);
  const detailPayload = externalOrderId ? readOrderDetail(externalOrderId, execFn) : undefined;
  const statusPayload = detailPayload ?? submissionPayload;
  const brokerStatus = extractBrokerStatus(statusPayload);
  const brokerOrderStage = brokerStatus
    ? mapBrokerStatusToStage(brokerStatus)
    : externalOrderId ? "submitted" : "unknown";
  const status = mapBrokerStageToExecutionStatus(brokerOrderStage, Boolean(externalOrderId));
  const fillPrice = brokerOrderStage === "filled" ? extractFillPrice(statusPayload) : undefined;

  return compactExecutionResult({
    ticketId: ticket.id,
    environment: "paper",
    status,
    provider: "longbridge-paper",
    externalOrderId,
    fillPrice,
    limitPrice: price,
    brokerStatus,
    brokerOrderStage,
    submittedAt: ticket.submittedAt,
    observedAt,
    rawBrokerPayload: toJsonValue({
      submission: submissionPayload,
      detail: detailPayload ?? null
    }),
    reasons: [
      externalOrderId
        ? `长桥官方模拟盘订单已通过本地 broker-executor 提交，order_id 为 ${externalOrderId}。`
        : "长桥官方模拟盘订单命令已完成，但 CLI 输出中没有找到 order_id。",
      brokerStatus
        ? `长桥券商状态为 ${brokerStatus}；本地状态为 ${status}。`
        : `长桥券商状态未返回；本地状态为 ${status}。`,
      "该路径受 LONGBRIDGE_OFFICIAL_PAPER_ENABLED=true、LONGBRIDGE_ACCOUNT_MODE=paper、ALLOW_LIVE_EXECUTION=false 共同保护。"
    ]
  });
}

export function parseLongbridgeOutput(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) {
    return {};
  }

  const exact = parseJson(trimmed);
  if (exact !== undefined) {
    return exact;
  }

  const embedded = parseFirstEmbeddedJson(trimmed);
  if (embedded !== undefined) {
    return embedded;
  }

  const idMatch = /order[_\s-]?id["'\s:=：]+([0-9A-Za-z-]+)/iu.exec(trimmed);
  if (idMatch?.[1]) {
    return { order_id: idMatch[1], raw: trimmed };
  }

  return {
    raw: trimmed
  };
}

export function extractOrderId(payload: unknown): string | undefined {
  return findStringValue(payload, ["order_id", "orderId", "orderID", "id"]);
}

export function extractBrokerStatus(payload: unknown): string | undefined {
  return findStringValue(payload, ["status", "order_status", "orderStatus", "orderStatusText"]);
}

// Phase 6 Task 5 (2026-07-15 plan): the status table itself now lives in
// ./broker-status-map.ts (the single source shared with the reconcile
// rebuild's .mjs port - see that module's doc comment). This wrapper keeps
// the PRE-Task-5 signature (a bare OfficialPaperOrderLifecycleStage, not the
// shared module's `{stage, localStatus}` object) so every existing call site
// and test in this file (`mapBrokerStatusToStage("Pending")).toBe("pending")`
// etc.) is unaffected - only the table backing it moved.
export function mapBrokerStatusToStage(status: string): OfficialPaperOrderLifecycleStage {
  return mapBrokerStatusToStageDetailed(status).stage;
}

function buildLongbridgeCliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "LONGBRIDGE_ACCESS_TOKEN",
    "LONGPORT_ACCESS_TOKEN"
  ]) {
    if (!env[key]?.trim()) {
      delete env[key];
    }
  }
  return env;
}

function resolveLongbridgeCli(): string {
  return process.env.LONGBRIDGE_CLI_PATH ?? `${homedir()}/.local/bin/longbridge`;
}

function validateOfficialPaperGuard(): string[] | undefined {
  const reasons: string[] = [];

  if (process.env.LONGBRIDGE_OFFICIAL_PAPER_ENABLED !== "true") {
    reasons.push("长桥官方模拟盘执行要求 LONGBRIDGE_OFFICIAL_PAPER_ENABLED=true。");
  }

  if (process.env.LONGBRIDGE_ACCOUNT_MODE !== "paper") {
    reasons.push("长桥官方模拟盘执行要求 LONGBRIDGE_ACCOUNT_MODE=paper。");
  }

  if (process.env.ALLOW_LIVE_EXECUTION !== "false") {
    reasons.push("长桥官方模拟盘执行要求 ALLOW_LIVE_EXECUTION=false。");
  }

  return reasons.length > 0 ? reasons : undefined;
}

function readOrderDetail(orderId: string, execFn: LongbridgeExecFn): unknown | undefined {
  try {
    const output = execFn(resolveLongbridgeCli(), [
      "order",
      "detail",
      orderId,
      "--format",
      "json"
    ], {
      encoding: "utf8",
      env: buildLongbridgeCliEnv(),
      timeout: resolveCliTimeoutMs()
    });

    return parseLongbridgeOutput(output);
  } catch {
    return undefined;
  }
}

function mapBrokerStageToExecutionStatus(
  stage: OfficialPaperOrderLifecycleStage,
  hasExternalOrderId: boolean
): ExecutionResultStatus {
  if (stage === "rejected") {
    return "rejected";
  }

  if (stage === "pending") {
    return "pending";
  }

  if (stage === "filled" || stage === "cancelled") {
    return "accepted";
  }

  if (stage === "submitted" || hasExternalOrderId) {
    return "submitted";
  }

  return "pending";
}

function extractFillPrice(payload: unknown): number | undefined {
  const raw = findStringValue(payload, ["executed_price", "executedPrice", "avg_price", "avgPrice", "price"]);
  if (!raw || raw === "-") {
    return undefined;
  }

  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function findStringValue(payload: unknown, keys: string[]): string | undefined {
  if (typeof payload === "string") {
    return payload.trim() ? payload : undefined;
  }

  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const value = findStringValue(entry, keys);
      if (value) {
        return value;
      }
    }
    return undefined;
  }

  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const candidate = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = candidate[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  for (const value of Object.values(candidate)) {
    const nested = findStringValue(value, keys);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseFirstEmbeddedJson(text: string): unknown | undefined {
  for (let index = 0; index < text.length; index += 1) {
    const marker = text[index];
    if (marker !== "{" && marker !== "[") {
      continue;
    }

    const jsonText = readBalancedJson(text, index);
    if (!jsonText) {
      continue;
    }

    const parsed = parseJson(jsonText);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
}

function readBalancedJson(text: string, start: number): string | undefined {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }

    if (char === "}" || char === "]") {
      const expected = stack.pop();
      if (expected !== char) {
        return undefined;
      }

      if (stack.length === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function compactExecutionResult(
  result: Pick<ExecutionResult, "ticketId" | "environment" | "status" | "provider" | "reasons"> &
    Record<string, unknown>
): ExecutionResult {
  return Object.fromEntries(
    Object.entries(result).filter(([, value]) => value !== undefined)
  ) as unknown as ExecutionResult;
}
