import type { OrderTicket, RiskDecision, RuleSet } from "@packages/shared-types";

const DEFAULT_ACCOUNT_NET_LIQ = 100_000;
const DEFAULT_OPENCLAW_PAPER_BUDGET_PERCENT = 10;
const DEFAULT_OFFICIAL_PAPER_FACT_MAX_AGE_MS = 90 * 60 * 1000;
const OFFICIAL_PAPER_FACT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface OfficialPaperRiskFacts {
  // USD-normalized account value. The broker server must never put a raw
  // reporting-currency aggregate (for example HKD net_assets) here. Zero is
  // reserved for valuationReliable=false, where the snapshot can still prove
  // a covered sell's held quantity but cannot authorize any new USD risk.
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
  // False when any persisted position lacks a finite positive live quote, or
  // when the snapshot's account/cash/position currencies cannot be proven on
  // one USD basis. A fresh timestamp alone cannot authorize new risk in either
  // case. Omitted defaults to true for backwards-compatible callers/tests.
  valuationReliable?: boolean;
  // FIX 2 (audit-class finding): the owner's currently held LONG quantity of
  // the ticket's own symbol, read from the latest official_paper_snapshots
  // positions JSON for that owner. Used to gate the paper-sell risk
  // exemption below - a sell used to be treated as riskIncreasingNotional 0
  // unconditionally, so a naked short (sell-to-open, no held position) of
  // any size read as ideaExposure 0% and sailed past the 10% cap. Optional
  // (undefined) so every existing caller/test that never supplies it keeps
  // behaving conservatively: undefined is treated as 0 held (validated
  // below), i.e. the WHOLE sell counts as risk-increasing, same as an
  // unknown/no-position sell.
  heldQuantityForSymbol?: number;
}

export function evaluateRisk(
  ticket: OrderTicket,
  rules: RuleSet,
  officialPaperRiskFacts?: OfficialPaperRiskFacts
): RiskDecision {
  const trustedPaperFacts = validateOfficialPaperRiskFacts(officialPaperRiskFacts);
  const accountNetLiq = trustedPaperFacts && trustedPaperFacts.accountNetLiq > 0
    ? trustedPaperFacts.accountNetLiq
    : getNumericMetadata(ticket, "accountNetLiq", DEFAULT_ACCOUNT_NET_LIQ);
  const openIdeas = getNumericMetadata(ticket, "currentOpenIdeas", 0);
  const highConvictionIdeas = getNumericMetadata(ticket, "currentHighConvictionIdeas", 0);
  const dailyNewRiskPercent = getNumericMetadata(ticket, "dailyNewRiskPercent", 0);
  const openclawPaperBudgetPercent = DEFAULT_OPENCLAW_PAPER_BUDGET_PERCENT;
  const riskIncreasingNotional = computeRiskIncreasingNotional(ticket, trustedPaperFacts);

  const reasons: string[] = [];
  let status: RiskDecision["status"] = "allow";

  const ideaExposurePercent = accountNetLiq > 0 ? (riskIncreasingNotional / accountNetLiq) * 100 : 100;

  if (ticket.environment === "paper" && !trustedPaperFacts) {
    status = escalateStatus(status, "block");
    reasons.push(
      "OpenClaw 官方模拟盘订单需要 SQLite 中的新鲜可信官方模拟盘账户快照；调用方传入的暴露 metadata 会被忽略。"
    );
  }

  // Longbridge paper accounts can hold short stock positions, but the
  // current persisted position shape does not carry a reliable direction and
  // older normalization drops non-positive quantities. Until short direction
  // and gross (absolute) exposure are represented end-to-end, allowing even a
  // small sell-to-open would let the filled short disappear from the next
  // budget snapshot. Fail closed: a paper sell may only reduce a long position
  // proven by the fresh snapshot (after the server deducts resting sells).
  if (ticket.environment === "paper" && ticket.side === "sell" && riskIncreasingNotional > 0) {
    status = escalateStatus(status, "block");
    reasons.push(
      "OpenClaw 官方模拟盘暂不允许卖空：卖出数量超过新鲜快照可证明且未被挂单占用的多头持仓；在短仓方向与总暴露可完整核算前，只允许减仓卖出。"
    );
  }

  if (
    ticket.environment === "paper"
    && trustedPaperFacts?.valuationReliable === false
    && riskIncreasingNotional > 0
  ) {
    status = escalateStatus(status, "block");
    reasons.push(
      "OpenClaw 官方模拟盘最新快照含按成本或 0 估值的持仓，或账户/持仓币种无法可靠统一为美元；估值恢复前禁止新增风险，但仍允许快照可证明的减仓卖出。"
    );
  }

  if (
    ticket.environment === "paper"
    && trustedPaperFacts
    && trustedPaperFacts.valuationReliable !== false
    && trustedPaperFacts.accountNetLiq > 0
    && riskIncreasingNotional > 0
  ) {
    // Keep the direction-independent budget calculation as defense in depth
    // even though sell-to-open is blocked above. A sell fully covered by the
    // held long has riskIncreasingNotional=0 and remains a permitted
    // de-risking action. This owner's open not-yet-filled orders are account
    // risk too, so order splitting cannot bypass the 10% Constitution cap.
    const openOrdersNotionalUsd = trustedPaperFacts.openOrdersNotionalUsd ?? 0;
    const projectedOfficialPaperExposureUsd =
      trustedPaperFacts.currentExposureUsd + openOrdersNotionalUsd + riskIncreasingNotional;
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

// A sell up to the owner's held long is risk-reducing; any quantity beyond
// that held long is the short-open portion. evaluateRisk currently blocks any
// positive result fail-closed, while retaining the notional for the ordinary
// exposure checks as defense in depth. Buys, live-environment tickets, and
// any non-paper-sell ticket use the full notional. Missing/negative/non-finite
// held quantity is treated as zero held.
function computeRiskIncreasingNotional(
  ticket: OrderTicket,
  trustedPaperFacts: OfficialPaperRiskFacts | undefined
): number {
  if (ticket.environment !== "paper" || ticket.side !== "sell") {
    return ticket.notionalUsd;
  }

  if (ticket.quantity <= 0) {
    return 0;
  }

  const rawHeld = trustedPaperFacts?.heldQuantityForSymbol;
  const heldQuantity = typeof rawHeld === "number" && Number.isFinite(rawHeld) && rawHeld > 0 ? rawHeld : 0;
  const excessQuantity = Math.max(0, ticket.quantity - heldQuantity);
  if (excessQuantity === 0) {
    return 0;
  }

  const perShareNotional = ticket.notionalUsd / ticket.quantity;
  return excessQuantity * perShareNotional;
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
    facts.accountNetLiq < 0 ||
    (facts.valuationReliable !== false && facts.accountNetLiq <= 0) ||
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
  const ageMs = Date.now() - fetchedAtMs;
  if (
    !Number.isFinite(fetchedAtMs)
    || !Number.isFinite(maxAgeMs)
    || maxAgeMs < 0
    || ageMs > maxAgeMs
    || ageMs < -OFFICIAL_PAPER_FACT_MAX_FUTURE_SKEW_MS
  ) {
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
