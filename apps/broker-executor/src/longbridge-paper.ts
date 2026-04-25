import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

import type {
  ExecutionResult,
  ExecutionResultStatus,
  JsonValue,
  LongbridgeAuthState,
  OfficialPaperOrderLifecycleStage,
  OrderTicket
} from "@packages/shared-types";

export function simulateLongbridgePaperExecution(
  ticket: OrderTicket,
  longbridgeAuth?: LongbridgeAuthState
): ExecutionResult {
  const marketPrice =
    ticket.side === "buy"
      ? ticket.marketSnapshot?.ask ?? ticket.marketSnapshot?.last ?? ticket.marketSnapshot?.bid
      : ticket.marketSnapshot?.bid ?? ticket.marketSnapshot?.last ?? ticket.marketSnapshot?.ask;

  return {
    ticketId: ticket.id,
    environment: "paper",
    status: "accepted",
    provider: "longbridge-paper",
    externalOrderId: `paper_${ticket.id}`,
    ...(typeof marketPrice === "number" ? { fillPrice: marketPrice } : {}),
    reasons: [
      "Paper execution accepted by local broker-executor stub.",
      longbridgeAuth?.configured
        ? `Longbridge OpenAPI auth is available via ${longbridgeAuth.source}, but the paper write path is still routed through the local execution stub.`
        : "Longbridge OpenAPI auth was not detected; execution remains fully local."
    ]
  };
}

export function executeLongbridgePaperOrder(
  ticket: OrderTicket,
  longbridgeAuth?: LongbridgeAuthState
): ExecutionResult {
  const guardFailure = validateOfficialPaperGuard();
  if (guardFailure) {
    if (process.env.LONGBRIDGE_OFFICIAL_PAPER_ENABLED !== "true") {
      return simulateLongbridgePaperExecution(ticket, longbridgeAuth);
    }

    return {
      ticketId: ticket.id,
      environment: "paper",
      status: "rejected",
      provider: "longbridge-paper",
      reasons: guardFailure
    };
  }

  if (process.env.LONGBRIDGE_OFFICIAL_PAPER_ENABLED !== "true") {
    return simulateLongbridgePaperExecution(ticket, longbridgeAuth);
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
        "Official Longbridge paper execution requires a positive limit price from the ticket market snapshot."
      ]
    };
  }

  try {
    const observedAt = new Date().toISOString();
    const output = execFileSync(resolveLongbridgeCli(), [
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
      env: buildLongbridgeCliEnv()
    });
    const submissionPayload = parseLongbridgeOutput(output);
    const externalOrderId = extractOrderId(submissionPayload);
    const detailPayload = externalOrderId ? readOrderDetail(externalOrderId) : undefined;
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
          ? `Official Longbridge paper order was submitted through the local broker-executor with order_id ${externalOrderId}.`
          : "Official Longbridge paper order command completed, but no order_id was found in CLI output.",
        brokerStatus
          ? `Longbridge broker status is ${brokerStatus}; local status is ${status}.`
          : `Longbridge broker status was not present; local status is ${status}.`,
        "This path is gated by LONGBRIDGE_OFFICIAL_PAPER_ENABLED=true and LONGBRIDGE_ACCOUNT_MODE=paper."
      ]
    });
  } catch (error) {
    const observedAt = new Date().toISOString();
    const output = collectProcessOutput(error);
    const payload = parseLongbridgeOutput(output);
    const externalOrderId = extractOrderId(payload);

    if (externalOrderId) {
      const brokerStatus = extractBrokerStatus(payload);
      const brokerOrderStage = brokerStatus ? mapBrokerStatusToStage(brokerStatus) : "submitted";
      const status = mapBrokerStageToExecutionStatus(brokerOrderStage, true);

      return compactExecutionResult({
        ticketId: ticket.id,
        environment: "paper",
        status,
        provider: "longbridge-paper",
        externalOrderId,
        limitPrice: price,
        brokerStatus,
        brokerOrderStage,
        submittedAt: ticket.submittedAt,
        observedAt,
        rawBrokerPayload: toJsonValue(payload),
        reasons: [
          `Official Longbridge paper order returned a non-zero CLI exit, but order_id ${externalOrderId} was found in CLI output.`,
          brokerStatus
            ? `Longbridge broker status is ${brokerStatus}; local status is ${status}.`
            : `Longbridge broker status was not present; local status is ${status}.`
        ]
      });
    }

    return compactExecutionResult({
      ticketId: ticket.id,
      environment: "paper",
      status: "rejected",
      provider: "longbridge-paper",
      limitPrice: price,
      observedAt,
      rawBrokerPayload: toJsonValue(payload),
      reasons: [
        `Official Longbridge paper order submission failed: ${(error as Error).message}`
      ]
    });
  }
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

export function mapBrokerStatusToStage(status: string): OfficialPaperOrderLifecycleStage {
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

  if (process.env.LONGBRIDGE_ACCOUNT_MODE !== "paper") {
    reasons.push("Official Longbridge paper execution requires LONGBRIDGE_ACCOUNT_MODE=paper.");
  }

  if (process.env.ALLOW_LIVE_EXECUTION === "true") {
    reasons.push("Official paper execution is refused while ALLOW_LIVE_EXECUTION=true; live-money flows must remain off.");
  }

  return reasons.length > 0 ? reasons : undefined;
}

function readOrderDetail(orderId: string): unknown | undefined {
  try {
    const output = execFileSync(resolveLongbridgeCli(), [
      "order",
      "detail",
      orderId,
      "--format",
      "json"
    ], {
      encoding: "utf8",
      env: buildLongbridgeCliEnv()
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

function collectProcessOutput(error: unknown): string {
  const candidate = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
  const parts = [candidate.stdout, candidate.stderr, candidate.message]
    .map((value) => typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "")
    .filter(Boolean);

  return parts.join("\n");
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
