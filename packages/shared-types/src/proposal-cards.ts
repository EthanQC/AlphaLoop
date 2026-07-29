/**
 * Proposal-approval card COMPOSITION (pure, no IO).
 *
 * 2026-07-28 (spec drift C7). These two functions used to live in
 * apps/openclaw-config/scripts/proposal-cards.mjs. They moved here - not
 * copied - when the Feishu approval button was wired end to end, because a
 * SECOND consumer appeared: apps/platform-app/src/routes/feishu-callback.ts
 * re-renders the very same card after a click, and platform-app is
 * TypeScript that (by this repo's standing rule - see routes/api-research.ts
 * and data/monthly-review.ts headers) does not reach across an app boundary
 * into `.mjs`. The alternative was a TS re-declaration of ~80 lines of
 * user-facing Chinese card copy in a second place, which is exactly the kind
 * of duplicate that drifts silently. `packages/shared-types` is a real
 * dependency of BOTH apps, so it is the one place this can live once.
 * proposal-cards.mjs now re-exports these; its own tests still drive it
 * through that `.mjs` face, unchanged.
 *
 * Field set / button values follow the 07-11 spec §4.2 mockup verbatim
 * (docs/superpowers/specs/archive/2026-07-11-detailed-requirements.md), as
 * carried forward by 07-12 §4 except for three explicitly-declared changes:
 * delivered to EACH member's own DM (not a single fixed owner), each
 * member's own paper account, and a per-member circuit breaker. The expiry
 * clause follows the 07-15 plan's Global Constraint override ("过期 =
 * expires_at（创建 +24h，07-12 §4 语义覆盖 07-11 样张的 23:58）"), not the
 * mockup's literal "23:58".
 *
 * One cosmetic deviation from the mockup, documented rather than silently
 * diverging: the mockup's 纪律检查 line inlines the CHECKED VALUE next to each
 * rule ("✓ 仓位 8.2%<10%"), a paraphrase `evaluateDiscipline`
 * (apps/openclaw-config/scripts/discipline-engine.mjs) does not itself
 * produce (it returns {ruleId, ruleText, enforcement, pass, detail}). This
 * module renders `${mark} ${ruleText}` instead - the mark plus the rule's
 * own stored text - which is exact, available data rather than a re-derived
 * paraphrase; the fuller `detail` (which DOES carry the computed values)
 * remains on the proposal's disciplineReport for the platform's proposal
 * detail page to render in full.
 */
import { buildProposalDecisionEnvelope } from "./card-actions.js";
import { buildDeepLink } from "./deep-links.js";
import type { Proposal } from "./domain.js";
import type { InteractiveCard, InteractiveCardButton } from "./notifications.js";

/** One row of `evaluateDiscipline`'s report (discipline-engine.mjs). */
export interface ProposalDisciplineRow {
  ruleId?: string;
  ruleText?: string;
  enforcement?: string;
  pass?: boolean | null;
  detail?: string;
}

/** A proposal plus the display name the caller resolved for `decidedBy`. */
export type DecidedProposalCardModel = Proposal & { decidedByDisplayName?: string };

const SIDE_LABEL: Record<string, string> = { buy: "买入", sell: "卖出" };
const CONFIDENCE_LABEL: Record<string, string> = { low: "低", medium: "中", high: "高" };
const DECISION_LABEL: Record<string, string> = {
  approved: "已批准",
  approved_half: "已批准（减半）",
  rejected: "已拒绝",
  expired: "已过期（超时自动作废）"
};
// pass === null falls through to "?" below
const DISCIPLINE_MARK: Record<string, string> = { true: "✓", false: "✗" };

