import { describe, expect, it } from "vitest";

import { renderMarkdown } from "./markdown.js";

function bodyOf(md: string): string {
  return renderMarkdown(md).html.__html;
}

describe("renderMarkdown: block structure", () => {
  it("renders #/##/### headings as h1/h2/h3", () => {
    const out = bodyOf("# 一级\n\n## 二级\n\n### 三级\n");
    expect(out).toContain("<h1>一级</h1>");
    expect(out).toMatch(/<h2 id="[^"]+">二级<\/h2>/u);
    expect(out).toContain("<h3>三级</h3>");
  });

  it("renders paragraphs", () => {
    const out = bodyOf("这是一段普通文本。\n");
    expect(out).toContain("<p>这是一段普通文本。</p>");
  });

  it("renders unordered lists", () => {
    const out = bodyOf("- 第一项\n- 第二项\n");
    expect(out).toContain("<ul><li>第一项</li><li>第二项</li></ul>");
  });

  it("renders ordered lists", () => {
    const out = bodyOf("1. 第一项\n2. 第二项\n");
    expect(out).toContain("<ol><li>第一项</li><li>第二项</li></ol>");
  });

  it("renders pipe tables with the first row as a header", () => {
    const out = bodyOf("| 标的 | 价格 |\n| --- | --- |\n| QQQ | 740.62 |\n");
    expect(out).toContain("<table><tbody>");
    expect(out).toContain("<tr><th>标的</th><th>价格</th></tr>");
    expect(out).toContain("<tr><td>QQQ</td><td>740.62</td></tr>");
  });

  // Task 23 (2026-07-30): a wide report table used to push the whole PAGE
  // sideways on a phone. Each table now carries its own horizontal scroll
  // container (`.table-scroll`, styled overflow-x:auto in routes/reports.ts's
  // REPORT_BODY_STYLE).
  it("wraps every table in its own horizontal scroll container", () => {
    const out = bodyOf("| 标的 | 价格 |\n| --- | --- |\n| QQQ | 740.62 |\n");
    expect(out).toContain('<div class="table-scroll" role="region" aria-label="可横向滚动的表格" tabindex="0"><table>');
    expect(out).toContain("</table></div>");
  });

  it("gives each of two tables its own scroll container rather than one shared wrapper", () => {
    const out = bodyOf("| A |\n| --- |\n| 1 |\n\n段落\n\n| B |\n| --- |\n| 2 |\n");
    expect(out.match(/class="table-scroll"/gu)).toHaveLength(2);
  });

  it("renders fenced code blocks verbatim (no inline markdown processing inside)", () => {
    const out = bodyOf("```\n**not bold** [not a link](http://x.com)\n```\n");
    expect(out).toContain("<pre><code>**not bold** [not a link](http://x.com)</code></pre>");
  });

  it("flushes an unterminated fenced code block at EOF instead of dropping it", () => {
    const out = bodyOf("```\n遗漏了收尾的代码块\n");
    expect(out).toContain("<pre><code>遗漏了收尾的代码块</code></pre>");
  });
});

describe("renderMarkdown: inline formatting", () => {
  it("renders bold, italic, and inline code", () => {
    const out = bodyOf("**加粗** *斜体* `代码`\n");
    expect(out).toContain("<strong>加粗</strong>");
    expect(out).toContain("<em>斜体</em>");
    expect(out).toContain("<code>代码</code>");
  });

  it("does not delete space-padded plain-text numbers (regression: token collision)", () => {
    // A prior implementation used whitespace-delimited placeholder tokens,
    // which collided with ordinary space-padded numbers like this and
    // silently deleted them.
    const out = bodyOf("已遵守 23 天，0 条待验证。\n");
    expect(out).toContain("已遵守 23 天，0 条待验证。");
  });

  it("renders http(s) links as anchors with rel=noreferrer and target=_blank", () => {
    const out = bodyOf("详见[原文](https://example.com/a)。\n");
    expect(out).toContain('<a href="https://example.com/a" rel="noreferrer" target="_blank">原文</a>');
  });

  it("collects http(s) links into sources", () => {
    const result = renderMarkdown("详见[原文](https://example.com/a)和[另一篇](http://example.com/b)。\n");
    expect(result.sources).toEqual([
      { text: "原文", url: "https://example.com/a" },
      { text: "另一篇", url: "http://example.com/b" }
    ]);
  });
});

