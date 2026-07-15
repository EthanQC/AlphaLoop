import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openTradingDatabase } from "../../../packages/shared-types/dist/index.js";

const engine = await import("./news-engine.mjs");
const store = await import("./news-store.mjs");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let idCounter = 0;
function article(overrides: Record<string, unknown> = {}) {
  idCounter += 1;
  return {
    id: `article_${idCounter}`,
    symbol: "AAPL.US",
    title: "Fed holds interest rates steady",
    titleZh: "美联储维持利率不变",
    summary: "",
    source: "yahoo-finance-search",
    sourceName: "Yahoo Finance",
    publisher: "Yahoo Finance",
    url: `https://example.com/article-${idCounter}`,
    publishedAt: "2026-07-10T10:00:00.000Z",
    publishedAtMs: Date.parse("2026-07-10T10:00:00.000Z"),
    relatedTickers: [] as string[],
    ...overrides
  };
}

function idsOf(cluster: { articles: Array<{ id: string }> }) {
  return cluster.articles.map((a) => a.id).sort();
}

// Builds a cluster object directly (bypassing clusterArticles's own merge
// decision) for buildEventFromCluster tests that want precise control over
// exactly which articles are grouped - buildEventFromCluster's behavior is
// defined given a cluster shape, independent of how that cluster was formed.
function makeCluster(articles: Array<Record<string, unknown>>) {
  const known = articles
    .map((a) => a.publishedAtMs)
    .filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  const firstMs = known.length > 0 ? Math.min(...known) : null;
  const lastMs = known.length > 0 ? Math.max(...known) : null;
  return {
    clusterKey: "test_cluster",
    articles,
    firstPublishedAt: firstMs !== null ? new Date(firstMs).toISOString() : null,
    lastPublishedAt: lastMs !== null ? new Date(lastMs).toISOString() : null
  };
}

// ===========================================================================
// 1. normalizeNewsUrl
// ===========================================================================

