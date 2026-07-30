/**
 * Self-hosted email-code login (2026-07-27): `GET/POST /login`,
 * `POST /login/verify`, `GET/POST /logout`.
 *
 * WHY: the platform is published to the public internet through a Cloudflare
 * TUNNEL (reports.qingverse.com), but Cloudflare ACCESS was never activated -
 * Zero Trust requires a payment method the operator could not complete - so
 * there is no Cloudflare-injected identity header in production and
 * identity.ts's Access path correctly fails closed. Before this module, a
 * browser could not authenticate at all; only `Authorization: Bearer` worked.
 * This is the browser's way in: prove you control a registered member's
 * Feishu DM, get a signed session cookie (session.ts).
 *
 * THE FLOW
 *   1. `GET /login`          -> email form (or straight to `/` if already in).
 *   2. `POST /login`         -> look the email up in `members`; if (and only
 *                               if) it is an ACTIVE member WITH a
 *                               `feishu_open_id`, mint a 6-digit code, store
 *                               only its salted scrypt hash, and deliver the
 *                               code to that member's own Feishu DM.
 *   3. `POST /login/verify`  -> constant-time check, then a session cookie.
 *   4. `GET/POST /logout`    -> clear the cookie.
 *
 * ANTI-ENUMERATION IS THE LOAD-BEARING RULE HERE. Step 2 renders the SAME
 * page with the SAME wording in every case: address not in `members`, member
 * revoked, member has no Feishu id on file, throttled, Feishu delivery
 * failed. Nothing about membership leaks through the status code, the body,
 * or a redirect. Two supporting details that are easy to lose in a later
 * edit:
 *   - The delivery work runs OUT OF BAND (see runSendInBackground): the
 *     response is written before any scrypt hashing or Feishu HTTP call
 *     happens, so "known member" and "unknown address" do not differ by a
 *     few hundred milliseconds either. Tests synchronize on it through the
 *     `onSendSettled` seam rather than by sleeping.
 *   - The throttle ledger is written for EVERY attempt, including addresses
 *     that match no member, so probing a list of addresses burns the
 *     probing IP's own budget.
 *
 * RATE LIMITS (per the task brief; enforced here, mechanics in
 * shared-types' LoginThrottleRepository):
 *   - per email: at most EMAIL_MAX_SENDS (3) codes per 15 minutes, and at
 *     least EMAIL_COOLDOWN_MS (60s) between two sends. This is what stops
 *     this endpoint being used to machine-gun a member's Feishu.
 *   - per IP: at most IP_MAX_SENDS (10) per 15 minutes, so one host cannot
 *     walk a list of candidate addresses.
 * Both are silent: a throttled request gets the identical "已发送" page.
 *
 * NO SECRETS IN LOGS. The code exists in exactly two places - the Feishu card
 * and a salted scrypt hash - and is never logged, never echoed into HTML,
 * never put in a URL, and never written to the audit log. Failures log a
 * reason (already sanitized by the notifier) and a member id at most.
 *
 * NO CSRF TOKEN, DELIBERATELY. Neither POST here is protected by one, and both
 * omissions are reasoned rather than forgotten: `/login/verify` is unguessable
 * on its own (an attacker who could forge that request would need the code,
 * which only the member's Feishu has), and `/login` can at worst be used to
 * make a victim's browser ASK for a code that then goes to the member's own
 * Feishu - throttled to 3 per 15 minutes, and useful to nobody. A token would
 * need either server-side state or a pre-session cookie, both of which buy
 * nothing here. If this ever grows a "change my email"-style authenticated
 * POST, that one needs real CSRF protection.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import {
  AuditLogRepository,
  LoginCodeRepository,
  LoginDeliveryLogRepository,
  LoginThrottleRepository,
  MemberRepository,
  deliverOperationalAlertToFeishu,
  generateLoginCode,
  methodNotAllowed,
  sendJson,
  type Member,
  type OperationalAlertPayload,
  type OperationalAlertResult
} from "@packages/shared-types";

import { createFeishuLoginCodeSender, type LoginCodeSender } from "../data/login-code-notifier.js";
import { renderLoginPage } from "../render/login-page.js";
import { NO_SHARED_CACHE } from "../security.js";
import { buildLogoutCookie, buildSessionCookie, resolveSessionMemberId } from "../session.js";
import { guardAsyncWrite } from "./async-guard.js";

export interface LoginRouteDeps {
  db: DatabaseSync;
  /** Injectable clock for deterministic tests; defaults to wall clock. */
  now?: () => Date;
  /** Feishu code delivery (data/login-code-notifier.ts). Tests inject a fake;
   * production omits it and gets the real app-credential card channel. */
  loginCodeSender?: LoginCodeSender;
  /** Test seam for the out-of-band send described in the module header: each
   * background job's promise is handed here so a test can await it instead of
   * sleeping. Never set in production. */
  onSendSettled?: (settled: Promise<void>) => void;
  /** Operator escalation for delivery failures (see raiseOperatorAlert).
   * Production omits it and gets shared-types' deliverOperationalAlertToFeishu
   * - the same channel market-alerts' escalations ride; tests inject a fake. */
  operationalAlert?: (payload: OperationalAlertPayload) => Promise<OperationalAlertResult>;
}

