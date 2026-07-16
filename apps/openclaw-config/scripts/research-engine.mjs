// Phase 8 Task 2 (2026-07-16 plan): the deterministic 研判引擎 (research
// verdict pipeline) sitting behind the in-site question box. This module
// runs a FIXED, ordered sequence of steps - 意图解析 -> 拉取行情 -> 检索新闻
// -> 读取论点与纪律 -> 数字校验 -> 生成研判 - assembling a `result_json`
// verdict from whatever real data was actually available, never fabricating
// a number or a source. It is intentionally NOT an LLM: every branch below
// is a pure function of its arguments, so the exact same
// (question, symbolUniverse, backend responses, quote/memory reader
// responses) always produces the exact same output.
//
// This module follows the injectable-backend/budget-accounting/degrade-
// honestly shape Phase 4 Task 5 established for restricted-agent search
// (news-agent-search.mjs) as closely as the (simpler) research-question
// shape allows:
//   - `createResearchBackend()` (bottom of this file) mirrors
//     `createOpenclawSearchBackend` exactly: a documented, P10-gated throw.
//     Every test in research-engine.test.ts instead injects a fake backend.
//   - the backend's raw text is defused (defuseMarkdownInText, report-
//     news.mjs #29) before it is ever adopted for rendering, AND the raw
//     pre-defuse text is separately quarantined behind the SAME
//     `<<<EXTERNAL_UNTRUSTED>>>...<<<END_EXTERNAL>>>` delimiters news-
//     agent-search.mjs uses - see `wrapExternalText` below and that
//     module's header comment for the full anti-injection rationale. The
//     one piece that differs from news-agent-search: this engine's evidence
//     shape (Global Constraints' research result schema) HAS a slot for it
//     (`evidence[].rawText`), so the quarantined text is exposed to a human
//     reader for audit rather than being pure internal dead weight - but it
//     is still a dead end for THIS module: nothing here (or in a later
//     query-planning step) ever reads a PRIOR call's `rawText`/`title`/
//     `summary_zh` back in to decide what to search for next. Every query
//     this module ever issues is derived solely from `question` and
//     `symbolUniverse` (both first-party/trusted, resolved once up front in
//     the 意图解析 step) - never from a backend response.
//   - budget accounting mirrors news-agent-search's `executeQueries`
//     exactly: the check happens BEFORE each call (so the (budget+1)-th
//     query is never attempted, not merely uncounted), and running out of
//     budget is NORMAL, EXPECTED completion (`status: 'done'`) - never
//     `degraded`. A backend THROW is the only thing that sets
//     `degraded: true`, and it keeps whatever partial results were already
//     validated from earlier, successful calls in the SAME run (`results`
//     is never reset).
//
// Numeric honesty (narrative-engine.mjs precedent, 2026-07-15 plan): a
// restricted search backend's prose can state a number (a cited price
// target, a percentage) that has no relationship to OUR OWN trusted
// figures (the quotes this run itself fetched via `quoteReader`). Exactly
// as narrative-engine.mjs's numeric pre-check does for its LLM narrative
// backend, any such number is checked against the trusted values within
// the SAME tolerances (±0.1 for a percentage-adjacent number, ±0.01 for a
// price) - but unlike narrative-engine.mjs (which degrades/discards a whole
// section on a mismatch), this engine marks ONLY the offending number
// "（数字待核）" in place and keeps the surrounding point/verdict: "do NOT
// drop the whole verdict, do NOT fabricate" (task brief) - a research
// verdict citing ONE unverified number is still useful; silently dropping
// the whole thing (or worse, silently accepting the number as fact) is not.
//
// Interfaces (task brief - this is the ENGINE's own signature, distinct
// from the 2026-07-16 plan's Task 2 sketch which also listed a `db`
// parameter): `runResearchPipeline` takes NO `db` - it is a pure function
// of its injected collaborators (`backend`, `quoteReader`, `memoryReader`)
// plus plain data (`question`, `ownerId`, `symbolUniverse`, `budget`,
// `now`). All persistence (steps trace, result_json, confidence, title)
// is the WORKER's job (Task 3): the worker calls this function, gets back
// a fully-formed result, and writes it via ResearchTaskRepository. This
// keeps the engine trivially testable (every collaborator is a fake in
// research-engine.test.ts) and keeps the isolation rule
// ("agent 无自由 scope 参数") structurally true: `memoryReader` is a
// closure the WORKER pre-binds to `ownerId` before ever handing it to this
// module (Global Constraints) - this engine merely forwards `ownerId` as a
// plain argument to whatever reader it was given; it never constructs,
// widens, or infers an owner/visibility scope from `question` or any other
// untrusted input.

