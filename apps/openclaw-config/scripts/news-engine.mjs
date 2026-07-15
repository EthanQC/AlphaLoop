// News event clustering core - Phase 4 Task 3. Pure functions, ZERO IO: no
// fetch/fs/db/Date.now()/Math.random() anywhere in this module. Every
// function's output depends only on its arguments, which is what lets
// news-engine.test.ts assert determinism (same input -> same clusterKey,
// shuffled input -> same clusters) and lets both render faces (daily report,
// Task 7; platform news page, Task 7) share one deterministic clustering
// pass over the same L1 article batch.
//
// Input article shape (post-Task-1 report-news.mjs normalizers /
// decorateNewsArticle - see that file): { id, symbol, title, titleZh,
// summary, source, sourceName, publisher, url, publishedAt (ISO|undefined),
// publishedAtMs (number|undefined), relatedTickers: string[],
// sourceEvidence?: string[], impact?: {direction,affected,reason} (future L2
// field, Global Constraints L2 schema) }. `title`/`titleZh`/`summary` are
// already markdown-defused and single-lined by decorateNewsArticle; this
// module never re-derives them from raw feed payloads.
//
// Output shapes:
//   cluster  = { clusterKey: string, articles: Article[],
//                firstPublishedAt: string|null, lastPublishedAt: string|null }
//   impact   = { direction: 'bullish'|'bearish'|'neutral'|'unknown',
//                affected: string[], reason: string|null }
//   event    = { clusterKey, titleZh, summaryZh, impact, firstPublishedAt,
//                lastPublishedAt, sources: [{ origin, publisher, url|null,
//                titleRaw, publishedAt: string|null, lang: 'zh'|'en' }] }
//     - this is the clustering core's semantic event shape, not a literal
//       1:1 argument list for news-store.mjs's upsertEventWithSources(event,
//       sources) - that function's first argument wants
//       impactDirection/impactAffected/impactReason as flat sibling fields
//       (because those are literal DB columns) rather than a nested
//       `impact` object, and takes `sources` as a second, separate argument.
//       The mapping from this event shape to that call is a few lines of
//       field renaming (impact.direction -> impactDirection, etc) done by
//       the caller (Task 7 wires this into scheduled-report.mjs /
//       news-store.mjs; news-engine.test.ts's round-trip test exercises the
//       same mapping today to prove the two shapes agree on every field).

import { createHash } from "node:crypto";

import { normalizeSymbol } from "./report-data.mjs";
import { defuseMarkdownInText, translateFinancialHeadlineToChinese } from "./report-news.mjs";

const CJK_RANGE = /[㐀-鿿]/u;

// ---------------------------------------------------------------------------
// 1. normalizeNewsUrl
// ---------------------------------------------------------------------------

// Tracking query parameters stripped unconditionally (in addition to any
// `utm_*` prefixed key, matched separately below since that family is
// open-ended: utm_source/utm_medium/utm_campaign/utm_term/utm_content/
// utm_id/utm_reader/utm_name/utm_social... all share the prefix). Everything
// NOT in this set / NOT utm_-prefixed is treated as a "meaningful" param and
// kept (e.g. a real article id or query string) - per the task brief, this
// function must not strip params it doesn't recognize as tracking noise.
const TRACKING_PARAM_DENYLIST = new Set([
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "msclkid",
  "yclid",
  "twclid",
  "wbraid",
  "gbraid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "mkt_tok",
  "ref_src",
  "ref",
  "spm",
  "vero_id",
  "_hsenc",
  "_hsmi",
  "oly_anon_id",
  "oly_enc_id"
]);

