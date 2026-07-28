/**
 * Report library routes (Task 4): the list page (`GET /reports`) and the
 * per-type reading pages (`GET /daily/<date>`, `/weekly/<date>`,
 * `/stock-analysis/<date>`, `/official-paper/<date>`).
 *
 * Every route here is identity-gated (plan Task 4 note: "pages from this
 * task onward ARE identity-gated") - resolveIdentity runs first on every
 * request this module handles, and a null result renders the shared 401
 * page. There is no per-owner filtering needed for reports themselves
 * (report content isn't member-scoped data), but the login gate still
 * applies like every other page past Task 3.
 *
 * Phase 8 Task 4 (2026-07-16 plan) addition: `?type=研判` is no longer a
 * disabled placeholder chip - it now lists the VIEWER's own done/degraded
 * `research_tasks` rows (owner-scoped: `ResearchTaskRepository.listForOwner
 * (member.id)`, never another member's), each card linking to `/research/
 * <id>`. This is a DB-backed list living alongside (not merged into) the
 * on-disk `scanReports` entries - `研判` was never a `ReportType` the
 * scanner produces, so it gets its own sentinel query value
 * (`RESEARCH_TYPE_PARAM = "研判"`) and its own branch through
 * `renderReportsListBody`, rather than trying to force research tasks into
 * `ReportIndexEntry`'s on-disk shape.
 *
 * Phase 9 Task 4 (2026-07-16 plan) addition: `?type=复盘` is the SAME kind of
 * real, DB-backed, owner-scoped chip - `loadOwnerReviews` (data/
 * monthly-review.ts) over `MonthlyReviewRepository.listForOwner`, never
 * scanned from disk, never another member's rows. Unlike 研判 (which has a
 * private/public split - a promoted task is visible to the whole circle),
 * 复盘 has NO public visibility at all: every review is unconditionally
 * private to its own owner (Global Constraint: "复盘...仅本人可见"), so this
 * chip's list is ALWAYS the viewer's own reviews, full stop - there is no
 * "circle" variant to ever add here. This was the plan's last disabled/"P9
 * 上线" placeholder chip - after this task, `renderReportsListBody` renders
 * NO disabled chips at all.
 *
 * 模拟盘快照 IS OWNER-SCOPED, NOT CIRCLE-VISIBLE (defect B1, 2026-07-28)
 * ---------------------------------------------------------------------
 * The module header above used to claim "there is no per-owner filtering
 * needed for reports themselves (report content isn't member-scoped data)".
 * That was false for ONE type: `reports/official-paper/<date>-post-open.md` is
 * renderPnlReport's output - the 净资产 / 现金 / 持仓估值 / 持仓明细 of the paper
 * account it was fetched from - and until this fix, being any `status='active'`
 * member was enough to read it by URL, with the /reports list linking it.
 * Requirements §3.1 keeps personal account content off shared surfaces and §5
 * makes account content owner-scoped, so:
 *
 *   - reports/scanner.ts's `scanReports` no longer returns official-paper
 *     entries at all; only `scanOwnerScopedReports` does.
 *   - THE ARTIFACT ON DISK CARRIES NO OWNER ATTRIBUTION, so ownership is not
 *     read from the file and never inferred from "who is asking" or "who is
 *     the only member". It comes from the `official_paper_snapshots` row that
 *     official-paper-monitor.mjs's `sendPnlReport` persisted in the SAME run
 *     that wrote the file: the filename's date is literally
 *     `snapshot.fetchedAt.slice(0, 10)`, so `substr(fetched_at, 1, 10)` +
 *     `reason = 'post_open_pnl'` identifies that row exactly, and its
 *     `owner_id` is the answer (see resolveOfficialPaperAttributions).
 *   - An artifact whose owner CANNOT be established that way - no such row, a
 *     legacy NULL `owner_id`, the `'__shared__'` sentinel (which means the
 *     writer itself could not attribute it), or two members' rows on one date
 *     - is readable by NOBODY. Guessing an owner would be fabrication, and
 *     "probably the operator" is not a permission.
 *   - Withheld entries are DISCLOSED with a count and a reason on the list
 *     page rather than silently dropped.
 */
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { ResearchTaskRepository, methodNotAllowed, type Member, type ResearchTask } from "@packages/shared-types";