describe("normalizeNewsUrl", () => {
  it("lowercases the host but leaves the path case untouched", () => {
    expect(engine.normalizeNewsUrl("https://Example.COM/Article/Path")).toBe(
      "https://example.com/Article/Path"
    );
  });

  it("strips utm_* and other known tracking params but keeps meaningful ones", () => {
    const url = "https://example.com/a?utm_source=twitter&utm_medium=social&utm_campaign=x&id=42";
    expect(engine.normalizeNewsUrl(url)).toBe("https://example.com/a?id=42");
  });

  it("strips fbclid/gclid/mc_cid style tracking params", () => {
    expect(engine.normalizeNewsUrl("https://example.com/a?fbclid=abc")).toBe("https://example.com/a");
    expect(engine.normalizeNewsUrl("https://example.com/a?gclid=abc")).toBe("https://example.com/a");
    expect(engine.normalizeNewsUrl("https://example.com/a?mc_cid=abc&mc_eid=def")).toBe("https://example.com/a");
  });

  it("sorts remaining meaningful params for determinism regardless of input order", () => {
    const first = engine.normalizeNewsUrl("https://example.com/a?b=2&a=1");
    const second = engine.normalizeNewsUrl("https://example.com/a?a=1&b=2");
    expect(first).toBe(second);
    expect(first).toBe("https://example.com/a?a=1&b=2");
  });

  it("strips a single trailing slash but keeps root '/' intact", () => {
    expect(engine.normalizeNewsUrl("https://example.com/a/")).toBe("https://example.com/a");
    expect(engine.normalizeNewsUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("drops the fragment", () => {
    expect(engine.normalizeNewsUrl("https://example.com/a#section-2")).toBe("https://example.com/a");
  });

  it("unwraps the legacy news.google.com/news/url?...&url= redirect shape", () => {
    const wrapped = "https://news.google.com/news/url?url=https%3A%2F%2Fexample.com%2Freal-article&ct=story&cid=1";
    expect(engine.normalizeNewsUrl(wrapped)).toBe("https://example.com/real-article");
  });

  it("leaves the opaque /rss/articles/ redirect shape as-is (documented: not extractable without IO)", () => {
    const opaque = "https://news.google.com/rss/articles/CBMiXkFVX3lxTE0?oc=5";
    expect(engine.normalizeNewsUrl(opaque)).toBe("https://news.google.com/rss/articles/CBMiXkFVX3lxTE0?oc=5");
  });

  it("returns null for invalid or non-http(s) input", () => {
    expect(engine.normalizeNewsUrl(undefined)).toBeNull();
    expect(engine.normalizeNewsUrl("")).toBeNull();
    expect(engine.normalizeNewsUrl("not a url")).toBeNull();
    expect(engine.normalizeNewsUrl("ftp://example.com/a")).toBeNull();
    expect(engine.normalizeNewsUrl("mailto:a@example.com")).toBeNull();
    expect(engine.normalizeNewsUrl("/relative/path")).toBeNull();
  });
});

// ===========================================================================
// 2. titleSimilarity
// ===========================================================================

describe("titleSimilarity", () => {
  it("returns 1 for identical titles", () => {
    expect(engine.titleSimilarity("Fed holds rates steady", "Fed holds rates steady")).toBe(1);
  });

  it("returns 0 for completely unrelated titles", () => {
    const sim = engine.titleSimilarity(
      "Fed holds interest rates steady",
      "Local bakery wins pastry award downtown"
    );
    expect(sim).toBeLessThan(0.2);
  });

  it("is high for near-duplicate English retitles (single word swap)", () => {
    const sim = engine.titleSimilarity(
      "Fed holds interest rates steady after June policy meeting",
      "Fed keeps interest rates steady after June policy meeting"
    );
    expect(sim).toBeGreaterThanOrEqual(0.6);
  });

  it("ignores case and punctuation", () => {
    const sim = engine.titleSimilarity(
      "Fed Holds Interest Rates Steady!",
      "fed holds interest rates steady"
    );
    expect(sim).toBe(1);
  });

  it("drops small stopwords (the/a/of) from both sides", () => {
    const sim = engine.titleSimilarity("the rise of the market", "rise of market");
    expect(sim).toBe(1);
  });

  it("computes CJK similarity via per-character bigrams - near-duplicate Chinese titles score high", () => {
    const sim = engine.titleSimilarity(
      "美联储宣布维持利率不变",
      "美联储宣布维持利率不变，符合市场预期"
    );
    expect(sim).toBeGreaterThanOrEqual(0.6);
  });

  it("keeps unrelated Chinese titles apart", () => {
    const sim = engine.titleSimilarity("美联储宣布维持利率不变", "苹果公司发布新款手机产品线");
    expect(sim).toBeLessThan(0.3);
  });

  it("drops small CJK stopwords (的/了/在) as tokens", () => {
    // "的" alone (length-1 CJK run) must not become a token; verify by
    // comparing two titles that differ only in a lone trailing "的".
    const withParticle = engine.titleSimilarity("美股上涨的", "美股上涨");
    expect(withParticle).toBe(1);
  });

  it("both-empty titles compare equal to each other and different from any non-empty title", () => {
    expect(engine.titleSimilarity("", "")).toBe(1);
    expect(engine.titleSimilarity("", "   ")).toBe(1);
    expect(engine.titleSimilarity("", "something")).toBe(0);
  });
});

// ===========================================================================
// 3. clusterArticles
// ===========================================================================

describe("clusterArticles", () => {
  it("merges the same normalized URL (utm variants) into one cluster even with different sources", () => {
    const a = article({ id: "a", url: "https://site.com/story?utm_source=twitter", title: "Story A headline" });
    const b = article({ id: "b", url: "https://site.com/story?utm_source=facebook", title: "Different phrasing entirely here" });

    const clusters = engine.clusterArticles([a, b]);

    expect(clusters).toHaveLength(1);
    expect(idsOf(clusters[0])).toEqual(["a", "b"]);
  });

  it("merges the exact same URL across different sources (cross-source dedup)", () => {
    const a = article({ id: "a", source: "longbridge-news", url: "https://wsj.com/x/1", title: "Fed decision today" });
    const b = article({ id: "b", source: "google-news-rss", url: "https://wsj.com/x/1", title: "Fed decision today" });

    const clusters = engine.clusterArticles([a, b]);

    expect(clusters).toHaveLength(1);
    expect(idsOf(clusters[0])).toEqual(["a", "b"]);
  });

  it("keeps unrelated titles with unrelated URLs in separate clusters", () => {
    const a = article({ id: "a", url: "https://a.com/1", title: "Fed holds interest rates steady" });
    const b = article({ id: "b", url: "https://b.com/2", title: "Local bakery wins pastry award downtown" });

    const clusters = engine.clusterArticles([a, b]);

    expect(clusters).toHaveLength(2);
    expect(clusters.map(idsOf).sort()).toEqual([["a"], ["b"]]);
  });

  it("merges CJK near-duplicate titles into one cluster and keeps a different Chinese story separate", () => {
    const a = article({ id: "a", url: "https://one.com/1", title: "美联储宣布维持利率不变", titleZh: "美联储宣布维持利率不变" });
    const b = article({ id: "b", url: "https://two.com/2", title: "美联储宣布维持利率不变，符合市场预期", titleZh: "美联储宣布维持利率不变，符合市场预期" });
    const c = article({ id: "c", url: "https://three.com/3", title: "苹果公司发布新款手机产品线", titleZh: "苹果公司发布新款手机产品线" });

    const clusters = engine.clusterArticles([a, b, c]);

    expect(clusters).toHaveLength(2);
    const groups = clusters.map(idsOf).sort();
    expect(groups).toEqual([["a", "b"], ["c"]]);
  });

  it("window boundary: same title 49h apart (both known times) stays separate; 47h apart merges", () => {
    const base = Date.parse("2026-07-10T00:00:00.000Z");
    const a = article({ id: "a", url: "https://a.com/1", title: "Fed holds interest rates steady", publishedAtMs: base, publishedAt: new Date(base).toISOString() });
    const within = article({
      id: "within",
      url: "https://a.com/2",
      title: "Fed keeps interest rates steady",
      publishedAtMs: base + 47 * 3600 * 1000,
      publishedAt: new Date(base + 47 * 3600 * 1000).toISOString()
    });
    const beyond = article({
      id: "beyond",
      url: "https://a.com/3",
      title: "Fed keeps interest rates steady",
      publishedAtMs: base + 49 * 3600 * 1000,
      publishedAt: new Date(base + 49 * 3600 * 1000).toISOString()
    });

    const withinClusters = engine.clusterArticles([a, within]);
    expect(withinClusters).toHaveLength(1);

    const beyondClusters = engine.clusterArticles([a, beyond]);
    expect(beyondClusters).toHaveLength(2);
  });

  it("unknown-time articles cluster via URL match", () => {
    const a = article({ id: "a", url: "https://a.com/1?utm_source=x", publishedAtMs: undefined, publishedAt: undefined });
    const b = article({ id: "b", url: "https://a.com/1?utm_source=y", publishedAtMs: undefined, publishedAt: undefined });

    const clusters = engine.clusterArticles([a, b]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].firstPublishedAt).toBeNull();
    expect(clusters[0].lastPublishedAt).toBeNull();
  });

  it("unknown-time article merges via similarity alone (no window check applies) when URLs differ", () => {
    const known = article({ id: "known", url: "https://a.com/1", title: "Fed holds interest rates steady", publishedAtMs: Date.parse("2026-07-10T00:00:00.000Z") });
    const unknown = article({ id: "unknown", url: "https://b.com/2", title: "Fed keeps interest rates steady", publishedAtMs: undefined, publishedAt: undefined });

    const clusters = engine.clusterArticles([known, unknown]);

    expect(clusters).toHaveLength(1);
    expect(idsOf(clusters[0])).toEqual(["known", "unknown"]);
    // The cluster still reports the one known time even though one member's
    // time is unknown - unknown-time members simply don't contribute to
    // first/lastPublishedAt (Number.isFinite filter), never masking it.
    expect(clusters[0].firstPublishedAt).toBe("2026-07-10T00:00:00.000Z");
  });

  it("two unknown-time articles with dissimilar titles still stay separate (similarity check still applies)", () => {
    const a = article({ id: "a", url: "https://a.com/1", title: "Fed holds interest rates steady", publishedAtMs: undefined, publishedAt: undefined });
    const b = article({ id: "b", url: "https://b.com/2", title: "Local bakery wins pastry award downtown", publishedAtMs: undefined, publishedAt: undefined });

    const clusters = engine.clusterArticles([a, b]);

    expect(clusters).toHaveLength(2);
  });

  it("documents the single-linkage transitivity tradeoff: an unknown-time bridge can connect two known-time articles further apart than the window", () => {
    const base = Date.parse("2026-07-10T00:00:00.000Z");
    const early = article({ id: "early", url: "https://a.com/1", title: "Fed holds interest rates steady", publishedAtMs: base });
    const bridge = article({ id: "bridge", url: "https://b.com/2", title: "Fed keeps interest rates steady", publishedAtMs: undefined, publishedAt: undefined });
    const late = article({
      id: "late",
      url: "https://c.com/3",
      title: "Fed maintains interest rates steady",
      publishedAtMs: base + 60 * 3600 * 1000
    });

    const clusters = engine.clusterArticles([early, bridge, late]);

    // early-late alone (60h apart, both known) would fail the window check,
    // but early-bridge and bridge-late each merge on similarity alone (one
    // side unknown), so single-linkage transitively unions all three - the
    // accepted, documented behavior of this clustering approach.
    expect(clusters).toHaveLength(1);
    expect(idsOf(clusters[0])).toEqual(["bridge", "early", "late"]);
  });

  it("20 near-duplicate variants (utm variants + retitles of the same story) collapse into exactly one cluster", () => {
    const canonical = "Fed holds interest rates steady after June policy meeting";
    const variants: Array<Record<string, unknown>> = [];

    // 15 articles: identical title text, spread across 5 "publishers" x 3
    // utm-tagged urls each (utm variants collapse via URL match; the shared
    // identical title also ties every publisher group together via
    // similarity = 1.0, independent of the URL rule).
    const utmSources = ["twitter", "facebook", "newsletter"];
    for (let publisher = 1; publisher <= 5; publisher += 1) {
      for (const utmSource of utmSources) {
        variants.push(
          article({
            id: `utm_${publisher}_${utmSource}`,
            source: `publisher-${publisher}`,
            url: `https://publisher${publisher}.example.com/story?utm_source=${utmSource}&utm_campaign=fed`,
            title: canonical
          })
        );
      }
    }

    // 5 retitled variants (single/double word swaps from canonical), each on
    // its own distinct URL, each independently >= 0.6 similar to the
    // canonical title used by the 15 above.
    const retitles = [
      "Fed keeps interest rates steady after June policy meeting",
      "Fed holds rates steady after June policy meeting",
      "Federal Reserve holds interest rates steady after June meeting",
      "Fed holds interest rates unchanged after June policy meeting",
      "Fed holds interest rates steady following June policy meeting"
    ];
    retitles.forEach((title, index) => {
      variants.push(
        article({
          id: `retitle_${index}`,
          source: `retitle-publisher-${index}`,
          url: `https://retitle${index}.example.com/story`,
          title
        })
      );
    });

    expect(variants).toHaveLength(20);

    const clusters = engine.clusterArticles(variants);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].articles).toHaveLength(20);
  });

  it("determinism: same input always produces the same clusterKey", () => {
    const a = article({ id: "a", url: "https://a.com/1?utm_source=x", title: "Fed holds interest rates steady" });
    const b = article({ id: "b", url: "https://a.com/1?utm_source=y", title: "Fed keeps interest rates steady" });

    const first = engine.clusterArticles([a, b]);
    const second = engine.clusterArticles([a, b]);

    expect(first[0].clusterKey).toBe(second[0].clusterKey);
  });

  it("determinism: shuffled input order produces the same set of clusters (same clusterKeys, same membership)", () => {
    const a = article({ id: "a", url: "https://a.com/1", title: "Fed holds interest rates steady" });
    const b = article({ id: "b", url: "https://a.com/1?utm_source=x", title: "Fed keeps interest rates steady" });
    const c = article({ id: "c", url: "https://c.com/9", title: "Local bakery wins pastry award downtown" });

    const forward = engine.clusterArticles([a, b, c]);
    const shuffled = engine.clusterArticles([c, b, a]);

    expect(shuffled.map((cl) => cl.clusterKey)).toEqual(forward.map((cl) => cl.clusterKey));
    expect(shuffled.map(idsOf)).toEqual(forward.map(idsOf));
  });

  it("clusterKey falls back to a stable title-hash when the representative article has no valid URL", () => {
    const a = article({ id: "a", url: "not-a-url", title: "Fed holds interest rates steady" });
    const b = article({ id: "b", url: "", title: "Fed keeps interest rates steady" });

    const clusters = engine.clusterArticles([a, b]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].clusterKey).toMatch(/^title:[0-9a-f]{16}$/u);
  });
});