// Normalizes a news article URL into a stable identity key so the same
// article fetched twice (different tracking params, different trailing
// slash, different host casing) collapses to one string. Returns null for
// anything that isn't an absolute http(s) URL - invalid/relative/other-
// scheme input can never produce a false url-identity match.
//
// Google News wraps the true article URL in an opaque path segment
// (`news.google.com/rss/articles/<protobuf-ish blob>`) that cannot be
// decoded back into the original URL without following the live HTTP
// redirect - which this function, being pure/zero-IO, must never do. Only
// the OLDER `news.google.com/news/url?...&url=<real>` redirect shape carries
// the real target in a plain query param, so that one is unwrapped
// (recursively normalized); the newer `/rss/articles/` shape is left as any
// other URL would be (host lowercased, tracking params stripped, trailing
// slash stripped) - callers rely on clusterArticles's title-similarity path
// to still merge these with their un-wrapped counterparts.
export function normalizeNewsUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ""));
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  if (parsed.hostname.toLowerCase() === "news.google.com") {
    const wrapped = parsed.searchParams.get("url");
    if (wrapped) {
      const unwrapped = normalizeNewsUrl(wrapped);
      if (unwrapped) {
        return unwrapped;
      }
    }
  }

  const host = parsed.host.toLowerCase();
  const params = new URLSearchParams(parsed.search);
  for (const key of Array.from(params.keys())) {
    if (/^utm_/iu.test(key) || TRACKING_PARAM_DENYLIST.has(key.toLowerCase())) {
      params.delete(key);
    }
  }
  // Sorted so two URLs carrying the same meaningful params in a different
  // order (a common cross-publisher-redistribution artifact) normalize
  // identically - this only affects param ORDER, never which params survive.
  const remaining = Array.from(params.entries()).sort(([left], [right]) => left.localeCompare(right));
  const search = remaining.length > 0
    ? `?${remaining.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}`
    : "";

  // Trailing slash stripped from the path (but never below root "/"); the
  // fragment (#...) is always dropped - it is essentially never part of an
  // article's identity for news and is a common source of otherwise-
  // spurious "different URL" noise (anchor added by a share widget, etc).
  const path = parsed.pathname.replace(/\/+$/u, "") || "/";
  return `${parsed.protocol}//${host}${path}${search}`;
}

// ---------------------------------------------------------------------------
// 2. titleSimilarity
// ---------------------------------------------------------------------------

// Small, intentionally short stopword lists per the task brief ("the/a/of/
// 在/的 etc small list") - this is NOT meant to be a comprehensive NLP
// stopword corpus, just enough to keep grammatical glue words from
// contributing noise to the Jaccard score.
const LATIN_STOPWORDS = new Set([
  "the", "a", "an", "of", "in", "on", "at", "to", "for", "and", "or",
  "is", "are", "was", "were", "with", "by", "as", "its", "it", "this", "that"
]);
const CJK_STOPWORDS = new Set([
  "的", "了", "在", "是", "和", "与", "及", "对", "也", "就", "都", "而", "着", "吗", "呢", "之"
]);

// Tokenizes one title for Jaccard comparison. CJK text has no whitespace to
// split on, so CJK runs are tokenized as per-character bigrams (a 1-char CJK
// run yields the single char itself, since a bigram needs 2 chars); Latin/
// digit runs are split into whole words. Punctuation and other symbols are
// dropped implicitly - the extraction regex below only matches CJK-ideograph
// runs and [a-z0-9] runs, so anything else (punctuation, emoji, whitespace)
// simply isn't captured into any token.
function tokenizeTitle(text) {
  const normalized = String(text ?? "").toLowerCase();
  const runs = normalized.match(/[㐀-鿿]+|[a-z0-9]+/gu) ?? [];
  const tokens = [];
  for (const run of runs) {
    if (CJK_RANGE.test(run)) {
      // Stopword characters are deleted from the run BEFORE bigrams are
      // generated (the CJK-granularity equivalent of dropping a whole Latin
      // stopword WORD from the token stream), not filtered out of the
      // resulting bigrams afterward - a bigram like "涨的" is not itself in
      // CJK_STOPWORDS and would otherwise survive untouched, silently
      // reintroducing the dropped particle. Deleting a stopword char that
      // sits between two content chars fuses its former neighbors into a
      // new adjacent pair (e.g. "上的涨" -> "上涨"); this is an accepted
      // simplification for this small, deliberately short stopword list,
      // not a general-purpose segmentation algorithm.
      const chars = Array.from(run).filter((char) => !CJK_STOPWORDS.has(char));
      if (chars.length === 0) {
        continue;
      }
      if (chars.length === 1) {
        tokens.push(chars[0]);
        continue;
      }
      for (let i = 0; i < chars.length - 1; i += 1) {
        tokens.push(chars[i] + chars[i + 1]);
      }
    } else if (!LATIN_STOPWORDS.has(run)) {
      tokens.push(run);
    }
  }
  return new Set(tokens);
}

