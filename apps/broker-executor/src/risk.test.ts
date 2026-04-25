import { describe, expect, it } from "vitest";

import { evaluateRisk } from "./risk.js";

describe("evaluateRisk", () => {
  it("blocks oversized ideas", () => {
    const result = evaluateRisk(
      {
        id: "ticket_1",
        source: "test",
        submittedAt: new Date().toISOString(),
        environment: "paper",
        assetClass: "stock",
        symbol: "AAPL",
        side: "buy",
        quantity: 10,
        conviction: "normal",
        notionalUsd: 15_000,
        metadata: {
          accountNetLiq: 100_000,
          currentOpenIdeas: 1,
          currentHighConvictionIdeas: 0,
          dailyNewRiskPercent: 0
        }
      },
      {
        version: "v1.0.0",
        scope: "paper",
        maxIdeaExposurePercent: 10,
        maxHighConvictionExposurePercent: 15,
        maxConcurrentIdeas: 8,
        maxHighConvictionIdeas: 2,
        maxDailyNewRiskPercent: 20,
        allowedOptionStrategies: ["covered_call", "cash_secured_put", "long_call", "long_put"],
        notes: []
      }
    );

    expect(result.status).toBe("block");
  });

  it("requires review when daily risk budget would be exceeded", () => {
    const result = evaluateRisk(
      {
        id: "ticket_2",
        source: "test",
        submittedAt: new Date().toISOString(),
        environment: "paper",
        assetClass: "stock",
        symbol: "TSLA",
        side: "buy",
        quantity: 10,
        conviction: "high",
        notionalUsd: 5_000,
        metadata: {
          accountNetLiq: 100_000,
          currentOpenIdeas: 1,
          currentHighConvictionIdeas: 1,
          dailyNewRiskPercent: 18
        }
      },
      {
        version: "v1.0.0",
        scope: "paper",
        maxIdeaExposurePercent: 10,
        maxHighConvictionExposurePercent: 15,
        maxConcurrentIdeas: 8,
        maxHighConvictionIdeas: 2,
        maxDailyNewRiskPercent: 20,
        allowedOptionStrategies: ["covered_call", "cash_secured_put", "long_call", "long_put"],
        notes: []
      }
    );

    expect(result.status).toBe("require_review");
  });
});
