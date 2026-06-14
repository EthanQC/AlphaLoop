import { describe, expect, it } from "vitest";

const rendering = await import("./report-rendering.mjs");

describe("report rendering", () => {
  it("uses one Chinese sans-serif typography stack for all report PDFs", () => {
    const html = rendering.renderReportHtml("# OpenClaw 日报\n\n- 中文报告");

    expect(html).toContain("PingFang SC");
    expect(html).toContain("Noto Sans CJK SC");
    expect(html).not.toContain("Songti SC");
  });
});