// Jaccard similarity of two titles' token sets, in [0, 1]. Two titles that
// both tokenize to nothing (empty/punctuation-only/all-stopword titles) are
// defined as similarity 1 only when their trimmed raw text is identical,
// else 0 - the bare Jaccard formula (0/0) is undefined and must not throw or
// silently return NaN into a threshold comparison.
export function titleSimilarity(a, b) {
  const tokensA = tokenizeTitle(a);
  const tokensB = tokenizeTitle(b);
  if (tokensA.size === 0 && tokensB.size === 0) {
    return String(a ?? "").trim() === String(b ?? "").trim() ? 1 : 0;
  }
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersection += 1;
    }
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// 3. clusterArticles
// ---------------------------------------------------------------------------

const DEFAULT_SIMILARITY_THRESHOLD = 0.6;
const DEFAULT_WINDOW_MS = 48 * 3600 * 1000;

function articleTitleText(article) {
  return String(article?.title ?? "").trim();
}

function hasKnownTime(article) {
  return Number.isFinite(article?.publishedAtMs);
}

// Pairwise merge test used by clusterArticles's title-similarity path. Per
// the task brief: an unknown-time article on EITHER side of the pair skips
// the window check entirely (there is no time to compare), relying on
// similarity alone; only when BOTH sides have a known publishedAtMs does the
// |diff| <= windowMs constraint apply.
function shouldMergeByTitle(articleA, articleB, threshold, windowMs) {
  const similarity = titleSimilarity(articleTitleText(articleA), articleTitleText(articleB));
  if (similarity < threshold) {
    return false;
  }
  if (hasKnownTime(articleA) && hasKnownTime(articleB)) {
    return Math.abs(articleA.publishedAtMs - articleB.publishedAtMs) <= windowMs;
  }
  return true;
}

// Selects the "representative" article of a group per the deterministic
// rule used throughout this module (clusterKey fallback, titleZh/summaryZh
// selection, deriveImpact's heuristic input): earliest known publish time
// first (unknown-time articles sort last, mirroring report-news.mjs's
// mergeNewsArticles convention of ranking unknown time last rather than
// fabricating "now"), tie-broken by normalized-URL (falling back to the raw
// url string) so the choice never depends on input array order.
function pickRepresentativeArticle(articles) {
  const list = Array.isArray(articles) ? articles : [];
  if (list.length === 0) {
    return null;
  }
  const sorted = [...list].sort((left, right) => {
    const leftTime = hasKnownTime(left) ? left.publishedAtMs : Infinity;
    const rightTime = hasKnownTime(right) ? right.publishedAtMs : Infinity;
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    const leftKey = normalizeNewsUrl(left?.url) ?? String(left?.url ?? "");
    const rightKey = normalizeNewsUrl(right?.url) ?? String(right?.url ?? "");
    return leftKey.localeCompare(rightKey);
  });
  return sorted[0];
}

// Deterministic, dependency-free stable hash for the `title:` clusterKey
// fallback (used only when the representative article has no usable URL).
// SHA-256 is available IO-free via node:crypto (pure computation, no
// filesystem/network/randomness) and avoids hand-rolling a hash function;
// truncated to 16 hex chars since this only needs to be collision-resistant
// enough to distinguish distinct headlines, not cryptographically secure.
function stableHash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function computeClusterKey(members) {
  const representative = pickRepresentativeArticle(members);
  const normalizedUrl = normalizeNewsUrl(representative?.url);
  if (normalizedUrl) {
    return normalizedUrl;
  }
  const tokens = Array.from(tokenizeTitle(articleTitleText(representative))).sort();
  return `title:${stableHash(tokens.join("|"))}`;
}

