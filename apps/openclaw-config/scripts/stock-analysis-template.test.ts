import { describe, expect, it } from "vitest";

const template = await import("./stock-analysis-template.mjs");

describe("stock analysis template", () => {
  // Spec r2 §3.4's nine sections, in its order, minus 策略对照 (rendered
  // per-viewer by the platform app, not by this batch renderer). 结论与置信度 is
  // the spec's 结论框[置信度三档]; the heading deliberately does not start with
  // "结论框" because conclusion-box.mjs finds the structured box it CONTAINS with
  // indexOf("### 结论框") - see the template module's own comment, and the
  // renderBatchStockAnalysis test that proves the box still parses.
  it("renders spec r2 §3.4's nine sections, in the spec's order", () => {
    const sections = template.loadStockAnalysisTemplate().sections.map((section) => section.title);

    expect(sections).toEqual([
      "报价技术面",
      "估值",
      "基本面",
      "分析师与情绪",
      "期权链只读",
      "新闻事件",
      "多路径推演",
      "结论与置信度"
    ]);
  });

  it("takes the news section's heading from report-quality.mjs instead of a second copy", async () => {
    const quality = await import("./report-quality.mjs");
    const newsSection = template
      .loadStockAnalysisTemplate()
      .sections.find((section) => section.kind === "news");

    expect(newsSection?.title).toBe(quality.STOCK_NEWS_SECTION_TITLE);
  });
});
