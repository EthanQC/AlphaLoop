const GENERIC_NEWS_PATTERN = /媒体报道与.+相关的公司新闻/u;
const LONG_ENGLISH_WORD_PATTERN = /(?:\b[A-Za-z][A-Za-z'-]{2,}\b[\s,.:;!?()/-]*){18,}/u;

export function validateReportMarkdown(markdown, { kind = "daily" } = {}) {
  const text = normalizeText(markdown);
  const failures = [];
  const newsLines = extractNewsLines(text);
  const sourceLabels = extractSourceLabels(text, newsLines);
  const nonLongbridgeSourceCount = sourceLabels.filter((source) => !/longbridge/iu.test(source)).length;

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
