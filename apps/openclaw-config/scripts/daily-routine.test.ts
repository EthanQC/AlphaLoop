import { describe, expect, it } from "vitest";

const routine = await import("./daily-routine.mjs");

describe("daily routine parsing", () => {
  it("loads the required information collection and classification categories", () => {
    const categories = routine.loadDailyRoutineChecklist().map((entry) => entry.title);

    expect(categories).toContain("新闻");
    expect(categories).toContain("企业近况");
    expect(categories).toContain("最新科研/技术成果");
    expect(categories).toContain("大宗商品价格变动");
    expect(categories).toContain("货币汇率变化");
    expect(categories).toContain("市场情绪");
    expect(categories).toContain("行业淡旺季");
    expect(categories).toContain("经济指标");
    expect(categories).toContain("大盘走势");
    expect(categories).toContain("利好");
    expect(categories).toContain("利空");
    expect(categories).toContain("是否影响企业基本面");
  });
});
