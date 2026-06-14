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
});
