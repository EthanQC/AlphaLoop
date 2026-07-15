import type { OrderTicket, RiskDecision, RuleSet } from "@packages/shared-types";

const DEFAULT_ACCOUNT_NET_LIQ = 100_000;
const DEFAULT_OPENCLAW_PAPER_BUDGET_PERCENT = 10;
const DEFAULT_OFFICIAL_PAPER_FACT_MAX_AGE_MS = 90 * 60 * 1000;

export interface OfficialPaperRiskFacts {
  accountNetLiq: number;
  currentExposureUsd: number;
  fetchedAt: string;
  maxAgeMs?: number;
  // Phase 6 Task 4 (2026-07-15 plan), Global Constraint ④: the notional of
  // this owner's OWN still-open lifecycle orders (stage IN submitting/
  // accepted/pending) - not yet filled/cancelled/rejected, so not yet
  // reflected in the account snapshot's currentExposureUsd, but real money
  // already at risk. Added to currentExposureUsd before the 10% budget check
  // so two sequential 9.5% orders correctly block the SECOND one instead of
  // both independently reading "under budget" against the same stale
  // snapshot. Optional (defaults to 0) so every existing caller/test that
  // never supplies it keeps behaving exactly as before.
  openOrdersNotionalUsd?: number;
}

export function evaluateRisk(
  ticket: OrderTicket,
  rules: RuleSet,
  officialPaperRiskFacts?: OfficialPaperRiskFacts
): RiskDecision {
  const trustedPaperFacts = validateOfficialPaperRiskFacts(officialPaperRiskFacts);
  const accountNetLiq = trustedPaperFacts?.accountNetLiq
    ?? getNumericMetadata(ticket, "accountNetLiq", DEFAULT_ACCOUNT_NET_LIQ);
  const openIdeas = getNumericMetadata(ticket, "currentOpenIdeas", 0);
  const highConvictionIdeas = getNumericMetadata(ticket, "currentHighConvictionIdeas", 0);
  const dailyNewRiskPercent = getNumericMetadata(ticket, "dailyNewRiskPercent", 0);
  const openclawPaperBudgetPercent = DEFAULT_OPENCLAW_PAPER_BUDGET_PERCENT;
  const riskIncreasingNotional = ticket.environment === "paper" && ticket.side === "sell" ? 0 : ticket.notionalUsd;

  const reasons: string[] = [];
  let status: RiskDecision["status"] = "allow";

  const ideaExposurePercent = accountNetLiq > 0 ? (riskIncreasingNotional / accountNetLiq) * 100 : 100;

  if (ticket.environment === "paper" && !trustedPaperFacts) {
    status = escalateStatus(status, "block");
    reasons.push(
      "OpenClaw 官方模拟盘订单需要 SQLite 中的新鲜可信官方模拟盘账户快照；调用方传入的暴露 metadata 会被忽略。"
    );
  }

  if (ticket.environment === "paper" && trustedPaperFacts && ticket.side === "buy") {
    // Phase 6 Task 4, Global Constraint ④: open (not-yet-filled) orders for
    // this owner count against the budget too - otherwise two sequential
    // 9.5% orders would each independently read "under the 10% cap" against
    // the same account snapshot, when together they are 19%.
    const openOrdersNotionalUsd = trustedPaperFacts.openOrdersNotionalUsd ?? 0;
    const projectedOfficialPaperExposureUsd =
      trustedPaperFacts.currentExposureUsd + openOrdersNotionalUsd + ticket.notionalUsd;
    const projectedOfficialPaperExposurePercent =
      (projectedOfficialPaperExposureUsd / trustedPaperFacts.accountNetLiq) * 100;

    if (projectedOfficialPaperExposurePercent > openclawPaperBudgetPercent) {
      status = escalateStatus(status, "block");
      reasons.push(
        `OpenClaw 官方模拟盘预算 ${projectedOfficialPaperExposurePercent.toFixed(2)}% 超过上限 ${openclawPaperBudgetPercent.toFixed(2)}%（含未成交挂单 ${openOrdersNotionalUsd.toFixed(2)} 美元）；账户 90% 必须保持不动。`
      );
    }
  }

  if (ideaExposurePercent > rules.maxIdeaExposurePercent) {
    status = escalateStatus(status, "block");
    reasons.push(
      `单个想法暴露 ${ideaExposurePercent.toFixed(2)}% 超过上限 ${rules.maxIdeaExposurePercent.toFixed(2)}%。`
    );
  }

  if (ticket.conviction === "high" && ideaExposurePercent > rules.maxHighConvictionExposurePercent) {
    status = escalateStatus(status, "block");
    reasons.push(
      `高置信想法暴露 ${ideaExposurePercent.toFixed(2)}% 超过上限 ${rules.maxHighConvictionExposurePercent.toFixed(2)}%。`
    );
  }

  if (openIdeas >= rules.maxConcurrentIdeas) {
    status = escalateStatus(status, "block");
    reasons.push(`当前开放想法 ${openIdeas} 已超过并发上限 ${rules.maxConcurrentIdeas}。`);
  }

  if (ticket.conviction === "high" && highConvictionIdeas >= rules.maxHighConvictionIdeas) {
    status = escalateStatus(status, "require_review");
    reasons.push(
      `高置信想法数量 ${highConvictionIdeas} 已达到配置上限 ${rules.maxHighConvictionIdeas}。`
    );
  }

  if (dailyNewRiskPercent + ideaExposurePercent > rules.maxDailyNewRiskPercent) {
    status = escalateStatus(status, "require_review");
    reasons.push(
      `预计当日新增风险 ${(dailyNewRiskPercent + ideaExposurePercent).toFixed(2)}% 超过配置上限 ${rules.maxDailyNewRiskPercent.toFixed(2)}%。`
    );
  }

  if (ticket.assetClass === "option") {
    status = escalateStatus(status, "block");
    reasons.push("期权自动化已按操作策略禁用。");
  } else if (ticket.strategy && !rules.allowedOptionStrategies.includes(ticket.strategy)) {
    status = escalateStatus(status, "block");
    reasons.push(`策略 ${ticket.strategy} 不在当前允许策略内。`);
  }

  return {
    status,
    reasons,
    requiresHumanReview: status !== "allow"
  };
}

