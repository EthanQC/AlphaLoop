import type { IncomingMessage } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { ApiTokenRepository, MemberRepository, type Member } from "@packages/shared-types";

import {
  JwksCache,
  defaultJwksFetcher,
  normalizeTeamDomain,
  verifyAccessToken,
  type JwksFetcher
} from "./access-jwt.js";

/**
 * The minimal shape resolveIdentity needs from an incoming request. A real
 * `http.IncomingMessage` satisfies this structurally, and tests can pass a
 * plain `{ headers }` object without constructing a real socket-backed
 * request.
 */
export type IdentityRequest = Pick<IncomingMessage, "headers">;

// v7 migration placeholder (packages/shared-types database.ts) attributing
// orphaned alert_events to a synthetic member row so no event is silently
// dropped. It is not a person, must never be treated as a logged-in member,
// and `/member/__legacy_system__` must 404 (Task 7). Its `status` is always
// 'revoked' in production, which already excludes it from both resolution
// paths below - but that is a side effect of how the row happens to be
// seeded, not a guarantee. This id check is the explicit, load-bearing
// guard; see the identity.test.ts cases that force status='active' on this
// id specifically to prove the guard (not the status filter) is what stops
// it.
const LEGACY_SYSTEM_MEMBER_ID = "__legacy_system__";

/**
 * Resolves the calling member's identity for one request, per the platform
 * identity chain (Global Constraints, tech §1.3):
 *
 *   1. `Authorization: Bearer <token>` -> ApiTokenRepository.verify. This
 *      already enforces `revoked_at IS NULL` (token not revoked) AND
 *      `members.status = 'active'` (owning member still active) in one
 *      query - see database.ts.
 *   2. Else `Cf-Access-Authenticated-User-Email` -> MemberRepository
 *      .getByEmail. This header is ONLY trusted after verifyAccessJwt passes:
 *      in ENFORCE mode that means a cryptographically-verified
 *      `Cf-Access-Jwt-Assertion` whose email claim matches the header; the
 *      pre-P10 blind-trust behavior survives only behind the explicit
 *      CF_ACCESS_DISABLED=true escape (see the Access JWT section below for the
 *      full precedence - the default is FAIL CLOSED). Unlike the token path,
 *      getByEmail does NOT filter by status (it's a plain lookup used
 *      elsewhere for that reason), so this function enforces
 *      `status === 'active'` itself here.
 *   3. Else -> null (caller renders renderUnauthorizedPage).
 *
 * Bearer is checked first and wins if both are present - see the plan's
 * Global Constraints ("身份解析链...bearer 优先").
 */
export function resolveIdentity(req: IdentityRequest, db: DatabaseSync): Member | null {
  const member = resolveViaBearerToken(req, db) ?? resolveViaAccessEmailHeader(req, db);
  if (!member) {
    return null;
  }

  if (member.id === LEGACY_SYSTEM_MEMBER_ID) {
    return null;
  }

  return member;
}

/**
 * Phase 7 Task 4: BEARER-TOKEN-ONLY identity resolution for the platform's
 * JSON write API (routes/api-strategy.ts). resolveIdentity above is the
 * HTML-page identity chain and deliberately accepts EITHER a bearer token OR
 * the `Cf-Access-Authenticated-User-Email` header (bearer first). The write
 * API is the skill/machine-facing surface (plan Task 4: writes are "the
 * skill/机器面"), so it must NEVER honor the Access header - a request that
 * carries ONLY that header (no `Authorization: Bearer`) is unauthenticated
 * for write purposes and gets 401, even though the exact same header would
 * authenticate the SAME request for reading an HTML page. This reuses
 * `resolveViaBearerToken` (the identical `ApiTokenRepository.verify` path
 * resolveIdentity's own bearer branch uses) so the two identity chains can
 * never silently drift apart on what counts as a valid token, and applies
 * the same `__legacy_system__` guard resolveIdentity applies.
 */
