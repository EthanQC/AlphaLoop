import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";

/**
 * Generates a fresh per-request nonce for the inline `<script>` allowed by
 * the platform-app CSP. Never reuse a nonce across requests/responses.
 */
export function createNonce(): string {
  return randomBytes(16).toString("base64");
}

/**
 * Applies the platform-app security header baseline to every response.
 * CSP is intentionally locked down: no third-party requests are allowed
 * (`default-src 'none'`), only inline styles/data-URI images are permitted,
 * and inline scripts must carry the per-request nonce.
 */
export function applySecurityHeaders(res: ServerResponse, nonce: string): void {
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}'`
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

/**
 * Cache-Control for OWNER-PRIVATE responses (defect B2, 2026-07-28 review):
 * the personal pages (routes/personal.ts) and the owner-scoped 模拟盘快照
 * reading page (routes/reports.ts). These carry one member's holdings,
 * strategy and account content, and the service is reachable through
 * cloudflared, so "only the owner sees this" has to hold at the cache layer
 * as well as in the handler:
 *
 *   - `private` forbids any shared cache (the tunnel/CDN edge, a corporate
 *     proxy) from storing the response for a second viewer;
 *   - `no-store` additionally keeps it out of the browser's own disk cache and
 *     off the back/forward path after the member logs out.
 *
 * Applied per-route rather than inside applySecurityHeaders on purpose: this
 * is an authorization property of the specific response, and the public,
 * circle-wide pages have no reason to become uncacheable. Call it BEFORE
 * `writeHead` - Node merges setHeader values with writeHead's own map.
 */
export function applyPrivateCacheHeaders(res: ServerResponse): void {
  res.setHeader("Cache-Control", "private, no-store");
}