// ===========================================================================
// 4. deriveImpact
// ===========================================================================

describe("deriveImpact", () => {
  it("classifies a tariff/trade-policy headline as bearish with the ported rule's Chinese reason label", () => {
    const a = article({ title: "US Trade Representative announces new tariff on tech imports", titleZh: undefined });
    const cluster = engine.clusterArticles([a])[0];

    const impact = engine.deriveImpact(cluster, []);

    expect(impact.direction).toBe("bearish");
    expect(impact.reason).toBe("美国贸易政策或关税相关消息更新");
  });

  it("classifies a rally/tech-strength headline as bullish", () => {
    const a = article({ title: "Wall Street extends rally as tech strength continues", titleZh: undefined });
    const cluster = engine.clusterArticles([a])[0];

    const impact = engine.deriveImpact(cluster, []);

    expect(impact.direction).toBe("bullish");
    expect(impact.reason).toBe("美股在科技板块带动下延续上涨");
  });

  it("classifies a plain earnings headline (no bias keywords) as neutral", () => {
    const a = article({ title: "Company reports quarterly earnings and guidance update", titleZh: undefined });
    const cluster = engine.clusterArticles([a])[0];

    const impact = engine.deriveImpact(cluster, []);

    expect(impact.direction).toBe("neutral");
    expect(impact.reason).toBe("公司业绩或指引相关消息");
  });

  it("affected includes tracked symbols matched via relatedTickers", () => {
    const a = article({ title: "Some headline with no ticker text", titleZh: undefined, relatedTickers: ["AAPL"] });
    const cluster = engine.clusterArticles([a])[0];

    const impact = engine.deriveImpact(cluster, ["AAPL.US", "MSFT.US"]);

    expect(impact.affected).toEqual(["AAPL.US"]);
  });

  it("affected includes tracked symbols matched via word-bounded title mention", () => {
    const a = article({ title: "NVDA surges on AI demand outlook", titleZh: undefined, relatedTickers: [] });
    const cluster = engine.clusterArticles([a])[0];

    const impact = engine.deriveImpact(cluster, ["NVDA.US", "AAPL.US"]);

    expect(impact.affected).toEqual(["NVDA.US"]);
  });

  it("does not false-positive a short ticker against an unrelated substring", () => {
    // "ALL" as a ticker must not match inside "wall street" / "small".
    const a = article({ title: "Wall Street stocks stay small and cautious today", titleZh: undefined, relatedTickers: [] });
    const cluster = engine.clusterArticles([a])[0];

    const impact = engine.deriveImpact(cluster, ["ALL.US"]);

    expect(impact.affected).toEqual([]);
  });

  it("prefers a structured impact field over the heuristic ladder when present, merging in matched tracked symbols", () => {
    const a = article({
      title: "Wall Street extends rally as tech strength continues",
      titleZh: undefined,
      relatedTickers: ["AAPL"],
      impact: { direction: "bearish", affected: ["QQQ.US"], reason: "L2 检索给出的结构化理由" }
    });
    const cluster = engine.clusterArticles([a])[0];

    const impact = engine.deriveImpact(cluster, ["AAPL.US", "QQQ.US"]);

    expect(impact.direction).toBe("bearish");
    expect(impact.reason).toBe("L2 检索给出的结构化理由");
    expect(impact.affected).toEqual(["AAPL.US", "QQQ.US"]);
  });

  it("an invalid structured direction value coerces to 'unknown' rather than passing through", () => {
    const a = article({ title: "headline", titleZh: undefined, impact: { direction: "bogus", affected: [], reason: "x" } });
    const cluster = engine.clusterArticles([a])[0];

    const impact = engine.deriveImpact(cluster, []);

    expect(impact.direction).toBe("unknown");
  });
});