import { loadOwnerReviews, type TypedMonthlyReview } from "../data/monthly-review.js";
import { renderUnauthorizedPage, resolveIdentity } from "../identity.js";
import { CONFIDENCE_LABELS } from "../reports/conclusion-box.js";
import { renderMarkdown, type MarkdownRenderResult } from "../reports/markdown.js";
import {
  OWNER_SCOPED_REPORT_TYPES,
  scanOwnerScopedReports,
  scanReports,
  type ReportIndexEntry,
  type ReportType
} from "../reports/scanner.js";
import { html, joinHtml, trustedHtml, type Html } from "../render/html.js";
import { renderPage, type Freshness } from "../render/layout.js";

export interface ReportsRouteDeps {
  db: DatabaseSync;
  repoRoot: string;
  /** Injectable clock for deterministic tests; defaults to wall clock. */
  now?: () => Date;
}

// Chinese labels for the four scannable report types. `official-paper`'s
// disk name doesn't match its user-facing label - the files under
// reports/official-paper/ are the official paper-trading account snapshot
// reports ("OpenClaw 模拟盘收支变化"), which the plan's chip list calls
// "模拟盘快照".
const TYPE_LABELS: Record<ReportType, string> = {
  daily: "日报",
  weekly: "周报",
  "stock-analysis": "个股分析",
  "official-paper": "模拟盘快照"
};

const TYPE_ORDER: readonly ReportType[] = ["daily", "weekly", "stock-analysis", "official-paper"];

// Sentinel `?type=` value for the (now real, DB-backed) 研判 chip - see
// module header. Not a `ReportType`: nothing under reports/scanner.ts's
// on-disk types is ever "研判".
const RESEARCH_TYPE_PARAM = "研判";

// Sentinel `?type=` value for the (now also real, DB-backed) 复盘 chip - see
// module header. Not a `ReportType` either, for the same reason
// RESEARCH_TYPE_PARAM isn't: monthly_reviews was never something
// reports/scanner.ts's on-disk scanner produces. This was the plan's last
// remaining disabled/"P9 上线" placeholder chip - there are no disabled chips
// left after this task.
const REVIEW_TYPE_PARAM = "复盘";

const DATE_PARAM_RE = /^\d{4}-\d{2}-\d{2}$/u;

const READING_PATH_SEGMENTS: Record<string, ReportType> = {
  daily: "daily",
  weekly: "weekly",
  "stock-analysis": "stock-analysis",
  "official-paper": "official-paper"
};

// ---------------------------------------------------------------------------
// Ownership of official-paper artifacts (defect B1 - see the module header)
// ---------------------------------------------------------------------------

/** The `official_paper_snapshots.reason` written by the run that also writes
 * `reports/official-paper/<date>-post-open.md` (official-paper-monitor.mjs
 * sendPnlReport: `saveSnapshot(db, snapshot, "post_open_pnl")` immediately
 * before `writeFileSync(markdownPath, ...)`). Snapshots from any other run
 * kind (hourly_poll, hourly_poll_per_member, manual) did not produce this
 * file and therefore say nothing about who it belongs to. */
const OFFICIAL_PAPER_REPORT_REASON = "post_open_pnl";

/** `owner_id` values that are NOT a member: `'__shared__'` is the writer's own
 * "could not attribute this to exactly one member" sentinel (official-paper-
 * monitor.mjs SHARED_OWNER_SENTINEL, mirrored in data/snapshots.ts), and
 * `'__legacy_system__'` is the v7 migration placeholder identity.ts refuses to
 * resolve. Neither may ever be treated as an owner who can be matched. */
const NON_MEMBER_OWNER_IDS: ReadonlySet<string> = new Set(["__shared__", "__legacy_system__"]);

/** Who an on-disk official-paper artifact belongs to. `unattributable` carries
 * the REASON, which is shown to the member instead of an invented owner. */
type OfficialPaperAttribution =
  | { kind: "owner"; ownerId: string }
  | { kind: "unattributable"; reason: string };

const NO_SNAPSHOT_ROW: OfficialPaperAttribution = {
  kind: "unattributable",
  reason: "没有找到与这份快照同一次生成的账户记录（official_paper_snapshots 里没有当天的 post_open_pnl 行）"
};

/**
 * Builds `report date -> attribution` for every official-paper artifact, in
 * one query. The date key is `substr(fetched_at, 1, 10)`, which is exactly how
 * the writer derived the filename (`snapshot.fetchedAt.slice(0, 10)`) - a
 * string match on the same value, not a timezone conversion that could drift.
 *
 * A date is attributed ONLY when every `post_open_pnl` row on it names ONE
 * real member. Zero rows, a NULL `owner_id`, a non-member sentinel, or two
 * members on one date are all `unattributable` WITH A REASON - never resolved
 * to a best guess, and (see the callers) never readable by anyone.
 */
