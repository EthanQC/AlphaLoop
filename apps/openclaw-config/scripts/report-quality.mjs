// Phase 5 Task 4 (2026-07-15 plan): the ONLY three project imports this
// otherwise-zero-dependency module has ever needed. Each is deliberately
// chosen to avoid a circular import that would loop back INTO this file (see
// stock-facts-store.mjs's own comment on CONFIDENCE_COVERAGE_CHECKPOINTS for
// why that constant lives there rather than in stock-analysis.mjs, which
// already imports assertStockAnalysisQuality from here) and to avoid pulling
// in any module with project-external side effects at import time (none of
// conclusion-box.mjs/stock-facts-store.mjs/narrative-engine.mjs touch the
// filesystem, env, or a db connection merely by being imported).
import { parseConclusionBox } from "./conclusion-box.mjs";
import { CONFIDENCE_COVERAGE_CHECKPOINTS, CONFIDENCE_COVERAGE_THRESHOLD } from "./stock-facts-store.mjs";
import { NON_CHINESE_DEGRADE_MARKER, NUMERIC_DEGRADE_MARKER, REPORT_DEGRADED_HEADER } from "./narrative-engine.mjs";

const GENERIC_NEWS_PATTERN = /媒体报道与.+相关的公司新闻/u;
const LONG_ENGLISH_WORD_PATTERN = /(?:\b[A-Za-z][A-Za-z'-]{2,}\b[\s,.:;!?()/-]*){18,}/u;

// Phase 4 Task 6 - era-compatibility rule (binding, see this task's live
// check requirement): reports rendered by the OLD renderMarketIntelligence
// (every report generated before Task 7 ships the event-clustering section,
// including every already-delivered/archived report under reports/daily/ and
// reports/weekly/) never carry this heading, and never carry the
// source-statistics lines (来源分布 with >=3 entries, 中文源占比：X%) the new
// gates below need to evaluate at all. Applying news.source_diversity_v2 /
// news.chinese_ratio (or, via the separate validateReportUrls/
// validateNarrativeNumbers functions below, news.url_reachability /
// facts.numeric_match) unconditionally would retroactively fail every
// legacy report the moment this file merges, even though nothing about
// those reports changed and the OLD gates (news.source_diversity, etc. -
// all still unconditional, unchanged, still enforced) already cover them.
//
// So the new gates are strictly opt-in: they only ever evaluate when this
// exact marker heading is present, which is also the same heading
// isPreparedReportMarkdownComplete's "多源新闻" substring check
// (scheduled-report.mjs) already requires - Task 7's renderer emitting this
// heading is simultaneously what turns every new gate on AND what a
// prepared report already needed to contain. There is no third, hybrid
// state: a legacy-format report is judged ONLY by the old gates; a
// new-format report is judged by the old gates AND the new ones.
const NEW_FORMAT_SECTION_MARKER = "### 多源新闻（事件聚类）";

function isNewFormatReport(text) {
  return text.includes(NEW_FORMAT_SECTION_MARKER);
}

export function validateReportMarkdown(markdown, { kind = "daily" } = {}) {
  const text = normalizeText(markdown);
  const failures = [];
  const newsLines = extractNewsLines(text);
  const sourceLabels = extractSourceLabels(text, newsLines);
  const nonLongbridgeSourceCount = sourceLabels.filter((source) => !/longbridge/iu.test(source)).length;
  const isNewFormat = isNewFormatReport(text);

  if (!/^# OpenClaw (?:日报|周报) \d{4}-\d{2}-\d{2}/u.test(text)) {
    failures.push("report.title");
  }
  if (!text.includes("### 多源新闻")) {
    failures.push("news.section_missing");
  }
  if (/daily-routine\.md|###\s+信息检索|###\s+信息分类与处理/u.test(text)) {
    failures.push("readability.template_checklist");
  }
  if (/###\s+利好\/利空\/基本面影响/u.test(text)) {
    failures.push("readability.duplicate_news_classification");
  }
  // Quiet-news-day escape (same honesty contract as the 「来源降级状态」
  // passthrough below): the new clustered format can legitimately produce
  // fewer than 3 EVENTS on a quiet day (holiday, weekend-adjacent session),
  // and blocking the whole report over that would recreate the exact
  // crash-loop-every-trigger failure H7 fixed for source diversity. A report
  // that EXPLICITLY discloses the scarcity (「事件稀少提示」, emitted by the
  // renderer only when it truly clustered <3 events) passes the depth gate;
  // an undisclosed thin report still fails.
  const hasScarcityDisclosure = /事件稀少提示/u.test(text);
  if (newsLines.length < minimumNewsLines(kind) && !(hasScarcityDisclosure && newsLines.length >= 1)) {
    failures.push("news.detail_depth");
  }
  if (new Set(sourceLabels.map((source) => source.toLowerCase())).size < 2 || nonLongbridgeSourceCount === 0) {
    failures.push("news.source_diversity");
  }
  if (GENERIC_NEWS_PATTERN.test(newsLines.join("\n"))) {
    failures.push("news.generic_chinese_summary");
  }
  if (!newsLines.every(isDetailedNewsLine)) {
    pushUnique(failures, "news.detail_depth");
  }
  if (newsLines.some(hasLongUntranslatedEnglishOutsideAllowedFields) || /英文摘要已读取|事件细节待核对/u.test(newsLines.join("\n"))) {
    failures.push("news.translation");
  }
  if (!/(### 宏观日历|宏观日历降级)/u.test(text)) {
    failures.push("macro.evidence");
  }
  if (!/(QQQ 固定观察|QQQ 与美股风险温度)/u.test(text)) {
    failures.push("market.qqq");
  }

  // Phase 4 Task 6 - new-format-only gates (see isNewFormatReport above for
  // the era-compatibility rule these are gated behind).
  if (isNewFormat) {
    // news.source_diversity_v2: strictly tighter than the pre-existing
    // news.source_diversity gate above (>=3 independent sources, not just
    // >=2 with one non-Longbridge) - both gates run and can both fire
    // independently, each under its own failure code. H7 semantics are
    // preserved identically to the existing gate: an explicitly-disclosed
    // "来源降级状态" report is deliberately honest about being degraded, so
    // it still passes this gate too, not just the older one.
    const isExplicitlyDegraded = /来源降级状态/u.test(text);
    if (!isExplicitlyDegraded) {
      const uniqueSourcesV2 = new Set(sourceLabels.map((source) => source.toLowerCase()));
      if (uniqueSourcesV2.size < 3) {
        failures.push("news.source_diversity_v2");
      }
    }

    // news.chinese_ratio: parses the "- 中文源占比：X%。" summary bullet this
    // task defines (T7 is the renderer that will actually emit it, scoped
    // the same section-aware way as the source-distribution line above -
    // see extractChineseRatioPercent). Fails when news is present in the
    // report but either the line is missing entirely, or its parsed
    // percentage is below the Global Constraints' 30% floor.
    if (newsLines.length > 0) {
      const chineseRatioPercent = extractChineseRatioPercent(text);
      if (chineseRatioPercent === null || chineseRatioPercent < 30) {
        failures.push("news.chinese_ratio");
      }
    }
  }

  return buildResult(failures);
}

export function assertReportQuality(markdown, options = {}) {
  const result = validateReportMarkdown(markdown, options);
  if (!result.ok) {
    throw new Error(`报告质量校验失败：${result.failures.join(", ")}`);
  }
  return result;
}

// Phase 5 Task 4 (2026-07-15 plan) - era marker for STOCK-ANALYSIS reports,
// separate constant/function from isNewFormatReport/NEW_FORMAT_SECTION_MARKER
// above (those are the daily/weekly kind's own marker - a different report
// family with its own independent era boundary). "### 结论框" is Task 2's
// structured conclusion box heading (conclusion-box.mjs's renderConclusionBox
// always emits it) - every stock-analysis report generated before this task
// shipped (every already-delivered/archived report under
// reports/stock-analysis/) never contains it, so the three new gates below
// are strictly opt-in behind this exact marker, identically to the
// daily/weekly era-compatibility rule: a legacy report is judged ONLY by the
// 8 pre-existing gates below (unchanged); a new-format report is judged by
// those AND the new ones.
const STOCK_CONCLUSION_BOX_MARKER = "### 结论框";

function isNewFormatStockReport(text) {
  return text.includes(STOCK_CONCLUSION_BOX_MARKER);
}

// Splits a stock-analysis markdown document into one entry per `## SYMBOL`
// section (heading text looks like a US ticker - uppercase letters/digits
// with optional `.`/`-` separators, e.g. "AAPL.US", "BRK.B" - never CJK), so
// each new gate below can be scoped to exactly ONE symbol's own content, the
// same way stock-analysis.mjs's own extractSymbolMarkdownSection slices the
// full rendered batch down to one symbol before persistPredictionsForRecords
// parses its box. A non-symbol level-2 heading (e.g. "## 本批次结论", the
// batch-level summary renderBatchStockAnalysis always renders first) is
// simply excluded - its content belongs to no symbol and is never scanned by
// any of the three new gates. Failed symbols (fetchStockAnalysisRecords'
// per-symbol isolation) never get a `## SYMBOL` section rendered for them in
// the first place (see stock-analysis.mjs's renderBatchStockAnalysis - a
// failedSymbols entry only ever appears inside the "数据缺口" bullet of "##
// 本批次结论"), so they are automatically excluded from every per-symbol
// gate's denominator below - no separate failedSymbols bookkeeping needed
// here.
const STOCK_SYMBOL_HEADING_PATTERN = /^[A-Z0-9]+(?:[.-][A-Z0-9]+)*$/u;

function extractStockSymbolSections(markdown) {
  const lines = markdown.split("\n");
  const sections = [];
  let currentSymbol = null;
  let buffer = [];
  const flush = () => {
    if (currentSymbol) {
      sections.push({ symbol: currentSymbol, section: buffer.join("\n") });
    }
    buffer = [];
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const heading = /^##(?!#)\s+(.+)$/u.exec(line);
    if (heading) {
      flush();
      const headingText = heading[1].trim();
      currentSymbol = STOCK_SYMBOL_HEADING_PATTERN.test(headingText) ? headingText : null;
      continue;
    }
    if (currentSymbol) {
      buffer.push(rawLine);
    }
  }
  flush();
  return sections;
}

// stock.facts_coverage: one detector pair per CONFIDENCE_COVERAGE_CHECKPOINTS
// key (imported from stock-facts-store.mjs - the SAME 8-key list Task 2's
// confidence heuristic uses, see that module's own comment) - `backed`
// matches the exact phrase buildDeterministicAnalysis/stock-analysis-metrics.mjs
// render for a REAL value of that key; `disclosed` matches the specific
// explicit-unavailability phrasing those same deterministic formulas render
// for that key's failure branch (never just "暂无", which is a plain
// formatting fallback with no stated reason - "缺数据段显式标注原因" per the
// plan requires an actual disclosed REASON, not a bare placeholder). Either
// one counts as "covered" - only a key with NEITHER present (a silent gap:
// the rendering pipeline dropped a whole data point without disclosing why)
// counts against the >=6/8 threshold.
const FACTS_COVERAGE_DETECTORS = {
  "quote.last": {
    backed: /最新价格[:：]\s*(?!暂无)[0-9]/u,
    disclosed: /现价数据不可得/u
  },
  "quote.pct": {
    backed: /涨跌幅[:：]\s*(?!暂无)[+-]?[0-9]/u,
    disclosed: /缺少前收数据/u
  },
  "valuation.pe": {
    backed: /PE\s+(?!暂无)[0-9,.]+/iu,
    disclosed: /估值(?:读取失败|数据暂无可用)/u
  },
  "valuation.targetPrice": {
    backed: /一年目标价\s*(?!暂无)[0-9,.]+/u,
    disclosed: /目标价(?:缺失|数据不可得|均数据不可得)/u
  },
  "history.ma20": {
    backed: /均线[:：]\s*20\s*日\s*(?!暂无)[0-9]/u,
    disclosed: /历史走势(?:读取失败|暂无可用数据)/u
  },
  "history.ma60": {
    backed: /60\s*日\s*(?!暂无)[0-9]/u,
    disclosed: /历史走势(?:读取失败|暂无可用数据)/u
  },
  "options.callOi": {
    backed: /Call\s*未平仓约\s*(?!暂无)[0-9]/u,
    disclosed: /期权链(?:读取失败|暂无可用数据)/u
  },
  "news.count": {
    backed: /(?:媒体|渠道)[:：]/u,
    disclosed: /暂无新闻来源/u
  }
};

function countFactsCoverage(sectionText) {
  return CONFIDENCE_COVERAGE_CHECKPOINTS.filter((key) => {
    const detector = FACTS_COVERAGE_DETECTORS[key];
    return Boolean(detector) && (detector.backed.test(sectionText) || detector.disclosed.test(sectionText));
  }).length;
}

export function validateStockAnalysisMarkdown(markdown) {
  const text = normalizeText(markdown);
  const failures = [];
  const newsLines = extractNewsLines(text);
  const sourceLabels = extractSourceLabels(text, newsLines);

  if (!/^# OpenClaw 个股分析 \d{4}-\d{2}-\d{2}/u.test(text)) {
    failures.push("stock.title");
  }
  if (!/PE\s+(?!暂无)[0-9,.]+/iu.test(text) || !/PB\s+(?!暂无)[0-9,.]+/iu.test(text)) {
    failures.push("stock.valuation_depth");
  }
  if (!/综合上行潜力/u.test(text) || /只看期权链|只看期权/u.test(text)) {
    failures.push("stock.upside_depth");
  }
  if (!/均线：20 日/u.test(text)) {
    failures.push("stock.trend_depth");
  }
  if (!/期权链只读补充/u.test(text)) {
    failures.push("stock.option_chain");
  }
  // Task H7 (2026-07-14 legacy audit): renderBatchStockAnalysis explicitly
  // discloses a whole-batch Longbridge-only news degradation with a fixed
  // "已保留来源降级状态" notice (stock-analysis.mjs) instead of pretending
  // diverse sources exist. That explicit, disclosed degradation used to be
  // rejected by this exact gate every time - a routine external-news outage
  // (Yahoo/Google returning zero items) meant NO report could ever be
  // delivered, crash-looping every scheduled trigger. An honestly-disclosed
  // degraded state must be allowed through; an UNDISCLOSED single-source
  // report must still fail.
  if (sourceLabels.length > 0) {
    const uniqueSources = new Set(sourceLabels.map((source) => source.toLowerCase()));
    const isExplicitlyDegraded = /来源降级状态/u.test(text);
    if (!isExplicitlyDegraded && (uniqueSources.size < 2 || !sourceLabels.some((source) => !/longbridge/iu.test(source)))) {
      failures.push("stock.news_source_diversity");
    }
  }
  if (GENERIC_NEWS_PATTERN.test(newsLines.join("\n"))) {
    failures.push("stock.news_generic_summary");
  }
  if (/英文摘要已读取|事件细节待核对/u.test(newsLines.join("\n"))) {
    failures.push("stock.news_translation");
  }

  // Phase 5 Task 4 (2026-07-15 plan) - new-format-only gates (see
  // isNewFormatStockReport above for the era-compatibility rule these are
  // gated behind). Both new gates are scoped PER `## SYMBOL` section
  // (extractStockSymbolSections) - a batch report can mix a well-formed
  // symbol with a corrupted one, and each symbol must be judged on its own.
  if (isNewFormatStockReport(text)) {
    for (const { symbol, section } of extractStockSymbolSections(text)) {
      // stock.conclusion_box: parseConclusionBox is the SAME parser Task 2's
      // prediction persistence and Task 5's platform summary card use (single
      // source, never re-parsed ad hoc here) - it already enforces "confidence
      // label must be one of 高/中/低" internally (confidenceFromLabel returns
      // undefined for anything else, e.g. a hand-edited '很高', and
      // parseConclusionBox treats that as a missing required key -> null), so
      // "AND confidence label ∈ 三档" from this gate's spec is satisfied by
      // composition rather than a second, redundant confidence check here.
      if (!parseConclusionBox(section)) {
        failures.push(`stock.conclusion_box:${symbol}`);
      }

      // stock.facts_coverage: >=6 of the SAME 8 checkpoints Task 2's
      // confidence heuristic counts, either facts-backed or explicitly
      // disclosed as unavailable within this symbol's own section text.
      const covered = countFactsCoverage(section);
      if (covered < CONFIDENCE_COVERAGE_THRESHOLD) {
        failures.push(`stock.facts_coverage:${symbol}:${covered}/${CONFIDENCE_COVERAGE_CHECKPOINTS.length}`);
      }
    }
  }

  return buildResult(failures);
}

export function assertStockAnalysisQuality(markdown) {
  const result = validateStockAnalysisMarkdown(markdown);
  if (!result.ok) {
    throw new Error(`个股分析质量校验失败：${result.failures.join(", ")}`);
  }
  return result;
}

function normalizeText(value) {
  return String(value ?? "").replace(/\r\n/gu, "\n").trim();
}

// #32 audit fix: the report's own source-distribution summary bullet is
// always the report generator's own line, never a news item - and it
// always starts the bullet directly with this label (see
// renderMarketIntelligence in scheduled-report.mjs and the equivalent in
// stock-analysis.mjs). Anchoring at the start of the bullet (rather than
// matching the substring anywhere in the line) means a news TITLE that
// merely *contains* this phrase - e.g. as part of "原始标题：" or
// "标题要点：" further along the same bullet - can never be mistaken for
// the summary line, because renderDetailedNewsLine always prefixes every
// news bullet with "- <time> <symbol>：..." first.
const SOURCE_SUMMARY_LINE_PATTERN = /^-\s*(?:新闻来源分布|来源分布)：(.+?)(?:。|$)/u;

function extractNewsLines(markdown) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^###\s+多源新闻|^###\s+近期新闻/u.test(line.trim()));
  if (start === -1) {
    return [];
  }
  const collected = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (/^#{2,3}\s+/u.test(trimmed)) {
      break;
    }
    if (SOURCE_SUMMARY_LINE_PATTERN.test(trimmed)) {
      // The report's own source-distribution summary bullet (stock-analysis
      // puts it as the first line of this same section) - not a news item,
      // must not count toward news.detail_depth either way.
      continue;
    }
    if (/^-\s+/u.test(trimmed) && /媒体：|渠道：/u.test(line)) {
      collected.push(trimmed);
    }
  }
  return collected;
}

// #32 audit fix: only recognize a "来源分布："/"新闻来源分布：" line as the
// report's own source-summary evidence when it appears (a) inside a
// section the report generator actually uses for that summary (### 证据与
// 来源 for daily/weekly, ### 近期新闻/### 多源新闻 for stock-analysis), AND
// (b) is anchored at the very start of the bullet (see
// SOURCE_SUMMARY_LINE_PATTERN above). A news headline that happens to
// contain the same Chinese phrase deep inside a detailed news bullet
// satisfies neither condition, so it can no longer forge source diversity
// or evade the news.detail_depth line count.
const SOURCE_SUMMARY_SECTION_HEADING_PATTERN = /^(?:证据与来源|近期新闻|多源新闻)/u;

function extractSourceLabels(markdown, newsLines) {
  const labels = [];
  let inSourceSummarySection = false;
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    const heading = /^#{2,3}\s+(.+)$/u.exec(line);
    if (heading) {
      inSourceSummarySection = SOURCE_SUMMARY_SECTION_HEADING_PATTERN.test(heading[1].trim());
      continue;
    }
    if (!inSourceSummarySection) {
      continue;
    }
    const sourceSummary = line.match(SOURCE_SUMMARY_LINE_PATTERN)?.[1];
    if (!sourceSummary) {
      continue;
    }
    for (const entry of sourceSummary.split("；")) {
      const label = entry.replace(/\s+\d+\s+条$/u, "").trim();
      if (label) {
        labels.push(label);
      }
    }
  }

  for (const line of newsLines) {
    const media = line.match(/媒体：([^；。]+)/u)?.[1]?.trim();
    const channel = line.match(/渠道：([^；。]+)/u)?.[1]?.trim();
    if (media) {
      labels.push(media);
    }
    if (channel) {
      labels.push(channel);
    }
  }
  return Array.from(new Set(labels.filter(Boolean)));
}

