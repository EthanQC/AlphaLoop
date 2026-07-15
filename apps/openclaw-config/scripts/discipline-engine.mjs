// 纪律引擎 (Phase 6 Task 2, 2026-07-15 plan): evaluates one owner's ENABLED
// `discipline_rules` (schema v3, packages/shared-types/src/database.ts)
// against a draft order, BEFORE a proposal is ever written to the
// `proposals` table - Task 3's proposal-creation flow calls this after
// `assertProposalAllowed` (circuit-breaker.mjs) and rejects (never writes a
// row) when `hardViolations` is non-empty, per the plan's Global Constraint
// ("纪律语义": hard 违反 → 提案不生成；proposal_check → 逐条 ✓/✗ 上卡；
// self → 仅提示行).
//
// Rule-text parsing is TABLE-DRIVEN and DELIBERATELY narrow (v1 recognizes
// exactly two structured patterns below). This module's one invariant,
// repeated at every branch: a rule this engine cannot actually evaluate must
// NEVER report `pass: true` (that would be a silent, fabricated pass) and
// must NEVER be allowed to hard-block (an unrecognized-format row is
// downgraded to `enforcement: 'self'` in the report regardless of what the
// row's own `enforcement` column says - a parser gap or a rule authored in
// free prose must not brick every future proposal). Both of those are
// `pass: null` - the report's "?" state (see plan: "report includes ALL
// enabled rules (✓/✗/? for card rendering)").
//
// @typedef {{
//   symbol: string, side: 'buy'|'sell', quantity: number, limitPrice?: number,
//   budgetImpactPct?: number,   // this order's OWN contribution to exposure%
//   currentExposurePct?: number // pre-trade exposure%, caller-computed
// }} DraftOrder

import { currentUsEasternTradingDay, currentUsEasternTradingWeek } from "./trading-schedule.mjs";
import { getStockFacts } from "./stock-facts-store.mjs";

// ---------------------------------------------------------------------------
// Rule parsers (table-driven, extensible: add a new {pattern, evaluate} entry
// to RULE_PARSERS for a new structured rule-text family; anything matching no
// entry falls through to the unrecognized-format branch in evaluateDiscipline).
// ---------------------------------------------------------------------------

// e.g. "仓位≤30%" / "仓位 <= 30%" / "仓位=30%".
const POSITION_CAP_PATTERN = /仓位\s*[≤<=]+\s*(\d+(?:\.\d+)?)%/;
// e.g. "财报周不买入" / "财报周不加仓".
const EARNINGS_WEEK_PATTERN = /财报周不(买入|加仓)/;

// fact_key convention this rule looks for. As of Phase 6 Task 2,
// report-facts.mjs's buildStockFacts writes NO earnings-date fact at all
// (only quote./valuation./history./options./news./institutional. families -
// see that module) - this lookup is therefore EXPECTED to come back empty
// for every symbol today. That is not a bug: it is the documented
// "无法判定：缺少财报日数据" path below, which a future phase resolves simply
// by starting to populate this key (no discipline-engine change needed).
const EARNINGS_DATE_FACT_KEY = "earnings.nextDate";

function evaluatePositionCapRule(match, draft) {
  const capPct = Number(match[1]);
  const current = draft?.currentExposurePct;
  const impact = draft?.budgetImpactPct;

  if (!Number.isFinite(current) || !Number.isFinite(impact)) {
    return {
      pass: null,
      detail: `无法判定：缺少当前仓位或预算影响数据，无法核对『仓位 ≤${capPct}%』`
    };
  }

  const projectedPct = current + impact;
  const projectedText = projectedPct.toFixed(2);

  if (projectedPct > capPct) {
    return { pass: false, detail: `本次成交后预计仓位 ${projectedText}%，超过上限 ${capPct}%` };
  }
  return { pass: true, detail: `本次成交后预计仓位 ${projectedText}%，未超过上限 ${capPct}%` };
}

