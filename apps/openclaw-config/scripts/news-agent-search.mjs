// L2/L3 restricted-agent search orchestration - Phase 4 Task 5.
//
// This module is the ONLY place that plans/paces/validates calls into a
// budget-bounded, injectable "restricted agent search backend" for two
// report-time jobs:
//   - L2 topic search (runL2TopicSearch): one query per tracked symbol plus a
//     macro/industry minimum, used by both daily (budget<=30) and weekly
//     (budget<=60) reports (Global Constraints).
//   - L3 deep dive (runL3DeepDive): cross-verification of the highest-impact
//     clustered events (news-engine.mjs's `event` shape, Task 3), OFF by
//     default for the daily report (07-07 decision) and only turned on by the
//     weekly caller (`enabled: true, perEventBudget: 8`).
//
// Neither function ever calls a real network/agent itself - `searchBackend`
// is always injected by the caller as
//   async ({ query, kind }) => ({ results: [{ title, publisher, url,
//     publishedAt, summary_zh, impact, evidence_quote }, ...] })
// so every test in news-agent-search.test.ts drives a fake backend with zero
// real network/agent calls, and the one REAL backend
// (createOpenclawSearchBackend, bottom of this file) is left as a documented
// P10 wiring point until the real OpenClaw restricted-agent gateway and its
// search-quota measurement exist.
//
// ---------------------------------------------------------------------------
// Anti-injection rationale (why raw external text is quarantined, not just
// defused)
// ---------------------------------------------------------------------------
// A restricted search backend returns text written by whoever published the
// underlying article/page - i.e. untrusted, potentially adversarial input.
// This module defends against it on two independent axes:
//   1. Content that will be RENDERED (title/summary_zh/evidence_quote/
//      impact.reason) is passed through Task 1's defuseMarkdownInText so it
//      can never smuggle a live `[text](url)` markdown link into either
//      rendering face (PDF/report-rendering.mjs, platform markdown.ts).
//   2. The raw, pre-defuse text is ALSO preserved verbatim for audit, but
//      only inside a dedicated `rawText` field wrapped in the delimiters
//      `<<<EXTERNAL_UNTRUSTED>>>...<<<END_EXTERNAL>>>`. This is the same
//      "quote untrusted data with an unambiguous boundary" pattern used to
//      defend LLM agents against prompt injection: the delimiters make it
//      structurally obvious - to a human reader or to any later LLM-based
//      consumer of this module's output - that everything between them is
//      DATA to look at, never INSTRUCTIONS to follow.
//   Critically, `rawText` is a dead end: nothing in this module (or its
//   callers, Task 7) ever reads `rawText` back in to decide what to search
//   next. L2's query plan is fully determined up front from `symbols`/
//   `l1Titles` (both first-party, trusted inputs); L3's per-event query plan
//   is derived only from the event's OWN clusterKey/titleZh/impact (produced
//   by news-engine.mjs from OUR OWN L1 clustering, Task 3) - never from a
//   prior L2/L3 backend response. External text therefore never participates
//   in tool/query selection, which is the actual injection vector this
//   design closes off; defusing merely closes the (secondary) markdown-link
//   rendering vector.
//
// Article/event shapes referenced here:
//   - `event` (news-engine.mjs's buildEventFromCluster output): { clusterKey,
//     titleZh, summaryZh, impact: {direction, affected, reason},
//     firstPublishedAt, lastPublishedAt, sources }.
//   - validated L2/L3 result item (this module's output, Global Constraints'
//     L2 schema): { title, publisher, url, publishedAt (ISO|null), summary_zh,
//     impact: {direction, affected, reason}, evidence_quote, rawText }.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { defuseMarkdownInText } from "./report-news.mjs";
import { normalizeSymbol } from "./report-data.mjs";
import { createGatewayClient, extractResultsArray, parseSmokeArgs, runSmoke } from "./_openclaw-gateway.mjs";

const VALID_DIRECTIONS = new Set(["bullish", "bearish", "neutral", "unknown"]);

const EXTERNAL_TEXT_PREFIX = "<<<EXTERNAL_UNTRUSTED>>>";
const EXTERNAL_TEXT_SUFFIX = "<<<END_EXTERNAL>>>";

// ---------------------------------------------------------------------------
// Shared: one raw backend result item -> validated/sanitized item, or dropped
// ---------------------------------------------------------------------------