function resolveOfficialPaperAttributions(db: DatabaseSync): Map<string, OfficialPaperAttribution> {
  const rows = db
    .prepare(
      `SELECT substr(fetched_at, 1, 10) AS report_date, owner_id
       FROM official_paper_snapshots
       WHERE reason = ?
       GROUP BY report_date, owner_id`
    )
    .all(OFFICIAL_PAPER_REPORT_REASON) as Array<{ report_date?: unknown; owner_id?: unknown }>;

  const ownersByDate = new Map<string, Set<string | null>>();
  for (const row of rows) {
    const date = typeof row.report_date === "string" ? row.report_date : null;
    if (!date) {
      continue;
    }
    const ownerId = typeof row.owner_id === "string" && row.owner_id.length > 0 ? row.owner_id : null;
    const owners = ownersByDate.get(date) ?? new Set<string | null>();
    owners.add(ownerId);
    ownersByDate.set(date, owners);
  }

  const attributions = new Map<string, OfficialPaperAttribution>();
  for (const [date, owners] of ownersByDate) {
    attributions.set(date, attributeOwners(owners));
  }
  return attributions;
}

function attributeOwners(owners: ReadonlySet<string | null>): OfficialPaperAttribution {
  if (owners.size > 1) {
    return {
      kind: "unattributable",
      reason: "同一天存在多份归属不同的账户记录，无法判断这份文件写的是谁的账户"
    };
  }
  const [ownerId] = [...owners];
  if (ownerId === null || ownerId === undefined) {
    return {
      kind: "unattributable",
      reason: "当天的账户记录没有归属标注（owner_id 为空，属于 schema v4 之前写入的历史行）"
    };
  }
  if (NON_MEMBER_OWNER_IDS.has(ownerId)) {
    return {
      kind: "unattributable",
      reason: `当天的账户记录归属为占位值 ${ownerId}，写入时就没能确定属于哪一位成员`
    };
  }
  return { kind: "owner", ownerId };
}

function attributionFor(
  attributions: Map<string, OfficialPaperAttribution>,
  date: string
): OfficialPaperAttribution {
  return attributions.get(date) ?? NO_SNAPSHOT_ROW;
}

function isOwnerScopedType(type: ReportType): boolean {
  return OWNER_SCOPED_REPORT_TYPES.includes(type);
}

/** Sets no cache header of its own. `cache-control: private, no-store` + the
 * identity `vary` are part of the server-wide baseline (security.ts's
 * applySecurityHeaders, defect N1), which covers every response this module
 * sends - the owner-scoped 模拟盘快照 page and its refusals, and equally the
 * circle-wide report pages, whose bodies still carry the viewer's own name and
 * their owner-scoped 研判/复盘 entries. B2's per-route opt-in is deliberately
 * gone: B1 made this module viewer-dependent and shipped without opting in,
 * because an opt-in only protects the routes whose author remembered it. */
function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

/** `YYYY-MM-DD` for a given instant, in Asia/Shanghai (Beijing has no DST,
 * so a fixed IANA zone is exact year-round). Built from formatToParts (not
 * a locale's default separator/order) so the output shape doesn't depend on
 * ICU version/locale quirks. Exported for routes/personal.ts, which applies
 * the identical date-based freshness rule to the personal page it hangs off
 * these reading pages - one implementation, so the two surfaces can never
 * disagree about whether the same date is 最新 or 延迟. */
export function formatBeijingDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

/**
 * Routes `/reports` and the four reading-page paths. Returns `true` if the
 * request was handled (including 401/404/405 responses), `false` if the
 * path doesn't belong to this module so the caller can keep trying other
 * routes / fall through to a generic 404.
 */
export function handleReportsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ReportsRouteDeps,
  nonce: string
): boolean {
  if (url.pathname === "/reports") {
    if (req.method !== "GET") {
      methodNotAllowed(res);
      return true;
    }
    const member = requireIdentity(req, res, deps.db, nonce);
    if (!member) {
      return true;
    }
    renderReportsListPage(res, deps, url, member, nonce);
    return true;
  }

  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 2) {
    const type = READING_PATH_SEGMENTS[segments[0] as string];
    if (type) {
      if (req.method !== "GET") {
        methodNotAllowed(res);
        return true;
      }
      const member = requireIdentity(req, res, deps.db, nonce);
      if (!member) {
        return true;
      }
      renderReadingPage(res, deps, type, segments[1] as string, member, nonce);
      return true;
    }
  }

  return false;
}