// Clusters a flat batch of L1 articles into events via single-linkage
// union-find: same normalized URL always merges two articles; otherwise
// title similarity >= threshold AND (both times known -> within windowMs) is
// a second, independent merge rule. Both rules feed the SAME union-find
// structure, so merges chain transitively (A-B via URL, B-C via title
// similarity => A, B, C end up in one cluster) even though no single pairwise
// rule alone would connect A directly to C. This is the accepted, documented
// tradeoff of single-linkage clustering: a long chain of pairwise-similar-
// enough articles can pull in a final member only loosely related to the
// first (the classic "clustering drift" failure mode). It is accepted here
// because (a) news events cited in the daily report/platform page are
// batches on the order of dozens of articles per run, not an unbounded
// stream where drift compounds over time, and (b) the task brief explicitly
// green-lights this approach ("Single-linkage union-find is fine").
//
// Complexity: O(n^2) title-similarity comparisons (every pair not already
// url-unified) plus O(n * alpha(n)) union-find operations - acceptable at
// report-generation scale; would need a blocking/indexing pass (e.g. by
// shared shingles) before this scales to thousands of articles per run.
export function clusterArticles(articles, options = {}) {
  const threshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const list = Array.isArray(articles) ? articles.filter(Boolean) : [];
  const n = list.length;

  const parent = Array.from({ length: n }, (_, index) => index);
  function find(index) {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root];
    }
    let cursor = index;
    while (parent[cursor] !== root) {
      const next = parent[cursor];
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  }
  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent[rootA] = rootB;
    }
  }

  const normalizedUrls = list.map((article) => normalizeNewsUrl(article?.url));

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const urlI = normalizedUrls[i];
      const urlJ = normalizedUrls[j];
      if (urlI && urlJ && urlI === urlJ) {
        union(i, j);
        continue;
      }
      if (shouldMergeByTitle(list[i], list[j], threshold, windowMs)) {
        union(i, j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    if (!groups.has(root)) {
      groups.set(root, []);
    }
    groups.get(root).push(list[i]);
  }

  const clusters = Array.from(groups.values()).map((members) => {
    const knownTimes = members.map((article) => article.publishedAtMs).filter(Number.isFinite);
    const firstMs = knownTimes.length > 0 ? Math.min(...knownTimes) : null;
    const lastMs = knownTimes.length > 0 ? Math.max(...knownTimes) : null;
    return {
      clusterKey: computeClusterKey(members),
      articles: members,
      firstPublishedAt: firstMs !== null ? new Date(firstMs).toISOString() : null,
      lastPublishedAt: lastMs !== null ? new Date(lastMs).toISOString() : null
    };
  });

  // Output order is sorted by clusterKey so a shuffled INPUT still produces
  // an identically-ordered output array - determinism the task brief asks
  // tests to pin ("order-independent input -> same clusters").
  return clusters.sort((left, right) => left.clusterKey.localeCompare(right.clusterKey));
}

// ---------------------------------------------------------------------------
// 4. deriveImpact
// ---------------------------------------------------------------------------

const VALID_DIRECTIONS = new Set(["bullish", "bearish", "neutral", "unknown"]);

function coerceDirection(value) {
  return VALID_DIRECTIONS.has(value) ? value : "unknown";
}