function evaluateEarningsWeekRule(match, draft, ctx) {
  const action = match[1]; // '买入' or '加仓'

  // The rule only restrains BUYING (opening or adding to a position) -
  // a sell is never what "不买入/不加仓" is guarding against.
  if (draft?.side !== "buy") {
    return { pass: true, detail: `本次为卖出方向，『财报周不${action}』规则不适用` };
  }

  const tradingDay = currentUsEasternTradingDay(ctx.now);
  const facts = getStockFacts(ctx.db, tradingDay, draft.symbol);
  const earningsFact = facts[EARNINGS_DATE_FACT_KEY];
  const earningsDate = earningsFact && typeof earningsFact.valueText === "string" ? earningsFact.valueText : null;

  // Missing OR malformed fact data - NEVER silently treated as "not earnings
  // week" (that would be a silent pass on a hard-enforcement rule).
  if (!earningsDate || !/^\d{4}-\d{2}-\d{2}$/.test(earningsDate)) {
    return { pass: null, detail: "无法判定：缺少财报日数据" };
  }

  const { mondayDateLabel, fridayDateLabel } = currentUsEasternTradingWeek(ctx.now);
  const inEarningsWeek = earningsDate >= mondayDateLabel && earningsDate <= fridayDateLabel;

  if (inEarningsWeek) {
    return {
      pass: false,
      detail: `财报日 ${earningsDate} 落在本交易周（${mondayDateLabel}~${fridayDateLabel}）内，命中『财报周不${action}』`
    };
  }
  return {
    pass: true,
    detail: `财报日 ${earningsDate} 不在本交易周（${mondayDateLabel}~${fridayDateLabel}）内`
  };
}

const RULE_PARSERS = [
  { pattern: POSITION_CAP_PATTERN, evaluate: evaluatePositionCapRule },
  { pattern: EARNINGS_WEEK_PATTERN, evaluate: evaluateEarningsWeekRule }
];

// Returns `null` when no parser recognizes `ruleText` - the caller
// (evaluateDiscipline) is what turns that into the "unrecognized format"
// self/pass:null report line, not this function.
function evaluateRuleText(ruleText, draft, ctx) {
  for (const parser of RULE_PARSERS) {
    const match = parser.pattern.exec(ruleText);
    if (match) {
      return parser.evaluate(match, draft, ctx);
    }
  }
  return null;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} ownerId
 * @param {DraftOrder} draft
 * @param {Date} [now] Defaults to `new Date()` - only ever overridden by
 *   tests (the 财报周 rule needs "now" to derive the current trading day/week;
 *   real callers, per the plan's binding 3-arg signature, never pass this).
 * @returns {{
 *   hardViolations: Array<{ruleId: string, ruleText: string, detail: string}>,
 *   report: Array<{ruleId: string, ruleText: string, enforcement: 'hard'|'proposal_check'|'self', pass: boolean|null, detail: string}>
 * }}
 */
export function evaluateDiscipline(db, ownerId, draft, now = new Date()) {
  const rows = db
    .prepare(`
      SELECT id, rule_text, enforcement
      FROM discipline_rules
      WHERE owner_id = ? AND enabled = 1
      ORDER BY created_at ASC
    `)
    .all(ownerId);

  const ctx = { db, now };
  const hardViolations = [];
  const report = [];

  for (const row of rows) {
    const ruleId = String(row.id);
    const ruleText = String(row.rule_text);
    const storedEnforcement = String(row.enforcement);

    const evaluated = evaluateRuleText(ruleText, draft, ctx);
    // Unrecognized format: forced to 'self' regardless of the row's stored
    // enforcement - see module header for why this must never be 'hard'.
    const enforcement = evaluated ? storedEnforcement : "self";
    const pass = evaluated ? evaluated.pass : null;
    const detail = evaluated ? evaluated.detail : "规则格式未识别，仅提示";

    report.push({ ruleId, ruleText, enforcement, pass, detail });

    if (enforcement === "hard" && pass === false) {
      hardViolations.push({ ruleId, ruleText, detail });
    }
  }

  return { hardViolations, report };
}
