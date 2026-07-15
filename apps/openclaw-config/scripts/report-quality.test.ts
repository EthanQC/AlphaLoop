import { describe, expect, it } from "vitest";

import {
  validateNarrativeNumbers,
  validateReportMarkdown,
  validateReportUrls,
  validateStockAnalysisMarkdown,
  validateStockNarrativeNumbers
} from "./report-quality.mjs";
import { buildStockFacts } from "./report-facts.mjs";
import { buildDeterministicAnalysis, renderBatchStockAnalysis } from "./stock-analysis.mjs";

describe("report quality gate", () => {
  it("rejects daily or weekly reports that still rely on Longbridge-only generic news", () => {
    const markdown = [
      "# OpenClaw 日报 2026-06-14",
      "",
      "## 2. 信息收集与分类",
      "",
      "- 新闻来源分布：Longbridge 5 条。",
      "",
      "### 多源新闻（中文摘要与来源）",
      "",
      "- 2026-06-14 12:04 QQQ.US：媒体报道与纳指 100 ETF相关的公司新闻；媒体：Longbridge；渠道：Longbridge；影响：作为新闻线索纳入观察，先不直接提高仓位；链接：https://longbridge.com/news/289679307。",
      "- 2026-06-13 12:03 QQQ.US：媒体报道与纳指 100 ETF相关的公司新闻；媒体：Longbridge；渠道：Longbridge；原始标题：Trade tokenized Apple, Tesla, and SpaceX on Uniswap (UNI) - traditional assets go on-chain. Explore the impact. #cryptonews；影响：作为新闻线索纳入观察，先不直接提高仓位；链接：https://longbridge.com/news/289654766。",
      "- 2026-06-13 09:33 QQQ.US：纳指 100 ETF新闻：事件细节待核对；媒体：Longbridge；渠道：Longbridge；标题要点：英文摘要已读取，需回到原文核对具体细节；原始标题：Unclassified market note；影响：作为新闻线索纳入观察，先不直接提高仓位；链接：https://longbridge.com/news/1。",
      "",
      "## 4. QQQ 固定观察",
      "",
      "- 最新价：721.34；前收：717.12；区间涨跌：4.22 / 0.59%"
    ].join("\n");

    const result = validateReportMarkdown(markdown, { kind: "daily" });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("news.source_diversity");
    expect(result.failures).toContain("news.generic_chinese_summary");
    expect(result.failures).toContain("news.detail_depth");
    expect(result.failures).toContain("news.translation");
  });

  it("accepts reports with diversified detailed Chinese news evidence", () => {
    const markdown = [
      "# OpenClaw 周报 2026-06-14",
      "",
      "## 2. 市场主线回顾与分类",
      "",
      "- 新闻来源分布：Longbridge 2 条；Yahoo Finance/Investor's Business Daily 1 条；Yahoo Finance/Barchart 1 条；Reuters 1 条。",
      "",
      "### 市场叙事与分类结论",
      "",
      "- 主线：小盘股、利率和科技股轮动共同影响风险偏好；当前偏中性观察。",
      "- 基本面：半导体和 AI 资本开支可能影响盈利预期，其他新闻主要影响情绪。",
      "",
      "### 多源新闻（中文摘要与来源）",
      "",
      "- 2026-06-13 21:55 QQQ.US：美股下周需要关注小盘股和利率信号；媒体：Investor's Business Daily；渠道：Yahoo Finance；标题要点：中文摘要说明小盘股、利率和科技股轮动；原始标题：Stock Market Week Ahead: Keep An Eye On The Little Things；分类：待验证；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；影响：作为风险偏好和板块轮动线索；链接：[原文](https://finance.yahoo.com/example-ibd)。",
      "- 2026-06-13 04:39 QQQ.US：美股在停火预期和科技股支撑下反弹；媒体：Barchart；渠道：Yahoo Finance；标题要点：中文摘要说明指数反弹、科技股和风险情绪改善；原始标题：Stocks Rally on Hopes for a Truce；分类：利好；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；影响：偏利好风险偏好但需成交量确认；链接：[原文](https://finance.yahoo.com/example-barchart)。",
      "- 2026-06-12 22:10 QQQ.US：半导体需求和 AI 资本开支继续支撑纳指权重；媒体：Reuters；渠道：Reuters；标题要点：中文摘要说明 AI 投资、芯片需求和盈利预期；原始标题：Chip demand supports Nasdaq leaders；分类：利好；基本面：可能影响基本面，需原始公告确认；影响：可能影响盈利预期，需要核对公司公告；链接：[原文](https://www.reuters.com/example-chip-demand)。",
      "",
      "### 宏观日历",
      "",
      "- 2026-06-18 20:30 美国费城联储制造业指数（前值-- / 预测12 / 公告--）",
      "",
      "## 3. QQQ 与美股风险温度",
      "",
      "- 最新价：721.34；前收：717.12；区间涨跌：4.22 / 0.59%"
    ].join("\n");

    const result = validateReportMarkdown(markdown, { kind: "weekly" });

    expect(result).toEqual({
      ok: true,
      failures: []
    });
  });

  it("passes a quiet-news-day report (<3 events) that explicitly discloses the scarcity, but never an empty or undisclosed one", () => {
    const buildQuietDay = ({ withDisclosure, lineCount }: { withDisclosure: boolean; lineCount: number }) => {
      const newsLines = [
        "- 2026-06-13 21:55 QQQ.US：美股下周需要关注小盘股和利率信号；媒体：Investor's Business Daily；渠道：Yahoo Finance；标题要点：中文摘要说明小盘股、利率和科技股轮动；原始标题：Stock Market Week Ahead；分类：待验证；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；影响：作为风险偏好线索；链接：[原文](https://finance.yahoo.com/example-ibd)。",
        "- 2026-06-13 04:39 QQQ.US：美股在停火预期和科技股支撑下反弹；媒体：Barchart；渠道：Yahoo Finance；标题要点：中文摘要说明指数反弹与风险情绪改善；原始标题：Stocks Rally；分类：利好；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；影响：偏利好但需成交量确认；链接：[原文](https://finance.yahoo.com/example-barchart)。"
      ].slice(0, lineCount);
      return [
        "# OpenClaw 日报 2026-07-15",
        "",
        "- 新闻来源分布：Yahoo Finance/Investor's Business Daily 1 条；Yahoo Finance/Barchart 1 条。",
        "",
        "### 多源新闻（中文摘要与来源）",
        "",
        ...newsLines,
        ...(withDisclosure ? ["- 事件稀少提示：本窗口仅聚类出 2 件事件（少于常规 3 件），已全部呈现，无遗漏。"] : []),
        "",
        "### 宏观日历",
        "",
        "- 2026-07-16 20:30 美国零售销售（前值-- / 预测0.2% / 公告--）",
        "",
        "## 3. QQQ 与美股风险温度",
        "",
        "- 最新价：740.62；前收：722.51；区间涨跌：18.11 / 2.51%"
      ].join("\n");
    };

    // Disclosed scarcity with >=1 real line: detail_depth passes.
    const disclosed = validateReportMarkdown(buildQuietDay({ withDisclosure: true, lineCount: 2 }), { kind: "daily" });
    expect(disclosed.failures).not.toContain("news.detail_depth");

    // Same thin report WITHOUT the disclosure: still rejected.
    const undisclosed = validateReportMarkdown(buildQuietDay({ withDisclosure: false, lineCount: 2 }), { kind: "daily" });
    expect(undisclosed.failures).toContain("news.detail_depth");

    // Disclosure cannot ship an EMPTY section (zero lines still fails).
    const empty = validateReportMarkdown(buildQuietDay({ withDisclosure: true, lineCount: 0 }), { kind: "daily" });
    expect(empty.failures).toContain("news.detail_depth");
  });

  it("rejects reports that repeat template checklists or duplicate news classification blocks", () => {
    const markdown = [
      "# OpenClaw 日报 2026-06-14",
      "",
      "## 1. 今日结论",
      "",
      "- 市场信号：QQQ 最新价 721.34。",
      "",
      "## 2. 信息收集与分类",
      "",
      "### daily-routine.md 检查清单",
      "",
      "- 新闻",
      "- 企业近况",
      "",
      "### 利好/利空/基本面影响",
      "",
      "- 2026-06-13 QQQ.US：重复的新闻分类。",
      "",
      "### 多源新闻（中文摘要与来源）",
      "",
      "- 2026-06-13 21:55 QQQ.US：美股下周需要关注小盘股和利率信号；媒体：Investor's Business Daily；渠道：Yahoo Finance；标题要点：中文摘要说明小盘股、利率和科技股轮动；原始标题：Stock Market Week Ahead: Keep An Eye On The Little Things；分类：待验证；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；影响：作为风险偏好和板块轮动线索；链接：[原文](https://finance.yahoo.com/example-ibd)。",
      "- 2026-06-13 04:39 QQQ.US：美股在停火预期和科技股支撑下反弹；媒体：Barchart；渠道：Yahoo Finance；标题要点：中文摘要说明指数反弹、科技股和风险情绪改善；原始标题：Stocks Rally on Hopes for a Truce；分类：利好；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；影响：偏利好风险偏好但需成交量确认；链接：[原文](https://finance.yahoo.com/example-barchart)。",
      "- 2026-06-12 22:10 QQQ.US：半导体需求和 AI 资本开支继续支撑纳指权重；媒体：Reuters；渠道：Reuters；标题要点：中文摘要说明 AI 投资、芯片需求和盈利预期；原始标题：Chip demand supports Nasdaq leaders；分类：利好；基本面：可能影响基本面，需原始公告确认；影响：可能影响盈利预期，需要核对公司公告；链接：[原文](https://www.reuters.com/example-chip-demand)。",
      "",
      "### 宏观日历",
      "",
      "- 2026-06-18 20:30 美国费城联储制造业指数（前值-- / 预测12 / 公告--）",
      "",
      "## 4. QQQ 固定观察",
      "",
      "- 最新价：721.34；前收：717.12；区间涨跌：4.22 / 0.59%"
    ].join("\n");

    const result = validateReportMarkdown(markdown, { kind: "daily" });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("readability.template_checklist");
    expect(result.failures).toContain("readability.duplicate_news_classification");
  });

  it("requires stock analysis to combine valuation, upside, trend, and option-chain evidence", () => {
    const markdown = [
      "# OpenClaw 个股分析 2026-06-14",
      "",
      "## AAPL",
      "",
      "### 基本面分析",
      "",
      "- 估值补充：PE 暂无，PB 暂无。",
      "- 上行潜力：只看期权链压力，缺少估值和目标价依据。",
      "",
      "### 市场表现与交易层面",
      "",
      "- 均线：20 日 201.00；60 日 195.00；180 日 188.00。",
      "",
      "### 期权交割与阻力支撑",
      "",
      "- 期权链只读补充：看涨合约较多。",
      "",
      "### 近期新闻",
      "",
      "- 来源分布：Longbridge 3 条。"
    ].join("\n");

    const result = validateStockAnalysisMarkdown(markdown);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("stock.valuation_depth");
    expect(result.failures).toContain("stock.news_source_diversity");
  });

  // Task H7 (2026-07-14 legacy audit): a whole-batch Longbridge-only news
  // degradation used to be rejected by this exact gate every time, even
  // though the renderer explicitly discloses it - meaning no report could
  // ever be delivered during a routine external-news outage.
  it("passes an explicitly-disclosed Longbridge-only news degradation instead of rejecting it forever", () => {
    const markdown = [
      "# OpenClaw 个股分析 2026-07-14",
      "",
      "## AAPL",
      "",
      "### 基本面分析",
      "",
      "- 估值补充：PE 28.10，PB 12.30。",
      "- 上行潜力：综合上行潜力：中性偏多，需结合估值和目标价确认。",
      "",
      "### 市场表现与交易层面",
      "",
      "- 均线：20 日 201.00；60 日 195.00；126 日 188.00。",
      "",
      "### 期权交割与阻力支撑",
      "",
      "- 期权链只读补充：看涨合约较多。",
      "",
      "### 近期新闻",
      "",
      "- 来源分布：Longbridge 3 条。",
      "- 来源提示：本批次未读取到可展示的非 Longbridge 新闻，已保留来源降级状态。"
    ].join("\n");

    const result = validateStockAnalysisMarkdown(markdown);

    expect(result.failures).not.toContain("stock.news_source_diversity");
  });

  it("still rejects an UNDISCLOSED Longbridge-only report (no explicit degradation notice)", () => {
    const markdown = [
      "# OpenClaw 个股分析 2026-07-14",
      "",
      "## AAPL",
      "",
      "### 近期新闻",
      "",
      "- 来源分布：Longbridge 3 条。"
    ].join("\n");

    const result = validateStockAnalysisMarkdown(markdown);

    expect(result.failures).toContain("stock.news_source_diversity");
  });

  // #32 audit fix regression: extractSourceLabels used to scan every line
  // of the whole markdown for "来源分布："/"新闻来源分布：" with no section
  // scoping, so a news TITLE that happened to contain that exact phrase
  // could forge fake source diversity (bypassing news.source_diversity)
  // while simultaneously getting itself stripped from news.detail_depth
  // counting via the same substring match. Neither must happen: the forged
  // phrase only lives inside a news item's own title fields, never inside
  // the report's own "### 证据与来源" summary section.
  it("does not let a forged 来源分布 phrase inside a news title manufacture source diversity or evade detail_depth counting", () => {
    const markdown = [
      "# OpenClaw 日报 2026-06-14",
      "",
      "## 2. 信息收集与分类",
      "",
      "### 证据与来源",
      "",
      "- 新闻来源分布：Longbridge 3 条。",
      "",
      "### 多源新闻（中文摘要与来源）",
      "",
      "- 2026-06-14 12:04 QQQ.US：纳指新闻更新；媒体：Longbridge；渠道：Longbridge；标题要点：纳指新闻更新；原始标题：Nasdaq futures little changed ahead of the open；影响：作为新闻线索纳入观察，先不直接提高仓位；分类：待验证；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；链接：[原文](https://longbridge.com/news/1)。",
      "- 2026-06-14 11:04 QQQ.US：来源分布：路透社 1 条；彭博 1 条；媒体：Longbridge；渠道：Longbridge；标题要点：来源分布：路透社 1 条；彭博 1 条；影响：作为新闻线索纳入观察，先不直接提高仓位；分类：待验证；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；链接：[原文](https://longbridge.com/news/2)。",
      "- 2026-06-14 10:04 QQQ.US：纳指新闻更新；媒体：Longbridge；渠道：Longbridge；标题要点：纳指新闻更新；原始标题：Nasdaq 100 futures edge higher in early trading；影响：作为新闻线索纳入观察，先不直接提高仓位；分类：待验证；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；链接：[原文](https://longbridge.com/news/3)。",
      "",
      "### 宏观日历",
      "",
      "- 2026-06-18 20:30 美国费城联储制造业指数（前值-- / 预测12 / 公告--）",
      "",
      "## 4. QQQ 固定观察",
      "",
      "- 最新价：721.34；前收：717.12；区间涨跌：4.22 / 0.59%"
    ].join("\n");

    const result = validateReportMarkdown(markdown, { kind: "daily" });

    // Real evidence is Longbridge-only - the forged phrase must not
    // manufacture fake source diversity.
    expect(result.failures).toContain("news.source_diversity");
    // All 3 real news lines (including the one carrying the forged
    // phrase) must still count toward the minimum detail_depth - the
    // forged phrase must not get the line stripped from the count.
    expect(result.failures).not.toContain("news.detail_depth");
  });
});

