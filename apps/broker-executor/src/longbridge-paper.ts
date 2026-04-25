import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

import type { ExecutionResult, LongbridgeAuthState, OrderTicket } from "@packages/shared-types";

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
  if (process.env.LONGBRIDGE_OFFICIAL_PAPER_ENABLED !== "true" || process.env.LONGBRIDGE_ACCOUNT_MODE !== "paper") {
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
    const payload = parseLongbridgeOutput(output);

    const externalOrderId = extractOrderId(payload);
    return {
      ticketId: ticket.id,
      environment: "paper",
      status: "accepted",
      provider: "longbridge-paper",
      ...(externalOrderId ? { externalOrderId } : {}),
      fillPrice: price,
      reasons: [
        "Official Longbridge paper order was submitted through the local broker-executor.",
        "This path is gated by LONGBRIDGE_OFFICIAL_PAPER_ENABLED=true and LONGBRIDGE_ACCOUNT_MODE=paper."
      ]
    };
  } catch (error) {
    return {
      ticketId: ticket.id,
      environment: "paper",
      status: "rejected",
      provider: "longbridge-paper",
      reasons: [
        `Official Longbridge paper order submission failed: ${(error as Error).message}`
      ]
    };
  }
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

function extractOrderId(payload: unknown): string | undefined {
  if (typeof payload === "string") {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const candidate = payload as Record<string, unknown>;
  for (const key of ["order_id", "orderId", "id"]) {
    if (typeof candidate[key] === "string") {
      return candidate[key] as string;
    }
  }
  return undefined;
}

function parseLongbridgeOutput(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const jsonStart = Math.min(
      ...["{", "["]
        .map((marker) => trimmed.indexOf(marker))
        .filter((index) => index >= 0)
    );
    if (Number.isFinite(jsonStart)) {
      try {
        return JSON.parse(trimmed.slice(jsonStart));
      } catch {
        // Fall through to regex extraction.
      }
    }
  }

  const idMatch = /order[_\s-]?id["'\s:=]+([0-9A-Za-z-]+)/iu.exec(trimmed);
  if (idMatch?.[1]) {
    return { order_id: idMatch[1] };
  }

  return {
    raw: trimmed
  };
}

function resolveLongbridgeCli(): string {
  return process.env.LONGBRIDGE_CLI_PATH ?? `${homedir()}/.local/bin/longbridge`;
}
