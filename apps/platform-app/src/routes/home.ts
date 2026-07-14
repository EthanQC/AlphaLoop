/**
 * Home page (Task 5): `GET /`. Identity-gated like every route past Task 3
 * (resolveIdentity runs first; a null result renders the shared 401 page).
 *
 * Block order is a BINDING part of the plan (Task 5, req §1.2) and must not
 * be reshuffled:
 *   ① 开始研究       - disabled input/button placeholder ("站内研究 P8 上线").
 *   ② 我的模拟盘概览 - real snapshot data (net assets + today's change) via
 *                      data/overview.ts, or an honest empty state.
 *   ③ 我的待办       - real pending proposals, or "提案审批 P6 上线" (always
 *                      the latter today - P6 hasn't shipped writes yet).
 *   ④ 我的提醒流水   - real alert_events rows, or "暂无提醒".
 *   ⑤ 今日日报卡     - latest daily report from Task 4's disk scanner, or
 *                      "暂无日报".
 *   ⑥ 纪律速览       - real discipline_rules, or "策略记忆 P7 上线" (always
 *                      the latter today - P7 hasn't shipped writes yet).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { methodNotAllowed, type Member } from "@packages/shared-types";

import {
  loadDisciplineRules,
  loadLatestSnapshotForOwner,
  loadPendingProposals,
  loadPreviousDaySnapshotForOwner,
  loadRecentAlertEvents,
  type AlertEventRow,
  type DisciplineRuleRow,
  type OwnerSnapshot,
  type ProposalRow
} from "../data/overview.js";
import { renderUnauthorizedPage, resolveIdentity } from "../identity.js";
import { scanReports, type ReportIndexEntry } from "../reports/scanner.js";
import { html, joinHtml, trustedHtml, type Html } from "../render/html.js";
import { freshnessPillClass, renderPage, type Freshness } from "../render/layout.js";

export interface HomeRouteDeps {
  db: DatabaseSync;
  repoRoot: string;
  /** Injectable clock for deterministic tests; defaults to wall clock. */
  now?: () => Date;
}

const ALERT_EVENT_LIMIT = 10;
/** Snapshot age threshold for the home page's own freshness rule (plan Task
 * 5): "snapshot exists and < 90min old -> 最新; exists older -> 延迟; missing
 * -> 部分缺失". Distinct from (and does not reuse) reports.ts's date-based
 * freshness rule - the two pages have different notions of "fresh". */
const SNAPSHOT_FRESH_WINDOW_MS = 90 * 60 * 1000;

const RULE_TYPE_LABELS: Record<string, string> = {
  daily_move: "日内波动",
  unrealized_pnl: "浮动盈亏",
  spike_5m: "5分钟异动",
  exposure: "敞口"
};