/** How long a code stays usable. */
const CODE_TTL_MINUTES = 10;
const CODE_TTL_MS = CODE_TTL_MINUTES * 60 * 1000;

const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const EMAIL_MAX_SENDS = 3;
const EMAIL_COOLDOWN_MS = 60 * 1000;
const IP_MAX_SENDS = 10;

/** Housekeeping horizon: code rows and throttle rows older than this are
 * deleted opportunistically on each send (nothing older can affect any
 * decision - the longest window in play is 15 minutes). */
const PRUNE_AGE_MS = 24 * 60 * 60 * 1000;

/** Unauthenticated endpoint: cap the body instead of reading whatever arrives.
 * A login form posts well under 1 KB. */
const MAX_BODY_BYTES = 8 * 1024;

/** The one response the send step is ever allowed to produce - see the
 * module header's anti-enumeration rule. */
const SENT_NOTICE = "验证码已发送。若该邮箱属于圈内成员，请到飞书查收 6 位验证码。";
const GENERIC_VERIFY_ERROR = "验证码不正确或已失效，请重新获取。";

// v7 migration placeholder (packages/shared-types database.ts) - never a
// person, never a login. Mirrors identity.ts's LEGACY_SYSTEM_MEMBER_ID guard,
// re-declared per this codebase's convention (see member-card.ts's own copy).
const LEGACY_SYSTEM_MEMBER_ID = "__legacy_system__";

function currentNow(deps: LoginRouteDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function sendHtml(res: ServerResponse, status: number, body: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    // A login screen (and anything gated behind one) must never sit in a
    // shared/browser cache. This repeats the server-wide baseline
    // (security.ts's applySecurityHeaders) rather than replacing it: writeHead's
    // own map WINS over setHeader for the keys it lists, so spelling a bare
    // "no-store" here would silently drop the baseline's `private` on exactly
    // the three responses that carry a session cookie. Use the constant.
    "cache-control": NO_SHARED_CACHE,
    ...extraHeaders
  });
  res.end(body);
}

function redirect(res: ServerResponse, location: string, extraHeaders: Record<string, string> = {}): void {
  // 303 (not 302): the browser's follow-up must be a GET regardless of the
  // method that got here - same rule api-research.ts's form path follows.
  // `cache-control` here for the same reason as sendHtml's above - writeHead's
  // map overrides the baseline setHeader, so it must carry the full value.
  res.writeHead(303, { location, "cache-control": NO_SHARED_CACHE, ...extraHeaders });
  res.end();
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Best-effort client IP for the per-IP throttle. Behind the tunnel the real
 * address arrives as `Cf-Connecting-Ip`; direct loopback requests fall back to
 * the socket. Both proxy headers are forgeable by anything that can reach this
 * port directly (loopback only), so this is DoS hygiene, not an authorization
 * input - the per-EMAIL limit is the one that actually protects a member's
 * Feishu from being machine-gunned, and it cannot be evaded this way.
 */
function resolveClientIp(req: IncomingMessage): string {
  const cfIp = firstHeaderValue(req.headers["cf-connecting-ip"])?.trim();
  if (cfIp) {
    return cfIp;
  }
  const forwarded = firstHeaderValue(req.headers["x-forwarded-for"]);
  const firstHop = forwarded?.split(",")[0]?.trim();
  if (firstHop) {
    return firstHop;
  }
  return req.socket?.remoteAddress ?? "unknown";
}

/** Reads a urlencoded form body, refusing anything over MAX_BODY_BYTES. */
async function readFormBody(req: IncomingMessage): Promise<URLSearchParams | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      return null;
    }
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function normalizeEmail(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

/** Deliberately loose: this only rejects input that could not be an address at
 * all. Anything shaped like an email is looked up, and a miss is
 * indistinguishable from a hit (module header). */
function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) && email.length <= 254;
}