// Ported from scheduled-report.mjs's summarizeMarketNewsTitle (Phase
// 2-3 heuristic; see that file's history around line ~682). Kept here
// byte-for-byte in rule ORDER and regex content (only renamed locally) so
// this module's classification agrees with the pre-Phase-4 report output;
// scheduled-report.mjs itself keeps its own copy until Task 7 rewires it to
// import from here (per this task's brief: "moving heuristics with
// re-export shims if needed - do NOT rewire scheduled-report's news flow").
function summarizeMarketNewsTitle(title) {
  const text = String(title ?? "");
  if (/trade representative|ustr|tariff|trade policy/iu.test(text)) {
    return { event: "美国贸易政策或关税相关消息更新", impact: "关注贸易政策变化对科技股估值和纳指风险偏好的影响" };
  }
  if (/wall street extends rally|tech strength|tech leaps|technology/iu.test(text)) {
    return { event: "美股在科技板块带动下延续上涨", impact: "对 QQQ 偏正面，但需防止短线追高" };
  }
  if (/week ahead|monday|what to watch/iu.test(text)) {
    return { event: "下周市场前瞻更新", impact: "关注周一开盘、宏观数据和科技股消息对 QQQ 的影响" };
  }
  if (/global markets|crude|iran|truce|middle east/iu.test(text)) {
    return { event: "全球市场和地缘风险预期变化", impact: "若避险需求下降，成长股风险偏好可能改善；若反复则波动上升" };
  }
  if (/stock market indicator|warning|buffett|2007/iu.test(text)) {
    return { event: "市场风险指标出现警示信号", impact: "提示不要只看短线上涨，需同时关注回撤和仓位上限" };
  }
  if (/nvidia|huang|ai|artificial intelligence/iu.test(text)) {
    return { event: "人工智能和英伟达增长预期相关消息", impact: "对纳指和 QQQ 的科技权重股情绪有直接影响" };
  }
  if (/micron|semiconductor|chip|\bmu\b/iu.test(text)) {
    return { event: "半导体板块相关消息", impact: "可能影响纳指科技链条情绪，需观察是否扩散到 QQQ" };
  }
  if (/linde|nasdaq|underperform/iu.test(text)) {
    return { event: "个股相对纳指表现偏弱的讨论", impact: "作为市场宽度参考，暂不直接改变 QQQ 持仓判断" };
  }
  if (/hedge|shorted|crash/iu.test(text)) {
    return { event: "市场风险对冲和高空头股票反弹相关消息", impact: "说明风险偏好回升，但也可能放大短期波动" };
  }
  if (/market|stocks|wall street|nasdaq|qqq/iu.test(text)) {
    return { event: "美股市场走势相关消息", impact: "作为 QQQ 趋势和风险偏好的辅助证据" };
  }
  if (/earnings|revenue|profit|guidance/iu.test(text)) {
    return { event: "公司业绩或指引相关消息", impact: "关注是否影响科技股盈利预期" };
  }
  if (CJK_RANGE.test(text)) {
    return { event: singleLine(text, 120), impact: "媒体、渠道和链接已列在新闻明细中；先作为可核对线索，不单独触发加仓" };
  }
  return { event: "多源检索返回的一般市场新闻", impact: "媒体、渠道和链接已列在新闻明细中；先作为可核对线索，不单独触发加仓" };
}

function singleLine(value, maxChars) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

