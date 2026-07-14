import type { IncomingMessage } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { ApiTokenRepository, MemberRepository, type Member } from "@packages/shared-types";

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
 *      .getByEmail. Unlike the token path, getByEmail does NOT filter by
 *      status (it's a plain lookup used elsewhere for that reason), so this
 *      function enforces `status === 'active'` itself here.
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

  const member = new MemberRepository(db).getByEmail(email);
  if (!member || member.status !== "active") {
    return null;
  }

  return member;
}

/**
 * P10 prerequisite (explicit TODO): Cloudflare Access puts
 * `Cf-Access-Authenticated-User-Email` on every request that reaches this
 * service through the Access tunnel, but ANYTHING reaching platform-app
 * directly (e.g. another local process) can forge that header today - there
 * is no cryptographic proof it came from Access. The real fix is verifying
 * the `Cf-Access-Jwt-Assertion` header against Access's JWKS for AlphaLoop's
 * actual Cloudflare team domain, which does not exist in this local dev
 * environment (P10: "cloudflared/Access 真环境与 JWT 校验"). Until P10 lands,
 * this is a documented no-op - platform-app stays loopback-only
 * (127.0.0.1:4314, never 0.0.0.0) specifically because this check does not
 * yet do anything.
 *
 * TODO(P10): implement real JWT verification here and call it from
 * resolveViaAccessEmailHeader before trusting the email header at all.
 */
export function verifyAccessJwt(_req: IdentityRequest): boolean {
  return true;
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
