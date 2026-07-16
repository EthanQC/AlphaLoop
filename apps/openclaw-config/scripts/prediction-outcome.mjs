// Phase 9 Task 1 (2026-07-16 plan, review flywheel): 系统级预测复盘's outcome
// backfill for `analysis_predictions` (public, no owner_id - see that
// table's v1 DDL, packages/shared-types/src/database.ts, and
// conclusion-box.mjs's own header comment: "outcome 的 hit|miss|invalidated
// 枚举是留给 P9 的"). This module is the deterministic backfill P9 reserves
// that enum for.
//
// Kept as a zero-dependency, pure/mostly-pure module - conclusion/parsing
// logic has NO node: imports and NO project imports (same portability
// discipline conclusion-box.mjs and thesis-outcome.mjs already declare for
// themselves); only `fillPredictionOutcomes` below touches a `db` handle,
// and even that takes it as a plain constructor-free argument, not an
// import.
//
// ---------------------------------------------------------------------------
// Why this is a DIFFERENT shape of problem than thesis-outcome.mjs
// ---------------------------------------------------------------------------
// thesis-outcome.mjs's computeThesisOutcome works from a thesis's own
// STRUCTURED numeric levels (target_low/target_high/invalidation_price -
// real columns on `theses`). analysis_predictions has no such columns: Phase
// 5 Task 2's persistPredictionsForRecords (stock-analysis.mjs) writes only
// `conclusion` (free Chinese prose, box.coreConclusion), `confidence`,
// `review_trigger` (free Chinese prose, box.reviewTrigger) and
// `review_date` - the numeric value-range conclusion-box.mjs's own
// parseConclusionBox extracts from the SAME rendered box is discarded
// before that INSERT and never reaches this table. So this module has
// exactly ONE numeric anchor available per prediction: a threshold PARSED
// OUT of review_trigger's free text - there is no stored target/entry price
// to compare against, and this module never invents one.
//
// **This module is NOT an AI/LLM feature.** Every outcome below is a
// deterministic keyword-match + arithmetic comparison - no model call, no
// judgment call, no text generation - the same "documented, reproducible
// arithmetic, on purpose" discipline thesis-outcome.mjs declares for itself,
// per this phase's Global Constraint: "无历史时点价...缺该日价 →
// outcome=pending...绝不编造".
//
// ---------------------------------------------------------------------------
// Direction ('bull' | 'bear' | null) - parsed from `prediction.conclusion`
// ---------------------------------------------------------------------------
// Two independent keyword lists (checked separately, case-insensitive so an
// ascii "bull"/"bear" written in either case still matches):
//   bull: 看多 看涨 偏多 偏上行 上行 bull
//   bear: 看空 看跌 偏空 偏回撤 回撤 下行 bear
// (The 偏上行/偏回撤 pair is stock-analysis.mjs's OWN computeCoreConclusion
// vocabulary - see that function's header comment - included here so this
// module reads the codebase's real production text, not just a hypothetical
// 看多/看空 vocabulary.)
// If BOTH lists match (ambiguous/contradictory text) or NEITHER matches,
// direction is null - never guessed from anything else.
//
// ---------------------------------------------------------------------------
// Invalidation trigger ({operator: 'below'|'above', threshold: number} |
// null) - parsed from `prediction.reviewTrigger`
// ---------------------------------------------------------------------------
// review_trigger is ALSO free Chinese prose (stock-analysis.mjs's
// computeReviewTrigger emits e.g. "若价格跌破支撑位 95.00 美元，或基本面/新闻面
// 出现方向性反转，需重新评估当前结论"). The first "breaks below" keyword
// (跌破/跌穿/下破/低于) followed within a short window by a number is read as
// a 'below' threshold; a "breaks above" keyword (涨破/突破/上破/高于)
// similarly reads an 'above' threshold. Neither keyword+number pair found ->
// null - never guessed. (If, implausibly, BOTH patterns match the same
// string, whichever occurs FIRST in the text wins - never a fabricated
// "the" trigger when the text itself is ambiguous.)
//
// ---------------------------------------------------------------------------
// computePredictionOutcome({prediction, priceAtReview, now}) -> outcome
// ---------------------------------------------------------------------------
// `prediction` is the CAMELCASE shape a caller maps an analysis_predictions
// row into - {conclusion, reviewTrigger, reviewDate} - decoupled from the
// snake_case DB row the same way computeThesisOutcome's `thesis` parameter
// is decoupled from the raw `theses` row. `now` is an injectable clock
// (ISO-8601 string or Date-parseable value, defaulting to the real wall
// clock only when omitted) - fillPredictionOutcomes below always supplies
// it explicitly, so a single backfill run grades every row against the SAME
// instant.
//
// 'pending' (never guessed past this point - matches this phase's "缺该日价
// →outcome=pending...绝不编造" constraint):
//   - priceAtReview is null/undefined/not a finite number
//   - reviewDate is missing, not a plain 'YYYY-MM-DD' string, or is
//     STRICTLY AFTER `now`'s calendar date (lexicographic compare - both
//     sides share the same fixed-width format, the exact convention
//     usEasternTradingDayUtcRange's own doc comment in database.ts already
//     documents for date-label strings)
//   - reviewTrigger has no parseable (operator, threshold) pair
//   - a trigger WAS parsed but direction is null AND the trigger was NOT
//     breached (a QUIET, undirected trigger tells us nothing to grade - see
//     'invalidated' below for the breached/undirected case, which IS gradable)
//
// Otherwise, let `breached` = priceAtReview crossed the parsed threshold in
// the parsed operator's direction (<= for 'below', >= for 'above'). Full
// truth table (direction x operator x breached):
//
//   direction | operator | breached | outcome       | reading
//   ----------|----------|----------|---------------|------------------------
//   null      | either   | yes      | invalidated   | trigger fired, no direction to grade hit/miss against
//   null      | either   | no       | pending        | (see above)
//   bull      | below    | yes      | invalidated   | bull's own downside stop got hit
//   bull      | below    | no       | hit           | thesis held, stop never hit
//   bear      | above    | yes      | invalidated   | bear's own upside stop got hit
//   bear      | above    | no       | hit           | thesis held, stop never hit
//   bull      | above    | yes      | hit           | trigger describes the SAME upward move bull predicted, and it happened
//   bull      | above    | no       | miss          | predicted upward move never happened by review_date
//   bear      | below    | yes      | hit           | trigger describes the SAME downward move bear predicted, and it happened
//   bear      | below    | no       | miss          | predicted downward move never happened by review_date

