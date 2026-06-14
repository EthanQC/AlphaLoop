import { describe, expect, it } from "vitest";

const macro = await import("./report-macro.mjs");

describe("report macro calendar handling", () => {
  it("treats an empty macro calendar as reportable evidence instead of a hard failure", () => {
    const result = macro.normalizeReportMacroCalendarPayload({ list: [] });

    expect(result.entries).toEqual([]);
    expect(result.warnings).toEqual(["Longbridge 美国宏观日历在本窗口没有返回二星或三星事件"]);
  });
});
