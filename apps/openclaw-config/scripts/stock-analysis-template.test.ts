import { describe, expect, it } from "vitest";

const template = await import("./stock-analysis-template.mjs");

describe("stock analysis template", () => {
  it("keeps the Feishu-derived Chinese stock-analysis sections", () => {
    const sections = template.loadStockAnalysisTemplate().sections.map((section) => section.title);

    expect(sections).toEqual([
      "标的基本信息",
      "投资逻辑",
      "基本面分析",
      "催化剂",
      "风险点",
      "市场表现与交易层面",
      "期权交割与阻力支撑",
      "结论与复盘标签"
    ]);
  });
});
