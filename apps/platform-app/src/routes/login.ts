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
  LoginThrottleRepository,
  MemberRepository,
  generateLoginCode,
  methodNotAllowed,
  sendJson,
  type Member
} from "@packages/shared-types";

import { createFeishuLoginCodeSender, type LoginCodeSender } from "../data/login-code-notifier.js";
import { renderLoginPage } from "../render/login-page.js";
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
    // shared/browser cache.
    "cache-control": "no-store",
    ...extraHeaders
  });
  res.end(body);
}

function redirect(res: ServerResponse, location: string, extraHeaders: Record<string, string> = {}): void {
  // 303 (not 302): the browser's follow-up must be a GET regardless of the
  // method that got here - same rule api-research.ts's form path follows.
  res.writeHead(303, { location, "cache-control": "no-store", ...extraHeaders });
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
 * Mints + stores + delivers the code without the HTTP response waiting on any
 * of it (module header: the response must not be a timing oracle, and a slow
 * Feishu API must not hang the browser). Nothing it does can change what the
 * caller already answered; every failure is logged, sanitized, and dropped.
 */
function runSendInBackground(deps: LoginRouteDeps, email: string, now: Date): void {
  const settled = deliverCode(deps, email, now).catch((error: unknown) => {
    console.error(
      `login: code delivery job failed: ${error instanceof Error ? error.message : String(error)}`
    );
  });
  deps.onSendSettled?.(settled);
}

async function deliverCode(deps: LoginRouteDeps, email: string, now: Date): Promise<void> {
  const member = new MemberRepository(deps.db).getByEmail(email);
  if (!member || member.status !== "active" || member.id === LEGACY_SYSTEM_MEMBER_ID) {
    return;
  }
  if (!member.feishuOpenId) {
    console.warn(`login: member ${member.id} has no feishu_open_id on file; no code delivered.`);
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
  if (!result.ok) {
    console.error(`login: Feishu code delivery failed for member ${member.id}: ${result.reason ?? "unknown"}`);
  }
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
