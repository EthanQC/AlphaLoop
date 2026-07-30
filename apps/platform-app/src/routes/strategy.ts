/**
 * Strategy page (Task 7, upgraded Phase 7 Task 5 2026-07-15 plan):
 * `GET /strategy`, plus (2026-07-30) the four owner-only tier-change writes
 * `POST /strategy/{theses,cards}/<id>/{promote,demote}` that make §1.7's
 * 「档位随时可调」 reachable from a browser at all - see `renderTierControl` and
 * `handleTierChange` below for why they live here rather than on the
 * bearer-only /api surface. Identity-gated like every route past Task 3.
 *
 * Three sections, in this fixed order (plan Task 7 req §1.7, unchanged by
 * Task 5's rendering upgrade - not to be reshuffled):
 *   ① 我的纪律       - ALL of the viewer's own discipline_rules (enabled AND
 *                      disabled, enabled first) - each with its enforcement
 *                      badge AND a REAL 近30天遵守 statistic
 *                      (computeComplianceStats, data/strategy.ts) - no more
 *                      「统计 P7 上线」placeholder. Empty -> an honest empty state (render/empty-state.ts).
 *   ② 我的策略卡与论点 - the viewer's OWN strategy_cards (every visibility) with
 *                      a status badge (活跃/暂停/退役) and a visibility pill,
 *                      THEN the viewer's OWN theses (every visibility) - the
 *                      one place a member sees their own 'system'-only
 *                      theses/cards rendered back to them - each thesis with
 *                      its bull_points/bear_points evidence double-column,
 *                      target range, invalidation, visibility pill, and its
 *                      append-only thesis_history timeline annotated with
 *                      computeThesisOutcome's deterministic post-hoc verdict.
 *                      Each card and thesis also carries its own one-click tier
 *                      control (设为公开 / 降回系统可用), which is the only
 *                      browser-reachable 档位 control for strategy memory.
 *                      Empty card list / empty thesis list -> honest empty states
 *                      naming what the block would hold and how to fill it
 *                      (2026-07-30; these replaced bare 暂无X strings, which
 *                      themselves had replaced a stale 「策略记忆 P7 上线」).
 *   ③ 圈子公开区     - OTHER active members' `visibility = 'public'` theses
 *                      AND strategy cards ONLY, grouped by member (display
 *                      name links to `/member/<id>`). Empty -> an honest empty state
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

import {
  AuditLogRepository,
  STRATEGY_DEMOTION_NOTICE,
  methodNotAllowed,
  sendJson,
  type Member
} from "@packages/shared-types";

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
import {
  demoteCardVisibilityToSystem,
  demoteThesisVisibilityToSystem,
  getCardById,
  getThesisById,
  promoteCardVisibilityToPublic,
  promoteThesisVisibilityToPublic
} from "../data/strategy-write.js";
import { renderUnauthorizedPage, resolveIdentity } from "../identity.js";
import { renderComplianceLine } from "../render/compliance.js";
import { renderEmptyState, renderInlineEmptyState } from "../render/empty-state.js";
import { formatBeijingShortTime } from "../render/format.js";
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
      : renderEmptyState(
          "你还没有登记任何纪律规则。",
          "纪律是系统能替你硬拦的东西（如「财报周不加仓」「单票不超过 20%」）。在飞书单聊里说一句「记一条纪律：…」即可登记；登记后每条提案都会按它做检查，执行方式会标成 代码强制 / 提案检查 / 自我约束。"
        );
  return html`<section class="card w2 dt-w4">
    <h2>我的纪律</h2>
    ${body}
  </section>`;
}

// ---------------------------------------------------------------------------
// ② 我的策略卡与论点
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 档位控件 (req §1.7「档位随时可调」/ §2.1「一键升档…降档时已生成的历史内容不回收」)
//
// The data layer and the bearer API have had both directions since Task 15, but
// nothing a BROWSER can reach did: /api/theses|cards/:id/{promote,demote} are
// bearer-only by design (api-strategy.ts, and the skill manifest says so out
// loud), and a logged-in member holds a session cookie, not a token. So these
// two-line forms - posting to this module's own /strategy/... write paths - are
// the tier control a member actually has. Rendered ONLY inside the viewer's own
// ② 我的策略卡与论点 section, whose readers are owner-scoped at the SQL level,
// so a form for somebody else's row cannot be rendered in the first place; the
// handler re-checks ownership anyway (resolve row, compare owner, 403).
// ---------------------------------------------------------------------------

function renderTierControl(kind: "theses" | "cards", id: string, visibility: string): Html {
  const promoting = visibility !== "public";
  const action = promoting ? "promote" : "demote";
  const label = promoting ? "设为公开" : "降回系统可用";
  return html`<form method="post" action="/strategy/${kind}/${id}/${action}" style="display:inline">
    <button class="btn" type="submit" style="font-size:12px;padding:2px 8px">${label}</button>
  </form>`;
}

function renderStrategyCardRow(card: StrategyCardRow): Html {
  const statusLabel = CARD_STATUS_LABELS[card.status] ?? card.status;
  const visibilityLabel = VISIBILITY_LABELS[card.visibility] ?? card.visibility;
  const scene = card.scene ? html` <span style="color:var(--sub)">· ${card.scene}</span>` : trustedHtml("");
  return html`<div class="disc">
    <b>${card.name}</b>${scene}
    <div style="margin-top:4px;display:flex;gap:6px;align-items:center">
      <span class="pill" style="background:var(--accent-soft);color:var(--accent)">${statusLabel}</span>
      <span class="pill">${visibilityLabel}</span>
      ${renderTierControl("cards", card.id, card.visibility)}
    </div>
  </div>`;
}

function renderStrategyCardsSubsection(cards: StrategyCardRow[]): Html {
  const body =
    cards.length > 0
      ? joinHtml(cards.map(renderStrategyCardRow))
      : renderEmptyState(
          "你还没有策略卡。",
          "策略卡记的是一套打法（场景 / 进场条件 / 风控 / 离场规则）。在飞书单聊里说一句「记一条策略：…」即可创建；默认「系统可用」档只有你看得见，升到「公开」档才会出现在你的名片上。"
        );
  return html`<div style="margin-bottom:14px">
    <h3 style="font-size:13px;color:var(--sub);margin:0 0 6px">策略卡</h3>
    ${body}
  </div>`;
}

function renderEvidencePoints(points: string[]): Html {
  if (points.length === 0) {
    return renderInlineEmptyState("暂无依据");
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
  // U1: raw ISO instant out of the column -> Beijing wall-clock.
  return html`<div class="alert"><time class="mono" title="${entry.createdAt}">${formatBeijingShortTime(entry.createdAt)}</time><span>${entry.note} <span style="color:var(--sub)">· ${entry.source}</span>${verdictHtml}</span></div>`;
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
    return renderInlineEmptyState("暂无判断历史——每次在飞书里补一句判断都会 append 一行，不可删改");
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
    <span style="margin-left:6px">${renderTierControl("theses", thesis.id, thesis.visibility)}</span>
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
      : renderEmptyState(
          "你还没有记过任何个股论点。",
          "论点卡记的是「看多/看空 + 目标区间 + 失效价 + 依据」，系统会拿它做策略对照并按代码回算事后走势与命中率（样本 <10 会标「样本不足」）。在飞书单聊里说一句「记一条 NVDA 的看多论点，目标 x 到 y，跌破 z 失效」即可创建。"
        );
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
      : renderEmptyState(
          "圈内还没有人公开策略或论点。",
          "只有升到「公开」档的策略卡与论点才会出现在这里并进入对方的名片；「私有」档只在本人的本地工作台，「系统可用」档只有本人能看。"
        );
  return html`<section class="card w2 dt-w4">
    <h2>圈子公开区</h2>
    ${body}
  </section>`;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** The banner a tier change lands on. A DEMOTE carries
 * STRATEGY_DEMOTION_NOTICE - the same sentence the bearer API returns as
 * `notice` and the CLI prints, so the three faces cannot describe the same
 * operation differently. A promote retracts nothing, so it discloses nothing
 * beyond what just happened. */