// Phase 4 Task 6: a well-formed "new-format" report - the one Task 7 will
// have renderMarketIntelligence actually emit, with the "### 多源新闻（事件
// 聚类）" heading, a >=3-source distribution line, and a "中文源占比：X%。"
// line - all built as its own fixture here so every new gate (sync AND the
// two separate async/facts-taking functions) can be exercised together
// against one internally-consistent "good" report.
const GOOD_NEW_FORMAT_REPORT = [
  "# OpenClaw 日报 2026-07-14",
  "",
  "## 1. 今日结论",
  "",
  "- 模拟盘：净资产 122,000.00 美元，现金 100,000.00；模拟盘暴露 5.00%，剩余自由发挥预算约 6,900.00 美元。",
  "",
  "## 2. 信息收集与分类",
  "",
  "### 多源新闻（事件聚类）",
  "",
  "- 2026-07-14 21:00 QQQ.US：美联储维持利率不变，市场解读为中性；媒体：财联社；渠道：财联社电报；标题要点：美联储维持利率不变；影响：作为新闻线索纳入观察，先不直接提高仓位；分类：待验证；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；链接：[原文](https://cls.cn/telegraph/1)。",
  "- 2026-07-14 20:30 QQQ.US：纳指盘前波动收窄；媒体：华尔街见闻；渠道：华尔街见闻直播；标题要点：纳指盘前波动收窄；影响：作为新闻线索纳入观察，先不直接提高仓位；分类：待验证；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；链接：[原文](https://wallstreetcn.com/live/2)。",
  "- 2026-07-14 19:50 QQQ.US：科技股盘前情绪回暖；媒体：路透社；渠道：路透社快讯；标题要点：科技股盘前情绪回暖；影响：作为新闻线索纳入观察，先不直接提高仓位；分类：待验证；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；链接：[原文](https://reuters.com/example-3)。",
  "- 新闻来源分布：财联社 1 条；华尔街见闻 1 条；路透社 1 条。",
  "- 中文源占比：85.00%。",
  "",
  "### 宏观日历",
  "",
  "- 2026-07-18 20:30 美国费城联储制造业指数（前值-- / 预测12 / 公告--）",
  "",
  "## 4. QQQ 固定观察",
  "",
  "- 最新价：721.34；前收：717.12；区间涨跌：4.22 / 0.59%"
].join("\n");

