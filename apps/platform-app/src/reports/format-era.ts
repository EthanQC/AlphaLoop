/**
 * Per-file report format era (Task 12, 2026-07-28 spec-drift plan).
 *
 * WHAT THIS REPLACES: reports/scanner.ts used to stamp every entry it
 * returned with a module-level `ALL_CURRENT_REPORTS_ARE_LEGACY = true`. That
 * was a correct rule in P4, when nothing on disk was new-format and no
 * per-file marker existed. It stayed after the new format shipped, so a daily
 * report generated an hour ago wore 「历史存档：旧版格式」 on the reading page
 * and a 历史存档 pill in the library list, and its summary card claimed 「旧格式
 * 无置信度」 - three false statements about a file the pipeline had just
 * written.
 *
 * THE RULE, per report family (each family has its OWN era boundary - there
 * is no single site-wide "new format" date):
 *
 *   daily / weekly   Task 7's clustered-news section heading. This is the
 *                    exact marker report-quality.mjs gates its new-format-only
 *                    checks on (news.source_diversity_v2, news.chinese_ratio,
 *                    news.url_reachability, facts.numeric_match): a report
 *                    carrying it is judged by the new gates, i.e. the
 *                    pipeline itself already treats it as new-format.
 *   stock-analysis   Phase 5 Task 2's structured 结论框 heading - that
 *                    family's own independent boundary in the same file. A
 *                    stock-analysis report has never contained the
 *                    daily/weekly news marker, so judging it by that one is
 *                    precisely how today's batch got called an archive.
 *   official-paper   The 收支变化表 header row official-paper-monitor.mjs's
 *                    renderPnlReport emits today. This family has no quality
 *                    gate, so this is the only per-file era evidence there
 *                    is; the pre-2026-07-28 renderer wrote a header with
 *                    different column semantics (see that function's own
 *                    R4/F8 note), which is what makes the current header
 *                    discriminating rather than incidental.
 *
 * ANTI-DRIFT: the three markers below are RE-DECLARED here, not imported -
 * apps/openclaw-config/scripts is plain .mjs with no dist of its own, and
 * re-declaring with a comment pointing at the source of truth is this
 * codebase's established cross-app convention (see reports/conclusion-box.ts
 * and data/strategy.ts's own headers). `format-era.test.ts` IMPORTS the real
 * constants and the real `renderPnlReport` and asserts this module agrees
 * with them - that test is the enforcement mechanism for this comment, not
 * decoration.
 */
import type { ReportType } from "./scanner.js";

export type ReportFormatEra = "new" | "legacy";

/** report-quality.mjs's `NEW_FORMAT_SECTION_MARKER`. */
const DAILY_WEEKLY_MARKER = "### 多源新闻（事件聚类）";

/** report-quality.mjs's `STOCK_CONCLUSION_BOX_MARKER`. */
const STOCK_ANALYSIS_MARKER = "### 结论框";

/** official-paper-monitor.mjs's `PNL_TABLE_HEADER`. */
const OFFICIAL_PAPER_MARKER =
  "| 对比项 | 该行净资产 | 该行现金 | 该行持仓估值 | 净资产变化（当前 − 该行） | 现金变化（当前 − 该行） |";

const MARKER_BY_TYPE: Record<ReportType, string> = {
  daily: DAILY_WEEKLY_MARKER,
  weekly: DAILY_WEEKLY_MARKER,
  "stock-analysis": STOCK_ANALYSIS_MARKER,
  "official-paper": OFFICIAL_PAPER_MARKER
};

/**
 * `"new"` when `contents` carries its own family's current-format marker,
 * `"legacy"` otherwise. A pure function of the file's text - it never looks
 * at the filename, the date in it, or the clock, so re-running it on an
 * untouched file always gives the same answer.
 */
export function detectReportFormatEra(type: ReportType, contents: string): ReportFormatEra {
  return contents.includes(MARKER_BY_TYPE[type]) ? "new" : "legacy";
}