function hasCjk(value) {
  return /[㐀-鿿]/u.test(String(value ?? ""));
}

// Coerces a backend-supplied `impact` field into the Global Constraints shape
// no matter what the (untrusted) backend actually sent - an unknown/missing
// direction degrades to 'unknown' (never thrown away or crashed on), and
// affected/reason are defensively coerced to the expected types. This is NOT
// one of the two hard-drop conditions (missing url / non-Chinese summary) -
// per the task brief only those two drop the whole item; a malformed impact
// sub-object is repaired in place instead.
function coerceImpact(rawImpact) {
  const impact = rawImpact && typeof rawImpact === "object" ? rawImpact : {};
  const direction = VALID_DIRECTIONS.has(impact.direction) ? impact.direction : "unknown";
  const affected = Array.isArray(impact.affected) ? impact.affected.map(String) : [];
  const reason = impact.reason ? defuseMarkdownInText(String(impact.reason)) : null;
  return { direction, affected, reason };
}

// `publishedAt` is honestly nullable - "parseable or null (never now)": an
// unparseable/missing value must NEVER be fabricated as Date.now(), matching
// the #31 audit-fix rule report-news.mjs/news-engine.mjs already follow for
// L1 articles.
function parsePublishedAt(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const ts = new Date(String(value)).getTime();
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

// Builds the audit-only `rawText` field - see the module header's
// "Anti-injection rationale". Deliberately readable plain text (not JSON) so
// a human skimming a report's audit trail can read it directly; the
// delimiters are what matters for the "this is data, not instructions"
// signal, not the internal formatting.
function wrapExternalText(rawItem) {
  const parts = [
    `title: ${String(rawItem?.title ?? "")}`,
    `summary_zh: ${String(rawItem?.summary_zh ?? "")}`,
    `evidence_quote: ${String(rawItem?.evidence_quote ?? "")}`
  ].join(" | ");
  return `${EXTERNAL_TEXT_PREFIX}${parts}${EXTERNAL_TEXT_SUFFIX}`;
}

// Validates one raw backend result item against the L2 schema (Global
// Constraints: `{title, publisher, url, publishedAt, summary_zh,
// impact:{direction,affected,reason}, evidence_quote}`). Returns
// `{ item }` on success or `{ dropped: 'no_url' | 'not_chinese' }` on
// rejection - the two hard-drop conditions named in the task brief:
//   - no `url` at all -> dropped, counted as droppedNoUrl.
//   - `summary_zh` missing/without a single CJK character -> dropped,
//     counted as droppedNotChinese (a purely English/other-script summary
//     cannot satisfy "summary_zh").
// Every other field is defensively coerced rather than dropped (see
// coerceImpact above), and title/summary_zh/evidence_quote/impact.reason -
// every field this module lets a report render - are funneled through
// defuseMarkdownInText (Task 1 #29) before this function returns.
function validateResultItem(rawItem) {
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
    impact: coerceImpact(rawItem?.impact),
    evidence_quote: defuseMarkdownInText(String(rawItem?.evidence_quote ?? "").trim()),
    rawText: wrapExternalText(rawItem)
  };
  return { item };
}

// ---------------------------------------------------------------------------
// Shared: paced execution of a query plan against a budget
// ---------------------------------------------------------------------------

// Executes `queries` (an array of `{query, kind}`) against `searchBackend`
// one at a time, in order, never issuing more than `budget` calls total -
// "each backend call decrements [the budget]; call N+1 when budget exhausted
// -> NOT attempted (loop stops)". The check happens BEFORE each call, so the
// (budget+1)-th planned query is never sent to the backend at all (not
// attempted, not counted) - this is what makes "31st call never attempted"
// exact rather than approximate.
//
// Degradation contract (task brief): if `searchBackend` THROWS for any
// query, this stops issuing further calls immediately and reports
// `degraded: true` with the thrown message - whatever results were already
// validated from earlier, successful calls in this same run are kept
// (`results` is never reset). Running out of budget is explicitly NOT
// degradation - it is normal, expected completion of a bounded plan - so the
// budget-exhaustion break path above never touches `degraded`.
//
// A call that itself throws still consumes one unit of budget (it WAS
// attempted - "each backend call decrements" is unconditional on the
// call's outcome), which is why `callsUsed` is incremented before the
// backend is actually invoked, not after a successful resolution.
async function executeQueries(searchBackend, queries, budget) {
  const list = Array.isArray(queries) ? queries : [];
  const safeBudget = Math.max(0, Number(budget) || 0);

  const results = [];
  let callsUsed = 0;
  let droppedNoUrl = 0;
  let droppedNotChinese = 0;
  let degraded = false;
  let degradedReason = null;

  for (const plannedQuery of list) {
    if (callsUsed >= safeBudget) {
      break;
    }
    callsUsed += 1;

    let response;
    try {
      response = await searchBackend(plannedQuery);
    } catch (error) {
      degraded = true;
      degradedReason = String(error?.message ?? error);
      break;
    }

    const rawResults = Array.isArray(response?.results) ? response.results : [];
    for (const rawItem of rawResults) {
      const outcome = validateResultItem(rawItem);
      if (outcome.dropped === "no_url") {
        droppedNoUrl += 1;
      } else if (outcome.dropped === "not_chinese") {
        droppedNotChinese += 1;
      } else if (outcome.item) {
        results.push(outcome.item);
      }
    }
  }

  return { results, callsUsed, droppedNoUrl, droppedNotChinese, degraded, degradedReason };
}

