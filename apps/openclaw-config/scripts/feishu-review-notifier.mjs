// Real Feishu single-chat notifier for a CONFIRMED monthly review - the
// backend that replaces the P10 throw-placeholder reviews.mjs's
// createFeishuReviewNotifier used to be. Given the review owner's id, it
// looks up `members.feishu_open_id` and delivers a 月度复盘确认摘要
// interactive card over the SAME production channel the market-alert cards
// already ride: shared-types' sendInteractiveCard
// (packages/shared-types/src/notifications.ts), called exactly the way
// market-alerts-cards.mjs's deliverAlertCards calls it -
// `sendInteractiveCard(card, { openId }, transport)`. No auth is reinvented
// here: sendInteractiveCard's default CardTransport already carries the
// FEISHU_APP_ID/FEISHU_APP_SECRET channel (.env.local via loadLocalEnv)
// end-to-end, retries included.
//
// Platform-side sibling: apps/platform-app/src/data/feishu-review-notifier.ts
// - NOT an import, the same cross-app-boundary mirroring convention as
// memoryd-mirror.mjs vs data/memoryd-mirror.ts. Any change to the card
// composition or the degrade semantics here MUST be mirrored there (and vice
// versa).
//
// Fire-and-forget discipline (unchanged from the placeholder era): an
// EXPECTED miss - unknown member, or a member with no feishu_open_id on file
// - returns an honest `{ok:false, reason}` instead of throwing, and
// transport failures are already converted to `{ok:false, error}` by
// sendInteractiveCard itself. The confirm's SQL status change has already
// committed by the time this notifier runs; nothing here may undo, fail, or
// block it (reviews.mjs's notifyFeishuReviewConfirmed wrapper additionally
// catches anything unexpected).
import {
  MemberRepository,
  sendInteractiveCard
} from "../../../packages/shared-types/dist/index.js";

// Same disclaimer line the confirm cards carried before this notifier became
// real - kept verbatim (plan Global Constraint: "改进建议 only，变更须本人确认").
const CARD_DISCLAIMER = "以上改进建议仅供参考；任何策略/纪律变更须本人另行确认后生效。";

function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function formatPct(fraction) {
  return `${Math.round(fraction * 100)}%`;
}

