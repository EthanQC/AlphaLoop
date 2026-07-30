/**
 * Home page (Task 5): `GET /`. Identity-gated like every route past Task 3
 * (resolveIdentity runs first; a null result renders the shared 401 page).
 *
 * Phase 6 Task 6 (2026-07-15 plan) addition: an amber circuit-breaker banner
 * renders ABOVE every block below (CircuitBreakerRepository.isPaused(viewer.id,
 * now) - v10's per-owner circuit_breaker_state table, circuit-breaker.mjs's
 * engine) whenever the viewer's own proposal generation is currently paused.
 * Deliberately its own block (not folded into layout.ts's existing
 * `renderDegradedBanner`/`degraded` mechanism) - that banner is specifically
 * about snapshot DATA quality (「数据降级提示」), a different concept from "you
 * cannot get new trade proposals right now", and folding the two together
 * would mislabel a circuit-breaker pause as a data problem.
 *
 * Block order is a BINDING part of the plan (Task 5, req §1.2) and must not
 * be reshuffled:
 *   ① 开始研究       - Phase 8 Task 4 (2026-07-16 plan): a real
 *                      `<form method="post" action="/api/research">`
 *                      (previously a disabled input/button placeholder,
 *                      "站内研究 P8 上线" - P8 has now shipped the question
 *                      box). A plain browser submission carries no JS: the
 *                      form posts `question` as
 *                      `application/x-www-form-urlencoded`, and
 *                      routes/api-research.ts's `handleSubmit` recognizes
 *                      that content type and responds with a `303` redirect
 *                      straight to `/research/<id>` instead of its normal
 *                      JSON body (see that file's own module header, "TWO
 *                      SUBMISSION SHAPES"). Whether the question is even a
 *                      *research* question at all is judged entirely
 *                      server-side by the research pipeline (a non-research/
 *                      operational-intent question resolves to a `failed`
 *                      task with an honest reason, research-engine.mjs's own
 *                      `operational_intent` branch) - this form performs no
 *                      client-side validation beyond HTML5 `required`.
 *                      Task 22 (2026-07-30) added req §1.2's 最近研判 entry
 *                      below the box: the viewer's OWN most recent
 *                      research_tasks (ResearchTaskRepository.listForOwner),
 *                      including queued/running ones, which the /reports
 *                      研判 chip does not list.
 *   ② 我的模拟盘概览 - real snapshot data (net assets + today's change) via
 *                      data/overview.ts, or an honest empty state. Task 22
 *                      added req §1.2's 净值 sparkline (a script-free inline
 *                      SVG over loadSnapshotSeriesForOwner, plotting only
 *                      points with a real net-asset value) and the 对比入口
 *                      to /paper.
 *   ③ 我的待办       - real pending proposals, or an honest empty state.
 *   ④ 我的提醒流水   - this owner's alert_events INSIDE THE MOST RECENT US
 *                      trading session (req §1.1), with that session named in
 *                      the block header; or an honest empty state. Until
 *                      Task 22 this block read the newest 10 rows of any age
 *                      while its empty state claimed session scope.
 *   ⑤ 今日日报卡     - latest daily report from Task 4's disk scanner, or
 *                      an honest empty state.
 *   ⑥ 纪律速览       - real discipline_rules, each with its own real 近30天
 *                      tally (`computeComplianceStats`), under a streak line
 *                      (`computeDisciplineStreak`) - or an honest empty
 *                      state. Both lines are phrased by render/compliance.ts,
 *                      the same module the strategy page's 我的纪律 section
 *                      uses. Until 2026-07-30 this block stopped at the rule
 *                      text and req §1.2's compliance half was the
 *                      「策略记忆 P7 上线」 placeholder. Task 22 added req
 *                      §1.2's 情境匹配: `matchDisciplineContexts` measures
 *                      this week's loss against the -3% circuit-breaker line
 *                      and current exposure against the 10% paper budget, and
 *                      the 1-2 rules those contexts hit are pinned to the top
 *                      with the measured number stated. The 临近财报 context
 *                      in req §1.2 is NOT matched - nothing writes the
 *                      earnings-date fact it needs - and that is disclosed
 *                      rather than silently treated as "no earnings soon".
 *
 * EMPTY STATES (2026-07-30, U3): every block above used to fall back to a
 * bare 暂无X - and two of them ("提案审批 P6 上线", "策略记忆 P7 上线") still
 * named phases that had SHIPPED, so the page told a reader a feature was
 * missing when it was actually just empty. They all now use
 * render/empty-state.ts's two-line form: what the block would show, and the
 * real mechanism that fills it.
 *
 * Phase 9 Task 4 (2026-07-16 plan) ADDITION - ⑦ 复盘速览: appended AFTER the
 * six blocks above, in its own new bento row, rather than reshuffled into
 * them - the plan's binding order above is Phase 6 Task 5's original text
 * and stays untouched; a brand-new block added by a later phase is
 * documented as an addition at the end, the same way Phase 8 Task 4's ①
 * upgrade is called out inline above rather than silently rewriting the
 * numbered list. Shows the viewer's own MOST RECENT monthly review (highest
 * `period`, via data/monthly-review.ts's `loadOwnerReviews` - already
 * period-DESC ordered by `MonthlyReviewRepository.listForOwner`) - period +
 * 状态（草稿/已确认）+ a `/review/<id>` link, or an honest empty state when
 * the owner has none yet. Monthly reviews have NO public
 * visibility (Global Constraint: 复盘 is always owner-only), so this block
 * only ever reads the VIEWER'S OWN reviews - never another member's.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import {
  CircuitBreakerRepository,
  ResearchTaskRepository,
  latestUsTradingSession,
  methodNotAllowed,
  type Member,
  type ResearchTask,
  type UsTradingSession
} from "@packages/shared-types";

import { loadOwnerReviews, type TypedMonthlyReview } from "../data/monthly-review.js";
import {
  loadAlertEventsInSession,
  loadDisciplineRules,
  loadLatestSnapshotForOwner,
  loadPendingProposals,
  loadPreviousDaySnapshotForOwner,
  type AlertEventRow,
  type DisciplineRuleRow,
  type OwnerSnapshot,
  type ProposalRow
} from "../data/overview.js";
import { loadSnapshotSeriesForOwner, type SnapshotSeriesPoint } from "../data/snapshots.js";
import {
  computeComplianceStats,
  computeDisciplineStreak,
  matchDisciplineContexts,
  type ComplianceStats,
  type DisciplineContext,
  type DisciplineContextMatch,
  type DisciplineStreak
} from "../data/strategy.js";
import { renderUnauthorizedPage, resolveIdentity } from "../identity.js";
import { scanReports, type ReportIndexEntry } from "../reports/scanner.js";
import { describeDisciplineStreak, renderComplianceLine } from "../render/compliance.js";
import { renderEmptyState } from "../render/empty-state.js";
import {
  beijingDayAge,
  describeDataDay,
  describeDataInstant,
  formatAccountAmount,
  formatAlertValue,
  formatBeijingShortTime
} from "../render/format.js";
import { html, joinHtml, trustedHtml, type Html } from "../render/html.js";
import { freshnessPillClass, renderPage, snapshotFreshness, unknownDataTime, type Freshness } from "../render/layout.js";

export interface HomeRouteDeps {
  db: DatabaseSync;
  repoRoot: string;
  /** Injectable clock for deterministic tests; defaults to wall clock. */
  now?: () => Date;
}

