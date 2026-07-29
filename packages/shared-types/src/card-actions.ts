/**
 * ocf1 card-action envelopes - the ONE module that both WRITES an approval
 * button's callback value and READS it back.
 *
 * 2026-07-28 (spec drift C7). Until this file existed, a proposal card's
 * approve button went nowhere: `composeProposalCard` put the bare text
 * `批准 <token>` in the button's `value`, `buildFeishuCardPayload` wrapped
 * that as `behaviors:[{type:"callback", value:{value:"批准 <token>"}}]`, and
 * nothing anywhere in this repo consumed `card.action.trigger`. The one
 * OTHER consumer that could have - the OpenClaw gateway's native card-action
 * handler - rejects that shape too: its `decodeFeishuCardAction` only treats
 * an action value as structured when `value.oc === "ocf1"`, so
 * `{value:"批准 <token>"}` fell through to its `legacy` branch and was
 * dispatched to the agent as the literal string `{"value":"批准 tok_..."}`.
 *
 * THE ENVELOPE SHAPE IS NOT OURS TO INVENT. It is the wire contract of
 * OpenClaw's `decodeFeishuCardAction` (installed copy:
 * `<openclaw>/dist/send-result-*.js`, `extensions/feishu/src/
 * card-interaction.ts`), which validates:
 *   · `oc === "ocf1"`             else -> kind "legacy"
 *   · `k` ∈ button|quick|meta     else -> invalid/malformed
 *   · `a` a non-empty string      else -> invalid/malformed
 *   · `q` a string if present     else -> invalid/malformed
 *   · `m` a flat record of string|number|boolean|null if present
 *   · `c.u`/`c.h`/`c.s` strings, `c.e` a finite number, `c.t` p2p|group
 *   · `c.e < now`                 -> invalid/stale
 *   · `c.u !== operator.open_id`  -> invalid/wrong_user
 *   · `c.h !== context.chat_id`   -> invalid/wrong_conversation
 * `card-actions.openclaw-contract.test.ts` drives THIS module's output
 * through THAT installed decoder rather than through a hand-written copy of
 * those rules, and says so out loud when the decoder is not installed.
 *
 * `c` IS A HINT, NEVER AN IDENTITY. `c.u`/`c.e` let a gateway reject an
 * obviously-wrong click before it reaches us, but they travel in the card and
 * are echoed back by the clicking client. The platform callback endpoint
 * (apps/platform-app/src/routes/feishu-callback.ts) re-derives BOTH from
 * server-side state: the clicker from the signed event's own
 * `event.operator.open_id`, and the expiry from the proposal row's
 * `expires_at`. Nothing in `c` is trusted as an authorization decision.
 */

export const FEISHU_CARD_ACTION_VERSION = "ocf1";

/** The `a` (action) discriminator this repo's proposal buttons carry. */
export const PROPOSAL_DECIDE_ACTION = "alphaloop.proposal.decide";

/**
 * The three owner decisions an approval card offers. Deliberately NOT the
 * full `ProposalDecision` union (database.ts) - `expired` is written by the
 * sweep job, never by a button, so it must not be expressible in an envelope.
 */
export type ProposalCardDecision = "approved" | "approved_half" | "rejected";

/**
 * Button label per decision, and - since `q` is `<label> <token>` - the
 * literal the parser matches on. One table, both directions: the round-trip
 * test in card-actions.test.ts drives every decision through
 * `buildProposalDecisionEnvelope` into `parseProposalDecisionEnvelope`, so a
 * label edit can never leave a producer emitting text its own consumer no
 * longer recognises.
 */
export const PROPOSAL_DECISION_LABEL: Record<ProposalCardDecision, string> = {
  approved: "批准",
  approved_half: "减半批准",
  rejected: "拒绝"
};

const DECISION_BY_LABEL = new Map<string, ProposalCardDecision>(
  (Object.keys(PROPOSAL_DECISION_LABEL) as ProposalCardDecision[]).map((decision) => [
    PROPOSAL_DECISION_LABEL[decision],
    decision
  ])
);

export type FeishuCardActionKind = "button" | "quick" | "meta";

export type FeishuCardActionMetadataValue = string | number | boolean | null;