// ---------------------------------------------------------------------------
// L2 topic search: planner + entry point
// ---------------------------------------------------------------------------

// A tiny, deterministic set of industry/topic keywords this planner can spot
// inside L1 titles to flavor the (always-present) industry query - NOT a
// general NLP keyword extractor, just enough to let `l1Titles` have a real,
// observable effect on the plan (first match wins, so output is stable for a
// stable input) without making the planner's output depend on anything other
// than its own arguments.
const INDUSTRY_KEYWORDS = ["人工智能", "半导体", "芯片", "云计算", "新能源", "医药", "消费电子", "AI"];

function extractIndustryKeyword(l1Titles) {
  const text = (Array.isArray(l1Titles) ? l1Titles : []).join(" ");
  return INDUSTRY_KEYWORDS.find((term) => text.includes(term)) ?? null;
}

// Second macro query's industry phrase: primarily derived from the tracked
// symbol list (per the task brief: "行业主题 derived from symbols") - the
// first up-to-3 symbols, in the order given - optionally sharpened with an
// industry keyword actually seen in `l1Titles` when one is present. Both
// inputs are first-party/trusted (the tracked-symbol pool and our own L1
// collection's titles), so this stays inside the "external text never drives
// query selection" rule from the module header.
function deriveIndustryQuery(symbolList, l1Titles) {
  const keyword = extractIndustryKeyword(l1Titles);
  const symbolPhrase = symbolList.slice(0, 3).join("、") || "美股科技板块";
  return keyword
    ? `${symbolPhrase} ${keyword} 行业动态 最新消息`
    : `${symbolPhrase} 行业动态 最新消息`;
}

// Builds the L2 query plan and trims it to `budget`.
//
// PRIORITY RULE (documented per the task brief - "symbols first, macro
// minimum preserved"):
//   - Symbol queries occupy the FRONT of the plan (executed/attempted before
//     the macro queries) - covering the tracked, specific tickers takes
//     precedence in ORDER.
//   - The two macro queries are a RESERVED MINIMUM: `Math.min(2, budget)`
//     slots are set aside for them before any symbol query is admitted, so a
//     tight budget trims SYMBOL queries down (never macro queries) to make
//     room. Symbols are what gets sacrificed when budget is scarce, not
//     macro coverage - macro/宏观 context (Fed policy, industry-wide themes)
//     is judged too broadly relevant to ever drop to zero while ANY budget
//     remains, whereas an individual missing per-symbol query is a smaller,
//     more localized gap.
//   - Edge case: when budget itself is below 2 (e.g. budget=1), the macro
//     reservation can only ever secure `budget` slots, so symbols get 0 and
//     only the highest-priority macro query survives - with a single call
//     available for an entire report, a single broad query is judged more
//     useful than one arbitrary symbol out of many.
// This keeps the trim fully deterministic given the same
// (symbols, l1Titles, budget) inputs - no randomness, no dependency on
// anything but the arguments themselves.
function planL2Queries({ symbols, l1Titles, budget }) {
  const symbolList = Array.from(
    new Set((Array.isArray(symbols) ? symbols : []).map((symbol) => normalizeSymbol(symbol)).filter(Boolean))
  );

  const symbolQueries = symbolList.map((symbol) => ({
    query: `${symbol} 最新消息 财报 监管`,
    kind: "symbol"
  }));

  const macroQueries = [
    { query: "美联储 利率 宏观经济 最新消息", kind: "macro" },
    { query: deriveIndustryQuery(symbolList, l1Titles), kind: "macro" }
  ];

  const idealSize = symbolQueries.length + macroQueries.length;
  const safeBudget = Math.max(0, Number(budget) || 0);

  const macroReserve = Math.min(macroQueries.length, safeBudget);
  const symbolBudget = Math.max(0, safeBudget - macroReserve);

  const plan = [...symbolQueries.slice(0, symbolBudget), ...macroQueries.slice(0, macroReserve)];
  return { plan, idealSize };
}