function requireIdentity(
  req: IncomingMessage,
  res: ServerResponse,
  db: DatabaseSync,
  nonce: string
): Member | null {
  const member = resolveIdentity(req, db);
  if (!member) {
    sendHtml(res, 401, renderUnauthorizedPage(nonce));
    return null;
  }
  return member;
}

function currentNow(deps: ReportsRouteDeps): Date {
  return deps.now ? deps.now() : new Date();
}

// ---------------------------------------------------------------------------
// List page: GET /reports[?type=daily|weekly|stock-analysis|official-paper]
// ---------------------------------------------------------------------------

function renderReportsListPage(
  res: ServerResponse,
  deps: ReportsRouteDeps,
  url: URL,
  member: Member,
  nonce: string
): void {
  const now = currentNow(deps);
  const typeParam = url.searchParams.get("type");
  const isResearchView = typeParam === RESEARCH_TYPE_PARAM;
  const isReviewView = typeParam === REVIEW_TYPE_PARAM;

  // 研判/复盘 are both DB-backed, owner-scoped lists (never scanned from
  // disk) - see module header. Every other `?type=` value (or none) keeps
  // the original on-disk `scanReports` behavior unchanged - except that
  // scanReports no longer contains ANY owner-scoped artifact (defect B1), so
  // the viewer's own 模拟盘快照 entries are added back explicitly below.
  const circleEntries = isResearchView || isReviewView ? [] : scanReports(deps.repoRoot);
  const owned =
    isResearchView || isReviewView
      ? { entries: [], withheld: { otherOwner: 0, unattributable: 0 } }
      : loadViewerOwnedPaperReports(deps.db, deps.repoRoot, member.id);
  const entries = [...circleEntries, ...owned.entries].sort(
    (a, b) => b.date.localeCompare(a.date) || a.type.localeCompare(b.type)
  );
  const filtered =
    !isResearchView && !isReviewView && typeParam ? entries.filter((entry) => entry.type === typeParam) : entries;
  const researchTasks = isResearchView ? loadOwnerResearchArchive(deps.db, member.id) : [];
  // 复盘 has no public/done-vs-degraded filter of its own - EVERY review this
  // owner has (draft or confirmed) belongs on their own list, full stop.
  const reviews = isReviewView ? loadOwnerReviews(deps.db, member.id) : [];

  const page = renderPage({
    title: "报告库",
    nav: "reports",
    member: { displayName: member.displayName },
    freshness: "最新",
    degraded: [],
    bodyHtml: renderReportsListBody(filtered, typeParam, researchTasks, reviews, owned.withheld),
    nonce,
    now
  });
  sendHtml(res, 200, page);
}

/** Counts of official-paper artifacts left OFF this viewer's list, split by
 * why - disclosed on the page (never silently dropped). */
interface WithheldPaperReports {
  /** Attributed to a different member. */
  otherOwner: number;
  /** No owner could be established at all, so nobody may read them. */
  unattributable: number;
}

/**
 * The viewer's OWN official-paper artifacts, plus the counts of the ones that
 * were withheld. `scanOwnerScopedReports` is the only way to obtain these
 * entries (reports/scanner.ts) and this is its only call site, so no listing
 * can include one without passing through this ownership decision.
 */
function loadViewerOwnedPaperReports(
  db: DatabaseSync,
  repoRoot: string,
  viewerId: string
): { entries: ReportIndexEntry[]; withheld: WithheldPaperReports } {
  const candidates = scanOwnerScopedReports(repoRoot);
  if (candidates.length === 0) {
    return { entries: [], withheld: { otherOwner: 0, unattributable: 0 } };
  }

  const attributions = resolveOfficialPaperAttributions(db);
  const entries: ReportIndexEntry[] = [];
  const withheld: WithheldPaperReports = { otherOwner: 0, unattributable: 0 };
  for (const entry of candidates) {
    const attribution = attributionFor(attributions, entry.date);
    if (attribution.kind === "unattributable") {
      withheld.unattributable += 1;
    } else if (attribution.ownerId === viewerId) {
      entries.push(entry);
    } else {
      withheld.otherOwner += 1;
    }
  }
  return { entries, withheld };
}

// Owner's own done/degraded research tasks (plan Task 4: "「研判」筛选片从
// research_tasks（owner 的 done/degraded）列表") - `ownerId` is always the
// resolved VIEWER's own id (never a query/body value), so member B can never
// see member A's research archive through this list. `listForOwner` takes a
// single optional status filter, not a set, so "done OR degraded" is applied
// client-side over the (per-owner, inherently small) full list rather than
// issuing two separate queries.
function loadOwnerResearchArchive(db: DatabaseSync, ownerId: string): ResearchTask[] {
  return new ResearchTaskRepository(db)
    .listForOwner(ownerId)
    .filter((task) => task.status === "done" || task.status === "degraded");
}

