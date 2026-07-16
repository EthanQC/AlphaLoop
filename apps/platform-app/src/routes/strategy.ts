/**
 * Strategy page (Task 7, upgraded Phase 7 Task 5 2026-07-15 plan):
 * `GET /strategy`. Identity-gated like every route past Task 3.
 *
 * Three sections, in this fixed order (plan Task 7 req §1.7, unchanged by
 * Task 5's rendering upgrade - not to be reshuffled):
 *   ① 我的纪律       - ALL of the viewer's own discipline_rules (enabled AND
 *                      disabled, enabled first) - each with its enforcement
 *                      badge AND a REAL 近30天遵守 statistic
 *                      (computeComplianceStats, data/strategy.ts) - no more
 *                      「统计 P7 上线」placeholder. Empty -> 「暂无纪律规则」.
 *   ② 我的策略卡与论点 - the viewer's OWN strategy_cards (every visibility) with
 *                      a status badge (活跃/暂停/退役) and a visibility pill,
 *                      THEN the viewer's OWN theses (every visibility) - the
 *                      one place a member sees their own 'system'-only
 *                      theses/cards rendered back to them - each thesis with
 *                      its bull_points/bear_points evidence double-column,
 *                      target range, invalidation, visibility pill, and its
 *                      append-only thesis_history timeline annotated with
 *                      computeThesisOutcome's deterministic post-hoc verdict.
 *                      Empty card list -> 「暂无策略卡」; empty thesis list ->
 *                      「暂无论点」(replacing the old, now-inaccurate 「策略记忆
 *                      P7 上线」placeholder - the feature has shipped).
 *   ③ 圈子公开区     - OTHER active members' `visibility = 'public'` theses
 *                      AND strategy cards ONLY, grouped by member (display
 *                      name links to `/member/<id>`). Empty -> 「圈子暂无公开策略」
 *                      (a DIFFERENT empty state than ①/② - "the feature
 *                      exists and works, nobody else has published anything
 *                      yet", not "this hasn't shipped").
 *
 * VISIBILITY ENFORCEMENT (Global Constraints: "服务端强制隔离"): every reader
 * this page calls (data/strategy.ts) filters `visibility = 'public' AND
 * owner_id != ?` at the SQL level - a member's 'system'-tier thesis/card is
 * never fetched for anyone but its owner, so there is no JS-side filter step
 * that could be forgotten.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { methodNotAllowed, type Member } from "@packages/shared-types";

import {
  computeComplianceStats,
  computeThesisOutcome,
  groupThesesByOwner,
  loadCirclePublicTheses,
  loadLatestPriceForSymbol,
  loadOwnTheses,
  loadPublicStrategyCards,
  loadStrategyCardsForOwner,
  loadThesisHistory,
  type ComplianceStats,
  type StrategyCardRow,
  type ThesisEvidenceRow,
  type ThesisHistoryRow,
  type ThesisOutcomeJudgmentResult
} from "../data/strategy.js";
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
const CARD_STATUS_LABELS: Record<string, string> = { active: "活跃", paused: "暂停", retired: "退役" };

const VERDICT_LABELS: Record<string, string> = {
  toward_target: "走势偏向目标",
  toward_invalidation: "走势偏向失效",
  neutral: "区间震荡",
  insufficient: "证据不足（缺目标价/失效价）",
  no_price: "暂无最新价"
};

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
// ① 我的纪律
// ---------------------------------------------------------------------------

function renderComplianceLine(stats: ComplianceStats): Html {
  if (stats.sample === "none") {
    return html`<span class="days">近30天无相关提案</span>`;
  }
  return html`<span class="days">近30天 ${stats.checked} 次检查，遵守 ${stats.passed} / 违反 ${stats.failed}</span>`;
}

function renderDisciplineRow(rule: DisciplineRuleRow, stats: ComplianceStats): Html {
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
    ${renderComplianceLine(stats)}
  </div>`;
}

function renderDisciplineSection(rules: DisciplineRuleRow[], statsByRuleId: Map<string, ComplianceStats>): Html {
  const body =
    rules.length > 0
      ? joinHtml(rules.map((rule) => renderDisciplineRow(rule, statsByRuleId.get(rule.id) ?? { sample: "none" })))
      : html`<p style="font-size:13px;color:var(--sub)">暂无纪律规则</p>`;
  return html`<section class="card w2 dt-w4">
    <h2>我的纪律</h2>
    ${body}
  </section>`;
}

// ---------------------------------------------------------------------------
// ② 我的策略卡与论点
// ---------------------------------------------------------------------------

function renderStrategyCardRow(card: StrategyCardRow): Html {
  const statusLabel = CARD_STATUS_LABELS[card.status] ?? card.status;
  const visibilityLabel = VISIBILITY_LABELS[card.visibility] ?? card.visibility;
  const scene = card.scene ? html` <span style="color:var(--sub)">· ${card.scene}</span>` : trustedHtml("");
  return html`<div class="disc">
    <b>${card.name}</b>${scene}
    <div style="margin-top:4px;display:flex;gap:6px">
      <span class="pill" style="background:var(--accent-soft);color:var(--accent)">${statusLabel}</span>
      <span class="pill">${visibilityLabel}</span>
    </div>
  </div>`;
}

function renderStrategyCardsSubsection(cards: StrategyCardRow[]): Html {
  const body =
    cards.length > 0
      ? joinHtml(cards.map(renderStrategyCardRow))
      : html`<p style="font-size:13px;color:var(--sub)">暂无策略卡</p>`;
  return html`<div style="margin-bottom:14px">
    <h3 style="font-size:13px;color:var(--sub);margin:0 0 6px">策略卡</h3>
    ${body}
  </div>`;
}

function renderEvidencePoints(points: string[]): Html {
  if (points.length === 0) {
    return html`<p style="font-size:12px;color:var(--sub);margin:2px 0 0">暂无依据</p>`;
  }
  return joinHtml(points.map((point) => html`<li style="font-size:12.5px">${point}</li>`));
}

function renderJudgmentRow(entry: ThesisHistoryRow, outcome: ThesisOutcomeJudgmentResult | undefined): Html {
  const verdictLabel = outcome ? VERDICT_LABELS[outcome.verdict] ?? outcome.verdict : "";
  const verdictHtml = outcome
    ? html` <span style="color:var(--sub)">· ${verdictLabel}${
        outcome.priceAtRender !== null ? html` (最新价 ${outcome.priceAtRender})` : trustedHtml("")
      }</span>`
    : trustedHtml("");
  return html`<div class="alert"><time class="mono">${entry.createdAt}</time><span>${entry.note} <span style="color:var(--sub)">· ${entry.source}</span>${verdictHtml}</span></div>`;
}

function renderHitRateLine(hitRate: ReturnType<typeof computeThesisOutcome>["hitRate"]): Html {
  if (hitRate.sample === "insufficient") {
    return html`<p style="font-size:12px;color:var(--sub);margin-top:4px">样本不足（已判断 ${hitRate.n} 次${
      hitRate.reason ? html`，${hitRate.reason}` : trustedHtml("")
    }）</p>`;
  }
  return html`<p style="font-size:12px;color:var(--sub);margin-top:4px">命中率 ${(hitRate.hitFraction * 100).toFixed(0)}%（${hitRate.hits} 命中 / ${hitRate.total} 共判断，样本 ${hitRate.n} 次）</p>`;
}

function renderThesisHistoryTimeline(
  history: ThesisHistoryRow[],
  outcomeByJudgmentId: Map<string, ThesisOutcomeJudgmentResult>
): Html {
  if (history.length === 0) {
    return html`<p style="font-size:12px;color:var(--sub);margin-top:6px">暂无判断历史</p>`;
  }
  const rows = joinHtml(history.map((entry) => renderJudgmentRow(entry, outcomeByJudgmentId.get(entry.id))));
  return html`<div style="margin-top:6px">${rows}</div>`;
}

function renderMyThesisCard(
  thesis: ThesisEvidenceRow,
  history: ThesisHistoryRow[],
  latestPrice: number | null
): Html {
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

  const outcome = computeThesisOutcome({
    thesis: { direction: thesis.direction, targetLow: thesis.targetLow, targetHigh: thesis.targetHigh, invalidationPrice: thesis.invalidationPrice },
    judgments: history.map((entry) => ({ id: entry.id })),
    latestPrice
  });
  const outcomeByJudgmentId = new Map(outcome.perJudgment.map((row) => [row.judgmentId, row]));

  return html`<div class="disc" style="margin-bottom:12px;padding-bottom:10px;border-bottom:1px dashed var(--line)">
    <b class="mono">${thesis.symbol}</b>
    <span class="${directionClass}" style="margin-left:6px;font-weight:600">${directionLabel}</span>
    <span class="pill" style="margin-left:6px;background:var(--accent-soft);color:var(--accent)">${visibilityLabel}</span>
    <div style="margin-top:4px">${range}${invalidation}</div>
    <div style="display:flex;gap:16px;margin-top:8px">
      <div style="flex:1"><div style="font-size:12px;color:var(--sub)">看多依据</div><ul style="margin:4px 0 0;padding-left:16px">${renderEvidencePoints(thesis.bullPoints)}</ul></div>
      <div style="flex:1"><div style="font-size:12px;color:var(--sub)">看空依据</div><ul style="margin:4px 0 0;padding-left:16px">${renderEvidencePoints(thesis.bearPoints)}</ul></div>
    </div>
    ${renderThesisHistoryTimeline(history, outcomeByJudgmentId)}
    ${history.length > 0 ? renderHitRateLine(outcome.hitRate) : trustedHtml("")}
  </div>`;
}

function renderThesesSubsection(theses: ThesisEvidenceRow[], historyByThesisId: Map<string, ThesisHistoryRow[]>, priceBySymbol: Map<string, number | null>): Html {
  const body =
    theses.length > 0
      ? joinHtml(
          theses.map((thesis) =>
            renderMyThesisCard(thesis, historyByThesisId.get(thesis.id) ?? [], priceBySymbol.get(thesis.symbol) ?? null)
          )
        )
      : html`<p style="font-size:13px;color:var(--sub)">暂无论点</p>`;
  return html`<div>
    <h3 style="font-size:13px;color:var(--sub);margin:0 0 6px">论点</h3>
    ${body}
  </div>`;
}

function renderMyStrategySection(
  cards: StrategyCardRow[],
  theses: ThesisEvidenceRow[],
  historyByThesisId: Map<string, ThesisHistoryRow[]>,
  priceBySymbol: Map<string, number | null>
): Html {
  return html`<section class="card w2 dt-w4">
    <h2>我的策略卡与论点</h2>
    ${renderStrategyCardsSubsection(cards)}
    ${renderThesesSubsection(theses, historyByThesisId, priceBySymbol)}
  </section>`;
}

// ---------------------------------------------------------------------------
// ③ 圈子公开区
// ---------------------------------------------------------------------------

function renderCircleThesisRow(thesis: ThesisEvidenceRow): Html {
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

function renderCircleCardRow(card: StrategyCardRow): Html {
  const statusLabel = CARD_STATUS_LABELS[card.status] ?? card.status;
  return html`<div class="disc">
    <b>${card.name}</b>
    <span class="pill" style="margin-left:6px;background:var(--accent-soft);color:var(--accent)">${statusLabel}</span>
  </div>`;
}

interface CircleGroup {
  ownerId: string;
  ownerDisplayName: string;
  theses: ThesisEvidenceRow[];
  cards: StrategyCardRow[];
}

function buildCircleGroups(theses: ThesisEvidenceRow[], cards: StrategyCardRow[]): CircleGroup[] {
  const order: string[] = [];
  const byOwner = new Map<string, CircleGroup>();
  const ensure = (ownerId: string, ownerDisplayName: string): CircleGroup => {
    let group = byOwner.get(ownerId);
    if (!group) {
      group = { ownerId, ownerDisplayName, theses: [], cards: [] };
      byOwner.set(ownerId, group);
      order.push(ownerId);
    }
    return group;
  };
  for (const thesis of theses) {
    ensure(thesis.ownerId, thesis.ownerDisplayName).theses.push(thesis);
  }
  for (const card of cards) {
    ensure(card.ownerId, card.ownerDisplayName).cards.push(card);
  }
  return order.map((ownerId) => byOwner.get(ownerId) as CircleGroup);
}

function renderCircleGroup(group: CircleGroup): Html {
  return html`<div style="margin-bottom:10px">
    <a href="/member/${group.ownerId}" style="color:var(--accent);font-size:13px;font-weight:600">${group.ownerDisplayName}</a>
    <div style="margin-top:4px">${joinHtml(group.cards.map(renderCircleCardRow))}${joinHtml(group.theses.map(renderCircleThesisRow))}</div>
  </div>`;
}

function renderCirclePublicSection(groups: CircleGroup[]): Html {
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
  const complianceStatsByRuleId = new Map<string, ComplianceStats>();
  for (const rule of disciplineRules) {
    complianceStatsByRuleId.set(rule.id, computeComplianceStats(deps.db, member.id, rule.id, now));
  }

  const ownCards = loadStrategyCardsForOwner(deps.db, member.id);
  const ownTheses = loadOwnTheses(deps.db, member.id);
  const historyByThesisId = new Map<string, ThesisHistoryRow[]>();
  const priceBySymbol = new Map<string, number | null>();
  for (const thesis of ownTheses) {
    historyByThesisId.set(thesis.id, loadThesisHistory(deps.db, thesis.id));
    if (!priceBySymbol.has(thesis.symbol)) {
      priceBySymbol.set(thesis.symbol, loadLatestPriceForSymbol(deps.db, thesis.symbol));
    }
  }

  const circleTheses = loadCirclePublicTheses(deps.db, member.id);
  const circleCards = loadPublicStrategyCards(deps.db, member.id);
  const circleGroups = buildCircleGroups(circleTheses, circleCards);

  const bodyHtml = html`<div class="bento">${renderDisciplineSection(disciplineRules, complianceStatsByRuleId)}</div>
    <div class="bento" style="margin-top:10px">${renderMyStrategySection(ownCards, ownTheses, historyByThesisId, priceBySymbol)}</div>
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
