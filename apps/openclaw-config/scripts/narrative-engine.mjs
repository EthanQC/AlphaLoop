// Phase 5 Task 3 (2026-07-15 plan): LLM 叙事编排层 - the optional narrative
// enhancement layer sitting ON TOP of buildDeterministicAnalysis's
// deterministic per-section text (stock-analysis.mjs), following the SAME
// injectable-backend/budget-free/degrade-honestly shape Phase 4 Task 5
// established for restricted-agent search (news-agent-search.mjs):
//   - the real backend is a documented, P10-gated throw
//     (createNarrativeLlmBackend, bottom of this file) - every test in
//     narrative-engine.test.ts injects a fake backend instead.
//   - external/LLM-produced text is defused (defuseMarkdownInText,
//     report-news.mjs #29) before it is ever adopted for rendering.
//   - the backend's output NEVER drives what gets asked next - each of the
//     8 sections is called with a FIXED, pre-determined
//     {symbol, sectionKey, deterministicText} derived entirely from
//     buildDeterministicAnalysis's own first-party output; nothing here
//     branches on backend content to decide which section/query to try
//     next (mirrors news-agent-search.mjs's header rationale: the backend's
//     prose is rendered, never used for tool/query selection).
//
// This module adds ONE more defense specific to a *narrative* backend that
// news-agent-search.mjs's search backend didn't need: a NUMERIC PRE-CHECK.
// A restricted search backend's output is disclosed as EXTERNAL/untrusted
// evidence (quoted, sourced, never asserted as our own fact); a narrative
// backend's output is instead meant to REPLACE our own deterministic prose
// for a report section - so any number it states must be traceable to the
// SAME stock_facts ground truth report-quality.mjs's facts.numeric_match
// gate (Task 4) checks against, or the report would ship an LLM-fabricated
// number formatted exactly like a fact. This module is the FIRST line of
// defense (retry-then-degrade, before the report is ever assembled); Task 4's
// gate is the fail-loud last line of defense at delivery time.

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { defuseMarkdownInText } from "./report-news.mjs";
import { createGatewayClient, parseSmokeArgs, runSmoke } from "./_openclaw-gateway.mjs";

// ---------------------------------------------------------------------------
// Constants (all documented, spec-fixed per the 2026-07-15 plan)
// ---------------------------------------------------------------------------

// Same CJK range news-agent-search.mjs's hasCjk uses (CJK Unified Ideographs,
// U+3400-U+9FFF) - kept as a LOCAL copy (not imported) because this module
// needs to COUNT occurrences (ratio), not just test presence, and re-using a
// non-exported helper across files would create a needless coupling for one
// regex literal.
const CJK_CHAR_PATTERN = /[㐀-鿿]/gu;

// "Mostly Chinese" threshold for one section's backend output: CJK
// characters must be >= 30% of the text's CONTENT characters (see
// computeCjkRatio below for what counts as "content"). Chosen to match the
// SAME 30% floor report-quality.mjs's news.chinese_ratio gate already uses
// for a related-but-distinct concept (Chinese-language share across
// multi-source news items) - one number for "mostly Chinese" across this
// codebase, not two independently-tuned thresholds for a similar idea.
const CJK_RATIO_THRESHOLD = 0.3;

