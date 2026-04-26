import type { ExecutionResult, OrderTicket } from "@packages/shared-types";

export const LIVE_EXECUTION_ENABLED = false;
export const OPTION_AUTOMATION_ENABLED = false;

export function rejectDisabledExecution(ticket: OrderTicket): ExecutionResult | null {
  if (ticket.environment === "live") {
    return rejected(ticket, [
      "Live execution is disabled by the trading constitution.",
      "Real-money flows stop at structured advice cards and explicit human review."
    ]);
  }

  if (ticket.assetClass === "option") {
    return rejected(ticket, [
      "Option automation is disabled by operator policy.",
      "The trading stack only accepts stock and ETF tickets for automated execution."
    ]);
  }

  if (ticket.environment === "shadow") {
    return rejected(ticket, [
      "Shadow execution is disabled by operator policy.",
      "Historical option simulation records are read-only and must not create new automated tickets."
    ]);
  }

  return null;
}

function rejected(ticket: OrderTicket, reasons: string[]): ExecutionResult {
  return {
    ticketId: ticket.id,
    environment: ticket.environment,
    status: "rejected",
    provider: "broker-executor",
    reasons
  };
}