function renderTypeChip(type: ReportType, label: string, activeType: string | null): Html {
  const active = activeType === type;
  const extraStyle = active
    ? "background:var(--accent-soft);color:var(--accent);border-color:var(--accent-border);font-weight:600"
    : "background:var(--card);color:var(--ink);border-color:var(--line)";
  const href = active ? "/reports" : `/reports?type=${type}`;
  return html`<a href="${href}" style="display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;padding:6px 14px;font-size:13px;margin:0 8px 8px 0;${extraStyle}">${label}</a>`;
}

// Real, clickable chip for the (now shipped) 研判 archive - same visual
// treatment as renderTypeChip's active/inactive states, just keyed off the
// RESEARCH_TYPE_PARAM sentinel instead of a ReportType.
function renderResearchChip(activeType: string | null): Html {
  const active = activeType === RESEARCH_TYPE_PARAM;
  const extraStyle = active
    ? "background:var(--accent-soft);color:var(--accent);border-color:var(--accent-border);font-weight:600"
    : "background:var(--card);color:var(--ink);border-color:var(--line)";
  const href = active ? "/reports" : `/reports?type=${encodeURIComponent(RESEARCH_TYPE_PARAM)}`;
  return html`<a href="${href}" style="display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;padding:6px 14px;font-size:13px;margin:0 8px 8px 0;${extraStyle}">研判</a>`;
}

// Real, clickable chip for the (now shipped) 复盘 archive - same visual
// treatment as renderTypeChip/renderResearchChip's active/inactive states,
// just keyed off the REVIEW_TYPE_PARAM sentinel instead of a ReportType.
// This was the plan's last remaining disabled/"P9 上线" chip - there is no
// `renderDisabledChip` left in this module at all after this task.
function renderReviewChip(activeType: string | null): Html {
  const active = activeType === REVIEW_TYPE_PARAM;
  const extraStyle = active
    ? "background:var(--accent-soft);color:var(--accent);border-color:var(--accent-border);font-weight:600"
    : "background:var(--card);color:var(--ink);border-color:var(--line)";
  const href = active ? "/reports" : `/reports?type=${encodeURIComponent(REVIEW_TYPE_PARAM)}`;
  return html`<a href="${href}" style="display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;padding:6px 14px;font-size:13px;margin:0 8px 8px 0;${extraStyle}">复盘</a>`;
}

function renderReportCard(entry: ReportIndexEntry): Html {
  const legacyPill = entry.legacy
    ? html`<span class="pill warn" style="margin-left:6px">历史存档</span>`
    : trustedHtml("");
  return html`<a class="card" href="/${entry.type}/${entry.date}" style="display:block">
      <div style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--sub)">
        <span class="pill" style="background:var(--accent-soft);color:var(--accent)">${TYPE_LABELS[entry.type]}</span>
        <span class="mono">${entry.date}</span>
        ${legacyPill}
      </div>
      <div style="margin-top:8px;font-size:14.5px;font-weight:650;color:var(--ink)">${entry.title}</div>
    </a>`;
}

// Research archive card (plan Task 4: "列表卡 = title||question + 置信度 +
// 日期 + /research/<id> 链接").
function renderResearchArchiveCard(task: ResearchTask): Html {
  const label = task.title ?? task.question;
  const confidenceBadge = task.confidence
    ? html`<span class="pill ${task.confidence === "high" ? "ok" : task.confidence === "medium" ? "warn" : ""}">${CONFIDENCE_LABELS[task.confidence]}</span>`
    : trustedHtml("");
  const finishedDate = task.finishedAt ? formatBeijingDate(new Date(task.finishedAt)) : "—";
  return html`<a class="card" href="/research/${task.id}" style="display:block">
      <div style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--sub)">
        <span class="pill" style="background:var(--accent-soft);color:var(--accent)">研判</span>
        <span class="mono">${finishedDate}</span>
        ${confidenceBadge}
      </div>
      <div style="margin-top:8px;font-size:14.5px;font-weight:650;color:var(--ink)">${label}</div>
    </a>`;
}

// Review archive card (plan Task 4: "列表卡 = period + 状态（草稿/已确认）+
// /review/<id> 链接").
const REVIEW_STATUS_LABELS: Record<string, string> = { draft: "草稿", confirmed: "已确认" };

