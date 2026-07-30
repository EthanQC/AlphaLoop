// Phase 5 Task 4 (2026-07-15 plan): the ONLY four project imports this
// otherwise-zero-dependency module has ever needed (the fourth,
// stock-analysis-metrics.mjs, was added 2026-07-27 so the valuation detectors
// below are built from the literals the RENDERER actually emits rather than a
// second, hand-typed copy of them - it pulls in nothing this file's import
// graph did not already contain, since narrative-engine.mjs already reaches
// report-news.mjs/report-data.mjs, and it has no path back into this file).
// Each is deliberately
// chosen to avoid a circular import that would loop back INTO this file (see
// stock-facts-store.mjs's own comment on CONFIDENCE_COVERAGE_CHECKPOINTS for
// why that constant lives there rather than in stock-analysis.mjs, which
// already imports assertStockAnalysisQuality from here) and to avoid pulling
// in any module with project-external side effects at import time (none of
// conclusion-box.mjs/stock-facts-store.mjs/narrative-engine.mjs touch the
// filesystem, env, or a db connection merely by being imported).
import { parseConclusionBox, parseReportConclusionBox } from "./conclusion-box.mjs";
import { CONFIDENCE_COVERAGE_CHECKPOINTS, CONFIDENCE_COVERAGE_THRESHOLD } from "./stock-facts-store.mjs";
import {
  NARRATIVE_BULLET_PREFIX,
  NON_CHINESE_DEGRADE_MARKER,
  NUMERIC_DEGRADE_MARKER,
  REPORT_DEGRADED_HEADER
} from "./narrative-engine.mjs";
import { ETF_INAPPLICABLE_REASONS, INSUFFICIENT_SAMPLE_PREFIX, VALUATION_DISCLOSURE } from "./stock-analysis-metrics.mjs";