// Runs an L2 topic search: one planned query per tracked symbol plus the
// macro/industry minimum (see planL2Queries), executed one call at a time
// against `searchBackend` up to `budget` total calls, with every returned
// item schema-validated/sanitized (validateResultItem).
//
// @param {{
//   searchBackend: (planned: {query:string, kind:string}) => Promise<{results: any[]}>,
//   budget?: number, symbols?: string[], l1Titles?: string[]
// }} options
// @returns {{
//   results: object[], queries: {query:string, kind:string}[],
//   callsUsed: number, budgetExhausted: boolean,
//   droppedNoUrl: number, droppedNotChinese: number,
//   degraded: boolean, degradedReason: string|null
// }}
export async function runL2TopicSearch({ searchBackend, budget, symbols = [], l1Titles = [] } = {}) {
  const safeBudget = Math.max(0, Number(budget) || 0);
  const { plan, idealSize } = planL2Queries({ symbols, l1Titles, budget: safeBudget });

  const execution = await executeQueries(searchBackend, plan, safeBudget);

  return {
    results: execution.results,
    queries: plan,
    callsUsed: execution.callsUsed,
    // Budget exhaustion is judged against the IDEAL (untrimmed) plan size,
    // not against whether the (already-trimmed-to-fit) plan finished - by
    // construction plan.length <= safeBudget always, so this is the only
    // source of "we wanted to search more than the budget allowed" signal.
    budgetExhausted: idealSize > safeBudget,
    droppedNoUrl: execution.droppedNoUrl,
    droppedNotChinese: execution.droppedNotChinese,
    degraded: execution.degraded,
    degradedReason: execution.degradedReason
  };
}

// ---------------------------------------------------------------------------
// L3 deep dive: impact scoring + planner + entry point
// ---------------------------------------------------------------------------

// Simple, deterministic impact score used to pick which clustered events are
// worth an (expensive) L3 deep dive: `2 points per affected tracked symbol +
// 1 point if the direction is anything other than 'unknown'`. This favors
// events that (a) are known to touch more of the tracked portfolio and (b)
// already have SOME directional read (bullish/bearish/neutral all count -
// only 'unknown' scores zero for this term), over events that are broad but
// undirected. Ties are broken deterministically (never by input array order)
// by more-recent `lastPublishedAt` first, then by `clusterKey` ascending.
function impactScore(event) {
  const affectedCount = Array.isArray(event?.impact?.affected) ? event.impact.affected.length : 0;
  const directionKnown = event?.impact?.direction && event.impact.direction !== "unknown" ? 1 : 0;
  return affectedCount * 2 + directionKnown;
}

function selectTopEventsByImpact(events, maxEvents) {
  const list = Array.isArray(events) ? events.filter(Boolean) : [];
  const scored = list.map((event) => ({ event, score: impactScore(event) }));

  scored.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    const leftTime = left.event?.lastPublishedAt ? Date.parse(left.event.lastPublishedAt) : -Infinity;
    const rightTime = right.event?.lastPublishedAt ? Date.parse(right.event.lastPublishedAt) : -Infinity;
    if (rightTime !== leftTime) {
      return rightTime - leftTime;
    }
    return String(left.event?.clusterKey ?? "").localeCompare(String(right.event?.clusterKey ?? ""));
  });

  return scored.slice(0, Math.max(0, Number(maxEvents) || 0)).map((entry) => entry.event);
}

function deriveEventTopic(event) {
  return String(event?.titleZh ?? event?.clusterKey ?? "").trim() || "相关事件";
}

