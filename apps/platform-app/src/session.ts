/**
 * Signed browser sessions for the self-hosted email-code login
 * (routes/login.ts), 2026-07-27.
 *
 * WHY THIS EXISTS: Cloudflare ACCESS was never activated (Zero Trust requires
 * a payment method the operator could not complete), so the
 * `Cf-Access-Authenticated-User-Email` identity path in identity.ts is
 * permanently FAIL-CLOSED in production - correct, but it left no way at all
 * to authenticate a browser. The tunnel (cloudflared -> reports.qingverse.com)
 * publishes the app without providing any identity, so the app has to mint its
 * own.
 *
 * STATELESS BY DESIGN: the cookie IS the session - a member id plus an expiry,
 * HMAC-SHA256'd with PLATFORM_SESSION_SECRET. There is no sessions table, so
 * there is nothing to look up on the request path (identity.ts's
 * resolveIdentity is synchronous and runs on every route) and nothing to grow
 * unboundedly. The tradeoff is honest and worth stating: a stolen cookie
 * cannot be revoked individually before it expires. The two mitigations that
 * DO exist are (a) revoking the member (`members.status = 'revoked'`), which
 * kills the cookie immediately because resolveIdentity re-reads the member row
 * on every request and rejects non-active members, and (b) rotating
 * PLATFORM_SESSION_SECRET, which invalidates every session at once. For a
 * two-person private circle that is the right shape; if per-session revocation
 * is ever needed, add a session-id table and check it here.
 *
 * FAIL CLOSED ON A MISSING SECRET: with PLATFORM_SESSION_SECRET unset there is
 * no default, no derived-from-hostname fallback, and no "dev mode" - session
 * verification simply always fails (and warns once), and the real entrypoint
 * (index.ts) refuses to boot at all via assertSessionSecretConfigured(). An
 * unsigned or predictably-signed session cookie on a publicly-reachable host
 * is worse than no login.
 */
import type { IncomingMessage } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

/** Cookie name. Kept boring/prefix-free on purpose: `__Host-` would be
 * stricter but forbids the `Domain`-less/`Path=/` combination changing later
 * and breaks plain-http loopback dev entirely. */
export const SESSION_COOKIE_NAME = "alphaloop_session";

/** 30 days, per the task brief's "reasonable lifetime". */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Minimum secret length we consider serious. Below this the process still
 * boots (an operator mid-ignition should not be blocked by a style rule) but
 * warns loudly - see assertSessionSecretConfigured. */
const RECOMMENDED_SECRET_LENGTH = 32;

const SESSION_TOKEN_VERSION = "v1";

let warnedMissingSecret = false;

/** Test seam: clears the warn-once latch so a test can assert the warning. */
export function __resetSessionWarningsForTests(): void {
  warnedMissingSecret = false;
}

/**
 * The signing secret from the environment, or null when unset/blank. Re-read
 * per call (never cached at module load) so a long-lived process picks up a
 * rotated value on restart-free reloads and so tests can set/unset it freely.
 */
export function resolveSessionSecret(): string | null {
  const secret = process.env.PLATFORM_SESSION_SECRET?.trim();
  if (!secret) {
    warnMissingSecretOnce();
    return null;
  }
  return secret;
}

function warnMissingSecretOnce(): void {
  if (warnedMissingSecret) {
    return;
  }
  warnedMissingSecret = true;
  console.error(
    "[session] PLATFORM_SESSION_SECRET is not set: every session cookie is rejected " +
      "and nobody can stay logged in. Generate one with `openssl rand -base64 48` and put " +
      "it in .env.local. There is deliberately no default."
  );
}

/**
 * Startup gate for the real entrypoint: throws (with a fix-it message) when
 * PLATFORM_SESSION_SECRET is missing, so the process refuses to serve at all
 * rather than silently running a login nobody can complete.
 */