describe("renderMarkdown: XSS/security probes", () => {
  it("escapes a raw <script> tag in a paragraph", () => {
    const out = bodyOf('<script>alert(1)</script>\n');
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes a raw <script> tag inside a heading", () => {
    const out = bodyOf('## <script>alert(1)</script>\n');
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes a raw <script> tag inside link text", () => {
    const out = bodyOf('[<script>alert(1)</script>](https://example.com)\n');
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // The anchor itself must still be a real, safe anchor.
    expect(out).toContain('<a href="https://example.com" rel="noreferrer" target="_blank">');
  });

  it("escapes a raw <script> tag inside a table cell", () => {
    const out = bodyOf("| 列 |\n| --- |\n| <script>alert(1)</script> |\n");
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes a raw <script> tag inside a fenced code block", () => {
    const out = bodyOf("```\n<script>alert(1)</script>\n```\n");
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("renders a javascript: link as plain text, not an anchor", () => {
    const out = bodyOf("[点我](javascript:alert(1))\n");
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("<a ");
    expect(out).toContain("点我");
  });

  it("does not collect a javascript: link into sources", () => {
    const result = renderMarkdown("[点我](javascript:alert(1))\n");
    expect(result.sources).toEqual([]);
  });

  it("renders a protocol-relative link as plain text, not an anchor", () => {
    const out = bodyOf("[链接](//evil.example.com)\n");
    expect(out).not.toContain("<a ");
    expect(out).toContain("链接");
  });

  it("escapes ampersands and quotes generally", () => {
    const out = bodyOf('A & B "quoted" \'single\'\n');
    expect(out).toContain("A &amp; B &quot;quoted&quot; &#39;single&#39;");
  });
});

describe("renderMarkdown: TOC anchors", () => {
  it("assigns stable ids to H2 headings, keeping Chinese characters", () => {
    const result = renderMarkdown("## 今日结论\n\n内容。\n");
    expect(result.toc).toEqual([{ id: "今日结论", text: "今日结论", level: 2 }]);
    expect(result.html.__html).toContain('<h2 id="今日结论">今日结论</h2>');
  });

  it("does not add H1 or H3 headings to the toc", () => {
    const result = renderMarkdown("# 标题\n\n## 二级\n\n### 三级\n");
    expect(result.toc).toEqual([{ id: "二级", text: "二级", level: 2 }]);
  });

  it("disambiguates duplicate H2 headings", () => {
    const result = renderMarkdown("## 复盘\n\n内容。\n\n## 复盘\n\n更多内容。\n");
    expect(result.toc.map((entry) => entry.id)).toEqual(["复盘", "复盘-2"]);
  });

  it("produces the same id for the same heading text across renders (stability)", () => {
    const first = renderMarkdown("## 风险与异常\n");
    const second = renderMarkdown("## 风险与异常\n");
    expect(first.toc[0]?.id).toBe(second.toc[0]?.id);
  });
});

// Task 20 (2026-07-28 spec-drift plan): the report's calendar section became
// `### 宏观与财报日历` over `#### 宏观日历` / `#### 财报日历`. HEADING_RE was
// `#{1,3}`, which cannot match a level-4 line at all (its 4th character is `#`,
// not whitespace) - the line fell through to the paragraph branch and the
// reading page printed a literal "#### 宏观日历" to the user.
describe("level-4 headings (report sub-sections)", () => {
  const rendered = renderMarkdown(
    [
      "## 2. 信息收集与分类",
      "",
      "### 宏观与财报日历",
      "",
      "#### 宏观日历",
      "",
      "- 2026-07-18 20:30 美国费城联储制造业指数",
      "",
      "#### 财报日历",
      "",
      "- 2026-08-26 盘后 NVDA.US 2027 财年 Q2 财报。"
    ].join("\n")
  );

  it("renders them as h4, not as literal text", () => {
    expect(rendered.html.__html).toContain("<h4>宏观日历</h4>");
    expect(rendered.html.__html).toContain("<h4>财报日历</h4>");
    expect(rendered.html.__html).not.toContain("#### ");
  });

  it("leaves the h2-only table of contents alone", () => {
    expect(rendered.toc.map((entry) => entry.text)).toEqual(["2. 信息收集与分类"]);
  });

  it("still renders the h3 section heading above them", () => {
    expect(rendered.html.__html).toContain("<h3>宏观与财报日历</h3>");
  });
});
