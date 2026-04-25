import {
  ShadowBookRepository,
  createId,
  nowIso,
  type ExecutionResult,
  type OrderTicket,
  type ShadowPosition
} from "@packages/shared-types";

import { computeConservativeFill } from "./fills.js";

export class OptionsShadowEngine {
  constructor(private readonly book: ShadowBookRepository) {}

  execute(ticket: OrderTicket): ExecutionResult {
    if (!ticket.optionContract || !ticket.strategy) {
      throw new Error("Shadow option execution requires optionContract and strategy.");
    }

    const fillPrice = computeConservativeFill(ticket);
    const closePositionId = typeof ticket.metadata?.closePositionId === "string" ? ticket.metadata.closePositionId : undefined;

    if (closePositionId) {
      const existing = this.book.getPosition(closePositionId);
      if (!existing) {
        throw new Error(`Shadow position ${closePositionId} not found.`);
      }

      const realizedPnl = calculateRealizedPnl(existing, fillPrice, ticket.quantity, ticket.side);
      const closedPosition: ShadowPosition = {
        ...existing,
        status: "closed",
        realizedPnl,
        updatedAt: nowIso()
      };
      this.book.openPosition(closedPosition);
      this.book.appendOrder({
        positionId: existing.id,
        ticketId: ticket.id,
        strategy: ticket.strategy,
        symbol: ticket.symbol,
        contract: ticket.optionContract,
        quantity: ticket.quantity,
        side: ticket.side,
        fillPrice,
        status: "closed",
        createdAt: nowIso()
      });

      return {
        ticketId: ticket.id,
        environment: "shadow",
        status: "simulated",
        provider: "options-shadow",
        externalOrderId: `shadow_${ticket.id}`,
        fillPrice,
        reasons: [
          `Closed shadow position ${existing.id}.`,
          `Realized PnL: ${realizedPnl.toFixed(2)} USD.`
        ]
      };
    }

    const position: ShadowPosition = {
      id: createId("shadow_position"),
      strategy: ticket.strategy,
      symbol: ticket.symbol,
      contract: ticket.optionContract,
      quantity: ticket.quantity,
      avgPrice: fillPrice,
      status: "open",
      realizedPnl: 0,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };

    this.book.openPosition(position);
    this.book.appendOrder({
      positionId: position.id,
      ticketId: ticket.id,
      strategy: ticket.strategy,
      symbol: ticket.symbol,
      contract: ticket.optionContract,
      quantity: ticket.quantity,
      side: ticket.side,
      fillPrice,
      status: "open",
      createdAt: nowIso()
    });

    return {
      ticketId: ticket.id,
      environment: "shadow",
      status: "simulated",
      provider: "options-shadow",
      externalOrderId: `shadow_${ticket.id}`,
      fillPrice,
      reasons: [
        `Opened shadow position ${position.id}.`,
        "Used conservative fill model (worse-side bid/ask plus fixed slippage)."
      ]
    };
  }

  expirePosition(positionId: string, settlementPrice?: number): ShadowPosition {
    const position = this.book.getPosition(positionId);
    if (!position) {
      throw new Error(`Shadow position ${positionId} not found.`);
    }

    const expired: ShadowPosition = {
      ...position,
      status: "expired",
      realizedPnl:
        position.strategy === "long_call" || position.strategy === "long_put"
          ? -position.avgPrice * position.quantity * position.contract.multiplier
          : position.realizedPnl,
      updatedAt: nowIso()
    };

    this.book.openPosition(expired);
    this.book.appendOrder({
      positionId,
      ticketId: createId("expire"),
      strategy: position.strategy,
      symbol: position.symbol,
      contract: position.contract,
      quantity: position.quantity,
      side: "sell",
      fillPrice: settlementPrice ?? 0,
      status: "expired",
      createdAt: nowIso()
    });

    return expired;
  }

  assignPosition(positionId: string, settlementPrice?: number): ShadowPosition {
    const position = this.book.getPosition(positionId);
    if (!position) {
      throw new Error(`Shadow position ${positionId} not found.`);
    }

    const assigned: ShadowPosition = {
      ...position,
      status: "assigned",
      realizedPnl:
        position.strategy === "covered_call" || position.strategy === "cash_secured_put"
          ? position.avgPrice * position.quantity * position.contract.multiplier
          : position.realizedPnl,
      updatedAt: nowIso()
    };

    this.book.openPosition(assigned);
    this.book.appendOrder({
      positionId,
      ticketId: createId("assign"),
      strategy: position.strategy,
      symbol: position.symbol,
      contract: position.contract,
      quantity: position.quantity,
      side: "sell",
      fillPrice: settlementPrice ?? 0,
      status: "assigned",
      createdAt: nowIso()
    });

    return assigned;
  }
}

function calculateRealizedPnl(
  position: ShadowPosition,
  exitPrice: number,
  quantity: number,
  side: OrderTicket["side"]
): number {
  const multiplier = position.contract.multiplier;
  if (position.strategy === "long_call" || position.strategy === "long_put") {
    return (exitPrice - position.avgPrice) * quantity * multiplier;
  }

  if (side === "buy") {
    return (position.avgPrice - exitPrice) * quantity * multiplier;
  }

  return (exitPrice - position.avgPrice) * quantity * multiplier;
}
