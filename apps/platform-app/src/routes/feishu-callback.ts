/**
 * `POST /feishu/card-callback` - the Feishu card-action callback endpoint
 * (2026-07-28, spec drift C7 / plan Task 8).
 *
 * WHY IT EXISTS. Approval cards have carried three buttons since P6, and
 * until now a click went NOWHERE: nothing in this repo consumed
 * `card.action.trigger`. The owner could only decide a proposal from a
 * terminal (`proposals.mjs approve …`), which is not the loop §4/§6 describe
 * ("owner 在飞书里点批准，卡片原地回改"). This endpoint closes it.
 *
 * TRUST BOUNDARY - read this before touching anything below. Every field in
 * the request body is attacker-controlled UNTIL the signature check passes,
 * and TWO of them stay untrustworthy even after:
 *
 *   · IDENTITY comes from `event.operator.open_id` of the SIGNED body,
 *     mapped through `members.feishu_open_id`. It is never taken from a
 *     request field naming a member/owner, and the ocf1 envelope's own
 *     `c.u` binding hint is never read as identity either (a click echoes
 *     the card's payload back, so `c.u` proves nothing on its own). The
 *     resolved member id must equal `proposals.owner_id` or the click is
 *     refused with the token untouched - a non-owner must never be able to
 *     burn the real owner's token, so the ownership check happens BEFORE
 *     `consumeApproval`, exactly as proposals.mjs's CLI orders it.
 *   · EXPIRY comes from the proposal row's `expires_at`, not from the
 *     envelope's `c.e`.
 *
 * WHAT EACH BAD CLICK GETS:
 *   · forged / absent signature  -> 401, nothing read, nothing written.
 *   · no signing key configured  -> 503 naming the missing env var. This
 *     endpoint never falls back to accepting unsigned callbacks.
 *   · encrypted push (`{encrypt}`) -> 400 naming the reason. This endpoint
 *     verifies signatures but does not decrypt; a deployment that turns on
 *     event encryption gets a loud refusal instead of a silently dropped
 *     click.
 *   · clicker not a member       -> toast, no state change.
 *   · clicker is not the owner   -> toast, no state change, card unchanged.
 *   · expired proposal           -> toast, token NOT consumed, card unchanged.
 *   · replayed click (same signed body twice, or a double-tap) -> the first
 *     `consumeApproval` wins atomically; every later one gets
 *     `{consumed:false}` and answers with an "already handled" toast without
 *     re-deciding, re-halving, re-auditing or re-editing the card.
 *
 * REPLAY, STATED HONESTLY: there is no timestamp-freshness window here. The
 * `x-lark-request-timestamp` header is inside the signature, so a replay is
 * bit-identical to the original click - and a re-sent click of an
 * already-consumed token is exactly the idempotent case above, which changes
 * nothing. (The one shipping implementation of this verification we can read,
 * OpenClaw's `isFeishuWebhookSignatureValid`, likewise checks the signature
 * and no freshness window.) A freshness check was left out rather than
 * guessed at: the header's unit is not something this repo can verify without
 * a real callback, and a wrong guess silently rejects every real click.
 *
 * WHAT THIS ENDPOINT DELIBERATELY DOES NOT DO: it does not submit anything to
 * broker-executor. The CLI's `approve` path does that (`submitToExecutor` in
 * proposals.mjs); a click here moves the proposal to approved/approved_half
 * and re-renders the card, and execution remains the executor's own
 * shared-secret path, still governed by ALLOW_LIVE_EXECUTION. A click
 * therefore never places an order by itself.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import {
  AuditLogRepository,
  MemberRepository,
  ProposalRepository,
  composeDecisionUpdate,
  methodNotAllowed,
  nowIso,
  parseProposalDecisionEnvelope,
  updateInteractiveCard,
  type CardTransport,
  type ProposalCardDecision
} from "@packages/shared-types";

import { guardAsyncWrite } from "./async-guard.js";

/**
 * The callback URL to register in the Feishu developer console. Written as a
 * literal at the comparison site below as well: cache-headers.test.ts reads
 * each route module's path decisions straight out of its source, and only
 * understands `pathname === "<literal>"`.
 */
export const FEISHU_CALLBACK_PATH = "/feishu/card-callback";

/** Feishu's own cap on a card-callback body is far below this. */
const MAX_BODY_BYTES = 256 * 1024;

export interface FeishuCallbackRouteDeps {
  db: DatabaseSync;
  /** Injectable clock for deterministic tests; defaults to wall clock. */
  now?: () => Date;
  /**
   * Card transport for the in-place edit. Production leaves it unset and
   * `updateInteractiveCard` uses the real tenant-token HTTP transport; tests
   * inject a fake that records the payload instead of calling Feishu.
   */
  cardTransport?: CardTransport;
}

type ToastType = "info" | "success" | "error" | "warning";

