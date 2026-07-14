/**
 * Proposal detail page (Task 7): `GET /proposal/<id>`. Identity-gated like
 * every route past Task 3, PLUS a second, independent ownership check on top
 * of identity (plan Task 7, req §1.9: "仅本人可见自己的提案详情").
 *
 * ACCESS ORDER IS LOAD-BEARING (plan Task 7 explicit requirement - "先查行、
 * 比 owner、再渲染"):
 *   1. Resolve the row FIRST, by id alone, no owner filter in the query.
 *   2. No row at all -> 404.
 *   3. Row exists AND `owner_id !== viewer.id` -> 403 (render/forbidden.ts's
 *      shared page) - a DIFFERENT status code from 404 on purpose (req §7:
 *      "被拒" must be distinguishable from "not found", so a non-owner
 *      probing ids can't use the status code to learn whether an id exists
 *      at all... except that here it CAN, by design: the plan explicitly
 *      calls for 403, not a privacy-preserving 404-for-everything. See the
 *      plan's own worked example: "A 本人 → 404【空库】仍非 403" - the two
 *      codes are meant to disagree, not to be indistinguishable.).
 *   4. Row exists AND `owner_id === viewer.id` -> render the full page.
 *
 * The empty `proposals` table today (P6 hasn't shipped proposal creation
 * yet) means every real id 404s in production right now - but the 403 code
 * path must exist and be exercised with seeded rows in tests (plan: "空表
 * ...仍必须真实存在并测试").
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { methodNotAllowed, type Member } from "@packages/shared-types";

import { renderUnauthorizedPage, resolveIdentity } from "../identity.js";
import { html, joinHtml, trustedHtml, type Html } from "../render/html.js";
import { renderForbiddenPage } from "../render/forbidden.js";
import { renderPage } from "../render/layout.js";

export interface ProposalRouteDeps {
  db: DatabaseSync;
  /** Injectable clock for deterministic tests; defaults to wall clock. */
  now?: () => Date;
}

