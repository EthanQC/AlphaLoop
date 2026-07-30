import { describe, expect, it } from "vitest";

import {
  CHINESE_RATIO_DISCLOSURE_PREFIX,
  CHINESE_SOURCE_FLOOR_PERCENT,
  countFactsCoverage,
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
    expect(result.failures).toContain("stock.valuation_depth:AAPL");
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
  // Task 13 (2026-07-28 spec-drift plan): a well-formed new-format report now
  // LEADS with the conclusion box (req §1.4/§3.5), so the "good" fixture
  // carries one - these exact bytes are what conclusion-box.mjs's
  // renderReportConclusionBox emits (see
  // __fixtures__/report-conclusion-box-samples.json, generated from it and
  // cross-checked by both conclusion-box suites).
  "### 结论框",
  "",
  "- 核心结论：QQQ 最新价 721.34，较前收上涨 4.22（0.59%）；中性偏多，可以继续观察强势延续，但不因单日新闻直接加仓",
  "- 置信度：中",
  "- 依据：行情：QQQ 行情时间 2026-07-14 13:00；新闻：读取 3 条，覆盖 1/1 标的；宏观：事件 1 条；降级：agent 检索不可用（L1-only 模式）",
  "- 截至：2026-07-14 13:00（北京时间）",
  "",
  "### 今日要点",
  "",
  "- 市场信号：QQQ 最新价 721.34，较前收上涨 4.22（0.59%）。",
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
  // Task 20 (2026-07-28): the section renderMarketIntelligence emits is
  // 「宏观与财报日历」 with a macro and an earnings sub-heading. Copied from the
  // real renderer's output shape (see the seam test in
  // scheduled-report.test.ts, which runs the REAL renderer through THIS gate).
  "### 宏观与财报日历",
  "",
  "#### 宏观日历",
  "",
  "- 2026-07-18 20:30 美国费城联储制造业指数（前值-- / 预测12 / 公告--）",
  "",
  "#### 财报日历",
  "",
  "- 2026-08-26 盘后 NVDA.US 2027 财年 Q2 财报；EPS 预期 2.1274；营收预期 936.06 亿。",
  "",
  "## 4. QQQ 固定观察",
  "",
  "- 最新价：721.34；前收：717.12；区间涨跌：4.22 / 0.59%"
].join("\n");

// Task 4 (2026-07-28 spec-drift plan): the account/holdings bullet
// GOOD_NEW_FORMAT_REPORT used to carry inside "## 1. 今日结论". Spec §3.1 keeps
// it OUT of the public body now (report.no_personal_content), so the "good"
// fixture above no longer has it - but the facts.numeric_match gate's own
// patterns (paper.netAssets/totalCash/exposurePct/remainingBudget) only ever
// fire when those phrases ARE present, so the numeric tests below keep
// exercising them against this deliberately-leaky variant, which doubles as
// the bad sample for the new privacy gate.
const PERSONAL_ACCOUNT_LINE =
  "- 模拟盘：净资产 122,000.00 美元，现金 100,000.00；模拟盘暴露 5.00%，剩余自由发挥预算约 6,900.00 美元。";
const LEAKY_PERSONAL_REPORT = GOOD_NEW_FORMAT_REPORT.replace(
  "## 2. 信息收集与分类",
  `${PERSONAL_ACCOUNT_LINE}\n\n## 2. 信息收集与分类`
);

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

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.disclosure).toBeNull();
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
    expect(urlResult.ok).toBe(true);
    expect(urlResult.failures).toEqual([]);
    expect(urlResult.disclosure).toBeNull();

    const numericResult = validateNarrativeNumbers(GOOD_NEW_FORMAT_REPORT, GOOD_SAMPLE_FACTS);
    expect(numericResult).toEqual({ ok: true, failures: [] });
  });
});