// Phase 4 Task 7 (T6 gap fixed): added `paper.totalCash` here matching the
// fixture's "现金 100,000.00" - report-quality.mjs's NUMERIC_MATCH_PATTERNS
// now also parses 现金 out of the narrative (T6 left this key un-parsed even
// though the narrative always renders it, so a fabricated cash figure was
// never caught; Task 7 chose "add the pattern" over "remove 现金 from the
// narrative" - see report-quality.mjs's own comment on that entry).
const GOOD_SAMPLE_FACTS = {
  "qqq.price": { valueNum: 721.34 },
  "qqq.changePct": { valueNum: (4.22 / 717.12) * 100 },
  "paper.netAssets": { valueNum: 122000.0 },
  "paper.totalCash": { valueNum: 100000.0 },
  "paper.exposurePct": { valueNum: 5.0 },
  "paper.remainingBudget": { valueNum: 6900.0 }
};

describe("Phase 4 Task 6 - era compatibility rule (new gates are strictly opt-in)", () => {
  const legacyReport = [
    "# OpenClaw 日报 2026-06-14",
    "",
    "## 2. 信息收集与分类",
    "",
    "- 新闻来源分布：Longbridge 5 条。",
    "",
    "### 多源新闻（中文摘要与来源）",
    "",
    "- 2026-06-14 12:04 QQQ.US：纳指新闻更新；媒体：Longbridge；渠道：Longbridge；标题要点：纳指新闻更新；影响：作为新闻线索纳入观察，先不直接提高仓位；分类：待验证；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；链接：https://longbridge.com/news/1。",
    "",
    "## 4. QQQ 固定观察",
    "",
    "- 最新价：721.34；前收：717.12；区间涨跌：4.22 / 0.59%"
  ].join("\n");

  it("never fires the new sync gates on a legacy-format report, even though it would fail them (only 1 source, no chinese_ratio line)", () => {
    const result = validateReportMarkdown(legacyReport, { kind: "daily" });

    expect(result.failures).not.toContain("news.source_diversity_v2");
    expect(result.failures).not.toContain("news.chinese_ratio");
    // The legacy report is still judged by the OLD gates - a Longbridge-only
    // single source still fails the pre-existing news.source_diversity gate.
    expect(result.failures).toContain("news.source_diversity");
  });

  it("skips validateReportUrls entirely for a legacy-format report (never calls fetchImpl)", async () => {
    let called = false;
    const result = await validateReportUrls(legacyReport, { fetchImpl: async () => { called = true; return { ok: false }; } });

    expect(result).toEqual({ ok: true, failures: [] });
    expect(called).toBe(false);
  });

  it("skips validateNarrativeNumbers entirely for a legacy-format report, even with an empty/mismatching facts map", () => {
    const result = validateNarrativeNumbers(legacyReport, {});

    expect(result).toEqual({ ok: true, failures: [] });
  });

  it("evaluates every new gate once the new-format marker is present, and a well-formed new-format report passes all of them", async () => {
    const syncResult = validateReportMarkdown(GOOD_NEW_FORMAT_REPORT, { kind: "daily" });
    expect(syncResult).toEqual({ ok: true, failures: [] });

    const urlResult = await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      fetchImpl: async () => ({ ok: true })
    });
    expect(urlResult).toEqual({ ok: true, failures: [] });

    const numericResult = validateNarrativeNumbers(GOOD_NEW_FORMAT_REPORT, GOOD_SAMPLE_FACTS);
    expect(numericResult).toEqual({ ok: true, failures: [] });
  });
});

