/**
 * The one place 近30天遵守情况 and 已连续遵守 N 天 turn into Chinese (Task 11,
 * 2026-07-30).
 *
 * Two pages state the same measurement about the same rules - the strategy
 * page's 我的纪律 section (req §1.7) and the home page's 纪律速览 (req §1.2).
 * They were about to grow two hand-written phrasings of `ComplianceStats`,
 * which is how "3 次检查" on one page and "3 次判定" on the other start
 * meaning subtly different things to a reader. Both import from here instead.
 *
 * Every string below is bounded by what the underlying measurement can
 * support: `{sample:'none'}` never renders as 0/0, and a streak with no
 * violation on record renders as 至少 N 天 (a lower bound) rather than an N
 * nobody measured. See data/strategy.ts's `computeComplianceStats` /
 * `computeDisciplineStreak` for the measurements themselves.
 */
import type { ComplianceStats, DisciplineStreak } from "../data/strategy.js";

import { html, type Html } from "./html.js";

/** One rule's 近30天 tally. `sample:'none'` says the sample is missing rather
 * than reporting a zeroed-out one. */
export function renderComplianceLine(stats: ComplianceStats): Html {
  if (stats.sample === "none") {
    return html`<span class="days">近30天无相关提案</span>`;
  }
  return html`<span class="days">近30天 ${stats.checked} 次检查，遵守 ${stats.passed} / 违反 ${stats.failed}</span>`;
}

/**
 * The owner's streak, in the strongest form the evidence supports:
 *   - a real violation on record -> an exact 已连续遵守 N 天 plus the date it
 *     is counted from, so the reader can check it;
 *   - checks but no violation -> 已连续遵守至少 N 天, anchored to the oldest
 *     check that was actually examined;
 *   - no completed check -> no streak sentence at all, and the reason.
 */
export function describeDisciplineStreak(streak: DisciplineStreak): string {
  if (streak.kind === "no_checks") {
    return "还没有提案触发过纪律检查，暂时算不出连续遵守天数。";
  }
  if (streak.kind === "since_violation") {
    return `已连续遵守 ${streak.days} 天（从上次未遵守 ${streak.lastViolationAt.slice(0, 10)} 起算）。`;
  }
  return `已连续遵守至少 ${streak.atLeastDays} 天（回看到 ${streak.oldestCheckedAt.slice(0, 10)} 的 ${streak.checked} 次检查，没有未遵守记录；更早的部分本页未回看）。`;
}