// Builds one event's per-query plan, split into `evidenceQueries` (topic +
// one per affected symbol) and `counterEvidence` query(ies), both bounded so
// their COMBINED length never exceeds `perEventBudget` ("Per event <=
// perEventBudget backend calls"). Same reserved-minimum pattern as
// planL2Queries's macro reservation: exactly 1 slot is reserved for the
// counter-evidence query whenever any budget at all is available, so
// `counterEvidence` can be a truthful 'not_found' (the query WAS attempted
// and came back empty) rather than merely un-asked - evidence queries fill
// whatever budget remains after that reservation.
function planL3Queries(event, perEventBudget) {
  const budget = Math.max(0, Number(perEventBudget) || 0);
  const topic = deriveEventTopic(event);
  const affected = Array.isArray(event?.impact?.affected) ? event.impact.affected : [];

  const evidenceCandidates = [
    { query: `${topic} 最新进展 核实`, kind: "evidence" },
    ...affected.map((symbol) => ({ query: `${symbol} ${topic} 影响`, kind: "evidence" }))
  ];
  const counterCandidate = { query: `${topic} 反驳 质疑 辟谣`, kind: "counter_evidence" };

  const counterReserve = budget >= 1 ? 1 : 0;
  const evidenceBudget = Math.max(0, budget - counterReserve);

  return {
    evidenceQueries: evidenceCandidates.slice(0, evidenceBudget),
    counterQueries: counterReserve > 0 ? [counterCandidate] : []
  };
}

// Deterministic uncertainty read for one event's L3 analysis:
//   - no corroborating evidence at all -> 'high' (nothing to stand on).
//   - corroborating evidence exists but a counter-evidence item was also
//     found -> 'high' (there IS a documented conflicting account).
//   - exactly one corroborating item and no counter-evidence -> 'medium'
//     (single-source corroboration).
//   - two or more corroborating items and no counter-evidence -> 'low'.
function buildAnalysis(event, evidenceItems, counterEvidence) {
  const direction = VALID_DIRECTIONS.has(event?.impact?.direction) ? event.impact.direction : "unknown";
  const hasCounter = Array.isArray(counterEvidence) && counterEvidence.length > 0;

  let uncertainty;
  if (evidenceItems.length === 0) {
    uncertainty = "high";
  } else if (hasCounter) {
    uncertainty = "high";
  } else if (evidenceItems.length === 1) {
    uncertainty = "medium";
  } else {
    uncertainty = "low";
  }

  return { direction, uncertainty };
}

// Runs the L3 deep dive: top `maxEvents` clustered events by impact score,
// each cross-verified with up to `perEventBudget` backend calls (topic
// evidence + a mandatory counter-evidence query).
//
// `enabled` defaults to `false` - the 07-07 binding decision is "L3 日报默认
// 关" (L3 OFF by default for the daily report); the weekly caller is the one
// that opts in with `enabled: true, perEventBudget: 8`. When disabled this
// returns EXACTLY `{ skipped: true, reason: 'l3_disabled_daily' }` and never
// touches `searchBackend`.
//
// Degradation: identical contract to runL2TopicSearch - a `searchBackend`
// throw stops ALL further calls (remaining queries for the current event AND
// any events not yet processed) immediately, `degraded: true` is set, and
// whatever event results were already built are kept in `events`.
//
// @param {{
//   searchBackend: (planned: {query:string, kind:string}) => Promise<{results: any[]}>,
//   events?: object[], perEventBudget?: number, maxEvents?: number, enabled?: boolean
// }} options
export async function runL3DeepDive({ searchBackend, events = [], perEventBudget = 5, maxEvents = 3, enabled = false } = {}) {
  if (!enabled) {
    return { skipped: true, reason: "l3_disabled_daily" };
  }

  const selected = selectTopEventsByImpact(events, maxEvents);

  const results = [];
  let callsUsed = 0;
  let droppedNoUrl = 0;
  let droppedNotChinese = 0;
  let degraded = false;
  let degradedReason = null;

  for (const event of selected) {
    const { evidenceQueries, counterQueries } = planL3Queries(event, perEventBudget);

    const evidenceExecution = await executeQueries(searchBackend, evidenceQueries, evidenceQueries.length);
    callsUsed += evidenceExecution.callsUsed;
    droppedNoUrl += evidenceExecution.droppedNoUrl;
    droppedNotChinese += evidenceExecution.droppedNotChinese;

    let counterExecution = { results: [], callsUsed: 0, droppedNoUrl: 0, droppedNotChinese: 0, degraded: false, degradedReason: null };
    if (!evidenceExecution.degraded) {
      counterExecution = await executeQueries(searchBackend, counterQueries, counterQueries.length);
      callsUsed += counterExecution.callsUsed;
      droppedNoUrl += counterExecution.droppedNoUrl;
      droppedNotChinese += counterExecution.droppedNotChinese;
    }

    const counterEvidence = counterExecution.results.length > 0 ? counterExecution.results : "not_found";
    results.push({
      eventClusterKey: event?.clusterKey ?? null,
      evidence: evidenceExecution.results,
      analysis: buildAnalysis(event, evidenceExecution.results, counterEvidence),
      counterEvidence
    });

    if (evidenceExecution.degraded || counterExecution.degraded) {
      degraded = true;
      degradedReason = evidenceExecution.degradedReason ?? counterExecution.degradedReason;
      break;
    }
  }

  return { events: results, callsUsed, droppedNoUrl, droppedNotChinese, degraded, degradedReason };
}