// ---------------------------------------------------------------------------
// GET /login
// ---------------------------------------------------------------------------

function handleLoginPage(req: IncomingMessage, res: ServerResponse, deps: LoginRouteDeps, nonce: string): void {
  if (resolveActiveSessionMember(req, deps)) {
    redirect(res, "/");
    return;
  }
  sendHtml(res, 200, renderLoginPage({ nonce, step: "email" }));
}

function resolveActiveSessionMember(req: IncomingMessage, deps: LoginRouteDeps): Member | null {
  const memberId = resolveSessionMemberId(req, currentNow(deps).getTime());
  if (!memberId || memberId === LEGACY_SYSTEM_MEMBER_ID) {
    return null;
  }
  const member = new MemberRepository(deps.db).getById(memberId);
  return member && member.status === "active" ? member : null;
}

// ---------------------------------------------------------------------------
// POST /login  (request a code)
// ---------------------------------------------------------------------------

async function handleRequestCode(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LoginRouteDeps,
  nonce: string
): Promise<void> {
  const form = await readFormBody(req);
  if (!form) {
    sendJson(res, 413, { ok: false, error: "请求体过大。" });
    return;
  }

  const email = normalizeEmail(form.get("email"));
  if (!looksLikeEmail(email)) {
    // A format complaint reveals nothing about membership - it is the same
    // answer for every syntactically bad address.
    sendHtml(res, 400, renderLoginPage({ nonce, step: "email", error: "请输入有效的邮箱地址。" }));
    return;
  }

  const now = currentNow(deps);
  const clientIp = resolveClientIp(req);

  // Everything below this line must reach the SAME response. The work itself
  // runs out of band so the response time cannot be used as an oracle either.
  const allowed = reserveSendSlot(deps, email, clientIp, now);
  if (allowed) {
    runSendInBackground(deps, email, now);
  }

  sendHtml(res, 200, renderLoginPage({ nonce, step: "code", email, notice: SENT_NOTICE }));
}

/**
 * Applies the per-email and per-IP limits and, when the send is allowed,
 * records it in the ledger. Recording happens here - BEFORE delivery is
 * attempted - on purpose: a Feishu outage must not hand out unlimited retries,
 * and the ledger must be written for addresses that match no member too.
 *
 * The cost of that ordering, stated rather than discovered later: `login_send_log`
 * records sends that may never have arrived, so during a Feishu outage a member
 * burns all three of their 15-minute slots on codes that do not exist and is
 * then throttled out of the recovery too. Deliberate - the alternative (record
 * only what was delivered) makes the endpoint unlimited during exactly the
 * outage an attacker would pick. This ledger alone therefore cannot tell an
 * operator that it happened - a burnt slot and a delivered one are the same
 * row - which is why deliverCode records what became of each slot in
 * `login_delivery_log` (v19 migration), the durable other half the doctor's
 * login-delivery-health check compares this ledger against.
 */
function reserveSendSlot(deps: LoginRouteDeps, email: string, clientIp: string, now: Date): boolean {
  const throttle = new LoginThrottleRepository(deps.db);
  const windowStart = new Date(now.getTime() - THROTTLE_WINDOW_MS).toISOString();

  if (throttle.countSince("email", email, windowStart) >= EMAIL_MAX_SENDS) {
    return false;
  }
  const lastEmailSend = throttle.lastSentAt("email", email);
  if (lastEmailSend && now.getTime() - Date.parse(lastEmailSend) < EMAIL_COOLDOWN_MS) {
    return false;
  }
  if (throttle.countSince("ip", clientIp, windowStart) >= IP_MAX_SENDS) {
    return false;
  }

  // Housekeeping at the only point where this table grows, so it stays bounded
  // by the limits just enforced above (a throttled attempt writes no row at
  // all, and nothing older than 24h can affect a 15-minute window).
  throttle.prune(new Date(now.getTime() - PRUNE_AGE_MS).toISOString());

  const nowIso = now.toISOString();
  throttle.record("email", email, nowIso);
  throttle.record("ip", clientIp, nowIso);
  return true;
}

