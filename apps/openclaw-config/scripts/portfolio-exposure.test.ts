import { describe, expect, it } from "vitest";

import { computeExposure } from "./portfolio-exposure.mjs";

// These tests characterize the exposure math extracted from
// official-paper-monitor.mjs's private `buildStrategyReflection`
// (netAssets > 0 ? (marketValue / netAssets) * 100 : 0, budget fixed at 10%).
// The numeric outcomes here must match what that legacy code would have
// produced for equivalent inputs. See portfolio-exposure.mjs's module doc
// comment for the two quirks preserved on purpose.
describe("computeExposure", () => {
  it("computes the exposure ratio under budget from netAssets/marketValue", () => {
    const result = computeExposure({
      netAssets: 122957.73,
      marketValue: 700.12,
      positions: [{ symbol: "QQQ.US", quantity: 1, marketValue: 700.12 }]
    });

    expect(result.exposureRatio).toBe(700.12 / 122957.73);
    expect(result.budgetRatio).toBe(0.1);
    expect(result.overBudget).toBe(false);
    expect(result.detail).toBe("持仓 1 笔，敞口 0.57%（预算上限 10%），未超出预算。");
  });

  it("flags overBudget once exposure exceeds the fixed 10% budget", () => {
    const result = computeExposure({
      netAssets: 5000,
      marketValue: 1600,
      positions: [{ symbol: "AAPL.US", quantity: 10, marketValue: 1600 }]
    });

    expect(result.exposureRatio).toBe(1600 / 5000);
    expect(result.overBudget).toBe(true);
    expect(result.detail).toBe("持仓 1 笔，敞口 32.00%（预算上限 10%），已超出预算。");
  });

  it("treats netAssets === 0 as 0% exposure instead of dividing by zero (legacy guard, preserved as-is)", () => {
    const result = computeExposure({ netAssets: 0, marketValue: 500, positions: [] });

    expect(result.exposureRatio).toBe(0);
    expect(result.overBudget).toBe(false);
    expect(result.detail).toBe("持仓 0 笔，敞口 0.00%（预算上限 10%），未超出预算。");
  });

  it("treats negative netAssets the same as zero (same legacy guard; a pre-existing false-negative risk, not fixed here)", () => {
    const result = computeExposure({ netAssets: -200, marketValue: 500, positions: [] });

    expect(result.exposureRatio).toBe(0);
    expect(result.overBudget).toBe(false);
  });

  it("returns a null exposureRatio and overBudget=false when netAssets is missing (null)", () => {
    const result = computeExposure({ netAssets: null, marketValue: 500, positions: [] });

    expect(result.exposureRatio).toBeNull();
    expect(result.budgetRatio).toBe(0.1);
    expect(result.overBudget).toBe(false);
    expect(result.detail).toContain("净资产缺失");
  });

  it("returns a null exposureRatio when netAssets is undefined", () => {
    const result = computeExposure({ netAssets: undefined, marketValue: 500, positions: [] });

    expect(result.exposureRatio).toBeNull();
    expect(result.overBudget).toBe(false);
  });

  it("handles zero market value / no positions as 0% exposure", () => {
    const result = computeExposure({ netAssets: 122957.73, marketValue: 0, positions: [] });

    expect(result.exposureRatio).toBe(0);
    expect(result.overBudget).toBe(false);
    expect(result.detail).toContain("持仓 0 笔");
  });

  it("rounds repeating decimals to two places in the detail string, matching legacy toFixed(2) summary formatting", () => {
    const result = computeExposure({ netAssets: 3000, marketValue: 100, positions: [] });

    expect(result.exposureRatio).toBe(100 / 3000);
    expect(result.detail).toContain("3.33%");
  });

  it("does not flag overBudget when exposure equals the budget exactly (legacy used a strict > comparison)", () => {
    const result = computeExposure({ netAssets: 10000, marketValue: 1000, positions: [] });

    expect(result.exposureRatio).toBe(0.1);
    expect(result.overBudget).toBe(false);
  });

  it("keeps budgetRatio fixed at 0.1 (10%) regardless of inputs", () => {
    const result = computeExposure({ netAssets: 999999, marketValue: 1, positions: [] });

    expect(result.budgetRatio).toBe(0.1);
  });

  it("defaults positions to an empty array when omitted", () => {
    const result = computeExposure({ netAssets: 1000, marketValue: 50 });

    expect(result.detail).toContain("持仓 0 笔");
  });
});
