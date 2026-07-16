/**
 * Member card (Task 7): `GET /member/<who>`. A VIEW only - no storage of its
 * own (tech §2.5: "视图无存储") - every field it renders already lives on
 * `members`, `theses`, `official_paper_snapshots`, or `research_tasks`.
 *
 * Identity-gated like every route past Task 3 (there must be a logged-in
 * viewer before anyone's card can be shown), but the interesting access
 * control here is a SECOND, independent check: whose card is being asked
 * for.
 *
 * SENTINELS NEVER RENDER AS PEOPLE (plan Task 7, req §1.8):
 *   - `__legacy_system__` (the v7 migration placeholder member - see
 *     identity.ts's own LEGACY_SYSTEM_MEMBER_ID comment) -> 404, unconditionally,
 *     checked BEFORE the DB lookup even runs.
 *   - `who` not resolving to any member row -> 404.
 *   - `who` resolving to a `status = 'revoked'` member -> 404 (a former
 *     member's card disappears entirely, it does not degrade to some
 *     "revoked" banner).
 *
 * PRIVACY GATE ON 战绩 (req §1.8, tech §2.5 - server-enforced, not a UI
 * hint): a subject's `show_performance = 0` hides their KPI summary from
 * everyone except themselves, and - same discipline as paper.ts's
 * `loadPaperViewData` from Task 6 - the snapshot series query for a hidden
 * subject NEVER RUNS. `loadPerformanceView` below is the one and only call
 * site for `loadSnapshotSeriesForOwner` on this page, so the gate can't be
 * accidentally bypassed by a second code path.
 *
 * VISIBILITY on theses/research (Global Constraints: "服务端强制隔离"): the
 * subject's own theses are ALWAYS queried `visibility = 'public'`-only
 * UNLESS the viewer IS the subject, in which case every visibility is
 * fetched (so a member's own card lets them audit exactly what's public
 * about themselves) - enforced in the WHERE clause itself.
 *
 * NO follow/comment/like/DM anywhere on this page (req §1.8 explicit: "不做
 * 关注/评论/点赞/私信").
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import {
  MemberRepository,
  ResearchTaskRepository,
  methodNotAllowed,
  type Member,
  type ResearchTask
} from "@packages/shared-types";

import { computePaperKpis, loadSnapshotSeriesForOwner, type PaperKpis } from "../data/snapshots.js";
import {
  computeThesisOutcome,
  loadLatestPriceForSymbol,
  loadSubjectStrategyCards,
  loadSubjectTheses,
  loadThesisHistory,
  type StrategyCardRow,
  type ThesisEvidenceRow,
  type ThesisHistoryRow
} from "../data/strategy.js";
import { renderUnauthorizedPage, resolveIdentity } from "../identity.js";
import { CONFIDENCE_LABELS } from "../reports/conclusion-box.js";
import { html, joinHtml, trustedHtml, type Html } from "../render/html.js";
import { renderPage } from "../render/layout.js";

export interface MemberCardRouteDeps {
  db: DatabaseSync;
  /** Injectable clock for deterministic tests; defaults to wall clock. */
  now?: () => Date;
}

// v7 migration placeholder (packages/shared-types database.ts) - not a real
// person, must never render as a member card. Mirrors identity.ts's
// LEGACY_SYSTEM_MEMBER_ID guard (re-declared, not imported, per this
// codebase's established "re-declare the literal, comment cross-references
// the source of truth" convention - see paper.ts's own copy of this guard).
const LEGACY_SYSTEM_MEMBER_ID = "__legacy_system__";

/** How many recent snapshots to pull for the card's KPI summary - generous
 * enough for `computePaperKpis`'s 累计/最大回撤 to find real history, same
 * value paper.ts's SERIES_LIMIT uses for the same reason. */
const SERIES_LIMIT = 500;