function renderReviewArchiveCard(review: TypedMonthlyReview): Html {
  const statusLabel = REVIEW_STATUS_LABELS[review.status] ?? review.status;
  const statusClass = review.status === "confirmed" ? "ok" : "warn";
  return html`<a class="card" href="/review/${review.id}" style="display:block">
      <div style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--sub)">
        <span class="pill" style="background:var(--accent-soft);color:var(--accent)">复盘</span>
        <span class="mono">${review.period}</span>
        <span class="pill ${statusClass}">${statusLabel}</span>
      </div>
      <div style="margin-top:8px;font-size:14.5px;font-weight:650;color:var(--ink)">${review.period} 月度复盘</div>
    </a>`;
}

/**
 * Honest disclosure for official-paper artifacts kept off this list (defect
 * B1): a member is told HOW MANY were withheld and WHY, so an empty 模拟盘快照
 * filter never reads as "no snapshot was ever produced". Counts only - no
 * date, no title, and none of the account content itself.
 */
function renderWithheldPaperNote(withheld: WithheldPaperReports): Html {
  const clauses: string[] = [];
  if (withheld.otherOwner > 0) {
    clauses.push(`已隐藏 ${withheld.otherOwner} 份属于其他成员的快照`);
  }
  if (withheld.unattributable > 0) {
    clauses.push(`已隐藏 ${withheld.unattributable} 份归属无法确认的快照`);
  }
  if (clauses.length === 0) {
    return trustedHtml("");
  }
  return html`<div class="bento" style="margin-top:10px">
    <section class="card w2 dt-w4">
      <h2>模拟盘快照仅本人可见</h2>
      <p style="margin:0;font-size:13px;color:var(--sub)">
        模拟盘快照写的是某一位成员账户的资金与仓位，只有该账户归属成员本人能看到：${clauses.join("，")}。
      </p>
    </section>
  </div>`;
}

function renderReportsListBody(
  entries: ReportIndexEntry[],
  activeType: string | null,
  researchTasks: ResearchTask[],
  reviews: TypedMonthlyReview[],
  withheldPaper: WithheldPaperReports
): Html {
  const chips = joinHtml([
    ...TYPE_ORDER.map((type) => renderTypeChip(type, TYPE_LABELS[type], activeType)),
    renderResearchChip(activeType),
    renderReviewChip(activeType)
  ]);

  const isResearchView = activeType === RESEARCH_TYPE_PARAM;
  const isReviewView = activeType === REVIEW_TYPE_PARAM;
  const cards = isResearchView
    ? researchTasks.length > 0
      ? joinHtml(researchTasks.map(renderResearchArchiveCard))
      : html`<p style="padding:24px 4px;color:var(--sub);font-size:13px">暂无研判。</p>`
    : isReviewView
      ? reviews.length > 0
        ? joinHtml(reviews.map(renderReviewArchiveCard))
        : html`<p style="padding:24px 4px;color:var(--sub);font-size:13px">暂无复盘，每月第一个周末自动生成草稿。</p>`
      : entries.length > 0
        ? joinHtml(entries.map(renderReportCard))
        : html`<p style="padding:24px 4px;color:var(--sub);font-size:13px">暂无报告。</p>`;

  return html`<div class="bento">
      <section class="card w2 dt-w4">
        <h2>报告类型</h2>
        <div>${chips}</div>
      </section>
    </div>
    ${isResearchView || isReviewView ? trustedHtml("") : renderWithheldPaperNote(withheldPaper)}
    <div class="bento" style="margin-top:10px">${cards}</div>`;
}

// ---------------------------------------------------------------------------
// Reading pages: GET /<type>/<date>
// ---------------------------------------------------------------------------

function renderNotFoundPage(member: Member, nonce: string, now: Date): string {
  const body = html`<div class="bento">
    <section class="card w2 dt-w4">
      <h2>未找到</h2>
      <p style="font-size:13px;color:var(--sub)">该报告不存在，或日期格式不正确。</p>
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

function renderLegacyBanner(): Html {
  return html`<div class="bento" style="padding-bottom:0">
    <section class="card w2 dt-w4 amber" role="alert" aria-label="历史存档提示">
      <h2 style="color:var(--amber)">历史存档</h2>
      <p style="margin:0;font-size:13px;color:var(--ink)">历史存档：旧版格式，含当时共享模拟盘账户内容。</p>
    </section>
  </div>`;
}

/** Heuristic "first paragraph" extraction for the summary card: the first
 * run of contiguous non-heading/non-list/non-table/non-fence lines. Plain
 * text (not markdown-rendered) - it's escaped like any other interpolated
 * string when spliced into the summary card. */
function extractFirstParagraph(md: string): string {
  const lines = md.replace(/\r\n/gu, "\n").split("\n");
  const collected: string[] = [];
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (collected.length > 0) {
        break;
      }
      continue;
    }
    if (/^#{1,6}\s+/u.test(trimmed)) {
      continue;
    }
    if (/^[-*]\s+/u.test(trimmed)) {
      continue;
    }
    if (/^\d+[.)]\s+/u.test(trimmed)) {
      continue;
    }
    if (trimmed.startsWith("|") || trimmed.startsWith("```")) {
      continue;
    }
    collected.push(trimmed);
  }
  return collected.join(" ").trim() || "（无摘要内容）";
}

