import { describe, expect, it } from "vitest";

import type { OrderTicket } from "@packages/shared-types";

import { rejectDisabledExecution } from "./execution-guards.js";

describe("execution boundary guards", () => {
  it("rejects option tickets before any broker write path", () => {
    const result = rejectDisabledExecution({
      ...baseTicket(),
      assetClass: "option",
      strategy: "long_call"
    });

    expect(result?.status).toBe("rejected");
    expect(result?.reasons.join(" ")).toMatch(/期权自动化/u);
  });

  it("rejects live tickets before any broker write path", () => {
    const result = rejectDisabledExecution({
      ...baseTicket(),
      environment: "live"
    });

    expect(result?.status).toBe("rejected");
    expect(result?.reasons.join(" ")).toMatch(/实盘自动执行/u);
  });

  it("rejects shadow tickets before any broker write path", () => {
    const result = rejectDisabledExecution({
      ...baseTicket(),
      environment: "shadow"
    });

    expect(result?.status).toBe("rejected");
    expect(result?.reasons.join(" ")).toMatch(/影子执行/u);
  });
});

function baseTicket(): OrderTicket {
  return {
    id: "ticket_guard_test",
    source: "test",
    submittedAt: new Date().toISOString(),
    environment: "paper",
    assetClass: "stock",
    symbol: "AAPL",
    side: "buy",
    quantity: 1,
    conviction: "normal",
    notionalUsd: 100,
    marketSnapshot: {
      last: 100,
      timestamp: new Date().toISOString()
    },
    metadata: {
      accountNetLiq: 100_000,
      currentOpenIdeas: 0,
      currentHighConvictionIdeas: 0,
      dailyNewRiskPercent: 0
    }
  };
}
