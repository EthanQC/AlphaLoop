// Phase 4 Task 4: L1 news source clients. Every test drives a fixture
// fetchImpl/longbridgeNewsFetcher - zero real network calls anywhere in this
// file, matching the task brief's "fixtures only" requirement.
import { describe, expect, it, vi } from "vitest";

const sources = await import("./news-sources.mjs");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function rssXml(items) {
  const body = items
    .map(
      (item) => `
    <item>
      <title>${item.title}</title>
      <link>${item.link}</link>
      <description>${item.description ?? ""}</description>
      <pubDate>${item.pubDate ?? ""}</pubDate>
      ${item.source ? `<source>${item.source}</source>` : ""}
    </item>`
    )
    .join("\n");
  return `<?xml version="1.0"?><rss><channel>${body}</channel></rss>`;
}

function okTextResponse(text) {
  return { ok: true, status: 200, statusText: "OK", text: async () => text, json: async () => JSON.parse(text) };
}

function okJsonResponse(payload) {
  const text = JSON.stringify(payload);
  return { ok: true, status: 200, statusText: "OK", text: async () => text, json: async () => payload };
}

function failResponse(status = 500, statusText = "Internal Server Error") {
  return { ok: false, status, statusText, text: async () => "", json: async () => ({}) };
}

// ---------------------------------------------------------------------------
// fetchRsshubFeed
// ---------------------------------------------------------------------------

describe("fetchRsshubFeed", () => {
  const routeEntry = { name: "cls", primary: "/cls/telegraph", fallback: "/cls/depth", sourceName: "财联社" };

  it("falls back to the second route when the primary fails (non-200)", async () => {
    const fallbackXml = rssXml([
      { title: "央行公开市场操作", link: "https://example.com/a", pubDate: "Tue, 14 Jul 2026 08:00:00 GMT" }
    ]);
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes("/cls/telegraph")) {
        return failResponse(503, "Service Unavailable");
      }
      expect(String(url)).toContain("/cls/depth");
      return okTextResponse(fallbackXml);
    });

    const articles = await sources.fetchRsshubFeed(routeEntry, { baseUrl: "http://127.0.0.1:1200", fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe("央行公开市场操作");
    expect(articles[0].source).toBe("rsshub-cls");
  });

  it("falls back when the primary times out (aborts)", async () => {
    const fallbackXml = rssXml([{ title: "深度报道", link: "https://example.com/b" }]);
    const fetchImpl = vi.fn(async (url, init) => {
      if (String(url).includes("/cls/telegraph")) {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
        });
      }
      return okTextResponse(fallbackXml);
    });

    const articles = await sources.fetchRsshubFeed(routeEntry, { baseUrl: "http://127.0.0.1:1200", fetchImpl, timeoutMs: 20 });
    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe("深度报道");
  });

  it("falls back when the primary parses to zero items", async () => {
    const fallbackXml = rssXml([{ title: "备用来源条目", link: "https://example.com/c" }]);
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes("/cls/telegraph")) {
        return okTextResponse("<?xml version=\"1.0\"?><rss><channel></channel></rss>");
      }
      return okTextResponse(fallbackXml);
    });

    const articles = await sources.fetchRsshubFeed(routeEntry, { baseUrl: "http://127.0.0.1:1200", fetchImpl });
    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe("备用来源条目");
  });

  it("throws naming both routes when primary and fallback both fail", async () => {
    const fetchImpl = vi.fn(async () => failResponse(500, "Internal Server Error"));

    await expect(
      sources.fetchRsshubFeed(routeEntry, { baseUrl: "http://127.0.0.1:1200", fetchImpl })
    ).rejects.toThrow(/cls/);
    await expect(
      sources.fetchRsshubFeed(routeEntry, { baseUrl: "http://127.0.0.1:1200", fetchImpl })
    ).rejects.toThrow(/\/cls\/telegraph/);
    await expect(
      sources.fetchRsshubFeed(routeEntry, { baseUrl: "http://127.0.0.1:1200", fetchImpl })
    ).rejects.toThrow(/\/cls\/depth/);
  });

  it("tags every returned article lang='zh'", async () => {
    const xml = rssXml([
      { title: "文章一", link: "https://example.com/1" },
      { title: "文章二", link: "https://example.com/2" }
    ]);
    const fetchImpl = vi.fn(async () => okTextResponse(xml));

    const articles = await sources.fetchRsshubFeed(routeEntry, { baseUrl: "http://127.0.0.1:1200", fetchImpl });
    expect(articles).toHaveLength(2);
    expect(articles.every((article) => article.lang === "zh")).toBe(true);
  });

  it("RSSHUB_ROUTES binds exactly the three spec'd sources with a distinct fallback each", () => {
    expect(Object.keys(sources.RSSHUB_ROUTES).sort()).toEqual(["cls", "gelonghui", "wallstreetcn"]);
    for (const entry of Object.values(sources.RSSHUB_ROUTES)) {
      expect(entry.primary).not.toBe(entry.fallback);
      expect(typeof entry.fallback).toBe("string");
      expect(entry.fallback.length).toBeGreaterThan(0);
    }
    expect(sources.RSSHUB_ROUTES.cls.primary).toBe("/cls/telegraph");
    expect(sources.RSSHUB_ROUTES.wallstreetcn.primary).toBe("/wallstreetcn/live");
    expect(sources.RSSHUB_ROUTES.wallstreetcn.fallback).toBe("/wallstreetcn/news");
    expect(sources.RSSHUB_ROUTES.gelonghui.primary).toBe("/gelonghui/live");
  });
});