// Ported from scheduled-report.mjs's classifyMarketNews bias ladder (same
// file/line range as summarizeMarketNewsTitle above). The old function
// returned a Chinese bias label (利好/利空/待验证); deriveImpact needs the
// new `direction` enum, so the mapping is 利好 -> bullish, 利空 -> bearish,
// 待验证 -> neutral (a real classification was produced, it just isn't
// directionally clear-cut - this is NOT the same as `unknown`, which this
// module reserves for "there was nothing to classify at all", see
// deriveImpact below).
function classifyArticleDirection(article) {
  const summary = summarizeMarketNewsTitle(article?.titleZh ?? article?.title);
  const text = `${article?.title ?? ""} ${article?.titleZh ?? ""} ${summary.event} ${summary.impact}`;
  let bias = "待验证";
  if (/rally|strength|leaps|growth|truce|improve|上行|上涨|改善|正面|增长|缓和/iu.test(text)) {
    bias = "利好";
  }
  if (/warning|tariff|crude|iran|crash|underperform|risk event|geopolitical risk|下跌|警示|关税|风险事件|地缘风险|偏弱/iu.test(text)) {
    bias = bias === "利好" ? "待验证" : "利空";
  }
  const direction = bias === "利好" ? "bullish" : bias === "利空" ? "bearish" : "neutral";
  return { direction, reason: summary.event };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// Matches trackedSymbols against a cluster's relatedTickers (Yahoo-style
// bare tickers, e.g. "AAPL" - normalized the same way report-data.mjs
// normalizes any symbol, so "AAPL" and "AAPL.US" compare equal) and against
// literal ticker mentions in article title/titleZh text (word-bounded, so
// e.g. ticker "ALL" cannot match inside an unrelated word like "wall" or
// "small"). This is intentionally narrower than a full company-name-aware
// match (no COMPANY_NAMES-style NLP) per the task brief's wording ("affected
// = matched tracked symbols from relatedTickers+title matching").
function matchAffectedSymbols(cluster, trackedSymbols) {
  const tracked = Array.from(new Set((Array.isArray(trackedSymbols) ? trackedSymbols : []).map((symbol) => normalizeSymbol(symbol)).filter(Boolean)));
  if (tracked.length === 0) {
    return [];
  }
  const matched = new Set();
  for (const article of cluster?.articles ?? []) {
    const relatedNormalized = new Set((Array.isArray(article?.relatedTickers) ? article.relatedTickers : []).map((ticker) => normalizeSymbol(ticker)));
    const text = `${article?.title ?? ""} ${article?.titleZh ?? ""}`;
    for (const symbol of tracked) {
      if (matched.has(symbol)) {
        continue;
      }
      if (relatedNormalized.has(symbol)) {
        matched.add(symbol);
        continue;
      }
      const bare = symbol.replace(/\.[A-Z]{2,4}$/u, "");
      if (bare.length < 2) {
        continue;
      }
      const pattern = new RegExp(`(?:^|[^A-Za-z])\\$?${escapeRegExp(bare)}(?:[^A-Za-z]|$)`, "iu");
      if (pattern.test(text)) {
        matched.add(symbol);
      }
    }
  }
  return Array.from(matched).sort();
}

// Derives a cluster's market impact classification. If any member article
// already carries a structured `impact` object (the future L2 field, Global
// Constraints' `{title, publisher, url, publishedAt, summary_zh,
// impact:{direction,affected,reason}, evidence_quote}` schema), that
// structured value is preferred outright over the heuristic ladder below -
// per the task brief ("If an article carries structured impact ... prefer
// it") - with its `affected` list still UNIONED against this module's own
// trackedSymbols/relatedTickers/title match (a human- or L2-supplied impact
// naming one ticker should not suppress a second, independently-detected
// tracked symbol also mentioned in the same cluster).
//
// Absent any structured impact, the heuristic path classifies the cluster's
// single REPRESENTATIVE article (see pickRepresentativeArticle) rather than
// every article separately and then voting - this keeps the result
// deterministic and consistent with which article's title/summary the rest
// of this module (clusterKey, titleZh) already treats as canonical for the
// cluster, instead of introducing a second, independent "best article" rule.
export function deriveImpact(cluster, trackedSymbols = []) {
  const articles = Array.isArray(cluster?.articles) ? cluster.articles : [];
  const affected = matchAffectedSymbols(cluster, trackedSymbols);

  const structuredHolder = articles.find((article) => article && typeof article.impact === "object" && article.impact !== null);
  if (structuredHolder) {
    const structured = structuredHolder.impact;
    const structuredAffected = Array.isArray(structured.affected) ? structured.affected.map(String) : [];
    return {
      direction: coerceDirection(structured.direction),
      affected: Array.from(new Set([...structuredAffected, ...affected])).sort(),
      reason: structured.reason ? String(structured.reason) : null
    };
  }

  if (articles.length === 0) {
    return { direction: "unknown", affected, reason: null };
  }

  const representative = pickRepresentativeArticle(articles);
  const { direction, reason } = classifyArticleDirection(representative);
  return { direction, affected, reason };
}

// ---------------------------------------------------------------------------
// 5. buildEventFromCluster
// ---------------------------------------------------------------------------

function isNativeCjkArticle(article) {
  return CJK_RANGE.test(String(article?.title ?? ""));
}

// "Best" CJK title in the cluster: prefer a genuinely Chinese-sourced
// headline (article.title itself is CJK, e.g. from a RSSHub Chinese-language
// route) over a machine-translated one - decorateNewsArticle (Task 1)
// guarantees EVERY article already has a non-empty titleZh by the time it
// reaches this module (native text passed through as-is, English headlines
// run through translateFinancialHeadlineToChinese), but that heuristic
// translation is lossy/generic (many distinct English earnings headlines
// all translate to the same "XX 业绩、收入或指引相关更新" bucket), so a
// genuinely-Chinese source is strictly more informative when one exists in
// the cluster. Falls back to re-deriving the translation for the
// cluster's representative article when no native-Chinese member exists.
function selectBestTitleZh(articles) {
  const nativeCjk = articles.filter(isNativeCjkArticle);
  const pool = nativeCjk.length > 0 ? nativeCjk : articles;
  const chosen = pickRepresentativeArticle(pool);
  if (!chosen) {
    return "";
  }
  const raw = chosen.titleZh ?? translateFinancialHeadlineToChinese(chosen.title, chosen.symbol);
  return defuseMarkdownInText(raw);
}

// Two-line summaryZh: line 1 is the cluster's chosen Chinese headline (same
// selection as selectBestTitleZh, so the two fields agree on which article
// is "the story"); line 2 is that article's own summary/description text
// when present (already Chinese if the source was Chinese; prefixed when it
// is English, since this module has no access to report-news.mjs's private
// summarizeNewsSnippetToChinese heuristic - Task 3's brief scopes changes to
// news-engine.mjs only, report-news.mjs is not to be modified here) or an
// honest placeholder when the source provided no summary text at all.
function selectBestSummaryZh(articles) {
  const withSummary = articles.filter((article) => String(article?.summary ?? "").trim().length > 0);
  const pool = withSummary.length > 0 ? withSummary : articles;
  const chosen = pickRepresentativeArticle(pool);
  if (!chosen) {
    return "";
  }
  const headlineLine = chosen.titleZh ?? translateFinancialHeadlineToChinese(chosen.title, chosen.symbol);
  const summary = String(chosen?.summary ?? "").trim();
  const detailLine = summary.length === 0
    ? "来源未提供摘要正文，请核对原文链接确认细节。"
    : (CJK_RANGE.test(summary) ? summary : `英文摘要：${summary}`);
  return defuseMarkdownInText(`${headlineLine}\n${detailLine}`);
}

function toSourceRecord(article) {
  return {
    origin: String(article?.source ?? article?.origin ?? "unknown-news"),
    publisher: String(article?.publisher ?? article?.sourceName ?? article?.source ?? "未知来源"),
    url: article?.url ? String(article.url) : null,
    titleRaw: String(article?.title ?? article?.titleZh ?? "(无标题)"),
    publishedAt: article?.publishedAt ?? null,
    lang: isNativeCjkArticle(article) ? "zh" : "en"
  };
}

// Builds the store-bound event shape (see module header for the mapping
// note to news-store.mjs's upsertEventWithSources) from one clusterArticles
// result. trackedSymbols flows straight through to deriveImpact.
export function buildEventFromCluster(cluster, trackedSymbols = []) {
  const articles = Array.isArray(cluster?.articles) ? cluster.articles : [];
  return {
    clusterKey: cluster?.clusterKey ?? null,
    titleZh: selectBestTitleZh(articles),
    summaryZh: selectBestSummaryZh(articles),
    impact: deriveImpact(cluster, trackedSymbols),
    firstPublishedAt: cluster?.firstPublishedAt ?? null,
    lastPublishedAt: cluster?.lastPublishedAt ?? null,
    sources: articles.map(toSourceRecord)
  };
}
