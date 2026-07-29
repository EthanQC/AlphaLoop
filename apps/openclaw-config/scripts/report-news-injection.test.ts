import { describe, expect, it } from "vitest";

// Regression test (#29 audit fix): a malicious news title using markdown link
// syntax must never become a live, clickable anchor in the rendering face this
// repo has - the platform-app report reading page (markdown.ts's
// renderMarkdown). It recognizes `[text](url)` via the literal ASCII bracket
// shape; defuseMarkdownInText (applied in the news normalizer/decorate layer,
// report-news.mjs) must break that syntax before that sink ever sees it.
//
// 2026-07-30: this file used to assert the same property against a SECOND
// face - the report HTML renderer that fed Chrome's print-to-pdf. The PDF is
// retired (§0.4), that renderer is deleted, and with it the face - one sink,
// one assertion. The news text itself is still checked here (`line` must not
// carry the bracket shape at all), which is the property that protects any
// future sink.
import { renderMarkdown } from "../../platform-app/src/reports/markdown.js";

const news = await import("./report-news.mjs");

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

describe("news title injection is defused before it reaches the rendering face", () => {
  it("strips the markdown-link shape out of the news line itself", () => {
    expect(buildMaliciousLine()).not.toMatch(/\[[^\]]+\]\(https?:\/\//u);
  });

  it("produces no anchor in the platform-app rendering face (markdown.ts renderMarkdown)", () => {
    const line = buildMaliciousLine();

    const result = renderMarkdown(line);

    expect(result.html.__html).not.toContain("<a ");
    expect(result.html.__html).not.toMatch(/<a\b[^>]*href="https:\/\/evil\.example\/phish"/u);
    expect(result.sources).toEqual([]);
  });
});
