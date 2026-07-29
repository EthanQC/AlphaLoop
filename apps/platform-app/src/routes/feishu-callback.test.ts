/**
 * The Feishu card-action callback (POST /feishu/card-callback), driven
 * through the real HTTP server (createPlatformServer), same convention as
 * api-research.test.ts.
 *
 * Two rules this file follows deliberately:
 *
 *  1. NO BUTTON IS EVER CLICKED IN FEISHU. Every request here is synthesised
 *     locally and signed locally; nothing in this file talks to Feishu, and
 *     no real proposal is approved on anyone's behalf.
 *  2. THE INPUT IS THE PRODUCER'S OUTPUT. The action value posted below is
 *     not hand-written JSON - it is read back out of the card
 *     `composeProposalCard` actually produced, through the payload
 *     `buildFeishuCardPayload` actually serialises. If a producer changes the
 *     envelope, these tests change with it instead of continuing to pass
 *     against a shape nothing emits.
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MemberRepository,
  ProposalRepository,
  buildFeishuCardPayload,
  composeProposalCard,
  migrate,
  type CardTransport,
  type Member,
  type Proposal
} from "@packages/shared-types";

import { createPlatformServer } from "../server.js";

const SIGNING_KEY = "test-only-encrypt-key-not-a-real-one";

interface CapturedUpdate {
  messageId: string;
  cardJson: unknown;
}

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    id: "member_a",
    email: "member-a@example.com",
    displayName: "成员甲",
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

/**
 * Independent expression of Feishu's documented callback signature
 * (`sha256(timestamp + nonce + encryptKey + body)`), written here rather than
 * imported from the route, so a change to the route's own verification
 * cannot make these tests agree with it by construction.
 */
function signRequest(rawBody: string, timestamp: string, nonce: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-lark-request-timestamp": timestamp,
    "x-lark-request-nonce": nonce,
    "x-lark-signature": createHash("sha256").update(timestamp + nonce + SIGNING_KEY + rawBody).digest("hex")
  };
}

/** Pulls the callback value out of the card the real producer emits. */
function buttonCallbackValue(proposal: Proposal, label: "批准" | "减半批准" | "拒绝", ownerOpenId?: string): unknown {
  const card = composeProposalCard(proposal, [], ownerOpenId ? { ownerOpenId } : {});
  const payload = buildFeishuCardPayload(card) as {
    body: { elements: Array<Record<string, unknown>> };
  };
  const button = payload.body.elements.find(
    (element) =>
      element.tag === "button" &&
      (element.text as { content?: string } | undefined)?.content === label
  );
  if (!button) {
    throw new Error(`no "${label}" button in the composed card`);
  }
  const behaviors = button.behaviors as Array<{ type: string; value?: unknown }>;
  const callback = behaviors.find((behavior) => behavior.type === "callback");
  if (!callback) {
    throw new Error(`the "${label}" button has no callback behavior`);
  }
  return callback.value;
}

function cardActionBody(actionValue: unknown, operatorOpenId: string): string {
  return JSON.stringify({
    schema: "2.0",
    header: {
      event_id: "evt_1",
      token: "verification-token",
      create_time: "1800000000000",
      event_type: "card.action.trigger",
      tenant_key: "tk_1",
      app_id: "cli_1"
    },
    event: {
      operator: { tenant_key: "tk_1", user_id: "u_1", open_id: operatorOpenId, union_id: "on_1" },
      token: "c-callback-token",
      action: { tag: "button", value: actionValue },
      host: "im_message",
      context: { open_message_id: "om_from_event", open_chat_id: "oc_dm" }
    }
  });
}

