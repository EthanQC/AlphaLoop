// L1 news source clients - Phase 4 Task 4.
//
// This module is the single place that knows HOW to reach every raw news
// feed the daily/weekly report (and, later, the platform news page) draws
// on: RSSHub's three bound Chinese-language routes, Finnhub's company-news
// REST endpoint, and the pre-existing Yahoo Finance / Google News / Longbridge
// fetchers that used to live inline inside scheduled-report.mjs's
// fetchMarketNews (moved here verbatim, only parameterized so tests can
// inject fetchImpl - see the "moved, not rewritten" note on each fetcher
// below). scheduled-report.mjs's fetchMarketNews now just calls
// collectL1News() with the tracked-symbol list; this keeps the four
// pre-existing sources' behavior (env var names, warning text, merge
// semantics) unchanged while RSSHub and Finnhub join the same pool.
//
// Every fetcher here accepts an injectable `fetchImpl` (defaults to the
// global `fetch`) so news-sources.test.ts can exercise every code path -
// primary/fallback route selection, rate-limit rejection, key redaction,
// partial-failure aggregation - against fixtures with ZERO real network
// calls, matching this repo's existing pattern (see openclaw-runtime-doctor-
// core.mjs's `fetchImpl` option).
//
// Article shape produced by every fetcher in this module is the same
// decorated shape report-news.mjs's decorateNewsArticle produces (title/
// titleZh/summary already markdown-defused and single-lined, publishedAt/
// publishedAtMs honestly undefined when unknown - see report-news.mjs's #29/
// #31 audit-fix comments) plus an explicit `lang: 'zh'|'en'` marker this
// module adds (RSSHub routes are always lang='zh'; Finnhub is always
// lang='en') - the "smallest clean change" the task brief asks for: post-tag
// after the shared RSS/decorate pipeline runs, rather than teaching
// report-news.mjs's normalizeExternalRssNews a new source-specific option.

import {
  decorateNewsArticle,
  mergeNewsArticles,
  normalizeExternalRssNews,
  normalizeYahooSearchNews
} from "./report-news.mjs";
import { normalizeNewsPayload, normalizeSymbol } from "./report-data.mjs";
import { runLongbridgeJsonWithRetry } from "./_longbridge.mjs";

// ---------------------------------------------------------------------------
// RSSHub: bound routes + primary/fallback fetch
// ---------------------------------------------------------------------------

export const DEFAULT_RSSHUB_BASE_URL = "http://127.0.0.1:1200";
const DEFAULT_RSSHUB_TIMEOUT_MS = 12_000;

// RSSHUB_ROUTES (Global Constraints "RSSHub 路由（binding）"): the three
// routes are fixed by the plan and each gets a second, independent RSSHub
// route for the SAME underlying source as a fallback - these three feeds
// are named in the plan as "历史上常失效" (historically flaky), so a
// same-route retry buys little; a different route against the same
// publisher is much more likely to still be reachable when the primary is
// down (rate-limited, anti-crawling-blocked, or the specific route handler
// itself broken upstream) while the publisher's site as a whole is fine.
// Fallback choices researched against RSSHub's actual route catalog
// (docs.rsshub.app / DIYgod/RSSHub source, 2026-07 knowledge):
//   - cls/telegraph (财联社电报, real-time wire) -> cls/depth (财联社深度,
//     in-depth pieces): both are first-party 财联社 feeds; depth is a
//     lower-traffic route than telegraph's real-time wire, so it is less
//     likely to be caught by the same anti-crawling throttle window.
//   - wallstreetcn/live (华尔街见闻快讯) -> wallstreetcn/news (华尔街见闻
//     资讯): explicitly the example pairing given in the task brief itself;
//     news/:category? is a slower-moving, separately-implemented route from
//     live's real-time wire.
//   - gelonghui/live (格隆汇快讯) -> gelonghui/hot-article (格隆汇热门文章):
//     gelonghui has no second "live wire" route, so hot-article (a
//     separately implemented, lower-frequency route on the same publisher)
//     is the most RSSHub-catalog-faithful fallback available, mirroring the
//     telegraph->hot / live->hot pattern the other two sources also have
//     available (cls/hot, wallstreetcn/hot) if depth/news ever also fail.
export const RSSHUB_ROUTES = {
  cls: {
    name: "cls",
    primary: "/cls/telegraph",
    fallback: "/cls/depth",
    sourceName: "财联社"
  },
  wallstreetcn: {
    name: "wallstreetcn",
    primary: "/wallstreetcn/live",
    fallback: "/wallstreetcn/news",
    sourceName: "华尔街见闻"
  },
  gelonghui: {
    name: "gelonghui",
    primary: "/gelonghui/live",
    fallback: "/gelonghui/hot-article",
    sourceName: "格隆汇"
  }
};