export interface FeishuCardActionContext {
  /** Bound clicker's `open_id`. A hint - see this module's header. */
  u?: string;
  /** Bound conversation's chat id. */
  h?: string;
  /** Opaque session key (OpenClaw's own approval cards use it). */
  s?: string;
  /** Expiry, epoch milliseconds. A hint - see this module's header. */
  e?: number;
  /** Conversation type. */
  t?: "p2p" | "group";
}

export interface FeishuCardActionEnvelope {
  oc: typeof FEISHU_CARD_ACTION_VERSION;
  k: FeishuCardActionKind;
  a: string;
  q?: string;
  m?: Record<string, FeishuCardActionMetadataValue>;
  c?: FeishuCardActionContext;
}

/**
 * The text command a decision button carries in `q`. With `k: "quick"`,
 * OpenClaw's handler dispatches exactly this string as a synthetic chat
 * command, which is the P6 design ("按钮 value = ocf1 文本命令语义"); the
 * platform callback endpoint parses the same string back into a decision.
 * Token ids are `createId()` output (`approval_<uuid>`) and never contain
 * whitespace, so a single space is an unambiguous separator.
 */
export function buildProposalDecisionCommand(decision: ProposalCardDecision, token: string): string {
  return `${PROPOSAL_DECISION_LABEL[decision]} ${token}`;
}

export interface ProposalDecisionEnvelopeInput {
  decision: ProposalCardDecision;
  token: string;
  /** Owner's Feishu `open_id`, when the deployment has one on file. */
  ownerOpenId?: string;
  /** Proposal `expires_at` in epoch milliseconds. */
  expiresAtMs?: number;
}

/**
 * `k: "quick"` (not `"button"`): OpenClaw's handler only dispatches `q` as a
 * command for `k === "quick"` (or the reserved `feishu.approval.confirm`
 * action); a `"button"` kind with our own `a` falls through to its
 * malformed branch. `c` is omitted entirely when neither hint is available,
 * because an EMPTY `c` is not the same as no `c` to the decoder's
 * `c.e < now` / `c.u !== operator` checks.
 */
export function buildProposalDecisionEnvelope(
  input: ProposalDecisionEnvelopeInput
): FeishuCardActionEnvelope {
  const context: FeishuCardActionContext = {
    ...(input.ownerOpenId ? { u: input.ownerOpenId } : {}),
    ...(Number.isFinite(input.expiresAtMs) ? { e: Number(input.expiresAtMs) } : {})
  };

  return {
    oc: FEISHU_CARD_ACTION_VERSION,
    k: "quick",
    a: PROPOSAL_DECIDE_ACTION,
    q: buildProposalDecisionCommand(input.decision, input.token),
    ...(Object.keys(context).length > 0 ? { c: context } : {})
  };
}

export type ProposalDecisionParseFailure =
  /** Not an ocf1 envelope at all (a legacy text button, or junk). */
  | "not_ocf1"
  /** A valid ocf1 envelope for some OTHER action. */
  | "wrong_action"
  /** Ours, but `q` is missing/unparseable/names no known decision. */
  | "malformed";

export type ProposalDecisionParseResult =
  | { ok: true; decision: ProposalCardDecision; token: string; envelope: FeishuCardActionEnvelope }
  | { ok: false; reason: ProposalDecisionParseFailure };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a raw `event.action.value` back into a decision + token. Returns a
 * reason rather than throwing, because every failure here is a REQUEST the
 * endpoint must answer (with a toast), not an internal error.
 */
export function parseProposalDecisionEnvelope(value: unknown): ProposalDecisionParseResult {
  if (!isRecord(value) || value.oc !== FEISHU_CARD_ACTION_VERSION) {
    return { ok: false, reason: "not_ocf1" };
  }
  if (value.a !== PROPOSAL_DECIDE_ACTION) {
    return { ok: false, reason: "wrong_action" };
  }
  if (typeof value.q !== "string") {
    return { ok: false, reason: "malformed" };
  }

  const parts = value.q.trim().split(/\s+/u);
  const label = parts[0] ?? "";
  const token = parts[1] ?? "";
  const decision = DECISION_BY_LABEL.get(label);
  if (!decision || !token || parts.length !== 2) {
    return { ok: false, reason: "malformed" };
  }

  return { ok: true, decision, token, envelope: value as unknown as FeishuCardActionEnvelope };
}