function renderTierNotice(notice: string): Html | null {
  const text =
    notice === "thesis-demoted" || notice === "card-demoted"
      ? STRATEGY_DEMOTION_NOTICE
      : notice === "thesis-promoted"
        ? "论点已升为「公开」档：圈内成员现在能在你的名片和策略页看到它，并附代码回算的事后走势。"
        : notice === "card-promoted"
          ? "策略卡已升为「公开」档：圈内成员现在能在你的名片和策略页看到它。"
          : null;
  if (!text) {
    return null;
  }
  return html`<section class="card w2 dt-w4" role="status" aria-label="档位变更">
    <p style="font-size:13px;color:var(--ink);margin:0">${text}</p>
  </section>`;
}

function renderStrategyPage(
  res: ServerResponse,
  deps: StrategyRouteDeps,
  member: Member,
  nonce: string,
  notice: string | null
): void {
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

  const noticeCard = notice ? renderTierNotice(notice) : null;

  const bodyHtml = html`${noticeCard ? html`<div class="bento" style="margin-bottom:10px">${noticeCard}</div>` : trustedHtml("")}
    <div class="bento">${renderDisciplineSection(disciplineRules, complianceStatsByRuleId)}</div>
    <div class="bento" style="margin-top:10px">${renderMyStrategySection(ownCards, ownTheses, historyByThesisId, priceBySymbol)}</div>
    <div class="bento" style="margin-top:10px">${renderCirclePublicSection(circleGroups)}</div>`;

  const page = renderPage({
    title: "策略",
    nav: "strategy",
    member: { displayName: member.displayName },
    freshness: "最新",
    // U2: the strategy page shows the viewer's OWN stored records - they have
    // no production time of their own beyond the moment each was written, and
    // each row already carries its own timestamp. A page-level 数据时间 would
    // have to invent one, so this page honestly states none.
    dataAsOf: null,
    degraded: [],
    bodyHtml,
    nonce,
    now
  });
  sendHtml(res, 200, page);
}

