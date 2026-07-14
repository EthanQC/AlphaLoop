/**
 * Strategy page (Task 7): `GET /strategy`. Identity-gated like every route
 * past Task 3.
 *
 * Three sections, in this fixed order (plan Task 7, req §1.7 - not to be
 * reshuffled):
 *   ① 我的纪律       - ALL of the viewer's own discipline_rules (enabled AND
 *                      disabled, enabled first - data/overview.ts's
 *                      loadAllDisciplineRulesForOwner), each with its
 *                      enforcement badge and a 「统计 P7 上线」 placeholder
 *                      where 近30天遵守 stats will eventually go. Empty ->
 *                      「策略记忆 P7 上线」.
 *   ② 我的策略卡与论点 - the viewer's OWN theses, in EVERY visibility (this is
 *                      the one place a member sees their own 'system'-only
 *                      theses rendered back to them, with a visibility pill
 *                      so they can tell which tier each one is at), each with
 *                      its append-only thesis_history timeline. Empty ->
 *                      「策略记忆 P7 上线」.
 *   ③ 圈子公开区     - OTHER active members' theses, `visibility = 'public'`
 *                      ONLY, grouped by member (display name links to
 *                      `/member/<id>`). Empty -> 「圈子暂无公开策略」 (a
 *                      DIFFERENT empty state than ①/② - "the feature exists
 *                      and works, nobody else has published anything yet",
 *                      not "this hasn't shipped").
 *
 * VISIBILITY ENFORCEMENT (Global Constraints: "服务端强制隔离"): section ③'s
 * query filters `visibility = 'public' AND owner_id != ?` at the SQL level -
 * a member's 'system'-tier thesis is never fetched for anyone but its owner,
 * so there is no JS-side filter step that could be forgotten.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { methodNotAllowed, type Member } from "@packages/shared-types";

import { loadAllDisciplineRulesForOwner, type DisciplineRuleRow } from "../data/overview.js";
import { renderUnauthorizedPage, resolveIdentity } from "../identity.js";
import { html, joinHtml, trustedHtml, type Html } from "../render/html.js";
import { renderPage } from "../render/layout.js";

export interface StrategyRouteDeps {
  db: DatabaseSync;
  /** Injectable clock for deterministic tests; defaults to wall clock. */
  now?: () => Date;
}

const ENFORCEMENT_LABELS: Record<string, string> = {
  hard: "代码强制",
  proposal_check: "提案检查",
  self: "自我约束"
};

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

function currentNow(deps: StrategyRouteDeps): Date {
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

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

export interface ThesisRow {
  id: string;
  ownerId: string;
  ownerDisplayName: string;
  symbol: string;
  direction: "bull" | "bear" | "neutral";
  targetLow: number | null;
  targetHigh: number | null;
  invalidationPrice: number | null;
  visibility: "system" | "public";
  status: "active" | "withdrawn" | "superseded";
  createdAt: string;
}

export interface ThesisHistoryRow {
  id: string;
  note: string;
  source: string;
  createdAt: string;
}

function mapThesisRow(row: Record<string, unknown>): ThesisRow {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    ownerDisplayName: String(row.owner_display_name),
    symbol: String(row.symbol),
    direction: row.direction as ThesisRow["direction"],
    targetLow: row.target_low === null || row.target_low === undefined ? null : Number(row.target_low),
    targetHigh: row.target_high === null || row.target_high === undefined ? null : Number(row.target_high),
    invalidationPrice:
      row.invalidation_price === null || row.invalidation_price === undefined ? null : Number(row.invalidation_price),
    visibility: row.visibility as ThesisRow["visibility"],
    status: row.status as ThesisRow["status"],
    createdAt: String(row.created_at)
  };
}

/** The viewer's OWN theses, every visibility - "本人全见" (plan Task 7). */
function loadOwnTheses(db: DatabaseSync, ownerId: string): ThesisRow[] {
  const rows = db
    .prepare(`
      SELECT t.id AS id, t.owner_id AS owner_id, m.display_name AS owner_display_name,
             t.symbol AS symbol, t.direction AS direction, t.target_low AS target_low,
             t.target_high AS target_high, t.invalidation_price AS invalidation_price,
             t.visibility AS visibility, t.status AS status, t.created_at AS created_at
      FROM theses t
      JOIN members m ON m.id = t.owner_id
      WHERE t.owner_id = ?
      ORDER BY t.created_at DESC
    `)
    .all(ownerId) as Array<Record<string, unknown>>;
  return rows.map(mapThesisRow);
}