const ENFORCEMENT_LABELS: Record<string, string> = {
  hard: "代码强制",
  proposal_check: "提案检查",
  self: "自我约束"
};

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function currentNow(deps: HomeRouteDeps): Date {
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

// Module-level (not per-call) - Intl.DateTimeFormat construction is
// comparatively expensive (locale/calendar data setup), and
// formatBeijingShortTime below is called once per alert-feed row (up to
// ALERT_EVENT_LIMIT times per request); its options never vary, so building
// it once at module load and reusing it is strictly cheaper than
// reconstructing it on every call with no behavior difference.
const BEIJING_SHORT_TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

/** `MM-DD HH:mm` in Asia/Shanghai (Beijing has no DST, so a fixed IANA zone
 * is exact year-round) - compact enough for the alert feed's per-row time. */
function formatBeijingShortTime(iso: string): string {
  const parts = BEIJING_SHORT_TIME_FORMAT.formatToParts(new Date(iso));
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("month")}-${byType.get("day")} ${byType.get("hour")}:${byType.get("minute")}`;
}

function computeHomeFreshness(snapshot: OwnerSnapshot | null, now: Date): Freshness {
  if (!snapshot) {
    return "部分缺失";
  }
  const ageMs = now.getTime() - new Date(snapshot.fetchedAt).getTime();
  return ageMs < SNAPSHOT_FRESH_WINDOW_MS ? "最新" : "延迟";
}

function formatNetAssets(value: number): string {
  return `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 美元`;
}

function formatSignedPercent(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

/** Single source of truth for the degraded-valuation fallback wording, so
 * the inline card note (renderDegradedNote) and the page-level degraded
 * banner (renderHomePage) can never disagree about the same condition. */
function degradedReasonText(snapshot: OwnerSnapshot): string {
  return snapshot.degradedReason ?? "快照数据降级（原因未知）";
}

/**
 * Computes 今日涨跌 (today's net-asset change) against the previous day's
 * close. Deliberately requires `previousDay.id !== snapshot.id` in addition
 * to both net-asset values being present and non-zero: `snapshot` and
 * `previousDay` can resolve to the IDENTICAL row (e.g. an owner whose only
 * snapshot is several days stale - loadLatestSnapshotForOwner returns it as
 * the latest, and loadPreviousDaySnapshotForOwner independently returns the
 * same row as the newest one before today's boundary). Without this guard
 * that produces a fabricated "+0.00%" - a snapshot can't have "changed"
 * against itself - instead of the honest "数据不足" the plan calls for when
 * there is no genuine today-vs-yesterday comparison available. `Number
 * .isFinite` guards the arithmetic itself against a NaN/Infinity result
 * (e.g. a corrupted net_assets value that isn't actually the literal 0 the
 * explicit check above already excludes).
 */
function computeDailyChange(
  snapshot: OwnerSnapshot,
  previousDay: OwnerSnapshot | null
): { changeDisplay: string; changeClass: string } {
  if (
    snapshot.netAssets === null ||
    !previousDay ||
    previousDay.id === snapshot.id ||
    previousDay.netAssets === null ||
    previousDay.netAssets === 0
  ) {
    return { changeDisplay: "数据不足", changeClass: "" };
  }

  const pct = ((snapshot.netAssets - previousDay.netAssets) / previousDay.netAssets) * 100;
  if (!Number.isFinite(pct)) {
    return { changeDisplay: "数据不足", changeClass: "" };
  }

  return { changeDisplay: formatSignedPercent(pct), changeClass: pct >= 0 ? "u" : "d" };
}

// ---------------------------------------------------------------------------
// ① 开始研究
// ---------------------------------------------------------------------------

function renderStartResearchBlock(): Html {
  return html`<section class="card w2 dt-w4">
    <h2>开始研究 <span class="pill warn">站内研究 P8 上线</span></h2>
    <div class="ask" aria-disabled="true">
      <input
        type="text"
        placeholder="问点什么…如「NVDA 财报前要减仓吗」"
        disabled
        style="flex:1;background:transparent;border:none;color:inherit;font-size:14.5px;outline:none"
      >
    </div>
    <div style="margin-top:10px">
      <button class="btn primary" type="button" disabled style="flex:none;padding:9px 18px">开始研究</button>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// ② 我的模拟盘概览
// ---------------------------------------------------------------------------

function renderDegradedNote(snapshot: OwnerSnapshot): Html {
  if (!snapshot.degraded) {
    return trustedHtml("");
  }
  return html`<p style="margin-top:8px;font-size:12px;color:var(--amber)">估值降级：${degradedReasonText(snapshot)}</p>`;
}

function renderPaperOverviewBlock(
  snapshot: OwnerSnapshot | null,
  previousDay: OwnerSnapshot | null,
  freshness: Freshness
): Html {
  if (!snapshot) {
    return html`<section class="card w2 dt-w2">
      <h2>我的模拟盘概览</h2>
      <p style="font-size:13px;color:var(--sub)">暂无快照数据——模拟盘接入后显示</p>
    </section>`;
  }

  const netAssetsDisplay = snapshot.netAssets === null ? "数据不足" : formatNetAssets(snapshot.netAssets);
  const { changeDisplay, changeClass } = computeDailyChange(snapshot, previousDay);

  const pillClass = freshnessPillClass(freshness);

  return html`<section class="card w2 dt-w2">
    <h2>我的模拟盘概览 <span class="pill ${pillClass}">${freshness}</span></h2>
    <div class="kpirow">
      <div class="kpi-main"><div class="num mono">${netAssetsDisplay}</div><div class="lbl">净值</div></div>
      <div class="kpi"><div class="num mono ${changeClass}">${changeDisplay}</div><div class="lbl">今日</div></div>
    </div>
    ${renderDegradedNote(snapshot)}
  </section>`;
}

// ---------------------------------------------------------------------------
// ③ 我的待办
// ---------------------------------------------------------------------------

function renderProposalRow(proposal: ProposalRow): Html {
  return html`<div class="todo">
    <div>
      <div class="t1">${proposal.symbol} ${proposal.side} ${proposal.quantity} 股</div>
      <div class="t2 mono">${proposal.reason}</div>
    </div>
  </div>`;
}

function renderTodoBlock(proposals: ProposalRow[]): Html {
  const body =
    proposals.length > 0
      ? joinHtml(proposals.map(renderProposalRow))
      : html`<p style="font-size:13px;color:var(--sub)">提案审批 P6 上线</p>`;
  return html`<section class="card dt-w2">
    <h2>我的待办</h2>
    ${body}
  </section>`;
}

// ---------------------------------------------------------------------------
// ④ 我的提醒流水
// ---------------------------------------------------------------------------

function renderAlertRow(event: AlertEventRow): Html {
  const label = RULE_TYPE_LABELS[event.ruleType] ?? event.ruleType;
  return html`<div class="alert">
    <time class="mono">${formatBeijingShortTime(event.triggeredAt)}</time>
    <span>${event.symbol} ${label} <b class="mono">${event.value}</b></span>
  </div>`;
}

function renderAlertFeedBlock(events: ReadonlyArray<AlertEventRow>): Html {
  const body =
    events.length > 0
      ? joinHtml(events.map(renderAlertRow))
      : html`<p style="font-size:13px;color:var(--sub)">暂无提醒</p>`;
  return html`<section class="card dt-w2">
    <h2>我的提醒流水</h2>
    ${body}
  </section>`;
}

// ---------------------------------------------------------------------------
// ⑤ 今日日报卡
// ---------------------------------------------------------------------------

function renderDailyReportBlock(entry: ReportIndexEntry | undefined): Html {
  if (!entry) {
    return html`<section class="card dt-w2 report">
      <h2>今日日报卡</h2>
      <p style="font-size:13px;color:var(--sub)">暂无日报</p>
    </section>`;
  }

  const legacyPill = entry.legacy ? html`<span class="pill warn">历史存档</span>` : trustedHtml("");

  return html`<section class="card dt-w2 report">
    <h2>今日日报卡 ${legacyPill}</h2>
    <h3>${entry.title}</h3>
    <div class="report-links">
      <a class="btn primary" href="/${entry.type}/${entry.date}">阅读全文</a>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// ⑥ 纪律速览
// ---------------------------------------------------------------------------

function renderDisciplineRow(rule: DisciplineRuleRow): Html {
  const label = ENFORCEMENT_LABELS[rule.enforcement] ?? rule.enforcement;
  return html`<div class="disc">${rule.ruleText} <span style="color:var(--sub);font-size:12px">· ${label}</span></div>`;
}

function renderDisciplineBlock(rules: DisciplineRuleRow[]): Html {
  const body =
    rules.length > 0
      ? joinHtml(rules.map(renderDisciplineRow))
      : html`<p style="font-size:13px;color:var(--sub)">策略记忆 P7 上线</p>`;
  return html`<section class="card w2 dt-w4">
    <h2>纪律速览</h2>
    ${body}
  </section>`;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function renderHomeBody(
  snapshot: OwnerSnapshot | null,
  previousDay: OwnerSnapshot | null,
  freshness: Freshness,
  proposals: ProposalRow[],
  alertEvents: ReadonlyArray<AlertEventRow>,
  latestDaily: ReportIndexEntry | undefined,
  disciplineRules: DisciplineRuleRow[]
): Html {
  return html`<div class="bento">
      ${renderStartResearchBlock()}
    </div>
    <div class="bento" style="margin-top:10px">
      ${renderPaperOverviewBlock(snapshot, previousDay, freshness)}
      ${renderTodoBlock(proposals)}
    </div>
    <div class="bento" style="margin-top:10px">
      ${renderAlertFeedBlock(alertEvents)}
      ${renderDailyReportBlock(latestDaily)}
    </div>
    <div class="bento" style="margin-top:10px">
      ${renderDisciplineBlock(disciplineRules)}
    </div>`;
}

export function renderHomePage(
  res: ServerResponse,
  deps: HomeRouteDeps,
  member: Member,
  nonce: string
): void {
  const now = currentNow(deps);

  const snapshot = loadLatestSnapshotForOwner(deps.db, member.id);
  const previousDay = loadPreviousDaySnapshotForOwner(deps.db, member.id, now);
  const proposals = loadPendingProposals(deps.db, member.id);
  const alertEvents = loadRecentAlertEvents(deps.db, member.id, ALERT_EVENT_LIMIT);
  const disciplineRules = loadDisciplineRules(deps.db, member.id);
  const latestDaily = scanReports(deps.repoRoot).find((entry) => entry.type === "daily");

  const freshness = computeHomeFreshness(snapshot, now);
  const degraded = snapshot?.degraded ? [degradedReasonText(snapshot)] : [];

  const page = renderPage({
    title: "首页",
    nav: "home",
    member: { displayName: member.displayName },
    freshness,
    degraded,
    bodyHtml: renderHomeBody(snapshot, previousDay, freshness, proposals, alertEvents, latestDaily, disciplineRules),
    nonce,
    now
  });
  sendHtml(res, 200, page);
}

/**
 * Routes `GET /`. Returns `true` if the request was handled (including the
 * 401/405 cases), `false` if the path isn't `/` so the caller can keep
 * trying other routes.
 */
export function handleHomeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: HomeRouteDeps,
  nonce: string
): boolean {
  if (url.pathname !== "/") {
    return false;
  }

  if (req.method !== "GET") {
    methodNotAllowed(res);
    return true;
  }

  const member = requireIdentity(req, res, deps.db, nonce);
  if (!member) {
    return true;
  }

  renderHomePage(res, deps, member, nonce);
  return true;
}