// Task 13 (2026-07-28 spec-drift plan) - report.conclusion_box. §1.4/§3.5:
// a daily/weekly report leads with 核心结论 + 置信度（高/中/低）+ 依据 + 截至时间.
// The gate reads the box with conclusion-box.mjs's own parser - the same one
// the renderer round-trips through - so it fails for exactly the reasons a
// reader would see nothing usable.
describe("Task 13 - report.conclusion_box", () => {
  it("fails a new-format report with no conclusion box at all", () => {
    const withoutBox = GOOD_NEW_FORMAT_REPORT.split("\n")
      .filter((line) => !line.startsWith("### 结论框") && !/^-\s*(核心结论|置信度|依据|截至)：/u.test(line))
      .join("\n");

    expect(validateReportMarkdown(withoutBox, { kind: "daily" }).failures).toContain("report.conclusion_box");
  });

  it("fails a box that is missing the 置信度 tier, rather than accepting a headline alone", () => {
    const withoutTier = GOOD_NEW_FORMAT_REPORT.replace("- 置信度：中\n", "");

    expect(validateReportMarkdown(withoutTier, { kind: "daily" }).failures).toContain("report.conclusion_box");
  });

  it("fails a tier that is not one of the three (no invented fourth level)", () => {
    const badTier = GOOD_NEW_FORMAT_REPORT.replace("- 置信度：中", "- 置信度：极高");

    expect(validateReportMarkdown(badTier, { kind: "daily" }).failures).toContain("report.conclusion_box");
  });

  it("passes the well-formed report, and never fires on a legacy-format one (era rule)", () => {
    expect(validateReportMarkdown(GOOD_NEW_FORMAT_REPORT, { kind: "daily" }).failures).not.toContain("report.conclusion_box");

    const legacyReport = [
      "# OpenClaw 日报 2026-06-14",
      "",
      "## 1. 今日结论",
      "",
      "- 市场信号：QQQ 最新价 721.34。",
      "",
      "### 多源新闻（中文摘要与来源）",
      "",
      "- 2026-06-14 12:04 QQQ.US：纳指新闻更新；媒体：Longbridge；渠道：Longbridge；标题要点：纳指新闻更新；影响：作为新闻线索纳入观察，先不直接提高仓位；分类：待验证；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；链接：https://longbridge.com/news/1。",
      "",
      "### 宏观日历",
      "",
      "- 2026-06-18 20:30 美国费城联储制造业指数",
      "",
      "## 4. QQQ 固定观察",
      "",
      "- 最新价：721.34；前收：717.12；区间涨跌：4.22 / 0.59%"
    ].join("\n");

    expect(validateReportMarkdown(legacyReport, { kind: "daily" }).failures).not.toContain("report.conclusion_box");
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

// 2026-07-30: this gate used to be a pure delivery blocker, and that is how it
// took the daily report down. All three Chinese feeds come from ONE locally
// hosted RSSHub (DEFAULT_RSSHUB_BASE_URL = http://127.0.0.1:1200), so a single
// container hiccup collapsed the ratio and destroyed the whole report - the same
// shape as news.url_reachability, which read a publisher's HEAD 404 as proof its
// live article was invented. The rule now: a thin Chinese mix SHIPS as long as
// the report says so, and only an undisclosed shortfall (or a missing statistic
// altogether, i.e. we cannot even tell) blocks. Each case below pins one arm of
// that, including the arm that must PASS - without it the gate could quietly go
// back to fatal and every test here would still be green.
describe("Phase 4 Task 6 - news.chinese_ratio", () => {
  it("blocks an undisclosed shortfall, naming the measured ratio", () => {
    const markdown = GOOD_NEW_FORMAT_REPORT.replace("中文源占比：85.00%。", "中文源占比：20.00%。");

    const result = validateReportMarkdown(markdown, { kind: "daily" });

    expect(result.failures).toContain("news.chinese_ratio:未披露(20%)");
  });

  it("SHIPS the same shortfall once the report discloses it", () => {
    const markdown = GOOD_NEW_FORMAT_REPORT.replace(
      "中文源占比：85.00%。",
      [
        "中文源占比：20.00%。",
        `${CHINESE_RATIO_DISCLOSURE_PREFIX}：本次中文源占比 20.00%，低于 ${CHINESE_SOURCE_FLOOR_PERCENT}% 目标；财联社电报未返回条目（RSSHub 不可达）。`
      ].join("\n")
    );

    const result = validateReportMarkdown(markdown, { kind: "daily" });

    expect(result.failures.filter((code) => code.startsWith("news.chinese_ratio"))).toEqual([]);
  });

  it("blocks when the statistic is missing entirely, because then the mix is unknowable", () => {
    const markdown = GOOD_NEW_FORMAT_REPORT
      .split("\n")
      .filter((line) => !line.includes("中文源占比"))
      .join("\n");

    const result = validateReportMarkdown(markdown, { kind: "daily" });

    expect(result.failures).toContain("news.chinese_ratio:统计行缺失");
  });
});


// ---------------------------------------------------------------------------
// 2026-07-30, round 2 of the url_reachability outage fix.
//
// WHY THIS BLOCK WAS REWRITTEN. The tests that stood here were green for two
// days while the daily report was destroyed every single day. They were green
// because their stubs answered `{ ok: false, status: 404 }` to a HEAD and the
// block called that shape "unreachable" - and HEAD 404 is exactly what
// wallstreetcn.com answers for its own LIVE articles. The input shape was
// authored here rather than measured, so the suite agreed with the code
// instead of with the world.
//
// Every stub below now reproduces a shape MEASURED on 2026-07-30 (curl and
// node fetch, dev box and the mini agreeing), using the exact URLs from the
// mini's crash log:
//
//   wallstreetcn.com/livenews/3141798 and /3141797 - REAL, cited by the
//     mini's own 2026-07-30 daily report:
//        HEAD -> 404
//        GET  -> 200, 19357 B, <title>意大利和沙特重申支持落实“两国方案” - 华尔街见闻</title>
//   wallstreetcn.com/livenews/999999999 - INVENTED:
//        HEAD -> 404
//        GET  -> 200, 13051 B, <title>404 Not Found - 华尔街见闻</title>
//   finance.sina.com.cn/nope-not-real-123 - INVENTED:  HEAD -> 404, GET -> 404
//   reuters.com/nonexistent-article-xyz  - INVENTED:  HEAD -> 401, GET -> 401
//   cls.cn/detail/99999999999            - INVENTED:  GET  -> 200, empty <title>
//
// The two directions this block has to prove: the real pair SHIPS, the
// invented pair BLOCKS.
// ---------------------------------------------------------------------------

const WSCN_REAL_TITLE = "意大利和沙特重申支持落实“两国方案” - 华尔街见闻";
const WSCN_SOFT_404_TITLE = "404 Not Found - 华尔街见闻";

/** An HTML response shaped like the real ones: status + a readable body. */
function htmlResponse(status: number, title: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () =>
      `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><div id="app"></div></body></html>`
  };
}

/** A response with no readable body, e.g. an error page we do not parse. */
function bareResponse(status: number) {
  return { ok: status >= 200 && status < 300, status };
}

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

describe("validateReportUrls - what blocks vs what is disclosed (news.url_reachability)", () => {
  const fast = { retryDelayMs: 0 } as const;

  // --- direction 1: real links must ship -----------------------------------

  it("SHIPS the report whose live wallstreetcn links killed it for days (HEAD 404 + GET 200)", async () => {
    // The precise production shape: the origin 404s HEAD for a live article
    // and serves it under GET. The old gate read the HEAD and threw the day's
    // report away.
    const methods: string[] = [];
    const result = await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      ...fast,
      fetchImpl: async (url: string, init: { method: string }) => {
        methods.push(init.method);
        if (init.method === "HEAD") {
          return bareResponse(404);
        }
        return htmlResponse(200, WSCN_REAL_TITLE);
      }
    });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.hardCount).toBe(0);
    expect(result.disclosure).toBeNull();
    // The HEAD branch above is never taken - and that is the fix. Reinstating
    // a HEAD probe turns this stub's 404s back into "does not exist" and
    // fails this test, which is exactly what the outage needed someone to
    // notice.
    expect(methods).not.toContain("HEAD");
  });

  it("never sends HEAD at all - a HEAD answer is not evidence either way", async () => {
    const methods: string[] = [];
    await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      ...fast,
      fetchImpl: async (url: string, init: { method: string }) => {
        methods.push(init.method);
        return htmlResponse(200, "某条真实新闻 - 财联社");
      }
    });

    expect(methods.length).toBeGreaterThan(0);
    expect(methods).not.toContain("HEAD");
    expect(new Set(methods)).toEqual(new Set(["GET"]));
  });

  it("identifies itself truthfully instead of impersonating a browser", async () => {
    // Measured 2026-07-30: wallstreetcn server-renders for a bot UA (19357 B,
    // real title) and ships an empty 2871 B shell to a browser UA, which
    // erases the only signal that separates a real citation from an invented
    // one. So the probe says who it is.
    const agents: string[] = [];
    await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      ...fast,
      fetchImpl: async (url: string, init: { headers?: Record<string, string> }) => {
        agents.push(init.headers?.["User-Agent"] ?? "");
        return htmlResponse(200, "某条真实新闻 - 财联社");
      }
    });

    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) {
      expect(agent).toContain("OpenClaw");
      expect(agent).not.toContain("Mozilla");
    }
  });

  // --- direction 2: fabricated links must still block ----------------------

  it("BLOCKS invented wallstreetcn links: GET 200 carrying the origin's own not-found title", async () => {
    const invented = ["https://cls.cn/telegraph/1", "https://wallstreetcn.com/live/2"];
    const result = await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      ...fast,
      fetchImpl: async (url: string) =>
        htmlResponse(200, invented.includes(url) ? WSCN_SOFT_404_TITLE : WSCN_REAL_TITLE)
    });

    expect(result.ok).toBe(false);
    expect(result.hardCount).toBe(2);
    for (const url of invented) {
      expect(result.failures).toContain(`news.url_reachability:${url}`);
    }
  });

  it("BLOCKS invented links a publisher answers with a real 404 on GET (the sina shape)", async () => {
    const invented = ["https://cls.cn/telegraph/1", "https://reuters.com/example-3"];
    const result = await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      ...fast,
      fetchImpl: async (url: string) =>
        invented.includes(url) ? bareResponse(404) : htmlResponse(200, WSCN_REAL_TITLE)
    });

    expect(result.ok).toBe(false);
    for (const url of invented) {
      expect(result.failures).toContain(`news.url_reachability:${url}`);
    }
  });

  it("BLOCKS a one-link sample whose only citation is confirmed missing", async () => {
    const singleLinkReport = GOOD_NEW_FORMAT_REPORT
      .replace("https://wallstreetcn.com/live/2", "https://cls.cn/telegraph/1")
      .replace("https://reuters.com/example-3", "https://cls.cn/telegraph/1");
    const result = await validateReportUrls(singleLinkReport, {
      ...fast,
      fetchImpl: async () => bareResponse(410)
    });

    expect(result.sampled).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("news.url_reachability:https://cls.cn/telegraph/1");
  });

  // --- everything else is disclosed, never fatal ---------------------------

  it("discloses a single confirmed-dead link without destroying the report (ordinary link rot)", async () => {
    const dead = "https://reuters.com/example-3";
    const result = await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      ...fast,
      fetchImpl: async (url: string) =>
        url === dead ? bareResponse(404) : htmlResponse(200, WSCN_REAL_TITLE)
    });

    expect(result.ok).toBe(true);
    expect(result.hardCount).toBe(1);
    // The reader is told this one was CHECKED and found dead - not that it
    // merely went unchecked.
    expect(result.disclosure).toContain("经 GET 复核确认打不开");
    expect(result.disclosure).toContain("HTTP 404");
  });

  it("PASSES with a disclosure when a single link times out", async () => {
    const flaky = "https://wallstreetcn.com/live/2";
    const result = await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      ...fast,
      fetchImpl: async (url: string) => {
        if (url === flaky) {
          throw abortError();
        }
        return htmlResponse(200, WSCN_REAL_TITLE);
      }
    });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.unverified).toEqual([{ url: flaky, reason: "请求超时", status: "unverified" }]);
    expect(result.disclosure).toContain("1 条未能核验");
    expect(result.disclosure).toContain("请求超时");
  });

  it("PASSES with a disclosure for a single 429 rate-limit", async () => {
    const result = await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      ...fast,
      fetchImpl: async (url: string) =>
        url.includes("cls.cn") ? bareResponse(429) : htmlResponse(200, WSCN_REAL_TITLE)
    });

    expect(result.ok).toBe(true);
    expect(result.hardCount).toBe(0);
    expect(result.disclosure).toContain("HTTP 429");
  });

  it("PASSES with a disclosure for a single transient 5xx", async () => {
    const result = await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      ...fast,
      fetchImpl: async (url: string) =>
        url.includes("cls.cn") ? bareResponse(503) : htmlResponse(200, WSCN_REAL_TITLE)
    });

    expect(result.ok).toBe(true);
    expect(result.disclosure).toContain("HTTP 503");
  });

  it("a whole-network outage is disclosed, NOT fatal - nothing answered, so nothing was proven", async () => {
    // The old rule failed the report when zero URLs came back reachable, even
    // with zero 404s. A 10-second network blip therefore destroyed the day,
    // which is the same bug this fix exists to end, in a different costume.
    const result = await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      ...fast,
      fetchImpl: async () => {
        throw new Error("network down");
      }
    });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.hardCount).toBe(0);
    expect(result.disclosure).toContain("3 条未能核验");
    expect(result.disclosure).toContain("网络异常");
  });

  it("every link timing out is disclosed, not fatal", async () => {
    const result = await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      ...fast,
      fetchImpl: async () => {
        throw abortError();
      }
    });

    expect(result.ok).toBe(true);
    expect(result.disclosure).toContain("请求超时");
  });

  it("treats a 401 auth wall as proof of NEITHER direction (measured: reuters 401s invented paths too)", async () => {
    const walled = "https://reuters.com/example-3";
    const result = await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      ...fast,
      fetchImpl: async (url: string) =>
        url === walled ? bareResponse(401) : htmlResponse(200, WSCN_REAL_TITLE)
    });

    // Not fatal - an auth challenge is not evidence of fabrication.
    expect(result.ok).toBe(true);
    expect(result.hardCount).toBe(0);
    // But not silently "verified" either.
    expect(result.disclosure).toContain("HTTP 401");
  });

  // cls.cn answers an invented /detail/ path with 200 and an empty <title>
  // (measured 2026-07-30). It never labels the page "not found", so this gate
  // cannot call it missing - and an empty title must not be promoted into
  // evidence of absence, since real pages render one too.
  it("does not treat an empty <title> as a soft 404", async () => {
    const result = await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      ...fast,
      fetchImpl: async () => htmlResponse(200, "")
    });

    expect(result.ok).toBe(true);
    expect(result.hardCount).toBe(0);
  });

  it("does not call an article a soft 404 because its headline mentions 404", async () => {
    const result = await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      ...fast,
      fetchImpl: async () => htmlResponse(200, "纳指收涨 4040 点，报 14042 点 - 财联社")
    });

    expect(result.ok).toBe(true);
    expect(result.hardCount).toBe(0);
  });

  // --- request shaping and budget ------------------------------------------

  it("falls back to a plain GET when the origin rejects the ranged GET (405/416)", async () => {
    const picky = "https://wallstreetcn.com/live/2";
    const ranges: (string | undefined)[] = [];
    const result = await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      ...fast,
      fetchImpl: async (url: string, init: { method: string; headers?: Record<string, string> }) => {
        if (url !== picky) {
          return htmlResponse(200, WSCN_REAL_TITLE);
        }
        ranges.push(init.headers?.Range);
        return init.headers?.Range ? bareResponse(405) : htmlResponse(200, WSCN_REAL_TITLE);
      }
    });

    expect(ranges).toEqual(["bytes=0-65535", undefined]);
    expect(result.ok).toBe(true);
    expect(result.disclosure).toBeNull();
  });

  it("retries once with backoff before giving up on a transient failure", async () => {
    const attempts: string[] = [];
    const flaky = "https://cls.cn/telegraph/1";
    const result = await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      ...fast,
      fetchImpl: async (url: string) => {
        attempts.push(url);
        if (url === flaky && attempts.filter((entry) => entry === flaky).length === 1) {
          return bareResponse(503);
        }
        return htmlResponse(200, WSCN_REAL_TITLE);
      }
    });

    expect(attempts.filter((entry) => entry === flaky)).toHaveLength(2);
    expect(result.ok).toBe(true);
    expect(result.disclosure).toBeNull();
  });

  it("never retries a confirmed answer, in either direction", async () => {
    const dead = "https://reuters.com/example-3";
    const attempts: string[] = [];
    await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      ...fast,
      fetchImpl: async (url: string) => {
        attempts.push(url);
        return url === dead ? bareResponse(404) : htmlResponse(200, WSCN_REAL_TITLE);
      }
    });

    // 3 sampled URLs, one request each: a 404 and a 200 are both final.
    expect(attempts).toHaveLength(3);
    expect(attempts.filter((entry) => entry === dead)).toHaveLength(1);
  });

  it("stops probing once the wall-clock budget is spent, and discloses the rest", async () => {
    const probed: string[] = [];
    const result = await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      ...fast,
      budgetMs: 0,
      fetchImpl: async (url: string) => {
        probed.push(url);
        return htmlResponse(200, WSCN_REAL_TITLE);
      }
    });

    expect(probed).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.probed).toBe(0);
    expect(result.disclosure).toContain("核验预算耗尽");
  });

  it("an exhausted budget can never block, even when the report is full of links", async () => {
    const result = await validateReportUrls(GOOD_NEW_FORMAT_REPORT, { ...fast, budgetMs: 0 });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("in a runtime with no fetch: does not silently pass (forces a disclosure) and does not hard-fail the report", async () => {
    const originalFetch = globalThis.fetch;
    // @ts-expect-error - deliberately simulating a runtime without fetch
    delete globalThis.fetch;
    try {
      const result = await validateReportUrls(GOOD_NEW_FORMAT_REPORT, fast);

      // Nothing was probed, so there is no evidence of fabrication - failing
      // the report over an environment quirk would repeat the outage this fix
      // exists to end. But the report must never claim verification it did
      // not perform, so the disclosure is mandatory.
      expect(result.ok).toBe(true);
      expect(result.unverifiable).toBe(true);
      expect(result.probed).toBe(0);
      expect(result.disclosure).toContain("运行环境不具备联网核验能力");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("samples all links when there are fewer than sampleSize", async () => {
    const checked: string[] = [];
    await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      ...fast,
      fetchImpl: async (url: string) => {
        checked.push(url);
        return htmlResponse(200, WSCN_REAL_TITLE);
      },
      sampleSize: 5
    });

    expect(checked).toHaveLength(3);
  });

  it("does not read a body the origin declares enormous", async () => {
    let textRead = false;
    const result = await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      ...fast,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name.toLowerCase() === "content-length" ? "900000000" : null) },
        text: async () => {
          textRead = true;
          return `<title>${WSCN_SOFT_404_TITLE}</title>`;
        }
      })
    });

    expect(textRead).toBe(false);
    expect(result.ok).toBe(true);
  });

  it("treats an unreadable body as no evidence rather than as a missing resource", async () => {
    const result = await validateReportUrls(GOOD_NEW_FORMAT_REPORT, {
      ...fast,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => {
          throw new Error("stream closed");
        }
      })
    });

    expect(result.ok).toBe(true);
    expect(result.hardCount).toBe(0);
  });
});