/**
 * OTHER active members' `public` theses only - "他人仅 public" (plan Task 7).
 * `owner_id != ?` and `visibility = 'public'` are both enforced in the WHERE
 * clause itself, never filtered in JS after an unfiltered fetch; joining
 * `members` with `status = 'active'` additionally keeps a revoked member's
 * old public theses out of the circle view.
 */
function loadCirclePublicTheses(db: DatabaseSync, viewerId: string): ThesisRow[] {
  const rows = db
    .prepare(`
      SELECT t.id AS id, t.owner_id AS owner_id, m.display_name AS owner_display_name,
             t.symbol AS symbol, t.direction AS direction, t.target_low AS target_low,
             t.target_high AS target_high, t.invalidation_price AS invalidation_price,
             t.visibility AS visibility, t.status AS status, t.created_at AS created_at
      FROM theses t
      JOIN members m ON m.id = t.owner_id
      WHERE t.visibility = 'public' AND t.owner_id != ? AND m.status = 'active'
      ORDER BY m.display_name ASC, t.created_at DESC
    `)
    .all(viewerId) as Array<Record<string, unknown>>;
  return rows.map(mapThesisRow);
}

/** Append-only judgment timeline for one thesis, oldest first (a timeline
 * reads top-to-bottom as "what happened, in order" - the plan's own wording,
 * "判断历史时间线（append-only）", describes a growing log, not a most-recent-
 * first feed). */
function loadThesisHistory(db: DatabaseSync, thesisId: string): ThesisHistoryRow[] {
  const rows = db
    .prepare(`SELECT id, note, source, created_at FROM thesis_history WHERE thesis_id = ? ORDER BY created_at ASC`)
    .all(thesisId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    note: String(row.note),
    source: String(row.source),
    createdAt: String(row.created_at)
  }));
}

interface ThesisGroup {
  ownerId: string;
  ownerDisplayName: string;
  theses: ThesisRow[];
}

/** Groups an already-ordered thesis list by owner, preserving first-seen
 * order (the SQL query's own ORDER BY decides which owner appears first). */
function groupThesesByOwner(theses: readonly ThesisRow[]): ThesisGroup[] {
  const order: string[] = [];
  const byOwner = new Map<string, ThesisGroup>();
  for (const thesis of theses) {
    let group = byOwner.get(thesis.ownerId);
    if (!group) {
      group = { ownerId: thesis.ownerId, ownerDisplayName: thesis.ownerDisplayName, theses: [] };
      byOwner.set(thesis.ownerId, group);
      order.push(thesis.ownerId);
    }
    group.theses.push(thesis);
  }
  return order.map((ownerId) => byOwner.get(ownerId) as ThesisGroup);
}

// ---------------------------------------------------------------------------
// ① 我的纪律
// ---------------------------------------------------------------------------

function renderDisciplineRow(rule: DisciplineRuleRow): Html {
  const label = ENFORCEMENT_LABELS[rule.enforcement] ?? rule.enforcement;
  const statusPill = rule.enabled
    ? html`<span class="pill ok">启用</span>`
    : html`<span class="pill warn">已停用</span>`;
  return html`<div class="disc">
    ${rule.ruleText}
    <div style="margin-top:4px;display:flex;gap:6px;align-items:center">
      <span class="pill" style="background:var(--accent-soft);color:var(--accent)">${label}</span>
      ${statusPill}
    </div>
    <span class="days">近30天遵守：统计 P7 上线</span>
  </div>`;
}

function renderDisciplineSection(rules: DisciplineRuleRow[]): Html {
  const body =
    rules.length > 0
      ? joinHtml(rules.map(renderDisciplineRow))
      : html`<p style="font-size:13px;color:var(--sub)">策略记忆 P7 上线</p>`;
  return html`<section class="card w2 dt-w4">
    <h2>我的纪律</h2>
    ${body}
  </section>`;
}

// ---------------------------------------------------------------------------
// ② 我的策略卡与论点
// ---------------------------------------------------------------------------

