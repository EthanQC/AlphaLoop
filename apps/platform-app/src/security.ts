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