// ---------------------------------------------------------------------------
// P10 wiring: real restricted-agent search backend (live OpenClaw gateway)
// ---------------------------------------------------------------------------

// One L2/L3 search call's latency budget (task brief: search ≤120s).
const SEARCH_TIMEOUT_MS = 120000;

// System instruction: this lane runs ONE web-search-and-summarize turn per
// query and MUST return a JSON array in exactly the L2 schema every function
// in this module already validates (validateResultItem). Two anti-fabrication
// rules are load-bearing: honest empty (`[]`) when nothing is found, and never
// a made-up url — validateResultItem hard-drops any item lacking a url, so an
// invented item would simply vanish, but the instruction keeps the model from
// wasting the turn on fiction.
const SEARCH_SYSTEM = [
  "你是受限的中文财经检索助手：针对给定查询做一次真实的网络检索，并把结果整理为 JSON 数组返回。",
  "只返回一个 JSON 数组（不要 Markdown、不要代码块、不要任何解释文字）。数组每个元素形如：",
  '{"title": "标题", "publisher": "来源媒体", "url": "真实文章链接", "publishedAt": "ISO8601 时间或 null", "summary_zh": "中文摘要", "impact": {"direction": "bullish|bearish|neutral|unknown", "affected": ["受影响标的代码"], "reason": "中文影响说明"}, "evidence_quote": "原文关键引述"}',
  "硬性规则：",
  "1. url 必须是检索到的真实链接，严禁编造；summary_zh 必须是中文。",
  "2. 若没有检索到任何可靠结果，返回空数组 []，不要编造条目。",
  "3. 不要输出数组以外的任何字符。"
].join("\n");

function buildSearchPrompt({ query, kind }) {
  return [`检索意图类别：${kind ?? "topic"}`, `查询：${query ?? ""}`, "请检索并按系统指定的 JSON 数组格式返回结果。"].join("\n");
}

// Real search backend, wired to the live gateway via the shared client.
// Callers (scheduled-report.mjs) already inject this as `searchBackend`;
// production wiring lights up automatically. Tests inject `{ client }` so no
// network is touched. The gateway text is parsed to a results array
// (extractResultsArray): a valid empty array is an honest "no news" (never a
// throw), while an unparseable reply throws — which executeQueries treats as a
// degrade (stops issuing further calls, keeps partial results). Individual
// items are then schema-validated/defused by validateResultItem downstream, so
// this backend never needs to sanitize or fabricate.
export function createOpenclawSearchBackend(options = {}) {
  const client = options.client || createGatewayClient(options);
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;
  return async function openclawSearchBackend({ query, kind }) {
    const text = await client.complete({ prompt: buildSearchPrompt({ query, kind }), system: SEARCH_SYSTEM, timeoutMs });
    return { results: extractResultsArray(text) };
  };
}

// ---------------------------------------------------------------------------
// Smoke entrypoint: `node news-agent-search.mjs smoke [--query "..."] [--kind symbol]`
// One real gateway call — the controller runs this on the mini.
// ---------------------------------------------------------------------------
const isMainModule = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (isMainModule && process.argv[2] === "smoke") {
  const args = parseSmokeArgs(process.argv.slice(3));
  const query = typeof args.query === "string" ? args.query : "AAPL.US 最新消息 财报 监管";
  const kind = typeof args.kind === "string" ? args.kind : "symbol";
  const backend = createOpenclawSearchBackend();
  await runSmoke("news-agent-search", () => backend({ query, kind }));
}
