/**
 * Strict HTML-assembly primitives for platform-app's server-rendered pages.
 *
 * The rule these exist to enforce (plan Global Constraints + Task 3): no
 * template function may accept a raw string and splice it into HTML output
 * unescaped. The ONLY sanctioned escape hatch is `trustedHtml()`, which is
 * deliberately named so it is greppable (`grep -rn trustedHtml`) - every call
 * site is a place a human should be able to look at and confirm the string
 * being trusted is either a literal (e.g. an SVG icon copied from
 * final.html) or was already built up out of other `Html` values, never raw
 * user/member/report input.
 */

/**
 * An opaque wrapper around a string that is known-safe to inject into HTML
 * verbatim. There is no way to produce one except `trustedHtml()` or by
 * composing existing `Html` values via `html` / `joinHtml` - plain strings
 * passed through those always get escaped first.
 */
export type Html = { readonly __html: string };

/** The sole escape hatch: wraps a raw string as trusted HTML verbatim. */
export function trustedHtml(raw: string): Html {
  return { __html: raw };
}

const EMPTY_HTML: Html = trustedHtml("");

/** Escapes the five HTML-significant characters: & < > " ' */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

/**
 * Escapes a value for use inside a double-quoted HTML attribute. Uses the
 * same escaping as `escapeHtml` (which already covers `"`) - kept as a
 * separate, differently-named export so call sites at attribute positions
 * read clearly and so the two concerns (text content vs. attribute value)
 * can diverge later without a signature change.
 */
export function attr(value: string): string {
  return escapeHtml(value);
}

/** Values the `html` tagged template accepts as interpolations. */
export type HtmlInterpolation =
  | Html
  | string
  | number
  | ReadonlyArray<Html | string>
  | null
  | undefined
  | false;

function interpolate(value: HtmlInterpolation): string {
  if (value === null || value === undefined || value === false) {
    return "";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    return escapeHtml(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolate(item)).join("");
  }
  // Remaining case: a single Html object.
  return (value as Html).__html;
}

/**
 * Tagged template for assembling HTML. Every interpolated plain string (or
 * array of strings) is escaped automatically; interpolated `Html` values
 * (or arrays of them) are spliced in raw, since they are already trusted.
 * Numbers are stringified as-is; `null`/`undefined`/`false` render as
 * nothing (handy for conditional fragments).
 */
export function html(strings: TemplateStringsArray, ...values: HtmlInterpolation[]): Html {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i += 1) {
    out += interpolate(values[i]);
    out += strings[i + 1] ?? "";
  }
  return trustedHtml(out);
}

/** Joins already-trusted `Html` fragments with an optional raw separator. */
export function joinHtml(parts: readonly Html[], separator = ""): Html {
  if (parts.length === 0) {
    return EMPTY_HTML;
  }
  return trustedHtml(parts.map((part) => part.__html).join(separator));
}