/** Shared by routes/personal.ts, which renders the same markdown-derived
 * `.report-body` block - exported rather than copied so the two pages'
 * typography stays one definition. */
export const REPORT_BODY_STYLE = trustedHtml(`<style>
.report-body h1{font-size:20px;margin:18px 0 10px}
.report-body h2{font-size:16px;margin:20px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--line)}
.report-body h3{font-size:14px;margin:14px 0 6px}
.report-body p{margin:8px 0;font-size:13.5px;line-height:1.7}
.report-body ul,.report-body ol{margin:8px 0 10px 20px}
.report-body li{margin:4px 0}
.report-body table{border-collapse:collapse;width:100%;margin:10px 0 14px;font-size:12.5px}
.report-body th,.report-body td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.report-body th{background:var(--card2)}
.report-body pre{background:var(--card2);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow-x:auto;font-size:12px}
.report-body code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
.report-body a{color:var(--accent);text-decoration:underline}
</style>`);

/**
 * Entry point to the reader's OWN personal page (Task 6, 2026-07-28), shown
 * only on the two report kinds that generate one (`personal_pages.kind` is
 * CHECK'd to daily/weekly - 个股分析/模拟盘快照 have no personal page at all,
 * so linking to `/stock-analysis/<date>/me` would just be a guaranteed 404).
 * The href carries no owner: routes/personal.ts resolves the owner from the
 * session, and refuses an `?owner=` parameter outright.
 */
function renderPersonalPageEntry(entry: ReportIndexEntry): Html {
  if (entry.type !== "daily" && entry.type !== "weekly") {
    return trustedHtml("");
  }
  return html`<div class="bento" style="margin-top:10px">
    <section class="card w2 dt-w4">
      <h2>我的个人页</h2>
      <p style="font-size:13px;color:var(--sub)">
        持仓、策略对照、提醒回顾与待办都在你自己的个人页里，公共${TYPE_LABELS[entry.type]}不含任何个人内容。
      </p>
      <a class="btn primary" href="/${entry.type}/${entry.date}/me">我的个人页 →</a>
    </section>
  </div>`;
}

function renderReadingBody(entry: ReportIndexEntry, rawMd: string, rendered: MarkdownRenderResult): Html {
  const legacyNote = entry.legacy
    ? html`<p style="margin-top:6px;font-size:12px;color:var(--sub)">旧格式无置信度</p>`
    : trustedHtml("");

  const summarySection = html`<section class="card w2 dt-w4">
    <h2>摘要</h2>
    <p style="font-size:13.5px;line-height:1.7">${extractFirstParagraph(rawMd)}</p>
    ${legacyNote}
  </section>`;

  const tocSection =
    rendered.toc.length > 0
      ? html`<details>
          <summary style="cursor:pointer;font-size:13px;color:var(--sub);padding:4px 0">目录</summary>
          <ul style="margin:6px 0 0 18px;font-size:13px">
            ${joinHtml(
              rendered.toc.map(
                (item) => html`<li style="margin:4px 0"><a href="#${item.id}" style="color:var(--accent)">${item.text}</a></li>`
              )
            )}
          </ul>
        </details>`
      : trustedHtml("");

  const sourcesSection =
    rendered.sources.length > 0
      ? html`<section class="card w2 dt-w4" style="margin-top:10px">
          <h2>来源清单</h2>
          <ul style="margin:0;padding-left:18px;font-size:13px">
            ${joinHtml(
              rendered.sources.map(
                (source) =>
                  html`<li style="margin:4px 0"><a href="${source.url}" rel="noreferrer" target="_blank" style="color:var(--accent)">${source.text}</a></li>`
              )
            )}
          </ul>
        </section>`
      : trustedHtml("");

  return html`${entry.legacy ? renderLegacyBanner() : trustedHtml("")}
    <div class="bento">${summarySection}</div>
    ${renderPersonalPageEntry(entry)}
    <div class="bento" style="margin-top:10px">
      <section class="card w2 dt-w4">
        ${tocSection}
        <div class="report-body" style="margin-top:10px">${rendered.html}</div>
      </section>
    </div>
    <div class="bento" style="margin-top:10px">${sourcesSection}</div>
    ${REPORT_BODY_STYLE}`;
}