const GENERIC_NEWS_PATTERN = /媒体报道与.+相关的公司新闻/u;
const LONG_ENGLISH_WORD_PATTERN = /(?:\b[A-Za-z][A-Za-z'-]{2,}\b[\s,.:;!?()/-]*){18,}/u;

// The two headings under which a report renders EXTERNAL content (news items
// the pipeline did not author) - "### 近期新闻" for stock-analysis,
// "### 多源新闻…" for daily/weekly. Every gate below treats them two ways, and
// only these two ways:
//   - news gates read them (and read EVERY one of them - a batch renders one
//     per symbol, see extractNewsLines);
//   - evidence gates refuse to read them at all (see
//     extractDeterministicEvidenceLines).
// STOCK_NEWS_SECTION_TITLE is exported and IMPORTED BY THE RENDERER
// (stock-analysis.mjs's renderBatchStockAnalysis) rather than typed twice, so
// the heading the renderer emits and the heading these gates look for cannot
// drift apart. It lives here, not there, because stock-analysis.mjs already
// imports this file - the reverse edge would be circular (same reasoning as
// stock-facts-store.mjs's CONFIDENCE_COVERAGE_CHECKPOINTS).
//
// 2026-07-30: renamed 近期新闻 -> 新闻事件 to match spec r2 §3.4's sixth section.
// LEGACY_STOCK_NEWS_SECTION_TITLE keeps the old heading recognized by every
// pattern below, because the reports already on disk (and already delivered)
// carry it: a news block the gates stop recognizing is not a harmless miss, it
// is a block whose raw external headlines start being scanned as first-party
// numeric evidence (see extractDeterministicEvidenceLines and
// EXEMPT_STOCK_SUBSECTION_HEADINGS).
export const STOCK_NEWS_SECTION_TITLE = "新闻事件";
export const LEGACY_STOCK_NEWS_SECTION_TITLE = "近期新闻";
const MULTI_SOURCE_NEWS_SECTION_TITLE = "多源新闻";
const NEWS_SECTION_HEADING_PATTERN = new RegExp(
  `^(?:${STOCK_NEWS_SECTION_TITLE}|${LEGACY_STOCK_NEWS_SECTION_TITLE}|${MULTI_SOURCE_NEWS_SECTION_TITLE})`,
  "u"
);
// Level 1-3 headings delimit a section; deeper ones (####) are content INSIDE
// it, matching what the pre-2026-07-27 extractNewsLines loop did.
const SECTION_HEADING_PATTERN = /^#{1,3}(?!#)\s+(.+)$/u;

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
//
// EXPORTED (2026-07-30, spec-drift Task 12): the platform's report library
// needs the SAME era boundary this gate uses, so it stops stamping every
// report - including one generated an hour ago - as a legacy archive. The
// TS side re-declares the marker locally (apps/platform-app/src/reports/
// format-era.ts, this codebase's cross-app convention) and a parity test
// imports THIS constant and THIS function to prove the two agree.
export const NEW_FORMAT_SECTION_MARKER = "### 多源新闻（事件聚类）";

export function isNewFormatReport(text) {
  return text.includes(NEW_FORMAT_SECTION_MARKER);
}

// Task 4 (2026-07-28 spec-drift plan) - report.no_personal_content.
// 2026-07-12 requirements §3.1: the PUBLIC daily/weekly report is "不含任何个人
// 持仓与策略内容". It used to carry the owner's whole account (renderCoreSummary's
// 模拟盘 bullet, renderOfficialPaperSnapshot's block, renderNextTracking's 仓位
// bullet), which stayed invisible only because the deployment has exactly one
// member - the second member added would have been able to read the first one's
// positions off /daily/<date>. This is the regression guard that keeps those
// fields out for good; the data itself moves to the per-owner personal page.
//
// Two deliberate scoping decisions:
//
//   1. ADJACENCY, not the bare word. Every leak is a RENDERED `label：value`
//      pair, so the number sits immediately after the label (only a colon or
//      spaces between). Chinese prose never does that - a headline says
//      "现金储备升至 3,800 亿", "持仓比例升至 12%", "净资产收益率为 8%", always
//      with words in between. Banning the bare word would instead hand any
//      finance headline the power to halt delivery of the whole report (the
//      exact crash-loop class H7 and URL_HARD_FAILURE_THRESHOLD were fixed for),
//      while catching nothing extra: a headline is not the owner's account.
//   2. NEWS SECTIONS ARE NOT SCANNED (stripNewsSections). Their content is
//      third-party text this pipeline neither authors nor controls, and the
//      renderer never puts snapshot data there - the same read/refuse split
//      extractDeterministicEvidenceLines already draws.
//
// Unlike the news gates above, this one is NOT era-gated: leaking a member's
// account is not a formatting era, and a legacy-format report that carries it
// must be blocked too. That is safe for an already-prepared file on disk
// because deliverReport (scheduled-report.mjs) treats a leaking prepared report
// as stale and re-renders it, instead of hard-failing the run.
const PERSONAL_CONTENT_FIELDS = [
  { field: "净资产", pattern: /净资产\s*[：:]?\s*(?:约)?\s*[0-9]/u },
  { field: "现金", pattern: /现金\s*[：:]?\s*(?:约)?\s*[0-9]/u },
  { field: "购买力", pattern: /购买力\s*[：:]?\s*(?:约)?\s*[0-9]/u },
  { field: "持仓", pattern: /持仓\s*[：:]?\s*(?:约)?\s*[0-9A-Z]/u },
  // renderOfficialPaperSnapshot's per-position bullet: "- QQQ.US（纳指 100
  // 交易型开放式指数基金）：20.0000 …". Anchored at the bullet start, so a news
  // bullet (always "- <日期> <标的>：…", whose leading token contains "-") can
  // never match it.
  { field: "持仓明细", pattern: /^-\s*[A-Z][A-Z0-9]*(?:\.[A-Z]+)?（[^）\n]*）：\s*[0-9]/mu },
  { field: "模拟盘暴露", pattern: /暴露\s*[：:]?\s*[0-9]+(?:\.[0-9]+)?\s*%/u },
  { field: "剩余预算", pattern: /剩余[^\n。；]{0,12}预算[^\n。；0-9]{0,8}[0-9]/u }
];

// Exported so scheduled-report.mjs can tell an already-prepared report that
// still carries personal content apart from a fresh one (see deliverReport) -
// the same list, in one place, rather than a second hand-typed copy.
export function findPersonalContentLeaks(markdown) {
  const scanned = stripNewsSections(normalizeText(markdown));
  return PERSONAL_CONTENT_FIELDS
    .filter(({ pattern }) => pattern.test(scanned))
    .map(({ field }) => field);
}

// Drops every "### 近期新闻"/"### 多源新闻…" block, keeping the rest of the
// document. Section boundaries follow the same rule extractNewsLines uses:
// level 1-3 headings delimit, deeper ones (#### event cards) are content.
function stripNewsSections(text) {
  const kept = [];
  let inNewsSection = false;
  for (const line of text.split("\n")) {
    const heading = SECTION_HEADING_PATTERN.exec(line.trim());
    if (heading) {
      inNewsSection = NEWS_SECTION_HEADING_PATTERN.test(heading[1].trim());
    }
    if (!inNewsSection) {
      kept.push(line);
    }
  }
  return kept.join("\n");
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
  // Task 20 (2026-07-28 spec-drift plan): the section is 「宏观与财报日历」 now
  // (requirements §3.1), rendered as `### 宏观与财报日历` over `#### 宏观日历` +
  // `#### 财报日历`. The old literal `### 宏观日历` is kept as an accepted form
  // so a legacy report on disk is still judged by the rule it was written
  // under - the same era discipline `isNewFormatReport` draws below.
  if (!/(### 宏观与财报日历|#{3,4} 宏观日历|宏观日历降级)/u.test(text)) {
    failures.push("macro.evidence");
  }
  // The earnings half is only required of a NEW-format report: it did not
  // exist before Task 20, and retroactively failing every archived report over
  // it would be the exact retro-fail this file's era gate exists to prevent.
  // renderEarningsCalendarLines never returns an empty list - it returns the
  // reason there is nothing to list - so a new-format report that lost this
  // heading lost the whole section, not merely its content.
  if (isNewFormat && !/#### 财报日历/u.test(text)) {
    failures.push("macro.earnings_missing");
  }
  if (!/(QQQ 固定观察|QQQ 与美股风险温度)/u.test(text)) {
    failures.push("market.qqq");
  }
  // Task 4 - report.no_personal_content (see PERSONAL_CONTENT_FIELDS above).
  // The leaked field names ride along in the failure code so an operator reads
  // WHICH field came back, not just that something did.
  const personalLeaks = findPersonalContentLeaks(text);
  if (personalLeaks.length > 0) {
    failures.push(`report.no_personal_content:${personalLeaks.join("、")}`);
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
    // task defines (T7 is the renderer that emits it, scoped the same
    // section-aware way as the source-distribution line above - see
    // extractChineseRatioPercent).
    //
    // 2026-07-30 OUTAGE FIX. This gate used to fail on ANY sub-30% ratio, and
    // that made it a second copy of the news.url_reachability bug: a delivery
    // blocker armed by things that are not fabrications. Two measurements:
    //
    //   1. ALL THREE Chinese sources (华尔街见闻/财联社/格隆汇) come from ONE
    //      locally-hosted RSSHub (news-sources.mjs's RSSHUB_ROUTES +
    //      DEFAULT_RSSHUB_BASE_URL = http://127.0.0.1:1200), so one container
    //      hiccup takes the ratio to 0 and destroyed the whole report. Measured
    //      2026-07-30: rsshub answers 200 on the mini and 000 from a dev box,
    //      which is exactly how a local `daily prepare` died on
    //      「报告质量校验失败：news.chinese_ratio」.
    //   2. THE FLOOR IS ALSO UNREACHABLE AT THE SPEC'S OWN SYMBOL POOL. The
    //      three Chinese feeds are fetched ONCE per run (they take no symbol),
    //      while the four English sources are fetched PER SYMBOL, so the ratio
    //      is 160/(160 + ~66N) for N searched symbols. Measured on the mini's
    //      2026-07-30 daily (N=1): 华尔街见闻 100 + 财联社 45 + 格隆汇 15 = 160 of
    //      226 sources = 70.80%, exactly the rendered number. At the mini's
    //      CURRENT pool (§0.4 union: QQQ.US + 5 active targets, N=6) the same
    //      arithmetic gives 28.8% - i.e. the next scheduled daily would have
    //      failed this gate with every source perfectly healthy.
    //
    // So a sub-floor ratio is no longer evidence of anything dishonest; it is a
    // collection-mix fact that the reader is entitled to be TOLD. What still
    // blocks is the absence of honesty, which is the same line every other gate
    // in this file draws:
    //
    //   blocks   the statistic line is GONE from a report that carries news
    //            (`:统计行缺失`) - the renderer lost a required number, and a
    //            reader would have no idea coverage was ever measured. Always
    //            recoverable: deliverReport re-renders a prepared file that
    //            fails a gate rather than hard-failing the run.
    //   blocks   the ratio is below the floor and the report does NOT carry the
    //            renderer's coverage disclosure (`:未披露`) - a thin number
    //            printed with no explanation of why.
    //   ships    the ratio is below the floor WITH that disclosure, which names
    //            the measured percentage, the health of each of the three
    //            Chinese feeds, and how many symbols diluted the pool.
    //
    // The disclosure marker is CHINESE_RATIO_DISCLOSURE_PREFIX, and
    // renderClusteredNewsSection emits it on exactly this condition - unlike
    // news.source_diversity_v2's 来源降级状态 escape above, which no
    // daily/weekly renderer has ever emitted (only stock-analysis.mjs does), so
    // that escape is dead code for this report family. The parity is proven by a
    // test that renders a REAL sub-floor report through renderDailyReport and
    // runs this function over it, not by a hand-typed fixture.
    if (newsLines.length > 0) {
      const chineseRatioPercent = extractChineseRatioPercent(text);
      if (chineseRatioPercent === null) {
        failures.push("news.chinese_ratio:统计行缺失");
      } else if (chineseRatioPercent < CHINESE_SOURCE_FLOOR_PERCENT && !hasChineseRatioDisclosure(text)) {
        failures.push(`news.chinese_ratio:未披露(${chineseRatioPercent}%)`);
      }
    }

    // Task 13 (2026-07-28 spec-drift plan) - report.conclusion_box.
    // Requirements §1.4/§3.5: a daily/weekly report leads with 核心结论 + 置信度
    // （高/中/低）+ 依据 + 截至时间. parseReportConclusionBox is the SAME parser
    // the renderer's box round-trips through and the platform's summary card
    // reads, so this gate fails for exactly the reason a reader would see
    // nothing: no box, a missing required bullet, or a confidence label that is
    // not one of the three tiers. Era-gated like every other new gate here -
    // a legacy-format report never had a box and is not retroactively broken;
    // everything the CURRENT renderer emits carries both markers, so for
    // anything generated from now on this gate is unconditional in effect.
    // scheduled-report.mjs's deliverReport treats an already-prepared file
    // without a box as STALE and re-renders it, exactly as it does for a file
    // carrying personal content, so this can never halt a scheduled run over a
    // file we know how to rebuild.
    if (parseReportConclusionBox(text) === null) {
      failures.push("report.conclusion_box");
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
// EXPORTED for the same reason as NEW_FORMAT_SECTION_MARKER above (Task 12):
// stock-analysis is its OWN report family with its OWN era boundary, so the
// platform must not judge a stock analysis by the daily/weekly marker (no
// stock-analysis report has ever contained 多源新闻（事件聚类）, so doing that
// would call every one of them legacy forever).
export const STOCK_CONCLUSION_BOX_MARKER = "### 结论框";

export function isNewFormatStockReport(text) {
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

// ---------------------------------------------------------------------------
// Valuation evidence: scope, vocabulary, and the four states a field can be in
// (2026-07-27, adversarial review of ca4cc52 - defects 1/2/3)
// ---------------------------------------------------------------------------

// Defect 3 - SCOPE. The PE/PB detectors used to run case-insensitively over
// the WHOLE report, so any English prose elsewhere in the document could
// satisfy them: a news headline containing "…Europe 5.5 percent…" reads as
// "pe 5.5" to /PE\s+[0-9,.]+/i, and a genuine silent valuation gap shipped
// masked by unrelated news text.
//
// Valuation evidence has exactly two renderer-owned homes
// (buildDeterministicAnalysis in stock-analysis.mjs):
//   - "- 估值补充：<summarizeValuation.summary>"      (基本面分析)
//   - "- 综合上行潜力：…；PE …；PB …；…"              (投资逻辑/基本面分析/结论)
// Both are anchored at the START of the renderer's own bullet, exactly like
// SOURCE_SUMMARY_LINE_PATTERN above.
//
// 2026-07-27, SECOND adversarial pass (defect 3). The original argument for
// line anchoring was "a news bullet cannot forge this, because
// renderDetailedNewsLine always opens with '- <时间> <代码>：'". That holds per
// LINE, but a news ITEM was not guaranteed to be one line: not every field it
// interpolates funnels through report-news.mjs's singleLine (a feed-supplied
// `titleZh`, a `publisher`), so external content carrying a line break emitted
// a SECOND line - starting wherever the attacker chose, e.g.
// "- 估值补充：PE 12.3；PB 4.5". Line anchoring then read it as first-party
// evidence. Two independent fixes, both landed:
//   1. renderDetailedNewsLine now collapses line breaks, so one item is one
//      line again (the source of the problem);
//   2. evidence extraction became STRUCTURAL rather than purely line-shaped -
//      lines inside a news section, and lines the narrative layer authored
//      ("- 叙事：…", NARRATIVE_BULLET_PREFIX imported from narrative-engine.mjs
//      rather than re-typed), are not evidence no matter how they are shaped.
// Either one alone closes the hole; together, a regression in one still leaves
// the gate honest.
const VALUATION_EVIDENCE_LINE_PATTERN = /^(?:-\s*)?(?:估值补充：|综合上行潜力：)/u;

// Defect 1: the SAME treatment for the upside gate. "综合上行潜力" used to be
// searched for (and "只看期权链" searched against) across the whole document.
// With the narrative additive, a model sentence containing "只看期权链" blocked
// every batch forever, while model prose that merely mentioned 综合上行潜力
// could satisfy the positive half with no deterministic bullet behind it.
const UPSIDE_EVIDENCE_LINE_PATTERN = /^(?:-\s*)?综合上行潜力：/u;
// An upside verdict drawn from the option chain alone is not "综合" (combined)
// - the renderer's own bullet always carries 目标价/PE/PB/趋势分 alongside it.
const OPTIONS_ONLY_UPSIDE_PATTERN = /只看期权链|只看期权/u;

// Every line of `text` that the RENDERER authored as first-party evidence:
// outside any news section, and not a narrative bullet. Deliberately
// structural - it does not care what the line says, only where it came from.
function extractDeterministicEvidenceLines(text) {
  const lines = [];
  let inNewsSection = false;
  for (const rawLine of String(text ?? "").split("\n")) {
    const trimmed = rawLine.trim();
    const heading = SECTION_HEADING_PATTERN.exec(trimmed);
    if (heading) {
      inNewsSection = NEWS_SECTION_HEADING_PATTERN.test(heading[1].trim());
      continue;
    }
    if (inNewsSection) {
      continue;
    }
    if (trimmed.startsWith(`- ${NARRATIVE_BULLET_PREFIX}`) || trimmed.startsWith(NARRATIVE_BULLET_PREFIX)) {
      continue;
    }
    // Belt and braces for a news bullet rendered outside a news section (no
    // current code path does this): a detailed news line always carries both
    // of these labels, and no deterministic evidence bullet carries either.
    if (/媒体：/u.test(trimmed) && /渠道：/u.test(trimmed)) {
      continue;
    }
    lines.push(trimmed);
  }
  return lines;
}

function extractValuationEvidence(text) {
  return extractDeterministicEvidenceLines(text)
    .filter((line) => VALUATION_EVIDENCE_LINE_PATTERN.test(line))
    .join("\n");
}

function extractUpsideEvidence(text) {
  return extractDeterministicEvidenceLines(text)
    .filter((line) => UPSIDE_EVIDENCE_LINE_PATTERN.test(line))
    .join("\n");
}

// The disclosure vocabulary is IMPORTED from the renderer (stock-analysis-
// metrics.mjs's VALUATION_DISCLOSURE), not re-typed here, so the gate and the
// text it judges can never drift apart. Each field is in exactly one of four
// states:
//   real          - an actual number ("PE 27.76")
//   inapplicable  - structurally absent, ETF only ("PE 不适用（ETF 无市盈率
//                   口径，……）"). Accepting this is scoped to the ETF branch as
//                   tightly as the renderer itself scopes it: the reason must
//                   be the EXACT sentence ETF_INAPPLICABLE_REASONS holds for
//                   that field, which summarizeValuation/summarizeUpsidePotential
//                   emit only when instrumentKind === "etf". An equity - which
//                   always HAS a P/E - can neither invent nor paraphrase its
//                   way into this state (defect 2).
//   unavailable   - the metric exists but no source returned it ("PE 不可得
//                   （来源未提供该字段：…）"), or summarizeValuation's whole-block
//                   failure ("估值读取失败：…"). Honest, reason-carrying, and
//                   therefore shippable (defect 1) - and textually distinct
//                   from the ETF case for the reader.
//   missing       - neither a value nor a reason: a bare "PE 暂无", a bare
//                   "PE 不可得" with no stated reason, or PE vanishing from the
//                   report entirely. This is the silent gap the gate exists
//                   to catch, and it still fails.
const VALUATION_STATE = { real: "real", inapplicable: "inapplicable", unavailable: "unavailable", missing: "missing" };

// Matches nothing, ever - the structural detector for a field the renderer has
// no structural reason for (an ETF still HAS a market cap, so "市值 不适用" is
// not a state this codebase can legitimately produce).
const NEVER_MATCHES_PATTERN = /(?!)/u;

function valuationFieldDetectors(label, field) {
  const structuralReason = ETF_INAPPLICABLE_REASONS[field];
  return {
    // A signed number counts as real too: summarizeUpsidePotential renders the
    // implied target upside as a percentage ("目标价隐含空间 +31.46%").
    real: new RegExp(`${label}\\s+(?!暂无)[+-]?[0-9][0-9,.]*`, "u"),
    inapplicable: structuralReason
      ? new RegExp(`${label}\\s*${VALUATION_DISCLOSURE.inapplicable}（${escapeRegExp(structuralReason)}）`, "u")
      : NEVER_MATCHES_PATTERN,
    unavailable: new RegExp(`${label}\\s*${VALUATION_DISCLOSURE.unavailable}（[^）]{4,}）`, "u")
  };
}

// summarizeValuation's whole-block failure branch: no source responded at all,
// so no per-field line is rendered - the single sentence names the reason for
// every field at once. Both spellings require an actual reason after them.
const VALUATION_BLOCK_DISCLOSED_PATTERN = /估值读取失败：\S{4,}|估值数据暂无可用（[^）]{4,}）/u;

const VALUATION_FIELD_DETECTORS = {
  pe: valuationFieldDetectors("PE", "pe"),
  pb: valuationFieldDetectors("PB", "pb"),
  // summarizeValuation writes "一年目标价 …", summarizeUpsidePotential writes
  // "目标价隐含空间 …" - one field, two renderer-owned labels.
  targetPrice: valuationFieldDetectors("(?:一年目标价|目标价隐含空间)", "targetPrice")
};

// The facts-coverage counterpart of classifyValuationField: one regex that
// matches EITHER disclosed state (structural or outage), built from the same
// detectors so the two can never diverge.
function valuationDisclosedPattern(field) {
  const detectors = VALUATION_FIELD_DETECTORS[field];
  return new RegExp(
    `${detectors.inapplicable.source}|${detectors.unavailable.source}|${VALUATION_BLOCK_DISCLOSED_PATTERN.source}`,
    "u"
  );
}

function classifyValuationField(valuationEvidence, field) {
  const detectors = VALUATION_FIELD_DETECTORS[field];
  if (detectors.real.test(valuationEvidence)) {
    return VALUATION_STATE.real;
  }
  if (detectors.inapplicable.test(valuationEvidence)) {
    return VALUATION_STATE.inapplicable;
  }
  if (detectors.unavailable.test(valuationEvidence) || VALUATION_BLOCK_DISCLOSED_PATTERN.test(valuationEvidence)) {
    return VALUATION_STATE.unavailable;
  }
  return VALUATION_STATE.missing;
}

// A fixed-label moving average is accounted for either by the whole-history
// disclosure (no rows at all) or, since 2026-07-27 (defect 5), by the
// per-window "N 日 不可得（样本不足 N 日，实际仅 M 个交易日）" sentence
// summarizeHistory/formatMovingAverage render when the sample is shorter than
// the window. INSUFFICIENT_SAMPLE_PREFIX and VALUATION_DISCLOSURE are imported
// from the renderer's own module, never re-typed here.
function movingAverageDisclosedPattern(windowDays) {
  return new RegExp(
    `历史走势(?:读取失败|暂无可用数据)|${windowDays}\\s*日\\s*${VALUATION_DISCLOSURE.unavailable}（${INSUFFICIENT_SAMPLE_PREFIX}[^）]{4,}）`,
    "u"
  );
}

const FACTS_COVERAGE_DETECTORS = {
  "quote.last": {
    backed: /最新价格[:：]\s*(?!暂无)[0-9]/u,
    disclosed: /现价数据不可得/u
  },
  "quote.pct": {
    backed: /涨跌幅[:：]\s*(?!暂无)[+-]?[0-9]/u,
    disclosed: /缺少前收数据/u
  },
  // Both valuation checkpoints read the SAME scoped evidence and the SAME
  // state machine the stock.valuation_depth gate below uses (`scope` narrows
  // the section text to the renderer's own valuation bullets first - see
  // extractValuationEvidence): "covered" here and "passes the gate" there can
  // never mean two different things.
  "valuation.pe": {
    scope: extractValuationEvidence,
    backed: VALUATION_FIELD_DETECTORS.pe.real,
    disclosed: valuationDisclosedPattern("pe")
  },
  "valuation.targetPrice": {
    scope: extractValuationEvidence,
    backed: VALUATION_FIELD_DETECTORS.targetPrice.real,
    disclosed: valuationDisclosedPattern("targetPrice")
  },
  "history.ma20": {
    backed: /均线[:：]\s*20\s*日\s*(?!暂无)[0-9]/u,
    disclosed: movingAverageDisclosedPattern(20)
  },
  "history.ma60": {
    backed: /60\s*日\s*(?!暂无)[0-9]/u,
    disclosed: movingAverageDisclosedPattern(60)
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

// Exported for tests: asserting "the gate passed" only proves >=6/8, which
// cannot tell a genuinely 8/8 disclosure set apart from one that squeaked
// through at exactly the threshold. Tests pin the exact count.
export function countFactsCoverage(sectionText) {
  return CONFIDENCE_COVERAGE_CHECKPOINTS.filter((key) => {
    const detector = FACTS_COVERAGE_DETECTORS[key];
    if (!detector) {
      return false;
    }
    // A detector may narrow the text it is allowed to look at (today: the two
    // valuation checkpoints, see extractValuationEvidence) - a checkpoint can
    // only ever be satisfied by the renderer's own evidence for THAT domain,
    // never by prose that happens to contain a lookalike token.
    const scoped = detector.scope ? detector.scope(sectionText) : sectionText;
    return detector.backed.test(scoped) || detector.disclosed.test(scoped);
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
  // Per-symbol scope. A batch renders one `## SYMBOL` section per target, and
  // every gate below judges ONE symbol's own evidence - a healthy sibling's
  // real PE must never cover another symbol's silent gap (2026-07-27 second
  // pass, defect 4: valuation_depth used to pool evidence batch-wide while
  // stock.facts_coverage was already per-symbol, so the two disagreed about
  // what "covered" means). A document with no symbol headings at all (a legacy
  // single-block report) is judged as one unnamed scope, exactly as before, so
  // this can never become a way for a gate to silently stop running.
  const symbolSections = extractStockSymbolSections(text);
  const symbolScopes = symbolSections.length > 0 ? symbolSections : [{ symbol: null, section: text }];
  for (const { symbol, section } of symbolScopes) {
    const scopeSuffix = symbol ? `:${symbol}` : "";

    // stock.valuation_depth: PE and PB must EACH be accounted for, judged only
    // against the renderer's own valuation evidence (extractValuationEvidence).
    // A field is accounted for when it carries a real number, or a disclosure
    // that states WHY it is absent - structurally (ETF) or because no source
    // returned it. Anything else (bare "暂无", a reason-less "不可得", or the
    // field vanishing entirely, which is how a paraphrasing narrative layer
    // used to break this) is a silent gap and still fails.
    //
    // 2026-07-27 review, defects 1+2: the previous form demanded a real PE AND
    // a real PB, else a disclosed PE AND a disclosed PB - which (1) refused the
    // whole-block "估值读取失败：…" disclosure the renderer actually emits when
    // every valuation source is down, blocking the entire batch forever with no
    // way to ship an honest report, (2) rejected the perfectly ordinary mixed
    // state (real PE, disclosed PB), and (3) accepted the ETF's structural
    // wording from an all-equity batch. Judging each field independently, with
    // the structural branch scoped to the ETF reason, fixes all three without
    // letting a single undisclosed gap through.
    const valuationEvidence = extractValuationEvidence(section);
    const valuationStates = [classifyValuationField(valuationEvidence, "pe"), classifyValuationField(valuationEvidence, "pb")];
    if (valuationStates.includes(VALUATION_STATE.missing)) {
      failures.push(`stock.valuation_depth${scopeSuffix}`);
    }

    // stock.upside_depth (defect 1): both halves read the renderer's own
    // "综合上行潜力：…" bullet and nothing else. Narrative prose can no longer
    // satisfy the positive half without a deterministic bullet behind it, nor
    // block an entire batch by containing the four characters "只看期权链".
    const upsideEvidence = extractUpsideEvidence(section);
    if (upsideEvidence === "" || OPTIONS_ONLY_UPSIDE_PATTERN.test(upsideEvidence)) {
      failures.push(`stock.upside_depth${scopeSuffix}`);
    }

    // News content gates (defect 2): a batch renders one 近期新闻 block PER
    // symbol, and extractNewsLines used to stop after the first, so symbols
    // 2..N shipped unchecked. These two judge the CONTENT of one symbol's own
    // news, so they are evaluated per symbol; stock.news_source_diversity
    // below stays batch-wide on purpose - the renderer's own degradation
    // notice ("本批次未读取到…") is a statement about the batch.
    const scopedNewsLines = symbol ? extractNewsLines(section) : newsLines;
    const scopedNewsText = scopedNewsLines.join("\n");
    if (GENERIC_NEWS_PATTERN.test(scopedNewsText)) {
      failures.push(`stock.news_generic_summary${scopeSuffix}`);
    }
    if (/英文摘要已读取|事件细节待核对/u.test(scopedNewsText)) {
      failures.push(`stock.news_translation${scopeSuffix}`);
    }
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

  // Phase 5 Task 4 (2026-07-15 plan) - new-format-only gates (see
  // isNewFormatStockReport above for the era-compatibility rule these are
  // gated behind). Both new gates are scoped PER `## SYMBOL` section
  // (extractStockSymbolSections) - a batch report can mix a well-formed
  // symbol with a corrupted one, and each symbol must be judged on its own.
  if (isNewFormatStockReport(text)) {
    for (const { symbol, section } of symbolSections) {
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

// 2026-07-27 (second adversarial pass, defect 2): this used to find the FIRST
// news heading and stop at the next heading. A stock-analysis batch renders one
// "### 近期新闻" block PER SYMBOL (renderBatchStockAnalysis), so every news gate
// - generic-summary, translation, detail depth, and the 媒体/渠道 labels
// extractSourceLabels harvests - only ever inspected symbol #1, and symbols
// 2..N shipped completely unchecked. Now EVERY news block in the document is
// collected; callers that need one symbol's own news pass that symbol's
// section text in (validateStockAnalysisMarkdown's per-symbol scope).
function extractNewsLines(markdown) {
  const collected = [];
  let inNewsSection = false;
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    const heading = SECTION_HEADING_PATTERN.exec(trimmed);
    if (heading) {
      inNewsSection = NEWS_SECTION_HEADING_PATTERN.test(heading[1].trim());
      continue;
    }
    if (!inNewsSection) {
      continue;
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
const SOURCE_SUMMARY_SECTION_HEADING_PATTERN = new RegExp(
  `^(?:证据与来源|${STOCK_NEWS_SECTION_TITLE}|${LEGACY_STOCK_NEWS_SECTION_TITLE}|${MULTI_SOURCE_NEWS_SECTION_TITLE})`,
  "u"
);

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

// §0.4's 中文源占比 target. Exported so the RENDERER decides whether to emit the
// coverage disclosure using the same number this gate judges with, rather than a
// second hand-typed 30 that could drift out from under it.
export const CHINESE_SOURCE_FLOOR_PERCENT = 30;

// The disclosure a sub-floor report must carry, in the same "- <label>：<facts>。"
// bullet style as 来源分布/中文源占比/事件稀少提示/链接核验. Exported and IMPORTED
// BY THE RENDERER (scheduled-report.mjs's renderClusteredNewsSection) for the
// same reason STOCK_NEWS_SECTION_TITLE is: the literal the renderer writes and
// the literal this gate looks for must be one string, not two.
export const CHINESE_RATIO_DISCLOSURE_PREFIX = "- 中文源覆盖不足";

function extractChineseRatioPercent(markdown) {
  return scanSourceSummaryLines(markdown, (line) => {
    const match = line.match(CHINESE_RATIO_LINE_PATTERN);
    return match ? Number(match[1]) : undefined;
  });
}

// Scoped exactly like extractChineseRatioPercent's own parse: only a bullet
// inside a section the report generator uses for source statistics counts, so a
// news headline quoting the disclosure wording cannot satisfy the gate.
function hasChineseRatioDisclosure(markdown) {
  return scanSourceSummaryLines(markdown, (line) => (line.startsWith(CHINESE_RATIO_DISCLOSURE_PREFIX) ? true : undefined)) === true;
}

// Walks the source-summary sections (### 证据与来源 / ### 多源新闻… / ###
// 近期新闻) and returns the first non-undefined value `pick` yields, else null.
function scanSourceSummaryLines(markdown, pick) {
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
    const picked = pick(line);
    if (picked !== undefined) {
      return picked;
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
// 2026-07-28 OUTAGE FIX, round 2 (2026-07-30). Round 1 replaced "any single
// unreachable URL fails" with an aggregate judgement, and the daily report
// STILL died every single day. Measured 2026-07-30 against the exact URLs in
// the crash logs - the HEAD/GET status pairs on the mini AND the dev box
// (identical), the response bodies from the dev box:
//
//   https://wallstreetcn.com/livenews/3141798 (real, cited by the mini's own
//        2026-07-30 daily report)
//        HEAD -> 404
//        GET  -> 200, <title>意大利和沙特重申支持落实“两国方案” - 华尔街见闻</title>
//   https://wallstreetcn.com/livenews/999999999 (invented)
//        HEAD -> 404
//        GET  -> 200, <title>404 Not Found - 华尔街见闻</title>
//   https://finance.sina.com.cn/nope-not-real-123 (invented) HEAD/GET 404/404
//   https://www.reuters.com/nonexistent-article-xyz (invented) HEAD/GET 401/401
//
// Two independent lessons, and the gate got both backwards:
//
//   1. A HEAD RESPONSE IS NEVER EVIDENCE THAT A RESOURCE DOES NOT EXIST.
//      wallstreetcn answers HEAD with 404 for every path it has, live
//      articles included. The old probe sent HEAD and only fell back to GET
//      on 405, so every wallstreetcn citation was classified "does not
//      exist" - fabrication-grade evidence - and two of them per day crossed
//      the threshold and destroyed the report. Nothing is called missing now
//      unless a GET said so.
//
//   2. A 200 IS NOT EVIDENCE THAT IT DOES. wallstreetcn is a SPA that serves
//      HTTP 200 with its own "404 Not Found" page for invented paths, so
//      status alone cannot tell a real citation from a fabricated one at the
//      publisher this pipeline cites most. The body's <title> can, and that
//      is the only extra thing read (see NOT_FOUND_TITLE_MARKERS).
//
// Evidence model - only the first tier may block delivery:
//
//   missing  (blocks)   a GET returned 404/410, or a GET returned <400 whose
//                       <title> is the origin's own not-found page. Both are
//                       the origin stating, over the method that actually
//                       serves the resource, that it is not there. This is
//                       what a fabricated link looks like.
//   exists   (passes)   a GET returned <400 and the title is a real one.
//   unverified (discloses, NEVER blocks) everything else: HEAD-only answers,
//                       401/403 auth walls (reuters answers 401 for invented
//                       paths too, so it proves neither direction), 405,
//                       429, 5xx, other 4xx, network errors, timeouts, an
//                       exhausted time budget, a runtime with no fetch, a
//                       body we could not read.
//
// FAIL policy - `missing` is the only input:
//   - >= URL_HARD_FAILURE_THRESHOLD confirmed-missing links -> fail. One is
//     ordinary link rot (news orgs unpublish and re-slug constantly); two
//     independent confirmed "not there" answers in a 5-link sample is the
//     fabrication signal.
//   - every link we managed to probe came back confirmed-missing (and at
//     least one did) -> fail. A wholly invented source list resolves nowhere.
//     This deliberately no longer fires on transient outcomes: under the old
//     rule a 10-second network blip that timed out all 5 probes destroyed the
//     report, which is the same bug in a different costume.
//   - otherwise pass, and report `unverified` so the caller DISCLOSES it.
//     Never let "we could not check" print as "verified".
export const URL_HARD_FAILURE_THRESHOLD = 2;

// The whole check runs inside deliverReport, so it gets a wall-clock ceiling:
// 5 URLs x 2 attempts x a 5s timeout is already 50s of a delivery path,
// before the plain-GET retry below is counted. Once the budget is spent the
// remaining URLs are left unprobed and disclosed as such - honest, and it can
// never block, because only a GET that actually answered can produce
// `missing`.
export const URL_CHECK_BUDGET_MS = 20000;

// Bodies are read only to spot an origin's own not-found page, and only the
// <title> is inspected - matching anywhere in the document would misfire on
// any article that merely discusses a 404. The GET asks for the first 64KB,
// which is far past </title> on every publisher this pipeline cites.
//
// What this does NOT catch, stated plainly so nobody reads more into a clean
// gate than it earned: a publisher that answers an invented path with a
// success status and no not-found label. Measured 2026-07-30, cls.cn answers
// an invented /detail/ path with 200 and an EMPTY <title> - it never says
// "not found" - so a fabricated cls.cn link classifies `exists` here. An
// empty title is deliberately NOT treated as evidence of absence: plenty of
// real pages render one. The gate catches publishers that return a real 404
// and soft-404 pages that label themselves; it is not a universal
// fabrication detector.
const URL_BODY_SNIFF_BYTES = 65536;
const URL_MAX_SNIFF_CONTENT_LENGTH = 5000000;
const NOT_FOUND_TITLE_MARKERS = [
  /(?<!\d)404(?!\d)/u,
  /not\s*found/iu,
  /page\s+not\s+available/iu,
  /页面?不存在/u,
  /内容不存在/u,
  /文章不存在/u,
  /页面走丢/u,
  /找不到(该|这|此)?(页面|内容|文章)/u
];

export async function validateReportUrls(
  markdown,
  { fetchImpl, sampleSize = 5, timeoutMs = 5000, retryDelayMs = 400, budgetMs = URL_CHECK_BUDGET_MS } = {}
) {
  const text = normalizeText(markdown);
  if (!isNewFormatReport(text)) {
    return buildUrlResult({ failures: [], unverified: [], sampled: 0, probed: 0 });
  }

  const urls = extractReportUrls(text);
  const sample = urls.length <= sampleSize ? urls : urls.slice(0, sampleSize);
  const missing = [];
  const unverified = [];
  let probedCount = 0;
  const deadline = Date.now() + budgetMs;
  for (const url of sample) {
    // eslint-disable-next-line no-await-in-loop -- sequential checks keep the
    // failure list deterministically ordered and keep this trivially testable
    // with a simple fake fetchImpl; at most `sampleSize` (5) of them run.
    const verdict = await classifyUrl(url, { fetchImpl, timeoutMs, retryDelayMs, deadline });
    if (verdict.probed) {
      probedCount += 1;
    }
    if (verdict.status === "exists") {
      continue;
    }
    if (verdict.status === "missing") {
      missing.push(`news.url_reachability:${url}`);
    }
    unverified.push({ url, reason: verdict.reason, status: verdict.status });
  }

  const unverifiable = probedCount === 0 && sample.length > 0;
  // Only confirmed-missing links can block. `allConfirmedMissing` is the
  // wholly-invented-source-list case: EVERY sampled link came back confirmed
  // missing. It is deliberately not "every link that answered", which would
  // let one 404 plus two timeouts destroy a report on the strength of a
  // single data point; if anything went unverified, "it all resolves nowhere"
  // has not been established. In practice this only adds reach beyond the
  // threshold for a one-link sample - which is exactly the gap it is for.
  const allConfirmedMissing = missing.length > 0 && missing.length === sample.length;
  const failures = missing.length >= URL_HARD_FAILURE_THRESHOLD || allConfirmedMissing ? [...missing] : [];

  return buildUrlResult({
    failures,
    unverified,
    sampled: sample.length,
    probed: probedCount,
    hardCount: missing.length,
    unverifiable
  });
}

function buildUrlResult({ failures, unverified, sampled, probed, hardCount = 0, unverifiable = false }) {
  const base = buildResult(failures);
  return {
    ...base,
    sampled,
    probed,
    hardCount,
    unverifiable,
    unverified,
    // A one-line, honest disclosure the report can carry verbatim. Only
    // produced when something really was left unverified AND the gate passed
    // (a failing gate blocks delivery, so there is nothing to disclose).
    disclosure: base.ok && unverified.length > 0 ? buildUrlDisclosure({ sampled, unverified, unverifiable }) : null
  };
}

// Matches the report's existing tail-statistics bullet style (来源分布 /
// 中文源占比 / 事件稀少提示): a single "- <label>：<facts>。" line.
export const URL_DISCLOSURE_PREFIX = "- 链接核验";

// The two things a reader must be able to tell apart: a link we could not
// check, and a link we checked and found dead. Lumping them together was the
// old text's flaw - "未核验不等于已确认失效" is true of the first and false of
// the second.
function buildUrlDisclosure({ sampled, unverified, unverifiable }) {
  const confirmedDead = unverified.filter((entry) => entry.status === "missing");
  const stillOpen = unverified.filter((entry) => entry.status !== "missing");
  const parts = [];
  if (stillOpen.length > 0) {
    const reasons = Array.from(new Set(stillOpen.map((entry) => entry.reason)));
    const onlyNoFetch = reasons.length === 1 && reasons[0] === URL_NO_FETCH_REASON;
    const why = unverifiable && onlyNoFetch ? "运行环境不具备联网核验能力" : reasons.join("、");
    parts.push(`${stillOpen.length} 条未能核验（${why}），未核验不等于链接已确认有效，也不等于已确认失效`);
  }
  if (confirmedDead.length > 0) {
    const reasons = Array.from(new Set(confirmedDead.map((entry) => entry.reason)));
    parts.push(`${confirmedDead.length} 条经 GET 复核确认打不开（${reasons.join("、")}），原文可能已下线或改址`);
  }
  return `${URL_DISCLOSURE_PREFIX}：抽样 ${sampled} 条原文链接，其中 ${parts.join("；")}。`;
}

function extractReportUrls(markdown) {
  const urls = new Set();
  for (const match of markdown.matchAll(/https?:\/\/[^\s)\]）。；"'<>]+/gu)) {
    urls.add(match[0]);
  }
  return Array.from(urls);
}

// 404/410 from a GET is the only status that means "this resource is not
// here". The same status from a HEAD means nothing: wallstreetcn.com answers
// HEAD 404 for its own live articles (measured above), so this gate never
// sends HEAD - the GET a reader's browser would send is the only probe whose
// answer it acts on.
const HARD_MISSING_STATUSES = new Set([404, 410]);
// A ranged GET is the polite default, but some origins reject Range outright
// (405 on the ranged form, 416, 501). Retry those once as a plain GET before
// concluding anything.
const RANGE_REJECTED_STATUSES = new Set([405, 416, 501]);
export const URL_NO_FETCH_REASON = "运行时无 fetch";
const URL_BUDGET_SPENT_REASON = "核验预算耗尽";

// A TRUTHFUL user agent, and the measurement that argues for it. The obvious
// move is to pretend to be a browser, on the theory that publishers serve
// bots worse. Measured on 2026-07-30 the opposite is true where it matters -
// same URLs, same second, only the UA differing:
//
//   wallstreetcn.com/livenews/3141798 (real)     browser UA -> 200, 2871 B,
//       <title>华尔街见闻</title>          (an empty client-rendered shell)
//                                                bot UA     -> 200, 19357 B,
//       <title>意大利和沙特重申支持落实“两国方案” - 华尔街见闻</title>
//   wallstreetcn.com/livenews/999999999 (invented) bot UA   -> 200, 13051 B,
//       <title>404 Not Found - 华尔街见闻</title>
//
// wallstreetcn server-renders for crawlers and ships a JS shell to browsers,
// so a browser UA erases the ONLY signal that separates a real citation from
// an invented one there. cls.cn answered identically to both; sina and
// reuters answered by status alone. So: say who we are, take the SSR page.
const URL_PROBE_HEADERS = {
  "User-Agent": "OpenClawReportLinkCheck/1.0 (+citation verification for OpenClaw trading reports)",
  Accept: "*/*"
};

async function classifyUrl(url, { fetchImpl, timeoutMs, retryDelayMs, deadline = Infinity }) {
  const impl = fetchImpl ?? globalThis.fetch;
  if (typeof impl !== "function") {
    return { status: "unverified", reason: URL_NO_FETCH_REASON, probed: false };
  }
  if (Date.now() >= deadline) {
    return { status: "unverified", reason: URL_BUDGET_SPENT_REASON, probed: false };
  }
  // One retry with backoff: rate-limits and transient 5xx/network blips are
  // overwhelmingly one-shot, and a second attempt is cheap at sampleSize 5.
  // A confirmed answer - exists OR missing - is never retried; the origin
  // already told us, and retrying only burns the delivery budget.
  let last = { status: "unverified", reason: "网络异常", probed: true };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      if (Date.now() >= deadline) {
        return last;
      }
      if (retryDelayMs > 0) {
        // eslint-disable-next-line no-await-in-loop -- deliberate backoff
        await new Promise((resolve) => { setTimeout(resolve, retryDelayMs); });
      }
    }
    const budgetLeft = deadline - Date.now();
    const attemptTimeoutMs = Number.isFinite(budgetLeft) ? Math.max(1, Math.min(timeoutMs, budgetLeft)) : timeoutMs;
    // eslint-disable-next-line no-await-in-loop -- sequential by design
    last = await probeUrlOnce(url, { impl, timeoutMs: attemptTimeoutMs });
    if (last.status === "exists" || last.status === "missing") {
      return last;
    }
  }
  return last;
}

async function probeUrlOnce(url, { impl, timeoutMs }) {
  let outcome = await requestUrl(url, {
    impl,
    timeoutMs,
    method: "GET",
    headers: { ...URL_PROBE_HEADERS, Range: `bytes=0-${URL_BODY_SNIFF_BYTES - 1}` }
  });
  if (outcome.status === "http" && RANGE_REJECTED_STATUSES.has(outcome.code)) {
    outcome = await requestUrl(url, { impl, timeoutMs, method: "GET", headers: { ...URL_PROBE_HEADERS } });
  }
  return interpret(outcome);
}

function interpret(outcome) {
  if (outcome.status === "error") {
    return { status: "unverified", reason: outcome.reason, probed: true };
  }
  if (!(outcome.code > 0)) {
    // A response carrying no usable status tells us nothing definitive -
    // never read it as "does not exist".
    return { status: "unverified", reason: "无状态码响应", probed: true };
  }
  if (HARD_MISSING_STATUSES.has(outcome.code)) {
    return { status: "missing", reason: `HTTP ${outcome.code}`, probed: true };
  }
  if (outcome.code < 400) {
    if (outcome.notFoundBody) {
      // A soft 404: the origin served its own not-found page under a success
      // status. wallstreetcn.com does exactly this for invented paths.
      return { status: "missing", reason: `HTTP ${outcome.code} + 站内“未找到”页`, probed: true };
    }
    return { status: "exists", probed: true };
  }
  // 401/403 auth walls land here too: reuters.com answers 401 for invented
  // paths as well as real ones, so an auth challenge proves neither
  // direction and must not count as proof the resource exists.
  return { status: "unverified", reason: `HTTP ${outcome.code}`, probed: true };
}

async function requestUrl(url, { impl, timeoutMs, method, headers }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await impl(url, { method, signal: controller.signal, ...(headers ? { headers } : {}) });
    // A fetchImpl that returns nothing at all is a broken stub, not evidence
    // about the URL.
    if (!response || typeof response !== "object") {
      return { status: "error", reason: "无响应" };
    }
    const code = typeof response.status === "number" ? response.status : (response.ok ? 200 : 0);
    const notFoundBody = code > 0 && code < 400 ? await detectNotFoundBody(response) : false;
    return { status: "http", ok: Boolean(response.ok), code, notFoundBody };
  } catch (error) {
    return { status: "error", reason: error?.name === "AbortError" ? "请求超时" : "网络异常" };
  } finally {
    clearTimeout(timer);
  }
}

// Returns true ONLY when the body was actually read and its <title> is the
// origin's own not-found page. Every other path returns false, including a
// body we could not read: not reading something is never evidence about what
// it said, and this value is the one thing that can turn a 200 into
// fabrication-grade evidence.
async function detectNotFoundBody(response) {
  if (typeof response.text !== "function") {
    return false;
  }
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > URL_MAX_SNIFF_CONTENT_LENGTH) {
    return false;
  }
  let body;
  try {
    body = await response.text();
  } catch {
    return false;
  }
  if (typeof body !== "string" || body.length === 0) {
    return false;
  }
  const match = /<title[^>]*>([\s\S]{0,300}?)<\/title>/iu.exec(body.slice(0, URL_BODY_SNIFF_BYTES));
  if (!match) {
    return false;
  }
  const title = match[1].trim();
  return NOT_FOUND_TITLE_MARKERS.some((pattern) => pattern.test(title));
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
// A wall-clock reading is a TIMESTAMP, never a claim about the security, so it
// is stripped for the same reason the ISO date above is. Without this,
// renderSymbolAsOfBullet's 「行情时点 2026-07-30 04:00（北京时间）」 fed the
// matcher the bare tokens 04 and 00, and every symbol failed
// stock.numeric_match on its own freshness disclosure - measured on the live
// 2026-07-30 batch, which is how this was found.
const STOCK_CLOCK_TIME_PATTERN = /\d{1,2}:\d{2}(?::\d{2})?/gu;
// The same bullet states the report's own refresh cadence (「个股分析每 3 天更新
// 一次」). That number describes THIS PIPELINE, not the security, so no
// stock_facts row could ever back it. Anchored on the surrounding words rather
// than on the digit so a changed interval needs no edit here.
const STOCK_SELF_CADENCE_PATTERN = /每\s*\d+\s*天更新一次/gu;
const STOCK_NUMBER_TOKEN_PATTERN = /-?\d[\d,]*\.?\d*/gu;
const STOCK_DEGRADE_MARKER_PATTERN = new RegExp(
  `${escapeRegExp(NUMERIC_DEGRADE_MARKER)}|${escapeRegExp(NON_CHINESE_DEGRADE_MARKER)}`,
  "u"
);
const EXEMPT_STOCK_SUBSECTION_HEADINGS = new Set([
  "结论框",
  STOCK_NEWS_SECTION_TITLE,
  LEGACY_STOCK_NEWS_SECTION_TITLE
]);

function extractStockNumberTokens(text) {
  // Order matters: the clock strip must run while the date is still adjacent,
  // and the cadence phrase must go before the bare-number sweep sees its digit.
  const withoutDates = String(text ?? "")
    .replace(STOCK_ISO_DATE_PATTERN, "")
    .replace(STOCK_CLOCK_TIME_PATTERN, "")
    .replace(STOCK_SELF_CADENCE_PATTERN, "");
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

// 2026-07-27 - `deterministicTextBySymbol`: the SECOND legitimate origin a
// number in a rendered section can have. Since the narrative layer became
// ADDITIVE (stock-analysis.mjs's sectionValues renders
// buildDeterministicAnalysis's own bullets unconditionally and appends the
// LLM's prose after them, instead of replacing them), every section now
// carries first-party deterministic text on every run - not only on the
// whole-symbol-degrade path exemption 1 covers. That deterministic text
// legitimately states numbers that are DERIVED rather than copied from a
// single stock_facts row: the three-path probabilities, historyStats'
// trendScore and vs-long-average percentage, the "20 日"/"60 日" window
// labels, the sample-size count, and the HTTP status code inside a
// disclosure sentence. Re-deriving those inside this gate would duplicate
// buildDeterministicAnalysis; ignoring the sections wholesale would blind the
// gate to the narrative text sitting in the same block.
//
// So a token passes when it is EITHER within tolerance of one of that
// symbol's stock_facts values, OR appears verbatim (same numeric value) in
// that symbol's own pre-render deterministic text - which runAnalysis builds
// from `record.analysis`, i.e. from the object graph, never from the markdown
// being validated. A hand-edited/tampered number in the rendered markdown
// therefore still fails: changing "最新价格：213.00" to "218.70" matches
// neither a fact nor the deterministic text it was rendered from. Callers
// that pass no deterministic text (legacy callers, ad-hoc validation) get
// exactly the previous facts-only behaviour.
function collectDeterministicNumbers(deterministicText) {
  const values = new Set();
  for (const token of extractStockNumberTokens(deterministicText)) {
    values.add(token.value);
  }
  return values;
}

export function validateStockNarrativeNumbers(
  markdown,
  factsBySymbol = {},
  { pctTolerance = 0.1, priceTolerance = 0.01, deterministicTextBySymbol = {} } = {}
) {
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
    const deterministicValues = collectDeterministicNumbers(deterministicTextBySymbol[symbol]);
    for (const block of splitStockSubsections(section)) {
      if (EXEMPT_STOCK_SUBSECTION_HEADINGS.has(block.heading) || STOCK_DEGRADE_MARKER_PATTERN.test(block.body)) {
        // Exemptions 2/3/4 - see this function's header.
        continue;
      }
      for (const token of extractStockNumberTokens(block.body)) {
        const tolerance = token.kind === "pct" ? pctTolerance : priceTolerance;
        const matched = deterministicValues.has(token.value)
          || factValues.some((value) => Math.abs(value - token.value) <= tolerance);
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