import { defuseMarkdownInText } from "./report-news.mjs";
import { normalizeSymbol } from "./report-data.mjs";

// ---------------------------------------------------------------------------
// Step names - single source of truth so onStep()'s `name` field and this
// module's own tests never drift into two independently-typed copies of the
// same six Chinese literals.
// ---------------------------------------------------------------------------
const STEP_NAMES = {
  intent: "意图解析",
  quotes: "拉取行情",
  news: "检索新闻",
  memory: "读取论点与纪律",
  numeric: "数字校验",
  verdict: "生成研判"
};

// Operational-intent keywords (task brief): a question that names one of
// these ACTIONS is a COMMAND wearing a question's punctuation, not a
// research question - "帮我把这条规则改一下" and "要不要把这条规则改一下"
// both name 改规则; either way the correct destination is 飞书, not this
// read-only research pipeline. A simple substring match is deliberately
// conservative in the safe direction: a false positive merely redirects an
// edge-case research question to Feishu (annoying, recoverable); a false
// negative would let an operational request slip into a pipeline that has
// no write access to rules/proposals/memory/orders at all (Global
// Constraints: "无 shell/无文件写/无券商") and would then silently no-op -
// far worse than an over-eager redirect.
const OPERATIONAL_INTENT_KEYWORDS = ["改规则", "批提案", "记记忆", "删除", "买入", "卖出"];

function detectOperationalIntent(question) {
  const text = String(question ?? "");
  return OPERATIONAL_INTENT_KEYWORDS.find((keyword) => text.includes(keyword)) ?? null;
}

// ---------------------------------------------------------------------------
// 意图解析: symbol + topic extraction
// ---------------------------------------------------------------------------

// A deliberately generic ticker-shaped token (bare "AAPL" or suffixed
// "AAPL.US") - NOT a general NLP entity extractor. Safety comes from the
// SECOND half of extraction, not this regex: every candidate is normalized
// and then intersected with `symbolUniverse` (first-party/trusted, supplied
// by the worker per Global Constraints' "标的范围 = 全体标的池并集 + 本人持
// 仓"), so a random English word the regex happens to match (unlikely in a
// mostly-Chinese question, but not impossible) is silently dropped unless
// it ALSO happens to collide with a real tracked symbol.
const SYMBOL_TOKEN_PATTERN = /\b[A-Za-z]{1,6}(?:\.[A-Za-z]{1,4})?\b/gu;

function extractSymbols(question, symbolUniverse) {
  const universe = new Set(
    (Array.isArray(symbolUniverse) ? symbolUniverse : []).map((symbol) => normalizeSymbol(symbol)).filter(Boolean)
  );
  const text = String(question ?? "");
  const resolved = [];
  for (const match of text.matchAll(SYMBOL_TOKEN_PATTERN)) {
    const normalized = normalizeSymbol(match[0]);
    if (universe.has(normalized) && !resolved.includes(normalized)) {
      resolved.push(normalized);
    }
  }
  return resolved;
}