const ALERT_EVENT_LIMIT = 10;
/** Points behind the 净值 sparkline. ~2 weeks of hourly-poll snapshots; enough
 * for a shape, bounded so the home page stays one small query. */
const SPARKLINE_POINT_LIMIT = 60;
/* Snapshot age threshold moved to render/layout.ts's SNAPSHOT_FRESH_WINDOW_MS
 * (2026-07-30) so member-card.ts and paper.ts, which render the same snapshot,
 * cannot disagree with this page about whether it is fresh. The rule is
 * unchanged: "snapshot exists and < 90min old -> 最新; exists older -> 延迟;
 * missing -> 部分缺失". Still distinct from reports.ts's date-based freshness
 * rule - those pages have a different notion of "fresh". */


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

function computeHomeFreshness(snapshot: OwnerSnapshot | null, now: Date): Freshness {
  if (!snapshot) {
    return "部分缺失";
  }
  return snapshotFreshness(snapshot.fetchedAt, now);
}

// Currency comes from the snapshot the number came from - never assumed. See
// data/snapshots.ts's OwnerSnapshot.reportingCurrency.
function formatNetAssets(value: number, currency: string | null): string {
  return formatAccountAmount(value, currency);
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
// 熔断横幅 (Phase 6 Task 6): renders above every block when the viewer's own
// proposal generation is currently paused by their per-owner circuit breaker.
// ---------------------------------------------------------------------------

/** `null` (the common case - not paused) renders nothing. Text is the exact
 * wording the plan specifies: "⛔ 熔断暂停中，至 <恢复时间> 不再生成新提案". */
function renderCircuitBreakerBanner(pausedUntil: string | null): Html {
  if (!pausedUntil) {
    return trustedHtml("");
  }
  return html`<div class="bento" style="padding-bottom:0">
    <section class="card w2 dt-w4 amber" role="alert" aria-label="熔断暂停提示">
      <h2 style="color:var(--amber)">⛔ 熔断暂停中</h2>
      <p style="font-size:13px;color:var(--ink)">熔断暂停中，至 <span class="mono">${pausedUntil}</span> 不再生成新提案。</p>
    </section>
  </div>`;
}

// ---------------------------------------------------------------------------
// ① 开始研究
// ---------------------------------------------------------------------------

const RESEARCH_STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "进行中",
  done: "已完成",
  degraded: "降级完成",
  failed: "失败"
};

