import { describe, expect, it } from "vitest";

import { renderMarkdown } from "../reports/markdown.js";
import { renderReportToc } from "./toc.js";

const NONCE = "test-nonce-AAA/BBB+CCC=";

/** Builds the TOC from a REAL renderMarkdown result rather than a hand-typed
 * entry list, so the ids the links point at are the ids the headings actually
 * carry - a hand-made fixture could agree with itself while pointing at
 * anchors that do not exist in the document. */
function tocFor(md: string, nonce = NONCE): string {
  return renderReportToc(renderMarkdown(md).toc, nonce).__html;
}

const SAMPLE = "# 日报\n\n## 一、市场概览\n\n正文\n\n## 二、宏观日历\n\n正文\n";

describe("renderReportToc", () => {
  it("renders one link per H2, pointing at the id that heading really has", () => {
    const rendered = renderMarkdown(SAMPLE);
    const out = renderReportToc(rendered.toc, NONCE).__html;

    expect(rendered.toc).toHaveLength(2);
    for (const entry of rendered.toc) {
      expect(out).toContain(`href="#${entry.id}"`);
      expect(out).toContain(`data-toc-link="${entry.id}"`);
      // The anchor the link targets must exist in the rendered body.
      expect(rendered.html.__html).toContain(`id="${entry.id}"`);
    }
  });

  it("renders nothing at all for a document with no H2 headings", () => {
    expect(tocFor("# 只有标题\n\n正文\n")).toBe("");
  });

  it("carries the request's CSP nonce on its script (a nonce-less script would be blocked)", () => {
    const out = tocFor(SAMPLE);
    expect(out).toContain(`<script nonce="test-nonce-AAA/BBB+CCC=">`);
    expect(out).not.toMatch(/<script(?![^>]*nonce=)/u);
  });

  it("uses IntersectionObserver and sets aria-current on the active entry", () => {
    const out = tocFor(SAMPLE);
    expect(out).toContain("new IntersectionObserver");
    expect(out).toContain("toc-active");
    expect(out).toContain('setAttribute("aria-current", "true")');
    expect(out).toContain('removeAttribute("aria-current")');
  });

  it("uses no inline event-handler attributes (a nonce-only script-src does not cover them)", () => {
    expect(tocFor(SAMPLE)).not.toMatch(/\son[a-z]+=/u);
  });

  // THE DEFECT THIS PAIR EXISTS FOR (2026-07-30). The first version of this
  // module ran its setup synchronously. The tag is emitted ABOVE
  // `<div class="report-body">`, so at execution time `.report-body h2[id]`
  // matched nothing, the script hit its own "no headings" guard, and NOTHING
  // was ever highlighted on any report - while every text-shape assertion in
  // this file stayed green. It was caught by driving the real page in a
  // browser, and these two assertions are what would have caught it here.
  it("waits for DOMContentLoaded instead of querying a document that is still parsing", () => {
    const out = tocFor(SAMPLE);
    expect(out).toContain('if (document.readyState === "loading")');
    expect(out).toContain('document.addEventListener("DOMContentLoaded", start)');
  });

  // The other half of that pair - "the script really does land above the
  // .report-body it queries, on the real page" - is asserted in
  // routes/reading-surfaces.test.ts against the actual server response,
  // because only the page assembler knows the emitted order.

  it("observes the report body's own H2 anchors, matching the selector the links use", () => {
    const out = tocFor(SAMPLE);
    expect(out).toContain('.report-body h2[id]');
    expect(out).toContain('[data-toc-link]');
  });

  it("escapes heading text rather than letting a report inject markup through the TOC", () => {
    const out = tocFor('# t\n\n## <img src=x onerror=alert(1)>\n\n正文\n');
    expect(out).not.toContain("<img src=x");
    expect(out).toContain("&lt;img src=x");
  });

  it("still works without JavaScript: the entries are real anchor links", () => {
    const out = tocFor(SAMPLE);
    const withoutScript = out.slice(0, out.indexOf("<script"));
    expect(withoutScript).toContain("<a href=\"#");
    expect(withoutScript).toContain("<details open>");
    expect(withoutScript).toContain("<nav class=\"report-toc\" aria-label=\"报告目录\">");
  });
});
