// Proposal-approval card composition and delivery (Phase 6 Task 3, 2026-07-15
// plan). Field set/button values follow the 07-11 spec §4.2 mockup verbatim
// (docs/superpowers/specs/archive/2026-07-11-detailed-requirements.md), as
// carried forward unmodified by 07-12 §4 except for three explicitly-declared
// changes: delivered to EACH member's own DM (not a single fixed owner),
// each member's own paper account, and a per-member circuit breaker. The
// expiry clause also follows THIS plan's own Global Constraint override
// ("过期 = expires_at（创建 +24h，07-12 §4 语义覆盖 07-11 样张的 23:58）"),
// not the mockup's literal "23:58".
//
// composeProposalCard/composeDecisionUpdate are PURE functions (no IO),
// matching this codebase's existing card-composer convention (see
// market-alerts-cards.mjs's header) - trivially testable, and kept separate
// from deliverProposalCard (the one IO function in this module).
//
// One cosmetic deviation from the mockup, documented rather than silently
// diverging: the mockup's 纪律检查 line inlines the CHECKED VALUE next to each
// rule ("✓ 仓位 8.2%<10%"), a paraphrase discipline-engine.mjs's
// evaluateDiscipline does not itself produce (it returns {ruleId, ruleText,
// enforcement, pass, detail}). This module renders `${mark} ${ruleText}`
// instead - the mark plus the rule's own stored text - which is exact,
// available data rather than a re-derived paraphrase; the fuller `detail`
// (which DOES carry the computed values, e.g. "本次成交后预计仓位 X%...")
// remains on the proposal's disciplineReport for the platform's proposal
// detail page to render in full.
import {
  MemberRepository,
  ProposalRepository,
  sendInteractiveCard
} from "../../../packages/shared-types/dist/index.js";
import { getZonedParts } from "./trading-schedule.mjs";

const SIDE_LABEL = { buy: "买入", sell: "卖出" };
const CONFIDENCE_LABEL = { low: "低", medium: "中", high: "高" };
const DECISION_LABEL = {
  approved: "已批准",
  approved_half: "已批准（减半）",
  rejected: "已拒绝",
  expired: "已过期（超时自动作废）"
};
const DISCIPLINE_MARK = { true: "✓", false: "✗" }; // pass === null falls through to "?" below