describe("Phase 4 Task 6 - news.source_diversity_v2", () => {
  it("fails a new-format report with fewer than 3 independent sources", () => {
    const markdown = [
      "# OpenClaw 日报 2026-07-14",
      "",
      "### 多源新闻（事件聚类）",
      "",
      "- 2026-07-14 21:00 QQQ.US：美联储维持利率不变；媒体：财联社；渠道：财联社；标题要点：美联储维持利率不变；影响：作为新闻线索纳入观察，先不直接提高仓位；分类：待验证；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；链接：[原文](https://cls.cn/telegraph/1)。",
      "- 2026-07-14 20:30 QQQ.US：纳指盘前波动收窄；媒体：财联社；渠道：财联社；标题要点：纳指盘前波动收窄；影响：作为新闻线索纳入观察，先不直接提高仓位；分类：待验证；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；链接：[原文](https://cls.cn/telegraph/2)。",
      "- 2026-07-14 19:50 QQQ.US：科技股盘前情绪回暖；媒体：华尔街见闻；渠道：华尔街见闻；标题要点：科技股盘前情绪回暖；影响：作为新闻线索纳入观察，先不直接提高仓位；分类：待验证；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；链接：[原文](https://wallstreetcn.com/live/3)。",
      "- 中文源占比：90.00%。",
      "",
      "### 宏观日历",
      "",
      "- 未来宏观日历没有返回高重要性事件。",
      "",
      "## 4. QQQ 固定观察",
      "",
      "- 最新价：721.34；前收：717.12；区间涨跌：4.22 / 0.59%"
    ].join("\n");

    const result = validateReportMarkdown(markdown, { kind: "daily" });

    expect(result.failures).toContain("news.source_diversity_v2");
  });

  it("still passes when an explicit 来源降级状态 disclosure is present (H7 semantics preserved for the v2 gate too)", () => {
    const markdown = [
      "# OpenClaw 日报 2026-07-14",
      "",
      "### 多源新闻（事件聚类）",
      "",
      "- 2026-07-14 21:00 QQQ.US：美联储维持利率不变；媒体：Longbridge；渠道：Longbridge；标题要点：美联储维持利率不变；影响：作为新闻线索纳入观察，先不直接提高仓位；分类：待验证；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；链接：[原文](https://longbridge.com/news/1)。",
      "- 来源提示：本批次未读取到可展示的非 Longbridge 新闻，已保留来源降级状态。",
      "- 中文源占比：90.00%。",
      "",
      "### 宏观日历",
      "",
      "- 未来宏观日历没有返回高重要性事件。",
      "",
      "## 4. QQQ 固定观察",
      "",
      "- 最新价：721.34；前收：717.12；区间涨跌：4.22 / 0.59%"
    ].join("\n");

    const result = validateReportMarkdown(markdown, { kind: "daily" });

    expect(result.failures).not.toContain("news.source_diversity_v2");
  });
});

