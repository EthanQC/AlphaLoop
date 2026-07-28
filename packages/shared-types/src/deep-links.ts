// Single source of truth for links that point back at the member-facing
// platform app (§1.1 of docs/superpowers/specs/2026-07-12-detailed-
// requirements.md). Every Feishu card, notification and report that references
// a platform page MUST get its URL from here - nothing else may concatenate a
// base url with a path, because the path segments below are the contract the
// platform router already implements (apps/platform-app/src/routes/*.ts) and a
// second, drifting copy of them is exactly the kind of breakage this module
// exists to prevent.
//
// Two failure modes, deliberately handled differently:
//   - The deployment has no public base url configured -> `null`. This is an
//     environment fact, not a bug: the caller degrades to a link-free message
//     ("请在平台查看全文"). Callers must never fall back to printing a bare
//     path or a placeholder host - a path with no origin is useless in a
//     Feishu card and a fake host is fabricated data.
//   - The caller asks for a kind that does not exist, or passes a blank id ->
//     throw. Both are programming errors; a blank id would silently produce a
//     link to a listing page that looks right and goes to the wrong place.

const BASE_URL_ENV = "PLATFORM_PUBLIC_BASE_URL";

/**
 * Every platform page that can be linked to from outside the platform.
 * `personal-*` are the owner-only variants of the report reading pages.
 */
export type DeepLinkKind =
  | "daily"
  | "weekly"
  | "stock-analysis"
  | "official-paper"
  | "stock"
  | "proposal"
  | "research"
  | "review"
  | "member"
  | "personal-daily"
  | "personal-weekly";

/**
 * kind -> `[prefix, suffix]` around the encoded id. Mirrors the router:
 * `READING_PATH_SEGMENTS` in routes/reports.ts (daily / weekly /
 * stock-analysis / official-paper), routes/stock.ts, routes/proposal.ts,
 * routes/research.ts, routes/review.ts, routes/member-card.ts, and the
 * owner-only `/me` routes.
 *
 * `official-paper` is owner-gated (routes/reports.ts
 * `refusedOwnerScopedReport`: 403 for anyone who is not the snapshot's
 * attributed owner, decided before the file is looked up so the response
 * never reveals which dates exist). Linking to it is therefore safe in a
 * card that already went to that owner's own DM - and only there, which is
 * what the ReportScope marker in notifications.ts enforces.
 */
const PATH_SHAPES: Record<DeepLinkKind, readonly [string, string]> = {
  daily: ["/daily/", ""],
  weekly: ["/weekly/", ""],
  "stock-analysis": ["/stock-analysis/", ""],
  "official-paper": ["/official-paper/", ""],
  stock: ["/stock/", ""],
  proposal: ["/proposal/", ""],
  research: ["/research/", ""],
  review: ["/review/", ""],
  member: ["/member/", ""],
  "personal-daily": ["/daily/", "/me"],
  "personal-weekly": ["/weekly/", "/me"]
};

/**
 * Absolute URL for a platform page, or `null` when this deployment has no
 * public base url configured (`PLATFORM_PUBLIC_BASE_URL`, e.g.
 * `https://reports.qingverse.com`).
 *
 * The env var is read on every call, not at module load, because the CLI
 * entrypoints load `.env.local` after their imports have already been
 * evaluated.
 *
 * @throws {TypeError} when `kind` is not a known page or `id` is blank.
 */
export function buildDeepLink(kind: DeepLinkKind, id: string): string | null {
  const shape = PATH_SHAPES[kind];
  if (!shape) {
    throw new TypeError(`unknown deep link kind: ${String(kind)}`);
  }

  const trimmedId = typeof id === "string" ? id.trim() : "";
  if (trimmedId.length === 0) {
    throw new TypeError(`deep link id must be a non-empty string (kind: ${kind})`);
  }

  const base = normalizeBaseUrl(process.env[BASE_URL_ENV]);
  if (!base) {
    return null;
  }

  const [prefix, suffix] = shape;
  return `${base}${prefix}${encodeURIComponent(trimmedId)}${suffix}`;
}

/**
 * Trailing slashes are stripped so callers can configure either
 * `https://host` or `https://host/` without producing `//daily/...`. A value
 * that is not an absolute http(s) URL is treated as "not configured" rather
 * than as a link, since a relative or malformed origin cannot be opened from a
 * Feishu card anyway.
 */
function normalizeBaseUrl(raw: string | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }

  return trimmed.replace(/\/+$/u, "");
}