// Phase 4 Task 6: the report's own "中文源占比：X%。" summary bullet - this
// task DEFINES the line format (T7 is the later task that actually renders
// it); parsing is scoped to the exact same sections extractSourceLabels
// already trusts (SOURCE_SUMMARY_SECTION_HEADING_PATTERN matches headings
// starting with "多源新闻"/"证据与来源"/"近期新闻"), so a fabricated ratio
// phrase planted inside a news title can no more forge this than it can
// forge source diversity.
const CHINESE_RATIO_LINE_PATTERN = /^-\s*中文源占比：\s*([0-9]+(?:\.[0-9]+)?)\s*%/u;

function extractChineseRatioPercent(markdown) {
  let inSourceSummarySection = false;
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    const heading = /^#{2,3}\s+(.+)$/u.exec(line);
    if (heading) {
      inSourceSummarySection = SOURCE_SUMMARY_SECTION_HEADING_PATTERN.test(heading[1].trim());
      continue;
    }
    if (!inSourceSummarySection) {
      continue;
    }
    const match = line.match(CHINESE_RATIO_LINE_PATTERN);
    if (match) {
      return Number(match[1]);
    }
  }
  return null;
}

// Phase 4 Task 6 - news.url_reachability. Kept as its OWN async function
// rather than folded into validateReportMarkdown: every other gate in this
// file is a pure, synchronous string check, and every existing caller
// (assertReportQuality/prepareReport/deliverReport, stock-analysis.mjs) calls
// validateReportMarkdown synchronously - turning it async would force every
// call site to await a check that, for the vast majority of callers, has
// nothing to do with network reachability. A separate async function that
// callers can opt into (once they're ready to await it, e.g. before final
// delivery) is the cleaner seam; `fetchImpl` is injectable so tests never
// hit the real network (mirrors news-sources.mjs's own fetchImpl pattern).
//
// Same era-compatibility rule as the sync gates above: legacy-format reports
// (no NEW_FORMAT_SECTION_MARKER) are skipped entirely - this is a NEW gate
// only meaningful once Task 7's event-clustering section (with its per-event
// "原文链接" URLs) exists to sample from.
export async function validateReportUrls(markdown, { fetchImpl, sampleSize = 5, timeoutMs = 5000 } = {}) {
  const text = normalizeText(markdown);
  if (!isNewFormatReport(text)) {
    return buildResult([]);
  }

  const urls = extractReportUrls(text);
  const sample = urls.length <= sampleSize ? urls : urls.slice(0, sampleSize);
  const failures = [];
  for (const url of sample) {
    // eslint-disable-next-line no-await-in-loop -- sequential HEAD checks
    // keep the failure list deterministically ordered and keep this
    // trivially testable with a simple fake fetchImpl; report generation
    // runs at most a handful of these (sampleSize, default 5), so the
    // sequential cost is negligible against the plan's <=15 minute budget.
    const reachable = await checkUrlReachable(url, { fetchImpl, timeoutMs });
    if (!reachable) {
      failures.push(`news.url_reachability:${url}`);
    }
  }
  return buildResult(failures);
}