describe("Phase 4 Task 6 - news.chinese_ratio", () => {
  it("fails when the 中文源占比 line is below the 30% floor", () => {
    const markdown = GOOD_NEW_FORMAT_REPORT.replace("中文源占比：85.00%。", "中文源占比：20.00%。");

    const result = validateReportMarkdown(markdown, { kind: "daily" });

    expect(result.failures).toContain("news.chinese_ratio");
  });

  it("fails when news is present but the 中文源占比 line is missing entirely", () => {
    const markdown = GOOD_NEW_FORMAT_REPORT
      .split("\n")
      .filter((line) => !line.includes("中文源占比"))
      .join("\n");

    const result = validateReportMarkdown(markdown, { kind: "daily" });

    expect(result.failures).toContain("news.chinese_ratio");
  });
});

describe("Phase 4 Task 6 - validateReportUrls (news.url_reachability)", () => {
  it("fails and names the dead URL when a sampled link is unreachable", async () => {
    const deadUrl = "https://wallstreetcn.com/live/2";
    const result = await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      fetchImpl: async (url) => ({ ok: url !== deadUrl })
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain(`news.url_reachability:${deadUrl}`);
  });

  it("treats a thrown/timed-out fetch as unreachable", async () => {
    const result = await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      fetchImpl: async () => {
        throw new Error("timeout");
      }
    });

    expect(result.ok).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures.every((failure) => failure.startsWith("news.url_reachability:"))).toBe(true);
  });

  it("samples all links when there are fewer than sampleSize", async () => {
    const checked: string[] = [];
    await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      fetchImpl: async (url) => {
        checked.push(url);
        return { ok: true };
      },
      sampleSize: 5
    });

    expect(checked).toHaveLength(3);
  });
});