// Best-effort "what is this question actually about" string used only to
// flavor the (still fully deterministic) news query plan below - strips out
// the bare-ticker portion of each resolved symbol so the remaining text
// reads like the question's topic, falling back to the raw question (or a
// generic placeholder) when nothing is left.
function extractTopic(question, symbols) {
  let text = String(question ?? "").trim();
  for (const symbol of symbols) {
    const bareTicker = symbol.replace(/\.[A-Za-z]+$/u, "");
    if (bareTicker) {
      text = text.replaceAll(bareTicker, " ");
    }
  }
  text = text.replace(/\s+/gu, " ").trim();
  return text || String(question ?? "").trim() || "相关标的";
}

// Title shown on the /research/<id> card and in the reports/member-card
// archive lists - derived from the question, never from resultJson (task
// brief: "title (derived from question, ≤40 chars)"). Truncation keeps the
// ellipsis INSIDE the 40-char budget rather than appending past it.
function deriveTitle(question) {
  const trimmed = String(question ?? "").trim().replace(/\s+/gu, " ");
  if (!trimmed) {
    return "研究任务";
  }
  return trimmed.length <= 40 ? trimmed : `${trimmed.slice(0, 39)}…`;
}

// ---------------------------------------------------------------------------
// 检索新闻: result validation (mirrors news-agent-search.mjs's
// validateResultItem, trimmed to this engine's simpler backend schema -
// {title, publisher, url, summary_zh, publishedAt}, no `impact`/
// `evidence_quote`) + the external-text quarantine wrapper.
// ---------------------------------------------------------------------------

function hasCjk(value) {
  return /[㐀-鿿]/u.test(String(value ?? ""));
}

const EXTERNAL_TEXT_PREFIX = "<<<EXTERNAL_UNTRUSTED>>>";
const EXTERNAL_TEXT_SUFFIX = "<<<END_EXTERNAL>>>";

// See module header's anti-injection rationale: the raw, pre-defuse text is
// preserved verbatim (for a human audit trail / evidence[].rawText) inside
// these delimiters so it is structurally unambiguous - to a human reader or
// any later LLM-based consumer - that everything between them is DATA to
// look at, never INSTRUCTIONS to follow. Nothing in this module ever reads
// a `rawText` value back in to plan a subsequent query.
function wrapExternalText(rawItem) {
  const parts = [`title: ${String(rawItem?.title ?? "")}`, `summary_zh: ${String(rawItem?.summary_zh ?? "")}`].join(" | ");
  return `${EXTERNAL_TEXT_PREFIX}${parts}${EXTERNAL_TEXT_SUFFIX}`;
}