/**
 * A card callback answers with a toast (and optionally a replacement card).
 * We send only a toast: the card edit goes through the message-update API
 * (`updateInteractiveCard`), which is the same channel the CLI and the expiry
 * sweep already use, so all three deciders re-render a decided card the same
 * way rather than through three different mechanisms.
 */
function sendToast(res: ServerResponse, type: ToastType, content: string): void {
  const body = JSON.stringify({ toast: { type, content } });
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendError(res: ServerResponse, statusCode: number, error: string): void {
  const body = JSON.stringify({ ok: false, error });
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function firstHeader(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

/**
 * The Encrypt Key the Feishu developer console shows for this app's event /
 * card subscription. Unset means this endpoint cannot verify anything, and
 * it refuses to serve rather than trusting an unsigned body.
 */
export function resolveCallbackSigningKey(): string {
  return (process.env.FEISHU_CARD_ENCRYPT_KEY ?? process.env.FEISHU_ENCRYPT_KEY ?? "").trim();
}

/**
 * `sha256(timestamp + nonce + encryptKey + rawBody)`, hex, compared in
 * constant time. Not invented here: this is the algorithm the installed
 * OpenClaw gateway uses for the same Feishu webhook surface
 * (`isFeishuWebhookSignatureValid`, `<openclaw>/dist/monitor.account-*.js`),
 * and feishu-callback.test.ts signs its requests with an INDEPENDENT
 * expression of it rather than by calling this function.
 */
export function verifyFeishuSignature(params: {
  headers: IncomingMessage["headers"];
  rawBody: string;
  signingKey: string;
}): boolean {
  const timestamp = firstHeader(params.headers["x-lark-request-timestamp"]);
  const nonce = firstHeader(params.headers["x-lark-request-nonce"]);
  const signature = firstHeader(params.headers["x-lark-signature"]);
  if (!timestamp || !nonce || !signature || !params.signingKey) {
    return false;
  }

  const expected = createHash("sha256")
    .update(timestamp + nonce + params.signingKey + params.rawBody)
    .digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(signature, "utf8");
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

async function readRawBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: unknown, key: string): string {
  if (!isRecord(source)) {
    return "";
  }
  const value = source[key];
  return typeof value === "string" ? value : "";
}

/** The status `consumeApproval` writes for each button decision. */
const DECISION_TOAST: Record<ProposalCardDecision, string> = {
  approved: "已批准",
  approved_half: "已批准（减半）",
  rejected: "已拒绝"
};

const STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  approved: "已批准",
  approved_half: "已批准（减半）",
  rejected: "已拒绝",
  expired: "已过期",
  executed: "已执行",
  failed: "执行失败"
};

async function handleCardAction(
  req: IncomingMessage,
  res: ServerResponse,
  deps: FeishuCallbackRouteDeps
): Promise<void> {
  const signingKey = resolveCallbackSigningKey();
  if (!signingKey) {
    // Fail closed and say which knob is missing. Serving this path without a
    // key would mean accepting anyone's POST as an approval.
    console.error(
      "feishu-callback: refused a callback because FEISHU_CARD_ENCRYPT_KEY (or FEISHU_ENCRYPT_KEY) is not configured"
    );
    sendError(res, 503, "飞书卡片回调未配置签名密钥（FEISHU_CARD_ENCRYPT_KEY），已拒绝处理。");
    return;
  }

  const rawBody = await readRawBody(req);
  if (rawBody === null) {
    sendError(res, 413, "请求体过大。");
    return;
  }

  if (!verifyFeishuSignature({ headers: req.headers, rawBody, signingKey })) {
    console.error("feishu-callback: rejected a callback with an invalid or missing X-Lark-Signature");
    sendError(res, 401, "签名校验失败。");
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    sendError(res, 400, "请求体不是合法 JSON。");
    return;
  }
  if (!isRecord(payload)) {
    sendError(res, 400, "请求体不是合法 JSON 对象。");
    return;
  }

  // Console "回调地址" verification handshake. Signed like any other push, so
  // it is answered only after the check above.
  if (payload.type === "url_verification" && typeof payload.challenge === "string") {
    const body = JSON.stringify({ challenge: payload.challenge });
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body)
    });
    res.end(body);
    return;
  }

  if (typeof payload.encrypt === "string") {
    console.error("feishu-callback: received an encrypted push; this endpoint only accepts plaintext pushes");
    sendError(
      res,
      400,
      "该回调推送已加密，本端点只接受明文推送：请在飞书开发者后台关闭事件加密（保留 Encrypt Key 用于验签）。"
    );
    return;
  }

  const eventType = readString(payload.header, "event_type");
  if (eventType !== "card.action.trigger") {
    // Not ours (Feishu may push other subscribed events to the same URL).
    // 200 so Feishu does not retry something we will never handle.
    sendToast(res, "info", "已忽略：不是卡片操作事件。");
    return;
  }

  const event = isRecord(payload.event) ? payload.event : {};
  const operatorOpenId = readString(event.operator, "open_id").trim();
  const action = isRecord(event.action) ? event.action : {};
  const context = isRecord(event.context) ? event.context : {};

  const parsed = parseProposalDecisionEnvelope(action.value);
  if (!parsed.ok) {
    console.error(`feishu-callback: unrecognised card action value (${parsed.reason})`);
    sendToast(res, "error", "无法识别的卡片操作。");
    return;
  }

  const members = new MemberRepository(deps.db);
  const member = operatorOpenId ? members.getByFeishuOpenId(operatorOpenId) : null;
  if (!member) {
    sendToast(res, "error", "未找到与你飞书账号绑定的成员，无法处理该操作。");
    return;
  }

  const proposals = new ProposalRepository(deps.db);
  const proposal = proposals.getByToken(parsed.token);
  if (!proposal) {
    sendToast(res, "error", "提案不存在或审批链接已失效。");
    return;
  }

  // Owner-only, checked BEFORE the token is touched (see this module's
  // header): a non-owner's click must leave the token spendable by its real
  // owner.
  if (proposal.ownerId !== member.id) {
    console.error(
      `feishu-callback: refused a non-owner click on proposal ${proposal.id} (owner ${proposal.ownerId}, clicker ${member.id})`
    );
    new AuditLogRepository(deps.db).write("proposals", "card_click_refused", {
      proposalId: proposal.id,
      ownerId: proposal.ownerId,
      clickedBy: member.id,
      reason: "not_owner"
    });
    sendToast(res, "error", "无权操作：该提案属于其他成员。");
    return;
  }

  const now = deps.now ? deps.now() : new Date();
  if (proposal.status === "pending" && Date.parse(proposal.expiresAt) <= now.getTime()) {
    // Refused BEFORE consuming: the expiry sweep owns the 'expired'
    // transition, and a click after the deadline must not decide anything.
    sendToast(res, "warning", "该提案已过期，未做任何处理。");
    return;
  }

  const decidedAt = nowIso();
  const consumeResult = proposals.consumeApproval(parsed.token, {
    decision: parsed.decision,
    decidedBy: member.id,
    decidedAt
  });

  if (!consumeResult.consumed) {
    // Idempotent branch: a double-tap, a Feishu retry, or a replay of the
    // same signed body. Nothing is re-decided and the card is NOT re-edited.
    const current = proposals.getByToken(parsed.token);
    const label = current ? (STATUS_LABEL[current.status] ?? current.status) : "已处理";
    sendToast(res, "info", `该提案已处理（${label}），本次点击未重复执行。`);
    return;
  }

  let updated = consumeResult.proposal ?? proposals.getByToken(parsed.token);
  if (parsed.decision === "approved_half" && updated) {
    updated = { ...updated, quantity: proposals.applyHalfQuantity(updated.id) };
  }

  new AuditLogRepository(deps.db).write("proposals", parsed.decision, {
    proposalId: updated?.id ?? proposal.id,
    actor: member.id,
    token: parsed.token,
    source: "feishu_card_callback",
    operatorOpenId
  });

  // Re-render the SAME message so the buttons are gone for everyone looking
  // at it. The message id was backfilled at send time; the event's own
  // `open_message_id` is the fallback for a card whose id never made it onto
  // the row.
  const messageId = updated?.cardMessageId ?? readString(context, "open_message_id");
  if (messageId && updated) {
    const card = composeDecisionUpdate({ ...updated, decidedByDisplayName: member.displayName });
    const updateResult = deps.cardTransport
      ? await updateInteractiveCard(messageId, card, deps.cardTransport)
      : await updateInteractiveCard(messageId, card);
    if (!updateResult.ok) {
      // The decision已经落库 - a failed re-render is a display problem, not a
      // reason to pretend the click did not happen.
      console.error(`feishu-callback: card re-render failed for proposal ${updated.id}: ${updateResult.error}`);
    }
  }

  sendToast(res, "success", `${DECISION_TOAST[parsed.decision]}：提案 ${updated?.id ?? proposal.id}`);
}

/**
 * Dispatches `POST /feishu/card-callback`. Returns `true` when it claimed the
 * request. Must be reached WITHOUT an Access/session identity - the caller is
 * Feishu's server, not a browser - which is why server.ts dispatches it next
 * to `/health`, ahead of every identity-gated route.
 */
export function handleFeishuCallbackRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: FeishuCallbackRouteDeps
): boolean {
  if (url.pathname !== "/feishu/card-callback") {
    return false;
  }
  if (req.method !== "POST") {
    methodNotAllowed(res);
    return true;
  }

  guardAsyncWrite(handleCardAction(req, res, deps), req, res, "feishu-callback");
  return true;
}
