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
  if (newsLines.length < minimumNewsLines(kind)) {
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
