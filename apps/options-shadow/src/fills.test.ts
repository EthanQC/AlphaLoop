import { describe, expect, it } from "vitest";

import { computeConservativeFill } from "./fills.js";

describe("computeConservativeFill", () => {
  it("uses ask plus slippage for buy tickets", () => {
    expect(
      computeConservativeFill({
        id: "ticket_buy",
        source: "test",
        submittedAt: new Date().toISOString(),
        environment: "shadow",
        assetClass: "option",
        symbol: "AAPL",
        side: "buy",
        quantity: 1,
        conviction: "normal",
        notionalUsd: 120,
        strategy: "long_call",
        optionContract: {
          underlying: "AAPL",
          optionType: "call",
          expiration: "2026-06-19",
          strike: 250,
          multiplier: 100
        },
        marketSnapshot: {
          bid: 1.15,
          ask: 1.25,
          timestamp: new Date().toISOString()
        }
      })
    ).toBe(1.28);
  });

  it("uses bid minus slippage for sell tickets", () => {
    expect(
      computeConservativeFill({
        id: "ticket_sell",
        source: "test",
        submittedAt: new Date().toISOString(),
        environment: "shadow",
        assetClass: "option",
        symbol: "AAPL",
        side: "sell",
        quantity: 1,
        conviction: "normal",
        notionalUsd: 120,
        strategy: "covered_call",
        optionContract: {
          underlying: "AAPL",
          optionType: "call",
          expiration: "2026-06-19",
          strike: 250,
          multiplier: 100
        },
        marketSnapshot: {
          bid: 1.25,
          ask: 1.35,
          timestamp: new Date().toISOString()
        }
      })
    ).toBe(1.22);
  });
});