/**
 * ANTI-DRIFT: the same Intl formatting apps/openclaw-config/scripts/
 * trading-schedule.mjs's `getZonedParts` performs (identical option set,
 * `hourCycle: "h23"`, and the same `YYYY-MM-DD` label assembled from the
 * 2-digit parts), narrowed to the date+HH:MM this card needs. Not imported:
 * that file is `.mjs` inside an app, and this package must not depend
 * upward on an app. The rendered strings are pinned by
 * apps/openclaw-config/scripts/proposal-cards.test.ts's golden cases, which
 * still run against this code through the `.mjs` re-export.
 */
function formatShanghaiDateTime(iso: string | undefined | null): string {
  if (!iso) {
    return "未知时间";
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value])
  ) as Record<string, string>;

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function formatPriceClause(proposal: Proposal): string {
  return proposal.limitPrice !== undefined && proposal.limitPrice !== null
    ? ` · 限价 $${proposal.limitPrice}`
    : " · 市价";
}

function formatDisplaySymbol(symbol: string): string {
  return String(symbol ?? "").replace(/\.[A-Z]{2,4}$/u, "");
}

function formatReasonLine(proposal: Proposal): string {
  const evidence = Array.isArray(proposal.evidence) ? proposal.evidence.filter(Boolean) : [];
  const evidenceClause = evidence.length > 0 ? ` [引用: ${evidence.join(", ")}]` : "";
  return `理由: ${proposal.reason}${evidenceClause}`;
}

function formatDisciplineLine(disciplineReport: unknown): string {
  const rows = (Array.isArray(disciplineReport) ? disciplineReport : []) as ProposalDisciplineRow[];
  if (rows.length === 0) {
    return "纪律检查: 无已启用规则";
  }
  const rendered = rows.map((row) => `${DISCIPLINE_MARK[String(row.pass)] ?? "?"} ${row.ruleText}`);
  return `纪律检查: ${rendered.join("  ")}`;
}

function formatInvalidationLine(proposal: Proposal): string {
  const invalidation = proposal.invalidation ?? "未设置";
  const stopLoss =
    proposal.stopLoss !== undefined && proposal.stopLoss !== null ? `$${proposal.stopLoss}` : "未设置";
  const confidence = proposal.confidence
    ? (CONFIDENCE_LABEL[proposal.confidence] ?? proposal.confidence)
    : "未设置";
  return `失效条件: ${invalidation} · 止损: ${stopLoss} · 置信度: ${confidence}`;
}

function formatBudgetLine(proposal: Proposal): string {
  if (proposal.budgetImpact === undefined || proposal.budgetImpact === null) {
    return "预算影响: 预算无法核算（无快照或无限价）";
  }
  return `预算影响: 占模拟盘预算 ${Number(proposal.budgetImpact).toFixed(1)}%`;
}

// Shared by both card variants - only the trailing line (buttons+expiry vs.
// the decision line) differs between an open proposal and a decided one.
function buildDescriptiveLines(proposal: Proposal, disciplineReport: unknown): string[] {
  return [
    formatReasonLine(proposal),
    `关联策略: ${proposal.strategyRef ?? "未设置"}`,
    formatDisciplineLine(disciplineReport),
    formatInvalidationLine(proposal),
    formatBudgetLine(proposal)
  ];
}

/**
 * The card's link to the proposal's own platform page, or `undefined` when
 * this deployment has no PLATFORM_PUBLIC_BASE_URL configured. Never a bare
 * path: a path with no origin is not openable from a Feishu card (see
 * deep-links.ts). Both card variants carry it - the reader of a decided
 * proposal wants the full discipline report just as much as the approver did.
 */
function buildProposalUrl(proposal: Proposal): { text: string; href: string } | undefined {
  const href = buildDeepLink("proposal", proposal.id);
  return href ? { text: "查看提案详情", href } : undefined;
}

function buildTitle(proposal: Proposal): string {
  const sideLabel = SIDE_LABEL[proposal.side] ?? proposal.side;
  const symbol = formatDisplaySymbol(proposal.symbol);
  return `📋 提案 ${proposal.id} · ${sideLabel} ${symbol} ${proposal.quantity} 股${formatPriceClause(proposal)}`;
}