function formatShanghaiDateTime(iso) {
  if (!iso) {
    return "未知时间";
  }
  const { dateLabel, hour, minute } = getZonedParts(new Date(iso), "Asia/Shanghai");
  return `${dateLabel} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatPriceClause(proposal) {
  return proposal.limitPrice !== undefined && proposal.limitPrice !== null
    ? ` · 限价 $${proposal.limitPrice}`
    : " · 市价";
}

function formatDisplaySymbol(symbol) {
  return String(symbol ?? "").replace(/\.[A-Z]{2,4}$/u, "");
}

function formatReasonLine(proposal) {
  const evidence = Array.isArray(proposal.evidence) ? proposal.evidence.filter(Boolean) : [];
  const evidenceClause = evidence.length > 0 ? ` [引用: ${evidence.join(", ")}]` : "";
  return `理由: ${proposal.reason}${evidenceClause}`;
}

function formatDisciplineLine(disciplineReport) {
  const rows = Array.isArray(disciplineReport) ? disciplineReport : [];
  if (rows.length === 0) {
    return "纪律检查: 无已启用规则";
  }
  const rendered = rows.map((row) => `${DISCIPLINE_MARK[String(row.pass)] ?? "?"} ${row.ruleText}`);
  return `纪律检查: ${rendered.join("  ")}`;
}

function formatInvalidationLine(proposal) {
  const invalidation = proposal.invalidation ?? "未设置";
  const stopLoss = proposal.stopLoss !== undefined && proposal.stopLoss !== null ? `$${proposal.stopLoss}` : "未设置";
  const confidence = proposal.confidence ? (CONFIDENCE_LABEL[proposal.confidence] ?? proposal.confidence) : "未设置";
  return `失效条件: ${invalidation} · 止损: ${stopLoss} · 置信度: ${confidence}`;
}

function formatBudgetLine(proposal) {
  if (proposal.budgetImpact === undefined || proposal.budgetImpact === null) {
    return "预算影响: 预算无法核算（无快照或无限价）";
  }
  return `预算影响: 占模拟盘预算 ${Number(proposal.budgetImpact).toFixed(1)}%`;
}

// Shared by both card variants - only the trailing line (buttons+expiry vs.
// the decision line) differs between an open proposal and a decided one.
function buildDescriptiveLines(proposal, disciplineReport) {
  return [
    formatReasonLine(proposal),
    `关联策略: ${proposal.strategyRef ?? "未设置"}`,
    formatDisciplineLine(disciplineReport),
    formatInvalidationLine(proposal),
    formatBudgetLine(proposal)
  ];
}

function buildTitle(proposal) {
  const sideLabel = SIDE_LABEL[proposal.side] ?? proposal.side;
  const symbol = formatDisplaySymbol(proposal.symbol);
  return `📋 提案 ${proposal.id} · ${sideLabel} ${symbol} ${proposal.quantity} 股${formatPriceClause(proposal)}`;
}

/**
 * Composes the initial approval card sent at proposal-creation time: the
 * three action buttons carry the approval TOKEN (not the proposal id) as
 * their value, exactly `批准/减半批准/拒绝 <token>` - the ocf1 text-command
 * convention the plan's button values must match verbatim so a future P10
 * wiring of real button clicks can route on that literal text.
 *
 * @param {import('../../../packages/shared-types/dist/index.js').Proposal} proposal
 * @param {Array<{ruleId: string, ruleText: string, enforcement: string, pass: boolean|null, detail: string}>} disciplineReport
 * @returns {import('../../../packages/shared-types/dist/index.js').InteractiveCard}
 */
export function composeProposalCard(proposal, disciplineReport) {
  const token = proposal.approvalToken;
  return {
    title: buildTitle(proposal),
    lines: [
      ...buildDescriptiveLines(proposal, disciplineReport),
      `过期时间: ${formatShanghaiDateTime(proposal.expiresAt)} 后自动作废`
    ],
    buttons: [
      { text: "批准", value: `批准 ${token}`, style: "primary" },
      { text: "减半批准", value: `减半批准 ${token}` },
      { text: "拒绝", value: `拒绝 ${token}`, style: "danger" }
    ]
  };
}

/**
 * Composes the card re-render after a decision (approve/approve-half/reject/
 * expired): the buttons/expiry line are replaced by a single decision line
 * (决策/时间/操作人). Deliberately a single-argument function (per plan
 * signature) - `disciplineReport` is read from `proposal.disciplineReport`
 * (already persisted at creation time; nothing new is computed at decision
 * time), and the decider's DISPLAY NAME (rather than raw member id) is read
 * from `proposal.decidedByDisplayName` if the caller attached one (the CLI
 * looks it up via MemberRepository before calling this, since this function
 * itself has no db access - see proposals.mjs), falling back to the raw
 * `proposal.decidedBy` id when no display name was attached (e.g. the sweep
 * job's synthetic system actor).
 *
 * @param {import('../../../packages/shared-types/dist/index.js').Proposal & {decidedByDisplayName?: string}} proposal
 * @returns {import('../../../packages/shared-types/dist/index.js').InteractiveCard}
 */
export function composeDecisionUpdate(proposal) {
  const decisionLabel = DECISION_LABEL[proposal.status] ?? proposal.status;
  const displayName = proposal.decidedByDisplayName ?? proposal.decidedBy ?? "未知";
  return {
    title: buildTitle(proposal),
    lines: [
      ...buildDescriptiveLines(proposal, proposal.disciplineReport),
      `决策: ${decisionLabel} · 时间: ${formatShanghaiDateTime(proposal.decidedAt)} · 操作人: ${displayName}`
    ]
  };
}

/**
 * Delivers the INITIAL card (composeProposalCard's output) to the proposal
 * owner's Feishu DM (single-chat, never a group - per plan/spec: "审批通道
 * 只属于唯一审批人"). A missing feishuOpenId is not an error - the proposal
 * still stands, just with no delivery channel yet - so this returns
 * `{skipped: 'no_open_id'}` rather than throwing (mirrors market-alerts-
 * cards.mjs's composeAlertCards `skipped` handling for the same condition).
 * On a successful send that returns a messageId, backfills it onto the
 * proposal row via ProposalRepository.updateCardMessageId so a later
 * decision can re-render the SAME message (see composeDecisionUpdate /
 * updateInteractiveCard call sites in proposals.mjs).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {import('../../../packages/shared-types/dist/index.js').Proposal} proposal
 * @param {import('../../../packages/shared-types/dist/index.js').InteractiveCard} card
 * @param {import('../../../packages/shared-types/dist/index.js').CardTransport} [transport]
 * @returns {Promise<{skipped: 'no_open_id'} | {ok: true, messageId?: string} | {ok: false, error: string}>}
 */
export async function deliverProposalCard(db, proposal, card, transport) {
  const member = new MemberRepository(db).getById(proposal.ownerId);
  const openId = member?.feishuOpenId;

  if (!openId) {
    return { skipped: "no_open_id" };
  }

  const result = await sendInteractiveCard(card, { openId }, transport);
  if (!result.ok) {
    return { ok: false, error: result.error ?? "Interactive card send failed." };
  }

  if (result.messageId) {
    new ProposalRepository(db).updateCardMessageId(proposal.id, result.messageId);
  }

  return { ok: true, ...(result.messageId ? { messageId: result.messageId } : {}) };
}
