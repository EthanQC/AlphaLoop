import { describe, expect, it } from "vitest";

import {
  FEISHU_CARD_ACTION_VERSION,
  PROPOSAL_DECIDE_ACTION,
  PROPOSAL_DECISION_LABEL,
  buildProposalDecisionCommand,
  buildProposalDecisionEnvelope,
  parseProposalDecisionEnvelope,
  type ProposalCardDecision
} from "./card-actions.js";

const ALL_DECISIONS: ProposalCardDecision[] = ["approved", "approved_half", "rejected"];

describe("buildProposalDecisionEnvelope", () => {
  it("emits the ocf1 envelope shape with the decision command in q", () => {
    const envelope = buildProposalDecisionEnvelope({
      decision: "approved",
      token: "approval_9f1c",
      ownerOpenId: "ou_owner",
      expiresAtMs: 1_800_000_000_000
    });

    expect(envelope).toEqual({
      oc: "ocf1",
      k: "quick",
      a: "alphaloop.proposal.decide",
      q: "批准 approval_9f1c",
      c: { u: "ou_owner", e: 1_800_000_000_000 }
    });
    expect(FEISHU_CARD_ACTION_VERSION).toBe("ocf1");
    expect(PROPOSAL_DECIDE_ACTION).toBe("alphaloop.proposal.decide");
  });

  it("omits c entirely when there is neither an open_id nor an expiry", () => {
    const envelope = buildProposalDecisionEnvelope({ decision: "rejected", token: "approval_1" });

    expect(envelope).toEqual({
      oc: "ocf1",
      k: "quick",
      a: "alphaloop.proposal.decide",
      q: "拒绝 approval_1"
    });
    expect("c" in envelope).toBe(false);
  });

  it("carries only the hint it has", () => {
    expect(buildProposalDecisionEnvelope({ decision: "approved", token: "t1", ownerOpenId: "ou_x" }).c).toEqual({
      u: "ou_x"
    });
    expect(buildProposalDecisionEnvelope({ decision: "approved", token: "t1", expiresAtMs: 42 }).c).toEqual({
      e: 42
    });
  });

  it("drops a non-finite expiry rather than emitting NaN, which the decoder calls malformed", () => {
    const envelope = buildProposalDecisionEnvelope({
      decision: "approved",
      token: "t1",
      expiresAtMs: Number.NaN
    });

    expect(envelope.c).toBeUndefined();
  });

  it("carries the labels the 07-15 plan fixes for the three buttons", () => {
    expect(PROPOSAL_DECISION_LABEL).toEqual({
      approved: "批准",
      approved_half: "减半批准",
      rejected: "拒绝"
    });
  });
});

describe("parseProposalDecisionEnvelope", () => {
  // The producer feeds the consumer directly: a label edit that leaves the
  // parser behind fails HERE rather than in production, where it would look
  // like "the button does nothing".
  it.each(ALL_DECISIONS)("round-trips %s through build -> parse", (decision) => {
    const envelope = buildProposalDecisionEnvelope({
      decision,
      token: "approval_round_trip",
      ownerOpenId: "ou_owner",
      expiresAtMs: 1_800_000_000_000
    });

    const parsed = parseProposalDecisionEnvelope(envelope);

    expect(parsed).toMatchObject({ ok: true, decision, token: "approval_round_trip" });
  });

  it("round-trips through JSON, the way a click actually arrives", () => {
    const envelope = buildProposalDecisionEnvelope({ decision: "approved_half", token: "approval_j" });
    const overTheWire = JSON.parse(JSON.stringify(envelope)) as unknown;

    expect(parseProposalDecisionEnvelope(overTheWire)).toMatchObject({
      ok: true,
      decision: "approved_half",
      token: "approval_j"
    });
  });

  it("rejects a legacy text button value (the shape this repo used to emit)", () => {
    expect(parseProposalDecisionEnvelope({ value: "批准 approval_1" })).toEqual({
      ok: false,
      reason: "not_ocf1"
    });
    expect(parseProposalDecisionEnvelope("批准 approval_1")).toEqual({ ok: false, reason: "not_ocf1" });
    expect(parseProposalDecisionEnvelope(null)).toEqual({ ok: false, reason: "not_ocf1" });
  });

  it("rejects an ocf1 envelope for somebody else's action", () => {
    expect(
      parseProposalDecisionEnvelope({ oc: "ocf1", k: "quick", a: "feishu.approval.confirm", q: "/reset" })
    ).toEqual({ ok: false, reason: "wrong_action" });
  });

  it("rejects our action with an unparseable command", () => {
    const base = { oc: "ocf1", k: "quick", a: PROPOSAL_DECIDE_ACTION };

    expect(parseProposalDecisionEnvelope({ ...base })).toEqual({ ok: false, reason: "malformed" });
    expect(parseProposalDecisionEnvelope({ ...base, q: "批准" })).toEqual({ ok: false, reason: "malformed" });
    expect(parseProposalDecisionEnvelope({ ...base, q: "删除 approval_1" })).toEqual({
      ok: false,
      reason: "malformed"
    });
    expect(parseProposalDecisionEnvelope({ ...base, q: "批准 approval_1 extra" })).toEqual({
      ok: false,
      reason: "malformed"
    });
    expect(parseProposalDecisionEnvelope({ ...base, q: 42 })).toEqual({ ok: false, reason: "malformed" });
  });

  it("does not confuse 减半批准 with 批准 (one label ends with the other)", () => {
    expect(buildProposalDecisionCommand("approved_half", "t")).toBe("减半批准 t");
    expect(parseProposalDecisionEnvelope(buildProposalDecisionEnvelope({ decision: "approved_half", token: "t" })))
      .toMatchObject({ decision: "approved_half" });
    expect(parseProposalDecisionEnvelope(buildProposalDecisionEnvelope({ decision: "approved", token: "t" })))
      .toMatchObject({ decision: "approved" });
  });
});