// Punctuation/whitespace stripped out before computing the CJK ratio - ASCII
// and full-width punctuation are language-neutral (a period doesn't count
// AGAINST "content"), so ratio is computed over actual word/character
// content only, per the task brief's "CJK 占比阈值...content" framing.
const NON_CONTENT_PATTERN = /[\s　.,!?;:()[\]{}'"\-—、，。！？；：（）【】“”‘’·…/\\]/gu;

// Numeric pre-check tolerances - IDENTICAL values to report-quality.mjs's
// validateNarrativeNumbers ("百分比 ±0.1 / 价格 ±0.01", Global Constraints).
// See this file's header + findUnmatchedNumber's own comment for how the
// MATCHING approach here deliberately diverges from validateNarrativeNumbers
// (phrase-anchored regexes per known fact key) - the tolerance SEMANTICS are
// what's reused, not the extraction mechanism.
const PCT_TOLERANCE = 0.1;
const PRICE_TOLERANCE = 0.01;

// "重生成 ≤2 次仍失败" - up to 2 RETRIES after the initial attempt, i.e. at
// most 3 total backend calls per section (attempt indices 0, 1, 2 below).
const MAX_RETRIES_PER_SECTION = 2;

// Per-section degrade markers appended INSIDE that section's own fallback
// text (only reached when the backend itself did NOT throw, but its output
// failed validation on every attempt) - distinct from the GLOBAL degrade
// disclosure (REPORT_DEGRADED_HEADER) a backend THROW produces, which the
// caller (stock-analysis.mjs) renders once per symbol, not per section.
//
// Exported (Phase 5 Task 4, 2026-07-15 plan): report-quality.mjs's
// stock.numeric_match gate (validateStockNarrativeNumbers) needs to
// recognize a locally-degraded "### ..." block by this SAME literal text so
// it can skip re-scanning deterministic fallback prose for facts-derived (but
// not literally fact-value) numbers - importing the two exact strings here
// keeps that a single source rather than a second, independently-typed copy
// of the same marker text.
export const NUMERIC_DEGRADE_MARKER = "（叙事降级：数字比对未通过）";
export const NON_CHINESE_DEGRADE_MARKER = "（叙事降级：后端输出非中文）";

// Caller-facing header line for a GLOBAL degrade (backend threw) - exported
// so stock-analysis.mjs (and its tests) reference the exact same literal
// rather than re-typing it, matching conclusion-box.mjs's "single source for
// the exact string" convention.
export const REPORT_DEGRADED_HEADER = "叙事引擎不可用（纯事实表报告）";

// ---------------------------------------------------------------------------
// CJK ratio check
// ---------------------------------------------------------------------------

function computeCjkRatio(text) {
  const contentOnly = String(text ?? "").replace(NON_CONTENT_PATTERN, "");
  if (contentOnly.length === 0) {
    // Empty/whitespace-only/all-punctuation output cannot satisfy "mostly
    // Chinese" - ratio is honestly 0, never a divide-by-zero NaN treated as
    // passing.
    return 0;
  }
  const cjkCount = (contentOnly.match(CJK_CHAR_PATTERN) ?? []).length;
  return cjkCount / contentOnly.length;
}

function isMostlyChinese(text) {
  return computeCjkRatio(text) >= CJK_RATIO_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Numeric pre-check
// ---------------------------------------------------------------------------

// ISO calendar dates (YYYY-MM-DD) appear in deterministic text as VALUE-TEXT
// facts (e.g. options.nextExpiry, a string, never a stock_facts.value_num) -
// masking them out before number-token extraction avoids three false
// "unmatched number" failures (year/month/day parsed as three separate
// bogus tokens) over a date that was never meant to be checked against
// value_num at all. Documented divergence from validateNarrativeNumbers
// (report-quality.mjs), which never encounters this because its
// phrase-anchored patterns are keyed to specific non-date fact phrases.
const ISO_DATE_PATTERN = /\d{4}-\d{2}-\d{2}/gu;

// A "number token": optional leading minus, digits with optional
// thousands-separator commas, optional decimal part. Deliberately generic
// (not anchored to any phrase) - see this module's header for why: a
// narrative backend's phrasing is not fixed like the daily/weekly report's
// own fixed bullet templates, so unlike validateNarrativeNumbers this cannot
// key off a small fixed set of phrase patterns. Every number the backend
// states must independently prove itself against the facts table.
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
    // A number immediately followed by '%' (optionally with one space, e.g.
    // "12.3 %") uses the tighter PCT_TOLERANCE; every other number (price,
    // market cap, EPS, etc.) uses PRICE_TOLERANCE - same "pct-adjacent vs.
    // price" split validateNarrativeNumbers' NUMERIC_MATCH_PATTERNS encode
    // via each pattern's own `kind`, just decided structurally here instead
    // of per-fixed-phrase.
    const rest = withoutDates.slice(match.index + raw.length);
    const isPercentAdjacent = /^\s?%/u.test(rest);
    tokens.push({ raw, value, kind: isPercentAdjacent ? "pct" : "price" });
  }
  return tokens;
}

function collectFactValues(facts) {
  return Object.values(facts ?? {})
    .map((fact) => fact?.valueNum)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
}

