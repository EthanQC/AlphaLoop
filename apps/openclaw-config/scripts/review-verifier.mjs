// Phase 9 Task 3 (2026-07-16 plan, review flywheel): the INDEPENDENT
// verifier. `recomputeReviewMetrics({db, ownerId, period, now})` re-derives
// the SAME headline numbers review-engine.mjs's `buildMonthlyReview` produces
// (predictionReview.selfThesisHitRate, predictionReview.
// systemConfidenceCalibration, decisionReview.executed/rejected,
// disciplineReview.complianceRate/complianceValue, alertQuality) - but this
// file is a DELIBERATE second, independent implementation, not a shared
// mirror of the primary's code.
//
// ***************************************************************************
// THIS IS DELIBERATELY A SECOND, INDEPENDENT IMPLEMENTATION.
// ***************************************************************************
// review-engine.mjs's own header states the plan's architecture decision
// literally: "验证器禁止 import 主引擎的任何指标 helper（reviewer 从原始 SQL 重算），
// gate 断言两者逐值相等". The entire point of Task 3's consistency gate
// (review-consistency.test.ts) is that a BUG in the primary engine's
// arithmetic must be catchable by a SEPARATE piece of code doing the same
// arithmetic a different way - if this file just re-exported or called the
// primary's own functions, a bug shared by both sides would sail through
// undetected and the whole cross-check would be theater. So:
//
//   - This file does NOT import review-engine.mjs, thesis-outcome.mjs,
//     apps/platform-app/src/data/strategy.ts (computeThesisOutcome/
//     computeComplianceStats/loadLatestPriceForSymbol), or any other module
//     that computes a review metric. It talks to `db` directly with its own
//     SQL statements against theses/thesis_history/analysis_predictions/
//     proposals/official_paper_order_lifecycle/discipline_rules/alert_events/
//     stock_facts, and does its own arithmetic on the rows it gets back.
//   - Every formula below (the bull/bear/neutral "closer of two reference
//     levels" verdict rule, the direction-aware entry-vs-exit return
//     percentage, the 30-day discipline compliance tally, the misreport-rate
//     count) is independently reasoned about FROM THE SAME SPEC the primary
//     engine implements, not copied from its source. Same math, different
//     code path - so a correct primary and a correct verifier are
//     GUARANTEED to agree; a wrong number on EITHER side is what makes them
//     disagree, which is exactly the failure review-consistency.test.ts
//     exists to catch.
//   - If you find yourself tempted to `import` something from
//     review-engine.mjs (or one of the modules it delegates to) to avoid
//     re-deriving a formula here, STOP - that import would make this whole
//     module's cross-check vacuous.
//
// Two narrow, deliberate exceptions to "no shared code with the primary",
// both DOCUMENTED, neither one a metric-computation helper:
//   - The Beijing-calendar-month period window (`resolvePeriodWindow` below)
//     and the "QQQ price on the closest prior trading day" NY-Eastern date
//     label (`tradingDayLabel` below) are re-derived HERE with this file's
//     OWN arithmetic (not imported from review-engine.mjs's
//     beijingMonthUtcRange or trading-schedule.mjs's
//     currentUsEasternTradingDay) - both sides must agree on what "July 2026
//     Beijing calendar month" or "which NY trading day" MEANS (that is a
//     shared, spec-fixed convention, not a metric being cross-checked), and
//     re-deriving it independently, rather than importing either helper,
//     keeps this file's import list clean of anything the primary engine
//     itself imports.
//   - MIN_SAMPLE/CONFIDENCE_TIERS/BENCHMARK_SYMBOL/REJECTED_DISCLAIMER below
//     are spec-fixed CONSTANTS (this phase's Global Constraints literally
//     name "样本<10 标样本不足", the three confidence tiers, QQQ as the
//     benchmark, and the fixed disclaimer string) - restating a literal spec
//     constant is not "sharing a helper".

const MIN_SAMPLE = 10;
const CONFIDENCE_TIERS = ["low", "medium", "high"];
const BENCHMARK_SYMBOL = "QQQ";
const REJECTED_DISCLAIMER = "未执行，仅口径参考";
const COMPLIANCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function toNullableNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