function formatSignedPct(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function selfThesisLine(result) {
  const hitRate = asRecord(asRecord(result?.predictionReview)?.selfThesisHitRate);
  if (
    hitRate?.sample === "ok" &&
    typeof hitRate.hitFraction === "number" &&
    typeof hitRate.hits === "number" &&
    typeof hitRate.total === "number"
  ) {
    return `本人论点命中率：${formatPct(hitRate.hitFraction)}（${hitRate.hits}/${hitRate.total}）`;
  }
  return "本人论点命中率：样本不足";
}

function decisionLine(result) {
  const executed = asRecord(asRecord(result?.decisionReview)?.executed);
  if (
    executed?.sample === "ok" &&
    typeof executed.avgDecisionReturnPct === "number" &&
    typeof executed.avgBenchmarkReturnPct === "number" &&
    typeof executed.avgAlphaPct === "number"
  ) {
    return `决策收益：平均 ${formatSignedPct(executed.avgDecisionReturnPct)} vs 基准 ${formatSignedPct(executed.avgBenchmarkReturnPct)}，超额 ${formatSignedPct(executed.avgAlphaPct)}`;
  }
  return "决策收益：样本不足";
}

function complianceLine(result) {
  const complianceRate = asRecord(asRecord(result?.disciplineReview)?.complianceRate);
  if (
    complianceRate?.sample === "ok" &&
    typeof complianceRate.rate === "number" &&
    typeof complianceRate.passed === "number" &&
    typeof complianceRate.checked === "number"
  ) {
    return `纪律遵守率：${formatPct(complianceRate.rate)}（${complianceRate.passed}/${complianceRate.checked}）`;
  }
  return "纪律遵守率：暂无数据";
}

function alertQualityLine(result) {
  const alertQuality = asRecord(result?.alertQuality);
  if (
    alertQuality?.sample === "ok" &&
    typeof alertQuality.misreportRate === "number" &&
    typeof alertQuality.triggeredCount === "number" &&
    typeof alertQuality.misreportCount === "number"
  ) {
    return `提醒误报率：${formatPct(alertQuality.misreportRate)}（触发 ${alertQuality.triggeredCount} / 误报 ${alertQuality.misreportCount}）`;
  }
  return "提醒质量：本月无提醒触发";
}

/**
 * Composes the 月度复盘确认摘要 card body: period + confirm time, one
 * headline-metric line per review section (each degrading to an honest
 * 样本不足/暂无数据 when the review row lacks that number - never NaN, never a
 * fabricated value), the one-line lesson when present, a link line to the
 * platform's own review page path, and the standing disclaimer. PURE - no
 * IO; reads the raw result_json object defensively, so a hand-seeded or
 * malformed row degrades instead of throwing.
 *
 * @param {{id: string, period: string, confirmedAt?: string|null, result?: unknown}} review
 *   `result` is the review row's parsed result_json (reviews.mjs passes
 *   `review.resultJson`; the TS sibling passes `TypedMonthlyReview.result`).
 * @returns {string[]}
 */
export function composeReviewConfirmCardLines(review) {
  const result = asRecord(review.result);
  const lines = [
    `复盘周期：${review.period}`,
    `确认时间：${review.confirmedAt ?? ""}`,
    selfThesisLine(result),
    decisionLine(result),
    complianceLine(result),
    alertQualityLine(result)
  ];

  const oneLineLesson = typeof result?.oneLineLesson === "string" ? result.oneLineLesson.trim() : "";
  if (oneLineLesson) {
    lines.push(`一句话教训：${oneLineLesson}`);
  }

  lines.push(`复盘详情：/review/${review.id}（平台站内路径）`);
  lines.push(CARD_DISCLAIMER);
  return lines;
}

/**
 * The real notifier factory both reviews.mjs's `confirm` default and the
 * `notify-test` smoke subcommand wire in. Returns a function matching the
 * notifier interface reviews.mjs's notifyFeishuReviewConfirmed already
 * consumes: `({ownerId, title, lines}) => Promise<{ok, messageId?, reason?}>`.
 *
 * `transport` is injectable purely for hermetic tests (a fake CardTransport
 * capturing the composed card payload); production omits it so
 * sendInteractiveCard uses its own default transport - the exact channel
 * market-alerts-cards.mjs delivers through today.
 *
 * @param {{db: import('node:sqlite').DatabaseSync, transport?: import('../../../packages/shared-types/dist/index.js').CardTransport}} deps
 * @returns {(args: {ownerId: string, title: string, lines: string[]}) => Promise<{ok: boolean, messageId?: string, reason?: string}>}
 */
export function createFeishuReviewNotifier({ db, transport }) {
  const members = new MemberRepository(db);
  return async function feishuReviewNotifier({ ownerId, title, lines }) {
    const member = members.getById(ownerId);
    if (!member) {
      return { ok: false, reason: `成员不存在：${ownerId}，无法投递飞书复盘通知。` };
    }
    if (!member.feishuOpenId) {
      return { ok: false, reason: `成员 ${ownerId} 未配置 feishu_open_id，跳过飞书复盘通知。` };
    }

    const sent = transport
      ? await sendInteractiveCard({ title, lines }, { openId: member.feishuOpenId }, transport)
      : await sendInteractiveCard({ title, lines }, { openId: member.feishuOpenId });
    if (!sent.ok) {
      return { ok: false, reason: sent.error ?? "飞书卡片发送失败。" };
    }
    return { ok: true, ...(sent.messageId ? { messageId: sent.messageId } : {}) };
  };
}