const RESEARCH_STATUS_PILL: Record<string, string> = {
  queued: "warn",
  running: "warn",
  done: "ok",
  degraded: "warn",
  failed: "warn"
};

/** req §1.2's 「开始研究（提问框 + 最近研判入口）」: the entry point back into
 * work already in flight. WITHOUT it, a member who submitted a question,
 * closed the tab and came back had no route to their own task short of
 * /reports?type=研判 - the running ones are not even listed there (that chip
 * lists done/degraded only). Owner-scoped by construction:
 * `ResearchTaskRepository.listForOwner(member.id)` takes the VIEWER's id and
 * has no "everyone's" mode. */
const RECENT_RESEARCH_LIMIT = 3;

function renderRecentResearchRow(task: ResearchTask): Html {
  const statusLabel = RESEARCH_STATUS_LABELS[task.status] ?? task.status;
  const pill = RESEARCH_STATUS_PILL[task.status] ?? "warn";
  return html`<div class="alert">
    <span class="pill ${pill}">${statusLabel}</span>
    <a href="/research/${task.id}" style="color:var(--accent)">${task.title ?? task.question}</a>
  </div>`;
}

function renderRecentResearchEntry(tasks: ReadonlyArray<ResearchTask>): Html {
  if (tasks.length === 0) {
    return trustedHtml("");
  }
  return html`<div style="margin-top:12px;border-top:1px solid var(--line);padding-top:10px">
    <h3 style="font-size:13px;color:var(--sub);margin:0 0 6px">最近研判</h3>
    ${joinHtml(tasks.map(renderRecentResearchRow))}
    <p style="margin-top:6px"><a href="/reports?type=研判" style="color:var(--accent);font-size:12px">全部研判 →</a></p>
  </div>`;
}