export interface ComposeProposalCardOptions {
  /**
   * The owner's Feishu `open_id`, when the deployment has one on file. It
   * becomes the envelope's `c.u` binding hint, which lets a gateway reject a
   * click by anyone else BEFORE it reaches the callback endpoint. Omitting
   * it costs nothing but that early rejection: the endpoint's own
   * open_id -> member -> `proposal.owner_id` check is what actually enforces
   * ownership, and it never reads `c.u`.
   */
  ownerOpenId?: string;
}

/**
 * Composes the initial approval card sent at proposal-creation time.
 *
 * Each of the three action buttons carries an ocf1 envelope (card-actions.ts)
 * as its callback value; the human-readable command inside it is exactly
 * `批准/减半批准/拒绝 <approval token>` - the token, never the proposal id, so
 * a click carries the one credential `ProposalRepository.consumeApproval`
 * atomically spends. `button.value` keeps that same string so the card's
 * plain-text face and its structured envelope can never disagree.
 */
export function composeProposalCard(
  proposal: Proposal,
  disciplineReport: unknown,
  options: ComposeProposalCardOptions = {}
): InteractiveCard {
  const token = proposal.approvalToken ?? "";
  const url = buildProposalUrl(proposal);
  const expiresAtMs = Date.parse(proposal.expiresAt);
  const envelopeInput = {
    token,
    ...(options.ownerOpenId ? { ownerOpenId: options.ownerOpenId } : {}),
    ...(Number.isFinite(expiresAtMs) ? { expiresAtMs } : {})
  };

  const button = (
    decision: "approved" | "approved_half" | "rejected",
    text: string,
    style?: InteractiveCardButton["style"]
  ): InteractiveCardButton => {
    const envelope = buildProposalDecisionEnvelope({ decision, ...envelopeInput });
    return {
      text,
      value: envelope.q ?? "",
      callbackValue: envelope as unknown as Record<string, unknown>,
      ...(style ? { style } : {})
    };
  };

  return {
    title: buildTitle(proposal),
    lines: [
      ...buildDescriptiveLines(proposal, disciplineReport),
      `过期时间: ${formatShanghaiDateTime(proposal.expiresAt)} 后自动作废`
    ],
    buttons: [
      button("approved", "批准", "primary"),
      button("approved_half", "减半批准"),
      button("rejected", "拒绝", "danger")
    ],
    ...(url ? { url } : {})
  };
}

/**
 * Composes the card re-render after a decision (approve/approve-half/reject/
 * expired): the buttons/expiry line are replaced by a single decision line
 * (决策/时间/操作人), so the same message can never be clicked a second time by
 * a reader who scrolled back to it. Deliberately a single-argument function -
 * `disciplineReport` is read from `proposal.disciplineReport` (already
 * persisted at creation time; nothing new is computed at decision time), and
 * the decider's DISPLAY NAME (rather than raw member id) is read from
 * `proposal.decidedByDisplayName` if the caller attached one (both callers -
 * apps/openclaw-config/scripts/proposals.mjs and the platform callback
 * endpoint - look it up via MemberRepository first, since this function has
 * no db access), falling back to the raw `proposal.decidedBy` id when no
 * display name was attached (e.g. the sweep job's synthetic system actor).
 */
export function composeDecisionUpdate(proposal: DecidedProposalCardModel): InteractiveCard {
  const decisionLabel = DECISION_LABEL[proposal.status] ?? proposal.status;
  const displayName = proposal.decidedByDisplayName ?? proposal.decidedBy ?? "未知";
  const url = buildProposalUrl(proposal);
  return {
    title: buildTitle(proposal),
    lines: [
      ...buildDescriptiveLines(proposal, proposal.disciplineReport),
      `决策: ${decisionLabel} · 时间: ${formatShanghaiDateTime(proposal.decidedAt)} · 操作人: ${displayName}`
    ],
    ...(url ? { url } : {})
  };
}