// Returns the FIRST number token in `text` that cannot be matched (within
// tolerance) to ANY value_num across the whole facts map, or null if every
// number token matches something. "Extra/unmatched number = failure" (task
// brief) - deliberately does not try to pair each token to a SPECIFIC fact
// key (the backend's phrasing is free-form prose, not a fixed per-key
// template), so a token passes as soon as it lands within tolerance of ANY
// one fact's value - matching validateNarrativeNumbers' asymmetric
// contract in spirit (a stated number must be backed by SOMETHING real) while
// not requiring this module to guess which specific key a free-form sentence
// was citing.
function findUnmatchedNumber(text, facts) {
  const factValues = collectFactValues(facts);
  for (const token of extractNumberTokens(text)) {
    const tolerance = token.kind === "pct" ? PCT_TOLERANCE : PRICE_TOLERANCE;
    const matched = factValues.some((factValue) => Math.abs(factValue - token.value) <= tolerance);
    if (!matched) {
      return token;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-attempt validation: CJK ratio -> defuse -> numeric pre-check
// ---------------------------------------------------------------------------

// Validates + sanitizes ONE backend response for one section. Order matches
// the task brief exactly: ①CJK ratio ②defuseMarkdownInText ③numeric
// pre-check - defuse is a TRANSFORM (never itself a failure reason), applied
// before the numeric check runs so the check (and the text a caller
// eventually renders) always sees the SAME, already-defused string.
function validateBackendOutput(rawText, facts) {
  const text = String(rawText ?? "");
  if (!isMostlyChinese(text)) {
    return { ok: false, reason: "后端输出非中文（CJK 占比低于 30%）", marker: NON_CHINESE_DEGRADE_MARKER };
  }
  const defused = defuseMarkdownInText(text);
  const unmatched = findUnmatchedNumber(defused, facts);
  if (unmatched) {
    return {
      ok: false,
      reason: `数字比对未通过：叙事包含数字 ${unmatched.raw}，未在事实表数值（±容差）中找到匹配`,
      marker: NUMERIC_DEGRADE_MARKER
    };
  }
  return { ok: true, text: defused };
}

// ---------------------------------------------------------------------------
// Digest: a compact, deterministic string form of `facts` handed to the
// backend as `factsDigest` - real LLM prompt context (P10), and in the
// meantime a stable, directly-assertable value for tests.
// ---------------------------------------------------------------------------

function buildFactsDigest(facts) {
  return Object.entries(facts ?? {})
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([factKey, fact]) => {
      const hasNum = typeof fact?.valueNum === "number" && Number.isFinite(fact.valueNum);
      const value = hasNum ? `${fact.valueNum}${fact?.unit ? fact.unit : ""}` : (fact?.valueText ?? "数据不可得");
      return `${factKey}=${value}`;
    })
    .join("; ");
}

// ---------------------------------------------------------------------------
// One section: call -> validate -> retry (<=2) -> degrade
// ---------------------------------------------------------------------------

// Drives ONE section through up to 1 + MAX_RETRIES_PER_SECTION backend
// calls. Returns one of:
//   - { threw: true, error } - the backend ITSELF threw (not a validation
//     failure) - the caller (generateNarrativeSections) treats this as a
//     GLOBAL degrade signal, stopping immediately (mirrors
//     news-agent-search.mjs's executeQueries: "a searchBackend throw stops
//     issuing further calls immediately").
//   - { narrative: true, text, retries } - backend output validated
//     successfully (on the 1st attempt or a retry); `text` is already
//     defused and safe to render as-is.
//   - { narrative: false, text, retries, degradeReason } - every attempt
//     failed validation; `text` is deterministicText + the marker matching
//     the LAST failure's reason (numeric mismatch vs. non-Chinese).
//
// `retries` counts retry attempts actually CONSUMED (0 if the first call
// already validated) - see this function's inline accounting comment.
async function generateOneSection({ backend, symbol, facts, factsDigest, section }) {
  let retryReason = null;
  let retries = 0;

  for (let attempt = 0; attempt <= MAX_RETRIES_PER_SECTION; attempt += 1) {
    let backendOutput;
    try {
      // eslint-disable-next-line no-await-in-loop -- retries are inherently
      // sequential: attempt N+1 only exists because attempt N's own output
      // just failed validation, and the failure reason from attempt N is
      // itself part of attempt N+1's call args (self-correction hook).
      backendOutput = await backend({
        symbol,
        sectionKey: section.key,
        factsDigest,
        deterministicText: section.deterministicText,
        // Extension beyond the base 4-field interface (task brief: "带失败
        // 原因重试...so a real LLM could self-correct") - null on the first
        // attempt, the previous attempt's failure reason on every retry.
        retryReason
      });
    } catch (error) {
      return { threw: true, error, retries };
    }

    const validation = validateBackendOutput(backendOutput?.text, facts);
    if (validation.ok) {
      return { narrative: true, text: validation.text, retries };
    }

    retryReason = validation.reason;
    if (attempt < MAX_RETRIES_PER_SECTION) {
      // This failure IS going to be retried (another attempt follows) - it
      // counts as one consumed retry. The LAST attempt's failure (when the
      // loop is about to exit instead of looping again) must NOT bump this
      // counter a 3rd time - "retry same section <=2 times" means exactly 2
      // retries max, not 3.
      retries += 1;
    } else {
      // Exhausted every attempt - degrade this section, carrying the LAST
      // failure's marker (numeric vs. non-Chinese) so the disclosure names
      // the actual reason, not a generic one.
      return {
        narrative: false,
        text: `${section.deterministicText}${validation.marker}`,
        retries,
        degradeReason: retryReason
      };
    }
  }
  // Unreachable (the loop above always returns), kept only so this function
  // has an explicit fallthrough contract rather than an implicit `undefined`.
  throw new Error("generateOneSection: unreachable fallthrough");
}

// ---------------------------------------------------------------------------
// Public: generateNarrativeSections
// ---------------------------------------------------------------------------

// @param {{
//   backend: (args: {symbol, sectionKey, factsDigest, deterministicText,
//     retryReason: string|null}) => Promise<{text: string}>,
//   symbol: string,
//   facts: Record<string, {valueNum: number|null, valueText: string|null, unit: string|null}>,
//   sections: Array<{key: string, deterministicText: string}>
// }} options
// @returns {{
//   sections: Array<{key: string, text: string, narrative: boolean, degradeReason?: string}>,
//   degraded: boolean,
//   degradedReason: string|null,
//   degradedSections: string[],
//   retriesUsed: number
// }}
export async function generateNarrativeSections({ backend, symbol, facts, sections = [] }) {
  const factsDigest = buildFactsDigest(facts);

  const resolved = [];
  let retriesUsed = 0;
  let backendThrew = false;
  let degradedReason = null;

  for (const section of sections) {
    if (backendThrew) {
      // Task brief: "backend 整体抛错→全部段落回落" - once the backend has
      // thrown ONCE in this run, every remaining section is treated the same
      // way news-agent-search.mjs's executeQueries treats a mid-run throw:
      // no further calls are attempted at all (not even to discover it would
      // throw again), the section simply degrades.
      resolved.push({ key: section.key, narrative: false, text: section.deterministicText });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop -- sections are generated
    // one at a time, deliberately: a later section's retryReason/backend
    // call must never race a not-yet-resolved earlier section, and a
    // mid-run throw must be observed before any LATER section is attempted
    // (see the backendThrew branch above).
    const outcome = await generateOneSection({ backend, symbol, facts, factsDigest, section });

    if (outcome.threw) {
      backendThrew = true;
      degradedReason = String(outcome.error?.message ?? outcome.error);
      retriesUsed += outcome.retries;
      resolved.push({ key: section.key, narrative: false, text: section.deterministicText });
      continue;
    }

    retriesUsed += outcome.retries;
    resolved.push(
      outcome.narrative
        ? { key: section.key, narrative: true, text: outcome.text }
        : { key: section.key, narrative: false, text: outcome.text, degradeReason: outcome.degradeReason }
    );
  }

  if (backendThrew) {
    // Global degrade: EVERY section falls back to its own deterministicText
    // UNCHANGED (no per-section marker - the caller discloses this once, at
    // the report/symbol level, via REPORT_DEGRADED_HEADER), even sections
    // that had already validated successfully earlier in this same loop -
    // "全部段落回落" is unconditional on a backend throw, not just the
    // sections not yet attempted.
    return {
      sections: sections.map((section) => ({ key: section.key, narrative: false, text: section.deterministicText })),
      degraded: true,
      degradedReason,
      degradedSections: sections.map((section) => section.key),
      retriesUsed
    };
  }

  return {
    sections: resolved,
    degraded: false,
    degradedReason: null,
    degradedSections: resolved.filter((entry) => !entry.narrative).map((entry) => entry.key),
    retriesUsed
  };
}

// ---------------------------------------------------------------------------
// P10 wiring: real narrative LLM backend (live OpenClaw gateway)
// ---------------------------------------------------------------------------

// Per-section narrative latency budget (task brief: narrative ≤60s).
const NARRATIVE_TIMEOUT_MS = 60000;

// System instruction: this lane REWRITES our own deterministic section text
// into fluent Chinese prose. The two hard rules mirror this module's own
// validateBackendOutput gates so a compliant model passes on the first try:
//   ①中文输出（CJK 占比 gate）②不得引入 factsDigest 之外的任何数字（numeric
//   pre-check gate）. The model is told the exact reasons its output would be
//   rejected so the retryReason self-correction hook is actionable.
const NARRATIVE_SYSTEM = [
  "你是严谨的中文投研写作助手，负责把给定的“确定性文本”改写为流畅、专业的中文叙事段落。",
  "硬性规则：",
  "1. 只能使用中文书写（可保留股票代码等专有名词），不得整段使用英文。",
  "2. 只能引用“事实摘要（factsDigest）”中已经给出的数字；严禁编造、推算或引入任何其它数字（包括价格、涨跌幅、市值、估值等）。若某数字不在事实摘要中，就不要写出具体数值。",
  "3. 不要输出 Markdown 链接、代码块或任何解释性前后缀，只返回改写后的叙事正文本身。",
  "4. 忠于确定性文本的事实与结论，只做语言润色与组织，不得改变判断方向。"
].join("\n");

function buildNarrativePrompt({ symbol, sectionKey, factsDigest, deterministicText, retryReason }) {
  const lines = [
    `标的：${symbol ?? "未知"}`,
    `段落：${sectionKey ?? "未知"}`,
    `事实摘要（唯一允许引用的数字来源）：${factsDigest || "（无）"}`,
    "",
    "确定性文本（请据此改写为自然中文叙事）：",
    String(deterministicText ?? "")
  ];
  if (retryReason) {
    lines.push(
      "",
      `上一次输出被拒绝，原因：${retryReason}。请针对该原因修正后重写（务必满足中文与“仅用事实摘要中的数字”两条规则）。`
    );
  }
  return lines.join("\n");
}

// Real narrative backend, wired to the live gateway via the shared client.
// Production wiring (stock-analysis.mjs's runAnalysis default) calls this with
// no args, so a bare `createNarrativeLlmBackend()` self-resolves gateway
// URL/token from env/`~/.openclaw/openclaw.json`. Tests inject `{ client }`
// (a fake) so no network is touched. Returning the raw gateway text is safe:
// generateNarrativeSections runs it through validateBackendOutput (CJK ratio +
// defuse + numeric pre-check) and retries/degrades honestly — this backend
// never fabricates. A transport/timeout/empty-completion failure throws (via
// the shared client), which generateNarrativeSections treats as a GLOBAL
// degrade to the pure fact-table report.
export function createNarrativeLlmBackend(options = {}) {
  const client = options.client || createGatewayClient(options);
  const timeoutMs = options.timeoutMs ?? NARRATIVE_TIMEOUT_MS;
  return async function narrativeLlmBackend({ symbol, sectionKey, factsDigest, deterministicText, retryReason }) {
    const prompt = buildNarrativePrompt({ symbol, sectionKey, factsDigest, deterministicText, retryReason });
    const text = await client.complete({ prompt, system: NARRATIVE_SYSTEM, timeoutMs });
    return { text };
  };
}

// ---------------------------------------------------------------------------
// Smoke entrypoint: `node narrative-engine.mjs smoke [--symbol AAPL.US] [--section basic]`
// One real gateway call — the controller runs this on the mini.
// ---------------------------------------------------------------------------
const isMainModule = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (isMainModule && process.argv[2] === "smoke") {
  const args = parseSmokeArgs(process.argv.slice(3));
  const symbol = typeof args.symbol === "string" ? args.symbol : "AAPL.US";
  const sectionKey = typeof args.section === "string" ? args.section : "basic";
  const backend = createNarrativeLlmBackend();
  await runSmoke("narrative", () =>
    backend({
      symbol,
      sectionKey,
      factsDigest: "quote.last=210.5USD; quote.pct=1.2pct",
      deterministicText: `${symbol} 最新价 210.5 美元，日内涨幅 1.2%，整体表现稳健。`,
      retryReason: null
    })
  );
}