function renderStartResearchBlock(recentResearch: ReadonlyArray<ResearchTask>): Html {
  return html`<section class="card w2 dt-w4">
    <h2>开始研究</h2>
    <form method="post" action="/api/research">
      <div class="ask">
        <input
          type="text"
          name="question"
          required
          placeholder="问点什么…如「NVDA 财报前要减仓吗」"
          style="flex:1;background:transparent;border:none;color:inherit;font-size:14.5px;outline:none"
        >
      </div>
      <div style="margin-top:10px">
        <button class="btn primary" type="submit" style="flex:none;padding:9px 18px">开始研究</button>
      </div>
    </form>
    <p class="ask-hint">每日最多 10 次，操作类请求（改规则/下单等）请走飞书</p>
    ${renderRecentResearchEntry(recentResearch)}
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

/**
 * req §1.2's 净值 sparkline. A pure inline `<svg>` `<polyline>` - no script,
 * no external asset, nothing for the CSP (`default-src 'none'`) to block.
 *
 * WHAT IT WILL AND WILL NOT DRAW. It plots ONLY points whose `netAssets` is a
 * real number; a snapshot with a missing value is skipped rather than drawn
 * at zero or interpolated across, because a line that dips to the axis says
 * "your account went to nothing" when the truth is "we failed to fetch". With
 * fewer than two plottable points there is no line to draw at all, and the
 * caller says so in words instead - one point is a dot, and a dot rendered as
 * a flat line is a fabricated "unchanged".
 *
 * The polyline is drawn in a 100x28 user-space box scaled to the value range,
 * with a 1-unit vertical inset so a flat series still renders inside the box
 * rather than clipped along its edge.
 */
function renderNetAssetsSparkline(series: ReadonlyArray<SnapshotSeriesPoint>): Html {
  const values = series
    .map((point) => point.netAssets)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  if (values.length < 2) {
    return html`<p style="margin-top:8px;font-size:12px;color:var(--sub)">净值走势图需要至少 2 个有净值的快照，当前只有 ${values.length} 个。</p>`;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 100;
      // span === 0 (a genuinely flat series) draws down the middle.
      const y = span === 0 ? 14 : 27 - ((value - min) / span) * 26;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  const rising = (values[values.length - 1] as number) >= (values[0] as number);
  const stroke = rising ? "var(--up, #16a34a)" : "var(--down, #dc2626)";
  return html`<svg
    viewBox="0 0 100 28"
    preserveAspectRatio="none"
    style="width:100%;height:34px;margin-top:10px;display:block"
    role="img"
    aria-label="最近 ${values.length} 个快照的净值走势"
  ><polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="1.5" vector-effect="non-scaling-stroke"></polyline></svg>`;
}

function renderPaperOverviewBlock(
  snapshot: OwnerSnapshot | null,
  previousDay: OwnerSnapshot | null,
  freshness: Freshness,
  series: ReadonlyArray<SnapshotSeriesPoint>
): Html {
  if (!snapshot) {
    return html`<section class="card w2 dt-w2">
      <h2>我的模拟盘概览</h2>
      ${renderEmptyState(
        "还没有你的模拟盘快照，所以这里不显示净值和今日涨跌。",
        "快照由 mini 上的长桥模拟盘监控每交易日抓取；开好长桥模拟盘账户并把凭据交给平台托管后，下一个交易日即有数据。"
      )}
    </section>`;
  }

  const netAssetsDisplay =
    snapshot.netAssets === null
      ? "数据不足"
      : formatNetAssets(snapshot.netAssets, snapshot.reportingCurrency);
  const { changeDisplay, changeClass } = computeDailyChange(snapshot, previousDay);

  const pillClass = freshnessPillClass(freshness);

  return html`<section class="card w2 dt-w2">
    <h2>我的模拟盘概览 <span class="pill ${pillClass}">${freshness}</span></h2>
    <div class="kpirow">
      <div class="kpi-main"><div class="num mono">${netAssetsDisplay}</div><div class="lbl">净值</div></div>
      <div class="kpi"><div class="num mono ${changeClass}">${changeDisplay}</div><div class="lbl">今日</div></div>
    </div>
    ${renderNetAssetsSparkline(series)}
    ${renderDegradedNote(snapshot)}
    <p style="margin-top:8px"><a href="/paper" style="color:var(--accent);font-size:12px">净值曲线与提案成交对比 →</a></p>
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
      : renderEmptyState(
          "当前没有等你审批的提案。",
          "现在提案只有一条产生路径：在飞书里说一句「给我出一条 NVDA 的提案」。收盘后自动出提案还没接上，所以这里空着不代表系统判断「今天不该动」。提出后审批卡会发到你的飞书单聊，24 小时无操作自动作废。"
        );
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
  // U1 (2026-07-30): `event.value` is a decimal ratio, and used to render
  // raw (`-0.0332390201626266`). See render/format.ts for the unit contract.
  const cls = event.value < 0 ? "d" : "u";
  return html`<div class="alert">
    <time class="mono" title="${event.triggeredAt}">${formatBeijingShortTime(event.triggeredAt)}</time>
    <span>${event.symbol} ${label} <b class="mono ${cls}" title="原始值 ${String(event.value)}">${formatAlertValue(event.ruleType, event.value)}</b></span>
  </div>`;
}

