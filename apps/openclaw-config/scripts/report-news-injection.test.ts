import { describe, expect, it } from "vitest";

// Cross-face regression test (#29 audit fix): a malicious news title using
// markdown link syntax must never become a live, clickable anchor in
// EITHER rendering face this repo has - the PDF daily/weekly report
// (report-rendering.mjs's formatInlineHtml, exercised here through the
// exported renderReportHtml) and the platform-app report reading page
// (markdown.ts's renderMarkdown). Both sinks recognize `[text](url)` via
// the same literal ASCII bracket shape; defuseMarkdownInText (applied in
// the news normalizer/decorate layer, report-news.mjs) must break that
// syntax before either sink ever sees it - this test imports both faces
// directly so a regression in either one is caught here.
import { renderMarkdown } from "../../platform-app/src/reports/markdown.js";

const news = await import("./report-news.mjs");
const rendering = await import("./report-rendering.mjs");

const MALICIOUS_TITLE = "[紧急：点击核对持仓](https://evil.example/phish)";

function buildMaliciousLine(): string {
  const article = news.decorateNewsArticle({
    id: "phish-1",
    symbol: "QQQ.US",
    title: MALICIOUS_TITLE,
    titleZh: MALICIOUS_TITLE,
    url: "https://example.com/phish-source",
    source: "google-news-rss",
    sourceName: "Google News",
    publisher: "Example Wire",
    publishedAt: "2026-06-14T10:00:00.000Z",
    publishedAtMs: Date.parse("2026-06-14T10:00:00.000Z")
  });
  return news.renderDetailedNewsLine(article);
}

describe("news title injection is defused across both rendering faces", () => {
  it("produces no <a> in the PDF rendering face (report-rendering.mjs renderReportHtml)", () => {
    const line = buildMaliciousLine();
    expect(line).not.toMatch(/\[[^\]]+\]\(https?:\/\//u);

    const html = rendering.renderReportHtml(`### 多源新闻\n\n${line}`);

    expect(html).not.toContain('<a href="https://evil.example/phish">');
    expect(html).not.toMatch(/<a\b[^>]*href="https:\/\/evil\.example\/phish"/u);
  });

  it("produces no anchor in the platform-app rendering face (markdown.ts renderMarkdown)", () => {
    const line = buildMaliciousLine();

    const result = renderMarkdown(line);

    expect(result.html.__html).not.toContain("<a ");
    expect(result.html.__html).not.toMatch(/<a\b[^>]*href="https:\/\/evil\.example\/phish"/u);
    expect(result.sources).toEqual([]);
  });
});
