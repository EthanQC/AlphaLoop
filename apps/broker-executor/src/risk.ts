import type { OrderTicket, RiskDecision, RuleSet } from "@packages/shared-types";

const DEFAULT_ACCOUNT_NET_LIQ = 100_000;

export function evaluateRisk(ticket: OrderTicket, rules: RuleSet): RiskDecision {
  const accountNetLiq = getNumericMetadata(ticket, "accountNetLiq", DEFAULT_ACCOUNT_NET_LIQ);
  const openIdeas = getNumericMetadata(ticket, "currentOpenIdeas", 0);
  const highConvictionIdeas = getNumericMetadata(ticket, "currentHighConvictionIdeas", 0);
  const dailyNewRiskPercent = getNumericMetadata(ticket, "dailyNewRiskPercent", 0);

  const reasons: string[] = [];
  let status: RiskDecision["status"] = "allow";

  const ideaExposurePercent = (ticket.notionalUsd / accountNetLiq) * 100;
  if (ideaExposurePercent > rules.maxIdeaExposurePercent) {
    status = escalateStatus(status, "block");
    reasons.push(
      `Idea exposure ${ideaExposurePercent.toFixed(2)}% exceeds max ${rules.maxIdeaExposurePercent.toFixed(2)}%.`
    );
  }

  if (ticket.conviction === "high" && ideaExposurePercent > rules.maxHighConvictionExposurePercent) {
    status = escalateStatus(status, "block");
    reasons.push(
      `High-conviction idea exposure ${ideaExposurePercent.toFixed(2)}% exceeds max ${rules.maxHighConvictionExposurePercent.toFixed(2)}%.`
    );
  }

  if (openIdeas >= rules.maxConcurrentIdeas) {
    status = escalateStatus(status, "block");
    reasons.push(`Open ideas ${openIdeas} exceeds max concurrent ideas ${rules.maxConcurrentIdeas}.`);
  }

  if (ticket.conviction === "high" && highConvictionIdeas >= rules.maxHighConvictionIdeas) {
    status = escalateStatus(status, "require_review");
    reasons.push(
      `High-conviction ideas ${highConvictionIdeas} reached configured max ${rules.maxHighConvictionIdeas}.`
    );
  }

  if (dailyNewRiskPercent + ideaExposurePercent > rules.maxDailyNewRiskPercent) {
    status = escalateStatus(status, "require_review");
    reasons.push(
      `Projected daily new risk ${(dailyNewRiskPercent + ideaExposurePercent).toFixed(2)}% exceeds configured max ${rules.maxDailyNewRiskPercent.toFixed(2)}%.`
    );
  }

  if (ticket.assetClass === "option") {
    status = escalateStatus(status, "block");
    reasons.push("Option automation is disabled by operator policy.");
  } else if (ticket.strategy && !rules.allowedOptionStrategies.includes(ticket.strategy)) {
    status = escalateStatus(status, "block");
    reasons.push(`Strategy ${ticket.strategy} is not allowed by active rules.`);
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