function getNumericMetadata(ticket: OrderTicket, key: string, fallback: number): number {
  const rawValue = ticket.metadata?.[key];
  return typeof rawValue === "number" ? rawValue : fallback;
}

function validateOfficialPaperRiskFacts(facts?: OfficialPaperRiskFacts): OfficialPaperRiskFacts | undefined {
  if (!facts) {
    return undefined;
  }

  if (
    !Number.isFinite(facts.accountNetLiq) ||
    facts.accountNetLiq <= 0 ||
    !Number.isFinite(facts.currentExposureUsd) ||
    facts.currentExposureUsd < 0
  ) {
    return undefined;
  }

  if (
    facts.openOrdersNotionalUsd !== undefined &&
    (!Number.isFinite(facts.openOrdersNotionalUsd) || facts.openOrdersNotionalUsd < 0)
  ) {
    return undefined;
  }

  const fetchedAtMs = new Date(facts.fetchedAt).getTime();
  const maxAgeMs = facts.maxAgeMs ?? DEFAULT_OFFICIAL_PAPER_FACT_MAX_AGE_MS;
  if (!Number.isFinite(fetchedAtMs) || Date.now() - fetchedAtMs > maxAgeMs) {
    return undefined;
  }

  return facts;
}

function escalateStatus(
  current: RiskDecision["status"],
  next: RiskDecision["status"]
): RiskDecision["status"] {
  const order: Record<RiskDecision["status"], number> = {
    allow: 0,
    require_review: 1,
    block: 2
  };

  return order[next] > order[current] ? next : current;
}
