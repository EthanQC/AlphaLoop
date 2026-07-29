import { describe, expect, it } from "vitest";

const macro = await import("./report-macro.mjs");

describe("report macro calendar handling", () => {
  it("treats an empty macro calendar as reportable evidence instead of a hard failure", () => {
    const result = macro.normalizeReportMacroCalendarPayload({ list: [] });

    expect(result.entries).toEqual([]);
    expect(result.warnings).toEqual(["Longbridge 美国宏观日历在本窗口没有返回二星或三星事件"]);
  });
});

// ---------------------------------------------------------------------------
// Task 23 (2026-07-30): 宏观日历中文化
// ---------------------------------------------------------------------------
//
// THE FIXTURES BELOW ARE NOT INVENTED. Every `content` string is copied
// verbatim out of reports/daily/2026-07-30.md on the live mini, which is what
// scheduled-report.mjs rendered from Longbridge's US macro calendar that
// morning - all-English indicator names inside an otherwise all-Chinese
// report, with value pairs glued together ("Previous3.625").
describe("macro calendar Chinese labels", () => {
  it("labels a known US indicator in Chinese and keeps the English original in parentheses", () => {
    expect(macro.localizeMacroTitle("United States, Jobless Claims, National, Initial")).toBe(
      "初请失业金人数（United States, Jobless Claims, National, Initial）"
    );
    expect(macro.localizeMacroTitle("United States, Policy Rates, Fed Funds Target Rate")).toBe(
      "联邦基金目标利率（United States, Policy Rates, Fed Funds Target Rate）"
    );
  });

  it("prefers the four-week-average rule over the plain initial-claims rule", () => {
    expect(
      macro.localizeMacroTitle("United States, Jobless Claims, National, Initial, four week moving average")
    ).toBe(
      "初请失业金人数四周移动均值（United States, Jobless Claims, National, Initial, four week moving average）"
    );
  });

  it("says outright that it has no Chinese name for an unmapped indicator instead of printing English as the label", () => {
    const rendered = macro.localizeMacroTitle("United States, Widget Shipments, Total");
    expect(rendered).toBe("暂无中文名（英文原名：United States, Widget Shipments, Total）");
    expect(rendered.startsWith(macro.UNMAPPED_MACRO_LABEL_PREFIX)).toBe(true);
  });

  it("returns an empty string for a title-less row rather than fabricating a label", () => {
    expect(macro.localizeMacroTitle("")).toBe("");
    expect(macro.localizeMacroTitle(undefined)).toBe("");
  });

  it("translates the value keys and separates key from value", () => {
    expect(macro.formatMacroValuePair({ key: "Previous", value: "3.625" })).toBe("前值 3.625");
    expect(macro.formatMacroValuePair({ key: "Estimate", value: "200" })).toBe("预期 200");
    expect(macro.formatMacroValuePair({ key: "Actual", value: "1.798" })).toBe("实际 1.798");
  });

  it("keeps an unknown value key verbatim rather than guessing what it means", () => {
    expect(macro.formatMacroValuePair({ key: "Revision2", value: "9" })).toBe("Revision2 9");
  });

  it("drops a pair with no value instead of rendering a dangling label", () => {
    expect(macro.formatMacroValuePair({ key: "Actual", value: "" })).toBe("");
    expect(macro.formatMacroValuePair({ key: "", value: "5" })).toBe("");
  });
});
