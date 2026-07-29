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
// memoryd-mirror.mjs vs data/memoryd-mirror.ts. Any change to the CONFIRM card
// composition or the degrade semantics here MUST be mirrored there (and vice
// versa).
//
// The DRAFT composers (composeReviewDraftCardLines/Body, Task 15's sibling
// Task 16) deliberately have no counterpart there, and that is not an
// oversight: MonthlyReviewRepository.upsertDraft has exactly one caller in the
// tree - reviews.mjs's generateForOwner - so the platform never produces a
// draft and a mirrored copy would be code no producer can reach. If a platform
// route ever generates one, the composer moves or is mirrored then.
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
  buildDeepLink,
  sendInteractiveCard
} from "../../../packages/shared-types/dist/index.js";

// Same disclaimer line the confirm cards carried before this notifier became
// real - kept verbatim (plan Global Constraint: "改进建议 only，变更须本人确认").
const CARD_DISCLAIMER = "以上改进建议仅供参考；任何策略/纪律变更须本人另行确认后生效。";
// Shown in place of the platform link when no public base url is configured.
const NO_LINK_LINE = "完整复盘请在平台复盘页查看。";
// Closing line of the DRAFT card. A draft is not a decision - it waits for the
// owner's 确认 (the one human gate in this phase), so the card says so rather
// than reading like a finished verdict.
const DRAFT_CONFIRM_LINE = "这是草稿：确认后结论才会写入你的个人记忆；改进建议仅供参考。";
// 高/中/低 for the confidence tiers the review engine grades.
const TIER_LABELS = { high: "高", medium: "中", low: "低" };

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

  if (!buildDeepLink("review", review.id)) {
    // No public base url on this deployment - say so plainly instead of
    // printing the bare "/review/<id>" path this line used to carry, which is
    // not openable from inside Feishu (see deep-links.ts).
    lines.push(NO_LINK_LINE);
  }
  lines.push(CARD_DISCLAIMER);
  return lines;
}

/**
 * The 置信度校准 line, for the DRAFT card only.
 *
 * `systemConfidenceCalibration` is an array of per-tier rows the review engine
 * built with a MIN_SAMPLE_SIZE gate, so each tier is one of three honest
 * states: a measured hit rate, 样本不足 (rows exist but fewer than the gate), or
 * 暂无 (no graded predictions in that tier at all). None of them is rendered as
 * a 0% - "no sample" and "never right" are different facts.
 *
 * The 「全平台口径，非本人」 qualifier is not decoration: analysis_predictions has
 * no owner column (individual-stock analysis is a shared asset), so this
 * number is the SYSTEM's calibration appearing on a personal card, and saying
 * whose it is prevents the member reading it as their own.
 *
 * @param {unknown} result the review row's parsed result_json
 * @returns {string}
 */
function confidenceCalibrationLine(result) {
  const tiers = asRecord(result?.predictionReview)?.systemConfidenceCalibration;
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return "系统置信度校准：暂无数据（全平台口径，非本人）";
  }

  const parts = tiers.map((entry) => {
    const row = asRecord(entry);
    const label = TIER_LABELS[String(row?.tier)] ?? String(row?.tier ?? "?");
    if (row?.sample === "ok" && typeof row.hitFraction === "number" && typeof row.n === "number") {
      return `${label} ${formatPct(row.hitFraction)}（n=${row.n}）`;
    }
    if (row?.sample === "insufficient") {
      return `${label} 样本不足（n=${Number(row.n ?? 0)}）`;
    }
    return `${label} 暂无`;
  });

  return `系统置信度校准（全平台口径，非本人）：${parts.join("；")}`;
}

/**
 * Composes the 月度复盘草稿 card body: the same headline metrics the confirm
 * card carries, plus the 置信度校准 line, plus a plain statement that this is a
 * DRAFT waiting for the owner - a draft that notified nobody was the drift
 * this composer exists to fix (§3.4 「发本人单聊」).
 *
 * PURE - no IO, reads result_json defensively, degrades instead of throwing,
 * exactly like composeReviewConfirmCardLines above.
 *
 * @param {{id: string, period: string, generatedAt?: string|null, result?: unknown}} review
 * @returns {string[]}
 */
export function composeReviewDraftCardLines(review) {
  const result = asRecord(review.result);
  const lines = [
    `复盘周期：${review.period}`,
    `生成时间：${review.generatedAt ?? ""}`,
    selfThesisLine(result),
    decisionLine(result),
    complianceLine(result),
    alertQualityLine(result),
    confidenceCalibrationLine(result)
  ];

  const oneLineLesson = typeof result?.oneLineLesson === "string" ? result.oneLineLesson.trim() : "";
  if (oneLineLesson) {
    lines.push(`一句话教训：${oneLineLesson}`);
  }

  if (!buildDeepLink("review", review.id)) {
    lines.push(NO_LINK_LINE);
  }
  lines.push(DRAFT_CONFIRM_LINE);
  return lines;
}

/**
 * The draft card body (lines + the `/review/<id>` button when this deployment
 * has a public base url). Same shape and same spread-into-the-notifier usage
 * as composeReviewConfirmCardBody.
 *
 * @param {{id: string, period: string, generatedAt?: string|null, result?: unknown}} review
 * @returns {{lines: string[], url?: {text: string, href: string}}}
 */
export function composeReviewDraftCardBody(review) {
  const lines = composeReviewDraftCardLines(review);
  const href = buildDeepLink("review", review.id);
  return href ? { lines, url: { text: "查看复盘草稿", href } } : { lines };
}

/**
 * The card body (lines + the platform `url` button when this deployment has a
 * public base url). Spread straight into the notifier's argument object:
 * `notifier({ownerId, title, ...composeReviewConfirmCardBody(review)})`.
 *
 * @param {{id: string, period: string, confirmedAt?: string|null, result?: unknown}} review
 * @returns {{lines: string[], url?: {text: string, href: string}}}
 */
export function composeReviewConfirmCardBody(review) {
  const lines = composeReviewConfirmCardLines(review);
  const href = buildDeepLink("review", review.id);
  return href ? { lines, url: { text: "查看复盘详情", href } } : { lines };
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
 * @returns {(args: {ownerId: string, title: string, lines: string[], url?: {text: string, href: string}}) => Promise<{ok: boolean, messageId?: string, reason?: string}>}
 */
export function createFeishuReviewNotifier({ db, transport }) {
  const members = new MemberRepository(db);
  return async function feishuReviewNotifier({ ownerId, title, lines, url }) {
    const member = members.getById(ownerId);
    if (!member) {
      return { ok: false, reason: `成员不存在：${ownerId}，无法投递飞书复盘通知。` };
    }
    if (!member.feishuOpenId) {
      return { ok: false, reason: `成员 ${ownerId} 未配置 feishu_open_id，跳过飞书复盘通知。` };
    }

    const card = { title, lines, ...(url ? { url } : {}) };
    const sent = transport
      ? await sendInteractiveCard(card, { openId: member.feishuOpenId }, transport)
      : await sendInteractiveCard(card, { openId: member.feishuOpenId });
    if (!sent.ok) {
      return { ok: false, reason: sent.error ?? "飞书卡片发送失败。" };
    }
    return { ok: true, ...(sent.messageId ? { messageId: sent.messageId } : {}) };
  };
}