const ALERT_RULES_HINT =
  "提醒按你自己的规则触发（日内波动 / 浮动盈亏 / 5分钟异动 / 组合敞口），每人每日上限 30 张。在飞书单聊里说一句「给 NVDA 加一条涨跌 4% 提醒」即可建规则。";

/**
 * ④ 我的提醒流水 - req §1.1 defines it as 最近一个美股交易时段, and the header
 * now NAMES the session it is showing.
 *
 * THE DEFECT THIS FIXES (2026-07-30, Task 22): the empty state below already
 * read 「最近一个美股交易时段你没有触发过提醒」 while the reader behind it was
 * `loadRecentAlertEvents` - newest 10 rows, no time bound whatsoever. On the
 * live mini this member's newest alerts were from 07-28 and 07-29; on 07-30
 * the page presented them as this session's. The block is now filtered by
 * `latestUsTradingSession`'s real window and states which day that is, so the
 * rows and the sentence describing them cannot disagree.
 *
 * `session === null` means the calendar does not cover this instant's year
 * (packages/shared-types/src/trading-session.ts refuses to guess). That is
 * disclosed with the reason rather than silently rendering "no alerts", which
 * would be a claim about the member's day made from a calendar gap.
 */
function renderAlertFeedBlock(events: ReadonlyArray<AlertEventRow>, session: UsTradingSession | null): Html {
  if (!session) {
    return html`<section class="card dt-w2">
      <h2>我的提醒流水</h2>
      ${renderEmptyState(
        "暂时无法确定最近一个美股交易时段，所以这里不显示提醒。",
        "平台内置的 NYSE 休市日历没有覆盖当前年份，需要先更新交易日历（packages/shared-types/src/trading-session.ts 与 trading-schedule.mjs 同步维护）。"
      )}
    </section>`;
  }

  const sessionLabel = session.inProgress
    ? `${session.tradingDay} 美东时段（进行中）`
    : `${session.tradingDay} 美东时段`;

  const body =
    events.length > 0
      ? joinHtml(events.map(renderAlertRow))
      : renderEmptyState(`最近一个美股交易时段（${sessionLabel}）你没有触发过提醒。`, ALERT_RULES_HINT);

  return html`<section class="card dt-w2">
    <h2>我的提醒流水 <span class="pill" style="font-weight:400">${sessionLabel}</span></h2>
    ${body}
  </section>`;
}

// ---------------------------------------------------------------------------
// ⑤ 今日日报卡
// ---------------------------------------------------------------------------

/**
 * The 今日日报卡 heading is a claim about WHEN, and the newest daily on disk is
 * frequently not today's: the daily job had been dead for days at the end of
 * 2026-07 (14 consecutive `run_log` failures on the mini, last success
 * 2026-07-28) while this card kept presenting whatever it found under an
 * unqualified 今日, with no age anywhere on it - the only pill it could show
 * was `legacy`, which is about the report's FORMAT era, not its age. A reader
 * checking whether today's report had landed got told it had.
 *
 * So the heading now states the age whenever the report is not today's, and
 * from STALE_AFTER_DAYS on the pill turns into a warning. `beijingDayAge`
 * returns null for a date it cannot parse, and then nothing is claimed at all.
 */
function renderDailyReportAge(entry: ReportIndexEntry, now: Date): { heading: string; pill: Html } {
  const age = beijingDayAge(entry.date, now);
  if (!age || age.days === 0) {
    return { heading: "今日日报卡", pill: trustedHtml("") };
  }
  return {
    heading: "最新日报卡",
    pill: html`<span class="pill ${age.stale ? "warn" : ""}">${age.ago}</span>`
  };
}