// `publishedAt` is honestly nullable - an unparseable/missing value must
// NEVER be fabricated as "now" (same #31 audit-fix rule news-agent-
// search.mjs / news-engine.mjs already follow).
function parsePublishedAt(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const ts = new Date(String(value)).getTime();
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

// Validates one raw backend result item. Returns `{ item }` on success or
// `{ dropped: 'no_url' | 'not_chinese' }` on rejection - the two hard-drop
// conditions the task brief names: no `url` at all, or a `summary_zh` with
// no Chinese character at all (a purely English/other-script summary
// cannot satisfy "summary_zh"). Title/summary_zh - every field this module
// lets a report render - go through defuseMarkdownInText first.
function validateResearchResultItem(rawItem) {
  const url = String(rawItem?.url ?? "").trim();
  if (!url) {
    return { dropped: "no_url" };
  }
  const summaryZhRaw = String(rawItem?.summary_zh ?? "");
  if (!hasCjk(summaryZhRaw)) {
    return { dropped: "not_chinese" };
  }
  const item = {
    title: defuseMarkdownInText(String(rawItem?.title ?? "").trim()),
    publisher: String(rawItem?.publisher ?? "").trim() || "未知来源",
    url,
    publishedAt: parsePublishedAt(rawItem?.publishedAt),
    summary_zh: defuseMarkdownInText(summaryZhRaw.trim()),
    rawText: wrapExternalText(rawItem)
  };
  return { item };
}

// Deterministic query plan for a single research question: one query per
// resolved symbol plus one topic-level query - both derived ONLY from
// `symbols`/`topic` (first-party, resolved once in 意图解析), never from a
// prior backend response (module header's anti-injection rationale).
function planResearchQueries({ symbols, topic }) {
  const queries = symbols.map((symbol) => ({ query: `${symbol} ${topic} 最新消息`, kind: "symbol" }));
  queries.push({ query: `${topic} 相关新闻 最新消息`, kind: "topic" });
  return queries;
}

// Paced execution of the query plan against `backend`, bounded by `budget` -
// mirrors news-agent-search.mjs's executeQueries exactly: the budget check
// happens BEFORE each call (the (budget+1)-th query is never attempted), a
// throw sets `degraded: true` and stops immediately WITHOUT resetting
// `results` (partial results from earlier, successful calls are kept), and
// running out of budget is normal completion - `degraded` stays false.
async function executeResearchQueries(backend, queries, budget) {
  const safeBudget = Math.max(0, Number(budget) || 0);
  const results = [];
  let callsUsed = 0;
  let droppedNoUrl = 0;
  let droppedNotChinese = 0;
  let degraded = false;
  let degradedReason = null;

  if (typeof backend !== "function") {
    return { results, callsUsed, droppedNoUrl, droppedNotChinese, degraded, degradedReason, budgetExhausted: false, noBackend: true };
  }

  for (const plannedQuery of queries) {
    if (callsUsed >= safeBudget) {
      break;
    }
    callsUsed += 1;

    let response;
    try {
      response = await backend(plannedQuery);
    } catch (error) {
      degraded = true;
      degradedReason = String(error?.message ?? error);
      break;
    }

    const rawResults = Array.isArray(response?.results) ? response.results : [];
    for (const rawItem of rawResults) {
      const outcome = validateResearchResultItem(rawItem);
      if (outcome.dropped === "no_url") {
        droppedNoUrl += 1;
      } else if (outcome.dropped === "not_chinese") {
        droppedNotChinese += 1;
      } else if (outcome.item) {
        results.push(outcome.item);
      }
    }
  }

  return {
    results,
    callsUsed,
    droppedNoUrl,
    droppedNotChinese,
    degraded,
    degradedReason,
    budgetExhausted: queries.length > safeBudget,
    noBackend: false
  };
}

// ---------------------------------------------------------------------------
// 数字校验: numeric pre-check over evidence text (narrative-engine.mjs
// precedent - see module header). Tolerances are IDENTICAL to narrative-
// engine.mjs's PCT_TOLERANCE/PRICE_TOLERANCE.
// ---------------------------------------------------------------------------

const PCT_TOLERANCE = 0.1;
const PRICE_TOLERANCE = 0.01;
const ISO_DATE_PATTERN = /\d{4}-\d{2}-\d{2}/gu;
const NUMBER_TOKEN_PATTERN = /-?\d[\d,]*\.?\d*/gu;

function extractNumberTokens(text) {
  const withoutDates = String(text ?? "").replace(ISO_DATE_PATTERN, "");
  const tokens = [];
  for (const match of withoutDates.matchAll(NUMBER_TOKEN_PATTERN)) {
    const raw = match[0];
    const value = Number(raw.replace(/,/gu, ""));
    if (!Number.isFinite(value)) {
      continue;
    }
    const rest = withoutDates.slice(match.index + raw.length);
    const isPercentAdjacent = /^\s?%/u.test(rest);
    tokens.push({ raw, value, kind: isPercentAdjacent ? "pct" : "price" });
  }
  return tokens;
}

// Marks every number token in `text` that cannot be matched (within
// tolerance) to ANY of `factValues` with an inline "（数字待核）" annotation -
// "unmatched number = flagged, not dropped, not fabricated" (task brief).
// Each raw token string is annotated at most once (first occurrence) - a
// documented simplification: a repeated identical number within one short
// evidence snippet is the rare case, and annotating every instance would
// require token-position bookkeping this module's callers don't need.
function annotateUnmatchedNumbers(text, factValues) {
  const source = String(text ?? "");
  let annotated = source;
  let flaggedCount = 0;
  for (const token of extractNumberTokens(source)) {
    const tolerance = token.kind === "pct" ? PCT_TOLERANCE : PRICE_TOLERANCE;
    const matched = factValues.some((factValue) => Math.abs(factValue - token.value) <= tolerance);
    if (!matched && !annotated.includes(`${token.raw}（数字待核）`)) {
      flaggedCount += 1;
      annotated = annotated.replace(token.raw, `${token.raw}（数字待核）`);
    }
  }
  return { text: annotated, flaggedCount };
}

// ---------------------------------------------------------------------------
// 读取论点与纪律: comparison vs the owner's own theses/disciplines
// ---------------------------------------------------------------------------

// One thesis vs. the quote this run itself fetched: '一致' when the price
// supports the thesis's direction, '冲突' when the price has crossed the
// thesis's OWN stated invalidation level (the clearest, most objective
// signal a thesis is broken), '无法判断' whenever the run doesn't have
// enough first-party data (missing quote, or a thesis with neither target
// nor invalidation price set) to call it either way - never guessed.
function compareThesis(thesis, quotes) {
  const symbol = normalizeSymbol(thesis?.symbol);
  const direction = thesis?.direction;
  const price = quotes[symbol];
  const base = { symbol, direction, ref: thesis?.id ?? null };

  if (price === undefined) {
    return { ...base, verdict: "无法判断", note: "缺少最新行情，暂无法与该论点对照" };
  }

  const invalidationPrice = typeof thesis?.invalidationPrice === "number" ? thesis.invalidationPrice : null;
  const targetLow = typeof thesis?.targetLow === "number" ? thesis.targetLow : null;
  const targetHigh = typeof thesis?.targetHigh === "number" ? thesis.targetHigh : null;

  if (direction === "bull") {
    if (invalidationPrice !== null && price <= invalidationPrice) {
      return { ...base, verdict: "冲突", note: `最新价 ${price} 已触及/跌破止损位 ${invalidationPrice}` };
    }
    if (targetLow !== null && price >= targetLow) {
      return { ...base, verdict: "一致", note: `最新价 ${price} 支持该看多论点` };
    }
  } else if (direction === "bear") {
    if (invalidationPrice !== null && price >= invalidationPrice) {
      return { ...base, verdict: "冲突", note: `最新价 ${price} 已触及/突破止损位 ${invalidationPrice}` };
    }
    if (targetHigh !== null && price <= targetHigh) {
      return { ...base, verdict: "一致", note: `最新价 ${price} 支持该看空论点` };
    }
  }

  return { ...base, verdict: "无法判断", note: "现有数据不足以判定一致或冲突" };
}

// One discipline rule vs. its own近30天 compliance stats (the SAME
// `{sample:'none'} | {sample:'ok', checked, passed, failed}` shape
// computeComplianceStats in apps/platform-app/src/data/strategy.ts
// produces - the memoryReader the worker injects is expected to hand this
// engine that exact shape per rule). Any failed check at all -> '冲突'
// (documented conservative choice: partial compliance is still a
// deviation worth surfacing, not averaged away).
function compareDiscipline(discipline) {
  const stats = discipline?.stats;
  const base = { ruleId: discipline?.ruleId ?? null, ruleText: discipline?.ruleText ?? "" };
  if (!stats || stats.sample !== "ok") {
    return { ...base, verdict: "无法判断", note: "近 30 天无可判定样本" };
  }
  if ((stats.failed ?? 0) > 0) {
    return { ...base, verdict: "冲突", note: `近 30 天 ${stats.checked} 次判定中有 ${stats.failed} 次未遵守` };
  }
  return { ...base, verdict: "一致", note: `近 30 天 ${stats.checked} 次判定全部遵守` };
}

// ---------------------------------------------------------------------------
// 生成研判: confidence + assembly
// ---------------------------------------------------------------------------

// Deterministic, PENALIZED confidence aggregate (task brief - mirrors news-
// agent-search.mjs's buildAnalysis uncertainty tiers, inverted to a
// confidence scale and with an EXTRA penalty this engine's data sources
// need that a pure search module doesn't):
//   - 0 evidence sources -> 'low' (nothing to stand on).
//   - exactly 1 -> 'medium' (single-source corroboration).
//   - >=2 -> 'high' ... UNLESS a documented conflict was found against the
//     owner's own theses/disciplines, OR a resolved symbol's quote could
//     not be fetched at all - either one caps the tier at 'medium': a
//     verdict can be well-evidenced AND still not fully trustworthy when it
//     contradicts the owner's stated invalidation level, or when it is
//     missing the very price data the whole research question was about.
//     Both penalties are capped at 'medium' (never forced further down to
//     'low') - having 2+ real sources is still worth more than having none.
function computeConfidence({ evidenceCount, hasConflict, hasMissingData }) {
  let tier;
  if (evidenceCount === 0) {
    tier = "low";
  } else if (evidenceCount === 1) {
    tier = "medium";
  } else {
    tier = "high";
  }
  if (tier === "high" && (hasConflict || hasMissingData)) {
    tier = "medium";
  }
  return tier;
}

function buildDataTable(quotes) {
  return Object.entries(quotes).map(([symbol, price]) => ({
    label: `${symbol} 最新价`,
    value: price,
    source: "quote.last"
  }));
}

function buildEvidence(evidenceItems) {
  return evidenceItems.map((item, index) => ({
    ref: `E${index + 1}`,
    title: item.title,
    url: item.url,
    publisher: item.publisher,
    rawText: item.rawText
  }));
}

function buildConclusion({ symbols, quotes, evidenceCount, conflictCount }) {
  const parts = [];
  if (symbols.length === 0) {
    parts.push("问题未提及可识别的标的，本次研判仅能给出方向性参考。");
  } else {
    const quoteText = symbols
      .map((symbol) => (quotes[symbol] !== undefined ? `${symbol} 最新价 ${quotes[symbol]}` : `${symbol}（行情缺失）`))
      .join("；");
    parts.push(`已核实标的行情：${quoteText}。`);
  }
  parts.push(evidenceCount > 0 ? `共检索到 ${evidenceCount} 条相关新闻证据。` : "未检索到可用的新闻证据。");
  if (conflictCount > 0) {
    parts.push(`与本人已有论点/纪律存在 ${conflictCount} 处冲突，请留意。`);
  }
  return parts.join(" ");
}

function buildSuggestedAction({ confidence, hasConflict }) {
  if (hasConflict) {
    return "研判与已有论点/纪律存在冲突，建议先复核后再决策，不构成投资建议。";
  }
  if (confidence === "low") {
    return "现有证据不足，建议补充自选标的或等待更多行情/新闻数据后再次研究，不构成投资建议。";
  }
  return "研判仅供参考，不构成投资建议，请结合个人纪律与飞书确认后决策。";
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   question: string,
 *   ownerId: string,
 *   backend: (planned: {query: string, kind: string}) => Promise<{results: object[]}>,
 *   quoteReader: (symbol: string) => Promise<number|undefined> | number | undefined,
 *   memoryReader?: (args: {ownerId: string, symbols: string[]}) => Promise<{theses: object[], disciplines: object[]}>,
 *   budget?: number,
 *   symbolUniverse?: string[],
 *   now?: () => Date,
 *   onStep?: (step: {name: string, status: 'done'|'skipped', detail: string, at: string}) => void
 * }} options
 */
