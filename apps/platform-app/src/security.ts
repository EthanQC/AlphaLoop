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
 * The one Cache-Control value this service ever sends (see the block comment
 * below for why it is unconditional):
 *
 *   - `private` forbids any SHARED cache (the cloudflared/Cloudflare edge, a
 *     corporate proxy) from storing the response for a second viewer;
 *   - `no-store` additionally keeps it out of the browser's own disk cache and
 *     off the back/forward path after the member logs out.
 */
export const NO_SHARED_CACHE = "private, no-store";

/**
 * The complete set of request headers that can change WHO a response is for -
 * exactly the inputs of identity.ts's resolution chain (bearer token, session
 * cookie, Access email + its JWT assertion).
 *
 * `NO_SHARED_CACHE` above is the real protection; this is defence in depth for
 * the one deployment shape that can defeat it. A Cloudflare "Cache Everything"
 * rule (or any proxy configured to override origin freshness) will store an
 * HTML response despite `no-store`; such a cache still keys entries by `Vary`,
 * so listing the identity headers means a stored entry cannot be handed to a
 * viewer who authenticated differently. Note the session cookie is the live
 * browser path (routes/login.ts), which is why `Cookie` leads the list.
 */
export const IDENTITY_VARY = "Cookie, Authorization, Cf-Access-Authenticated-User-Email, Cf-Access-Jwt-Assertion";

/**
 * Applies the platform-app security header baseline to every response.
 * CSP is intentionally locked down: no third-party requests are allowed
 * (`default-src 'none'`), only inline styles/data-URI images are permitted,
 * and inline scripts must carry the per-request nonce.
 *
 * CACHING (defect N1, 2026-07-28 review; supersedes the per-route opt-in that
 * shipped as B2): the anti-caching headers are part of this baseline, applied
 * to EVERY response, because in this app there is no such thing as a
 * viewer-independent member-facing page. `render/layout.ts` puts the resolved
 * member's display name in the topbar of every page it renders, and several
 * pages go much further (the /reports list shows the viewer's own 模拟盘快照
 * entries plus their owner-scoped 研判/复盘 archives; /paper, /strategy,
 * /daily|weekly/<date>/me are one member's account content) - all at URLs that
 * are byte-identical for every member. B2 modelled this as a property a route
 * opts into, and the very next change (B1, which made /reports viewer-
 * dependent) shipped without opting in, because nothing forces an author to
 * notice. Making it unconditional removes that whole failure mode: a new route
 * cannot forget a header it never had to ask for. The cost is nil - this
 * service serves no static assets (CSP `default-src 'none'`, styles inline)
 * and every response is dynamically rendered per request.
 *
 * Set via setHeader, so a handler's own `writeHead` map still WINS for keys it
 * lists - a handler that spells `cache-control` itself silently replaces this
 * value rather than adding to it. routes/login.ts is the only handler that
 * does (its three session-cookie responses), and it writes `NO_SHARED_CACHE`
 * itself for exactly that reason.
 *
 * src/cache-headers.test.ts is the guard: it stands up the real server and
 * asserts the WIRE values of `cache-control` and `vary` on every route,
 * enumerating the routes from server.ts's own dispatch chain (and from each
 * dispatched module's path literals) rather than from a list kept by hand, so
 * a route added later cannot escape the assertion by being forgotten. It
 * caught login.ts's bare `no-store` - which had dropped `private` on the login
 * and logout responses - the first time it ran.
 */
export function applySecurityHeaders(res: ServerResponse, nonce: string): void {
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}'`
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", NO_SHARED_CACHE);
  res.setHeader("Vary", IDENTITY_VARY);
}

// NOTE: `applyPrivateCacheHeaders` (defect B2's per-route opt-in) is gone on
// purpose - see the caching paragraph on applySecurityHeaders above. There is
// no longer a per-route switch to remember, and nothing should reintroduce one:
// a route that wants to be cacheable by a shared cache would first have to stop
// rendering the viewer's identity into its body.