function buildRsshubUrl(baseUrl, route) {
  const base = String(baseUrl ?? DEFAULT_RSSHUB_BASE_URL).trim().replace(/\/+$/u, "") || DEFAULT_RSSHUB_BASE_URL;
  const path = route.startsWith("/") ? route : `/${route}`;
  return `${base}${path}`;
}

// Fetches one RSSHub-bound source, trying `routeEntry.primary` first and
// `routeEntry.fallback` only if the primary fails for ANY reason this
// function can observe: non-2xx HTTP status, request timeout/abort, or a
// response that parses to zero <item> entries (RSSHub itself returning an
// empty/broken feed rather than erroring). Both routes exhausted -> throws
// one error naming the source and BOTH attempted route paths (no key
// material is ever at stake here - RSSHub has no credential of any kind).
export async function fetchRsshubFeed(routeEntry, { baseUrl = DEFAULT_RSSHUB_BASE_URL, timeoutMs = DEFAULT_RSSHUB_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const name = String(routeEntry?.name ?? "rsshub");
  const sourceName = routeEntry?.sourceName ?? name;
  const routes = [routeEntry?.primary, routeEntry?.fallback].filter(
    (route) => typeof route === "string" && route.trim().length > 0
  );
  if (routes.length === 0) {
    throw new Error(`RSSHub route entry "${name}" has no primary route configured.`);
  }

  const attempted = [];
  let lastError;
  for (const route of routes) {
    attempted.push(route);
    try {
      const xml = await fetchTextWithRetry(buildRsshubUrl(baseUrl, route), {
        fetchImpl,
        attempts: 1,
        timeoutMs
      });
      const articles = normalizeExternalRssNews(undefined, xml, {
        source: `rsshub-${name}`,
        sourceName
      });
      if (articles.length === 0) {
        throw new Error(`RSSHub route ${route} returned no parseable <item> entries.`);
      }
      return articles.map((article) => ({ ...article, lang: "zh" }));
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `RSSHub feed "${name}" failed on all configured routes (${attempted.join(", ")}): ${lastError?.message ?? lastError}`
  );
}

// ---------------------------------------------------------------------------
// Finnhub: sliding-window rate limiter + company news
// ---------------------------------------------------------------------------

export class FinnhubRateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "FinnhubRateLimitError";
  }
}

// Sliding-window call limiter (default 60 calls / 60s, Finnhub's published
// free-tier limit). Per the task brief this REJECTS the (maxCalls+1)th call
// within the window with a typed error rather than queueing/waiting for the
// window to slide - callers (collectL1News) treat that rejection exactly
// like any other single-source failure: a warnings[] entry + sourceHealth
// 'failed', never blocking the rest of the batch. `now` is injectable so
// tests can drive the window deterministically instead of racing real wall-
// clock time.
export function createFinnhubRateLimiter({ maxCalls = 60, windowMs = 60_000, now = () => Date.now() } = {}) {
  const callTimestamps = [];
  return {
    acquire(label = "finnhub") {
      const current = now();
      while (callTimestamps.length > 0 && current - callTimestamps[0] >= windowMs) {
        callTimestamps.shift();
      }
      if (callTimestamps.length >= maxCalls) {
        throw new FinnhubRateLimitError(
          `Finnhub rate limit exceeded (${maxCalls} calls / ${windowMs}ms) while fetching ${label}.`
        );
      }
      callTimestamps.push(current);
    },
    // Exposed for tests/observability only - not used by collectL1News.
    size() {
      const current = now();
      return callTimestamps.filter((value) => current - value < windowMs).length;
    }
  };
}