export function resolveBearerIdentity(req: IdentityRequest, db: DatabaseSync): Member | null {
  const member = resolveViaBearerToken(req, db);
  if (!member) {
    return null;
  }

  if (member.id === LEGACY_SYSTEM_MEMBER_ID) {
    return null;
  }

  return member;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function resolveViaBearerToken(req: IdentityRequest, db: DatabaseSync): Member | null {
  const raw = firstHeaderValue(req.headers.authorization);
  if (!raw) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/iu.exec(raw.trim());
  if (!match) {
    return null;
  }

  const token = match[1]?.trim();
  if (!token) {
    return null;
  }

  return new ApiTokenRepository(db).verify(token);
}

function resolveViaAccessEmailHeader(req: IdentityRequest, db: DatabaseSync): Member | null {
  const raw = firstHeaderValue(req.headers["cf-access-authenticated-user-email"]);
  const email = raw?.trim();
  if (!email) {
    return null;
  }

  // The email header alone is spoofable by anything that can reach this port
  // directly. verifyAccessJwt is the gate: it returns true ONLY when the
  // request either carries a cryptographically-valid Cf-Access-Jwt-Assertion
  // that agrees with this email (ENFORCE mode) or the operator has explicitly
  // opted into blind trust via CF_ACCESS_DISABLED=true (loopback dev/tests).
  // With neither, it fails closed - the email header yields no identity.
  if (!verifyAccessJwt(req)) {
    return null;
  }

  const member = new MemberRepository(db).getByEmail(email);
  if (!member || member.status !== "active") {
    return null;
  }

  return member;
}

// ---------------------------------------------------------------------------
// Cloudflare Access JWT verification (P10)
// ---------------------------------------------------------------------------
//
// The cryptographic machinery (compact-JWT parsing, RS256/ES256 signature
// checks, the JWKS cache with synchronous reads + background refresh) lives
// in access-jwt.ts; this section owns the ENV-DRIVEN POLICY around it - the
// three modes, the warn-once fail-closed guard, and the binding of the
// token's email claim to the plain-text email header the rest of the identity
// chain resolves against.
//
// Configuration (read from process.env, which index.ts populates via
// loadLocalEnv before wiring anything - do NOT hardcode team/aud):
//   - CF_ACCESS_TEAM_DOMAIN: the Zero Trust team, e.g. "myteam" (a full
//     "myteam.cloudflareaccess.com" / "https://..." form is normalized).
//     JWKS: https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
//   - CF_ACCESS_AUD:      the Access application's audience (AUD) tag.
//   - CF_ACCESS_DISABLED: escape hatch (see mode 1 below).
//
// PRECEDENCE - loud on purpose; the entire point of P10 is that a
// missing/misconfigured verifier must NEVER silently trust a forgeable header
// once this service is publicly reachable through the Access tunnel:
//   1. CF_ACCESS_DISABLED === "true" -> "disabled": verifyAccessJwt returns
//      true, exactly the pre-P10 blind-trust behavior. This is the ONLY way to
//      keep trusting the bare email header; it exists for loopback dev/CI
//      (platform-app binds 127.0.0.1 only) and the existing test suite.
//   2. Else BOTH team + aud set -> "enforce": the `Cf-Access-Jwt-Assertion`
//      JWT is fully verified (signature against the team JWKS, iss, aud,
//      exp/nbf/iat with clock skew - see access-jwt.ts) and its email claim
//      must match the `Cf-Access-Authenticated-User-Email` header
//      case-insensitively. Any failure -> false (request is unauthenticated).
//   3. Else (EITHER unset, and not disabled) -> "fail-closed": every
//      header-path request is rejected, and a one-time console.error warns
//      that verification is off. Absence of config is NOT consent to trust.
//
// SYNCHRONY / COLD START: resolveIdentity is synchronous and is called
// synchronously from every route handler, so verification never awaits. The
// JWKS cache serves keys synchronously and refreshes in the background; an
// unknown kid or a stale cache fails CLOSED for the current request and
// schedules a refetch so the next request succeeds. index.ts calls
// primeAccessJwtCache() at startup so the very first tunneled request does not
// eat that one-time cold miss. A JWKS fetch failure keeps the previous key set
// and logs - it never fails open and never throws into a request.

export type AccessJwtMode = "disabled" | "enforce" | "fail-closed";

interface AccessJwtConfig {
  mode: AccessJwtMode;
  /** Present only in "enforce" mode. */
  issuer?: string;
  certsUrl?: string;
  aud?: string;
}

const ACCESS_JWKS_CACHE_TTL_MS = 10 * 60 * 1000;

let accessJwksFetcher: JwksFetcher = defaultJwksFetcher;
let accessJwksCache: JwksCache | null = null;
let accessJwksCacheCertsUrl: string | null = null;
let warnedAccessJwtFailClosed = false;

/**
 * Test seam: replace (or, with no argument, restore) the JWKS fetcher. Also
 * drops the current cache so the next verification uses the new fetcher.
 */
export function __setAccessJwksFetcherForTests(fetcher?: JwksFetcher): void {
  accessJwksFetcher = fetcher ?? defaultJwksFetcher;
  accessJwksCache = null;
  accessJwksCacheCertsUrl = null;
}

/** Test seam: clear the JWKS cache and the warn-once fail-closed flag. */
export function __resetAccessJwtStateForTests(): void {
  accessJwksCache = null;
  accessJwksCacheCertsUrl = null;
  warnedAccessJwtFailClosed = false;
}

/**
 * Resolves the current Access JWT mode from process.env - see the section
 * comment above for the three modes. index.ts calls this once at startup so
 * the mode is visible in the boot log and a fail-closed deployment warns
 * immediately (not on first request).
 */
export function getAccessJwtMode(): AccessJwtMode {
  return resolveAccessJwtConfig().mode;
}

/**
 * Pre-warms the JWKS cache (one awaited background refresh) so the first
 * request after process start does not hit the documented cold-start miss.
 * No-op outside "enforce" mode. Never throws (a failed fetch just leaves the
 * cache empty - requests fail closed until a later refresh succeeds).
 */
export async function primeAccessJwtCache(): Promise<void> {
  const config = resolveAccessJwtConfig();
  if (config.mode !== "enforce") {
    return;
  }
  await getAccessJwksCache(config.certsUrl as string).scheduleRefresh();
}

function resolveAccessJwtConfig(): AccessJwtConfig {
  // (1) Explicit escape hatch wins over everything: blind-trust the header.
  if (process.env.CF_ACCESS_DISABLED === "true") {
    return { mode: "disabled" };
  }

  const teamRaw = process.env.CF_ACCESS_TEAM_DOMAIN?.trim() ?? "";
  const aud = process.env.CF_ACCESS_AUD?.trim() ?? "";
  const team = teamRaw ? normalizeTeamDomain(teamRaw) : null;

  // (2) Both fully configured: enforce real JWT verification.
  if (team && aud) {
    return { mode: "enforce", issuer: team.issuer, certsUrl: team.certsUrl, aud };
  }

  // (3) Anything else (nothing set, only one set, or an unusable team domain)
  // fails closed. A missing/half-typed verifier must never fall back to
  // trusting the forgeable email header.
  warnAccessJwtFailClosedOnce();
  return { mode: "fail-closed" };
}

function warnAccessJwtFailClosedOnce(): void {
  if (warnedAccessJwtFailClosed) {
    return;
  }
  warnedAccessJwtFailClosed = true;
  console.error(
    "[identity] Cloudflare Access JWT verification is FAILING CLOSED: set BOTH " +
      "CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD to enforce real verification, or " +
      "CF_ACCESS_DISABLED=true for loopback dev/tests. Until then every " +
      "Cf-Access-Authenticated-User-Email login is rejected (the bare header is " +
      "never trusted without proof)."
  );
}

function getAccessJwksCache(certsUrl: string): JwksCache {
  if (!accessJwksCache || accessJwksCacheCertsUrl !== certsUrl) {
    accessJwksCache = new JwksCache({
      certsUrl,
      // Indirection on purpose: the seam swaps `accessJwksFetcher`, and the
      // cache instance must always see the CURRENT fetcher.
      fetcher: (url) => accessJwksFetcher(url),
      ttlMs: ACCESS_JWKS_CACHE_TTL_MS,
      now: Date.now,
      onError: (error) => {
        console.error(
          `[identity] Access JWKS refresh failed (failing closed): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    });
    accessJwksCacheCertsUrl = certsUrl;
  }
  return accessJwksCache;
}

/**
 * Verifies the `Cf-Access-Jwt-Assertion` header per the mode table in the
 * section comment above. Returns false (request treated as unauthenticated)
 * on ANY failure - missing/malformed token, bad signature, unknown kid (this
 * request; a background refetch is scheduled), expired, wrong aud/iss, or an
 * email-claim mismatch with the `Cf-Access-Authenticated-User-Email` header.
 * Never throws.
 */
export function verifyAccessJwt(req: IdentityRequest): boolean {
  const config = resolveAccessJwtConfig();
  if (config.mode === "disabled") {
    return true;
  }
  if (config.mode === "fail-closed") {
    return false;
  }

  const token = firstHeaderValue(req.headers["cf-access-jwt-assertion"])?.trim();
  if (!token) {
    return false;
  }

  const identity = verifyAccessToken(token, {
    jwksCache: getAccessJwksCache(config.certsUrl as string),
    issuer: config.issuer as string,
    audience: config.aud as string,
    now: Date.now,
    clockSkewSec: 60
  });
  if (!identity) {
    return false;
  }

  // The token's own email claim must match the plain-text header the rest of
  // the identity chain resolves against - otherwise a valid JWT for member A
  // could be replayed alongside a forged header naming member B.
  const headerEmail = firstHeaderValue(req.headers["cf-access-authenticated-user-email"])?.trim();
  if (!headerEmail) {
    return false;
  }
  return identity.email.trim().toLowerCase() === headerEmail.toLowerCase();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

/**
 * Renders the 401 page shown when resolveIdentity returns null. This is
 * intentionally minimal/self-contained for Task 2 - the full site chrome
 * (sidenav, theme tokens, etc.) lands in Task 3's layout engine. It still
 * follows the platform-wide CSP contract: no external requests (no
 * `<script src>`/`<link>`/http(s) URLs), styling is inline-only (allowed by
 * `style-src 'unsafe-inline'`), and the per-request nonce is threaded
 * through (as a `<meta>` tag, since this page has no inline `<script>` to
 * attach it to yet) so callers already have a stable place to read it from
 * once later tasks add one.
 */
export function renderUnauthorizedPage(nonce: string): string {
  const safeNonce = escapeHtml(nonce);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="csp-nonce" content="${safeNonce}">
<title>未获授权 - AlphaLoop</title>
<style>
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0b0f14;
    color: #e6edf3;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .card {
    max-width: 32rem;
    margin: 1rem;
    padding: 2rem;
    border-radius: 0.75rem;
    background: #131a21;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08);
    text-align: center;
  }
  h1 {
    margin: 0 0 0.75rem;
    font-size: 1.25rem;
  }
  p {
    margin: 0;
    line-height: 1.6;
    color: #9aa7b2;
  }
</style>
</head>
<body>
  <div class="card">
    <h1>401 未获授权</h1>
    <p>未获授权：请通过圈内白名单邮箱登录，或联系圈主开通成员。</p>
  </div>
</body>
</html>
`;
}