export async function runResearchPipeline({
  question,
  ownerId,
  backend,
  quoteReader,
  memoryReader,
  budget = 8,
  symbolUniverse = [],
  now = () => new Date(),
  onStep
} = {}) {
  const steps = [];
  const skipped = [];

  const record = ({ name, status, detail }) => {
    const timestamp = typeof now === "function" ? now() : new Date();
    const entry = { name, status, detail, at: timestamp.toISOString() };
    steps.push(entry);
    if (status === "skipped") {
      skipped.push({ step: name, reason: detail });
    }
    if (typeof onStep === "function") {
      onStep(entry);
    }
    return entry;
  };

  const title = deriveTitle(question);

  // --- 1. 意图解析 --------------------------------------------------------
  const operationalKeyword = detectOperationalIntent(question);
  if (operationalKeyword) {
    record({
      name: STEP_NAMES.intent,
      status: "done",
      detail: `识别为操作类意图（命中关键词「${operationalKeyword}」），不进入研究管线`
    });
    return {
      status: "failed",
      reason: "operational_intent",
      message: "操作类请走飞书，站内研究仅回答研究性问题。",
      resultJson: null,
      confidence: null,
      title,
      steps,
      skipped,
      budgetSpent: 0
    };
  }

  const symbols = extractSymbols(question, symbolUniverse);
  const topic = extractTopic(question, symbols);
  record({
    name: STEP_NAMES.intent,
    status: "done",
    detail: `识别标的：${symbols.length > 0 ? symbols.join("、") : "无"}；主题：${topic}`
  });

  // --- 2. 拉取行情 ---------------------------------------------------------
  const quotes = {};
  for (const symbol of symbols) {
    let rawPrice;
    try {
      rawPrice = await quoteReader?.(symbol);
    } catch {
      rawPrice = undefined;
    }
    const price = typeof rawPrice === "number" && Number.isFinite(rawPrice) ? rawPrice : undefined;
    if (price === undefined) {
      record({ name: STEP_NAMES.quotes, status: "skipped", detail: `跳过：未找到 ${symbol} 行情` });
    } else {
      quotes[symbol] = price;
      record({ name: STEP_NAMES.quotes, status: "done", detail: `${symbol} 最新价 ${price}` });
    }
  }
  if (symbols.length === 0) {
    record({ name: STEP_NAMES.quotes, status: "skipped", detail: "跳过：问题未提及可识别标的，无法拉取行情" });
  }
  const hasMissingData = symbols.some((symbol) => quotes[symbol] === undefined);

  // --- 3. 检索新闻 ---------------------------------------------------------
  const queries = planResearchQueries({ symbols, topic });
  const search = await executeResearchQueries(backend, queries, budget);
  if (search.noBackend) {
    record({ name: STEP_NAMES.news, status: "skipped", detail: "跳过：未提供检索后端" });
  } else if (search.degraded) {
    record({
      name: STEP_NAMES.news,
      status: "skipped",
      detail: `跳过：检索新闻中断（${search.degradedReason}），已保留 ${search.results.length} 条已获取证据`
    });
  } else if (search.results.length === 0) {
    record({ name: STEP_NAMES.news, status: "skipped", detail: "跳过：未检索到可用的新闻证据" });
  } else {
    record({
      name: STEP_NAMES.news,
      status: "done",
      detail: `检索到 ${search.results.length} 条新闻证据（用去 ${search.callsUsed} 次调用）`
    });
  }

  // --- 4. 读取论点与纪律 ----------------------------------------------------
  // `memoryReader` is expected to already be scope-bound to `ownerId` by the
  // WORKER (Task 3) before it is ever handed to this engine - see module
  // header. This engine forwards `ownerId` as a plain argument only; it
  // never derives/widens a scope itself.
  let theses = [];
  let disciplines = [];
  if (typeof memoryReader !== "function") {
    record({ name: STEP_NAMES.memory, status: "skipped", detail: "跳过：未提供论点/纪律读取器" });
  } else {
    let memory;
    try {
      memory = await memoryReader({ ownerId, symbols });
    } catch (error) {
      memory = null;
      record({
        name: STEP_NAMES.memory,
        status: "skipped",
        detail: `跳过：读取论点/纪律失败（${String(error?.message ?? error)}）`
      });
    }
    if (memory) {
      theses = Array.isArray(memory.theses) ? memory.theses : [];
      disciplines = Array.isArray(memory.disciplines) ? memory.disciplines : [];
      if (theses.length === 0 && disciplines.length === 0) {
        record({ name: STEP_NAMES.memory, status: "skipped", detail: "跳过：未找到本人论点或纪律记录" });
      } else {
        record({
          name: STEP_NAMES.memory,
          status: "done",
          detail: `读到 ${theses.length} 条论点、${disciplines.length} 条纪律记录`
        });
      }
    }
  }

  const comparison = {
    theses: theses.map((thesis) => compareThesis(thesis, quotes)),
    disciplines: disciplines.map((discipline) => compareDiscipline(discipline))
  };
  const conflicts = [...comparison.theses, ...comparison.disciplines].filter((entry) => entry.verdict === "冲突");
  const hasConflict = conflicts.length > 0;

  // --- 5. 数字校验 ---------------------------------------------------------
  const factValues = Object.values(quotes).filter((value) => typeof value === "number");
  const numericScan = search.results.map((item) => annotateUnmatchedNumbers(item.summary_zh || item.title, factValues));
  const totalFlagged = numericScan.reduce((sum, entry) => sum + entry.flaggedCount, 0);
  record({
    name: STEP_NAMES.numeric,
    status: "done",
    detail:
      totalFlagged > 0
        ? `${totalFlagged} 个证据数字未匹配行情/事实数据，已标记「数字待核」`
        : "证据中的数字均在容差范围内匹配行情/事实数据"
  });

  // --- 6. 生成研判 ---------------------------------------------------------
  const evidence = buildEvidence(search.results);
  const keyPoints = search.results.map((item, index) => ({
    text: numericScan[index].text,
    evidenceRefs: [`E${index + 1}`]
  }));
  const dataTable = buildDataTable(quotes);
  const confidence = computeConfidence({ evidenceCount: search.results.length, hasConflict, hasMissingData });
  const conclusion = buildConclusion({ symbols, quotes, evidenceCount: search.results.length, conflictCount: conflicts.length });
  const suggestedAction = buildSuggestedAction({ confidence, hasConflict });

  record({ name: STEP_NAMES.verdict, status: "done", detail: `研判生成完成，置信度：${confidence}` });

  const resultJson = {
    conclusion,
    confidence,
    keyPoints,
    dataTable,
    comparison,
    suggestedAction,
    evidence,
    skipped
  };

  return {
    status: search.degraded ? "degraded" : "done",
    resultJson,
    confidence,
    title,
    steps,
    skipped,
    budgetSpent: search.callsUsed
  };
}

// ---------------------------------------------------------------------------
// P10 wiring point
// ---------------------------------------------------------------------------

// Real backend implementation is OUT OF SCOPE for this task (明确不做:
// "真实 OpenClaw 受限 agent 网关 + 真检索 + 搜索配额实测（P10）"). Mirrors
// news-agent-search.mjs's createOpenclawSearchBackend exactly: callers
// (Task 3's worker) can already wire in the SHAPE of the real backend today
// while the function it returns simply throws until P10 stands up the real
// restricted no-shell OpenClaw gateway and its search-quota measurement.
// Every test in research-engine.test.ts instead injects a fake backend;
// this placeholder is never exercised by a passing test path other than
// asserting it throws.
export function createResearchBackend() {
  return async function researchBackend() {
    throw new Error(
      "research agent backend requires P10 ignition (restricted no-shell OpenClaw gateway + search quota measurement)"
    );
  };
}