function extractReportUrls(markdown) {
  const urls = new Set();
  for (const match of markdown.matchAll(/https?:\/\/[^\s)\]）。；"'<>]+/gu)) {
    urls.add(match[0]);
  }
  return Array.from(urls);
}

async function checkUrlReachable(url, { fetchImpl, timeoutMs = 5000 } = {}) {
  const impl = fetchImpl ?? globalThis.fetch;
  if (typeof impl !== "function") {
    // No fetch available in this runtime - treat as unreachable rather than
    // silently skipping the check (never let "we couldn't check" masquerade
    // as "it's fine").
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await impl(url, { method: "HEAD", signal: controller.signal });
    return Boolean(response?.ok);
  } catch {
    // Any thrown error - network failure, abort-on-timeout, malformed URL -
    // is "unreachable", per the task brief ("timeout 5s = unreachable").
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Phase 4 Task 6 - facts.numeric_match. A separate function (like
// validateReportUrls above) rather than folded into validateReportMarkdown,
// because it needs a THIRD input validateReportMarkdown's existing callers
// never had: the daily_facts map (news-store.mjs's getDailyFacts) computed
// independently by report-facts.mjs's buildDailyFacts. Extracts every
// number in the narrative that sits next to one of the known fact-key
// phrases and compares it against the matching daily_facts entry:
//   - phrase matches but the facts map has no usable value for that key ->
//     fail (a number is being asserted with nothing backing it - the
//     "编数拦截" case from the task brief).
//   - phrase matches and the facts map DOES have a value, but the two
//     differ by more than the tolerance -> fail, citing both values.
// Same era-compatibility rule as the sync gates: skipped entirely for
// legacy-format reports (no daily_facts-backed narrative to check yet).
const NUMERIC_MATCH_PATTERNS = [
  { factKey: "paper.exposurePct", kind: "pct", pattern: /暴露\s*([0-9][0-9,]*\.?[0-9]*)\s*%/gu },
  { factKey: "paper.netAssets", kind: "price", pattern: /净资产[：:]?\s*([0-9][0-9,]*\.?[0-9]*)/gu },
  // Phase 4 Task 7 (T6 gap): 现金/paper.totalCash appears in the narrative
  // (renderCoreSummary's accountSummary "现金 X"; renderOfficialPaperSnapshot's
  // "现金：X") but had no matching NUMERIC_MATCH_PATTERNS entry - a fabricated
  // cash figure would sail through undetected. Chosen fix: ADD the pattern
  // (keep showing 现金 to the reader) rather than remove it from the
  // narrative, matching the existing 净资产 entry's shape (optional colon,
  // comma-grouped number).
  { factKey: "paper.totalCash", kind: "price", pattern: /现金\s*[：:]?\s*([0-9][0-9,]*\.?[0-9]*)/gu },
  { factKey: "paper.remainingBudget", kind: "price", pattern: /剩余(?:[^\n。]*?)预算(?:[^\n0-9]*?)([0-9][0-9,]*\.?[0-9]*)/gu },
  { factKey: "qqq.price", kind: "price", pattern: /最新价[：:]?\s*([0-9][0-9,]*\.?[0-9]*)/gu },
  { factKey: "qqq.changePct", kind: "pct", pattern: /涨跌(?:[^\n%]*?)([0-9]+(?:\.[0-9]+)?)\s*%/gu }
];

export function validateNarrativeNumbers(markdown, facts = {}, { pctTolerance = 0.1, priceTolerance = 0.01 } = {}) {
  const text = normalizeText(markdown);
  if (!isNewFormatReport(text)) {
    return buildResult([]);
  }

  const failures = [];
  for (const { factKey, kind, pattern } of NUMERIC_MATCH_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const narrativeValue = parseNarrativeNumber(match[1]);
      if (narrativeValue === null) {
        continue;
      }
      const fact = facts[factKey];
      if (!fact || fact.valueNum === null || fact.valueNum === undefined) {
        pushUnique(failures, `facts.numeric_match:${factKey}:missing_fact:narrative=${narrativeValue}`);
        continue;
      }
      const tolerance = kind === "pct" ? pctTolerance : priceTolerance;
      if (Math.abs(narrativeValue - fact.valueNum) > tolerance) {
        pushUnique(failures, `facts.numeric_match:${factKey}:narrative=${narrativeValue}:fact=${fact.valueNum}`);
      }
    }
  }
  return buildResult(failures);
}

function parseNarrativeNumber(raw) {
  const cleaned = String(raw ?? "").replace(/,/gu, "");
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Phase 5 Task 4 (2026-07-15 plan) - stock.numeric_match
// (validateStockNarrativeNumbers). Kept as its own exported function,
// separate from validateStockAnalysisMarkdown, for the SAME reason
// validateNarrativeNumbers above is separate from validateReportMarkdown:
// it needs a THIRD input (factsBySymbol) that function's other callers don't
// carry.
//
// Matching approach deliberately mirrors narrative-engine.mjs's OWN numeric
// pre-check (findUnmatchedNumber/extractNumberTokens) rather than
// validateNarrativeNumbers' phrase-anchored NUMERIC_MATCH_PATTERNS above: a
// stock-analysis section's prose (deterministic OR, once P10 lands, real
// narrative) is free-form, not the daily/weekly report's small set of fixed
// bullet templates, so no small fixed list of phrase patterns could
// enumerate every number a section might state. Every number token found in
// non-exempt text must independently prove itself against SOME value in
// that symbol's own facts (any key, within tolerance) - the same asymmetric
// "a stated number must be backed by something real" contract in spirit,
// just decided structurally (like narrative-engine.mjs) instead of via fixed
// phrases (like validateNarrativeNumbers).
//
// Exemptions - each documented because "deterministic templates only
// interpolate facts values" is the safety argument the plan asks to spell
// out, and it does NOT apply uniformly to every rendered byte:
//   1. A whole `## SYMBOL` section carrying narrative-engine.mjs's
//      REPORT_DEGRADED_HEADER (rendered once, right after the heading, only
//      when the narrative backend THREW for that symbol - see
//      stock-analysis.mjs's renderBatchStockAnalysis) is skipped ENTIRELY.
//      Every one of its 8 sections is then buildDeterministicAnalysis's own
//      deterministic text, which legitimately states INTERNALLY-COMPUTED
//      (not literally-a-single-fact-value) numbers - the three-path
//      bullish/neutral/bearish probabilities, historyStats' trend score and
//      vs-180-day-average percentage, summarizeUpsidePotential's implied
//      upside percentage - none of which were ever generated by, or checked
//      against, a narrative backend in the first place, so re-checking them
//      here would false-fail a perfectly honest deterministic report.
//   2. A specific "### ..." block carrying an inline per-section degrade
//      marker (NUMERIC_DEGRADE_MARKER/NON_CHINESE_DEGRADE_MARKER, both
//      imported from narrative-engine.mjs - single source, not re-typed) is,
//      likewise, deterministic fallback text for THAT block only - skipped
//      the same way, even when sibling blocks in the same symbol section ARE
//      narrative-adopted (a mixed state: some sections succeeded, this one's
//      retries were exhausted).
//   3. The nested "### 结论框" block is NEVER scanned, unconditionally,
//      regardless of degrade-marker state. It is validated structurally by
//      the SEPARATE stock.conclusion_box gate above (parseConclusionBox), and
//      renderBatchStockAnalysis always embeds it verbatim from
//      buildConclusionBoxParams's own computation (computeValueRange/
//      computePricePosition) - never narrative-rewritten, regardless of
//      whether the surrounding "结论与复盘标签" section's OWN prose was
//      narrative-adopted. Its 合理价值区间/当前价格位置 numbers are legitimately
//      DERIVED (e.g. a rolling 20-session support/resistance) and do not
//      literally equal any single stock_facts value_num, so scanning it here
//      would either duplicate stock.conclusion_box's job or false-fail on a
//      sound derived number.
//   4. The "### 近期新闻" block is never scanned - it was never subject to
//      the narrative/facts-derivation contract at all (raw external news
//      content, not one of NARRATIVE_SECTION_KEYS), so its dates/headline
//      numbers are not expected to trace back to stock_facts any more than
//      the daily/weekly gate's NUMERIC_MATCH_PATTERNS ever scans news bullets.
const STOCK_ISO_DATE_PATTERN = /\d{4}-\d{2}-\d{2}/gu;
const STOCK_NUMBER_TOKEN_PATTERN = /-?\d[\d,]*\.?\d*/gu;
const STOCK_DEGRADE_MARKER_PATTERN = new RegExp(
  `${escapeRegExp(NUMERIC_DEGRADE_MARKER)}|${escapeRegExp(NON_CHINESE_DEGRADE_MARKER)}`,
  "u"
);
const EXEMPT_STOCK_SUBSECTION_HEADINGS = new Set(["结论框", "近期新闻"]);

function extractStockNumberTokens(text) {
  const withoutDates = String(text ?? "").replace(STOCK_ISO_DATE_PATTERN, "");
  const tokens = [];
  for (const match of withoutDates.matchAll(STOCK_NUMBER_TOKEN_PATTERN)) {
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

function collectStockFactValues(facts) {
  return Object.values(facts ?? {})
    .map((fact) => fact?.valueNum)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
}

// Splits ONE symbol's already-extracted section text (extractStockSymbolSections)
// into its "### ..." sub-blocks, keyed by heading text - same splitting shape
// as extractStockSymbolSections above, one heading level deeper. Content
// before the first "###" heading (the whole-symbol REPORT_DEGRADED_HEADER
// blockquote line, when present) is collected under a `null` heading; callers
// that already skip the whole section on that marker never reach this
// leftover bucket in practice, but it is scanned like any other non-exempt
// block for defensiveness (it carries no numbers under real rendering).
function splitStockSubsections(sectionText) {
  const lines = sectionText.split("\n");
  const blocks = [];
  let heading = null;
  let buffer = [];
  const flush = () => {
    blocks.push({ heading, body: buffer.join("\n") });
    buffer = [];
  };
  for (const rawLine of lines) {
    const match = /^###(?!#)\s+(.+)$/u.exec(rawLine.trim());
    if (match) {
      flush();
      heading = match[1].trim();
      continue;
    }
    buffer.push(rawLine);
  }
  flush();
  return blocks;
}

export function validateStockNarrativeNumbers(markdown, factsBySymbol = {}, { pctTolerance = 0.1, priceTolerance = 0.01 } = {}) {
  const text = normalizeText(markdown);
  if (!isNewFormatStockReport(text)) {
    return buildResult([]);
  }

  const failures = [];
  for (const { symbol, section } of extractStockSymbolSections(text)) {
    if (section.includes(REPORT_DEGRADED_HEADER)) {
      // Exemption 1 (whole-symbol degrade) - see this function's header.
      continue;
    }
    const factValues = collectStockFactValues(factsBySymbol[symbol]);
    for (const block of splitStockSubsections(section)) {
      if (EXEMPT_STOCK_SUBSECTION_HEADINGS.has(block.heading) || STOCK_DEGRADE_MARKER_PATTERN.test(block.body)) {
        // Exemptions 2/3/4 - see this function's header.
        continue;
      }
      for (const token of extractStockNumberTokens(block.body)) {
        const tolerance = token.kind === "pct" ? pctTolerance : priceTolerance;
        const matched = factValues.some((value) => Math.abs(value - token.value) <= tolerance);
        if (!matched) {
          pushUnique(failures, `stock.numeric_match:${symbol}:${token.raw}`);
        }
      }
    }
  }
  return buildResult(failures);
}

function minimumNewsLines(kind) {
  return kind === "weekly" ? 3 : 3;
}

function isDetailedNewsLine(line) {
  return [
    /媒体：/u,
    /渠道：/u,
    /分类：/u,
    /基本面：/u,
    /影响：/u,
    /(?:链接：|来源索引：)/u,
    /(?:标题要点：|原始标题：)/u
  ].every((pattern) => pattern.test(line));
}

function hasLongUntranslatedEnglishOutsideAllowedFields(line) {
  const stripped = line
    .replace(/原始标题：[^；。]+/gu, "")
    .replace(/链接：https?:\/\/\S+/giu, "")
    .replace(/[A-Z]{1,6}\.US/gu, "");
  return LONG_ENGLISH_WORD_PATTERN.test(stripped);
}

function buildResult(failures) {
  const uniqueFailures = Array.from(new Set(failures));
  return {
    ok: uniqueFailures.length === 0,
    failures: uniqueFailures
  };
}

function pushUnique(values, value) {
  if (!values.includes(value)) {
    values.push(value);
  }
}

// Same tiny helper conclusion-box.mjs declares locally for the same reason
// (escaping a known, fixed literal before embedding it in a RegExp) - not
// imported from there to avoid this file depending on a private, unexported
// helper.
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
