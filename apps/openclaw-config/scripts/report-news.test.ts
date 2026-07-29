import { describe, expect, it } from "vitest";

const news = await import("./report-news.mjs");

describe("report news aggregation", () => {
  it("normalizes Yahoo search news with publisher, link, related tickers, and Chinese digest text", () => {
    const articles = news.normalizeYahooSearchNews("AAPL.US", {
      news: [
        {
          uuid: "yahoo-1",
          title: "Northbridge Financial Group LLC Acquires New Shares in Apple Inc. $AAPL",
          publisher: "Simply Wall St.",
          link: "https://finance.yahoo.com/news/aapl-1.html",
          providerPublishTime: 1780236060,
          relatedTickers: ["AAPL"]
        }
      ]
    });

    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject({
      id: "yahoo-1",
      symbol: "AAPL.US",
      source: "yahoo-finance-search",
      sourceName: "Yahoo Finance",
      publisher: "Simply Wall St.",
      url: "https://finance.yahoo.com/news/aapl-1.html",
      relatedTickers: ["AAPL"]
    });
    expect(news.renderDetailedNewsLine(articles[0])).toContain("媒体：Simply Wall St.");
    expect(news.renderDetailedNewsLine(articles[0])).toContain("链接：https://finance.yahoo.com/news/aapl-1.html");
    expect(news.renderDetailedNewsLine(articles[0])).toContain("新建或增持苹果公司持仓");
    expect(news.renderDetailedNewsLine(articles[0])).toContain("原始标题：Northbridge Financial Group LLC Acquires New Shares in Apple Inc. $AAPL");
  });

  it("merges and ranks cross-source articles without duplicating the same link", () => {
    const merged = news.mergeNewsArticles([
      {
        id: "lb-1",
        symbol: "AAPL.US",
        title: "Apple’s Agentic AI Plans Could Be Its Biggest Growth Story Yet",
        url: "https://example.com/aapl-ai",
        publishedAt: "2026-05-30T10:00:00.000Z",
        publishedAtMs: Date.parse("2026-05-30T10:00:00.000Z"),
        source: "longbridge-news"
      },
      {
        id: "yahoo-duplicate",
        symbol: "AAPL.US",
        title: "Apple’s Agentic AI Plans Could Be Its Biggest Growth Story Yet",
        url: "https://example.com/aapl-ai",
        publishedAt: "2026-05-30T11:00:00.000Z",
        publishedAtMs: Date.parse("2026-05-30T11:00:00.000Z"),
        source: "yahoo-finance-search",
        publisher: "Benzinga"
      },
      {
        id: "yahoo-new",
        symbol: "AAPL.US",
        title: "Wall Street’s Top Analysts Raise Apple Price Target",
        url: "https://example.com/aapl-target",
        publishedAt: "2026-05-31T12:00:00.000Z",
        publishedAtMs: Date.parse("2026-05-31T12:00:00.000Z"),
        source: "yahoo-finance-search",
        publisher: "The Motley Fool"
      }
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      id: "yahoo-new",
      sourceName: "Yahoo Finance",
      publisher: "The Motley Fool"
    });
    expect(merged[1].sourceEvidence).toEqual(["longbridge-news", "yahoo-finance-search"]);
  });

  it("keeps non-Longbridge articles visible when rendering a short stock-analysis news list", () => {
    const articles = news.selectDiverseNewsArticles([
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `lb-${index}`,
        symbol: "AAPL.US",
        title: `Longbridge Apple market update ${index}`,
        url: `https://longbridge.com/news/${index}`,
        publishedAt: new Date(Date.UTC(2026, 5, 14, 16, index)).toISOString(),
        publishedAtMs: Date.UTC(2026, 5, 14, 16, index),
        source: "longbridge-news",
        publisher: "Longbridge"
      })),
      {
        id: "yahoo-important",
        symbol: "AAPL.US",
        title: "Apple’s Agentic AI Plans Could Be Its Biggest Growth Story Yet",
        summary: "Analysts said new AI features could support future services revenue.",
        url: "https://finance.yahoo.com/news/aapl-ai.html",
        publishedAt: "2026-06-13T12:00:00.000Z",
        publishedAtMs: Date.parse("2026-06-13T12:00:00.000Z"),
        source: "yahoo-finance-search",
        sourceName: "Yahoo Finance",
        publisher: "Benzinga"
      }
    ], 6);

    expect(articles).toHaveLength(6);
    expect(articles.some((article) => article.source === "yahoo-finance-search")).toBe(true);
    expect(articles.filter((article) => article.source === "longbridge-news")).toHaveLength(5);
  });

  it("renders detailed Chinese news lines with article identity and available snippets", () => {
    const line = news.renderDetailedNewsLine({
      id: "yahoo-2",
      symbol: "AAPL.US",
      title: "Wall Street’s Top Analysts Raise Apple Price Target",
      summary: "Analysts cited stronger iPhone demand and services growth.",
      publisher: "The Motley Fool",
      source: "yahoo-finance-search",
      sourceName: "Yahoo Finance",
      url: "https://finance.yahoo.com/news/aapl-target.html",
      publishedAt: "2026-06-14T10:00:00.000Z",
      publishedAtMs: Date.parse("2026-06-14T10:00:00.000Z")
    });

    expect(line).toContain("华尔街分析师上调苹果公司目标价");
    expect(line).toContain("标题要点：分析师提到 iPhone 需求和服务业务增长");
    expect(line).toContain("原始标题：Wall Street’s Top Analysts Raise Apple Price Target");
  });

  it("turns broad market English headlines into specific Chinese labels instead of generic filler", () => {
    const line = news.renderDetailedNewsLine({
      id: "yahoo-3",
      symbol: "QQQ.US",
      title: "Stock Market Week Ahead: Keep Your Eyes on the Fed",
      publisher: "Investor's Business Daily",
      source: "yahoo-finance-search",
      sourceName: "Yahoo Finance",
      url: "https://finance.yahoo.com/news/stock-market-week-ahead.html",
      publishedAt: "2026-06-14T10:00:00.000Z",
      publishedAtMs: Date.parse("2026-06-14T10:00:00.000Z")
    });

    expect(line).toContain("美股下周关注美联储、利率和风险偏好变化");
    expect(line).not.toContain("媒体报道与纳指 100 ETF相关的公司新闻");
    expect(line).toContain("原始标题：Stock Market Week Ahead: Keep Your Eyes on the Fed");
  });

  it("normalizes external RSS news into auditable source evidence", () => {
    const articles = news.normalizeExternalRssNews("QQQ.US", `
      <rss><channel>
        <item>
          <title>Nasdaq rallies as chip demand supports AI leaders</title>
          <link>https://www.reuters.com/markets/example</link>
          <pubDate>Sat, 13 Jun 2026 14:30:00 GMT</pubDate>
          <source>Reuters</source>
          <description>Chip demand and AI capital spending supported Nasdaq leaders.</description>
        </item>
      </channel></rss>
    `, {
      source: "google-news-rss",
      sourceName: "Google News"
    });

    expect(articles).toHaveLength(1);
    expect(articles[0]).toMatchObject({
      symbol: "QQQ.US",
      source: "google-news-rss",
      sourceName: "Google News",
      publisher: "Reuters",
      url: "https://www.reuters.com/markets/example"
    });
    expect(news.renderDetailedNewsLine(articles[0])).toContain("渠道：Google News");
    expect(news.renderDetailedNewsLine(articles[0])).toContain("标题要点：摘要提到 AI 产品、美股风险偏好、资本开支、需求变化");
  });

  it("renders unknown English news as a Chinese degraded summary instead of banned filler", () => {
    const line = news.renderDetailedNewsLine({
      id: "opaque-english",
      symbol: "AMBA.US",
      title: "Unexpected management transition raises questions",
      summary: "The company said updates will follow after the close.",
      publisher: "Example Wire",
      source: "google-news-rss",
      sourceName: "Google News",
      url: "https://example.com/amba-management",
      publishedAt: "2026-06-19T10:00:00.000Z",
      publishedAtMs: Date.parse("2026-06-19T10:00:00.000Z")
    });

    expect(line).toContain("媒体：Example Wire");
    expect(line).toContain("渠道：Google News");
    expect(line).toContain("标题要点：英文来源摘要未提供可抽取细节");
    expect(line).not.toContain("英文摘要已读取");
    expect(line).not.toContain("事件细节待核对");
  });

  it("does not let encoded RSS link markup become degraded-summary keywords", () => {
    const articles = news.normalizeExternalRssNews("QQQ.US", `
      <rss><channel>
        <item>
          <title>An opaque filing update arrives after the close</title>
          <link>https://news.google.com/rss/articles/example</link>
          <pubDate>Tue, 16 Jun 2026 12:47:00 GMT</pubDate>
          <source>Yahoo Finance</source>
          <description>&lt;a href="https://news.google.com/rss/articles/example"&gt;Opaque filing update&lt;/a&gt;&amp;nbsp;&lt;font color="#6f6f6f"&gt;Yahoo Finance&lt;/font&gt;</description>
        </item>
      </channel></rss>
    `, {
      source: "google-news-rss",
      sourceName: "Google News"
    });

    const line = news.renderDetailedNewsLine(articles[0]);
    expect(line).toContain("标题要点：英文来源摘要未提供可抽取细节");
    expect(line).not.toContain("href、https、news、google");
  });

  // #30 audit fix regression: a legitimately-escaped RSS title used to
  // survive as a live tag because xmlText stripped tags BEFORE decoding
  // entities (nothing to strip yet) and decodeXmlEntities decoded &amp;
  // first (double-decoding &amp;lt; back into a live "<").
  it("never lets a legitimately-escaped RSS title become a live <img> tag (decode order)", () => {
    const articles = news.normalizeExternalRssNews("QQQ.US", `
      <rss><channel>
        <item>
          <title>Fed &lt;img src=x onerror=alert(1)&gt; decision</title>
          <link>https://example.com/fed-decision</link>
          <pubDate>Sat, 13 Jun 2026 14:30:00 GMT</pubDate>
          <source>Reuters</source>
        </item>
      </channel></rss>
    `, {
      source: "google-news-rss",
      sourceName: "Google News"
    });

    expect(articles).toHaveLength(1);
    expect(articles[0].title).not.toContain("<img");
    expect(articles[0].title).not.toContain("onerror=");
    expect(articles[0].title).not.toMatch(/<[^>]+>/u);
    expect(articles[0].title).toBe("Fed decision");

    const line = news.renderDetailedNewsLine(articles[0]);
    expect(line).not.toContain("<img");
    expect(line).not.toMatch(/<[^>]+>/u);
  });

  it("does not double-decode a doubly-escaped entity into a live tag (decodeXmlEntities decodes &amp; last)", () => {
    const articles = news.normalizeExternalRssNews("QQQ.US", `
      <rss><channel>
        <item>
          <title>Report says &amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt; was quoted verbatim</title>
          <link>https://example.com/double-escaped</link>
          <pubDate>Sat, 13 Jun 2026 14:30:00 GMT</pubDate>
          <source>Reuters</source>
        </item>
      </channel></rss>
    `, {
      source: "google-news-rss",
      sourceName: "Google News"
    });

    // A double-escaped entity (&amp;lt; -> the literal text "&lt;") must
    // resolve to exactly one decode level, never all the way to a live "<".
    expect(articles[0].title).not.toContain("<script>");
    expect(articles[0].title).toContain("&lt;script&gt;");
  });

  // #31 audit fix regression: normalizeEpochMs used to fabricate Date.now()
  // for a missing/unparseable date, making undated stale news look
  // "just published".
  it("leaves publishedAt/publishedAtMs unknown (undefined) instead of fabricating Date.now() when a pubDate is missing", () => {
    const articles = news.normalizeExternalRssNews("QQQ.US", `
      <rss><channel>
        <item>
          <title>Undated wire report about QQQ</title>
          <link>https://example.com/undated</link>
          <source>Reuters</source>
        </item>
      </channel></rss>
    `, {
      source: "google-news-rss",
      sourceName: "Google News"
    });

    expect(articles).toHaveLength(1);
    expect(articles[0].publishedAtMs).toBeUndefined();
    expect(articles[0].publishedAt).toBeUndefined();
  });

  it("leaves publishedAt/publishedAtMs unknown when a pubDate string does not parse", () => {
    const articles = news.normalizeYahooSearchNews("QQQ.US", {
      news: [
        {
          uuid: "yahoo-undated",
          title: "Old wire report with a garbled timestamp",
          link: "https://finance.yahoo.com/news/undated.html",
          providerPublishTime: "not-a-real-date"
        }
      ]
    });

    expect(articles).toHaveLength(1);
    expect(articles[0].publishedAtMs).toBeUndefined();
    expect(articles[0].publishedAt).toBeUndefined();
  });

  it("labels an unknown-time article honestly as 时间未知 instead of crashing or guessing a time", () => {
    const line = news.renderDetailedNewsLine({
      id: "no-date",
      symbol: "QQQ.US",
      title: "Undated wire report",
      publisher: "Reuters",
      source: "google-news-rss",
      sourceName: "Google News",
      url: "https://example.com/undated"
    });

    expect(line).toContain("- 时间未知 QQQ.US：");
  });

  it("sorts unknown-time articles last (not first) when merging cross-source news", () => {
    const merged = news.mergeNewsArticles([
      {
        id: "dated",
        symbol: "QQQ.US",
        title: "Dated wire report",
        url: "https://example.com/dated",
        publishedAt: "2026-06-01T00:00:00.000Z",
        publishedAtMs: Date.parse("2026-06-01T00:00:00.000Z"),
        source: "longbridge-news"
      },
      {
        id: "undated",
        symbol: "QQQ.US",
        title: "Undated wire report",
        url: "https://example.com/undated",
        source: "google-news-rss"
      }
    ]);

    expect(merged.map((article) => article.id)).toEqual(["dated", "undated"]);
  });

  // #29 audit fix regression: a malicious title using markdown link syntax
  // must never survive normalization intact - the rendering face
  // (platform-app markdown.ts) turns `[text](url)` into a live anchor.
  it("defuseMarkdownInText neutralizes markdown link syntax deterministically", () => {
    expect(news.defuseMarkdownInText("[紧急：点击核对持仓](https://evil.example/phish)"))
      .toBe("［紧急：点击核对持仓］(https://evil.example/phish)");
    expect(news.defuseMarkdownInText("no markdown link here")).toBe("no markdown link here");
    expect(news.defuseMarkdownInText(undefined)).toBe("");
  });

  it("defuses a malicious markdown-link title from every normalizer source path", () => {
    const maliciousTitle = "[紧急：点击核对持仓](https://evil.example/phish)";

    const rssArticles = news.normalizeExternalRssNews("QQQ.US", `
      <rss><channel>
        <item>
          <title>${maliciousTitle}</title>
          <link>https://example.com/rss-phish</link>
          <pubDate>Sat, 13 Jun 2026 14:30:00 GMT</pubDate>
          <source>Reuters</source>
        </item>
      </channel></rss>
    `, {
      source: "google-news-rss",
      sourceName: "Google News"
    });
    expect(rssArticles[0].title).not.toMatch(/\[[^\]]+\]\(https?:\/\//u);
    expect(rssArticles[0].titleZh).not.toMatch(/\[[^\]]+\]\(https?:\/\//u);

    const yahooArticles = news.normalizeYahooSearchNews("QQQ.US", {
      news: [
        {
          uuid: "yahoo-phish",
          title: maliciousTitle,
          link: "https://finance.yahoo.com/news/phish.html",
          providerPublishTime: 1780236060
        }
      ]
    });
    expect(yahooArticles[0].title).not.toMatch(/\[[^\]]+\]\(https?:\/\//u);
    expect(yahooArticles[0].titleZh).not.toMatch(/\[[^\]]+\]\(https?:\/\//u);

    const decorated = news.decorateNewsArticle({
      id: "direct-phish",
      symbol: "QQQ.US",
      title: maliciousTitle,
      titleZh: maliciousTitle,
      summary: `See details: ${maliciousTitle}`,
      url: "https://example.com/direct-phish",
      source: "yahoo-finance-search"
    });
    expect(decorated.title).not.toMatch(/\[[^\]]+\]\(https?:\/\//u);
    expect(decorated.titleZh).not.toMatch(/\[[^\]]+\]\(https?:\/\//u);
    expect(decorated.summary).not.toMatch(/\[[^\]]+\]\(https?:\/\//u);
  });
});

// 2026-07-28 data-loss regression: newsIdentity's title fallback used to
// normalize with `\W+`, which in JavaScript is ASCII-only ([^A-Za-z0-9_]) even
// under the /u flag. Every CJK character was therefore stripped, so EVERY
// URL-less Chinese headline collapsed to the same empty key and articles 2..N
// were silently dropped as "duplicates" of article 1. The RSSHub Chinese feeds
// (财联社/华尔街见闻/格隆汇) are the primary news source for this product, so
// this quietly discarded most of the daily report's Chinese news.
describe("news identity dedup keeps non-ASCII scripts distinct", () => {
  const CHINESE_HEADLINES = [
    "英伟达发布新一代芯片",
    "台积电产能利用率回升",
    "谷歌云业务增长超预期"
  ];

  function chineseArticle(title: string, index: number) {
    return {
      id: `rsshub-${index}`,
      symbol: "QQQ.US",
      title,
      // No url on purpose: the url branch of newsIdentity would mask the bug.
      publishedAt: new Date(Date.UTC(2026, 6, 20, 1, index)).toISOString(),
      publishedAtMs: Date.UTC(2026, 6, 20, 1, index),
      source: "rsshub-cls",
      sourceName: "财联社",
      publisher: "财联社"
    };
  }

  it("keeps three distinct URL-less Chinese headlines as three distinct articles", () => {
    const articles = CHINESE_HEADLINES.map(chineseArticle);
    const merged = news.mergeNewsArticles(articles);

    expect(merged).toHaveLength(3);
    expect(new Set(merged.map((article) => article.title))).toEqual(new Set(CHINESE_HEADLINES));
  });

  it("renders all three Chinese headlines instead of silently keeping one", () => {
    const selected = news.selectDiverseNewsArticles(CHINESE_HEADLINES.map(chineseArticle), 6);
    const rendered = selected.map((article) => news.renderDetailedNewsLine(article)).join("\n");

    expect(selected).toHaveLength(3);
    for (const title of CHINESE_HEADLINES) {
      expect(rendered).toContain(title);
    }
  });

  it("still merges genuinely duplicate Chinese articles across publishers, keeping source evidence", () => {
    const merged = news.mergeNewsArticles([
      {
        id: "cls-1",
        symbol: "QQQ.US",
        title: "英伟达发布新一代芯片",
        publishedAt: "2026-07-20T01:00:00.000Z",
        publishedAtMs: Date.parse("2026-07-20T01:00:00.000Z"),
        source: "rsshub-cls",
        publisher: "财联社"
      },
      {
        // Same story redistributed: identical headline, different publisher,
        // full-width punctuation and stray whitespace added by the second
        // feed. Must still collapse into ONE article.
        id: "wallstreetcn-1",
        symbol: "QQQ.US",
        title: "英伟达发布新一代芯片 ！",
        publishedAt: "2026-07-20T02:00:00.000Z",
        publishedAtMs: Date.parse("2026-07-20T02:00:00.000Z"),
        source: "rsshub-wallstreetcn",
        publisher: "华尔街见闻"
      },
      {
        // A THIRD, genuinely different URL-less Chinese story: the buggy
        // `\W+` key merged it into the same empty bucket as the 英伟达 pair.
        id: "cls-2",
        symbol: "QQQ.US",
        title: "央行公开市场净投放规模扩大",
        publishedAt: "2026-07-20T02:30:00.000Z",
        publishedAtMs: Date.parse("2026-07-20T02:30:00.000Z"),
        source: "rsshub-cls",
        publisher: "财联社"
      },
      {
        id: "gelonghui-1",
        symbol: "QQQ.US",
        title: "台积电产能利用率回升",
        url: "https://example.com/tsmc",
        publishedAt: "2026-07-20T03:00:00.000Z",
        publishedAtMs: Date.parse("2026-07-20T03:00:00.000Z"),
        source: "rsshub-gelonghui",
        publisher: "格隆汇"
      },
      {
        // Same URL as the previous one: the url branch must keep deduping.
        id: "gelonghui-1-repost",
        symbol: "QQQ.US",
        title: "台积电产能利用率回升（转载）",
        url: "https://example.com/tsmc",
        publishedAt: "2026-07-20T04:00:00.000Z",
        publishedAtMs: Date.parse("2026-07-20T04:00:00.000Z"),
        source: "yahoo-finance-search",
        publisher: "Yahoo"
      }
    ]);

    expect(merged).toHaveLength(3);
    const nvidia = merged.find((article) => article.title.startsWith("英伟达"));
    const tsmc = merged.find((article) => article.title.startsWith("台积电"));
    expect(merged.some((article) => article.title.startsWith("央行"))).toBe(true);
    expect(nvidia?.sourceEvidence).toEqual(["rsshub-cls", "rsshub-wallstreetcn"]);
    expect(tsmc?.sourceEvidence).toEqual(["rsshub-gelonghui", "yahoo-finance-search"]);
  });

  it("dedupes a mixed Chinese + English batch on real title identity", () => {
    const merged = news.mergeNewsArticles([
      { id: "zh-1", symbol: "AAPL.US", title: "苹果发布新款 iPhone", source: "rsshub-cls" },
      { id: "zh-2", symbol: "AAPL.US", title: "苹果服务业务收入创新高", source: "rsshub-cls" },
      // zh-3 shares no Latin characters with zh-2, so the buggy ASCII-only key
      // collapsed the two into one empty bucket.
      { id: "zh-3", symbol: "AAPL.US", title: "供应链称新机备货量上调", source: "rsshub-gelonghui" },
      { id: "en-1", symbol: "AAPL.US", title: "Apple Unveils New iPhone", source: "google-news-rss" },
      { id: "en-1-dupe", symbol: "AAPL.US", title: "Apple  Unveils, New iPhone!", source: "bing-news-rss" },
      { id: "zh-1-dupe", symbol: "AAPL.US", title: "苹果发布新款 iPhone。", source: "rsshub-wallstreetcn" }
    ]);

    expect(merged).toHaveLength(4);
    expect(merged.map((article) => article.title).sort()).toEqual([
      "Apple Unveils New iPhone",
      "供应链称新机备货量上调",
      "苹果发布新款 iPhone",
      "苹果服务业务收入创新高"
    ]);
  });

  it("does not collapse two different pure-punctuation titles into one empty key", () => {
    const merged = news.mergeNewsArticles([
      { id: "punct-1", symbol: "QQQ.US", title: "!!!", source: "google-news-rss" },
      { id: "punct-2", symbol: "QQQ.US", title: "???", source: "google-news-rss" },
      { id: "emoji-1", symbol: "QQQ.US", title: "🚀🚀", source: "bing-news-rss" }
    ]);

    expect(merged).toHaveLength(3);
    expect(merged.map((article) => article.id).sort()).toEqual(["emoji-1", "punct-1", "punct-2"]);
  });
});
