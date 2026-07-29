// 个股分析新鲜度 - the ONE computation of "how old is the stock analysis that
// is currently on display, and is that older than the pipeline is allowed to
// be silent for".
//
// Why this module exists (2026-07-30). The operator opened /stock/TSM.US and
// read "支撑位 398.37" - a level derived from the 2026-07-27 batch - while TSM
// was trading near 375. Two separate defects produced that screen:
//
//   1. Production had stopped. trading-schedule.mjs's cadence gate was a
//      wall-clock `now - lastRunAt >= 72h` delta that the third day's own
//      21:00 slot could never satisfy (see that file's `shouldRunStockAnalysis`
//      comment for the measured evidence). Fixed there.
//   2. NOTHING NOTICED. A skipped slot prints `{"skipped":true,
//      "reason":"not_due"}` and exits 0, so the cron runner recorded `ok: true`
//      for it - three days of shipping nothing looked, in run_log and in every
//      runtime/openclaw-cron-runner/*.json, exactly like three days of health.
//      The cron runner's failure-notice/halt machinery only ever sees
//      failures, so a pipeline that stops by SKIPPING is invisible to it.
//
// Defect 2 is the class, and it is what this module closes: staleness is
// computed from the artifacts that are actually on display (the delivered
// `stock_analysis_runs` archive rows, whose `markdown_path` names the very
// `reports/stock-analysis/<label>.md` the stock page reads), never from the
// state file that just told us it was fine. Past the threshold, the scheduled
// entry point turns a silent skip into a NON-ZERO EXIT, which is the one
// signal the cron runner already escalates to Feishu.
//
// Everything here is derived from data the pipeline already writes - no new
// column, no new table, no new state file.

import {
  STOCK_ANALYSIS_INTERVAL_DAYS,
  stockAnalysisDaysSinceLastRun,
  stockAnalysisReportLabel
} from "./trading-schedule.mjs";

/**
 * How many days past the cadence a missing batch is tolerated before it is
 * called a stall. One full slot of grace: at 3 days the next batch is merely
 * due; at 4 the pipeline has skipped an entire scheduled slot without
 * producing, which is never normal.
 */
export const STOCK_ANALYSIS_STALE_GRACE_DAYS = 1;
export const STOCK_ANALYSIS_STALE_AFTER_DAYS = STOCK_ANALYSIS_INTERVAL_DAYS + STOCK_ANALYSIS_STALE_GRACE_DAYS;

/**
 * The label of the batch a report path names, e.g.
 * `/x/reports/stock-analysis/2026-07-27.md` -> `2026-07-27`. Returns null for
 * anything that is not a `YYYY-MM-DD` basename, so a hand-written or renamed
 * path degrades to the row's `created_at` rather than inventing a date.
 */
export function reportLabelFromPath(markdownPath) {
  const basename = String(markdownPath ?? "").split(/[\\/]/u).pop() ?? "";
  const match = /^(\d{4}-\d{2}-\d{2})\.md$/u.exec(basename);
  return match ? match[1] : null;
}

/**
 * The newest DELIVERED stock-analysis batch, as `{ runId, createdAt, label }`,
 * or null when the table has no rows at all.
 *
 * Ordered by `created_at` (the run instant) because that is the column the
 * table actually has an ordering guarantee on; `label` is then taken from the
 * archived markdown path - the file the platform app renders - and only falls
 * back to created_at's own label when the path is not a dated report name.
 */
export function readLatestStockAnalysisRun(db) {
  const row = db
    .prepare("SELECT id, created_at, markdown_path FROM stock_analysis_runs ORDER BY created_at DESC LIMIT 1")
    .get();
  if (!row) {
    return null;
  }
  const createdAt = String(row.created_at);
  return {
    runId: String(row.id),
    createdAt,
    label: reportLabelFromPath(row.markdown_path) ?? stockAnalysisReportLabel(new Date(createdAt))
  };
}

/**
 * @typedef {{
 *   latestLabel: string|null,
 *   latestRunId: string|null,
 *   latestRunAt: string|null,
 *   ageDays: number|null,
 *   staleAfterDays: number,
 *   intervalDays: number,
 *   stale: boolean,
 *   reason: string
 * }} StockAnalysisFreshness
 */

/**
 * Freshness of what is on display as of `now`. `ageDays` is whole calendar
 * days between the newest batch's report label and today's - the same day
 * arithmetic the cadence gate uses, so "due" and "stale" can never disagree
 * about what a day is.
 *
 * `stale` is true when there has NEVER been a batch, and when the newest one
 * is `STOCK_ANALYSIS_STALE_AFTER_DAYS` or more days old. A future-dated batch
 * (negative age, i.e. clock skew or a doctored row) is also stale: we cannot
 * vouch for it, and saying so is the honest answer.
 *
 * @returns {StockAnalysisFreshness}
 */
export function computeStockAnalysisFreshness(db, now = new Date()) {
  const base = {
    intervalDays: STOCK_ANALYSIS_INTERVAL_DAYS,
    staleAfterDays: STOCK_ANALYSIS_STALE_AFTER_DAYS
  };
  const latest = readLatestStockAnalysisRun(db);
  if (!latest) {
    return {
      ...base,
      latestLabel: null,
      latestRunId: null,
      latestRunAt: null,
      ageDays: null,
      stale: true,
      reason: "从未产出过个股分析批次"
    };
  }

  const ageDays = stockAnalysisDaysSinceLastRun(now, `${latest.label}T00:00:00.000Z`);
  const stale = ageDays === null || ageDays < 0 || ageDays >= STOCK_ANALYSIS_STALE_AFTER_DAYS;
  const reason = ageDays === null
    ? `最新批次 ${latest.label} 的日期无法解析`
    : ageDays < 0
      ? `最新批次日期 ${latest.label} 晚于当前日期，时钟或归档记录异常`
      : stale
        ? `最新批次为 ${latest.label}，已过去 ${ageDays} 天，超过 ${STOCK_ANALYSIS_STALE_AFTER_DAYS} 天上限`
        : `最新批次为 ${latest.label}，已过去 ${ageDays} 天`;

  return {
    ...base,
    latestLabel: latest.label,
    latestRunId: latest.runId,
    latestRunAt: latest.createdAt,
    ageDays,
    stale,
    reason
  };
}

/**
 * The operator-facing Chinese sentence for a freshness result. Used verbatim
 * by the scheduled entry point's stall error (which the cron runner forwards
 * to Feishu) and by the runtime doctor, so an operator reads the SAME words
 * wherever the stall surfaces.
 */
export function describeStockAnalysisFreshness(freshness) {
  if (!freshness.stale) {
    return `个股分析最新批次 ${freshness.latestLabel}（${freshness.ageDays} 天前），节奏为每 ${freshness.intervalDays} 天一次，未超期。`;
  }
  return `个股分析已停摆：${freshness.reason}。节奏应为每 ${freshness.intervalDays} 天一次，`
    + `超过 ${freshness.staleAfterDays} 天未产出即判定停摆。`
    + `在恢复产出前，站内展示的支撑位/阻力位/估值均为旧批次数据，不可当作当前价位使用。`;
}