function renderDailyReportBlock(entry: ReportIndexEntry | undefined, now: Date): Html {
  if (!entry) {
    return html`<section class="card dt-w2 report">
      <h2>今日日报卡</h2>
      ${renderEmptyState(
        "还没有可读的日报。",
        "日报在每个美股交易日开盘前（北京时间约 20:00）自动生成；美股节假日无新输入则不产出，这一天本就不会有日报。"
      )}
    </section>`;
  }

  const legacyPill = entry.legacy ? html`<span class="pill warn">历史存档</span>` : trustedHtml("");

  // 我的个人页 (Task 6, 2026-07-28): the daily card is the home page's entry
  // point to the viewer's OWN personal page. The href carries no owner id -
  // routes/personal.ts resolves the owner from the session and refuses an
  // `?owner=` parameter - and it is only offered for daily/weekly reports,
  // the only two kinds `personal_pages` holds.
  const personalLink =
    entry.type === "daily" || entry.type === "weekly"
      ? html`<a class="btn" href="/${entry.type}/${entry.date}/me">我的个人页 →</a>`
      : trustedHtml("");

  const { heading, pill: agePill } = renderDailyReportAge(entry, now);

  return html`<section class="card dt-w2 report">
    <h2>${heading} ${agePill}${legacyPill}</h2>
    <h3>${entry.title}</h3>
    <div class="report-links">
      <a class="btn primary" href="/${entry.type}/${entry.date}">阅读全文</a>
      ${personalLink}
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// ⑥ 纪律速览
// ---------------------------------------------------------------------------

function renderDisciplineRow(rule: DisciplineRuleRow, stats: ComplianceStats, pinned: boolean): Html {
  const label = ENFORCEMENT_LABELS[rule.enforcement] ?? rule.enforcement;
  const pin = pinned ? html`<span class="pill warn">当前相关</span> ` : trustedHtml("");
  return html`<div class="disc">
    ${pin}${rule.ruleText} <span style="color:var(--sub);font-size:12px">· ${label}</span>
    ${renderComplianceLine(stats)}
  </div>`;
}

/** One sentence per matched context, stating the MEASURED number and the
 * limit it is being measured against - never a bare "接近上限", which tells
 * the reader nothing they can check. */
function describeDisciplineContext(context: DisciplineContext): string {
  const pct = (ratio: number): string => `${(ratio * 100).toFixed(2)}%`;
  switch (context.kind) {
    case "circuit_tripped":
      return `本交易周净值 ${pct(context.weeklyLossRatio)}，已达到 ${pct(context.tripRatio)} 熔断线。`;
    case "circuit_near":
      return `本交易周净值 ${pct(context.weeklyLossRatio)}，正在接近 ${pct(context.tripRatio)} 熔断线。`;
    case "budget_over":
      return `当前持仓敞口 ${pct(context.exposureRatio)}，已超出 ${pct(context.budgetRatio)} 模拟盘预算。`;
    case "budget_near":
      return `当前持仓敞口 ${pct(context.exposureRatio)}，接近 ${pct(context.budgetRatio)} 模拟盘预算上限。`;
  }
}

function renderDisciplineContextNotes(match: DisciplineContextMatch): Html {
  const lines = [...match.contexts.map(describeDisciplineContext), ...match.unavailable];
  if (lines.length === 0) {
    return trustedHtml("");
  }
  return html`<div style="margin:0 0 8px">
    ${joinHtml(
      lines.map((line) => html`<p style="font-size:12px;color:var(--amber);margin:2px 0">${line}</p>`)
    )}
  </div>`;
}

/**
 * req §1.2's 纪律速览: the rules AND how they have actually been going. The
 * per-rule 近30天 tally and the streak line are both real measurements
 * (data/strategy.ts) - this block used to end at the rule text, with the
 * compliance half standing in as 「策略记忆 P7 上线」 long after P7 shipped.
 *
 * Both lines come from render/compliance.ts, the same module the strategy
 * page's 我的纪律 section uses, so the two pages cannot end up describing the
 * same tally in two different ways.
 */
function renderDisciplineBlock(
  rules: DisciplineRuleRow[],
  statsByRuleId: Map<string, ComplianceStats>,
  streak: DisciplineStreak,
  contextMatch: DisciplineContextMatch
): Html {
  // req §1.2's 匹配规则: pinned rules first (in the order their contexts were
  // ranked), then the rest in their existing newest-first order. The list is
  // REORDERED, never filtered - a rule that did not match today is still the
  // member's rule and still shows, just below the ones that matter now.
  const pinnedSet = new Set(contextMatch.pinnedRuleIds);
  const ordered = [
    ...contextMatch.pinnedRuleIds
      .map((id) => rules.find((rule) => rule.id === id))
      .filter((rule): rule is DisciplineRuleRow => rule !== undefined),
    ...rules.filter((rule) => !pinnedSet.has(rule.id))
  ];

  const body =
    ordered.length > 0
      ? joinHtml(
          ordered.map((rule) =>
            renderDisciplineRow(rule, statsByRuleId.get(rule.id) ?? { sample: "none" }, pinnedSet.has(rule.id))
          )
        )
      : renderEmptyState(
          "你还没有登记任何纪律规则。",
          "纪律是系统能替你硬拦的东西（如「财报周不加仓」「单票不超过 20%」）。在飞书单聊里说一句「记一条纪律：…」即可登记，之后每条提案都会按它做检查。"
        );

  // req §1.2's 无匹配 fallback is the streak line; when a context DID match,
  // the streak line stays too - "已连续遵守 23 天" and "本周已亏 2.6%" are both
  // true and neither replaces the other.
  return html`<section class="card w2 dt-w4">
    <h2>纪律速览</h2>
    ${renderDisciplineContextNotes(contextMatch)}
    <p style="font-size:12px;color:var(--sub);margin:-2px 0 8px">${describeDisciplineStreak(streak)}</p>
    ${body}
  </section>`;
}

// ---------------------------------------------------------------------------
// ⑦ 复盘速览 (Phase 9 Task 4 addition - see module header)
// ---------------------------------------------------------------------------

const HOME_REVIEW_STATUS_LABELS: Record<string, string> = { draft: "草稿", confirmed: "已确认" };

function renderMonthlyReviewBlock(latestReview: TypedMonthlyReview | null): Html {
  if (!latestReview) {
    return html`<section class="card w2 dt-w4">
      <h2>复盘速览</h2>
      ${renderEmptyState(
        "还没有你的月度复盘。",
        "复盘在每月第一个周末自动生成草稿并发到你的飞书单聊：预测命中率、决策收益对比、纪律遵守率与改进建议；你确认后结论才写进个人策略记忆。"
      )}
    </section>`;
  }
  const statusLabel = HOME_REVIEW_STATUS_LABELS[latestReview.status] ?? latestReview.status;
  const statusClass = latestReview.status === "confirmed" ? "ok" : "warn";
  return html`<section class="card w2 dt-w4">
    <h2>复盘速览</h2>
    <div class="alert">
      <span class="mono">${latestReview.period}</span>
      <span class="pill ${statusClass}">${statusLabel}</span>
      <a href="/review/${latestReview.id}" style="color:var(--accent)">查看复盘</a>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

interface HomeBodyData {
  snapshot: OwnerSnapshot | null;
  previousDay: OwnerSnapshot | null;
  freshness: Freshness;
  snapshotSeries: ReadonlyArray<SnapshotSeriesPoint>;
  recentResearch: ReadonlyArray<ResearchTask>;
  proposals: ProposalRow[];
  alertEvents: ReadonlyArray<AlertEventRow>;
  session: UsTradingSession | null;
  latestDaily: ReportIndexEntry | undefined;
  disciplineRules: DisciplineRuleRow[];
  complianceStatsByRuleId: Map<string, ComplianceStats>;
  disciplineStreak: DisciplineStreak;
  disciplineContexts: DisciplineContextMatch;
  circuitPausedUntil: string | null;
  latestReview: TypedMonthlyReview | null;
  /** Request clock, so the 今日日报卡 heading can state the report's real age
   * rather than assert 今日. */
  now: Date;
}

function renderHomeBody(data: HomeBodyData): Html {
  return html`${renderCircuitBreakerBanner(data.circuitPausedUntil)}
    <div class="bento">
      ${renderStartResearchBlock(data.recentResearch)}
    </div>
    <div class="bento" style="margin-top:10px">
      ${renderPaperOverviewBlock(data.snapshot, data.previousDay, data.freshness, data.snapshotSeries)}
      ${renderTodoBlock(data.proposals)}
    </div>
    <div class="bento" style="margin-top:10px">
      ${renderAlertFeedBlock(data.alertEvents, data.session)}
      ${renderDailyReportBlock(data.latestDaily, data.now)}
    </div>
    <div class="bento" style="margin-top:10px">
      ${renderDisciplineBlock(
        data.disciplineRules,
        data.complianceStatsByRuleId,
        data.disciplineStreak,
        data.disciplineContexts
      )}
    </div>
    <div class="bento" style="margin-top:10px">
      ${renderMonthlyReviewBlock(data.latestReview)}
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
  const snapshotSeries = loadSnapshotSeriesForOwner(deps.db, member.id, SPARKLINE_POINT_LIMIT);
  const proposals = loadPendingProposals(deps.db, member.id);
  // 最近研判 (req §1.2): the viewer's OWN tasks only - listForOwner takes an
  // owner id and has no cross-member mode.
  const recentResearch = new ResearchTaskRepository(deps.db)
    .listForOwner(member.id)
    .slice(0, RECENT_RESEARCH_LIMIT);
  // ④ 提醒流水 is scoped to the most recent US trading session (req §1.1), not
  // to "the newest N rows" - see renderAlertFeedBlock.
  const session = latestUsTradingSession(now);
  const alertEvents = session
    ? loadAlertEventsInSession(deps.db, member.id, session, ALERT_EVENT_LIMIT)
    : [];
  const disciplineRules = loadDisciplineRules(deps.db, member.id);
  // ⑥ 纪律速览's compliance half (Task 11) - the viewer's OWN id on every
  // call; a member's discipline record is never anyone else's business.
  const complianceStatsByRuleId = new Map<string, ComplianceStats>(
    disciplineRules.map((rule) => [rule.id, computeComplianceStats(deps.db, member.id, rule.id, now)])
  );
  const disciplineStreak = computeDisciplineStreak(deps.db, member.id, now);
  // 情境匹配 (req §1.2) - measured against this member's OWN snapshots only.
  const disciplineContexts = matchDisciplineContexts(deps.db, member.id, disciplineRules, now);
  const latestDaily = scanReports(deps.repoRoot).find((entry) => entry.type === "daily");
  // ⑦ 复盘速览 (Phase 9 Task 4 addition) - loadOwnerReviews is already
  // period-DESC ordered, so the first row (if any) is the most recent.
  const latestReview = loadOwnerReviews(deps.db, member.id)[0] ?? null;

  const freshness = computeHomeFreshness(snapshot, now);
  const degraded = snapshot?.degraded ? [degradedReasonText(snapshot)] : [];

  // Phase 6 Task 6: per-owner circuit breaker (v10's circuit_breaker_state,
  // never a different member's - CircuitBreakerRepository.isPaused/getState
  // are both keyed by `member.id`, the viewer's OWN id).
  const circuitBreakerRepo = new CircuitBreakerRepository(deps.db);
  const nowIso = now.toISOString();
  const circuitPausedUntil = circuitBreakerRepo.isPaused(member.id, nowIso)
    ? (circuitBreakerRepo.getState(member.id)?.pausedUntil ?? null)
    : null;

  const page = renderPage({
    title: "首页",
    nav: "home",
    member: { displayName: member.displayName },
    freshness,
    // U2: the topbar states when this page's DATA is from. The paper-trading
    // snapshot is the home page's own live figure (净值/今日), so it names
    // the data time; with no snapshot the newest daily report's date is the
    // only dated content left, and with neither there is nothing to state.
    // Task 19: with neither, the home page is still showing database-backed
    // content (提醒 / 待确认提案 / 纪律遵守), so it says the data time is
    // unknown and why - the request clock alone would be the pre-fix shape
    // this whole change exists to end.
    dataAsOf: snapshot
      ? describeDataInstant(snapshot.fetchedAt, now)
      : latestDaily
        ? describeDataDay(latestDaily.date, now)
        : unknownDataTime("还没有模拟盘快照，也没有任何一期日报"),
    degraded,
    bodyHtml: renderHomeBody({
      snapshot,
      previousDay,
      freshness,
      snapshotSeries,
      recentResearch,
      proposals,
      alertEvents,
      session,
      latestDaily,
      disciplineRules,
      complianceStatsByRuleId,
      disciplineStreak,
      disciplineContexts,
      circuitPausedUntil,
      latestReview,
      now
    }),
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