/**
 * 403 for an official-paper artifact this member may not read (defect B1).
 * States the actual reason - "belongs to another member" vs the concrete
 * reason ownership could not be established - because a 404 would claim the
 * report does not exist, and an empty page would read like "your account is
 * empty". Neither is true.
 */
function renderPaperForbiddenPage(member: Member, nonce: string, now: Date, detail: Html): string {
  const body = html`<div class="bento">
    <section class="card w2 dt-w4">
      <h2>403 无权访问</h2>
      ${detail}
    </section>
  </div>`;
  return renderPage({
    title: "403 无权访问",
    nav: "reports",
    member: { displayName: member.displayName },
    freshness: "最新",
    degraded: [],
    bodyHtml: body,
    nonce,
    now
  });
}

/**
 * The ownership gate for owner-scoped artifacts. Returns `true` when the
 * request has been answered with a 403 and the caller must stop.
 *
 * Runs BEFORE the entry is looked up and before the file is read, so (a) no
 * account bytes are loaded for a member who may not have them, and (b) a
 * non-owner gets the SAME 403 whether or not that date has a file - the
 * response never reveals which dates exist. The viewer's own id is the only
 * thing compared against the attribution; nothing in the request can name an
 * owner.
 */
function refusedOwnerScopedReport(
  res: ServerResponse,
  deps: ReportsRouteDeps,
  dateParam: string,
  member: Member,
  nonce: string,
  now: Date
): boolean {
  const attribution = attributionFor(resolveOfficialPaperAttributions(deps.db), dateParam);
  if (attribution.kind === "owner" && attribution.ownerId === member.id) {
    return false;
  }

  const detail =
    attribution.kind === "owner"
      ? html`<p style="font-size:13px;color:var(--sub)">
          模拟盘快照写的是某一位成员账户的资金与仓位，只有该账户归属成员本人能打开。这一份不属于你。
        </p>`
      : html`<p style="font-size:13px;color:var(--sub)">
          这份模拟盘快照在磁盘上没有归属标注，系统也无法确认它写的是谁的账户（${attribution.reason}）。为避免把别人的账户内容给错人，它对任何成员都不开放；你自己的账户数据在
          <a href="/paper" style="color:var(--accent)">模拟盘</a> 页面。
        </p>`;
  sendHtml(res, 403, renderPaperForbiddenPage(member, nonce, now, detail));
  return true;
}

function renderReadingPage(
  res: ServerResponse,
  deps: ReportsRouteDeps,
  type: ReportType,
  dateParam: string,
  member: Member,
  nonce: string
): void {
  const now = currentNow(deps);
  // Owner-scoped types (模拟盘快照) answer only their owner, so EVERY response
  // on that path - 404 shells included - is owner-private for caching purposes
  // (defect B2).
  const ownerScoped = isOwnerScopedType(type);
  const send = (status: number, body: string): void => sendHtml(res, status, body);

  // Validate BEFORE touching the filesystem at all (path traversal guard -
  // e.g. `/daily/../../etc/passwd` never reaches scanReports/readFileSync
  // because dateParam fails this check first).
  if (!DATE_PARAM_RE.test(dateParam)) {
    send(404, renderNotFoundPage(member, nonce, now));
    return;
  }

  // Ownership is resolved before anything is scanned or read - see
  // refusedOwnerScopedReport.
  if (ownerScoped && refusedOwnerScopedReport(res, deps, dateParam, member, nonce, now)) {
    return;
  }

  const entries = ownerScoped ? scanOwnerScopedReports(deps.repoRoot) : scanReports(deps.repoRoot);
  const entry = entries.find((candidate) => candidate.type === type && candidate.date === dateParam);
  if (!entry) {
    send(404, renderNotFoundPage(member, nonce, now));
    return;
  }

  const rawMd = readFileSync(entry.mdPath, "utf8");
  const rendered = renderMarkdown(rawMd);
  const freshness: Freshness = entry.date === formatBeijingDate(now) ? "最新" : "延迟";

  const page = renderPage({
    title: entry.title,
    nav: "reports",
    member: { displayName: member.displayName },
    freshness,
    degraded: [],
    bodyHtml: renderReadingBody(entry, rawMd, rendered),
    nonce,
    now
  });
  send(200, page);
}
