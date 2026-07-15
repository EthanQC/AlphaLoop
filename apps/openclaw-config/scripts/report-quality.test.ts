import { describe, expect, it } from "vitest";

import {
  validateReportMarkdown,
  validateStockAnalysisMarkdown
} from "./report-quality.mjs";

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