// -----------------------------------------------------------------------
// Own Beijing-calendar-month period window (see module header: independently
// re-derived, not imported from review-engine.mjs's beijingMonthUtcRange).
// -----------------------------------------------------------------------

const PERIOD_PATTERN = /^(\d{4})-(\d{2})$/;

function resolvePeriodWindow(period) {
  const match = PERIOD_PATTERN.exec(String(period ?? ""));
  if (!match) {
    throw new Error(`Invalid period "${period}": expected 'YYYY-MM'.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new Error(`Invalid period "${period}": month must be 01-12.`);
  }
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const periodStart = new Date(`${period}-01T00:00:00+08:00`).toISOString();
  const periodEnd = new Date(
    `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+08:00`
  ).toISOString();
  return { periodStart, periodEnd };
}

// -----------------------------------------------------------------------
// Own NY-Eastern calendar date label (see module header: independently
// re-derived via Intl directly, not imported from trading-schedule.mjs's
// currentUsEasternTradingDay - same one-line ICU zone conversion, written
// here from scratch so this file's import list stays clean of anything the
// primary engine itself imports).
// -----------------------------------------------------------------------

function tradingDayLabel(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

// -----------------------------------------------------------------------
// 1(a). predictionReview.selfThesisHitRate - re-tallied from theses +
// thesis_history + stock_facts directly, re-judging each thesis's own
// verdict (closer-of-two-reference-levels rule) with this file's OWN
// arithmetic - NOT by calling computeThesisOutcome.
// -----------------------------------------------------------------------

// Independent re-derivation of thesis-outcome.mjs's verdict rule: bull needs
// (target_high, invalidation_price) and picks whichever the price sits
// CLOSER to (ties favor the target); bear mirrors it with target_low; neutral
// needs (target_low, target_high) and is 'neutral' inside the range,
// 'toward_invalidation' outside it. Any missing required level, or an
// unrecognized direction, is 'insufficient' - never guessed.
function judgeThesisVerdict(thesisRow, latestPrice) {
  const direction = String(thesisRow.direction);
  const targetLow = toNullableNumber(thesisRow.target_low);
  const targetHigh = toNullableNumber(thesisRow.target_high);
  const invalidationPrice = toNullableNumber(thesisRow.invalidation_price);

  if (direction === "bull") {
    if (targetHigh === null || invalidationPrice === null) {
      return "insufficient";
    }
    return Math.abs(latestPrice - targetHigh) <= Math.abs(latestPrice - invalidationPrice)
      ? "toward_target"
      : "toward_invalidation";
  }
  if (direction === "bear") {
    if (targetLow === null || invalidationPrice === null) {
      return "insufficient";
    }
    return Math.abs(latestPrice - targetLow) <= Math.abs(latestPrice - invalidationPrice)
      ? "toward_target"
      : "toward_invalidation";
  }
  if (direction === "neutral") {
    if (targetLow === null || targetHigh === null) {
      return "insufficient";
    }
    return latestPrice >= targetLow && latestPrice <= targetHigh ? "neutral" : "toward_invalidation";
  }
  return "insufficient";
}

function latestQuoteForSymbol(db, symbol) {
  const row = db
    .prepare(`SELECT value_num FROM stock_facts WHERE symbol = ? AND fact_key = 'quote.last' AND value_num IS NOT NULL ORDER BY trading_day DESC LIMIT 1`)
    .get(symbol);
  return row ? Number(row.value_num) : null;
}

function tallySelfThesisHitRate(db, ownerId) {
  const theses = db
    .prepare(`SELECT id, symbol, direction, target_low, target_high, invalidation_price FROM theses WHERE owner_id = ?`)
    .all(ownerId);

  let n = 0;
  let hits = 0;
  let misses = 0;

  for (const thesis of theses) {
    const judgmentCountRow = db.prepare(`SELECT COUNT(*) AS cnt FROM thesis_history WHERE thesis_id = ?`).get(thesis.id);
    const judgmentCount = Number(judgmentCountRow?.cnt ?? 0);
    if (judgmentCount === 0) {
      continue;
    }
    n += judgmentCount;

    const latestPrice = latestQuoteForSymbol(db, String(thesis.symbol));
    if (!isFiniteNumber(latestPrice)) {
      continue; // 'no_price' - counts toward n, never toward hits/misses.
    }

    const verdict = judgeThesisVerdict(thesis, latestPrice);
    if (verdict === "toward_target") {
      hits += judgmentCount;
    } else if (verdict === "toward_invalidation") {
      misses += judgmentCount;
    }
  }

  if (n < MIN_SAMPLE) {
    return { sample: "insufficient", n };
  }
  const total = hits + misses;
  if (total === 0) {
    return {
      sample: "insufficient",
      n,
      reason: "无法计算方向命中率（缺少最新价格，或论点缺少目标价/失效价，无法判断方向）"
    };
  }
  return { sample: "ok", n, hits, total, hitFraction: round2(hits / total) };
}

// -----------------------------------------------------------------------
// 1(b). predictionReview.systemConfidenceCalibration - PUBLIC/system-level,
// re-tallied straight from analysis_predictions.
// -----------------------------------------------------------------------

function tallyConfidenceCalibration(db) {
  const rows = db.prepare(`SELECT confidence, outcome FROM analysis_predictions WHERE outcome IS NOT NULL`).all();

  return CONFIDENCE_TIERS.map((tier) => {
    const tierRows = rows.filter((row) => String(row.confidence) === tier);
    const n = tierRows.length;
    if (n === 0) {
      return { tier, sample: "none", n: 0 };
    }
    if (n < MIN_SAMPLE) {
      return { tier, sample: "insufficient", n };
    }
    const hits = tierRows.filter((row) => String(row.outcome) === "hit").length;
    return { tier, sample: "ok", n, hits, hitFraction: round2(hits / n) };
  });
}

// -----------------------------------------------------------------------
// 2. decisionReview - re-tallied straight from proposals +
// official_paper_order_lifecycle + stock_facts.
// -----------------------------------------------------------------------

function resolveExecutedEntryPrice(db, row) {
  if (row.ticket_id) {
    const lifecycle = db
      .prepare(`SELECT limit_price FROM official_paper_order_lifecycle WHERE ticket_id = ? LIMIT 1`)
      .get(row.ticket_id);
    if (lifecycle && lifecycle.limit_price !== null && lifecycle.limit_price !== undefined) {
      return Number(lifecycle.limit_price);
    }
  }
  return toNullableNumber(row.limit_price);
}

function benchmarkEntryPriceOn(db, createdAtIso) {
  const day = tradingDayLabel(new Date(createdAtIso));
  const row = db
    .prepare(`
      SELECT value_num FROM stock_facts
      WHERE symbol = ? AND fact_key = 'quote.last' AND value_num IS NOT NULL AND trading_day <= ?
      ORDER BY trading_day DESC LIMIT 1
    `)
    .get(BENCHMARK_SYMBOL, day);
  return row ? Number(row.value_num) : null;
}

// Direction-aware percent return: a 'sell' decision wants the price to FALL
// after the sale (avoiding a decline is the good outcome), so its raw percent
// change is inverted; a 'buy' (and the benchmark, always graded as a plain
// buy-and-hold) is not.
function signedReturnPct(side, entryPrice, exitPrice) {
  if (!isFiniteNumber(entryPrice) || !isFiniteNumber(exitPrice) || entryPrice === 0) {
    return null;
  }
  const rawPct = ((exitPrice - entryPrice) / entryPrice) * 100;
  return round2(side === "sell" ? -rawPct : rawPct);
}

function tallyDecisionReview(db, ownerId, period) {
  const { periodStart, periodEnd } = resolvePeriodWindow(period);

  const executedRows = db
    .prepare(`
      SELECT id, symbol, side, limit_price, ticket_id, created_at
      FROM proposals
      WHERE owner_id = ? AND status = 'executed' AND created_at >= ? AND created_at < ?
      ORDER BY created_at ASC
    `)
    .all(ownerId, periodStart, periodEnd);

  const executedEntries = executedRows.map((row) => {
    const side = String(row.side);
    const entryPrice = resolveExecutedEntryPrice(db, row);
    const reviewPrice = latestQuoteForSymbol(db, String(row.symbol));
    const decisionReturnPct = signedReturnPct(side, entryPrice, reviewPrice);

    const benchmarkEntryPrice = benchmarkEntryPriceOn(db, String(row.created_at));
    const benchmarkReviewPrice = latestQuoteForSymbol(db, BENCHMARK_SYMBOL);
    const benchmarkReturnPct = signedReturnPct("buy", benchmarkEntryPrice, benchmarkReviewPrice);

    const alphaPct =
      isFiniteNumber(decisionReturnPct) && isFiniteNumber(benchmarkReturnPct)
        ? round2(decisionReturnPct - benchmarkReturnPct)
        : null;

    return {
      proposalId: String(row.id),
      symbol: String(row.symbol),
      side,
      entryPrice,
      reviewPrice,
      decisionReturnPct,
      benchmarkSymbol: BENCHMARK_SYMBOL,
      benchmarkEntryPrice,
      benchmarkReviewPrice,
      benchmarkReturnPct,
      alphaPct
    };
  });

  const priced = executedEntries.filter((entry) => isFiniteNumber(entry.alphaPct));
  let executed;
  if (executedEntries.length === 0) {
    executed = { sample: "none", n: 0, priced: 0, entries: executedEntries };
  } else if (priced.length < MIN_SAMPLE) {
    executed = { sample: "insufficient", n: executedEntries.length, priced: priced.length, entries: executedEntries };
  } else {
    const avgDecisionReturnPct = round2(priced.reduce((sum, entry) => sum + entry.decisionReturnPct, 0) / priced.length);
    const avgBenchmarkReturnPct = round2(priced.reduce((sum, entry) => sum + entry.benchmarkReturnPct, 0) / priced.length);
    executed = {
      sample: "ok",
      n: executedEntries.length,
      priced: priced.length,
      avgDecisionReturnPct,
      avgBenchmarkReturnPct,
      avgAlphaPct: round2(avgDecisionReturnPct - avgBenchmarkReturnPct),
      entries: executedEntries
    };
  }

  const rejectedRows = db
    .prepare(`
      SELECT id, symbol, side, limit_price, created_at
      FROM proposals
      WHERE owner_id = ? AND status = 'rejected' AND created_at >= ? AND created_at < ?
      ORDER BY created_at ASC
    `)
    .all(ownerId, periodStart, periodEnd);

  const rejectedEntries = rejectedRows.map((row) => {
    const side = String(row.side);
    const proposalPrice = toNullableNumber(row.limit_price);
    const reviewPrice = latestQuoteForSymbol(db, String(row.symbol));
    const hypotheticalReturnPct = signedReturnPct(side, proposalPrice, reviewPrice);
    return {
      proposalId: String(row.id),
      symbol: String(row.symbol),
      side,
      proposalPrice,
      reviewPrice,
      hypotheticalReturnPct,
      disclaimer: REJECTED_DISCLAIMER
    };
  });

  const rejected = {
    sample: rejectedEntries.length === 0 ? "none" : "ok",
    n: rejectedEntries.length,
    disclaimer: REJECTED_DISCLAIMER,
    entries: rejectedEntries
  };

  return { period, periodStart, periodEnd, benchmarkSymbol: BENCHMARK_SYMBOL, executed, rejected };
}

// -----------------------------------------------------------------------
// 3. disciplineReview - re-tallied straight from discipline_rules +
// proposals.discipline_report (own 30-day window arithmetic, own JSON
// parse/tally - NOT via computeComplianceStats).
// -----------------------------------------------------------------------

function classifyProposalDiscipline(rawJson) {
  let entries;
  try {
    const parsed = JSON.parse(rawJson ?? "[]");
    entries = Array.isArray(parsed) ? parsed : [];
  } catch {
    entries = [];
  }
  if (entries.length === 0) {
    return "unknown";
  }
  const hasFail = entries.some((entry) => entry && entry.pass === false);
  return hasFail ? "violating" : "compliant";
}

function summarizeReturnBucket(values) {
  if (values.length === 0) {
    return { sample: "none", n: 0 };
  }
  if (values.length < MIN_SAMPLE) {
    return { sample: "insufficient", n: values.length };
  }
  return { sample: "ok", n: values.length, avgReturnPct: round2(values.reduce((sum, value) => sum + value, 0) / values.length) };
}

function tallyDisciplineReview(db, ownerId, nowDate, executedEntries) {
  const rules = db.prepare(`SELECT id FROM discipline_rules WHERE owner_id = ? AND enabled = 1`).all(ownerId);
  const windowStart = new Date(nowDate.getTime() - COMPLIANCE_WINDOW_MS).toISOString();
  const windowRows = db
    .prepare(`SELECT discipline_report FROM proposals WHERE owner_id = ? AND created_at >= ?`)
    .all(ownerId, windowStart);

  let passed = 0;
  let failed = 0;
  for (const rule of rules) {
    for (const row of windowRows) {
      let entries;
      try {
        const parsed = JSON.parse(row.discipline_report ?? "[]");
        entries = Array.isArray(parsed) ? parsed : [];
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (!entry || entry.ruleId !== rule.id) {
          continue;
        }
        if (entry.pass === true) {
          passed += 1;
        } else if (entry.pass === false) {
          failed += 1;
        }
      }
    }
  }
  const checked = passed + failed;

  let complianceRate;
  if (checked === 0) {
    complianceRate = { sample: "none" };
  } else if (checked < MIN_SAMPLE) {
    complianceRate = { sample: "insufficient", checked };
  } else {
    complianceRate = { sample: "ok", checked, passed, failed, rate: round2(passed / checked) };
  }

  const allProposalRows = db.prepare(`SELECT id, discipline_report FROM proposals WHERE owner_id = ?`).all(ownerId);
  const classificationById = new Map(
    allProposalRows.map((row) => [String(row.id), classifyProposalDiscipline(row.discipline_report)])
  );

  const compliantReturns = [];
  const violatingReturns = [];
  for (const entry of executedEntries) {
    if (!isFiniteNumber(entry.decisionReturnPct)) {
      continue;
    }
    const classification = classificationById.get(entry.proposalId) ?? "unknown";
    if (classification === "compliant") {
      compliantReturns.push(entry.decisionReturnPct);
    } else if (classification === "violating") {
      violatingReturns.push(entry.decisionReturnPct);
    }
  }

  const compliant = summarizeReturnBucket(compliantReturns);
  const violating = summarizeReturnBucket(violatingReturns);
  const deltaPct =
    compliant.sample === "ok" && violating.sample === "ok" ? round2(compliant.avgReturnPct - violating.avgReturnPct) : null;

  return { complianceRate, complianceValue: { compliant, violating, deltaPct } };
}

// -----------------------------------------------------------------------
// 4. alertQuality - re-tallied straight from alert_events.
// -----------------------------------------------------------------------

function tallyAlertQuality(db, ownerId, period) {
  const { periodStart, periodEnd } = resolvePeriodWindow(period);
  const rows = db
    .prepare(`SELECT feedback FROM alert_events WHERE owner_id = ? AND triggered_at >= ? AND triggered_at < ?`)
    .all(ownerId, periodStart, periodEnd);

  const triggeredCount = rows.length;
  if (triggeredCount === 0) {
    return { sample: "none", triggeredCount: 0, misreportCount: 0, misreportRate: null };
  }

  const misreportCount = rows.filter((row) => typeof row.feedback === "string" && row.feedback.includes("误报")).length;
  return { sample: "ok", triggeredCount, misreportCount, misreportRate: round2(misreportCount / triggeredCount) };
}

// -----------------------------------------------------------------------
// Public entry point.
// -----------------------------------------------------------------------

/**
 * Independently re-derives review-engine.mjs's headline numbers straight from
 * raw SQL - see this module's header for why it shares NO metric-computation
 * code with the primary engine.
 *
 * @param {{db: import('node:sqlite').DatabaseSync, ownerId: string, period: string, now?: string}} input
 * @returns {object} same shape as buildMonthlyReview's predictionReview/
 *   decisionReview/disciplineReview/alertQuality blocks.
 */
export function recomputeReviewMetrics({ db, ownerId, period, now } = {}) {
  if (!db) {
    throw new Error("recomputeReviewMetrics requires a db handle.");
  }
  if (!ownerId) {
    throw new Error("recomputeReviewMetrics requires ownerId.");
  }
  if (!period) {
    throw new Error("recomputeReviewMetrics requires period ('YYYY-MM').");
  }

  const nowValue = now ?? new Date().toISOString();
  const nowDate = new Date(nowValue);

  const predictionReview = {
    selfThesisHitRate: tallySelfThesisHitRate(db, ownerId),
    systemConfidenceCalibration: tallyConfidenceCalibration(db)
  };

  const decisionReview = tallyDecisionReview(db, ownerId, period);
  const disciplineReview = tallyDisciplineReview(db, ownerId, nowDate, decisionReview.executed.entries);
  const alertQuality = tallyAlertQuality(db, ownerId, period);

  return {
    ownerId,
    period,
    generatedAt: nowValue,
    predictionReview,
    decisionReview,
    disciplineReview,
    alertQuality
  };
}

// -----------------------------------------------------------------------
// compareReviewMetrics: the consistency-gate comparison helper. Walks a
// FIXED list of headline-number paths (exactly the metrics this phase's
// plan names as the cross-check target) and deep-diffs the primary engine's
// value against the verifier's recomputed value at each one, returning every
// leaf mismatch found (an empty array means fully consistent). Used by:
//   - review-consistency.test.ts (the delivery gate itself, plus its
//     bad-sample test: corrupt one number in the primary's result_json and
//     assert this function flags it).
//   - reviews.mjs's `generate` CLI command, at RUNTIME, as the actual save
//     gate - a non-empty result there refuses to persist the draft.
// -----------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectMismatches(path, primaryValue, verifierValue, mismatches) {
  if (Object.is(primaryValue, verifierValue)) {
    return;
  }

  if (Array.isArray(primaryValue) && Array.isArray(verifierValue)) {
    if (primaryValue.length !== verifierValue.length) {
      mismatches.push({ path: `${path}.length`, primary: primaryValue.length, verifier: verifierValue.length });
    }
    const length = Math.max(primaryValue.length, verifierValue.length);
    for (let i = 0; i < length; i += 1) {
      collectMismatches(`${path}[${i}]`, primaryValue[i], verifierValue[i], mismatches);
    }
    return;
  }

  if (isPlainObject(primaryValue) && isPlainObject(verifierValue)) {
    const keys = new Set([...Object.keys(primaryValue), ...Object.keys(verifierValue)]);
    for (const key of keys) {
      collectMismatches(path ? `${path}.${key}` : key, primaryValue[key], verifierValue[key], mismatches);
    }
    return;
  }

  mismatches.push({ path, primary: primaryValue, verifier: verifierValue });
}

// The exact headline-number blocks this phase's plan calls out for the
// consistency gate: "命中率/置信度校准各档/收益对比/遵守率/误报率".
const HEADLINE_PATHS = [
  ["predictionReview.selfThesisHitRate", (result) => result?.predictionReview?.selfThesisHitRate],
  ["predictionReview.systemConfidenceCalibration", (result) => result?.predictionReview?.systemConfidenceCalibration],
  ["decisionReview.executed", (result) => result?.decisionReview?.executed],
  ["decisionReview.rejected", (result) => result?.decisionReview?.rejected],
  ["disciplineReview.complianceRate", (result) => result?.disciplineReview?.complianceRate],
  ["disciplineReview.complianceValue", (result) => result?.disciplineReview?.complianceValue],
  ["alertQuality", (result) => result?.alertQuality]
];

/**
 * @param {object} primaryResult buildMonthlyReview's result_json.
 * @param {object} verifierResult recomputeReviewMetrics's return value.
 * @returns {Array<{path: string, primary: unknown, verifier: unknown}>} every
 *   headline-number leaf where the two disagree - empty means consistent.
 */
export function compareReviewMetrics(primaryResult, verifierResult) {
  const mismatches = [];
  for (const [label, pick] of HEADLINE_PATHS) {
    collectMismatches(label, pick(primaryResult), pick(verifierResult), mismatches);
  }
  return mismatches;
}