describe("Phase 4 Task 6 - validateNarrativeNumbers (facts.numeric_match)", () => {
  it("fails with both values when a narrative number mismatches its fact beyond tolerance", () => {
    const markdown = LEAKY_PERSONAL_REPORT.replace("净资产 122,000.00 美元", "净资产 122,959.91 美元");

    const result = validateNarrativeNumbers(markdown, GOOD_SAMPLE_FACTS);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("facts.numeric_match:paper.netAssets:narrative=122959.91:fact=122000");
  });

  it("fails when a narrative number has no corresponding fact key at all (fabricated number)", () => {
    const result = validateNarrativeNumbers(LEAKY_PERSONAL_REPORT, {});

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

// Task 4 (2026-07-28 spec-drift plan) - report.no_personal_content. Spec §3.1:
// the PUBLIC daily/weekly report must carry "不含任何个人持仓与策略内容".
// Today the deployment has one member, so nothing has leaked yet; the moment a
// second member exists, B opening /daily/<date> would read A's account. The
// gate is the regression guard that keeps those fields from coming back.
describe("Task 4 - report.no_personal_content", () => {
  it("fails a public report whose 今日结论 still carries the owner's account and holdings", () => {
    const result = validateReportMarkdown(LEAKY_PERSONAL_REPORT, { kind: "daily" });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("report.no_personal_content:净资产、现金、模拟盘暴露、剩余预算");
  });

  it("names every leaked field when a full 官方模拟盘 account/positions block is re-added", () => {
    const markdown = [
      GOOD_NEW_FORMAT_REPORT,
      "",
      "## 5. 官方模拟盘",
      "",
      "- 净资产：122,000.00 美元；现金：100,000.00；购买力：50,000.00",
      "- 当前持仓 QQQ.US 20.0000 份、NVDA.US 10.0000 份",
      "- QQQ.US（纳指 100 交易型开放式指数基金）：20.0000 交易型开放式指数基金，可用 20.0000，成本 600.000，币种 美元"
    ].join("\n");

    const result = validateReportMarkdown(markdown, { kind: "daily" });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("report.no_personal_content:净资产、现金、购买力、持仓、持仓明细");
  });

  it("passes a public report that carries none of them", () => {
    const result = validateReportMarkdown(GOOD_NEW_FORMAT_REPORT, { kind: "daily" });

    expect(result.failures.some((failure) => failure.startsWith("report.no_personal_content"))).toBe(false);
    expect(result).toEqual({ ok: true, failures: [] });
  });

  it("judges a legacy-format report too - a privacy leak is not a formatting era", () => {
    const legacyLeak = [
      "# OpenClaw 日报 2026-06-14",
      "",
      "## 1. 今日结论",
      "",
      "- 模拟盘：净资产 122,000.00 美元。",
      "",
      "### 多源新闻（中文摘要与来源）",
      "",
      "- 2026-06-14 12:04 QQQ.US：纳指新闻更新；媒体：Longbridge；渠道：Longbridge；链接：https://longbridge.com/news/1。"
    ].join("\n");

    const result = validateReportMarkdown(legacyLeak, { kind: "daily" });

    expect(result.failures).toContain("report.no_personal_content:净资产");
  });

  it("never fires on an external news headline that merely mentions 现金/持仓 (no delivery-halting false positive)", () => {
    const markdown = GOOD_NEW_FORMAT_REPORT
      .replace(
        "美联储维持利率不变，市场解读为中性",
        "某基金二季度持仓 300 万股并披露现金 12 亿美元"
      )
      // Renderer-authored prose OUTSIDE the news section that quotes the same
      // headline: natural language keeps words between the noun and the
      // number, which is exactly what the gate's adjacency requirement uses to
      // tell a rendered `label：value` pair apart from a quoted headline.
      .replace(
        "## 2. 信息收集与分类",
        "- 主线：某基金持仓比例升至 12%，现金储备升至 3,800 亿美元。\n\n## 2. 信息收集与分类"
      );

    const result = validateReportMarkdown(markdown, { kind: "daily" });

    expect(result.failures.some((failure) => failure.startsWith("report.no_personal_content"))).toBe(false);
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

// ---------------------------------------------------------------------------
// 2026-07-27 - honest-disclosure coverage. The rule these tests defend: a
// checkpoint counts as covered when the section carries a REAL value for it,
// OR states why it is unavailable. A bare "暂无" is neither, and must keep
// failing the gate - otherwise "never fabricate, disclose honestly" quietly
// degrades into "say nothing".
// ---------------------------------------------------------------------------

const UNAVAILABLE_HISTORY = {
  error: "Nasdaq 历史行情（assetclass=stocks）触发限流，当前维度待验证；StockAnalysis 历史接口读取失败：503；Yahoo chart 历史走势接口触发限流，当前维度待验证"
};
const UNAVAILABLE_OPTION_CHAIN = {
  error: "Nasdaq 期权链（assetclass=stocks）未返回合约（Symbol not exists.）；Yahoo options query2.finance.yahoo.com触发限流，当前维度待验证"
};

// One `## SYMBOL` slice - the same scope validateStockAnalysisMarkdown gives
// each per-symbol gate, so countFactsCoverage here sees exactly what the gate
// sees.
function symbolSection(markdown: string, symbol: string): string {
  const start = markdown.indexOf(`## ${symbol}\n`);
  const rest = markdown.slice(start + `## ${symbol}\n`.length);
  const next = rest.match(/\n##\s+/u);
  return next ? rest.slice(0, next.index) : rest;
}

function buildStockRecord(
  symbol: string,
  {
    history = stockHistoryFixture(),
    fundamentals = stockFundamentalsFixture(),
    optionChain = stockOptionChainFixture(),
    news = stockNewsFixture()
  }: { history?: unknown; fundamentals?: unknown; optionChain?: unknown; news?: Array<Record<string, unknown>> } = {}
) {
  const quote = stockQuoteFixture({ symbol });
  const analysis = buildDeterministicAnalysis(symbol, quote, news, { history, fundamentals, optionChain }, STOCK_GENERATED_AT);
  const facts = buildStockFacts({ symbol, quote, history, fundamentals, optionChain, news, tradingDay: STOCK_GENERATED_AT.slice(0, 10) });
  return {
    record: { symbol, analysis, news } as Record<string, unknown>,
    analysis,
    factsByKey: Object.fromEntries(facts.map((fact: { factKey: string }) => [fact.factKey, fact]))
  };
}

describe("stock.facts_coverage: disclosures count, bare placeholders do not", () => {
  it("a symbol whose history/option/valuation sources ALL failed still clears the threshold on disclosures alone", () => {
    // Paired with a healthy sibling so the batch-wide valuation gate has real
    // PE/PB to read - the per-symbol coverage assertion below is the point.
    const healthy = buildStockRecord("AAPL.US");
    const dark = buildStockRecord("MSFT.US", {
      history: UNAVAILABLE_HISTORY,
      fundamentals: { error: "finnhub-metric：Finnhub 指标接口返回 403；nasdaq-summary：Nasdaq 摘要未返回该标的数据（Symbol not exists.）" },
      optionChain: UNAVAILABLE_OPTION_CHAIN
    });
    const markdown = renderStockReport([{ record: healthy.record }, { record: dark.record }]);

    // Each unavailable domain names its own reason in the rendered section.
    expect(markdown).toContain("历史走势读取失败：");
    expect(markdown).toContain("期权链读取失败：");
    expect(markdown).toContain("估值读取失败：");
    // All 8 checkpoints accounted for: 3 backed by real quote/news data, 5
    // disclosed with a stated reason - not merely "above the threshold".
    expect(countFactsCoverage(symbolSection(markdown, "MSFT.US"))).toBe(8);
    expect(countFactsCoverage(symbolSection(markdown, "AAPL.US"))).toBe(8);
    expect(validateStockAnalysisMarkdown(markdown)).toEqual({ ok: true, failures: [] });
  });

  it("an ETF's structurally-inapplicable metrics are disclosed with a reason, and satisfy both the per-symbol and batch-wide valuation gates", () => {
    // QQQM: a fund has no PE/PB/EPS and no sell-side one-year target, and
    // this batch has no equity to borrow real ones from.
    const etf = buildStockRecord("QQQM.US", {
      history: UNAVAILABLE_HISTORY,
      fundamentals: { sources: ["nasdaq-summary", "finnhub-metric"], failures: [], marketCap: 97_291_489_986, previousClose: 281.68 },
      optionChain: UNAVAILABLE_OPTION_CHAIN
    });
    const markdown = renderStockReport([{ record: etf.record }]);

    expect(markdown).toContain("PE 不适用（ETF 无市盈率口径");
    expect(markdown).toContain("一年目标价 不适用（ETF 无卖方一年目标价");
    expect(countFactsCoverage(symbolSection(markdown, "QQQM.US"))).toBe(8);
    expect(validateStockAnalysisMarkdown(markdown)).toEqual({ ok: true, failures: [] });
  });

  it("FAILS - naming the count - when those same gaps are rendered as bare '暂无' with no reason", () => {
    const etf = buildStockRecord("QQQM.US", {
      history: UNAVAILABLE_HISTORY,
      fundamentals: { sources: ["nasdaq-summary"], failures: [], marketCap: 97_291_489_986 },
      optionChain: UNAVAILABLE_OPTION_CHAIN
    });
    // Strip the REASON out of every disclosure the renderer emits (both
    // verbs - 不适用 for the ETF's structural gaps, 不可得 for a source outage),
    // leaving the bare placeholder each one replaced.
    const silent = renderStockReport([{ record: etf.record }])
      .replace(/(PE|PB|一年目标价|目标价隐含空间|趋势分) (?:不可得|不适用)（[^）]+）/gu, "$1 暂无")
      .replace(/一年目标价均数据不可得/gu, "一年目标价暂无")
      .replace(/目标价数据不可得/gu, "目标价暂无")
      .replace(/历史走势读取失败：[^\n]*/gu, "历史走势暂无。")
      .replace(/期权链读取失败：[^\n]*/gu, "期权链暂无。");

    const result = validateStockAnalysisMarkdown(silent);

    expect(result.ok).toBe(false);
    // quote.last + quote.pct + news.count survive; the five silently-dropped
    // checkpoints (pe / targetPrice / ma20 / ma60 / callOi) do not.
    expect(result.failures).toContain("stock.facts_coverage:QQQM.US:3/8");
    // ...and the per-symbol valuation gate refuses a bare placeholder too.
    expect(result.failures).toContain("stock.valuation_depth:QQQM.US");
  });
});

describe("stock.numeric_match: deterministic derivations are backed, fabrications are not", () => {
  it("accepts numbers the renderer itself derived (probabilities, trend score, window labels) via deterministicTextBySymbol", () => {
    const { record, factsByKey, analysis } = buildStockRecord("AAPL.US");
    const markdown = renderStockReport([{ record }]);
    const deterministicText = ["quoteTechnicals", "valuation", "fundamentals", "analysts", "options", "paths", "conclusion"]
      .map((key) => (analysis as Record<string, string[]>)[key].join("\n"))
      .join("\n");

    expect(validateStockNarrativeNumbers(markdown, { "AAPL.US": factsByKey }, { deterministicTextBySymbol: { "AAPL.US": deterministicText } }))
      .toEqual({ ok: true, failures: [] });
  });

  it("still fails a number that is in neither the facts table nor the deterministic text", () => {
    const { record, factsByKey, analysis } = buildStockRecord("AAPL.US");
    const deterministicText = ["quoteTechnicals", "valuation", "fundamentals", "analysts", "options", "paths", "conclusion"]
      .map((key) => (analysis as Record<string, string[]>)[key].join("\n"))
      .join("\n");
    const markdown = renderStockReport([{ record }]).replace("日内强弱：", "日内强弱（叙事补充 777.77）：");

    const result = validateStockNarrativeNumbers(markdown, { "AAPL.US": factsByKey }, { deterministicTextBySymbol: { "AAPL.US": deterministicText } });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("stock.numeric_match:AAPL.US:777.77");
  });
});

// ---------------------------------------------------------------------------
// 2026-07-27 adversarial review of ca4cc52 - stock.valuation_depth. The gate
// must accept exactly what the renderer honestly emits (a reason-carrying
// disclosure), keep "结构上没有这个指标" distinguishable from "数据源没给", and
// keep failing a silent gap. Every fixture below goes through the real
// renderer, so "what the renderer emits" is never a second, hand-typed guess.
// ---------------------------------------------------------------------------

const ALL_VALUATION_SOURCES_DOWN = {
  error: "finnhub-metric：Finnhub 指标接口返回 429；nasdaq-summary：Nasdaq 摘要未返回该标的数据（Symbol not exists.）；stockanalysis-statistics：读取失败：503"
};

// Replaces every line the renderer emits valuation evidence on (the
// "估值补充" bullet and summarizeUpsidePotential's "综合上行潜力" bullet, which
// repeats PE/PB in three sections) with one controlled substitute - the only
// way to construct "the renderer's own valuation evidence, corrupted" without
// hand-typing a whole report that would drift from what it really emits.
function rewriteValuationEvidence(markdown: string, replacement: string): string {
  return markdown
    .split("\n")
    .flatMap((line) => {
      if (line.startsWith("- 估值补充：")) {
        return [replacement];
      }
      return line.startsWith("- 综合上行潜力：") ? ["- 综合上行潜力：中性；具体估值口径见估值补充。"] : [line];
    })
    .join("\n");
}

describe("stock.valuation_depth: an honest disclosure ships, a silent gap does not", () => {
  it("accepts an ALL-EQUITY batch whose valuation sources all failed, because the renderer discloses the reason", () => {
    // The failure this defends: PE/PB genuinely unfetchable -> the renderer
    // says exactly why -> the gate used to refuse it anyway, blocking the
    // whole batch forever with no way to ship an honest report.
    const aapl = buildStockRecord("AAPL.US", { fundamentals: ALL_VALUATION_SOURCES_DOWN });
    const markdown = renderStockReport([{ record: aapl.record }]);

    expect(markdown).toContain("估值补充：估值读取失败：");
    expect(validateStockAnalysisMarkdown(markdown)).toEqual({ ok: true, failures: [] });
  });

  it("accepts a per-field equity outage (sources answered, none carried PE/PB) and names the failing sources", () => {
    const aapl = buildStockRecord("AAPL.US", {
      fundamentals: {
        sources: ["nasdaq-summary"],
        failures: ["finnhub-metric：Finnhub 指标接口触发限流，当前维度待验证"],
        marketCap: 3_000_000_000_000,
        oneYearTarget: 280
      }
    });
    const markdown = renderStockReport([{ record: aapl.record }]);

    expect(markdown).toContain("PE 不可得（来源未提供该字段：finnhub-metric");
    expect(markdown).toContain("PB 不可得（来源未提供该字段：finnhub-metric");
    // A data-source outage must NEVER borrow the ETF's structural wording.
    expect(markdown).not.toContain("不适用");
    expect(validateStockAnalysisMarkdown(markdown)).toEqual({ ok: true, failures: [] });
  });

  it("keeps 'ETF 无此指标' textually distinguishable from '数据源不可用' - and accepts both", () => {
    const etf = buildStockRecord("QQQM.US", {
      fundamentals: { sources: ["nasdaq-summary", "finnhub-metric"], failures: [], marketCap: 97_291_489_986, previousClose: 281.68 }
    });
    const markdown = renderStockReport([{ record: etf.record }]);

    expect(markdown).toContain("PE 不适用（ETF 无市盈率口径");
    expect(markdown).toContain("PB 不适用（ETF 无市净率口径");
    expect(markdown).not.toContain("PE 不可得");
    expect(validateStockAnalysisMarkdown(markdown)).toEqual({ ok: true, failures: [] });
  });

  it("FAILS an equity that borrows the structural '不适用' wording, even a near-miss paraphrase of the ETF reason", () => {
    // "structurally inapplicable" acceptance is scoped to the ETF branch as
    // tightly as the renderer scopes it (the EXACT ETF_INAPPLICABLE_REASONS
    // sentence) - an equity always HAS a P/E, so neither a bare 不适用 nor a
    // reason that merely opens with "ETF" may buy its way past the gate.
    const aapl = buildStockRecord("AAPL.US", { fundamentals: ALL_VALUATION_SOURCES_DOWN });
    const markdown = renderStockReport([{ record: aapl.record }]);

    for (const forgedBullet of [
      "- 估值补充：PE 不适用（暂不适用）；PB 不适用（暂不适用）。",
      "- 估值补充：PE 不适用（ETF 无市盈率口径，本标的其实是个股）；PB 不适用（ETF 无市净率口径，本标的其实是个股）。"
    ]) {
      const result = validateStockAnalysisMarkdown(rewriteValuationEvidence(markdown, forgedBullet));

      expect(result.failures).toContain("stock.valuation_depth:AAPL.US");
    }
  });

  it("FAILS a disclosure with no stated reason at all ('PE 不可得' bare)", () => {
    const aapl = buildStockRecord("AAPL.US", { fundamentals: ALL_VALUATION_SOURCES_DOWN });
    const bare = rewriteValuationEvidence(
      renderStockReport([{ record: aapl.record }]),
      "- 估值补充：PE 不可得；PB 不可得。"
    );

    const result = validateStockAnalysisMarkdown(bare);

    expect(result.failures).toContain("stock.valuation_depth:AAPL.US");
  });

  it("FAILS when the report's only PE/PB tokens sit inside an English news headline", () => {
    // The detectors used to run case-insensitively over the WHOLE document,
    // so "…Europe 5.5 percent…" alone satisfied "PE <number>" and a genuine
    // silent valuation gap shipped masked by unrelated prose.
    const aapl = buildStockRecord("AAPL.US");
    const masked = renderStockReport([{ record: aapl.record }])
      .replace(/PE [0-9.]+/gu, "PE 暂无")
      .replace(/PB [0-9.]+/gu, "PB 暂无")
      .concat(
        "\n- 2026-07-15 09:00 AAPL.US：欧洲关税消息；媒体：Reuters；渠道：Reuters；分类：待验证；基本面：待验证；影响：观察；链接：https://example.com/a；原始标题：Apple faces Europe 5.5 percent tariff while a rival PB 3.2 ratio climbs。"
      );

    const result = validateStockAnalysisMarkdown(masked);

    expect(result.failures).toContain("stock.valuation_depth:AAPL.US");
  });
});

// ---------------------------------------------------------------------------
// 2026-07-27, second adversarial pass. The narrative layer is ADDITIVE now, so
// every delivered report permanently carries model prose in the same text the
// gates read, and a batch renders one 近期新闻 block PER SYMBOL. Both facts
// broke gates that judge the whole document as if it were one symbol's
// first-party evidence.
// ---------------------------------------------------------------------------

// Hand-built narrative results in exactly the shape generateNarrativeSections
// returns, so renderBatchStockAnalysis emits real "- 叙事：…" bullets without a
// backend or a db (same trick buildGoodStockRecord's `degraded` flag uses).
function withNarrative(record: Record<string, unknown>, textByKey: Record<string, string>) {
  return {
    ...record,
    narrative: {
      degraded: false,
      sections: Object.entries(textByKey).map(([key, text]) => ({ key, text, narrative: true }))
    }
  };
}

// Rewrites the renderer's own valuation bullets inside ONE symbol's section
// only - two records built from the same fundamentals render byte-identical
// evidence lines, so a document-wide replace could not express "this symbol's
// evidence is gone, its sibling's is intact".
function silenceValuationEvidenceForSymbol(markdown: string, symbol: string): string {
  let inTargetSymbol = false;
  let inNewsBlock = false;
  return markdown
    .split("\n")
    .map((line) => {
      const heading = /^##(?!#)\s+(.+)$/u.exec(line.trim());
      if (heading) {
        inTargetSymbol = heading[1].trim() === symbol;
        inNewsBlock = false;
        return line;
      }
      const subHeading = /^###(?!#)\s+(.+)$/u.exec(line.trim());
      if (subHeading) {
        // Never touch the news block: an injected lookalike line planted
        // there is exactly what these tests must leave standing.
        inNewsBlock = subHeading[1].trim() === "近期新闻";
        return line;
      }
      if (!inTargetSymbol || inNewsBlock) {
        return line;
      }
      if (line.startsWith("- 估值补充：")) {
        return "- 估值补充：PE 暂无；PB 暂无。";
      }
      return line.startsWith("- 综合上行潜力：") ? "- 综合上行潜力：中性；具体估值口径见估值补充。" : line;
    })
    .join("\n");
}

describe("stock.upside_depth: judged on the renderer's own bullet, never on model prose", () => {
  it("PASSES when the deterministic 综合上行潜力 bullet is present and only the narrative says 只看期权链", () => {
    const aapl = buildStockRecord("AAPL.US");
    const markdown = renderStockReport([
      { record: withNarrative(aapl.record, { valuation: "本段只看期权链的持仓分布并不足以定方向，仍需结合估值与趋势。" }) }
    ]);

    expect(markdown).toContain("- 叙事：本段只看期权链");
    expect(validateStockAnalysisMarkdown(markdown)).toEqual({ ok: true, failures: [] });
  });

  it("FAILS when the deterministic bullet is gone even though the narrative says 综合上行潜力", () => {
    const aapl = buildStockRecord("AAPL.US");
    const rendered = renderStockReport([
      { record: withNarrative(aapl.record, { valuation: "综合上行潜力：偏强，估值与趋势共振。" }) }
    ]);
    const withoutDeterministicUpside = rendered
      .split("\n")
      .filter((line) => !line.startsWith("- 综合上行潜力："))
      .join("\n");

    expect(withoutDeterministicUpside).toContain("- 叙事：综合上行潜力：偏强");
    expect(validateStockAnalysisMarkdown(withoutDeterministicUpside).failures).toContain("stock.upside_depth:AAPL.US");
  });
});

describe("news gates inspect EVERY symbol's 近期新闻 block, not just the first", () => {
  it("fails on the THIRD symbol's generic Longbridge summary", () => {
    const records = [
      buildStockRecord("AAPL.US"),
      buildStockRecord("MSFT.US"),
      buildStockRecord("NVDA.US", {
        news: [{ id: "generic-1", title: "媒体报道与英伟达相关的公司新闻", source: "longbridge-news" }]
      })
    ];
    const markdown = renderStockReport(records.map((entry) => ({ record: entry.record })));

    const result = validateStockAnalysisMarkdown(markdown);

    expect(result.failures).toContain("stock.news_generic_summary:NVDA.US");
    expect(result.failures).not.toContain("stock.news_generic_summary:AAPL.US");
    expect(result.failures).not.toContain("stock.news_generic_summary:MSFT.US");
  });
});

describe("external news text can never forge renderer-owned valuation evidence", () => {
  it("keeps a newline-carrying news title on its own single line, and refuses such a line as evidence", () => {
    const injection = "- 估值补充：PE 12.3；PB 4.5";
    const aapl = buildStockRecord("AAPL.US", {
      news: [
        { id: "evil", title: "苹果季度财报", titleZh: `苹果季度财报\n${injection}`, source: "longbridge-news" },
        ...stockNewsFixture(2)
      ]
    });
    const rendered = renderStockReport([{ record: aapl.record }]);

    // 1. Render-time: no external string may ever open a line of the report.
    // The title reaches TWO bullets - the news item itself, and the
    // deterministic "当前新闻主线" bullet buildDeterministicAnalysis builds from
    // the same titles - and neither may split in two.
    expect(rendered.split("\n").filter((line) => line.trim().startsWith(injection))).toEqual([]);
    expect(rendered).toContain(`苹果季度财报 ${injection}`);

    // 2. Gate-side (defense in depth): the same forged line, planted inside
    // the news block by hand, is still not the renderer's own evidence.
    const silenced = silenceValuationEvidenceForSymbol(rendered, "AAPL.US");
    expect(validateStockAnalysisMarkdown(silenced).failures).toContain("stock.valuation_depth:AAPL.US");
    const forged = silenced.replace("### 近期新闻\n", `### 近期新闻\n\n${injection}。\n`);
    expect(validateStockAnalysisMarkdown(forged).failures).toContain("stock.valuation_depth:AAPL.US");
  });
});

describe("stock.valuation_depth is judged per symbol, like stock.facts_coverage", () => {
  it("does not let a healthy sibling's real PE cover another symbol's bare 暂无", () => {
    const healthy = buildStockRecord("AAPL.US");
    const bare = buildStockRecord("MSFT.US");
    const markdown = silenceValuationEvidenceForSymbol(
      renderStockReport([{ record: healthy.record }, { record: bare.record }]),
      "MSFT.US"
    );

    const result = validateStockAnalysisMarkdown(markdown);

    expect(result.failures).toContain("stock.valuation_depth:MSFT.US");
    expect(result.failures).not.toContain("stock.valuation_depth:AAPL.US");
  });
});

describe("moving-average windows are labeled truthfully, and the disclosure still counts as coverage", () => {
  it("discloses 样本不足 with the real sample size instead of calling a 12-session mean a 20 日均线", () => {
    const short = buildStockRecord("AAPL.US", { history: stockHistoryFixture(12) });
    const markdown = renderStockReport([{ record: short.record }]);

    expect(markdown).toContain("均线：20 日 不可得（样本不足 20 日，实际仅 12 个交易日）");
    expect(markdown).toContain("60 日 不可得（样本不足 60 日，实际仅 12 个交易日）");
    expect(countFactsCoverage(symbolSection(markdown, "AAPL.US"))).toBe(8);
    expect(validateStockAnalysisMarkdown(markdown)).toEqual({ ok: true, failures: [] });
  });
});
