// Proposal-approval card delivery (Phase 6 Task 3, 2026-07-15 plan).
//
// 2026-07-28 (spec drift C7): the two PURE composers that used to live here -
// composeProposalCard / composeDecisionUpdate - moved to
// packages/shared-types/src/proposal-cards.ts and are re-exported below, so
// this module's callers and tests are unchanged. They moved because the
// Feishu approval button now has a SECOND consumer that re-renders the same
// card: apps/platform-app/src/routes/feishu-callback.ts, which is TypeScript
// and (by this repo's standing rule) does not import across an app boundary
// into `.mjs`. See that shared module's header for the full rationale, the
// spec provenance of every field, and the one documented deviation from the
// 07-11 mockup's 纪律检查 line.
//
// What remains here is the one IO function - deliverProposalCard - kept
// separate from composition, matching this codebase's card-composer
// convention (see market-alerts-cards.mjs's header).
import {
  MemberRepository,
  ProposalRepository,
  composeDecisionUpdate,
  composeProposalCard,
  sendInteractiveCard
} from "../../../packages/shared-types/dist/index.js";

export { composeDecisionUpdate, composeProposalCard };

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