describe("Feishu card-action callback (POST /feishu/card-callback)", () => {
  let repoRoot: string;
  let db: DatabaseSync;
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;
  let owner: Member;
  let other: Member;
  let proposal: Proposal;
  let updates: CapturedUpdate[];
  let updateResult: { ok: boolean; error?: string };

  const cardTransport: CardTransport = {
    async sendCard() {
      throw new Error("the callback endpoint must never SEND a new card");
    },
    async updateCard(messageId, cardJson) {
      updates.push({ messageId, cardJson });
      return updateResult;
    }
  };

  function post(rawBody: string, headers: Record<string, string>): Promise<Response> {
    return fetch(`${baseUrl}/feishu/card-callback`, { method: "POST", headers, body: rawBody });
  }

  function postSigned(rawBody: string): Promise<Response> {
    return post(rawBody, signRequest(rawBody, "1800000000", "nonce-1"));
  }

  function createProposal(overrides: Partial<Parameters<ProposalRepository["create"]>[0]> = {}): Proposal {
    return new ProposalRepository(db).create({
      ownerId: owner.id,
      symbol: "TSM.US",
      side: "buy",
      quantity: 10,
      orderType: "limit",
      limitPrice: 375,
      reason: "回踩 20 日线且盈利加速",
      evidence: [],
      disciplineReport: [],
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      ...overrides
    });
  }

  beforeEach(async () => {
    process.env.FEISHU_CARD_ENCRYPT_KEY = SIGNING_KEY;
    repoRoot = mkdtempSync(join(tmpdir(), "feishu-callback-"));
    db = memoryDb();
    updates = [];
    updateResult = { ok: true };

    const members = new MemberRepository(db);
    owner = makeMember({ id: "member_owner", email: "owner@example.com", feishuOpenId: "ou_owner" });
    other = makeMember({
      id: "member_other",
      email: "other@example.com",
      displayName: "成员乙",
      feishuOpenId: "ou_other"
    });
    members.upsert(owner);
    members.upsert(other);

    proposal = createProposal();
    new ProposalRepository(db).updateCardMessageId(proposal.id, "om_card_1");
    proposal = new ProposalRepository(db).getById(proposal.id) as Proposal;

    server = createPlatformServer({ db, repoRoot, cardTransport });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    delete process.env.FEISHU_CARD_ENCRYPT_KEY;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("the owner's approve click moves the proposal to approved and edits the card in place", async () => {
    const body = cardActionBody(buttonCallbackValue(proposal, "批准", "ou_owner"), "ou_owner");

    const response = await postSigned(body);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      toast: { type: "success", content: `已批准：提案 ${proposal.id}` }
    });

    const after = new ProposalRepository(db).getById(proposal.id) as Proposal;
    expect(after.status).toBe("approved");
    expect(after.decidedBy).toBe("member_owner");
    expect(after.consumedAt).toBeTruthy();

    // Edited IN PLACE - the message the card was originally sent as.
    expect(updates).toHaveLength(1);
    expect(updates[0]?.messageId).toBe("om_card_1");
    const rendered = JSON.stringify(updates[0]?.cardJson);
    expect(rendered).toContain("决策: 已批准");
    expect(rendered).toContain("操作人: 成员甲");
    // ...and the buttons are gone, so the same message cannot be clicked again.
    expect(rendered).not.toContain('"tag":"button"');
  });

  it("the owner's 减半批准 click halves the quantity by the shared rule", async () => {
    const body = cardActionBody(buttonCallbackValue(proposal, "减半批准", "ou_owner"), "ou_owner");

    await postSigned(body);

    const after = new ProposalRepository(db).getById(proposal.id) as Proposal;
    expect(after.status).toBe("approved_half");
    expect(after.quantity).toBe(5);
  });

  it("a 减半批准 of a single share stays at one share, never zero", async () => {
    const single = createProposal({ quantity: 1 });
    const body = cardActionBody(buttonCallbackValue(single, "减半批准", "ou_owner"), "ou_owner");

    await postSigned(body);

    expect((new ProposalRepository(db).getById(single.id) as Proposal).quantity).toBe(1);
  });

  it("the owner's reject click moves the proposal to rejected", async () => {
    const body = cardActionBody(buttonCallbackValue(proposal, "拒绝", "ou_owner"), "ou_owner");

    await postSigned(body);

    expect((new ProposalRepository(db).getById(proposal.id) as Proposal).status).toBe("rejected");
  });

  // ---- identity -----------------------------------------------------------

  it("another member's click is refused, the token stays spendable, and the card is untouched", async () => {
    // The envelope still carries the OWNER's binding hint - the click is
    // refused on the server's own open_id -> member -> owner_id chain, not on
    // anything in the request body.
    const body = cardActionBody(buttonCallbackValue(proposal, "批准", "ou_owner"), "ou_other");

    const response = await postSigned(body);

    expect(await response.json()).toEqual({
      toast: { type: "error", content: "无权操作：该提案属于其他成员。" }
    });
    expect((new ProposalRepository(db).getById(proposal.id) as Proposal).status).toBe("pending");
    expect(updates).toHaveLength(0);

    // ...and the real owner can still decide it afterwards.
    await postSigned(cardActionBody(buttonCallbackValue(proposal, "批准", "ou_owner"), "ou_owner"));
    expect((new ProposalRepository(db).getById(proposal.id) as Proposal).status).toBe("approved");
  });

  it("cannot be told who the actor is by the request body - identity comes from the signed open_id", async () => {
    // A forged envelope binding the card to the CLICKER, plus every
    // "ownerId"-shaped field an attacker might hope is read.
    const forged = {
      oc: "ocf1",
      k: "quick",
      a: "alphaloop.proposal.decide",
      q: `批准 ${proposal.approvalToken}`,
      c: { u: "ou_other" },
      ownerId: "member_owner",
      memberId: "member_owner",
      actor: "member_owner"
    };
    const body = JSON.parse(cardActionBody(forged, "ou_other")) as Record<string, unknown>;
    (body.event as Record<string, unknown>).ownerId = "member_owner";
    const raw = JSON.stringify(body);

    const response = await postSigned(raw);

    expect(await response.json()).toEqual({
      toast: { type: "error", content: "无权操作：该提案属于其他成员。" }
    });
    expect((new ProposalRepository(db).getById(proposal.id) as Proposal).status).toBe("pending");
  });

  it("a click from an open_id no member is bound to is refused", async () => {
    const body = cardActionBody(buttonCallbackValue(proposal, "批准", "ou_owner"), "ou_stranger");

    const response = await postSigned(body);

    expect(await response.json()).toEqual({
      toast: { type: "error", content: "未找到与你飞书账号绑定的成员，无法处理该操作。" }
    });
    expect((new ProposalRepository(db).getById(proposal.id) as Proposal).status).toBe("pending");
  });

  // ---- idempotency --------------------------------------------------------

  it("a replayed click (byte-identical signed body) decides once and says so the second time", async () => {
    const raw = cardActionBody(buttonCallbackValue(proposal, "批准", "ou_owner"), "ou_owner");
    const headers = signRequest(raw, "1800000000", "nonce-1");

    const first = await post(raw, headers);
    const second = await post(raw, headers);

    expect(await first.json()).toEqual({
      toast: { type: "success", content: `已批准：提案 ${proposal.id}` }
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      toast: { type: "info", content: "该提案已处理（已批准），本次点击未重复执行。" }
    });

    // Decided exactly once, and the card was re-rendered exactly once.
    const after = new ProposalRepository(db).getById(proposal.id) as Proposal;
    expect(after.status).toBe("approved");
    expect(updates).toHaveLength(1);
  });

  it("a second, DIFFERENT decision on an already-decided proposal changes nothing", async () => {
    await postSigned(cardActionBody(buttonCallbackValue(proposal, "批准", "ou_owner"), "ou_owner"));
    await postSigned(cardActionBody(buttonCallbackValue(proposal, "拒绝", "ou_owner"), "ou_owner"));

    const after = new ProposalRepository(db).getById(proposal.id) as Proposal;
    expect(after.status).toBe("approved");
    expect(after.quantity).toBe(10);
    expect(updates).toHaveLength(1);
  });

  it("two simultaneous clicks consume the token once", async () => {
    const raw = cardActionBody(buttonCallbackValue(proposal, "批准", "ou_owner"), "ou_owner");

    const responses = await Promise.all([postSigned(raw), postSigned(raw)]);
    const toasts = await Promise.all(responses.map((response) => response.json() as Promise<{ toast: { type: string } }>));

    expect(toasts.filter((payload) => payload.toast.type === "success")).toHaveLength(1);
    expect(toasts.filter((payload) => payload.toast.type === "info")).toHaveLength(1);
    expect(updates).toHaveLength(1);
  });

  // ---- expiry -------------------------------------------------------------

  it("an expired proposal's click is refused without consuming the token", async () => {
    const expired = createProposal({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const body = cardActionBody(buttonCallbackValue(expired, "批准", "ou_owner"), "ou_owner");

    const response = await postSigned(body);

    expect(await response.json()).toEqual({
      toast: { type: "warning", content: "该提案已过期，未做任何处理。" }
    });
    const after = new ProposalRepository(db).getById(expired.id) as Proposal;
    expect(after.status).toBe("pending");
    expect(after.consumedAt).toBeUndefined();
    expect(updates).toHaveLength(0);
  });

  it("uses the injected clock, so expiry is decided by the server's time, not the click's", async () => {
    const soon = createProposal({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createPlatformServer({
      db,
      repoRoot,
      cardTransport,
      now: () => new Date(Date.now() + 120_000)
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });

    const response = await postSigned(cardActionBody(buttonCallbackValue(soon, "批准", "ou_owner"), "ou_owner"));

    expect(await response.json()).toEqual({
      toast: { type: "warning", content: "该提案已过期，未做任何处理。" }
    });
    expect((new ProposalRepository(db).getById(soon.id) as Proposal).status).toBe("pending");
  });

  // ---- signature ----------------------------------------------------------

  it("a forged signature is 401 and decides nothing", async () => {
    const raw = cardActionBody(buttonCallbackValue(proposal, "批准", "ou_owner"), "ou_owner");
    const headers = signRequest(raw, "1800000000", "nonce-1");
    headers["x-lark-signature"] = createHash("sha256").update("guessed").digest("hex");

    const response = await post(raw, headers);

    expect(response.status).toBe(401);
    expect((new ProposalRepository(db).getById(proposal.id) as Proposal).status).toBe("pending");
    expect(updates).toHaveLength(0);
  });

  it("a body edited after signing is 401 - the signature covers the bytes", async () => {
    const raw = cardActionBody(buttonCallbackValue(proposal, "批准", "ou_owner"), "ou_owner");
    const headers = signRequest(raw, "1800000000", "nonce-1");
    const tampered = cardActionBody(buttonCallbackValue(proposal, "批准", "ou_owner"), "ou_other");

    const response = await post(tampered, headers);

    expect(response.status).toBe(401);
    expect((new ProposalRepository(db).getById(proposal.id) as Proposal).status).toBe("pending");
  });

  it("a request with no signature headers at all is 401", async () => {
    const raw = cardActionBody(buttonCallbackValue(proposal, "批准", "ou_owner"), "ou_owner");

    const response = await post(raw, { "content-type": "application/json" });

    expect(response.status).toBe(401);
    expect((new ProposalRepository(db).getById(proposal.id) as Proposal).status).toBe("pending");
  });

  it("refuses to serve at all when no signing key is configured, rather than trusting the body", async () => {
    delete process.env.FEISHU_CARD_ENCRYPT_KEY;
    const raw = cardActionBody(buttonCallbackValue(proposal, "批准", "ou_owner"), "ou_owner");

    const response = await post(raw, signRequest(raw, "1800000000", "nonce-1"));

    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toContain("FEISHU_CARD_ENCRYPT_KEY");
    expect((new ProposalRepository(db).getById(proposal.id) as Proposal).status).toBe("pending");
  });

  // ---- other payloads on the same URL ------------------------------------

  it("answers the console's url_verification challenge, but only when signed", async () => {
    const raw = JSON.stringify({ challenge: "chal_1", token: "verification-token", type: "url_verification" });

    expect(await (await postSigned(raw)).json()).toEqual({ challenge: "chal_1" });
    expect((await post(raw, { "content-type": "application/json" })).status).toBe(401);
  });

  it("refuses an encrypted push loudly instead of dropping the click", async () => {
    const raw = JSON.stringify({ encrypt: "b64-ciphertext" });

    const response = await postSigned(raw);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("加密");
  });

  it("ignores a non-card event pushed to the same URL", async () => {
    const raw = JSON.stringify({
      schema: "2.0",
      header: { event_type: "im.message.receive_v1" },
      event: {}
    });

    const response = await postSigned(raw);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ toast: { type: "info", content: "已忽略：不是卡片操作事件。" } });
  });

  it("rejects the legacy text button value this repo used to emit", async () => {
    const raw = cardActionBody({ value: `批准 ${proposal.approvalToken}` }, "ou_owner");

    const response = await postSigned(raw);

    expect(await response.json()).toEqual({ toast: { type: "error", content: "无法识别的卡片操作。" } });
    expect((new ProposalRepository(db).getById(proposal.id) as Proposal).status).toBe("pending");
  });

  it("rejects a well-formed envelope naming a token no proposal has", async () => {
    const raw = cardActionBody(
      { oc: "ocf1", k: "quick", a: "alphaloop.proposal.decide", q: "批准 approval_nope" },
      "ou_owner"
    );

    const response = await postSigned(raw);

    expect(await response.json()).toEqual({
      toast: { type: "error", content: "提案不存在或审批链接已失效。" }
    });
  });

  it("still records the decision when the card re-render fails", async () => {
    updateResult = { ok: false, error: "message not found" };
    const raw = cardActionBody(buttonCallbackValue(proposal, "批准", "ou_owner"), "ou_owner");

    const response = await postSigned(raw);

    expect(response.status).toBe(200);
    expect((new ProposalRepository(db).getById(proposal.id) as Proposal).status).toBe("approved");
  });

  // Feishu's server carries no Access header, no session cookie and no bearer
  // token. This route must therefore never consult identity.ts - including in
  // the fail-closed Access posture a real deployment runs in. (Cloudflare
  // Access at the EDGE is a separate matter: the tunnel needs a bypass policy
  // for this path, which is a deployment step, not something this process can
  // assert.)
  it("is reachable with no Access identity at all, even in the fail-closed Access posture", async () => {
    const previous = process.env.CF_ACCESS_DISABLED;
    delete process.env.CF_ACCESS_DISABLED;
    try {
      const raw = cardActionBody(buttonCallbackValue(proposal, "批准", "ou_owner"), "ou_owner");

      const response = await postSigned(raw);

      expect(response.status).toBe(200);
      expect((new ProposalRepository(db).getById(proposal.id) as Proposal).status).toBe("approved");
    } finally {
      if (previous === undefined) {
        delete process.env.CF_ACCESS_DISABLED;
      } else {
        process.env.CF_ACCESS_DISABLED = previous;
      }
    }
  });

  it("is POST-only", async () => {
    const response = await fetch(`${baseUrl}/feishu/card-callback`, { method: "GET" });

    expect(response.status).toBe(405);
  });
});