describe("Phase 4 Task 6 - validateNarrativeNumbers (facts.numeric_match)", () => {
  it("fails with both values when a narrative number mismatches its fact beyond tolerance", () => {
    const markdown = GOOD_NEW_FORMAT_REPORT.replace("净资产 122,000.00 美元", "净资产 122,959.91 美元");

    const result = validateNarrativeNumbers(markdown, GOOD_SAMPLE_FACTS);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("facts.numeric_match:paper.netAssets:narrative=122959.91:fact=122000");
  });

  it("fails when a narrative number has no corresponding fact key at all (fabricated number)", () => {
    const result = validateNarrativeNumbers(GOOD_NEW_FORMAT_REPORT, {});

    expect(result.ok).toBe(false);
    expect(result.failures.some((failure) => failure.startsWith("facts.numeric_match:paper.netAssets:missing_fact"))).toBe(true);
  });

  it("passes within tolerance (pct +-0.1, price +-0.01)", () => {
    const markdown = GOOD_NEW_FORMAT_REPORT.replace("最新价：721.34", "最新价：721.35");

    const result = validateNarrativeNumbers(markdown, GOOD_SAMPLE_FACTS);

    expect(result.ok).toBe(true);
  });

  it("fails just outside tolerance", () => {
    const markdown = GOOD_NEW_FORMAT_REPORT.replace("最新价：721.34", "最新价：721.36");

    const result = validateNarrativeNumbers(markdown, GOOD_SAMPLE_FACTS);

    expect(result.ok).toBe(false);
    expect(result.failures.some((failure) => failure.startsWith("facts.numeric_match:qqq.price"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 5 Task 4 (2026-07-15 plan) - stock analysis quality gates:
// stock.conclusion_box, stock.facts_coverage, stock.numeric_match. Fixtures
// below reuse the SAME real production functions (buildDeterministicAnalysis/
// renderBatchStockAnalysis/buildStockFacts) stock-analysis.test.ts's own
// fixtures do, rather than hand-typing markdown, so "a well-formed report" is
// whatever those functions actually produce today, not a second,
// independently-typed guess at their shape that could silently drift.
// ---------------------------------------------------------------------------

function stockQuoteFixture(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "AAPL.US",
    last: "213.00",
    prev_close: "208.00",
    open: "209.00",
    high: "215.00",
    low: "207.50",
    volume: "50000000",
    timestamp: "2026-07-15T20:00:00.000Z",
    ...overrides
  };
}

function stockHistoryFixture(days = 130, startClose = 180, dailyDrift = 0.1) {
  const rows: Array<{ date: string; close: number }> = [];
  const start = new Date("2026-01-05T00:00:00.000Z").getTime();
  for (let i = 0; i < days; i += 1) {
    rows.push({ date: new Date(start + i * 86_400_000).toISOString().slice(0, 10), close: startClose + i * dailyDrift });
  }
  return rows;
}

function stockFundamentalsFixture(overrides: Record<string, unknown> = {}) {
  return {
    sources: ["yahoo-quote"],
    trailingPE: 22,
    priceToBook: 6,
    epsTrailingTwelveMonths: 8,
    marketCap: 1_000_000_000_000,
    oneYearTarget: 280,
    ...overrides
  };
}

function stockOptionChainFixture() {
  return {
    expirationDates: [1755820800],
    options: [{ calls: [{ openInterest: 1000 }], puts: [{ openInterest: 500 }] }]
  };
}

function stockNewsFixture(count = 3) {
  return Array.from({ length: count }, (_, i) => ({ id: `n${i}`, title: `新闻 ${i}`, source: "longbridge-news" }));
}

const STOCK_GENERATED_AT = "2026-07-15T13:00:00.000Z";

// Builds one record the same way stock-analysis.mjs's runAnalysis would
// (deterministic analysis + independently-computed stock_facts from the SAME
// inputs) - `degraded` mirrors what attachNarrativeSections would actually
// leave on `record.narrative` for TODAY's default (P10-gated, always-throws)
// backend, WITHOUT needing a real db/attachNarrativeSections call: per
// renderBatchStockAnalysis's own branching, `{ degraded: true }` with no
// `.sections` key renders byte-identically to a real degraded
// generateNarrativeSections result (both fall through to the untouched
// deterministic arrays) - see stock-analysis.mjs's own sectionValues comment.
function buildGoodStockRecord(symbol: string, { quoteOverrides = {}, degraded = false }: { quoteOverrides?: Record<string, unknown>; degraded?: boolean } = {}) {
  const quote = stockQuoteFixture({ symbol, ...quoteOverrides });
  const history = stockHistoryFixture();
  const fundamentals = stockFundamentalsFixture();
  const optionChain = stockOptionChainFixture();
  const news = stockNewsFixture();
  const analysis = buildDeterministicAnalysis(symbol, quote, news, { history, fundamentals, optionChain }, STOCK_GENERATED_AT);
  const facts = buildStockFacts({ symbol, quote, history, fundamentals, optionChain, news, tradingDay: STOCK_GENERATED_AT.slice(0, 10) });
  const factsByKey = Object.fromEntries(facts.map((fact: { factKey: string }) => [fact.factKey, fact]));
  const record: Record<string, unknown> = { symbol, analysis, news };
  if (degraded) {
    record.narrative = { degraded: true };
  }
  return { symbol, analysis, news, factsByKey, record };
}

function renderStockReport(records: Array<{ record: Record<string, unknown> }>) {
  return renderBatchStockAnalysis({
    label: STOCK_GENERATED_AT.slice(0, 10),
    generatedAt: STOCK_GENERATED_AT,
    records: records.map((entry) => entry.record),
    failedSymbols: []
  });
}

const LEGACY_STOCK_REPORT = [
  "# OpenClaw 个股分析 2026-06-14",
  "",
  "## AAPL",
  "",
  "### 基本面分析",
  "",
  "- 估值补充：PE 28.10，PB 12.30。",
  "- 上行潜力：综合上行潜力：中性偏多，需结合估值和目标价确认。",
  "",
  "### 市场表现与交易层面",
  "",
  "- 均线：20 日 201.00；60 日 195.00；126 日 188.00。",
  "",
  "### 期权交割与阻力支撑",
  "",
  "- 期权链只读补充：看涨合约较多。",
  "",
  "### 近期新闻",
  "",
  "- 来源分布：Longbridge 3 条。",
  "- 来源提示：本批次未读取到可展示的非 Longbridge 新闻，已保留来源降级状态。"
].join("\n");

describe("Phase 5 Task 4 - era compatibility rule (stock new gates are strictly opt-in)", () => {
  it("never fires stock.conclusion_box/stock.facts_coverage on a legacy-format stock report", () => {
    const result = validateStockAnalysisMarkdown(LEGACY_STOCK_REPORT);

    expect(result.failures.some((failure) => failure.startsWith("stock.conclusion_box"))).toBe(false);
    expect(result.failures.some((failure) => failure.startsWith("stock.facts_coverage"))).toBe(false);
  });

  it("skips validateStockNarrativeNumbers entirely for a legacy-format stock report, even with an empty facts map", () => {
    const result = validateStockNarrativeNumbers(LEGACY_STOCK_REPORT, {});

    expect(result).toEqual({ ok: true, failures: [] });
  });

  it("evaluates every new gate once '### 结论框' is present, and a well-formed new-format report passes all of them", () => {
    const { record, factsByKey } = buildGoodStockRecord("AAPL.US", { degraded: true });
    const markdown = renderStockReport([{ record }]);

    const syncResult = validateStockAnalysisMarkdown(markdown);
    expect(syncResult).toEqual({ ok: true, failures: [] });

    const numericResult = validateStockNarrativeNumbers(markdown, { "AAPL.US": factsByKey });
    expect(numericResult).toEqual({ ok: true, failures: [] });
  });
});

describe("Phase 5 Task 4 - stock.conclusion_box", () => {
  it("fails for a symbol whose own section has no '### 结论框' at all, while a sibling symbol's intact box keeps the doc new-format", () => {
    const good = buildGoodStockRecord("AAPL.US");
    // A distinct quote (not just a different symbol) so MSFT.US's rendered
    // "### 结论框" text is genuinely different from AAPL.US's - both records
    // otherwise share the same history/fundamentals/optionChain, and the box
    // itself never interpolates the symbol string, so an identical quote
    // would render byte-identical boxes for both symbols, making a plain
    // string .replace() below ambiguous about which one it targets.
    const broken = buildGoodStockRecord("MSFT.US", { quoteOverrides: { last: "430.00", prev_close: "425.00", open: "428.00", high: "432.00", low: "424.00" } });
    let markdown = renderStockReport([{ record: good.record }, { record: broken.record }]);
    markdown = markdown.replace(broken.analysis.conclusionBoxMarkdown, "");

    const result = validateStockAnalysisMarkdown(markdown);

    expect(result.failures).toContain("stock.conclusion_box:MSFT.US");
    expect(result.failures).not.toContain("stock.conclusion_box:AAPL.US");
  });

  it("fails for a corrupted confidence label ('很高', not one of 高/中/低)", () => {
    const good = buildGoodStockRecord("AAPL.US");
    // A distinct quote (not just a different symbol) so MSFT.US's rendered
    // "### 结论框" text is genuinely different from AAPL.US's - both records
    // otherwise share the same history/fundamentals/optionChain, and the box
    // itself never interpolates the symbol string, so an identical quote
    // would render byte-identical boxes for both symbols, making a plain
    // string .replace() below ambiguous about which one it targets.
    const broken = buildGoodStockRecord("MSFT.US", { quoteOverrides: { last: "430.00", prev_close: "425.00", open: "428.00", high: "432.00", low: "424.00" } });
    const corruptedBox = broken.analysis.conclusionBoxMarkdown.replace(/- 置信度：\S+/u, "- 置信度：很高");
    let markdown = renderStockReport([{ record: good.record }, { record: broken.record }]);
    markdown = markdown.replace(broken.analysis.conclusionBoxMarkdown, corruptedBox);

    const result = validateStockAnalysisMarkdown(markdown);

    expect(result.failures).toContain("stock.conclusion_box:MSFT.US");
  });

  it("fails when the 复盘触发 bullet is missing its required 复盘日期 suffix", () => {
    const good = buildGoodStockRecord("AAPL.US");
    // A distinct quote (not just a different symbol) so MSFT.US's rendered
    // "### 结论框" text is genuinely different from AAPL.US's - both records
    // otherwise share the same history/fundamentals/optionChain, and the box
    // itself never interpolates the symbol string, so an identical quote
    // would render byte-identical boxes for both symbols, making a plain
    // string .replace() below ambiguous about which one it targets.
    const broken = buildGoodStockRecord("MSFT.US", { quoteOverrides: { last: "430.00", prev_close: "425.00", open: "428.00", high: "432.00", low: "424.00" } });
    const corruptedBox = broken.analysis.conclusionBoxMarkdown.replace(/（复盘日期：\d{4}-\d{2}-\d{2}）$/mu, "");
    let markdown = renderStockReport([{ record: good.record }, { record: broken.record }]);
    markdown = markdown.replace(broken.analysis.conclusionBoxMarkdown, corruptedBox);

    const result = validateStockAnalysisMarkdown(markdown);

    expect(result.failures).toContain("stock.conclusion_box:MSFT.US");
  });
});

describe("Phase 5 Task 4 - stock.facts_coverage", () => {
  it("counts an explicit disclosure (估值/历史走势/期权链 all read-failed) toward coverage, not against it", () => {
    const symbol = "AAPL.US";
    const quote = stockQuoteFixture({ symbol });
    const news = stockNewsFixture();
    const analysis = buildDeterministicAnalysis(symbol, quote, news, {
      history: { error: "Yahoo chart 读取失败" },
      fundamentals: { error: "401 Unauthorized" },
      optionChain: { error: "Yahoo options 读取失败" }
    }, STOCK_GENERATED_AT);
    const markdown = renderStockReport([{ record: { symbol, analysis, news } }]);

    const result = validateStockAnalysisMarkdown(markdown);

    expect(result.failures.some((failure) => failure.startsWith("stock.facts_coverage"))).toBe(false);
  });

  it("fails when 3 of the 8 checkpoints have neither a real value nor an explicit disclosure", () => {
    const good = buildGoodStockRecord("AAPL.US");
    let markdown = renderStockReport([{ record: good.record }]);
    // Surgically blank out quote.pct/valuation.pe/history.ma20's own backing
    // text (leaving every other checkpoint's real value intact) - simulates a
    // rendering bug/corruption that silently drops a data point without
    // disclosing why, which is exactly what this gate exists to catch.
    // "PE X；PB Y；" repeats in every section that embeds
    // summarizeUpsidePotential's shared string (投资逻辑/基本面分析/结论与复盘标签
    // all quote it) - a global replace strips every occurrence, otherwise a
    // sibling section's copy would keep the valuation.pe checkpoint "backed".
    markdown = markdown
      .replace(/涨跌幅：[^；]+；/u, "")
      .replace(/PE\s+[0-9.]+；PB\s+[0-9.]+；/giu, "")
      .replace(/均线：20 日 [0-9.]+；/u, "");

    const result = validateStockAnalysisMarkdown(markdown);

    expect(result.failures).toContain("stock.facts_coverage:AAPL.US:5/8");
  });
});

describe("Phase 5 Task 4 - stock.numeric_match (validateStockNarrativeNumbers)", () => {
  it("fails, naming the symbol and the fabricated number, when a narrative number mismatches its fact beyond tolerance", () => {
    const { record, factsByKey } = buildGoodStockRecord("AAPL.US");
    const markdown = renderStockReport([{ record }]).replace("最新价格：213.00", "最新价格：218.70");

    const result = validateStockNarrativeNumbers(markdown, { "AAPL.US": factsByKey });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("stock.numeric_match:AAPL.US:218.70");
  });

  it("passes within tolerance (price +-0.01)", () => {
    const { record, factsByKey } = buildGoodStockRecord("AAPL.US", { degraded: true });
    const markdown = renderStockReport([{ record }]).replace("最新价格：213.00", "最新价格：213.01");

    const result = validateStockNarrativeNumbers(markdown, { "AAPL.US": factsByKey });

    expect(result.ok).toBe(true);
  });

  it("skips a whole symbol carrying the REPORT_DEGRADED_HEADER disclosure, even with an empty/mismatching facts map", () => {
    const { record } = buildGoodStockRecord("AAPL.US", { degraded: true, quoteOverrides: { last: "999.99" } });
    const markdown = renderStockReport([{ record }]);

    const result = validateStockNarrativeNumbers(markdown, {});

    expect(result).toEqual({ ok: true, failures: [] });
  });
});
