/**
 * The report reading page's 目录 (Task 23, 2026-07-30), with scroll
 * highlighting.
 *
 * Before this module the TOC was a `<details>` full of plain `#anchor` links
 * rendered inline in routes/reports.ts. On a 3000-word daily report that is a
 * jump list and nothing else: once you have scrolled, it no longer tells you
 * where you are, which is most of what a table of contents is for.
 *
 * WHY A SCRIPT AT ALL, AND WHY IT IS SAFE UNDER THIS SITE'S CSP
 * -------------------------------------------------------------
 * security.ts sends `default-src 'none'; style-src 'unsafe-inline'; img-src
 * data:; script-src 'nonce-<nonce>'` - no `'unsafe-inline'` for scripts and
 * no host source at all, so an inline `<script>` runs ONLY if it carries this
 * request's nonce, and nothing can be fetched from anywhere. Per CSP3 a
 * nonce-only `script-src` also does not cover inline event-handler attributes
 * (`onclick=`), which is why the observer below is wired with
 * `addEventListener`-style APIs from inside the nonce'd block rather than any
 * `on*` attribute - the same rule render/layout.ts's theme script already
 * documents and follows.
 *
 * The script body is a fixed literal (no interpolation of anything derived
 * from a report, a member or a request), so there is no injection surface in
 * it; the ONLY interpolated value on the whole element is `nonce`, at an
 * attribute position, escaped by the `html` tag.
 *
 * NO-JS AND NO-INTERSECTIONOBSERVER BEHAVIOR: the markup is a real `<nav>` of
 * real `<a href="#id">` links and works with the script blocked or absent -
 * highlighting is the only thing that is lost. The script itself returns
 * early when the browser has no `IntersectionObserver`.
 */
import { html, joinHtml, trustedHtml, type Html } from "./html.js";
import type { MarkdownTocEntry } from "../reports/markdown.js";

/**
 * Offset (px) from the top of the viewport at which a heading counts as "the
 * section you are reading". Chosen to clear the sticky topbar; used in BOTH
 * places that need it - the observer's `rootMargin` (so the observer fires
 * exactly when a heading crosses that line) and the rect comparison that
 * decides the active entry - so the two can never disagree about where the
 * line is.
 */
const ACTIVE_LINE_PX = 96;

/**
 * THE DEFERRAL, AND WHY IT IS LOAD-BEARING (found by running the real page in
 * a browser, 2026-07-30 - the unit test that asserted the script's TEXT was
 * green the whole time the feature was dead).
 *
 * `renderReportToc`'s output is emitted INSIDE the report card, ABOVE
 * `<div class="report-body">`. A classic inline `<script>` runs the instant
 * the parser reaches it, so at that moment `.report-body h2[id]` matches
 * NOTHING - the headings are still further down the byte stream. The script
 * hit its own `!headings.length` guard, returned, and no entry was ever
 * highlighted on any report. Waiting for `DOMContentLoaded` when the document
 * is still parsing fixes it regardless of where the tag ends up sitting,
 * which is better than depending on the emitted order staying as it is.
 *
 * `toc.test.ts` asserts BOTH the guard and the emitted order, so a future
 * edit that removes the guard while the tag is still above the body fails.
 */
const TOC_READY_GUARD = `if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", start); } else { start(); }`;

/**
 * Recomputes the active entry from the headings' live rects on every
 * crossing, rather than from the IntersectionObserver entries themselves.
 * The reason: `isIntersecting` answers "is this heading inside the band",
 * and while you read the MIDDLE of a long section no heading is inside the
 * band at all - an entries-driven implementation highlights nothing there,
 * exactly where the reader most needs to be told which section they are in.
 * Rects answer the question that actually matters: which heading was the last
 * one to pass the line.
 */
const TOC_SCRIPT = `(function(){
  function start(){
  var links = document.querySelectorAll("[data-toc-link]");
  var headings = document.querySelectorAll(".report-body h2[id]");
  if (!links.length || !headings.length || typeof IntersectionObserver !== "function") { return; }
  function paint(){
    var current = "";
    for (var i = 0; i < headings.length; i++) {
      if (headings[i].getBoundingClientRect().top <= ${ACTIVE_LINE_PX}) { current = headings[i].id; } else { break; }
    }
    if (!current) { current = headings[0].id; }
    for (var j = 0; j < links.length; j++) {
      var on = links[j].getAttribute("data-toc-link") === current;
      links[j].classList.toggle("toc-active", on);
      if (on) { links[j].setAttribute("aria-current", "true"); } else { links[j].removeAttribute("aria-current"); }
    }
  }
  var observer = new IntersectionObserver(paint, { rootMargin: "-${ACTIVE_LINE_PX}px 0px 0px 0px", threshold: [0, 1] });
  for (var k = 0; k < headings.length; k++) { observer.observe(headings[k]); }
  paint();
  }
  ${TOC_READY_GUARD}
})();`;

const TOC_STYLE = trustedHtml(`<style>
.report-toc summary{cursor:pointer;font-size:13px;color:var(--sub);padding:4px 0}
.report-toc ul{margin:6px 0 0 18px;font-size:13px;list-style:disc}
.report-toc li{margin:4px 0}
.report-toc a{color:var(--accent);text-decoration:none}
.report-toc a:hover{text-decoration:underline}
.report-toc a.toc-active{font-weight:600;text-decoration:underline}
</style>`);

/**
 * Renders the 目录 block for a rendered report, or nothing at all when the
 * report has no `##` headings (an empty `<details>` labelled 目录 would claim
 * a navigation aid that has nowhere to go).
 *
 * `open` because a collapsed TOC cannot show you where you are - the whole
 * point of the highlighting - and a daily report's heading list is short.
 */
export function renderReportToc(toc: readonly MarkdownTocEntry[], nonce: string): Html {
  if (toc.length === 0) {
    return trustedHtml("");
  }
  const items = joinHtml(
    toc.map(
      (item) =>
        html`<li><a href="#${item.id}" data-toc-link="${item.id}">${item.text}</a></li>`
    )
  );
  return html`<nav class="report-toc" aria-label="报告目录">
    <details open>
      <summary>目录</summary>
      <ul>${items}</ul>
    </details>
  </nav>
  ${TOC_STYLE}
  <script nonce="${nonce}">${trustedHtml(TOC_SCRIPT)}</script>`;
}
