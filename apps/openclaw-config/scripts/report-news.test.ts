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
    expect(news.renderDetailedNewsLine(articles[0])).not.toContain("Acquires New Shares");
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
});
