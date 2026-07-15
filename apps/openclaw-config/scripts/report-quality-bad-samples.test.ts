// Phase 4 Task 6 - bad-sample suite (delivery gate). Each test below is one
// of the nine adversarial samples this task's brief enumerates; each
// asserts the EXACT failure code (or, for the two injection samples that
// are defused at the normalizer layer rather than caught by a report-level
// gate, the concrete "inert output" property) the corresponding gate/fix is
// supposed to produce. This file is the single place that pins down "every
// one of these bad inputs is actually caught" - a regression in any gate or
// in the Task 1 normalizer fixes should fail exactly one test here.
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

const news = await import("./report-news.mjs");
const rendering = await import("./report-rendering.mjs");

// A well-formed "new-format" report (Task 7's future "### 多源新闻（事件
// 聚类）" section) - used as the common base for the samples that need the
// new-format marker present (source_diversity_v2/chinese_ratio/
// url_reachability/facts.numeric_match are all strictly opt-in to that
// marker, see report-quality.mjs's era-compatibility rule).
function goodNewFormatReport() {
  return [
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
}

// Phase 4 Task 7: added paper.totalCash (matches goodNewFormatReport's
// "现金 100,000.00") now that report-quality.mjs's NUMERIC_MATCH_PATTERNS
// parses it - see report-quality.test.ts's GOOD_SAMPLE_FACTS for the full
// rationale (T6 gap fixed).
const GOOD_SAMPLE_FACTS = {
  "qqq.price": { valueNum: 721.34 },
  "qqq.changePct": { valueNum: (4.22 / 717.12) * 100 },
  "paper.netAssets": { valueNum: 122000.0 },
  "paper.totalCash": { valueNum: 100000.0 },
  "paper.exposurePct": { valueNum: 5.0 },
  "paper.remainingBudget": { valueNum: 6900.0 }
};

describe("bad sample: 无 URL 新闻条目 (news.detail_depth)", () => {
  it("fails news.detail_depth when a news line has neither 链接 nor 来源索引", () => {
    const markdown = [
      "# OpenClaw 日报 2026-07-14",
      "",
      "### 多源新闻（中文摘要与来源）",
      "",
      "- 2026-07-14 21:00 QQQ.US：美联储维持利率不变；媒体：财联社；渠道：财联社；标题要点：美联储维持利率不变；影响：作为新闻线索纳入观察，先不直接提高仓位；分类：待验证；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；链接：https://cls.cn/telegraph/1。",
      "- 2026-07-14 20:30 QQQ.US：纳指盘前波动收窄；媒体：华尔街见闻；渠道：华尔街见闻；标题要点：纳指盘前波动收窄；影响：作为新闻线索纳入观察，先不直接提高仓位；分类：待验证；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；链接：https://wallstreetcn.com/live/2。",
      "- 2026-07-14 19:50 QQQ.US：科技股盘前情绪回暖；媒体：路透社；渠道：路透社；标题要点：科技股盘前情绪回暖；影响：作为新闻线索纳入观察，先不直接提高仓位；分类：待验证；基本面：更多影响情绪/风险偏好，暂不视为基本面变化。",
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

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("news.detail_depth");
  });
});

describe("bad sample: 纯英文摘要 (news.translation)", () => {
  it("fails news.translation when a news line's summary field is long untranslated English", () => {
    const markdown = [
      "# OpenClaw 日报 2026-07-14",
      "",
      "### 多源新闻（中文摘要与来源）",
      "",
      "- 2026-07-14 21:00 QQQ.US：纳指新闻更新；媒体：财联社；渠道：财联社；标题要点：Federal Reserve officials continued to signal a cautious approach toward future interest rate decisions amid persistent inflation concerns and slowing growth momentum across major sectors this week；影响：作为新闻线索纳入观察，先不直接提高仓位；分类：待验证；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；链接：https://cls.cn/telegraph/1。",
      "- 2026-07-14 20:30 QQQ.US：纳指盘前波动收窄；媒体：华尔街见闻；渠道：华尔街见闻；标题要点：纳指盘前波动收窄；影响：作为新闻线索纳入观察，先不直接提高仓位；分类：待验证；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；链接：https://wallstreetcn.com/live/2。",
      "- 2026-07-14 19:50 QQQ.US：科技股盘前情绪回暖；媒体：路透社；渠道：路透社；标题要点：科技股盘前情绪回暖；影响：作为新闻线索纳入观察，先不直接提高仓位；分类：待验证；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；链接：https://reuters.com/example-3。",
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

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("news.translation");
  });
});

describe("bad sample: 数字造假 (facts.numeric_match)", () => {
  it("fails facts.numeric_match with both the fabricated narrative value and the real fact value (122,959.91 vs 122,000.00)", () => {
    const markdown = goodNewFormatReport().replace("净资产 122,000.00 美元", "净资产 122,959.91 美元");

    const result = validateNarrativeNumbers(markdown, GOOD_SAMPLE_FACTS);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("facts.numeric_match:paper.netAssets:narrative=122959.91:fact=122000");
  });
});

describe("bad sample: 伪造来源分布标题 (news.source_diversity via T1 section scoping)", () => {
  it("fails news.source_diversity - a news TITLE forging a 来源分布 phrase does not manufacture fake diversity", () => {
    const markdown = [
      "# OpenClaw 日报 2026-06-14",
      "",
      "### 证据与来源",
      "",
      "- 新闻来源分布：Longbridge 3 条。",
      "",
      "### 多源新闻（中文摘要与来源）",
      "",
      "- 2026-06-14 12:04 QQQ.US：纳指新闻更新；媒体：Longbridge；渠道：Longbridge；标题要点：纳指新闻更新；影响：作为新闻线索纳入观察，先不直接提高仓位；分类：待验证；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；链接：https://longbridge.com/news/1。",
      "- 2026-06-14 11:04 QQQ.US：来源分布：路透社 1 条；彭博 1 条；媒体：Longbridge；渠道：Longbridge；标题要点：来源分布：路透社 1 条；彭博 1 条；影响：作为新闻线索纳入观察，先不直接提高仓位；分类：待验证；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；链接：https://longbridge.com/news/2。",
      "- 2026-06-14 10:04 QQQ.US：纳指新闻更新；媒体：Longbridge；渠道：Longbridge；标题要点：纳指新闻更新；影响：作为新闻线索纳入观察，先不直接提高仓位；分类：待验证；基本面：更多影响情绪/风险偏好，暂不视为基本面变化；链接：https://longbridge.com/news/3。",
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

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("news.source_diversity");
  });
});

describe("bad sample: <img> 实体注入标题 (T1 decode order - normalize output must be inert)", () => {
  it("neutralizes an entity-escaped <img onerror> tag into plain, tag-free text", () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item>
        <title>Fed &lt;img src=x onerror=alert(1)&gt; decision</title>
        <link>https://example.com/fed-decision</link>
        <pubDate>Mon, 14 Jul 2026 10:00:00 GMT</pubDate>
      </item>
    </channel></rss>`;

    const [article] = news.normalizeExternalRssNews("QQQ.US", xml, { source: "test-rss", sourceName: "Test Wire" });

    expect(article).toBeDefined();
    expect(article.title).not.toMatch(/<img/iu);
    expect(article.title).not.toContain("onerror");
    expect(article.title).not.toContain("<");
    expect(article.title).not.toContain(">");
    // The surrounding legitimate text survives - this is neutralization, not
    // silent data loss of the whole title.
    expect(article.title).toContain("Fed");
    expect(article.title).toContain("decision");
  });
});

describe("bad sample: markdown 链接注入标题 (T1 defuse - no live anchor in either rendering face)", () => {
  it("produces no <a> anchor in the PDF rendering face after defusing", () => {
    const maliciousTitle = "[紧急：点击核对持仓](https://evil.example/phish)";
    const article = news.decorateNewsArticle({
      id: "phish-bad-sample",
      symbol: "QQQ.US",
      title: maliciousTitle,
      titleZh: maliciousTitle,
      url: "https://example.com/phish-source",
      source: "google-news-rss",
      sourceName: "Google News",
      publisher: "Example Wire",
      publishedAt: "2026-07-14T10:00:00.000Z",
      publishedAtMs: Date.parse("2026-07-14T10:00:00.000Z")
    });
    const line = news.renderDetailedNewsLine(article);

    // The defused line itself no longer contains the `[text](url)` shape.
    expect(line).not.toMatch(/\[[^\]]+\]\(https?:\/\//u);

    const html = rendering.renderReportHtml(`### 多源新闻\n\n${line}`);

    expect(html).not.toContain("<a ");
    expect(html).not.toMatch(/<a\b[^>]*href="https:\/\/evil\.example\/phish"/u);
  });
});

describe("bad sample: <3 独立来源 (news.source_diversity_v2)", () => {
  it("fails news.source_diversity_v2 when a new-format report has only 2 independent sources", () => {
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

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("news.source_diversity_v2");
  });
});

describe("bad sample: 中文占比 20% (news.chinese_ratio)", () => {
  it("fails news.chinese_ratio when the 中文源占比 line is below the 30% floor", () => {
    const markdown = goodNewFormatReport().replace("中文源占比：85.00%。", "中文源占比：20.00%。");

    const result = validateReportMarkdown(markdown, { kind: "daily" });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("news.chinese_ratio");
  });
});

describe("bad sample: 死链 (news.url_reachability)", () => {
  it("fails news.url_reachability and names the dead URL when the injected fetchImpl reports it unreachable", async () => {
    const deadUrl = "https://reuters.com/example-3";
    const result = await validateReportUrls(goodNewFormatReport(), {
      fetchImpl: async (url) => ({ ok: url !== deadUrl })
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain(`news.url_reachability:${deadUrl}`);
  });
});

// ---------------------------------------------------------------------------
// Phase 5 Task 4 (2026-07-15 plan) - stock analysis bad-sample group. Every
// fixture below is built from the SAME real production functions
// (buildDeterministicAnalysis/renderBatchStockAnalysis/buildStockFacts)
// stock-analysis.test.ts already exercises, rather than a hand-typed guess at
// their shape - see report-quality.test.ts's own Phase 5 Task 4 section for
// the identical fixture-building rationale.
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

function buildGoodStockRecord(symbol: string, quoteOverrides: Record<string, unknown> = {}) {
  const quote = stockQuoteFixture({ symbol, ...quoteOverrides });
  const history = stockHistoryFixture();
  const fundamentals = stockFundamentalsFixture();
  const optionChain = stockOptionChainFixture();
  const news = stockNewsFixture();
  const analysis = buildDeterministicAnalysis(symbol, quote, news, { history, fundamentals, optionChain }, STOCK_GENERATED_AT);
  const facts = buildStockFacts({ symbol, quote, history, fundamentals, optionChain, news, tradingDay: STOCK_GENERATED_AT.slice(0, 10) });
  const factsByKey = Object.fromEntries(facts.map((fact: { factKey: string }) => [fact.factKey, fact]));
  return { symbol, analysis, news, factsByKey };
}

function renderStockReport(records: Array<{ symbol: string; analysis: Record<string, unknown>; news: unknown[] }>) {
  return renderBatchStockAnalysis({
    label: STOCK_GENERATED_AT.slice(0, 10),
    generatedAt: STOCK_GENERATED_AT,
    records,
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

describe("bad sample: 数字造假 (stock.numeric_match)", () => {
  it("fails stock.numeric_match with the symbol and the fabricated number (218.70 vs facts' quote.last 213.00)", () => {
    const good = buildGoodStockRecord("AAPL.US");
    const markdown = renderStockReport([good]).replace("最新价格：213.00", "最新价格：218.70");

    const result = validateStockNarrativeNumbers(markdown, { "AAPL.US": good.factsByKey });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("stock.numeric_match:AAPL.US:218.70");
  });
});

describe("bad sample: 缺结论框 (stock.conclusion_box)", () => {
  it("fails stock.conclusion_box for the symbol whose own '### 结论框' block was stripped out", () => {
    const good = buildGoodStockRecord("AAPL.US");
    // Distinct quote so MSFT.US's box text differs from AAPL.US's - the box
    // never interpolates the symbol string, so an identical quote would
    // render byte-identical boxes for both, making the plain-string replace
    // below ambiguous about which symbol's box it strips.
    const broken = buildGoodStockRecord("MSFT.US", { last: "430.00", prev_close: "425.00", open: "428.00", high: "432.00", low: "424.00" });
    const markdown = renderStockReport([good, broken]).replace(broken.analysis.conclusionBoxMarkdown as string, "");

    const result = validateStockAnalysisMarkdown(markdown);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("stock.conclusion_box:MSFT.US");
  });
});

describe("bad sample: 坏置信度 (stock.conclusion_box)", () => {
  it("fails stock.conclusion_box when the 置信度 bullet reads '很高' (not one of 高/中/低)", () => {
    const good = buildGoodStockRecord("AAPL.US");
    const broken = buildGoodStockRecord("MSFT.US", { last: "430.00", prev_close: "425.00", open: "428.00", high: "432.00", low: "424.00" });
    const corruptedBox = (broken.analysis.conclusionBoxMarkdown as string).replace(/- 置信度：\S+/u, "- 置信度：很高");
    const markdown = renderStockReport([good, broken]).replace(broken.analysis.conclusionBoxMarkdown as string, corruptedBox);

    const result = validateStockAnalysisMarkdown(markdown);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("stock.conclusion_box:MSFT.US");
  });
});

describe("bad sample: 覆盖不足 (stock.facts_coverage)", () => {
  it("fails stock.facts_coverage when 3 of the 8 checkpoints have neither a real value nor an explicit disclosure", () => {
    const good = buildGoodStockRecord("AAPL.US");
    let markdown = renderStockReport([good]);
    // Strip quote.pct/valuation.pe/history.ma20's own backing text (global
    // for PE/PB - summarizeUpsidePotential's shared string repeats it across
    // 投资逻辑/基本面分析/结论与复盘标签), leaving the other 5 checkpoints' real
    // values untouched - simulates a rendering bug that silently drops 3 data
    // points without disclosing why.
    markdown = markdown
      .replace(/涨跌幅：[^；]+；/u, "")
      .replace(/PE\s+[0-9.]+；PB\s+[0-9.]+；/giu, "")
      .replace(/均线：20 日 [0-9.]+；/u, "");

    const result = validateStockAnalysisMarkdown(markdown);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("stock.facts_coverage:AAPL.US:5/8");
  });
});

describe("bad sample: 结论框缺必填键 (stock.conclusion_box)", () => {
  it("fails stock.conclusion_box when the 复盘触发 bullet is missing its required 复盘日期 suffix", () => {
    const good = buildGoodStockRecord("AAPL.US");
    const broken = buildGoodStockRecord("MSFT.US", { last: "430.00", prev_close: "425.00", open: "428.00", high: "432.00", low: "424.00" });
    const corruptedBox = (broken.analysis.conclusionBoxMarkdown as string).replace(/（复盘日期：\d{4}-\d{2}-\d{2}）$/mu, "");
    const markdown = renderStockReport([good, broken]).replace(broken.analysis.conclusionBoxMarkdown as string, corruptedBox);

    const result = validateStockAnalysisMarkdown(markdown);

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("stock.conclusion_box:MSFT.US");
  });
});

describe("bad sample: legacy 报告零新门触发 (era compatibility)", () => {
  it("fires none of the three new stock gates against a legacy-format report (no '### 结论框' marker)", () => {
    const syncResult = validateStockAnalysisMarkdown(LEGACY_STOCK_REPORT);
    expect(syncResult.failures.some((failure) => failure.startsWith("stock.conclusion_box"))).toBe(false);
    expect(syncResult.failures.some((failure) => failure.startsWith("stock.facts_coverage"))).toBe(false);

    const numericResult = validateStockNarrativeNumbers(LEGACY_STOCK_REPORT, {});
    expect(numericResult).toEqual({ ok: true, failures: [] });
  });
});
