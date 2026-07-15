// Phase 7 Task 3 (2026-07-15 plan): 事后走势回算 (post-hoc price-outcome
// backtest) for a thesis's judgment history. Deliberately a PURE,
// zero-IO, zero-dependency module (no node: imports, no project imports,
// nothing but arithmetic) - exactly the same "portable, no side effects"
// discipline conclusion-box.mjs documents for itself, for the same reason:
// this is imported both by strategy.mjs's CLI (Task 3, this task) and, per
// the plan's Task 5, by the platform-app rendering layer.
//
// **This module is NOT an AI/LLM feature.** Every verdict below is a
// deterministic comparison between a thesis's own stored numeric levels
// (target_low/target_high/invalidation_price) and a single caller-supplied
// "latest price" snapshot. There is no model call, no judgment call, no
// text generation anywhere in this file - it is documented, reproducible
// arithmetic, on purpose, per the plan's explicit "事后走势：确定性代码回算
// （价格 vs 目标/失效线），样本<10 标「样本不足」，非 AI 宣称" instruction.
//
// Why every judgment in one call gets the SAME verdict/pct numbers: this
// backtest does NOT reconstruct a price history per judgment (no historical
// price is stored per thesis_history row anywhere in this codebase's
// schema) - it answers ONE question, "given the thesis's target/invalidation
// levels and TODAY's latest price, where does this thesis currently stand?",
// and stamps that single answer onto every judgment row so a rendered
// timeline can show "as of today, this thesis is trending toward X" next to
// each of the owner's past notes. `judgmentId` is the only thing that
// varies per output row; `priceAtRender`/`vsTargetPct`/`vsInvalidationPct`/
// `verdict` are shared, by design.
//
// ---------------------------------------------------------------------------
// Verdict rules (direction-aware), enum: 'toward_target' | 'toward_invalidation'
//   | 'neutral' | 'insufficient' | 'no_price'
// ---------------------------------------------------------------------------
//
// - 'no_price': latestPrice is null/undefined (or not a finite number) -
//   NEVER guessed. Overrides every other rule; ALL judgments get this
//   verdict and priceAtRender=null, vsTargetPct=null, vsInvalidationPct=null.
// - 'insufficient': the thesis is missing the numeric level(s) this
//   direction needs to even ask the question (e.g. a bull thesis with no
//   target_high, or no invalidation_price; a neutral thesis with no
//   target_low/target_high range) - or the thesis has an unrecognized
//   direction value. Never a guess at a missing number.
// - bull: needs target_high (the upside aim) AND invalidation_price (the
//   downside stop). Verdict is whichever of the two the latest price sits
//   CLOSER to (ties favor 'toward_target' - the price sitting exactly at
//   the midpoint is read as "not yet broken down", the more optimistic of
//   the two possible reads, not an arbitrary pick): 'toward_target' if
//   price has moved up toward/past target_high, 'toward_invalidation' if it
//   has moved down toward/past invalidation_price.
// - bear: inverted - needs target_low (the downside aim, since a bear
//   thesis wants the price to FALL) AND invalidation_price (the upside stop,
//   since a bear thesis breaks if the price rises past it). Same
//   closer-of-the-two-levels rule, mirrored.
// - neutral: needs target_low AND target_high (the expected trading range -
//   a neutral/range thesis has no single directional aim). 'neutral' if the
//   latest price sits within [target_low, target_high] inclusive (spec:
//   "within range = neutral"); 'toward_invalidation' if the price has broken
//   OUTSIDE that range in either direction, since for a range thesis
//   "leaving the range" IS the failure mode - there is no separate
//   'toward_target' state distinct from "still inside the range".
//
// vsTargetPct / vsInvalidationPct: percent distance of the latest price from
// the direction's relevant reference level - ((latestPrice - ref) / ref) *
// 100, rounded to 2 decimals. Positive means the latest price sits ABOVE
// that reference level, negative means below. `null` whenever the relevant
// reference level itself is not set on the thesis (bull/bear's target
// reference is target_high/target_low respectively; neutral has no single
// target reference, only the range, so vsTargetPct is always null for a
// neutral thesis - vsInvalidationPct still uses invalidation_price if the
// thesis happens to have one set, even though direction is neutral).
//
// ---------------------------------------------------------------------------
// Overall hit-rate (computeThesisOutcome's `hitRate` field)
// ---------------------------------------------------------------------------
//
// Per the plan: "判断数 < 10 → 样本不足". `n` is the number of judgment rows
// handed in (NOT the number of directional verdicts - a thesis judged 12
// times but currently 'no_price'/'insufficient' still reports its true n,
// with the hit fraction itself degrading separately, see below).
//
//   n < 10                                  -> { sample: 'insufficient', n }
//   n >= 10, but no judgment has a directional
//     ('toward_target'/'toward_invalidation') verdict (e.g. no_price,
//     or the thesis itself is 'insufficient')
//                                            -> { sample: 'insufficient', n,
//                                                 reason: <Chinese, why> }
//   n >= 10 and at least one directional verdict exists
//                                            -> { sample: 'ok', n, hits,
//                                                 total, hitFraction }
//
// hitFraction = hits / total, where hits = count of 'toward_target' rows and
// total = count of 'toward_target' + 'toward_invalidation' rows ('neutral'
// rows are excluded from the denominator - a range thesis currently inside
// its range is neither a hit nor a miss yet).

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function pctFrom(reference, latestPrice) {
  if (!isFiniteNumber(reference)) {
    return null;
  }
  return round2(((latestPrice - reference) / reference) * 100);
}