const FINNHUB_COMPANY_NEWS_URL = "https://finnhub.io/api/v1/company-news";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Ported (not imported) from apps/broker-executor/src/redaction.ts's
// redactSensitiveText. apps/openclaw-config/scripts has no package.json/
// build step of its own and no existing app-to-app dist/ dependency
// anywhere in this directory (only packages/*/dist, built once for the
// whole workspace before any app runs) - reaching into a SIBLING APP's
// dist/ for a ~10-line helper would add a new, fragile cross-app coupling
// (broker-executor might not be built at all when only openclaw-config's
// scripts run). Same two-layer approach as the original: replace the
// literal secret substring first (catches the key verbatim wherever it
// landed in the message, including inside an upstream error this module
// didn't author), then a generic key=value-shaped pattern as defense in
// depth.
function redactSecret(text, secret) {
  const value = String(text ?? "");
  const trimmed = String(secret ?? "").trim();
  const withSecretRedacted = trimmed.length >= 6 ? value.split(trimmed).join("<redacted>") : value;
  return withSecretRedacted.replace(
    /\b((?:x-finnhub-token|authorization|token|secret|api[_-]?key)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["']?)[^"',\s}]+/giu,
    "$1$2$3<redacted>"
  );
}

// Fetches Finnhub's company-news endpoint for one symbol over the trailing
// 24h. The ENTIRE body runs inside one try/catch so every error path -
// missing key, rate-limit rejection, fetchImpl's own rejection (which may
// itself embed the raw key in its message, e.g. a lower-level HTTP client
// echoing the request URL/headers back in an error), a non-2xx response, an
// unparseable JSON body - is redacted before it ever leaves this function.
// This is deliberately whole-function rather than per-throw-site redaction:
// a future error path added here without remembering to redact it
// individually would otherwise be a silent key leak.
export async function fetchFinnhubCompanyNews(symbol, { apiKey, fetchImpl = fetch, limiter, timeoutMs = 12_000 } = {}) {
  const key = String(apiKey ?? "").trim();
  try {
    if (!key) {
      throw new Error("Finnhub API key is required (FINNHUB_API_KEY not set).");
    }
    if (limiter) {
      limiter.acquire(`company-news:${symbol}`);
    }

    const now = new Date();
    const url = new URL(FINNHUB_COMPANY_NEWS_URL);
    url.searchParams.set("symbol", toBareSymbol(symbol));
    url.searchParams.set("from", formatFinnhubDate(new Date(now.getTime() - MS_PER_DAY)));
    url.searchParams.set("to", formatFinnhubDate(now));

    const response = await fetchResponseWithTimeout(url, {
      fetchImpl,
      timeoutMs,
      headers: { "X-Finnhub-Token": key }
    });
    if (!response.ok) {
      throw new Error(`Finnhub HTTP ${response.status} ${response.statusText} for ${symbol}`);
    }

    const payload = await response.json();
    const rows = Array.isArray(payload) ? payload : [];
    return rows.map((row) => normalizeFinnhubArticle(symbol, row)).filter(Boolean);
  } catch (error) {
    throw new Error(redactSecret(String(error?.message ?? error), key));
  }
}

function formatFinnhubDate(date) {
  return date.toISOString().slice(0, 10);
}

function normalizeFinnhubArticle(symbol, row) {
  if (!row || typeof row !== "object") {
    return null;
  }
  const title = String(row.headline ?? "").replace(/\s+/gu, " ").trim();
  const url = String(row.url ?? "").trim();
  if (!title || !url) {
    return null;
  }
  // T1 rule ("published_at 可空=未知"): a missing/invalid `datetime` must
  // stay honestly unknown, never fabricated from Date.now().
  const publishedAtMs = Number.isFinite(row.datetime) && row.datetime > 0 ? row.datetime * 1000 : undefined;
  return decorateNewsArticle({
    id: String(row.id ?? url),
    symbol: normalizeSymbol(symbol),
    title,
    url,
    publishedAt: Number.isFinite(publishedAtMs) ? new Date(publishedAtMs).toISOString() : undefined,
    publishedAtMs,
    publisher: String(row.source ?? "").trim() || "Finnhub",
    summary: String(row.summary ?? "").replace(/\s+/gu, " ").trim(),
    source: "finnhub",
    sourceName: "Finnhub",
    lang: "en"
  });
}

// ---------------------------------------------------------------------------
// Pre-existing sources, moved verbatim from scheduled-report.mjs
// ---------------------------------------------------------------------------
// Behavior-preserving move (Task 4 brief): same URLs, same query params,
// same env var names/defaults (REPORT_NEWS_FETCH_ATTEMPTS default 2,
// REPORT_NEWS_FETCH_TIMEOUT_MS default 12000), same result shape. The only
// change is threading fetchImpl/env through as parameters instead of
// closing over module-level `process.env`/global `fetch`, so this module -
// and collectL1News below - can be tested with zero real network calls.

export async function fetchYahooSearchNews(symbol, count, { fetchImpl = fetch, env = process.env } = {}) {
  const yahooSymbol = toBareSymbol(symbol);
  const url = new URL("https://query2.finance.yahoo.com/v1/finance/search");
  url.searchParams.set("q", yahooSymbol);
  url.searchParams.set("quotesCount", "0");
  url.searchParams.set("newsCount", String(count));
  url.searchParams.set("enableFuzzyQuery", "false");
  const text = await fetchTextWithRetry(url, newsFetchRetryOptions(env, fetchImpl));
  return normalizeYahooSearchNews(symbol, JSON.parse(text));
}

export async function fetchYahooRssNews(symbol, count, { fetchImpl = fetch, env = process.env } = {}) {
  const yahooSymbol = toBareSymbol(symbol);
  const url = new URL("https://feeds.finance.yahoo.com/rss/2.0/headline");
  url.searchParams.set("s", yahooSymbol);
  url.searchParams.set("region", "US");
  url.searchParams.set("lang", "en-US");
  const xml = await fetchTextWithRetry(url, newsFetchRetryOptions(env, fetchImpl));
  return normalizeExternalRssNews(symbol, xml, {
    source: "yahoo-finance-rss",
    sourceName: "Yahoo Finance"
  }).slice(0, count);
}

export async function fetchGoogleNewsRss(symbol, count, { fetchImpl = fetch, env = process.env } = {}) {
  const yahooSymbol = toBareSymbol(symbol);
  const url = new URL("https://news.google.com/rss/search");
  url.searchParams.set("q", `${yahooSymbol} stock OR Nasdaq 100 ETF when:7d`);
  url.searchParams.set("hl", "en-US");
  url.searchParams.set("gl", "US");
  url.searchParams.set("ceid", "US:en");
  const xml = await fetchTextWithRetry(url, newsFetchRetryOptions(env, fetchImpl));
  return normalizeExternalRssNews(symbol, xml, {
    source: "google-news-rss",
    sourceName: "Google News"
  }).slice(0, count);
}

// Default Longbridge per-symbol news fetcher (the fourth pre-existing
// source): reads via the same rate-limited/retried CLI wrapper every other
// Longbridge call in this codebase uses. collectL1News accepts this as an
// injectable `longbridgeNewsFetcher` option precisely so tests never have to
// shell out to the real Longbridge CLI - a fixture fetcher stands in for it.
async function defaultLongbridgeNewsFetcher(symbol, count) {
  const payload = await runLongbridgeJsonWithRetry(
    "quote",
    ["news", symbol, "--count", String(count)],
    { label: `Longbridge 新闻 ${symbol}` }
  );
  return normalizeNewsPayload(symbol, payload);
}

// ---------------------------------------------------------------------------
// collectL1News: the unified L1 collection entry point
// ---------------------------------------------------------------------------

// Runs every L1 source concurrently via Promise.allSettled and merges
// whatever came back: RSSHub's 3 bound routes (market-wide - one fetch per
// route, NOT per symbol), Finnhub company-news (per symbol, skipped
// wholesale with sourceHealth.finnhub='skipped_no_key' when no API key is
// configured - not an error, just an absent optional source), and the four
// pre-existing per-symbol sources (Yahoo search, Yahoo RSS, Google News RSS,
// Longbridge). A single source failing (or the Finnhub limiter rejecting a
// call) never blocks any other source - it becomes one warnings[] entry and
// one sourceHealth[key]='failed' entry, exactly the "源级健康" rule the plan
// requires. Only when EVERY source failed or returned nothing (merged
// articles.length === 0) does this throw - the same "a report needs at
// least one verified article" invariant fetchMarketNews enforced before
// this task moved the check here.
export async function collectL1News({
  symbols = [],
  env = process.env,
  fetchImpl = fetch,
  countPerSymbol,
  finnhubLimiter,
  longbridgeNewsFetcher = defaultLongbridgeNewsFetcher,
  rsshubRoutes = RSSHUB_ROUTES
} = {}) {
  const symbolList = Array.isArray(symbols) ? symbols.filter(Boolean) : [];
  const count = Math.max(1, Number(countPerSymbol ?? env?.REPORT_NEWS_COUNT_PER_SYMBOL ?? 5));
  const rsshubBaseUrl = String(env?.RSSHUB_BASE_URL ?? "").trim() || DEFAULT_RSSHUB_BASE_URL;
  const finnhubApiKey = String(env?.FINNHUB_API_KEY ?? "").trim();
  const limiter = finnhubLimiter ?? createFinnhubRateLimiter();

  const warnings = [];
  const sourceHealth = {};
  const tasks = [];

  for (const routeEntry of Object.values(rsshubRoutes)) {
    tasks.push({
      healthKey: `rsshub-${routeEntry.name}`,
      warningLabel: `RSSHub ${routeEntry.sourceName ?? routeEntry.name}`,
      promise: fetchRsshubFeed(routeEntry, { baseUrl: rsshubBaseUrl, timeoutMs: DEFAULT_RSSHUB_TIMEOUT_MS, fetchImpl })
    });
  }

  if (!finnhubApiKey) {
    sourceHealth.finnhub = "skipped_no_key";
  } else {
    for (const symbol of symbolList) {
      tasks.push({
        healthKey: `finnhub:${symbol}`,
        warningLabel: `${symbol} Finnhub 新闻`,
        promise: fetchFinnhubCompanyNews(symbol, { apiKey: finnhubApiKey, fetchImpl, limiter })
      });
    }
  }

  for (const symbol of symbolList) {
    tasks.push({
      healthKey: `yahoo-finance-search:${symbol}`,
      warningLabel: `${symbol} Yahoo Finance 新闻`,
      promise: fetchYahooSearchNews(symbol, count, { fetchImpl, env })
    });
    tasks.push({
      healthKey: `yahoo-finance-rss:${symbol}`,
      warningLabel: `${symbol} Yahoo Finance RSS`,
      promise: fetchYahooRssNews(symbol, count, { fetchImpl, env })
    });
    tasks.push({
      healthKey: `google-news-rss:${symbol}`,
      warningLabel: `${symbol} Google News RSS`,
      promise: fetchGoogleNewsRss(symbol, count, { fetchImpl, env })
    });
    tasks.push({
      healthKey: `longbridge-news:${symbol}`,
      warningLabel: `${symbol} 长桥新闻`,
      promise: Promise.resolve().then(() => longbridgeNewsFetcher(symbol, count))
    });
  }

  const settled = await Promise.allSettled(tasks.map((task) => task.promise));
  const collected = [];
  settled.forEach((result, index) => {
    const { healthKey, warningLabel } = tasks[index];
    if (result.status === "fulfilled") {
      sourceHealth[healthKey] = "ok";
      collected.push(...(Array.isArray(result.value) ? result.value : []));
    } else {
      sourceHealth[healthKey] = "failed";
      warnings.push(`${warningLabel}读取失败：${singleLine(result.reason?.message ?? result.reason, 160)}`);
    }
  });

  const articles = mergeNewsArticles(collected);
  if (articles.length === 0) {
    throw new Error("L1 多源新闻采集全部失败或为空；报告需要至少一条已验证新闻。");
  }

  return { articles, warnings, sourceHealth };
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const DEFAULT_HEADERS = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/125 Safari/537.36 OpenClaw",
  "accept": "application/rss+xml,application/json,text/xml,text/plain,*/*",
  "accept-language": "en-US,en;q=0.9"
};

function newsFetchRetryOptions(env, fetchImpl) {
  return {
    fetchImpl,
    attempts: Math.max(1, Number(env?.REPORT_NEWS_FETCH_ATTEMPTS ?? 2)),
    timeoutMs: Number(env?.REPORT_NEWS_FETCH_TIMEOUT_MS ?? 12_000)
  };
}

async function fetchResponseWithTimeout(url, { fetchImpl = fetch, timeoutMs = 12_000, headers } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, headers ? { signal: controller.signal, headers } : { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextWithRetry(url, { fetchImpl = fetch, attempts = 1, timeoutMs = 12_000, headers = DEFAULT_HEADERS } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchResponseWithTimeout(url, { fetchImpl, timeoutMs, headers });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(500 * attempt);
      }
    }
  }
  throw lastError;
}

function toBareSymbol(symbol) {
  return String(symbol ?? "").toUpperCase().replace(/\.US$/u, "");
}

function singleLine(value, maxChars = 260) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
