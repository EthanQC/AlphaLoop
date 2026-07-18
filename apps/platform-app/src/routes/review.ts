/**
 * Monthly review reading page + confirm endpoint (Phase 9 Task 4, 2026-07-16
 * plan): `GET /review/<id>` and `POST /api/reviews/<id>/confirm`, both owned
 * by this one module (plan Task 4 explicitly allows this: "POST /api/
 * reviews/:id/confirm (in review.ts or api-research-style)").
 *
 * ALWAYS PRIVATE, NO PUBLIC EXCEPTION (Global Constraint: "复盘默认仅本人可见"
 * / "复盘页/列表 B 看不到 A 的"): unlike research.ts's `/research/<id>`
 * (which lets ANY member read a `visibility='public'` row), `monthly_reviews`
 * has no visibility column at all - EVERY review is owner-only, full stop.
 * The owner-gate below has no "OR public" branch anywhere; a non-owner
 * viewing any review, confirmed or not, gets 403 unconditionally. This is
 * the one deliberate divergence from research.ts's "resolve row first,
 * compare owner, allow public" template this module otherwise follows
 * closely (404 for a nonexistent id, distinct from 403 for a real row owned
 * by someone else).
 *
 * SIX SECTIONS, FIXED ORDER (plan Task 4 req): 预测复盘 -> 决策复盘 -> 策略纪律
 * 复盘 -> 提醒质量 -> 错误归类/一句话教训/下一步 -> 改进建议. Every number
 * rendered below comes straight from `TypedMonthlyReview.result`
 * (data/monthly-review.ts's defensively-parsed view of result_json) - this
 * module computes nothing itself, it only formats what the review engine
 * (apps/openclaw-config/scripts/review-engine.mjs, cross-checked at write
 * time by review-verifier.mjs's independent recomputation, Task 3) already
 * persisted.
 *
 * DRAFT -> CONFIRMED (plan Task 4 + Global Constraint "draft→confirmed 人工
 * 确认门"): a draft review renders a "待确认" banner with a `<form
 * method="post" action="/api/reviews/<id>/confirm">` button; a confirmed one
 * renders a "已确认于 <date>" pill instead - never both, and there is no
 * confirmed -> draft path anywhere (MonthlyReviewRepository.confirm's own
 * one-way, idempotent contract).
 *
 * CONFIRM ENDPOINT IDENTITY CHAIN: `resolveIdentity` (bearer OR Access),
 * mirroring routes/api-research.ts's `POST /api/research` - NOT
 * `resolveBearerIdentity` (api-strategy.ts's write-only rule) - because this
 * endpoint's real caller is the reading page's own confirm BUTTON, a browser
 * form post behind Cloudflare Access, not just a skill/bearer client. Same
 * "TWO SUBMISSION SHAPES" branch as api-research.ts's `handleSubmit`: an
 * `application/x-www-form-urlencoded` body -> `303` back to `/review/<id>`
 * (browser follow-up forced to GET); anything else -> the `{ok, review,
 * mirror, notify}` JSON shape for a skill/bearer caller. Unlike
 * api-research.ts's submit endpoint, this one reads no body fields at all -
 * the id comes from the URL, and there is nothing else to confirm.
 *
 * POST-CONFIRM SIDE EFFECTS (memoryd mirror - still a P10-gated placeholder
 * by default - + the REAL Feishu single-chat confirm card via
 * data/feishu-review-notifier.ts, both fire-and-forget, both degrading
 * gracefully) - this is the TS port, for the platform's own HTTP surface, of
 * apps/openclaw-config/scripts/reviews.mjs's `runConfirm` CLI flow: confirm's
 * SQL status change has already committed by the time either side effect is
 * attempted, so neither one's failure can ever undo or fail the confirm
 * itself (mirrors data/memoryd-mirror.ts's own "SQL first, mirror never
 * blocks" discipline, which routes/api-strategy.ts already relies on).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { MonthlyReviewRepository, methodNotAllowed, sendJson, type Member } from "@packages/shared-types";

import { guardAsyncWrite } from "./async-guard.js";
import {
  composeReviewConfirmCardLines,
  createFeishuReviewNotifier,
  type FeishuReviewNotifier,
  type FeishuReviewNotifyResult
} from "../data/feishu-review-notifier.js";
import { createMemorydBackend, mirrorRecord, type MemorydBackend } from "../data/memoryd-mirror.js";
import {
  loadReviewById,
  type AlertQuality,
  type ComplianceRate,
  type ComplianceValue,
  type ConfidenceTierStat,
  type DecisionEntry,
  type DecisionReview,
  type DisciplineReview,
  type ExecutedSummary,
  type ImprovementSuggestions,
  type MonthlyReviewResultShape,
  type PredictionReview,
  type RejectedEntry,
  type ReturnsSummary,
  type ReviewSample,
  type SelfThesisHitRate,
  type TypedMonthlyReview
} from "../data/monthly-review.js";
import { renderUnauthorizedPage, resolveIdentity } from "../identity.js";
import { renderForbiddenPage } from "../render/forbidden.js";
import { html, joinHtml, trustedHtml, type Html } from "../render/html.js";
import { renderPage } from "../render/layout.js";

// ---------------------------------------------------------------------------
// Feishu single-chat confirm notifier - REAL since the P10 wiring: the
// factory/composer live in data/feishu-review-notifier.ts (re-exported here
// so server.ts's existing `type FeishuReviewNotifier` import keeps working),
// delivering over the exact sendInteractiveCard channel the market-alert
// cards already use. Every caller here still treats any failure (a member
// with no feishu_open_id, a transport error) as a fire-and-forget degrade,
// never a failure of confirm itself.
// ---------------------------------------------------------------------------

export { createFeishuReviewNotifier, type FeishuReviewNotifier, type FeishuReviewNotifyResult };

async function notifyFeishuReviewConfirmed(
  notifier: FeishuReviewNotifier,
  ownerId: string,
  review: TypedMonthlyReview
): Promise<{ delivered: boolean; reason?: string; messageId?: string | null }> {
  try {
    const result = await notifier({
      ownerId,
      title: `${review.period} 月度复盘已确认`,
      lines: composeReviewConfirmCardLines({
        id: review.id,
        period: review.period,
        confirmedAt: review.confirmedAt ?? null,
        result: review.result
      })
    });
    if (result.ok) {
      return { delivered: true, messageId: result.messageId ?? null };
    }
    const reason = result.reason ? String(result.reason) : "feishu notifier returned ok:false";
    console.warn(`飞书单聊复盘确认通知跳过（owner=${ownerId}）：${reason}`);
    return { delivered: false, reason };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`飞书单聊复盘确认通知跳过（owner=${ownerId}）：${reason}`);
    return { delivered: false, reason };
  }
}

// ---------------------------------------------------------------------------
// Deps / small shared helpers (same shape as every other route module).
// ---------------------------------------------------------------------------

export interface ReviewRouteDeps {
  db: DatabaseSync;
  /** Injectable clock for deterministic tests; defaults to wall clock. */
  now?: () => Date;
  /** Injectable memoryd mirror backend; defaults to createMemorydBackend()'s
   * P10-gated placeholder (fire-and-forget degrade) when omitted. */
  memorydBackend?: MemorydBackend;
  /** Injectable Feishu confirm notifier; defaults to the REAL
   * createFeishuReviewNotifier({db}) (data/feishu-review-notifier.ts -
   * members.feishu_open_id lookup + sendInteractiveCard) when omitted.
   * Tests inject a fake to stay hermetic. */
  feishuNotifier?: FeishuReviewNotifier;
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function currentNow(deps: ReviewRouteDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function requireIdentity(req: IncomingMessage, res: ServerResponse, db: DatabaseSync, nonce: string): Member | null {
  const member = resolveIdentity(req, db);
  if (!member) {
    sendHtml(res, 401, renderUnauthorizedPage(nonce));
    return null;
  }
  return member;
}

const BEIJING_DATETIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

/** `YYYY-MM-DD HH:mm` in Asia/Shanghai (Beijing has no DST, so a fixed IANA
 * zone is exact year-round) - same convention as research.ts's own
 * formatBeijingDateTime, used here for the "已确认于 <date>" pill. */
function formatBeijingDateTime(iso: string): string {
  const parts = BEIJING_DATETIME_FORMAT.formatToParts(new Date(iso));
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")} ${byType.get("hour")}:${byType.get("minute")}`;
}

function formatPct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function formatSignedPct(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function pctClass(value: number): "u" | "d" {
  return value >= 0 ? "u" : "d";
}

function renderSampleNote(sample: ReviewSample): Html {
  if (sample === "insufficient") {
    return html`<p style="font-size:12px;color:var(--sub)">样本不足（&lt;10），暂不下结论。</p>`;
  }
  if (sample === "none") {
    return html`<p style="font-size:12px;color:var(--sub)">暂无数据。</p>`;
  }
  return trustedHtml("");
}

// ---------------------------------------------------------------------------
// 404 page
// ---------------------------------------------------------------------------

function renderNotFoundPage(member: Member, nonce: string, now: Date): string {
  const body = html`<div class="bento">
    <section class="card w2 dt-w4">
      <h2>未找到</h2>
      <p style="font-size:13px;color:var(--sub)">该复盘不存在。</p>
    </section>
  </div>`;
  return renderPage({
    title: "未找到",
    nav: "reports",
    member: { displayName: member.displayName },
    freshness: "最新",
    degraded: [],
    bodyHtml: body,
    nonce,
    now
  });
}

// ---------------------------------------------------------------------------
// Header + draft/confirmed status
// ---------------------------------------------------------------------------

function renderHeaderCard(review: TypedMonthlyReview): Html {
  const statusPill =
    review.status === "confirmed"
      ? html`<span class="pill ok">已确认于 ${review.confirmedAt ? formatBeijingDateTime(review.confirmedAt) : "—"}</span>`
      : html`<span class="pill warn">草稿</span>`;
  return html`<section class="card w2 dt-w4">
    <h2>${review.period} 月度复盘 ${statusPill}</h2>
    <p style="margin-top:4px;font-size:12px;color:var(--sub)">复盘仅本人可见，不对外公开。</p>
  </section>`;
}

function renderPendingConfirmBanner(reviewId: string): Html {
  return html`<div class="bento" style="padding-bottom:0">
    <section class="card w2 dt-w4 amber" role="alert" aria-label="复盘待确认">
      <h2 style="color:var(--amber)">待确认</h2>
      <p style="margin:0 0 10px;font-size:13px;color:var(--ink)">本月复盘为草稿状态，确认后归档为长期记录（memoryd 镜像 + 飞书通知），且此后不可撤销。</p>
      <form method="post" action="/api/reviews/${reviewId}/confirm">
        <button class="btn primary" type="submit" style="flex:none;padding:9px 18px">确认复盘</button>
      </form>
    </section>
  </div>`;
}

// ---------------------------------------------------------------------------
// ① 预测复盘 - 本人论点命中率 + 系统置信度校准三档
// ---------------------------------------------------------------------------

function renderSelfThesisHitRateRow(hitRate: SelfThesisHitRate): Html {
  if (hitRate.sample === "ok") {
    return html`<div class="alert">
      <span>本人论点方向命中率</span>
      <span class="mono">${formatPct(hitRate.hitFraction)}</span>
      <span style="color:var(--sub)">（${hitRate.hits}/${hitRate.total}，样本 ${hitRate.n}）</span>
    </div>`;
  }
  return html`<div class="alert">
    <span>本人论点方向命中率</span>
    <span style="color:var(--sub)">样本不足（n=${hitRate.n}）${hitRate.reason ? ` · ${hitRate.reason}` : ""}</span>
  </div>`;
}

const CONFIDENCE_TIER_LABELS: Record<string, string> = { low: "低", medium: "中", high: "高" };

function renderConfidenceTierRow(tier: ConfidenceTierStat): Html {
  const label = CONFIDENCE_TIER_LABELS[tier.tier] ?? tier.tier;
  if (tier.sample === "ok") {
    return html`<div class="alert">
      <span>「${label}」置信度</span>
      <span class="mono">${formatPct(tier.hitFraction)}</span>
      <span style="color:var(--sub)">（${tier.hits}/${tier.n}）</span>
    </div>`;
  }
  const note = tier.sample === "none" ? "暂无数据" : `样本不足（n=${tier.n}）`;
  return html`<div class="alert"><span>「${label}」置信度</span><span style="color:var(--sub)">${note}</span></div>`;
}

function renderPredictionReviewCard(predictionReview: PredictionReview): Html {
  return html`<section class="card w2 dt-w4">
    <h2>预测复盘</h2>
    <h3 style="margin-top:4px;font-size:13px;color:var(--sub)">本人论点命中率</h3>
    ${renderSelfThesisHitRateRow(predictionReview.selfThesisHitRate)}
    <h3 style="margin-top:12px;font-size:13px;color:var(--sub)">${predictionReview.systemConfidenceCalibrationNote}</h3>
    ${joinHtml(predictionReview.systemConfidenceCalibration.map(renderConfidenceTierRow))}
  </section>`;
}

// ---------------------------------------------------------------------------
// ② 决策复盘 - 提案收益 vs 买入持有基准 + 被拒简化口径 + 免责
// ---------------------------------------------------------------------------

function renderDecisionEntryRow(entry: DecisionEntry): Html {
  const returnHtml =
    entry.decisionReturnPct === null
      ? html`<span style="color:var(--sub)">无法计价</span>`
      : html`<span class="mono ${pctClass(entry.decisionReturnPct)}">${formatSignedPct(entry.decisionReturnPct)}</span>`;
  const alphaHtml =
    entry.alphaPct === null
      ? trustedHtml("")
      : html`<span style="color:var(--sub)">超额 <span class="mono ${pctClass(entry.alphaPct)}">${formatSignedPct(entry.alphaPct)}</span></span>`;
  return html`<div class="alert"><span>${entry.symbol} ${entry.side}</span>${returnHtml}${alphaHtml}</div>`;
}

function renderExecutedSection(executed: ExecutedSummary): Html {
  const summary =
    executed.sample === "ok"
      ? html`<p style="font-size:13px;color:var(--ink)">
          平均决策收益 <span class="mono ${pctClass(executed.avgDecisionReturnPct)}">${formatSignedPct(executed.avgDecisionReturnPct)}</span>
          vs 基准 <span class="mono">${formatSignedPct(executed.avgBenchmarkReturnPct)}</span>，
          超额 <span class="mono ${pctClass(executed.avgAlphaPct)}">${formatSignedPct(executed.avgAlphaPct)}</span>
        </p>`
      : renderSampleNote(executed.sample);
  const rows =
    executed.entries.length > 0
      ? joinHtml(executed.entries.map(renderDecisionEntryRow))
      : html`<p style="font-size:13px;color:var(--sub)">本月无已执行提案</p>`;
  return html`${summary}${rows}`;
}

function renderRejectedEntryRow(entry: RejectedEntry): Html {
  const returnHtml =
    entry.hypotheticalReturnPct === null
      ? html`<span style="color:var(--sub)">无法计价</span>`
      : html`<span class="mono ${pctClass(entry.hypotheticalReturnPct)}">${formatSignedPct(entry.hypotheticalReturnPct)}</span>`;
  return html`<div class="alert"><span>${entry.symbol} ${entry.side}（被拒）</span>${returnHtml}</div>`;
}

function renderDecisionReviewCard(decisionReview: DecisionReview): Html {
  const rejectedRows =
    decisionReview.rejected.entries.length > 0
      ? joinHtml(decisionReview.rejected.entries.map(renderRejectedEntryRow))
      : html`<p style="font-size:13px;color:var(--sub)">本月无被拒提案</p>`;
  return html`<section class="card w2 dt-w4">
    <h2>决策复盘</h2>
    <h3 style="margin-top:4px;font-size:13px;color:var(--sub)">已执行提案（基准：${decisionReview.benchmarkSymbol}）</h3>
    ${renderExecutedSection(decisionReview.executed)}
    <h3 style="margin-top:12px;font-size:13px;color:var(--sub)">被拒提案（简化口径）</h3>
    ${rejectedRows}
    <p style="margin-top:6px;font-size:12px;color:var(--sub)">${decisionReview.rejected.disclaimer}</p>
  </section>`;
}

// ---------------------------------------------------------------------------
// ③ 策略纪律复盘 - 遵守率 + 守规矩值多少钱
// ---------------------------------------------------------------------------

function renderComplianceRateRow(complianceRate: ComplianceRate): Html {
  if (complianceRate.sample === "ok") {
    return html`<div class="alert">
      <span>近期遵守率</span>
      <span class="mono">${formatPct(complianceRate.rate)}</span>
      <span style="color:var(--sub)">（${complianceRate.passed}/${complianceRate.checked}）</span>
    </div>`;
  }
  if (complianceRate.sample === "insufficient") {
    return html`<div class="alert"><span>近期遵守率</span><span style="color:var(--sub)">样本不足（已检查 ${complianceRate.checked} 次）</span></div>`;
  }
  return html`<div class="alert"><span>近期遵守率</span><span style="color:var(--sub)">暂无数据</span></div>`;
}

function renderReturnsSummary(label: string, summary: ReturnsSummary): Html {
  if (summary.sample === "ok") {
    return html`<span>${label}：<span class="mono ${pctClass(summary.avgReturnPct)}">${formatSignedPct(summary.avgReturnPct)}</span>（n=${summary.n}）</span>`;
  }
  const note = summary.sample === "none" ? "暂无数据" : `样本不足（n=${summary.n}）`;
  return html`<span>${label}：<span style="color:var(--sub)">${note}</span></span>`;
}

function renderComplianceValue(complianceValue: ComplianceValue): Html {
  const deltaHtml =
    complianceValue.deltaPct === null
      ? html`<p style="margin-top:6px;font-size:12px;color:var(--sub)">样本不足，暂无法计算"守规矩值多少钱"。</p>`
      : html`<p style="margin-top:6px;font-size:13px;color:var(--ink)">
          守规矩值多少钱：遵守纪律的交易比违反纪律的多赚
          <span class="mono ${pctClass(complianceValue.deltaPct)}">${formatSignedPct(complianceValue.deltaPct)}</span>
        </p>`;
  return html`<div class="alert">${renderReturnsSummary("遵守纪律", complianceValue.compliant)} · ${renderReturnsSummary("违反纪律", complianceValue.violating)}</div>${deltaHtml}`;
}

function renderDisciplineReviewCard(disciplineReview: DisciplineReview): Html {
  return html`<section class="card w2 dt-w4">
    <h2>策略纪律复盘</h2>
    ${renderComplianceRateRow(disciplineReview.complianceRate)}
    <h3 style="margin-top:12px;font-size:13px;color:var(--sub)">守规矩值多少钱</h3>
    ${renderComplianceValue(disciplineReview.complianceValue)}
  </section>`;
}

// ---------------------------------------------------------------------------
// ④ 提醒质量 - 触发/误报/误报率
// ---------------------------------------------------------------------------

function renderAlertQualityCard(alertQuality: AlertQuality): Html {
  if (alertQuality.sample === "none") {
    return html`<section class="card w2 dt-w4">
      <h2>提醒质量</h2>
      <p style="font-size:13px;color:var(--sub)">本月无提醒触发</p>
    </section>`;
  }
  return html`<section class="card w2 dt-w4">
    <h2>提醒质量</h2>
    <div class="kpirow">
      <div class="kpi-main"><div class="num mono">${alertQuality.triggeredCount}</div><div class="lbl">触发次数</div></div>
      <div class="kpi"><div class="num mono">${alertQuality.misreportCount}</div><div class="lbl">误报次数</div></div>
      <div class="kpi"><div class="num mono">${formatPct(alertQuality.misreportRate)}</div><div class="lbl">误报率</div></div>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// ⑤ 错误归类 + 一句话教训 + 下一步
// ---------------------------------------------------------------------------

function renderLessonsCard(result: MonthlyReviewResultShape): Html {
  const categories =
    result.errorCategories.length > 0
      ? joinHtml(result.errorCategories.map((category) => html`<span class="pill warn" style="margin:0 6px 6px 0">${category}</span>`))
      : html`<p style="font-size:13px;color:var(--sub)">暂无归类</p>`;
  const steps =
    result.nextSteps.length > 0
      ? joinHtml(result.nextSteps.map((step) => html`<div class="alert"><span>${step}</span></div>`))
      : html`<p style="font-size:13px;color:var(--sub)">暂无下一步</p>`;
  return html`<section class="card w2 dt-w4">
    <h2>错误归类 · 一句话教训 · 下一步</h2>
    <div style="margin:6px 0 10px">${categories}</div>
    <p style="font-size:13.5px;line-height:1.7;color:var(--ink)">${result.oneLineLesson}</p>
    <h3 style="margin-top:12px;font-size:13px;color:var(--sub)">下一步</h3>
    ${steps}
  </section>`;
}

// ---------------------------------------------------------------------------
// ⑥ 改进建议 - "建议 only，变更须本人确认"
// ---------------------------------------------------------------------------

function renderSuggestionsCard(suggestions: ImprovementSuggestions): Html {
  const items =
    suggestions.items.length > 0
      ? joinHtml(suggestions.items.map((item) => html`<div class="alert"><span>${item}</span></div>`))
      : html`<p style="font-size:13px;color:var(--sub)">暂无改进建议</p>`;
  return html`<section class="card w2 dt-w4">
    <h2>改进建议</h2>
    ${items}
    <p style="margin-top:8px;font-size:12px;color:var(--amber)">${suggestions.disclaimer}</p>
  </section>`;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function renderResultBody(result: MonthlyReviewResultShape): Html {
  return html`<div class="bento" style="margin-top:10px">${renderPredictionReviewCard(result.predictionReview)}</div>
    <div class="bento" style="margin-top:10px">${renderDecisionReviewCard(result.decisionReview)}</div>
    <div class="bento" style="margin-top:10px">${renderDisciplineReviewCard(result.disciplineReview)}</div>
    <div class="bento" style="margin-top:10px">${renderAlertQualityCard(result.alertQuality)}</div>
    <div class="bento" style="margin-top:10px">${renderLessonsCard(result)}</div>
    <div class="bento" style="margin-top:10px">${renderSuggestionsCard(result.improvementSuggestions)}</div>`;
}

// Defensive only (see data/monthly-review.ts's own `toResultShape` comment):
// the real pipeline always writes a result before a review is ever shown,
// but a hand-seeded/corrupted row degrades to this honest empty state
// instead of throwing and 500ing the whole page.
function renderMissingResultBody(): Html {
  return html`<div class="bento" style="margin-top:10px">
    <section class="card w2 dt-w4">
      <h2>暂无复盘内容</h2>
      <p style="font-size:13px;color:var(--sub)">该复盘尚未生成结果。</p>
    </section>
  </div>`;
}

function renderReviewBody(review: TypedMonthlyReview): Html {
  const banner = review.status === "draft" ? renderPendingConfirmBanner(review.id) : trustedHtml("");
  return html`${banner}
    <div class="bento">${renderHeaderCard(review)}</div>
    ${review.result ? renderResultBody(review.result) : renderMissingResultBody()}`;
}

function renderReviewPage(
  res: ServerResponse,
  deps: ReviewRouteDeps,
  member: Member,
  review: TypedMonthlyReview,
  nonce: string
): void {
  const now = currentNow(deps);
  const page = renderPage({
    title: `${review.period} 月度复盘`,
    nav: "reports",
    member: { displayName: member.displayName },
    freshness: "最新",
    degraded: [],
    bodyHtml: renderReviewBody(review),
    nonce,
    now
  });
  sendHtml(res, 200, page);
}

// ---------------------------------------------------------------------------
// GET /review/<id>
// ---------------------------------------------------------------------------

function handleGetReview(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ReviewRouteDeps,
  id: string,
  nonce: string
): void {
  const member = requireIdentity(req, res, deps.db, nonce);
  if (!member) {
    return;
  }

  const now = currentNow(deps);
  const review = loadReviewById(deps.db, id);
  if (!review) {
    sendHtml(res, 404, renderNotFoundPage(member, nonce, now));
    return;
  }

  // 复盘 has NO public visibility, ever - see module header. Non-owner ->
  // 403 unconditionally, regardless of draft/confirmed status.
  if (review.ownerId !== member.id) {
    sendHtml(res, 403, renderForbiddenPage(member, "reports", nonce, now));
    return;
  }

  renderReviewPage(res, deps, member, review, nonce);
}

// ---------------------------------------------------------------------------
// POST /api/reviews/<id>/confirm
// ---------------------------------------------------------------------------

const FORM_URLENCODED_CONTENT_TYPE = "application/x-www-form-urlencoded";

/** True for the reading page's own `<form method="post">` confirm button -
 * see module header's "TWO SUBMISSION SHAPES" (mirrors api-research.ts's
 * identically-named helper). Matched as a prefix since a real browser sends
 * `application/x-www-form-urlencoded;charset=UTF-8`. */
function isFormUrlEncoded(req: IncomingMessage): boolean {
  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  return contentType.startsWith(FORM_URLENCODED_CONTENT_TYPE);
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, {
    ok: false,
    error: "未获授权：请通过圈内白名单邮箱登录，或提供有效的 Authorization: Bearer <token>"
  });
}

async function handleConfirm(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ReviewRouteDeps,
  id: string
): Promise<void> {
  const identity = resolveIdentity(req, deps.db);
  if (!identity) {
    unauthorized(res);
    return;
  }

  const repo = new MonthlyReviewRepository(deps.db);
  const existing = repo.getById(id);
  if (!existing) {
    sendJson(res, 404, { ok: false, error: `未找到复盘：${id}` });
    return;
  }
  // Resolve-row-first, compare-owner (proposal.ts/research.ts/
  // api-strategy.ts's shared discipline) - 404 for a nonexistent row is
  // distinct from 403 for a real row owned by someone else. No "OR public"
  // branch - see module header.
  if (existing.ownerId !== identity.id) {
    sendJson(res, 403, { ok: false, error: "无权操作：该复盘属于其他成员" });
    return;
  }

  // draft -> confirmed, one-way, idempotent on an already-confirmed review
  // (MonthlyReviewRepository.confirm's own contract) - a duplicate click
  // never throws or re-stamps confirmed_at.
  repo.confirm(id, identity.id);

  const typed = loadReviewById(deps.db, id);
  if (!typed) {
    // Defensive only: confirm() above just wrote this row - a null re-fetch
    // here would mean it vanished mid-request, which should never happen in
    // practice, but this degrades honestly rather than throwing.
    sendJson(res, 500, { ok: false, error: "复盘确认后重新读取失败" });
    return;
  }

  const memorydBackend = deps.memorydBackend ?? createMemorydBackend();
  const mirror = await mirrorRecord(memorydBackend, {
    ownerId: identity.id,
    recordType: "monthly_review",
    title: `${typed.period} 月度复盘结论`,
    content: JSON.stringify({
      period: typed.period,
      oneLineLesson: typed.result?.oneLineLesson ?? null,
      errorCategories: typed.result?.errorCategories ?? [],
      nextSteps: typed.result?.nextSteps ?? []
    }),
    visibility: "private"
  });

  const feishuNotifier = deps.feishuNotifier ?? createFeishuReviewNotifier({ db: deps.db });
  const notify = await notifyFeishuReviewConfirmed(feishuNotifier, identity.id, typed);

  if (isFormUrlEncoded(req)) {
    // See module header's "TWO SUBMISSION SHAPES" - 303 (not 302) so the
    // browser's follow-up request is a GET regardless of the original
    // method.
    res.writeHead(303, { Location: `/review/${id}` });
    res.end();
    return;
  }

  sendJson(res, 200, { ok: true, review: typed, mirror, notify });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Routes `GET /review/<id>` and `POST /api/reviews/<id>/confirm`. Returns
 * `true` if the request was handled (including 401/403/404/405 responses),
 * `false` if the path doesn't belong to this module so the caller can keep
 * trying other routes.
 */
export function handleReviewRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ReviewRouteDeps,
  nonce: string
): boolean {
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);

  if (segments.length === 2 && segments[0] === "review") {
    if (req.method !== "GET") {
      methodNotAllowed(res);
      return true;
    }
    handleGetReview(req, res, deps, segments[1] as string, nonce);
    return true;
  }

  if (segments.length === 4 && segments[0] === "api" && segments[1] === "reviews" && segments[3] === "confirm") {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    guardAsyncWrite(handleConfirm(req, res, deps, segments[2] as string), req, res, "review");
    return true;
  }

  return false;
}