function renderThesisHistoryTimeline(history: ThesisHistoryRow[]): Html {
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

function renderMyThesisCard(thesis: ThesisRow, history: ThesisHistoryRow[]): Html {
  const directionLabel = DIRECTION_LABELS[thesis.direction] ?? thesis.direction;
  const directionClass = DIRECTION_CLASS[thesis.direction] ?? "";
  const visibilityLabel = VISIBILITY_LABELS[thesis.visibility] ?? thesis.visibility;
  const range =
    thesis.targetLow !== null && thesis.targetHigh !== null
      ? html`目标区间 <span class="mono">${thesis.targetLow} - ${thesis.targetHigh}</span>`
      : html`目标区间未设定`;
  const invalidation =
    thesis.invalidationPrice !== null
      ? html` · 失效价 <span class="mono">${thesis.invalidationPrice}</span>`
      : trustedHtml("");

  return html`<div class="disc" style="margin-bottom:12px;padding-bottom:10px;border-bottom:1px dashed var(--line)">
    <b class="mono">${thesis.symbol}</b>
    <span class="${directionClass}" style="margin-left:6px;font-weight:600">${directionLabel}</span>
    <span class="pill" style="margin-left:6px;background:var(--accent-soft);color:var(--accent)">${visibilityLabel}</span>
    <div style="margin-top:4px">${range}${invalidation}</div>
    ${renderThesisHistoryTimeline(history)}
  </div>`;
}

function renderMyThesisSection(theses: ThesisRow[], historyByThesisId: Map<string, ThesisHistoryRow[]>): Html {
  if (theses.length === 0) {
    return html`<section class="card w2 dt-w4">
      <h2>我的策略卡与论点</h2>
      <p style="font-size:13px;color:var(--sub)">策略记忆 P7 上线</p>
    </section>`;
  }
  const cards = joinHtml(theses.map((thesis) => renderMyThesisCard(thesis, historyByThesisId.get(thesis.id) ?? [])));
  return html`<section class="card w2 dt-w4">
    <h2>我的策略卡与论点</h2>
    ${cards}
  </section>`;
}

// ---------------------------------------------------------------------------
// ③ 圈子公开区
// ---------------------------------------------------------------------------

function renderCircleThesisRow(thesis: ThesisRow): Html {
  const directionLabel = DIRECTION_LABELS[thesis.direction] ?? thesis.direction;
  const directionClass = DIRECTION_CLASS[thesis.direction] ?? "";
  const range =
    thesis.targetLow !== null && thesis.targetHigh !== null
      ? html`目标区间 <span class="mono">${thesis.targetLow} - ${thesis.targetHigh}</span>`
      : html`目标区间未设定`;
  return html`<div class="disc">
    <b class="mono">${thesis.symbol}</b>
    <span class="${directionClass}" style="margin-left:6px;font-weight:600">${directionLabel}</span>
    <span style="margin-left:6px">${range}</span>
  </div>`;
}

function renderCircleGroup(group: ThesisGroup): Html {
  return html`<div style="margin-bottom:10px">
    <a href="/member/${group.ownerId}" style="color:var(--accent);font-size:13px;font-weight:600">${group.ownerDisplayName}</a>
    <div style="margin-top:4px">${joinHtml(group.theses.map(renderCircleThesisRow))}</div>
  </div>`;
}

function renderCirclePublicSection(groups: ThesisGroup[]): Html {
  const body =
    groups.length > 0
      ? joinHtml(groups.map(renderCircleGroup))
      : html`<p style="font-size:13px;color:var(--sub)">圈子暂无公开策略</p>`;
  return html`<section class="card w2 dt-w4">
    <h2>圈子公开区</h2>
    ${body}
  </section>`;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function renderStrategyPage(res: ServerResponse, deps: StrategyRouteDeps, member: Member, nonce: string): void {
  const now = currentNow(deps);

  const disciplineRules = loadAllDisciplineRulesForOwner(deps.db, member.id);

  const ownTheses = loadOwnTheses(deps.db, member.id);
  const historyByThesisId = new Map<string, ThesisHistoryRow[]>();
  for (const thesis of ownTheses) {
    historyByThesisId.set(thesis.id, loadThesisHistory(deps.db, thesis.id));
  }

  const circleTheses = loadCirclePublicTheses(deps.db, member.id);
  const circleGroups = groupThesesByOwner(circleTheses);

  const bodyHtml = html`<div class="bento">${renderDisciplineSection(disciplineRules)}</div>
    <div class="bento" style="margin-top:10px">${renderMyThesisSection(ownTheses, historyByThesisId)}</div>
    <div class="bento" style="margin-top:10px">${renderCirclePublicSection(circleGroups)}</div>`;

  const page = renderPage({
    title: "策略",
    nav: "strategy",
    member: { displayName: member.displayName },
    freshness: "最新",
    degraded: [],
    bodyHtml,
    nonce,
    now
  });
  sendHtml(res, 200, page);
}

/**
 * Routes `GET /strategy`. Returns `true` if the request was handled
 * (including the 401/405 cases), `false` if the path isn't `/strategy` so
 * the caller can keep trying other routes.
 */
export function handleStrategyRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: StrategyRouteDeps,
  nonce: string
): boolean {
  if (url.pathname !== "/strategy") {
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

  renderStrategyPage(res, deps, member, nonce);
  return true;
}