const BULL_KEYWORDS = ["看多", "看涨", "偏多", "偏上行", "上行", "bull"];
const BEAR_KEYWORDS = ["看空", "看跌", "偏空", "偏回撤", "回撤", "下行", "bear"];

// "Breaks below" / "breaks above" keyword -> number, tolerating a short run
// of non-digit filler in between (e.g. "支撑位 " between the keyword and the
// number itself, as stock-analysis.mjs's computeReviewTrigger emits).
const BELOW_PATTERN = /(?:跌破|跌穿|下破|低于)[^\d]{0,12}(\d+(?:\.\d+)?)/u;
const ABOVE_PATTERN = /(?:涨破|突破|上破|高于)[^\d]{0,12}(\d+(?:\.\d+)?)/u;

function textIncludesAny(text, keywords) {
  const lower = String(text ?? "").toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

// -> 'bull' | 'bear' | null. null on either "neither keyword list matched"
// or "both matched" (ambiguous/contradictory text) - never guessed.
function parseDirection(conclusion) {
  const isBull = textIncludesAny(conclusion, BULL_KEYWORDS);
  const isBear = textIncludesAny(conclusion, BEAR_KEYWORDS);
  if (isBull && !isBear) {
    return "bull";
  }
  if (isBear && !isBull) {
    return "bear";
  }
  return null;
}

// -> {operator: 'below'|'above', threshold: number} | null.
function parseInvalidationTrigger(reviewTrigger) {
  const text = String(reviewTrigger ?? "");
  const belowMatch = BELOW_PATTERN.exec(text);
  const aboveMatch = ABOVE_PATTERN.exec(text);

  let chosen = null;
  if (belowMatch && aboveMatch) {
    chosen = belowMatch.index <= aboveMatch.index
      ? { operator: "below", raw: belowMatch[1] }
      : { operator: "above", raw: aboveMatch[1] };
  } else if (belowMatch) {
    chosen = { operator: "below", raw: belowMatch[1] };
  } else if (aboveMatch) {
    chosen = { operator: "above", raw: aboveMatch[1] };
  }

  if (!chosen) {
    return null;
  }
  const threshold = Number(chosen.raw);
  if (!Number.isFinite(threshold)) {
    return null; // defensive - the regex only captures digits/'.', should always parse
  }
  return { operator: chosen.operator, threshold };
}

const REVIEW_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Whether `reviewDate` ('YYYY-MM-DD') is today or earlier relative to `now`
// (any ISO-8601-ish value `new Date()` or a plain 'YYYY-MM-DD' prefix can be
// sliced from - fillPredictionOutcomes always passes its own `now` through
// unchanged). Lexicographic compare of the two fixed-width date-label
// strings - same convention usEasternTradingDayUtcRange's own doc comment in
// database.ts documents for this exact string shape.
function isReviewDateDueBy(reviewDate, now) {
  if (typeof reviewDate !== "string" || !REVIEW_DATE_PATTERN.test(reviewDate)) {
    return false; // missing/malformed (e.g. computeReviewDate's own "待确认" fallback) - never guessed
  }
  const today = String(now ?? new Date().toISOString()).slice(0, 10);
  return reviewDate <= today;
}

/**
 * @param {{
 *   prediction: {conclusion: string, reviewTrigger?: string|null, reviewDate?: string|null},
 *   priceAtReview: number|null|undefined,
 *   now?: string
 * }} input
 * @returns {'hit'|'miss'|'invalidated'|'pending'}
 */
export function computePredictionOutcome({ prediction, priceAtReview, now } = {}) {
  const price = Number(priceAtReview);
  if (priceAtReview === null || priceAtReview === undefined || !Number.isFinite(price)) {
    return "pending";
  }
  if (!isReviewDateDueBy(prediction?.reviewDate, now)) {
    return "pending";
  }

  const trigger = parseInvalidationTrigger(prediction?.reviewTrigger);
  if (!trigger) {
    return "pending"; // no parseable numeric anchor at all - never fabricated
  }

  const direction = parseDirection(prediction?.conclusion);
  const breached = trigger.operator === "below" ? price <= trigger.threshold : price >= trigger.threshold;

  if (direction === null) {
    return breached ? "invalidated" : "pending";
  }

  const isNaturalStop =
    (direction === "bull" && trigger.operator === "below") || (direction === "bear" && trigger.operator === "above");

  if (isNaturalStop) {
    return breached ? "invalidated" : "hit";
  }

  // The only remaining case: the mismatched pairing (bull+above / bear+below)
  // - review_trigger describes the SAME-direction move the conclusion itself
  // predicted, not a stop-loss.
  return breached ? "hit" : "miss";
}

// The one enum this task's Global Constraint app-layer-validates
// ("应用层枚举 hit|miss|invalidated|pending 校验") for WRITES specifically -
// 'pending' is deliberately excluded: a pending row is left NULL (never
// written) so a later backfill run can pick it up once a price/date becomes
// available, per fillPredictionOutcomes below. Exported (not just used
// internally) so a future decision-review write path (proposals.outcome -
// see the module-level note near fillProposalOutcome below) can reuse this
// SAME guard rather than re-declaring an equivalent one.
export const WRITABLE_PREDICTION_OUTCOMES = new Set(["hit", "miss", "invalidated"]);

export function assertWritableOutcome(outcome) {
  if (!WRITABLE_PREDICTION_OUTCOMES.has(outcome)) {
    throw new Error(
      `Invalid outcome "${outcome}": must be one of ${[...WRITABLE_PREDICTION_OUTCOMES].join(", ")} ` +
      `('pending' rows are left NULL, never written - see computePredictionOutcome).`
    );
  }
}

// Iterates every analysis_predictions row that is DUE for grading (outcome
// still NULL, review_date already <= today) and, for each, asks
// `priceReader(symbol, reviewDate)` for that day's price - a caller-injected
// function so this stays testable without a real stock_facts-backed db (the
// production wiring is `(symbol, day) => getStockFacts(db, day,
// symbol)['quote.last']?.valueNum ?? null`, per stock-facts-store.mjs's
// getStockFacts). A row whose price comes back null/undefined (no
// stock_facts snapshot for that exact trading day - the Global Constraint's
// "无历史时点价" gap) computes to 'pending' via computePredictionOutcome and
// is left untouched - NOT written as NULL again, just skipped - so a LATER
// run (once a price becomes available) can still pick it up.
//
// @param {import('node:sqlite').DatabaseSync} db
// @param {{now?: string, priceReader: (symbol: string, reviewDate: string) => number|null|undefined}} options
// @returns {{filled: number, pending: number}}
export function fillPredictionOutcomes(db, { now, priceReader } = {}) {
  const nowValue = now ?? new Date().toISOString();
  const today = String(nowValue).slice(0, 10);

  const rows = db
    .prepare(`
      SELECT id, symbol, conclusion, review_trigger, review_date
      FROM analysis_predictions
      WHERE outcome IS NULL AND review_date IS NOT NULL AND review_date <= ?
    `)
    .all(today);

  const update = db.prepare(`UPDATE analysis_predictions SET outcome = ? WHERE id = ?`);

  let filled = 0;
  let pending = 0;

  for (const row of rows) {
    const priceAtReview = priceReader(String(row.symbol), String(row.review_date));
    const outcome = computePredictionOutcome({
      prediction: {
        conclusion: row.conclusion,
        reviewTrigger: row.review_trigger,
        reviewDate: row.review_date
      },
      priceAtReview,
      now: nowValue
    });

    if (outcome === "pending") {
      pending += 1;
      continue;
    }

    assertWritableOutcome(outcome);
    update.run(outcome, row.id);
    filled += 1;
  }

  return { filled, pending };
}

// proposals.outcome ALREADY carries a DIFFERENT, pre-existing meaning (see
// ProposalRepository.markFailed in packages/shared-types/src/database.ts: a
// free-text failure reason, e.g. "broker executor unreachable" - NOT this
// module's hit/miss/invalidated vocabulary). This task's Global Constraint
// only freezes DDL ("analysis_predictions/proposals 的 outcome 回填不改
// DDL") - it does not itself redefine what the EXISTING proposals.outcome
// column means, and computing a real decision-review verdict (提案收益 vs
// 买入持有基准 - "被拒提案简化口径") is explicitly P9 Task 2's concern, not
// this task's ("keep minimal, focus on predictions" per this task's own
// brief). No fillProposalOutcome is implemented here - Task 2's engine
// should reuse WRITABLE_PREDICTION_OUTCOMES/assertWritableOutcome above
// (same closed enum, same app-layer guard) once it owns that computation,
// rather than this task guessing at a shape Task 2 hasn't designed yet.