// ---------------------------------------------------------------------------
// POST /strategy/theses/<id>/{promote,demote} · /strategy/cards/<id>/{promote,demote}
// ---------------------------------------------------------------------------

const FORM_URLENCODED_CONTENT_TYPE = "application/x-www-form-urlencoded";

/**
 * Flips ONE row's visibility for the resolved identity. Synchronous on purpose:
 * these controls carry no fields (the id is in the path, the direction is the
 * path's last segment), so there is no body to await - `req.resume()` merely
 * drains whatever the browser sent so the connection stays reusable.
 *
 * Gate order is the same one proposal.ts/research.ts/api-strategy.ts use:
 * resolve the row by id FIRST, 404 when it does not exist, 403 when it exists
 * and belongs to somebody else. The owner is never read from the request.
 */
function handleTierChange(
  req: IncomingMessage,
  res: ServerResponse,
  deps: StrategyRouteDeps,
  kind: "theses" | "cards",
  id: string,
  action: "promote" | "demote"
): void {
  req.resume();

  const member = resolveIdentity(req, deps.db);
  if (!member) {
    sendJson(res, 401, { ok: false, error: "未获授权：请先登录" });
    return;
  }

  const row = kind === "theses" ? getThesisById(deps.db, id) : getCardById(deps.db, id);
  if (!row) {
    sendJson(res, 404, { ok: false, error: kind === "theses" ? `未找到论点：${id}` : `未找到策略卡：${id}` });
    return;
  }
  if (row.ownerId !== member.id) {
    sendJson(res, 403, {
      ok: false,
      error: kind === "theses" ? "无权操作：该论点属于其他成员" : "无权操作：该策略卡属于其他成员"
    });
    return;
  }

  if (kind === "theses") {
    if (action === "promote") {
      promoteThesisVisibilityToPublic(deps.db, id);
    } else {
      demoteThesisVisibilityToSystem(deps.db, id);
    }
  } else if (action === "promote") {
    promoteCardVisibilityToPublic(deps.db, id);
  } else {
    demoteCardVisibilityToSystem(deps.db, id);
  }

  const auditAction = `${kind === "theses" ? "thesis" : "card"} ${action}`;
  new AuditLogRepository(deps.db).write("strategy_memory", auditAction, {
    ...(kind === "theses" ? { thesisId: id } : { cardId: id }),
    ownerId: member.id,
    surface: "web"
  });

  const notice = `${kind === "theses" ? "thesis" : "card"}-${action === "promote" ? "promoted" : "demoted"}`;
  const isFormPost = String(req.headers["content-type"] ?? "")
    .toLowerCase()
    .startsWith(FORM_URLENCODED_CONTENT_TYPE);
  if (isFormPost) {
    // 303 -> the browser re-GETs /strategy, where the notice card states what
    // the change did and (for a demote) what it did NOT take back.
    res.writeHead(303, { location: `/strategy?notice=${notice}` });
    res.end();
    return;
  }
  sendJson(res, 200, {
    ok: true,
    ...(action === "demote" ? { notice: STRATEGY_DEMOTION_NOTICE } : {})
  });
}

/**
 * Routes `GET /strategy` and the four tier-change write paths under it. Returns
 * `true` if the request was handled (including the 401/403/404/405 cases),
 * `false` if the path isn't this module's so the caller can keep trying other
 * routes.
 */
export function handleStrategyRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: StrategyRouteDeps,
  nonce: string
): boolean {
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments[0] !== "strategy") {
    return false;
  }

  if (
    segments.length === 4 &&
    (segments[1] === "theses" || segments[1] === "cards") &&
    (segments[3] === "promote" || segments[3] === "demote")
  ) {
    if (req.method !== "POST") {
      methodNotAllowed(res);
      return true;
    }
    handleTierChange(
      req,
      res,
      deps,
      segments[1] as "theses" | "cards",
      segments[2] as string,
      segments[3] as "promote" | "demote"
    );
    return true;
  }

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

  renderStrategyPage(res, deps, member, nonce, url.searchParams.get("notice"));
  return true;
}