// Resolves, for ONE thesis, the (targetRef, invalidationRef) pair the
// direction-aware verdict rule above needs, or null if the direction itself
// is not one of the three recognized values. `targetRef`/`invalidationRef`
// individually may still be null (level not set on the thesis) - the
// caller (resolveVerdict) treats either being null as 'insufficient'.
function resolveReferenceLevels(thesis) {
  const targetLow = isFiniteNumber(thesis?.targetLow) ? thesis.targetLow : null;
  const targetHigh = isFiniteNumber(thesis?.targetHigh) ? thesis.targetHigh : null;
  const invalidationPrice = isFiniteNumber(thesis?.invalidationPrice) ? thesis.invalidationPrice : null;

  if (thesis?.direction === "bull") {
    return { targetRef: targetHigh, invalidationRef: invalidationPrice, rangeLow: null, rangeHigh: null };
  }
  if (thesis?.direction === "bear") {
    return { targetRef: targetLow, invalidationRef: invalidationPrice, rangeLow: null, rangeHigh: null };
  }
  if (thesis?.direction === "neutral") {
    return { targetRef: null, invalidationRef: invalidationPrice, rangeLow: targetLow, rangeHigh: targetHigh };
  }
  return null;
}

function resolveVerdict(thesis, latestPrice) {
  const levels = resolveReferenceLevels(thesis);
  if (!levels) {
    return "insufficient"; // unrecognized/missing direction - never guessed
  }

  if (thesis.direction === "neutral") {
    if (levels.rangeLow === null || levels.rangeHigh === null) {
      return "insufficient";
    }
    return latestPrice >= levels.rangeLow && latestPrice <= levels.rangeHigh ? "neutral" : "toward_invalidation";
  }

  // bull / bear: both need a target reference AND an invalidation reference.
  if (levels.targetRef === null || levels.invalidationRef === null) {
    return "insufficient";
  }

  const distToTarget = Math.abs(latestPrice - levels.targetRef);
  const distToInvalidation = Math.abs(latestPrice - levels.invalidationRef);
  return distToTarget <= distToInvalidation ? "toward_target" : "toward_invalidation";
}

/**
 * @param {{
 *   thesis: {direction: 'bull'|'bear'|'neutral', targetLow?: number|null, targetHigh?: number|null, invalidationPrice?: number|null},
 *   judgments: Array<{id: string}>,
 *   latestPrice: number|null|undefined
 * }} input
 * @returns {{
 *   perJudgment: Array<{judgmentId: string, priceAtRender: number|null, vsTargetPct: number|null, vsInvalidationPct: number|null, verdict: string}>,
 *   hitRate: {sample: 'insufficient', n: number, reason?: string} | {sample: 'ok', n: number, hits: number, total: number, hitFraction: number}
 * }}
 */
export function computeThesisOutcome({ thesis, judgments, latestPrice }) {
  const judgmentList = judgments ?? [];
  const hasPrice = isFiniteNumber(latestPrice);

  const levels = hasPrice ? resolveReferenceLevels(thesis) : null;
  const verdict = hasPrice ? resolveVerdict(thesis, latestPrice) : "no_price";
  const vsTargetPct = hasPrice && levels ? pctFrom(levels.targetRef, latestPrice) : null;
  const vsInvalidationPct = hasPrice && levels ? pctFrom(levels.invalidationRef, latestPrice) : null;
  const priceAtRender = hasPrice ? latestPrice : null;

  const perJudgment = judgmentList.map((judgment) => ({
    judgmentId: judgment.id,
    priceAtRender,
    vsTargetPct,
    vsInvalidationPct,
    verdict
  }));

  const n = judgmentList.length;
  let hitRate;
  if (n < 10) {
    hitRate = { sample: "insufficient", n };
  } else {
    const hits = perJudgment.filter((row) => row.verdict === "toward_target").length;
    const misses = perJudgment.filter((row) => row.verdict === "toward_invalidation").length;
    const total = hits + misses;
    if (total === 0) {
      hitRate = {
        sample: "insufficient",
        n,
        reason: "无法计算方向命中率（缺少最新价格，或论点缺少目标价/失效价，无法判断方向）"
      };
    } else {
      hitRate = { sample: "ok", n, hits, total, hitFraction: round2(hits / total) };
    }
  }

  return { perJudgment, hitRate };
}
