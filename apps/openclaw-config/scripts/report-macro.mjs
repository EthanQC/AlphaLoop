import { normalizeMacroCalendarPayload } from "./report-data.mjs";

const EMPTY_MACRO_WARNING = "Longbridge 美国宏观日历在本窗口没有返回二星或三星事件";

export function normalizeReportMacroCalendarPayload(payload) {
  const entries = normalizeMacroCalendarPayload(payload);
  return {
    entries,
    warnings: entries.length === 0 ? [EMPTY_MACRO_WARNING] : []
  };
}