/**
 * The one string an operator has to be able to grep for (J4, 2026-07-29).
 *
 * A member whose code never arrives sees a perfectly normal 「已发送」 page and
 * tries again; the anti-enumeration rule above means they MUST, so the login
 * flow can be entirely broken while looking entirely healthy from outside.
 * Every failure line carries this token. It is deliberately ugly and unique:
 * `grep -c LOGIN-DELIVERY-FAILED platform-app.err.log` is the check, and a
 * non-zero count on a deployment with real members means people cannot log in
 * right now.
 *
 * The token is one of THREE layers, because no single one survives every
 * failure (2026-07-30, this task):
 *   1. This stderr token - survives everything the process itself survives,
 *      but somebody has to go read the log.
 *   2. A THROTTLED operator alert through the operational-alert channel
 *      (raiseOperatorAlert below). It reaches the operator's own Feishu
 *      unprompted - but the dominant failure this reports IS Feishu being
 *      unreachable, in which case the alert rides the channel that just
 *      failed. market-alerts-poll.mjs hit the same wall (its "Fix 3" note),
 *      which is why this layer is explicitly best-effort and never the only
 *      one.
 *   3. A durable outcome row in `login_delivery_log` (recordDeliveryOutcome
 *      below), which needs no Feishu at all: the doctor's
 *      login-delivery-health check (openclaw-runtime-doctor-core.mjs) compares
 *      recent login_send_log reservations against these rows and fails the
 *      machine when members are requesting codes that never arrive.
 *
 * NOT emitted for an address that matches no member, an inactive member, or a
 * throttled attempt - and neither is the alert, nor an outcome row. Those are
 * all normal traffic - anyone can type any address into the form - and
 * counting them would bury the real signal under noise a stranger controls.
 * All three layers fire only when a REAL, ACTIVE member with a Feishu id on
 * file could not be reached (or, for 2 and 3, when such a member can never be
 * reached for want of a feishu_open_id), which is never normal.
 */
const DELIVERY_ALARM = "LOGIN-DELIVERY-FAILED";

/**
 * One operator alert per failure BURST, not one per failed attempt: after an
 * alert attempt, further delivery failures inside this window only log and
 * record. In-process state on purpose - a restart forgetting the burst costs
 * at most one extra card, while persisting it would add a write to a path
 * whose whole premise is that infrastructure is failing.
 *
 * The clock counts alert ATTEMPTS, successful or not: during a full Feishu
 * outage every attempt fails, and re-attempting more often than this would
 * hammer a dead API without informing anyone (layer 3 above is the net for
 * that case).
 */
const OPERATOR_ALERT_BURST_WINDOW_MS = 15 * 60 * 1000;
let lastOperatorAlertAttemptAtMs: number | null = null;

/** Tests share this module instance; mirrors identity.ts's
 * __resetAccessJwtStateForTests convention. Never called in production. */
export function __resetLoginOperatorAlertThrottleForTests(): void {
  lastOperatorAlertAttemptAtMs = null;
}

/**
 * Layer 2: tell the operator, through the same operational-alert channel
 * market-alerts' escalations use. The body names the member ID and a
 * SANITIZED reason only - never the code (which must exist nowhere but the
 * card and the scrypt hash) and never the member's email address (the member
 * id is what an operator needs to look the account up; the address would only
 * widen what a leaked alert exposes).
 *
 * Failures here are logged WITHOUT the DELIVERY_ALARM token: the token counts
 * member-impacting delivery failures, and the primary line for this failure
 * has already been written by the caller.
 */
