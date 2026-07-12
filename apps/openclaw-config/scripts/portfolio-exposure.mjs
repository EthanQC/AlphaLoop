const BUDGET_RATIO = 0.1;

/**
 * Computes portfolio exposure vs. the fixed 10% OpenClaw paper-trading budget.
 *
 * Extracted from official-paper-monitor.mjs's private `buildStrategyReflection`
 * so Phase 2's alert engine can reuse the exact same numeric semantics
 * (see apps/openclaw-config/scripts/portfolio-exposure.test.ts for the
 * characterization tests that pin this behavior). This function preserves the
 * original computation's quirks verbatim rather than "fixing" them:
 *
 *   - netAssets <= 0 (zero or negative) is treated as 0% exposure, not an
 *     error/undefined value, mirroring the legacy `netAssets > 0 ? ratio : 0`
 *     guard. If real market value exists while netAssets is zero/negative,
 *     this under-reports exposure as 0% instead of flagging it — a
 *     pre-existing false-negative risk carried over from the legacy code.
 *   - netAssets === null/undefined ("missing") is the only case that yields a
 *     null exposureRatio. official-paper-monitor.mjs's current call site never
 *     actually reaches this branch because it coerces a missing netAssets to
 *     0 (via `?? 0`) before ever computing exposure, so today this branch is
 *     only exercised by direct callers of computeExposure (e.g. a future
 *     alert engine that may not have net assets yet).
 *
 * @param {{ netAssets: number|null, marketValue: number, positions: Array<{symbol: string, quantity: number, marketValue?: number}> }} snapshot
 * @returns {{ exposureRatio: number|null, budgetRatio: number, overBudget: boolean, detail: string }}
 */
export function computeExposure(snapshot) {
  const netAssets = snapshot?.netAssets;
  const marketValue = snapshot?.marketValue;
  const positions = Array.isArray(snapshot?.positions) ? snapshot.positions : [];
  const budgetRatio = BUDGET_RATIO;

  if (netAssets === null || netAssets === undefined) {
    return {
      exposureRatio: null,
      budgetRatio,
      overBudget: false,
      detail: renderDetail({ exposureRatio: null, budgetRatio, overBudget: false, positionCount: positions.length })
    };
  }

  const exposureRatio = netAssets > 0 ? marketValue / netAssets : 0;
  // Compare in percent-space (matching the legacy `exposurePercent > budgetPercent`
  // comparison) rather than comparing raw ratios, so this stays bit-for-bit
  // consistent with the original code instead of merely "equivalent in theory".
  const overBudget = exposureRatio * 100 > budgetRatio * 100;

  return {
    exposureRatio,
    budgetRatio,
    overBudget,
    detail: renderDetail({ exposureRatio, budgetRatio, overBudget, positionCount: positions.length })
  };
}

function renderDetail({ exposureRatio, budgetRatio, overBudget, positionCount }) {
  const budgetText = `${(budgetRatio * 100).toFixed(0)}%`;
  if (exposureRatio === null) {
    return `持仓 ${positionCount} 笔，净资产缺失，敞口无法计算（预算上限 ${budgetText}）。`;
  }
  const exposureText = `${(exposureRatio * 100).toFixed(2)}%`;
  const statusText = overBudget ? "已超出预算" : "未超出预算";
  return `持仓 ${positionCount} 笔，敞口 ${exposureText}（预算上限 ${budgetText}），${statusText}。`;
}