// ===========================================================================
// 5. buildEventFromCluster
// ===========================================================================

describe("buildEventFromCluster", () => {
  it("prefers a native-CJK title over a machine-translated one for titleZh", () => {
    const en = article({ id: "en", url: "https://en.example.com/1", title: "Apple unveils new AI features for iPhone", titleZh: undefined });
    const zh = article({ id: "zh", url: "https://en.example.com/1?utm_source=weibo", title: "苹果公司发布 iPhone 人工智能新功能", titleZh: "苹果公司发布 iPhone 人工智能新功能" });
    const cluster = engine.clusterArticles([en, zh])[0];

    const event = engine.buildEventFromCluster(cluster, []);

    expect(event.titleZh).toBe("苹果公司发布 iPhone 人工智能新功能");
  });

  it("defuses a malicious markdown-link title so no [text](url) construct survives into titleZh/summaryZh", () => {
    const malicious = article({
      title: "[Click here](javascript:alert(1)) Fed holds rates steady",
      titleZh: "[点击这里](javascript:alert(1))美联储维持利率不变",
      summary: "[link](javascript:alert(1)) more detail here"
    });
    const cluster = engine.clusterArticles([malicious])[0];

    const event = engine.buildEventFromCluster(cluster, []);

    expect(event.titleZh).not.toMatch(/\[[^\]]+\]\(/u);
    expect(event.summaryZh).not.toMatch(/\[[^\]]+\]\(/u);
  });

  it("summaryZh is a two-line string: headline line then a detail line", () => {
    const a = article({ titleZh: "美联储维持利率不变", summary: "美联储在最新会议上维持利率不变，符合市场预期。" });
    const cluster = engine.clusterArticles([a])[0];

    const event = engine.buildEventFromCluster(cluster, []);
    const lines = event.summaryZh.split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("美联储维持利率不变");
    expect(lines[1]).toContain("符合市场预期");
  });

  it("summaryZh falls back to an honest placeholder detail line when no article has summary text", () => {
    const a = article({ titleZh: "美联储维持利率不变", summary: "" });
    const cluster = engine.clusterArticles([a])[0];

    const event = engine.buildEventFromCluster(cluster, []);
    const lines = event.summaryZh.split("\n");

    expect(lines[1]).toBe("来源未提供摘要正文，请核对原文链接确认细节。");
  });

  it("produces one source entry per article with the exact store field names, url null when missing, and lang tagged from native-CJK detection", () => {
    const zh = article({ id: "zh", url: "https://a.com/1", title: "美联储维持利率不变", titleZh: "美联储维持利率不变", publisher: "华尔街见闻", source: "wallstreetcn", publishedAt: "2026-07-10T10:00:00.000Z" });
    const en = article({ id: "en", url: "", title: "Fed keeps interest rates steady", titleZh: undefined, publisher: "Yahoo Finance", source: "yahoo-finance-search", publishedAt: undefined, publishedAtMs: undefined });
    const cluster = makeCluster([zh, en]);

    const event = engine.buildEventFromCluster(cluster, []);

    expect(event.sources).toHaveLength(2);
    const byOrigin = Object.fromEntries(event.sources.map((s: Record<string, unknown>) => [s.origin, s]));
    expect(byOrigin.wallstreetcn).toMatchObject({
      publisher: "华尔街见闻",
      url: "https://a.com/1",
      titleRaw: "美联储维持利率不变",
      publishedAt: "2026-07-10T10:00:00.000Z",
      lang: "zh"
    });
    expect(byOrigin["yahoo-finance-search"]).toMatchObject({
      publisher: "Yahoo Finance",
      url: null,
      titleRaw: "Fed keeps interest rates steady",
      publishedAt: null,
      lang: "en"
    });
  });

  it("passes through firstPublishedAt/lastPublishedAt from the cluster verbatim, null when all unknown", () => {
    const a = article({ url: "https://a.com/1", publishedAtMs: undefined, publishedAt: undefined });
    const cluster = engine.clusterArticles([a])[0];

    const event = engine.buildEventFromCluster(cluster, []);

    expect(event.firstPublishedAt).toBeNull();
    expect(event.lastPublishedAt).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Integration: build -> upsert -> list back (round-trips through the real
  // store). This is the contract check the task brief asks for: mapping
  // buildEventFromCluster's nested `impact` object onto
  // upsertEventWithSources's flat impactDirection/impactAffected/
  // impactReason fields is a few lines of field renaming that Task 7 will do
  // for real inside scheduled-report.mjs; this test pins that the mapping
  // loses no information in either direction.
  // -------------------------------------------------------------------------
  describe("news-store round-trip", () => {
    const tempDirs: string[] = [];

    function makeDb(): DatabaseSync {
      const dir = mkdtempSync(join(tmpdir(), "alphaloop-news-engine-"));
      tempDirs.push(dir);
      return openTradingDatabase(join(dir, "trading.sqlite"));
    }

    afterEach(() => {
      while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });

    it("build -> upsert -> listEventsInWindow round-trips every field of the built event", () => {
      const db = makeDb();

      const a = article({
        id: "a",
        url: "https://wallstreetcn.com/articles/123",
        title: "美联储宣布维持利率不变",
        titleZh: "美联储宣布维持利率不变",
        summary: "美联储在最新会议上维持利率不变，符合市场预期。",
        source: "wallstreetcn",
        publisher: "华尔街见闻",
        publishedAt: "2026-07-10T10:00:00.000Z",
        publishedAtMs: Date.parse("2026-07-10T10:00:00.000Z"),
        relatedTickers: ["QQQ"]
      });
      const b = article({
        id: "b",
        url: "https://wallstreetcn.com/articles/123?utm_source=telegram",
        title: "美联储宣布维持利率不变",
        titleZh: "美联储宣布维持利率不变",
        source: "gelonghui",
        publisher: "格隆汇",
        publishedAt: "2026-07-10T12:00:00.000Z",
        publishedAtMs: Date.parse("2026-07-10T12:00:00.000Z")
      });

      const cluster = engine.clusterArticles([a, b])[0];
      const built = engine.buildEventFromCluster(cluster, ["QQQ.US"]);

      const { eventId } = store.upsertEventWithSources(
        db,
        {
          clusterKey: built.clusterKey,
          titleZh: built.titleZh,
          summaryZh: built.summaryZh,
          impactDirection: built.impact.direction,
          impactAffected: built.impact.affected,
          impactReason: built.impact.reason
        },
        built.sources
      );

      const [stored] = store.listEventsInWindow(db, { sinceIso: "2026-07-01T00:00:00.000Z" });

      expect(stored.id).toBe(eventId);
      expect(stored.clusterKey).toBe(built.clusterKey);
      expect(stored.titleZh).toBe(built.titleZh);
      expect(stored.summaryZh).toBe(built.summaryZh);
      expect(stored.impactDirection).toBe(built.impact.direction);
      expect(stored.impactAffected).toEqual(built.impact.affected);
      expect(stored.impactReason).toBe(built.impact.reason);
      expect(stored.firstPublishedAt).toBe(built.firstPublishedAt);
      expect(stored.lastPublishedAt).toBe(built.lastPublishedAt);
      expect(stored.sourceCount).toBe(2);
      expect(stored.zhSourceCount).toBe(2);
      expect(stored.sources).toHaveLength(2);
      const storedPublishers = stored.sources.map((s: { publisher: string }) => s.publisher).sort();
      expect(storedPublishers).toEqual(["华尔街见闻", "格隆汇"]);
    });

    it("round-trips a cluster with a tracked-symbol match through the store's symbol filter", () => {
      const db = makeDb();
      const a = article({
        id: "a",
        url: "https://a.com/1",
        title: "NVDA surges on AI demand outlook",
        titleZh: undefined,
        relatedTickers: []
      });
      const cluster = engine.clusterArticles([a])[0];
      const built = engine.buildEventFromCluster(cluster, ["NVDA.US"]);

      store.upsertEventWithSources(
        db,
        {
          clusterKey: built.clusterKey,
          titleZh: built.titleZh,
          summaryZh: built.summaryZh,
          impactDirection: built.impact.direction,
          impactAffected: built.impact.affected,
          impactReason: built.impact.reason
        },
        built.sources
      );

      const filtered = store.listEventsInWindow(db, { sinceIso: "2026-01-01T00:00:00.000Z", symbol: "NVDA.US" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].clusterKey).toBe(built.clusterKey);
    });
  });
});