async function raiseOperatorAlert(deps: LoginRouteDeps, now: Date, detail: string): Promise<void> {
  const nowMs = now.getTime();
  if (
    lastOperatorAlertAttemptAtMs !== null &&
    nowMs - lastOperatorAlertAttemptAtMs < OPERATOR_ALERT_BURST_WINDOW_MS
  ) {
    return;
  }
  lastOperatorAlertAttemptAtMs = nowMs;
  try {
    const send = deps.operationalAlert ?? deliverOperationalAlertToFeishu;
    const result = await send({
      title: "登录验证码投递失败",
      markdown: [
        detail,
        `发生时间：${now.toISOString()}。成员在页面上只会看到「已发送」，不会看到任何错误提示。`,
        "同一故障批次 15 分钟内只发送本告警一次；期间的其余失败请查看 platform-app 的 err.log" +
          `（grep ${DELIVERY_ALARM}）。若本告警因飞书整体故障未能送达，runtime doctor 的 ` +
          "login-delivery-health 检查会在不依赖飞书的情况下报出同一问题。"
      ].join("\n")
    });
    if (!result.sent) {
      console.error(
        `login: operator alert about a code delivery failure could not be sent: ${result.reason ?? "unknown"}`
      );
    }
  } catch (error) {
    console.error(
      `login: operator alert about a code delivery failure threw: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Layer 3: the durable outcome row (login_delivery_log, v19 migration) the
 * doctor compares login_send_log reservations against. Best-effort by
 * necessity - if this write fails the doctor sees a reservation with NO
 * outcome at all, which its login-delivery-health check treats as a failure in
 * its own right (that is what makes a crash between reserve and record
 * visible), so a throw here is logged and deliberately not retried.
 */
function recordDeliveryOutcome(
  deps: LoginRouteDeps,
  input: { memberId: string | null; email: string; ok: boolean; reason?: string },
  now: Date
): void {
  try {
    const outcomes = new LoginDeliveryLogRepository(deps.db);
    outcomes.prune(new Date(now.getTime() - PRUNE_AGE_MS).toISOString());
    outcomes.record({ ...input, now: now.toISOString() });
  } catch (error) {
    console.error(
      `login: failed to record a delivery outcome (the doctor's login-delivery-health check will see ` +
        `a reservation with no outcome instead): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Mints + stores + delivers the code without the HTTP response waiting on any
 * of it (module header: the response must not be a timing oracle, and a slow
 * Feishu API must not hang the browser). Nothing it does can change what the
 * caller already answered; every failure is logged, sanitized, and dropped.
 */
function runSendInBackground(deps: LoginRouteDeps, email: string, now: Date): void {
  const settled = deliverCode(deps, email, now).catch(async (error: unknown) => {
    console.error(
      `login: ${DELIVERY_ALARM} code delivery job threw: ${error instanceof Error ? error.message : String(error)}`
    );
    // The job died before deliverCode could say what happened - whether a
    // member was even involved is unknown here, so the outcome row carries a
    // null member and a FIXED reason (the raw error text stays in stderr
    // only, where a future error message embedding something sensitive can
    // do the least harm). Both layers are best-effort: if the throw came
    // from the db, the record fails too and the doctor sees a reservation
    // with no outcome, which is the signal for exactly this case.
    const settledAt = currentNow(deps);
    recordDeliveryOutcome(deps, { memberId: null, email, ok: false, reason: "job_threw" }, settledAt);
    await raiseOperatorAlert(deps, settledAt, "一次登录验证码后台投递任务异常退出（成员未知，原因见 err.log）。");
  });
  deps.onSendSettled?.(settled);
}

async function deliverCode(deps: LoginRouteDeps, email: string, now: Date): Promise<void> {
  const member = new MemberRepository(deps.db).getByEmail(email);
  if (!member || member.status !== "active" || member.id === LEGACY_SYSTEM_MEMBER_ID) {
    // Stranger-controlled traffic: no log line, no alert, no outcome row -
    // see DELIVERY_ALARM's note on noise.
    return;
  }
  if (!member.feishuOpenId) {
    // An active member who can never log in: nothing about this recovers on its
    // own, and the member's own view of it is an endless 「已发送」.
    console.error(
      `login: ${DELIVERY_ALARM} member ${member.id} is active but has no feishu_open_id on file, ` +
        `so no code can ever be delivered to them.`
    );
    const settledAt = currentNow(deps);
    recordDeliveryOutcome(
      deps,
      { memberId: member.id, email, ok: false, reason: "no_feishu_open_id" },
      settledAt
    );
    await raiseOperatorAlert(
      deps,
      settledAt,
      `成员 ${member.id} 处于激活状态但没有 feishu_open_id，验证码永远无法送达，该成员将一直无法登录。`
    );
    return;
  }

  const codes = new LoginCodeRepository(deps.db);
  codes.prune(new Date(now.getTime() - PRUNE_AGE_MS).toISOString());

  const code = generateLoginCode();
  codes.issue({
    memberId: member.id,
    code,
    expiresAt: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
    now: now.toISOString()
  });

  const send = deps.loginCodeSender ?? createFeishuLoginCodeSender();
  const result = await send({ openId: member.feishuOpenId, code, ttlMinutes: CODE_TTL_MINUTES });
  const settledAt = currentNow(deps);
  if (!result.ok) {
    // The member has already been told 「已发送」 and has already spent one of
    // their three sends per 15 minutes on a code that does not exist.
    console.error(
      `login: ${DELIVERY_ALARM} Feishu code delivery failed for member ${member.id}: ${result.reason ?? "unknown"}`
    );
    // Durable ledger first (local, most reliable), Feishu alert second.
    recordDeliveryOutcome(
      deps,
      { memberId: member.id, email, ok: false, reason: result.reason ?? "unknown" },
      settledAt
    );
    await raiseOperatorAlert(
      deps,
      settledAt,
      `成员 ${member.id} 的登录验证码经飞书投递失败（原因：${result.reason ?? "unknown"}）。`
    );
    return;
  }
  recordDeliveryOutcome(deps, { memberId: member.id, email, ok: true }, settledAt);
}

// ---------------------------------------------------------------------------
// POST /login/verify
// ---------------------------------------------------------------------------

async function handleVerifyCode(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LoginRouteDeps,
  nonce: string
): Promise<void> {
  const form = await readFormBody(req);
  if (!form) {
    sendJson(res, 413, { ok: false, error: "请求体过大。" });
    return;
  }

  const email = normalizeEmail(form.get("email"));
  const code = (form.get("code") ?? "").trim();
  const now = currentNow(deps);

  const reject = (): void => {
    sendHtml(
      res,
      401,
      renderLoginPage({ nonce, step: "code", email, error: GENERIC_VERIFY_ERROR })
    );
  };

  if (!looksLikeEmail(email) || !/^\d{6}$/u.test(code)) {
    reject();
    return;
  }

  const member = new MemberRepository(deps.db).getByEmail(email);
  if (!member || member.status !== "active" || member.id === LEGACY_SYSTEM_MEMBER_ID) {
    reject();
    return;
  }

  const result = new LoginCodeRepository(deps.db).verify({
    memberId: member.id,
    code,
    now: now.toISOString()
  });

  if (!result.ok) {
    // The reason is audited but never rendered - see LoginCodeFailureReason's
    // own comment in database.ts.
    new AuditLogRepository(deps.db).write("auth", "login code rejected", {
      memberId: member.id,
      reason: result.reason
    });
    reject();
    return;
  }

  const cookie = buildSessionCookie(member.id, now.getTime());
  if (!cookie) {
    // PLATFORM_SESSION_SECRET missing: session.ts already warned. Refuse
    // rather than hand out an unsigned session.
    sendHtml(
      res,
      500,
      renderLoginPage({
        nonce,
        step: "email",
        error: "服务器未配置会话密钥，暂时无法登录，请联系圈主。"
      })
    );
    return;
  }

  new AuditLogRepository(deps.db).write("auth", "login success", { memberId: member.id });
  redirect(res, "/", { "set-cookie": cookie });
}

// ---------------------------------------------------------------------------
// /logout
// ---------------------------------------------------------------------------

function handleLogout(res: ServerResponse): void {
  redirect(res, "/login", { "set-cookie": buildLogoutCookie() });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Routes `/login`, `/login/verify` and `/logout`. Returns true when the
 * request was handled (including 400/401/405/413), false when the path is not
 * ours so server.ts keeps looking. Every path here is deliberately reachable
 * WITHOUT an identity - this is the door.
 */
export function handleLoginRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: LoginRouteDeps,
  nonce: string
): boolean {
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);

  if (segments.length === 1 && segments[0] === "login") {
    if (req.method === "GET") {
      handleLoginPage(req, res, deps, nonce);
      return true;
    }
    if (req.method === "POST") {
      guardAsyncWrite(handleRequestCode(req, res, deps, nonce), req, res, "login");
      return true;
    }
    methodNotAllowed(res);
    return true;
  }

  if (segments.length === 2 && segments[0] === "login" && segments[1] === "verify") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    guardAsyncWrite(handleVerifyCode(req, res, deps, nonce), req, res, "login");
    return true;
  }

  if (segments.length === 1 && segments[0] === "logout") {
    if (req.method !== "GET" && req.method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    handleLogout(res);
    return true;
  }

  return false;
}