export function assertSessionSecretConfigured(): void {
  const secret = process.env.PLATFORM_SESSION_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "PLATFORM_SESSION_SECRET is required: the platform signs its login session cookies with it. " +
        "Generate one with `openssl rand -base64 48` and add it to .env.local, then restart. " +
        "(No default is used on purpose - an unsigned session cookie on a public host is worse than no login.)"
    );
  }
  if (secret.length < RECOMMENDED_SECRET_LENGTH) {
    console.warn(
      `[session] PLATFORM_SESSION_SECRET is only ${secret.length} characters; ` +
        `use at least ${RECOMMENDED_SECRET_LENGTH} (\`openssl rand -base64 48\`).`
    );
  }
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Mints a session token for `memberId` valid until `expiresAtMs`. Returns
 * null when no secret is configured (fail closed - the caller must then not
 * set a cookie at all).
 */
export function createSessionToken(memberId: string, expiresAtMs: number): string | null {
  const secret = resolveSessionSecret();
  if (!secret) {
    return null;
  }
  const payload = Buffer.from(JSON.stringify({ m: memberId, e: Math.floor(expiresAtMs) }), "utf8").toString(
    "base64url"
  );
  const body = `${SESSION_TOKEN_VERSION}.${payload}`;
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verifies signature THEN expiry, returning the member id or null. Never
 * throws - any malformed/tampered/expired/foreign token is simply null.
 * Signature comparison is constant-time.
 */
export function verifySessionToken(token: string, nowMs: number): string | null {
  const secret = resolveSessionSecret();
  if (!secret) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [version, payload, signature] = parts as [string, string, string];
  if (version !== SESSION_TOKEN_VERSION || !payload || !signature) {
    return null;
  }

  const expected = Buffer.from(sign(`${version}.${payload}`, secret), "base64url");
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null) {
    return null;
  }

  const { m, e } = claims as { m?: unknown; e?: unknown };
  if (typeof m !== "string" || !m || typeof e !== "number" || !Number.isFinite(e)) {
    return null;
  }
  if (e <= nowMs) {
    return null;
  }
  return m;
}

/**
 * The `Set-Cookie` value that logs `memberId` in, or null when no secret is
 * configured. Attributes, and why each one:
 *   - HttpOnly: no page script can read it (this app ships one inline theme
 *     script and no framework, but the rule is absolute).
 *   - Secure: production is HTTPS-only via the tunnel. Browsers treat
 *     http://localhost as a secure context, so loopback dev still works.
 *   - SameSite=Lax: cross-site POSTs never carry it, while a normal
 *     click-through from Feishu to a page URL still arrives logged in.
 *   - Path=/: every route is behind the same identity.
 *   - Max-Age: matches the signed expiry, so the browser drops the cookie at
 *     the same moment the server would start rejecting it.
 */
export function buildSessionCookie(memberId: string, nowMs: number): string | null {
  const expiresAtMs = nowMs + SESSION_TTL_MS;
  const token = createSessionToken(memberId, expiresAtMs);
  if (!token) {
    return null;
  }
  const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

/** The `Set-Cookie` value that clears the session (same attributes, empty
 * value, immediate expiry - a browser only overwrites a cookie when Path and
 * the other attributes line up). */
export function buildLogoutCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Minimal shape the cookie readers need from a request. */
export type CookieRequest = Pick<IncomingMessage, "headers">;

/** Parses a `Cookie:` header into a map. Unknown/duplicate names keep the
 * FIRST occurrence, matching how browsers order more-specific cookies first. */
export function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const raw = Array.isArray(header) ? header.join("; ") : header;
  const out: Record<string, string> = {};
  if (!raw) {
    return out;
  }
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (!name || Object.prototype.hasOwnProperty.call(out, name)) {
      continue;
    }
    out[name] = part.slice(separator + 1).trim();
  }
  return out;
}

/**
 * Resolves the member id carried by a request's session cookie, or null.
 * This is the single entry point identity.ts uses; it does NOT check that the
 * member still exists or is active - that is identity.ts's job (and it must
 * stay there, so a revoked member's outstanding cookie stops working).
 */
export function resolveSessionMemberId(req: CookieRequest, nowMs: number = Date.now()): string | null {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
  if (!token) {
    return null;
  }
  return verifySessionToken(token, nowMs);
}
