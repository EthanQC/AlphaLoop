import type { OrderTicket } from "@packages/shared-types";

const DEFAULT_SLIPPAGE = 0.03;

export function computeConservativeFill(ticket: OrderTicket): number {
  const quote = ticket.marketSnapshot;
  if (!quote) {
    throw new Error("Shadow execution requires marketSnapshot.");
  }

  if (ticket.side === "buy") {
    const base = quote.ask ?? quote.last ?? quote.bid;
    if (typeof base !== "number") {
      throw new Error("No usable ask/last/bid quote for buy-side fill.");
    }
    return roundCurrency(base + DEFAULT_SLIPPAGE);
  }

  const base = quote.bid ?? quote.last ?? quote.ask;
  if (typeof base !== "number") {
    throw new Error("No usable bid/last/ask quote for sell-side fill.");
  }
  return roundCurrency(Math.max(0.01, base - DEFAULT_SLIPPAGE));
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

