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
      },
      {
        accountNetLiq: 100_000,
        currentExposureUsd: 1_000,
        fetchedAt: new Date().toISOString()
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
      },
      {
        accountNetLiq: 100_000,
        currentExposureUsd: 1_000,
        fetchedAt: new Date().toISOString()
      }
    );

    expect(result.status).toBe("require_review");
  });

  it("blocks OpenClaw official paper exposure above 10% of total account value", () => {
    const result = evaluateRisk(
      {
        id: "ticket_3",
        source: "openclaw-official-paper",
        submittedAt: new Date().toISOString(),
        environment: "paper",
        assetClass: "stock",
        symbol: "NVDA",
        side: "buy",
        quantity: 3,
        conviction: "normal",
        notionalUsd: 1_500,
        metadata: {
          accountNetLiq: 100_000,
          officialPaperCurrentExposureUsd: 9_000,
          openclawPaperBudgetPercent: 10,
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
      },
      {
        accountNetLiq: 100_000,
        currentExposureUsd: 9_000,
        fetchedAt: new Date().toISOString()
      }
    );

    expect(result.status).toBe("block");
    expect(result.reasons.join(" ")).toMatch(/10\.00%|OpenClaw 官方模拟盘预算/u);
  });

  it("rejects paper buys when trusted official paper account facts are missing", () => {
    const result = evaluateRisk(
      {
        id: "ticket_missing_facts",
        source: "openclaw-official-paper",
        submittedAt: new Date().toISOString(),
        environment: "paper",
        assetClass: "stock",
        symbol: "NVDA",
        side: "buy",
        quantity: 1,
        conviction: "normal",
        notionalUsd: 500
      },
      baseRules()
    );

    expect(result.status).toBe("block");
    expect(result.reasons.join(" ")).toMatch(/trusted official paper account snapshot|官方模拟盘账户快照/u);
  });

  it("uses trusted official paper account facts instead of caller-supplied exposure metadata", () => {
    const result = evaluateRisk(
      {
        id: "ticket_untrusted_metadata",
        source: "openclaw-official-paper",
        submittedAt: new Date().toISOString(),
        environment: "paper",
        assetClass: "stock",
        symbol: "NVDA",
        side: "buy",
        quantity: 1,
        conviction: "normal",
        notionalUsd: 1_500,
        metadata: {
          accountNetLiq: 1_000_000,
          officialPaperCurrentExposureUsd: 0
        }
      },
      baseRules(),
      {
        accountNetLiq: 100_000,
        currentExposureUsd: 9_000,
        fetchedAt: new Date().toISOString()
      }
    );

    expect(result.status).toBe("block");
    expect(result.reasons.join(" ")).toMatch(/10\.00%|OpenClaw 官方模拟盘预算/u);
  });

  it("does not block de-risking sells only because the official paper budget is already over 10%", () => {
    const result = evaluateRisk(
      {
        id: "ticket_derisk_sell",
        source: "openclaw-official-paper",
        submittedAt: new Date().toISOString(),
        environment: "paper",
        assetClass: "stock",
        symbol: "NVDA",
        side: "sell",
        quantity: 1,
        conviction: "normal",
        notionalUsd: 1_000
      },
      baseRules(),
      {
        accountNetLiq: 100_000,
        currentExposureUsd: 12_000,
        fetchedAt: new Date().toISOString()
      }
    );

    expect(result.reasons.join(" ")).not.toMatch(/OpenClaw 官方模拟盘预算/u);
  });
});

function baseRules() {
  return {
    version: "v1.0.0",
    scope: "paper" as const,
    maxIdeaExposurePercent: 10,
    maxHighConvictionExposurePercent: 15,
    maxConcurrentIdeas: 8,
    maxHighConvictionIdeas: 2,
    maxDailyNewRiskPercent: 20,
    allowedOptionStrategies: ["covered_call", "cash_secured_put", "long_call", "long_put"] as const,
    notes: []
  };
}