// Chinese labels for the proposals.status CHECK constraint's full value set
// (packages/shared-types database.ts) - covers all 7 values the schema
// actually allows; the archived req doc's "五态" (待审批/已批准·已成交/已拒绝/
// 已过期/熔断暂停) describes the user-facing GROUPING, not a literal 5-value
// enum, so 'approved'/'approved_half'/'executed' all read as visually
// "approved" (ok/green) while still keeping their own distinct label text.
const STATUS_LABELS: Record<string, { label: string; pillClass: string; style?: string }> = {
  pending: { label: "待审批", pillClass: "pill warn" },
  approved: { label: "已批准", pillClass: "pill ok" },
  approved_half: { label: "部分批准", pillClass: "pill ok" },
  executed: { label: "已批准·已成交", pillClass: "pill ok" },
  rejected: { label: "已拒绝", pillClass: "pill", style: "background:var(--card2);color:var(--sub)" },
  expired: { label: "已过期", pillClass: "pill", style: "background:var(--card2);color:var(--sub)" },
  failed: { label: "熔断暂停", pillClass: "pill", style: "background:var(--down);color:#fff" }
};

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function currentNow(deps: ProposalRouteDeps): Date {
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

interface ProposalDetailRow {
  id: string;
  ownerId: string;
  symbol: string;
  side: string;
  quantity: number;
  orderType: string;
  limitPrice: number | null;
  reason: string;
  evidence: unknown;
  strategyRef: string | null;
  disciplineReport: unknown;
  invalidation: string | null;
  stopLoss: number | null;
  budgetImpact: number | null;
  confidence: string | null;
  status: string;
  decidedAt: string | null;
  decidedBy: string | null;
  consumedAt: string | null;
  outcome: string | null;
  createdAt: string;
  expiresAt: string;
}

/** Best-effort JSON parse for the evidence/discipline_report TEXT columns
 * (both `NOT NULL DEFAULT '[]'` per the schema, but still parsed
 * defensively) - malformed JSON renders as an empty array rather than
 * throwing and 500ing the whole page. */
function parseJsonColumn(raw: unknown): unknown {
  try {
    return JSON.parse(String(raw));
  } catch {
    return [];
  }
}

function loadProposalById(db: DatabaseSync, id: string): ProposalDetailRow | null {
  const row = db.prepare(`SELECT * FROM proposals WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    symbol: String(row.symbol),
    side: String(row.side),
    quantity: Number(row.quantity),
    orderType: String(row.order_type),
    limitPrice: row.limit_price === null || row.limit_price === undefined ? null : Number(row.limit_price),
    reason: String(row.reason),
    evidence: parseJsonColumn(row.evidence),
    strategyRef: row.strategy_ref === null || row.strategy_ref === undefined ? null : String(row.strategy_ref),
    disciplineReport: parseJsonColumn(row.discipline_report),
    invalidation: row.invalidation === null || row.invalidation === undefined ? null : String(row.invalidation),
    stopLoss: row.stop_loss === null || row.stop_loss === undefined ? null : Number(row.stop_loss),
    budgetImpact: row.budget_impact === null || row.budget_impact === undefined ? null : Number(row.budget_impact),
    confidence: row.confidence === null || row.confidence === undefined ? null : String(row.confidence),
    status: String(row.status),
    decidedAt: row.decided_at === null || row.decided_at === undefined ? null : String(row.decided_at),
    decidedBy: row.decided_by === null || row.decided_by === undefined ? null : String(row.decided_by),
    consumedAt: row.consumed_at === null || row.consumed_at === undefined ? null : String(row.consumed_at),
    outcome: row.outcome === null || row.outcome === undefined ? null : String(row.outcome),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at)
  };
}

// ---------------------------------------------------------------------------
// 404 page
// ---------------------------------------------------------------------------

function renderNotFoundPage(member: Member, nonce: string, now: Date): string {
  const body = html`<div class="bento">
    <section class="card w2 dt-w4">
      <h2>未找到</h2>
      <p style="font-size:13px;color:var(--sub)">该提案不存在。</p>
    </section>
  </div>`;
  return renderPage({
    title: "未找到",
    nav: "paper",
    member: { displayName: member.displayName },
    freshness: "最新",
    degraded: [],
    bodyHtml: body,
    nonce,
    now
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderStatusBar(status: string): Html {
  const entry = STATUS_LABELS[status] ?? { label: status, pillClass: "pill warn" };
  return html`<section class="card w2 dt-w4">
    <h2>状态</h2>
    <span class="${entry.pillClass}" style="${entry.style ?? ""}">${entry.label}</span>
  </section>`;
}

function renderOriginalTextCard(proposal: ProposalDetailRow): Html {
  const limitPrice = proposal.limitPrice !== null ? html`限价 <span class="mono">${proposal.limitPrice}</span>` : html`市价`;
  const invalidation = proposal.invalidation
    ? html`<div style="margin-top:6px;font-size:13px">失效条件：${proposal.invalidation}</div>`
    : trustedHtml("");
  const stopLoss =
    proposal.stopLoss !== null
      ? html`<div style="margin-top:4px;font-size:13px">止损位：<span class="mono">${proposal.stopLoss}</span></div>`
      : trustedHtml("");
  const confidence = proposal.confidence
    ? html`<div style="margin-top:4px;font-size:13px">置信度：${proposal.confidence}</div>`
    : trustedHtml("");
  return html`<section class="card w2 dt-w4">
    <h2>提案原文</h2>
    <div class="disc"><b class="mono">${proposal.symbol}</b> ${proposal.side} <span class="mono">${proposal.quantity}</span> 股 · ${proposal.orderType} · ${limitPrice}</div>
    <div style="margin-top:6px;font-size:13px">${proposal.reason}</div>
    ${invalidation}
    ${stopLoss}
    ${confidence}
  </section>`;
}

function renderJsonBlock(value: unknown): Html {
  return html`<pre class="mono" style="white-space:pre-wrap;font-size:12px;background:var(--card2);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow-x:auto">${JSON.stringify(
    value,
    null,
    2
  )}</pre>`;
}

function renderDisciplineReportCard(proposal: ProposalDetailRow): Html {
  return html`<section class="card w2 dt-w2">
    <h2>纪律检查</h2>
    ${renderJsonBlock(proposal.disciplineReport)}
  </section>`;
}

function renderEvidenceCard(proposal: ProposalDetailRow): Html {
  return html`<section class="card w2 dt-w2">
    <h2>引用证据</h2>
    ${renderJsonBlock(proposal.evidence)}
  </section>`;
}

function renderApprovalTimelineCard(proposal: ProposalDetailRow): Html {
  const entries: Html[] = [
    html`<div class="alert"><time class="mono">${proposal.createdAt}</time><span>提案创建</span></div>`
  ];
  if (proposal.decidedAt) {
    const decidedByNote = proposal.decidedBy ? ` · 决策人 ${proposal.decidedBy}` : "";
    entries.push(
      html`<div class="alert"><time class="mono">${proposal.decidedAt}</time><span>审批决定${decidedByNote}</span></div>`
    );
  }
  if (proposal.consumedAt) {
    entries.push(html`<div class="alert"><time class="mono">${proposal.consumedAt}</time><span>执行完成</span></div>`);
  }
  return html`<section class="card w2 dt-w4">
    <h2>审批与执行时间线</h2>
    ${joinHtml(entries)}
  </section>`;
}

function renderOutcomeCard(proposal: ProposalDetailRow): Html {
  const body = proposal.outcome
    ? html`<p style="font-size:13px">${proposal.outcome}</p>`
    : html`<p style="font-size:13px;color:var(--sub)">待 P6/P9 完善</p>`;
  return html`<section class="card w2 dt-w4">
    <h2>事后表现</h2>
    ${body}
  </section>`;
}

function renderProposalPage(
  res: ServerResponse,
  deps: ProposalRouteDeps,
  member: Member,
  proposal: ProposalDetailRow,
  nonce: string
): void {
  const now = currentNow(deps);

  const bodyHtml = html`<div class="bento">${renderStatusBar(proposal.status)}</div>
    <div class="bento" style="margin-top:10px">${renderOriginalTextCard(proposal)}</div>
    <div class="bento" style="margin-top:10px">${renderDisciplineReportCard(proposal)}${renderEvidenceCard(proposal)}</div>
    <div class="bento" style="margin-top:10px">${renderApprovalTimelineCard(proposal)}</div>
    <div class="bento" style="margin-top:10px">${renderOutcomeCard(proposal)}</div>`;

  const page = renderPage({
    title: `提案 ${proposal.symbol}`,
    nav: "paper",
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
 * Routes `GET /proposal/<id>`. Returns `true` if the request was handled
 * (including 401/403/404/405 responses), `false` if the path doesn't belong
 * to this module so the caller can keep trying other routes.
 */
export function handleProposalRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ProposalRouteDeps,
  nonce: string
): boolean {
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2 || segments[0] !== "proposal") {
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

  const now = currentNow(deps);
  const id = segments[1] as string;

  // Resolve the row FIRST, before any ownership comparison - see module doc.
  const proposal = loadProposalById(deps.db, id);
  if (!proposal) {
    sendHtml(res, 404, renderNotFoundPage(member, nonce, now));
    return true;
  }

  if (proposal.ownerId !== member.id) {
    sendHtml(res, 403, renderForbiddenPage(member, "paper", nonce, now));
    return true;
  }

  renderProposalPage(res, deps, member, proposal, nonce);
  return true;
}
