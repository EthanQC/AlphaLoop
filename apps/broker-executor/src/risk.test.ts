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

  it("blocks a second 9.5% order once the first's OPEN (not-yet-filled) notional is counted against the same account snapshot (Global Constraint ④)", () => {
    // The account snapshot alone (currentExposureUsd: 0) would make a lone
    // 9.5% order look fine - the whole point of this test is that
    // openOrdersNotionalUsd (the first order's still-open notional) must be
    // added BEFORE the 10% check, so the second 9.5% order is blocked.
    const firstOrder = evaluateRisk(
      {
        id: "ticket_open_1",
        source: "openclaw-official-paper",
        submittedAt: new Date().toISOString(),
        environment: "paper",
        assetClass: "stock",
        side: "buy",
        symbol: "AAPL",
        quantity: 1,
        conviction: "normal",
        notionalUsd: 9_500
      },
      baseRules(),
      {
        accountNetLiq: 100_000,
        currentExposureUsd: 0,
        fetchedAt: new Date().toISOString()
      }
    );
    expect(firstOrder.status).toBe("allow");

    const secondOrder = evaluateRisk(
      {
        id: "ticket_open_2",
        source: "openclaw-official-paper",
        submittedAt: new Date().toISOString(),
        environment: "paper",
        assetClass: "stock",
        side: "buy",
        symbol: "MSFT",
        quantity: 1,
        conviction: "normal",
        notionalUsd: 9_500
      },
      baseRules(),
      {
        accountNetLiq: 100_000,
        currentExposureUsd: 0,
        fetchedAt: new Date().toISOString(),
        openOrdersNotionalUsd: 9_500
      }
    );

    expect(secondOrder.status).toBe("block");
    expect(secondOrder.reasons.join(" ")).toMatch(/含未成交挂单/u);
  });

  it("treats a negative/non-finite openOrdersNotionalUsd as untrusted facts (falls back to the missing-facts block), same defensive posture as accountNetLiq/currentExposureUsd", () => {
    const result = evaluateRisk(
      {
        id: "ticket_bad_open_notional",
        source: "openclaw-official-paper",
        submittedAt: new Date().toISOString(),
        environment: "paper",
        assetClass: "stock",
        side: "buy",
        symbol: "AAPL",
        quantity: 1,
        conviction: "normal",
        notionalUsd: 100
      },
      baseRules(),
      {
        accountNetLiq: 100_000,
        currentExposureUsd: 0,
        fetchedAt: new Date().toISOString(),
        openOrdersNotionalUsd: -1
      }
    );

    expect(result.status).toBe("block");
    expect(result.reasons.join(" ")).toMatch(/官方模拟盘账户快照/u);
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
        fetchedAt: new Date().toISOString(),
        heldQuantityForSymbol: 5
      }
    );

    expect(result.reasons.join(" ")).not.toMatch(/OpenClaw 官方模拟盘预算/u);
  });

  // FIX 2 (audit-class finding): the paper-sell exemption used to zero out
  // riskIncreasingNotional for EVERY paper sell regardless of whether the
  // owner actually held the position - a sell-to-open (naked short) of any
  // size read as ideaExposure 0 and sailed past the 10% cap. Gated on the
  // owner's ACTUAL held long for that symbol (heldQuantityForSymbol): a sell
  // up to the held long is risk-reducing (exempt); any excess beyond it (a
  // short-open) counts as risk-increasing notional, subject to the same 10%
  // idea-exposure cap as a buy.
  describe("sell exemption gated on held position (FIX 2)", () => {
    it("allows a sell fully within the held long, even though it exceeds the 10% idea-exposure cap in notional terms", () => {
      const result = evaluateRisk(
        {
          id: "ticket_sell_within_held",
          source: "openclaw-official-paper",
          submittedAt: new Date().toISOString(),
          environment: "paper",
          assetClass: "stock",
          symbol: "NVDA",
          side: "sell",
          quantity: 10,
          conviction: "normal",
          // 10 shares * $2,000 = $20,000 = 20% of net liq - would block if
          // treated as risk-increasing, but the owner holds all 10 shares.
          notionalUsd: 20_000
        },
        baseRules(),
        {
          accountNetLiq: 100_000,
          currentExposureUsd: 20_000,
          fetchedAt: new Date().toISOString(),
          heldQuantityForSymbol: 10
        }
      );

      expect(result.status).toBe("allow");
    });

    it("blocks a sell that exceeds the held long (a short-open) once the excess notional is over budget", () => {
      const result = evaluateRisk(
        {
          id: "ticket_sell_exceeds_held",
          source: "openclaw-official-paper",
          submittedAt: new Date().toISOString(),
          environment: "paper",
          assetClass: "stock",
          symbol: "NVDA",
          side: "sell",
          quantity: 10,
          conviction: "normal",
          // 10 shares * $2,000 = $20,000; owner holds only 2 -> 8 excess
          // shares = $16,000 = 16% of net liq, over the 10% cap.
          notionalUsd: 20_000
        },
        baseRules(),
        {
          accountNetLiq: 100_000,
          currentExposureUsd: 0,
          fetchedAt: new Date().toISOString(),
          heldQuantityForSymbol: 2
        }
      );

      expect(result.status).toBe("block");
      expect(result.reasons.join(" ")).toMatch(/单个想法暴露/u);
    });

    it("blocks a naked-short sell over budget when the owner holds no position in the symbol at all", () => {
      const result = evaluateRisk(
        {
          id: "ticket_sell_no_position",
          source: "openclaw-official-paper",
          submittedAt: new Date().toISOString(),
          environment: "paper",
          assetClass: "stock",
          symbol: "TSLA",
          side: "sell",
          quantity: 10,
          conviction: "normal",
          notionalUsd: 20_000
        },
        baseRules(),
        {
          accountNetLiq: 100_000,
          currentExposureUsd: 0,
          fetchedAt: new Date().toISOString(),
          heldQuantityForSymbol: 0
        }
      );

      expect(result.status).toBe("block");
      expect(result.reasons.join(" ")).toMatch(/单个想法暴露/u);
    });

    it("treats an unknown/missing heldQuantityForSymbol as zero held (conservative: whole sell counts as risk-increasing)", () => {
      const result = evaluateRisk(
        {
          id: "ticket_sell_unknown_position",
          source: "openclaw-official-paper",
          submittedAt: new Date().toISOString(),
          environment: "paper",
          assetClass: "stock",
          symbol: "AMD",
          side: "sell",
          quantity: 10,
          conviction: "normal",
          notionalUsd: 20_000
        },
        baseRules(),
        {
          accountNetLiq: 100_000,
          currentExposureUsd: 0,
          fetchedAt: new Date().toISOString()
          // heldQuantityForSymbol omitted entirely - unknown position.
        }
      );

      expect(result.status).toBe("block");
      expect(result.reasons.join(" ")).toMatch(/单个想法暴露/u);
    });
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
