import {
  PaperBookRepository,
  createId,
  nowIso,
  type ExecutionResult,
  type EquityAssetClass,
  type OrderTicket,
  type PaperPosition
} from "@packages/shared-types";

const DEFAULT_SLIPPAGE = 0.02;

export class PaperExecutionEngine {
  constructor(private readonly book: PaperBookRepository) {}

  execute(ticket: OrderTicket): ExecutionResult {
    const assetClass = assertPaperAssetClass(ticket);
    const fillPrice = computePaperFill(ticket);
    const existing = this.book.getOpenPositionBySymbol(ticket.symbol);
    const createdAt = nowIso();

    if (ticket.side === "buy") {
      const nextPosition = existing
        ? mergeIntoOpenPosition(existing, ticket.quantity, fillPrice, createdAt)
        : createOpenPosition(ticket, assetClass, fillPrice, createdAt);

      this.book.upsertPosition(nextPosition);
      this.book.appendOrder({
        positionId: nextPosition.id,
        ticketId: ticket.id,
        symbol: ticket.symbol,
        assetClass,
        quantity: ticket.quantity,
        side: ticket.side,
        fillPrice,
        status: "open",
        createdAt
      });

      return {
        ticketId: ticket.id,
        environment: "paper",
        status: "accepted",
        provider: "paper-sim",
        externalOrderId: `paper_${ticket.id}`,
        fillPrice,
        reasons: [
          existing
            ? `Added ${ticket.quantity} shares to existing paper position ${nextPosition.id}.`
            : `Opened paper position ${nextPosition.id}.`,
          "Equity paper execution is simulated locally to guarantee automation never touches the live broker."
        ]
      };
    }

    if (!existing) {
      return {
        ticketId: ticket.id,
        environment: "paper",
        status: "rejected",
        provider: "paper-sim",
        reasons: [`No open paper position found for ${ticket.symbol}.`]
      };
    }

    const sellQuantity = Math.min(ticket.quantity, existing.quantity);
    const remainingQuantity = existing.quantity - sellQuantity;
    const realizedPnl = existing.realizedPnl + (fillPrice - existing.avgPrice) * sellQuantity;
    const nextPosition: PaperPosition = {
      ...existing,
      quantity: remainingQuantity,
      status: remainingQuantity > 0 ? "open" : "closed",
      realizedPnl: roundCurrency(realizedPnl),
      updatedAt: createdAt
    };

    this.book.upsertPosition(nextPosition);
    this.book.appendOrder({
      positionId: existing.id,
      ticketId: ticket.id,
      symbol: ticket.symbol,
      assetClass,
      quantity: sellQuantity,
      side: ticket.side,
      fillPrice,
      status: nextPosition.status,
      createdAt
    });

    return {
      ticketId: ticket.id,
      environment: "paper",
      status: "accepted",
      provider: "paper-sim",
      externalOrderId: `paper_${ticket.id}`,
      fillPrice,
      reasons: [
        remainingQuantity > 0
          ? `Reduced paper position ${existing.id} to ${remainingQuantity} shares.`
          : `Closed paper position ${existing.id}.`,
        `Realized PnL is now ${nextPosition.realizedPnl.toFixed(2)} USD.`
      ]
    };
  }
}

function createOpenPosition(
  ticket: OrderTicket,
  assetClass: EquityAssetClass,
  fillPrice: number,
  createdAt: string
): PaperPosition {
  return {
    id: createId("paper_position"),
    symbol: ticket.symbol,
    assetClass,
    quantity: ticket.quantity,
    avgPrice: fillPrice,
    status: "open",
    realizedPnl: 0,
    createdAt,
    updatedAt: createdAt
  };
}

function mergeIntoOpenPosition(
  existing: PaperPosition,
  quantity: number,
  fillPrice: number,
  updatedAt: string
): PaperPosition {
  const totalQuantity = existing.quantity + quantity;
  const weightedPrice =
    (existing.avgPrice * existing.quantity + fillPrice * quantity) / Math.max(1, totalQuantity);

  return {
    ...existing,
    quantity: totalQuantity,
    avgPrice: roundCurrency(weightedPrice),
    updatedAt
  };
}

function computePaperFill(ticket: OrderTicket): number {
  const quote = ticket.marketSnapshot;
  if (!quote) {
    throw new Error("Paper execution requires marketSnapshot.");
  }

  if (ticket.side === "buy") {
    const base = quote.ask ?? quote.last ?? quote.bid;
    if (typeof base !== "number") {
      throw new Error("No usable ask/last/bid quote for buy-side paper fill.");
    }
    return roundCurrency(base + DEFAULT_SLIPPAGE);
  }

  const base = quote.bid ?? quote.last ?? quote.ask;
  if (typeof base !== "number") {
    throw new Error("No usable bid/last/ask quote for sell-side paper fill.");
  }

  return roundCurrency(Math.max(0.01, base - DEFAULT_SLIPPAGE));
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function assertPaperAssetClass(ticket: OrderTicket): EquityAssetClass {
  if (ticket.assetClass === "stock" || ticket.assetClass === "etf") {
    return ticket.assetClass;
  }

  throw new Error("Paper execution only supports stock and ETF tickets.");
}
