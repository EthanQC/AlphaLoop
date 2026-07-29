// Task 12 (2026-07-28 spec-drift plan): PRODUCER-DRIVEN check on the report
// library's per-file format-era detector.
//
// Nothing in this file authors a "new format report" by hand. Every positive
// input is either the literal era marker IMPORTED from the module that
// decides the era on the producing side (report-quality.mjs's own gates), or
// - for official-paper, which has no quality gate - a document produced by
// calling the REAL renderer (official-paper-monitor.mjs's renderPnlReport).
// Every negative input is a REAL archived report file committed under
// reports/, written months ago by the pre-split pipeline.
//
// That shape is deliberate: the bug this replaces was a blanket
// `ALL_CURRENT_REPORTS_ARE_LEGACY = true`, and a hand-typed fixture asserting
// "a string containing X is new" would have proved nothing about whether X is
// what the pipeline actually writes.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  NEW_FORMAT_SECTION_MARKER,
  STOCK_CONCLUSION_BOX_MARKER,
  isNewFormatReport,
  isNewFormatStockReport
  // eslint-disable-next-line import/no-unresolved -- plain .mjs, no dist
} from "../../../openclaw-config/scripts/report-quality.mjs";
import { PNL_TABLE_HEADER, renderPnlReport } from "../../../openclaw-config/scripts/official-paper-monitor.mjs";

import { detectReportFormatEra } from "./format-era.js";

function repoFile(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../${relative}`, import.meta.url)), "utf8");
}

describe("detectReportFormatEra: the era comes from the PRODUCER's own marker, per file", () => {
  it("agrees with report-quality.mjs's isNewFormatReport on daily/weekly", () => {
    const withMarker = `# OpenClaw 日报 2026-07-30\n\n${NEW_FORMAT_SECTION_MARKER}\n\n- 事件：X。`;
    expect(isNewFormatReport(withMarker)).toBe(true);
    expect(detectReportFormatEra("daily", withMarker)).toBe("new");
    expect(detectReportFormatEra("weekly", withMarker)).toBe("new");

    const withoutMarker = "# OpenClaw 日报 2026-05-29\n\n## 1. 今日结论\n\n- 无。";
    expect(isNewFormatReport(withoutMarker)).toBe(false);
    expect(detectReportFormatEra("daily", withoutMarker)).toBe("legacy");
  });

  it("judges stock-analysis by ITS own marker, not the daily/weekly one", () => {
    // A real stock-analysis report never contains 多源新闻（事件聚类） - judging
    // it by the daily marker is exactly how today's batch got stamped legacy.
    const stockNewFormat = `# OpenClaw 个股分析 2026-07-27\n\n## AMZN.US\n\n${STOCK_CONCLUSION_BOX_MARKER}\n\n- 核心结论：持有。`;
    expect(stockNewFormat.includes(NEW_FORMAT_SECTION_MARKER)).toBe(false);
    expect(isNewFormatStockReport(stockNewFormat)).toBe(true);
    expect(detectReportFormatEra("stock-analysis", stockNewFormat)).toBe("new");
    // ...and the daily rule would have called the very same document legacy.
    expect(detectReportFormatEra("daily", stockNewFormat)).toBe("legacy");
  });

  it("calls a document the REAL renderPnlReport just produced a new-format official-paper", () => {
    const snapshot = {
      fetchedAt: "2026-07-30T13:30:00.000Z",
      primaryAsset: { net_assets: 860261.61, total_cash: 855558.45 },
      positions: [{ symbol: "QQQ.US", quantity: 1, costPrice: 663.88, price: 671.62 }]
    };
    const markdown = renderPnlReport(snapshot, null, null) as string;

    expect(markdown).toContain(PNL_TABLE_HEADER);
    expect(detectReportFormatEra("official-paper", markdown)).toBe("new");
  });

  it("calls every REAL archived report under reports/ legacy - they predate their kind's marker", () => {
    const archived: Array<[Parameters<typeof detectReportFormatEra>[0], string]> = [
      ["daily", "reports/daily/2026-06-19.md"],
      ["weekly", "reports/weekly/2026-06-19.md"],
      ["stock-analysis", "reports/stock-analysis/2026-06-19.md"],
      ["official-paper", "reports/official-paper/2026-05-31-post-open.md"]
    ];
    for (const [type, path] of archived) {
      expect(detectReportFormatEra(type, repoFile(path)), path).toBe("legacy");
    }
  });

});