const DIRECTION_LABELS: Record<string, string> = { bull: "看多", bear: "看空", neutral: "中性" };
const DIRECTION_CLASS: Record<string, string> = { bull: "u", bear: "d", neutral: "" };
const VISIBILITY_LABELS: Record<string, string> = { system: "系统可用", public: "公开" };

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function currentNow(deps: MemberCardRouteDeps): Date {
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

function formatMoney(value: number): string {
  return `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 美元`;
}

function formatSignedPercent(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// 404 page
// ---------------------------------------------------------------------------

function renderNotFoundPage(viewer: Member, nonce: string, now: Date): string {
  const body = html`<div class="bento">
    <section class="card w2 dt-w4">
      <h2>未找到</h2>
      <p style="font-size:13px;color:var(--sub)">该成员不存在，或已退出圈子。</p>
    </section>
  </div>`;
  return renderPage({
    title: "未找到",
    nav: "strategy",
    member: { displayName: viewer.displayName },
    freshness: "最新",
    degraded: [],
    bodyHtml: body,
    nonce,
    now
  });
}

// ---------------------------------------------------------------------------
// Header: displayName + risk_tags/stock_tags chips
// ---------------------------------------------------------------------------

function renderTagChips(tags: readonly string[]): Html {
  if (tags.length === 0) {
    return html`<span style="font-size:12px;color:var(--sub)">未设置</span>`;
  }
  return joinHtml(
    tags.map(
      (tag) =>
        html`<span class="pill" style="background:var(--accent-soft);color:var(--accent);margin:0 6px 6px 0">${tag}</span>`
    )
  );
}

function renderHeaderCard(subject: Member): Html {
  return html`<section class="card w2 dt-w4">
    <h2>${subject.displayName}</h2>
    <div style="margin-top:6px;font-size:12.5px;color:var(--sub)">风险偏好</div>
    <div style="margin-top:4px">${renderTagChips(subject.riskTags)}</div>
    <div style="margin-top:8px;font-size:12.5px;color:var(--sub)">标的偏好</div>
    <div style="margin-top:4px">${renderTagChips(subject.stockTags)}</div>
  </section>`;
}

// ---------------------------------------------------------------------------
// 战绩 (server-gated - see module doc)
// ---------------------------------------------------------------------------

interface PerformanceView {
  visible: boolean;
  kpis: PaperKpis | null;
  hasSeries: boolean;
}

/**
 * Loads the KPI summary for `subject`, gated by `canSee` - the ONE call site
 * for `loadSnapshotSeriesForOwner` on this page. When `canSee` is false, the
 * snapshot table is never touched for `subject.id` at all.
 */
function loadPerformanceView(db: DatabaseSync, subject: Member, canSee: boolean): PerformanceView {
  if (!canSee) {
    return { visible: false, kpis: null, hasSeries: false };
  }
  const series = loadSnapshotSeriesForOwner(db, subject.id, SERIES_LIMIT);
  if (series.length === 0) {
    return { visible: true, kpis: null, hasSeries: false };
  }
  return { visible: true, kpis: computePaperKpis(series), hasSeries: true };
}

function renderPerformanceSection(view: PerformanceView): Html {
  if (!view.visible) {
    return html`<section class="card w2 dt-w2">
      <h2>模拟盘战绩</h2>
      <p style="font-size:13px;color:var(--sub)">未公开</p>
    </section>`;
  }
  if (!view.hasSeries || !view.kpis) {
    return html`<section class="card w2 dt-w2">
      <h2>模拟盘战绩</h2>
      <p style="font-size:13px;color:var(--sub)">暂无快照数据</p>
    </section>`;
  }

  const { kpis } = view;
  const netAssetsDisplay = kpis.netAssets === null ? "数据不足" : formatMoney(kpis.netAssets);
  const cumulative =
    kpis.cumulativeChangePct === null
      ? { display: "数据不足", cls: "" }
      : { display: formatSignedPercent(kpis.cumulativeChangePct), cls: kpis.cumulativeChangePct >= 0 ? "u" : "d" };
  const drawdown =
    kpis.maxDrawdownPct === null
      ? { display: "数据不足", cls: "" }
      : { display: `${kpis.maxDrawdownPct.toFixed(2)}%`, cls: kpis.maxDrawdownPct < 0 ? "d" : "" };

  return html`<section class="card w2 dt-w2">
    <h2>模拟盘战绩</h2>
    <div class="kpirow">
      <div class="kpi-main"><div class="num mono">${netAssetsDisplay}</div><div class="lbl">净值</div></div>
      <div class="kpi"><div class="num mono ${cumulative.cls}">${cumulative.display}</div><div class="lbl">累计收益</div></div>
      <div class="kpi"><div class="num mono ${drawdown.cls}">${drawdown.display}</div><div class="lbl">最大回撤</div></div>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// 公开策略清单 (strategy_cards)
// ---------------------------------------------------------------------------

const CARD_STATUS_LABELS: Record<string, string> = { active: "活跃", paused: "暂停", retired: "退役" };

function renderStrategyCardRow(card: StrategyCardRow, showVisibilityPill: boolean): Html {
  const statusLabel = CARD_STATUS_LABELS[card.status] ?? card.status;
  const visibilityPill = showVisibilityPill
    ? html`<span class="pill" style="margin-left:6px;background:var(--accent-soft);color:var(--accent)">${VISIBILITY_LABELS[card.visibility] ?? card.visibility}</span>`
    : trustedHtml("");
  return html`<div class="disc">
    <b>${card.name}</b>
    <span class="pill" style="margin-left:6px;background:var(--accent-soft);color:var(--accent)">${statusLabel}</span>
    ${visibilityPill}
  </div>`;
}

function renderStrategyCardsSection(cards: StrategyCardRow[], showVisibilityPills: boolean): Html {
  const body =
    cards.length > 0
      ? joinHtml(cards.map((card) => renderStrategyCardRow(card, showVisibilityPills)))
      : html`<p style="font-size:13px;color:var(--sub)">暂无公开策略卡</p>`;
  return html`<section class="card w2 dt-w4">
    <h2>公开策略清单</h2>
    ${body}
  </section>`;
}

// ---------------------------------------------------------------------------
// 公开论点清单 (theses + 事后走势回算 - "公开即接受检验")
// ---------------------------------------------------------------------------

function renderEvidencePoints(points: string[]): Html {
  if (points.length === 0) {
    return html`<p style="font-size:12px;color:var(--sub);margin:2px 0 0">暂无依据</p>`;
  }
  return joinHtml(points.map((point) => html`<li style="font-size:12.5px">${point}</li>`));
}

function renderJudgmentTimeline(history: ThesisHistoryRow[]): Html {
  if (history.length === 0) {
    return html`<p style="font-size:12px;color:var(--sub);margin-top:6px">暂无判断历史</p>`;
  }
  const rows = joinHtml(
    history.map(
      (entry) =>
        html`<div class="alert"><time class="mono">${entry.createdAt}</time><span>${entry.note} <span style="color:var(--sub)">· ${entry.source}</span></span></div>`
    )
  );
  return html`<div style="margin-top:6px">${rows}</div>`;
}

function renderOutcomeLine(hitRate: ReturnType<typeof computeThesisOutcome>["hitRate"]): Html {
  if (hitRate.sample === "insufficient") {
    return html`<p style="font-size:12px;color:var(--sub);margin-top:4px">样本不足（已判断 ${hitRate.n} 次）</p>`;
  }
  return html`<p style="font-size:12px;color:var(--sub);margin-top:4px">命中率 ${(hitRate.hitFraction * 100).toFixed(0)}%（${hitRate.hits} 命中 / ${hitRate.total} 共判断，样本 ${hitRate.n} 次）</p>`;
}

function renderThesisRow(
  thesis: ThesisEvidenceRow,
  showVisibilityPill: boolean,
  history: ThesisHistoryRow[],
  latestPrice: number | null
): Html {
  const directionLabel = DIRECTION_LABELS[thesis.direction] ?? thesis.direction;
  const directionClass = DIRECTION_CLASS[thesis.direction] ?? "";
  const range =
    thesis.targetLow !== null && thesis.targetHigh !== null
      ? html`目标区间 <span class="mono">${thesis.targetLow} - ${thesis.targetHigh}</span>`
      : html`目标区间未设定`;
  const invalidation =
    thesis.invalidationPrice !== null
      ? html` · 失效价 <span class="mono">${thesis.invalidationPrice}</span>`
      : trustedHtml("");
  const visibilityPill = showVisibilityPill
    ? html`<span class="pill" style="margin-left:6px;background:var(--accent-soft);color:var(--accent)">${VISIBILITY_LABELS[thesis.visibility] ?? thesis.visibility}</span>`
    : trustedHtml("");

  const outcome = computeThesisOutcome({
    thesis: { direction: thesis.direction, targetLow: thesis.targetLow, targetHigh: thesis.targetHigh, invalidationPrice: thesis.invalidationPrice },
    judgments: history.map((entry) => ({ id: entry.id })),
    latestPrice
  });

  return html`<div class="disc" style="margin-bottom:12px;padding-bottom:10px;border-bottom:1px dashed var(--line)">
    <b class="mono">${thesis.symbol}</b>
    <span class="${directionClass}" style="margin-left:6px;font-weight:600">${directionLabel}</span>
    ${visibilityPill}
    <div style="margin-top:4px">${range}${invalidation}</div>
    <div style="display:flex;gap:16px;margin-top:8px">
      <div style="flex:1"><div style="font-size:12px;color:var(--sub)">看多依据</div><ul style="margin:4px 0 0;padding-left:16px">${renderEvidencePoints(thesis.bullPoints)}</ul></div>
      <div style="flex:1"><div style="font-size:12px;color:var(--sub)">看空依据</div><ul style="margin:4px 0 0;padding-left:16px">${renderEvidencePoints(thesis.bearPoints)}</ul></div>
    </div>
    ${renderJudgmentTimeline(history)}
    ${history.length > 0 ? renderOutcomeLine(outcome.hitRate) : trustedHtml("")}
  </div>`;
}

function renderThesesSection(
  theses: ThesisEvidenceRow[],
  showVisibilityPills: boolean,
  historyByThesisId: Map<string, ThesisHistoryRow[]>,
  priceBySymbol: Map<string, number | null>
): Html {
  const body =
    theses.length > 0
      ? joinHtml(
          theses.map((thesis) =>
            renderThesisRow(
              thesis,
              showVisibilityPills,
              historyByThesisId.get(thesis.id) ?? [],
              priceBySymbol.get(thesis.symbol) ?? null
            )
          )
        )
      : html`<p style="font-size:13px;color:var(--sub)">暂无公开论点</p>`;
  return html`<section class="card w2 dt-w4">
    <h2>公开论点清单</h2>
    <p style="font-size:11.5px;color:var(--sub);margin-top:-4px">公开即接受检验</p>
    ${body}
  </section>`;
}

// ---------------------------------------------------------------------------
// 公开研判 (Phase 8 Task 4, 2026-07-16 plan: real rendering, replacing the
// pre-P8 status-only placeholder)
// ---------------------------------------------------------------------------

/** `subject`'s PUBLIC, done/degraded research_tasks only - own-card visitors
 * don't get a private-included view here the way theses do (req §1.8 lists
 * this as "本人选择公开的研判", i.e. always the public subset, even for the
 * subject themselves - unlike 战绩/论点 there's no "audit my own private
 * rows" case called for on this page). Filtered to done/degraded (not just
 * any visibility='public' row, whatever its status) because this section
 * renders a conclusion + confidence badge - a queued/running/failed task has
 * no `resultJson` to show one from. Uses the SAME `ResearchTaskRepository.
 * listForOwner` reader research.ts/reports.ts use (Task 1), rather than this
 * page's own ad hoc SQL - `listForOwner` takes a single optional status
 * filter, not a set, so "done OR degraded" is applied client-side over the
 * (per-subject, inherently small) full list. */
function loadSubjectPublicResearch(db: DatabaseSync, subjectId: string): ResearchTask[] {
  return new ResearchTaskRepository(db)
    .listForOwner(subjectId)
    .filter((task) => task.visibility === "public" && (task.status === "done" || task.status === "degraded"));
}

function renderResearchRow(task: ResearchTask): Html {
  const label = task.title ?? task.question;
  const conclusion = task.resultJson?.conclusion ?? "";
  const confidenceBadge = task.confidence
    ? html`<span class="pill ${task.confidence === "high" ? "ok" : task.confidence === "medium" ? "warn" : ""}" style="margin-left:6px">${CONFIDENCE_LABELS[task.confidence]}</span>`
    : trustedHtml("");
  return html`<div class="disc" style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px dashed var(--line)">
    <a href="/research/${task.id}" style="color:var(--accent);font-weight:600">${label}</a>${confidenceBadge}
    ${conclusion ? html`<div style="font-size:12.5px;color:var(--ink);margin-top:4px">${conclusion}</div>` : trustedHtml("")}
  </div>`;
}

function renderResearchSection(tasks: ResearchTask[]): Html {
  const body =
    tasks.length > 0
      ? joinHtml(tasks.map(renderResearchRow))
      : html`<p style="font-size:13px;color:var(--sub)">暂无公开研判</p>`;
  return html`<section class="card w2 dt-w4">
    <h2>公开研判</h2>
    ${body}
  </section>`;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function renderMemberCardPage(
  res: ServerResponse,
  deps: MemberCardRouteDeps,
  viewer: Member,
  subject: Member,
  nonce: string
): void {
  const now = currentNow(deps);
  const viewingSelf = viewer.id === subject.id;

  const performanceView = loadPerformanceView(deps.db, subject, viewingSelf || subject.showPerformance);
  const strategyCards = loadSubjectStrategyCards(deps.db, subject.id, viewingSelf);
  const theses = loadSubjectTheses(deps.db, subject.id, viewingSelf);
  const historyByThesisId = new Map<string, ThesisHistoryRow[]>();
  const priceBySymbol = new Map<string, number | null>();
  for (const thesis of theses) {
    historyByThesisId.set(thesis.id, loadThesisHistory(deps.db, thesis.id));
    if (!priceBySymbol.has(thesis.symbol)) {
      priceBySymbol.set(thesis.symbol, loadLatestPriceForSymbol(deps.db, thesis.symbol));
    }
  }
  const researchTasks = loadSubjectPublicResearch(deps.db, subject.id);

  const bodyHtml = html`<div class="bento">${renderHeaderCard(subject)}</div>
    <div class="bento" style="margin-top:10px">${renderPerformanceSection(performanceView)}</div>
    <div class="bento" style="margin-top:10px">${renderStrategyCardsSection(strategyCards, viewingSelf)}</div>
    <div class="bento" style="margin-top:10px">${renderThesesSection(theses, viewingSelf, historyByThesisId, priceBySymbol)}</div>
    <div class="bento" style="margin-top:10px">${renderResearchSection(researchTasks)}</div>`;

  const page = renderPage({
    title: subject.displayName,
    nav: "strategy",
    member: { displayName: viewer.displayName },
    freshness: "最新",
    degraded: [],
    bodyHtml,
    nonce,
    now
  });
  sendHtml(res, 200, page);
}

/**
 * Routes `GET /member/<who>`. Returns `true` if the request was handled
 * (including 401/404/405 responses), `false` if the path doesn't belong to
 * this module so the caller can keep trying other routes.
 */
export function handleMemberCardRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: MemberCardRouteDeps,
  nonce: string
): boolean {
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2 || segments[0] !== "member") {
    return false;
  }

  if (req.method !== "GET") {
    methodNotAllowed(res);
    return true;
  }

  const viewer = requireIdentity(req, res, deps.db, nonce);
  if (!viewer) {
    return true;
  }

  const who = segments[1] as string;
  const now = currentNow(deps);

  // Sentinel check BEFORE the DB lookup - see module doc: a member row could
  // (defensively) exist with this id and an 'active' status, and this must
  // still 404 regardless of what the row says.
  if (who === LEGACY_SYSTEM_MEMBER_ID) {
    sendHtml(res, 404, renderNotFoundPage(viewer, nonce, now));
    return true;
  }

  const subject = new MemberRepository(deps.db).getById(who);
  if (!subject || subject.status !== "active") {
    sendHtml(res, 404, renderNotFoundPage(viewer, nonce, now));
    return true;
  }

  renderMemberCardPage(res, deps, viewer, subject, nonce);
  return true;
}