// ---------------------------------------------------------------------------
// Finnhub: rate limiter
// ---------------------------------------------------------------------------

describe("createFinnhubRateLimiter", () => {
  it("allows up to maxCalls within the window and rejects the (maxCalls+1)th", () => {
    let clock = 1_000_000;
    const limiter = sources.createFinnhubRateLimiter({ maxCalls: 60, windowMs: 60_000, now: () => clock });

    for (let i = 0; i < 60; i += 1) {
      expect(() => limiter.acquire(`call-${i}`)).not.toThrow();
    }
    expect(() => limiter.acquire("call-61")).toThrow(sources.FinnhubRateLimitError);
  });

  it("slides the window: once the oldest calls age out, new calls succeed again", () => {
    let clock = 1_000_000;
    const limiter = sources.createFinnhubRateLimiter({ maxCalls: 60, windowMs: 60_000, now: () => clock });

    for (let i = 0; i < 60; i += 1) {
      limiter.acquire(`call-${i}`);
    }
    expect(() => limiter.acquire("blocked")).toThrow(sources.FinnhubRateLimitError);

    // Advance past the window so every earlier call slides out.
    clock += 60_001;
    expect(() => limiter.acquire("after-slide")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Finnhub: fetch + mapping + redaction
// ---------------------------------------------------------------------------

describe("fetchFinnhubCompanyNews", () => {
  it("maps Finnhub rows to article shape with origin/lang and datetime*1000, no Date.now() fallback", async () => {
    const datetimeSeconds = Math.floor(Date.parse("2026-07-14T01:00:00.000Z") / 1000);
    const fetchImpl = vi.fn(async (url, init) => {
      expect(String(url)).toContain("symbol=AAPL");
      expect(init.headers["X-Finnhub-Token"]).toBe("secret-finnhub-key");
      return okJsonResponse([
        {
          id: 1,
          headline: "Apple unveils new AI features",
          url: "https://example.com/aapl-ai",
          source: "Reuters",
          summary: "Apple announced new AI capabilities.",
          datetime: datetimeSeconds
        },
        // Missing datetime -> publishedAt/publishedAtMs must stay undefined,
        // never fabricated from Date.now() (T1 rule).
        { id: 2, headline: "Apple supplier update", url: "https://example.com/aapl-supplier", source: "Wire" }
      ]);
    });

    const articles = await sources.fetchFinnhubCompanyNews("AAPL.US", { apiKey: "secret-finnhub-key", fetchImpl });

    expect(articles).toHaveLength(2);
    expect(articles[0].source).toBe("finnhub");
    expect(articles[0].lang).toBe("en");
    expect(articles[0].publishedAtMs).toBe(datetimeSeconds * 1000);
    expect(articles[0].publishedAt).toBe(new Date(datetimeSeconds * 1000).toISOString());
    expect(articles[1].publishedAtMs).toBeUndefined();
    expect(articles[1].publishedAt).toBeUndefined();
  });

  it("checks the rate limiter before calling fetchImpl", async () => {
    const limiter = { acquire: vi.fn(() => { throw new sources.FinnhubRateLimitError("limit hit"); }) };
    const fetchImpl = vi.fn();

    await expect(
      sources.fetchFinnhubCompanyNews("AAPL.US", { apiKey: "secret-finnhub-key", fetchImpl, limiter })
    ).rejects.toThrow("limit hit");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("redacts the API key out of an error thrown by a rejecting fetchImpl", async () => {
    const apiKey = "secret-finnhub-key-abc123";
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connection reset while calling https://finnhub.io/?token=${apiKey}`);
    });

    await expect(
      sources.fetchFinnhubCompanyNews("AAPL.US", { apiKey, fetchImpl })
    ).rejects.toThrowError(
      expect.objectContaining({
        message: expect.not.stringContaining(apiKey)
      })
    );
  });

  it("redacts the API key out of a non-2xx HTTP response error", async () => {
    const apiKey = "secret-finnhub-key-xyz789";
    const fetchImpl = vi.fn(async () => failResponse(401, "Unauthorized"));

    let caught;
    try {
      await sources.fetchFinnhubCompanyNews("AAPL.US", { apiKey, fetchImpl });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught?.message)).not.toContain(apiKey);
  });
});

// ---------------------------------------------------------------------------
// collectL1News
// ---------------------------------------------------------------------------

describe("collectL1News", () => {
  function buildFetchImpl({ rsshubXml, yahooSearchPayload, yahooRssXml, googleRssXml } = {}) {
    return vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("127.0.0.1:1200") || href.includes("rsshub")) {
        return okTextResponse(rsshubXml ?? rssXml([{ title: "RSSHub 条目", link: `https://example.com/rsshub-${Math.random()}` }]));
      }
      if (href.includes("query2.finance.yahoo.com")) {
        return okJsonResponse(yahooSearchPayload ?? { news: [] });
      }
      if (href.includes("feeds.finance.yahoo.com")) {
        return okTextResponse(yahooRssXml ?? rssXml([]));
      }
      if (href.includes("news.google.com")) {
        return okTextResponse(googleRssXml ?? rssXml([]));
      }
      return failResponse(404, "Not Found");
    });
  }

  it("merges articles across all sources and reports sourceHealth='skipped_no_key' when FINNHUB_API_KEY is unset", async () => {
    const fetchImpl = buildFetchImpl({
      yahooSearchPayload: {
        news: [
          {
            uuid: "y-1",
            title: "AAPL rises on strong iPhone demand",
            link: "https://finance.yahoo.com/y-1",
            publisher: "Yahoo Finance",
            providerPublishTime: Math.floor(Date.parse("2026-07-14T02:00:00.000Z") / 1000)
          }
        ]
      }
    });
    const longbridgeNewsFetcher = vi.fn(async (symbol) => [
      {
        id: `lb-${symbol}`,
        symbol,
        title: `${symbol} 长桥新闻标题`,
        url: `https://longbridge.example.com/${symbol}`,
        publishedAt: "2026-07-14T03:00:00.000Z",
        publishedAtMs: Date.parse("2026-07-14T03:00:00.000Z"),
        source: "longbridge-news"
      }
    ]);

    const result = await sources.collectL1News({
      symbols: ["AAPL.US"],
      env: {},
      fetchImpl,
      longbridgeNewsFetcher
    });

    expect(result.sourceHealth.finnhub).toBe("skipped_no_key");
    expect(result.sourceHealth["rsshub-cls"]).toBe("ok");
    expect(result.sourceHealth["rsshub-wallstreetcn"]).toBe("ok");
    expect(result.sourceHealth["rsshub-gelonghui"]).toBe("ok");
    expect(result.sourceHealth["yahoo-finance-search:AAPL.US"]).toBe("ok");
    expect(result.sourceHealth["longbridge-news:AAPL.US"]).toBe("ok");
    expect(result.warnings).toEqual([]);
    // 3 RSSHub + 1 Yahoo search + 1 Longbridge = 5 merged articles (Yahoo
    // RSS/Google RSS fixtures return empty feeds above).
    expect(result.articles.length).toBe(5);
    const origins = result.articles.map((article) => article.source).sort();
    expect(origins).toEqual(["longbridge-news", "rsshub-cls", "rsshub-gelonghui", "rsshub-wallstreetcn", "yahoo-finance-search"]);
  });

  it("records a warning + sourceHealth='failed' for a single failing source without blocking the others", async () => {
    const fetchImpl = buildFetchImpl();
    const longbridgeNewsFetcher = vi.fn(async () => {
      throw new Error("Longbridge CLI token expired");
    });

    const result = await sources.collectL1News({
      symbols: ["AAPL.US"],
      env: {},
      fetchImpl,
      longbridgeNewsFetcher
    });

    expect(result.sourceHealth["longbridge-news:AAPL.US"]).toBe("failed");
    expect(result.warnings.some((warning) => warning.includes("长桥新闻读取失败") && warning.includes("Longbridge CLI token expired"))).toBe(true);
    // RSSHub still contributed articles even though Longbridge failed.
    expect(result.articles.length).toBeGreaterThan(0);
  });

  it("includes Finnhub in the pool (sourceHealth='ok') when FINNHUB_API_KEY is set", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      const href = String(url);
      if (href.includes("finnhub.io")) {
        expect(init.headers["X-Finnhub-Token"]).toBe("finnhub-key-123");
        return okJsonResponse([
          { id: 9, headline: "AAPL earnings beat", url: "https://example.com/aapl-earnings", source: "Finnhub", datetime: Math.floor(Date.now() / 1000) }
        ]);
      }
      if (href.includes("127.0.0.1:1200")) {
        return okTextResponse(rssXml([{ title: "RSSHub 条目", link: `https://example.com/rsshub-${Math.random()}` }]));
      }
      if (href.includes("query2.finance.yahoo.com")) {
        return okJsonResponse({ news: [] });
      }
      return okTextResponse(rssXml([]));
    });
    const longbridgeNewsFetcher = vi.fn(async () => []);

    const result = await sources.collectL1News({
      symbols: ["AAPL.US"],
      env: { FINNHUB_API_KEY: "finnhub-key-123" },
      fetchImpl,
      longbridgeNewsFetcher
    });

    expect(result.sourceHealth["finnhub:AAPL.US"]).toBe("ok");
    expect(result.articles.some((article) => article.source === "finnhub")).toBe(true);
  });

  it("throws when every source fails or returns empty", async () => {
    const fetchImpl = vi.fn(async () => failResponse(500, "boom"));
    const longbridgeNewsFetcher = vi.fn(async () => {
      throw new Error("Longbridge down");
    });

    await expect(
      sources.collectL1News({ symbols: ["AAPL.US"], env: {}, fetchImpl, longbridgeNewsFetcher })
    ).rejects.toThrow(/多源新闻|采集全部失败/);
  });
});
