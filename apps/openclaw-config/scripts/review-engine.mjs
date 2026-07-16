// Phase 9 Task 2 (2026-07-16 plan, review flywheel): the monthly review
// engine. `buildMonthlyReview({db, ownerId, period, now, helpers})` is the
// ONE public export - a pure(ish) read function that turns one owner's raw
// rows for one calendar month into the `result_json` MonthlyReviewRepository
// (Task 1) persists. Every headline number below is plain arithmetic over
// real rows - no LLM call, no judgment call, anywhere in this file (same
// discipline thesis-outcome.mjs/prediction-outcome.mjs already declare for
// themselves). Task 3's independent verifier re-derives these SAME headline
// numbers from scratch, with its own SQL and its own arithmetic, and gates
// on them matching this file's output byte-for-byte - so nothing here may
// depend on anything Task 3's verifier can't equally reconstruct from the
// raw tables.
//
// ---------------------------------------------------------------------------
// Helper injection vs. raw SQL: WHY the split falls exactly where it does
// ---------------------------------------------------------------------------
// This module receives exactly THREE functions via `helpers` -
// `computeThesisOutcome`, `loadLatestPriceForSymbol`, `computeComplianceStats`
// - and does everything else (proposals, discipline_rules, alert_events,
// analysis_predictions, official_paper_order_lifecycle, stock_facts) as raw
// SQL straight against `db`. The split is not arbitrary:
//
//   - `loadLatestPriceForSymbol` and `computeComplianceStats` are ONLY
//     implemented in TypeScript, in apps/platform-app/src/data/strategy.ts.
//     That app has no compiled artifact a script in a DIFFERENT app can
//     `import` the way every other .mjs here imports
//     packages/shared-types/dist/index.js (that package genuinely ships a
//     dist/; apps/platform-app does not publish one for other apps to
//     consume). Re-declaring their algorithms a second time IN THIS FILE was
//     considered and rejected: computeComplianceStats's 30-day-window
//     discipline_report tally and loadLatestPriceForSymbol's "latest
//     quote.last" query are exactly the kind of logic strategy.ts's own
//     header warns against silently duplicating (see computeThesisOutcome's
//     dual-implementation-plus-anti-drift-fixture precedent there) - a
//     second hand-copy in this file would be a second place to drift out of
//     sync with zero test coverage forcing them back into agreement. Runtime
//     wiring (Task 3's CLI/cron) is expected to bridge this the same way any
//     other cross-app TS dependency in this monorepo gets bridged - out of
//     scope for this task, which only needs `buildMonthlyReview` to accept
//     them as parameters.
//   - `computeThesisOutcome` ALSO arrives via `helpers` (matching the plan's
//     literal interface), even though apps/openclaw-config/scripts/
//     thesis-outcome.mjs already has a same-app, zero-build-step
//     implementation this file could `import` directly with no boundary
//     problem at all. It is still received as a parameter rather than
//     imported, purely to honor the plan's explicit
//     `helpers.computeThesisOutcome` interface and keep every metric
//     equally test-injectable/swappable - there is no cost to doing so here.
//   - `currentUsEasternTradingDay` (trading-schedule.mjs) is a plain SAME-APP
//     sibling import below, NOT part of `helpers` - it already lives in this
//     exact app with no build step in the way (discipline-engine.mjs already
//     imports it for the same reason), so injecting it would add ceremony
//     without solving any real problem. The benchmark's point-in-time price
//     lookup below queries `stock_facts` directly with its own bounded SQL
//     (`trading_day <= ?`) rather than reusing stock-facts-store.mjs's
//     `getStockFacts` - that helper is an EXACT (trading_day, symbol) match
//     (right for prediction-outcome.mjs's designated review_date lookups),
//     whereas an arbitrary proposal's created_at needs "closest PRIOR
//     trading day actually on record", a different query shape - see below.
//   - `computePaperKpis`/`loadSnapshotSeriesForOwner` (also TS-only, also
//     named in the plan's illustrative "helpers = 注入的 ... 等" list) are
//     DELIBERATELY NOT wired in here: none of this task's five metric blocks
//     (predictionReview/decisionReview/disciplineReview/alertQuality/
//     suggestions) needs a portfolio-level net-worth KPI - decisionReview's
//     own metric is proposal-by-proposal (entry price vs. review-day price
//     vs. a benchmark), not an account-level curve. Wiring in two unused
//     parameters just to match an illustrative list would be dead surface
//     with no test obligation behind it.
//
// ---------------------------------------------------------------------------
// Period window: Beijing (Asia/Shanghai) calendar month
// ---------------------------------------------------------------------------
// `period` is a 'YYYY-MM' label; every period-scoped SQL WHERE clause below
// bounds `created_at`/`triggered_at` (ISO-8601 UTC strings, e.g. from
// nowIso()) to the half-open UTC instant range [periodStart, periodEnd) for
// that calendar month IN BEIJING TIME, mirroring
// apps/platform-app/src/data/snapshots.ts's own beijingDayStartUtcIso/
// beijingDateStamp convention for exactly the same reason that file states:
// this project's owner-facing day/period boundaries (proposals, reports,
// cron jobs) are already anchored to Beijing local time everywhere else -
// openclaw-cron-jobs.mjs's own cron entries all declare `timezone:
// "Asia/Shanghai"`, and this phase's own spec says reviews generate "每月
// 第一个周末" (every month's first weekend), which is a Beijing-calendar
// concept for this team. Beijing has no DST, so a fixed UTC+8 offset is
// exact year-round (same simplifying fact snapshots.ts's own comment
// relies on) - no need for the America/New_York-style DST-aware offset
// lookup usEasternTradingDayUtcRange needs in database.ts.
//
// NOT every metric below is period-scoped, and that is deliberate, not an
// oversight:
//   - selfThesisHitRate (predictionReview.a) is the owner's CUMULATIVE
//     judgment track record as of `now`, not clipped to this one calendar
//     month - a thesis's judgment history spans many months, and restricting
//     it to a single month would make the n>=10 threshold nearly
//     unreachable for most owners most months. This mirrors
//     computeComplianceStats's OWN existing convention (a rolling 30-day
//     window from `now`, never a calendar-month window either) - neither of
//     the two P5-P8 helpers this engine reuses is period-scoped, so this
//     engine does not invent a month-scoping wrapper around them.
//   - disciplineReview.complianceRate reuses computeComplianceStats AS-IS
//     (its existing rolling 30-day-from-`now` window), for the same reason:
//     that helper's signature/semantics are given, not redesigned here.
//   - decisionReview and alertQuality (proposals/alert_events created THIS
//     month) and disciplineReview's "守规矩值多少钱" comparison (which reuses
//     decisionReview's own period-scoped executed-proposal set, to avoid a
//     THIRD independently-scoped read of the same table) ARE period-scoped -
//     these three are inherently "what happened this month" questions.
//
// ---------------------------------------------------------------------------
// Benchmark choice: QQQ, not "the symbol itself"
// ---------------------------------------------------------------------------
// The plan offers a choice ("同期 QQQ 或标的自身"). Benchmarking a trade
// against a passive buy-and-hold of the exact same symbol over the exact
// same window is tautological here: decisionReturnPct is ALREADY computed as
// exactly that (entry price -> review-day price, no fees modeled) - "the
// symbol itself" as its own benchmark would always show zero alpha by
// construction, which answers no real question. QQQ (a broad, liquid,
// always-tradeable market proxy) answers the question this metric exists
// for - "did the active decision beat passively sitting in the market" - so
// it is the benchmark used for every decisionReview entry, fixed, not
// per-symbol.
//
// ---------------------------------------------------------------------------
// No historical point-in-time price store (Global Constraint: "无历史时点价")
// ---------------------------------------------------------------------------
// stock_facts is keyed by (trading_day, symbol) - a REAL point-in-time
// series exists, but only for days/symbols this system actually ran
// analysis for. Two different lookups against it appear below, deliberately
// NOT unified into one helper:
//   - `helpers.loadLatestPriceForSymbol` (own stock's "review-day price" AND
//     the benchmark's own "review-day price") always means "the latest
//     quote.last on record, as of whenever this review is generated" - same
//     "no historical anchor, just today's snapshot" semantics
//     computeThesisOutcome's own `latestPrice` input already carries.
//   - `resolveBenchmarkEntryPrice` below is a DIFFERENT question - "QQQ's
//     price on/near a SPECIFIC PAST calendar day" (the day a given proposal
//     was created) - so it runs its own bounded SQL
//     (`trading_day <= ? ORDER BY trading_day DESC LIMIT 1`), the closest
//     PRIOR trading day actually on record, exactly like
//     prediction-outcome.mjs's own priceReader concept, but intentionally
//     NOT reusing that file's exact-day-match convention (review_date there
//     is guaranteed to be a real designated date; an arbitrary proposal's
//     created_at is not, so a closest-prior-day fallback is the honest
//     choice here, not a copy-paste of a convention built for a different
//     guarantee).
// Any lookup that comes back with no row is `null` - counted as "unpriceable"
// for that one entry, NEVER fabricated, exactly like the rest of this
// phase's price-outcome modules.
//
// ---------------------------------------------------------------------------
// MIN_SAMPLE_SIZE = 10, used everywhere in this file
// ---------------------------------------------------------------------------
// thesis-outcome.mjs already establishes "n < 10 -> 样本不足" as this
// project's standing convention for a judgment-count threshold. Rather than
// invent a DIFFERENT magic number per metric (proposal counts, alert counts,
// compliance-check counts) with no principled basis for picking each one,
// this file reuses that SAME threshold everywhere a sample-size gate is
// needed. A lower threshold specifically for the "守规矩值多少钱"
// compliant-vs-violating comparison was considered (executed trades per
// month are naturally few, so this comparison will often show
// 'insufficient') and rejected: a looser threshold there would make it
// easier to dress up a couple of coincidental data points as "the cost of
// breaking the rules", which is exactly the "诚实呈现防事后美化" (honest
// presentation, no after-the-fact flattery) principle this phase's Global
// Constraints call for.

import { currentUsEasternTradingDay } from "./trading-schedule.mjs";

const MIN_SAMPLE_SIZE = 10;
const CONFIDENCE_TIERS = ["low", "medium", "high"];
const BENCHMARK_SYMBOL = "QQQ";
const REJECTED_DISCLAIMER = "未执行，仅口径参考";
const IMPROVEMENT_DISCLAIMER =
  "以上为规则推导的改进建议，仅供参考；任何策略/纪律变更须本人在飞书或 CLI 中手动确认后生效。";
const NO_LESSON_DEFAULT = "本月各项指标样本不足或表现正常，暂无可归纳的一句话教训。";
const NO_NEXT_STEPS_DEFAULT = "暂无下一步动作建议——数据不足或本月各项指标均在正常范围内。";

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
// Period window (see module header: Beijing calendar month, no DST).
// -----------------------------------------------------------------------

const PERIOD_PATTERN = /^(\d{4})-(\d{2})$/;

function beijingMidnightUtcIso(dateLabel) {
  return new Date(`${dateLabel}T00:00:00+08:00`).toISOString();
}

/**
 * @param {string} period 'YYYY-MM'
 * @returns {{periodStart: string, periodEnd: string}} half-open UTC instant
 *   range for that Beijing calendar month.
 */
export function beijingMonthUtcRange(period) {
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
  const periodStart = beijingMidnightUtcIso(`${period}-01`);
  const periodEnd = beijingMidnightUtcIso(`${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`);
  return { periodStart, periodEnd };
}

// -----------------------------------------------------------------------
// 1(a). predictionReview.selfThesisHitRate - owner's cumulative judgment
// track record (NOT period-scoped, see module header).
// -----------------------------------------------------------------------

function buildSelfThesisHitRate(db, ownerId, helpers) {
  const theses = db
    .prepare(`SELECT id, symbol, direction, target_low, target_high, invalidation_price FROM theses WHERE owner_id = ?`)
    .all(ownerId);

  let n = 0;
  let hits = 0;
  let misses = 0;

  for (const row of theses) {
    const judgments = db
      .prepare(`SELECT id FROM thesis_history WHERE thesis_id = ? ORDER BY created_at ASC`)
      .all(row.id)
      .map((judgment) => ({ id: String(judgment.id) }));

    if (judgments.length === 0) {
      continue;
    }

    const latestPrice = helpers.loadLatestPriceForSymbol(db, String(row.symbol));
    const thesis = {
      direction: String(row.direction),
      targetLow: toNullableNumber(row.target_low),
      targetHigh: toNullableNumber(row.target_high),
      invalidationPrice: toNullableNumber(row.invalidation_price)
    };

    const { perJudgment } = helpers.computeThesisOutcome({ thesis, judgments, latestPrice });
    n += perJudgment.length;
    hits += perJudgment.filter((judgment) => judgment.verdict === "toward_target").length;
    misses += perJudgment.filter((judgment) => judgment.verdict === "toward_invalidation").length;
  }

  if (n < MIN_SAMPLE_SIZE) {
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
// 1(b). predictionReview.systemConfidenceCalibration - PUBLIC, system-level,
// deliberately NOT owner-filtered (Global Constraint / plan architecture
// decision ①: analysis_predictions has no owner_id at all - it is a shared
// individual-stock-analysis artifact, not a per-owner one).
// -----------------------------------------------------------------------

function buildSystemConfidenceCalibration(db) {
  const rows = db.prepare(`SELECT confidence, outcome FROM analysis_predictions WHERE outcome IS NOT NULL`).all();

  return CONFIDENCE_TIERS.map((tier) => {
    const tierRows = rows.filter((row) => String(row.confidence) === tier);
    const n = tierRows.length;
    if (n === 0) {
      return { tier, sample: "none", n: 0 };
    }
    if (n < MIN_SAMPLE_SIZE) {
      return { tier, sample: "insufficient", n };
    }
    const hits = tierRows.filter((row) => String(row.outcome) === "hit").length;
    return { tier, sample: "ok", n, hits, hitFraction: round2(hits / n) };
  });
}

// -----------------------------------------------------------------------
// 2. decisionReview - period-scoped.
// -----------------------------------------------------------------------

function resolveEntryPrice(db, proposalRow) {
  if (proposalRow.ticket_id) {
    const lifecycle = db
      .prepare(`SELECT limit_price FROM official_paper_order_lifecycle WHERE ticket_id = ? LIMIT 1`)
      .get(proposalRow.ticket_id);
    if (lifecycle && lifecycle.limit_price !== null && lifecycle.limit_price !== undefined) {
      return Number(lifecycle.limit_price);
    }
  }
  return toNullableNumber(proposalRow.limit_price);
}

// Direction-aware return: a 'buy' decision wants the price to rise after
// entry, a 'sell' decision wants it to fall after the sale (selling before a
// decline is the "good" outcome) - same directional-grading idea
// thesis-outcome.mjs applies to bull/bear theses. The benchmark itself is
// always graded as a plain buy-and-hold (side = 'buy'), never inverted.
function directionalReturnPct(side, entryPrice, exitPrice) {
  if (!isFiniteNumber(entryPrice) || !isFiniteNumber(exitPrice) || entryPrice === 0) {
    return null;
  }
  const rawPct = ((exitPrice - entryPrice) / entryPrice) * 100;
  return round2(side === "sell" ? -rawPct : rawPct);
}

// QQQ's price on/near a SPECIFIC PAST calendar day (see module header for
// why this is a different lookup shape than helpers.loadLatestPriceForSymbol).
function resolveBenchmarkEntryPrice(db, createdAtIso) {
  const tradingDay = currentUsEasternTradingDay(new Date(createdAtIso));
  const row = db
    .prepare(`
      SELECT value_num FROM stock_facts
      WHERE symbol = ? AND fact_key = 'quote.last' AND value_num IS NOT NULL AND trading_day <= ?
      ORDER BY trading_day DESC LIMIT 1
    `)
    .get(BENCHMARK_SYMBOL, tradingDay);
  return row ? Number(row.value_num) : null;
}

function buildDecisionReview(db, ownerId, period, helpers) {
  const { periodStart, periodEnd } = beijingMonthUtcRange(period);

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
    const entryPrice = resolveEntryPrice(db, row);
    const reviewPrice = helpers.loadLatestPriceForSymbol(db, String(row.symbol));
    const decisionReturnPct = directionalReturnPct(side, entryPrice, reviewPrice);

    const benchmarkEntryPrice = resolveBenchmarkEntryPrice(db, String(row.created_at));
    const benchmarkReviewPrice = helpers.loadLatestPriceForSymbol(db, BENCHMARK_SYMBOL);
    const benchmarkReturnPct = directionalReturnPct("buy", benchmarkEntryPrice, benchmarkReviewPrice);

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
  } else if (priced.length < MIN_SAMPLE_SIZE) {
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
    const reviewPrice = helpers.loadLatestPriceForSymbol(db, String(row.symbol));
    const hypotheticalReturnPct = directionalReturnPct(side, proposalPrice, reviewPrice);
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
// 3. disciplineReview - complianceRate reuses computeComplianceStats (its own
// existing rolling-30-day window, see module header); complianceValue
// ("守规矩值多少钱") reuses decisionReview's ALREADY-COMPUTED, period-scoped
// executed-proposal entries (same universe, avoids a second independently-
// scoped read of `proposals`/re-deriving decisionReturnPct a second time).
// -----------------------------------------------------------------------

function classifyDisciplineReport(rawJson) {
  let entries;
  try {
    const parsed = JSON.parse(rawJson ?? "[]");
    entries = Array.isArray(parsed) ? parsed : [];
  } catch {
    entries = [];
  }
  if (entries.length === 0) {
    return "unknown"; // no discipline_report info at all recorded for this proposal
  }
  const hasFail = entries.some((entry) => entry && entry.pass === false);
  return hasFail ? "violating" : "compliant";
}

function summarizeReturns(returns) {
  if (returns.length === 0) {
    return { sample: "none", n: 0 };
  }
  if (returns.length < MIN_SAMPLE_SIZE) {
    return { sample: "insufficient", n: returns.length };
  }
  return { sample: "ok", n: returns.length, avgReturnPct: round2(returns.reduce((sum, r) => sum + r, 0) / returns.length) };
}

function buildComplianceValue(compliantReturns, violatingReturns) {
  const compliant = summarizeReturns(compliantReturns);
  const violating = summarizeReturns(violatingReturns);
  const deltaPct =
    compliant.sample === "ok" && violating.sample === "ok" ? round2(compliant.avgReturnPct - violating.avgReturnPct) : null;
  return { compliant, violating, deltaPct };
}

function buildDisciplineReview(db, ownerId, nowDate, executedEntries, helpers) {
  const rules = db.prepare(`SELECT id FROM discipline_rules WHERE owner_id = ? AND enabled = 1`).all(ownerId);

  let checked = 0;
  let passed = 0;
  let failed = 0;
  for (const rule of rules) {
    const stats = helpers.computeComplianceStats(db, ownerId, String(rule.id), nowDate);
    if (stats.sample === "ok") {
      checked += stats.checked;
      passed += stats.passed;
      failed += stats.failed;
    }
  }

  let complianceRate;
  if (checked === 0) {
    complianceRate = { sample: "none" };
  } else if (checked < MIN_SAMPLE_SIZE) {
    complianceRate = { sample: "insufficient", checked };
  } else {
    complianceRate = { sample: "ok", checked, passed, failed, rate: round2(passed / checked) };
  }

  const disciplineRows = db.prepare(`SELECT id, discipline_report FROM proposals WHERE owner_id = ?`).all(ownerId);
  const classificationById = new Map(disciplineRows.map((row) => [String(row.id), classifyDisciplineReport(row.discipline_report)]));

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

  return { complianceRate, complianceValue: buildComplianceValue(compliantReturns, violatingReturns) };
}

// -----------------------------------------------------------------------
// 4. alertQuality - period-scoped.
// -----------------------------------------------------------------------

function buildAlertQuality(db, ownerId, period) {
  const { periodStart, periodEnd } = beijingMonthUtcRange(period);
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
// 5. errorCategories / oneLineLesson / nextSteps / improvementSuggestions -
// a DETERMINISTIC, rule-based template over the metrics computed above. This
// is explicitly NOT an LLM feature (Global Constraint: "确定性/无 LLM 的指标");
// a future phase may add LLM narrative on TOP of this, per the plan's "划界"
// section, but the gate this phase cares about never touches that path.
// -----------------------------------------------------------------------

function buildSuggestions({ predictionReview, decisionReview, disciplineReview, alertQuality }) {
  const suggestions = [];
  const categories = [];

  const { complianceRate } = disciplineReview;
  if (complianceRate.sample === "ok" && complianceRate.rate < 0.8) {
    categories.push("策略纪律");
    suggestions.push(
      `本月遵守率 ${Math.round(complianceRate.rate * 100)}%，低于 80%，建议复核高频违反的规则，考虑收紧执行或简化条款以减少绕过空间。`
    );
  }

  const { selfThesisHitRate, systemConfidenceCalibration } = predictionReview;
  if (selfThesisHitRate.sample === "ok" && selfThesisHitRate.hitFraction < 0.5) {
    categories.push("论点方向");
    suggestions.push(
      `本人论点方向命中率 ${Math.round(selfThesisHitRate.hitFraction * 100)}%，低于五成，建议复盘方向判断失误的论点，找出共性偏差。`
    );
  }

  const highTier = systemConfidenceCalibration.find((tier) => tier.tier === "high");
  const lowTier = systemConfidenceCalibration.find((tier) => tier.tier === "low");
  if (highTier?.sample === "ok" && highTier.hitFraction < 0.5) {
    categories.push("系统置信度校准");
    suggestions.push(
      `系统「高」置信度个股分析命中率仅 ${Math.round(highTier.hitFraction * 100)}%（系统级，非本人），建议重新校准置信度打分标准。`
    );
  }
  if (highTier?.sample === "ok" && lowTier?.sample === "ok" && highTier.hitFraction < lowTier.hitFraction) {
    categories.push("系统置信度校准");
    suggestions.push(
      `系统「高」置信度命中率低于「低」置信度（${Math.round(highTier.hitFraction * 100)}% < ${Math.round(lowTier.hitFraction * 100)}%，系统级，非本人），置信度分档出现倒挂，建议校准。`
    );
  }

  if (decisionReview.executed.sample === "ok" && decisionReview.executed.avgAlphaPct < 0) {
    categories.push("决策择时");
    suggestions.push(
      `本月执行提案平均收益跑输 ${decisionReview.benchmarkSymbol} 基准 ${Math.abs(decisionReview.executed.avgAlphaPct).toFixed(2)} 个百分点，建议减少主动择时交易，评估被动持有的必要性。`
    );
  }

  if (alertQuality.sample === "ok" && alertQuality.misreportRate > 0.3) {
    categories.push("提醒质量");
    suggestions.push(
      `本月提醒误报率 ${Math.round(alertQuality.misreportRate * 100)}%，高于 30%，建议调高触发阈值或增加滞回（hysteresis）。`
    );
  }

  const errorCategories = [...new Set(categories)];
  const oneLineLesson = suggestions.length > 0 ? suggestions[0] : NO_LESSON_DEFAULT;
  const nextSteps = suggestions.length > 0 ? suggestions.map((s, i) => `${i + 1}. ${s}`) : [NO_NEXT_STEPS_DEFAULT];

  return {
    errorCategories,
    oneLineLesson,
    nextSteps,
    improvementSuggestions: { disclaimer: IMPROVEMENT_DISCLAIMER, items: suggestions }
  };
}

// -----------------------------------------------------------------------
// Public entry point.
// -----------------------------------------------------------------------

/**
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   ownerId: string,
 *   period: string,
 *   now?: string,
 *   helpers: {
 *     computeThesisOutcome: Function,
 *     loadLatestPriceForSymbol: (db: unknown, symbol: string) => number | null,
 *     computeComplianceStats: (db: unknown, ownerId: string, ruleId: string, now: Date) => unknown
 *   }
 * }} input
 * @returns {object} the MonthlyReviewResult `result_json` shape.
 */
export function buildMonthlyReview({ db, ownerId, period, now, helpers } = {}) {
  if (!db) {
    throw new Error("buildMonthlyReview requires a db handle.");
  }
  if (!ownerId) {
    throw new Error("buildMonthlyReview requires ownerId.");
  }
  if (!period) {
    throw new Error("buildMonthlyReview requires period ('YYYY-MM').");
  }
  if (
    !helpers ||
    typeof helpers.computeThesisOutcome !== "function" ||
    typeof helpers.loadLatestPriceForSymbol !== "function" ||
    typeof helpers.computeComplianceStats !== "function"
  ) {
    throw new Error(
      "buildMonthlyReview requires helpers.{computeThesisOutcome, loadLatestPriceForSymbol, computeComplianceStats}."
    );
  }

  const nowValue = now ?? new Date().toISOString();
  const nowDate = new Date(nowValue);

  const predictionReview = {
    selfThesisHitRate: buildSelfThesisHitRate(db, ownerId, helpers),
    systemConfidenceCalibration: buildSystemConfidenceCalibration(db),
    systemConfidenceCalibrationNote: "系统个股分析置信度校准——全平台口径，非本人专属"
  };

  const decisionReview = buildDecisionReview(db, ownerId, period, helpers);
  const disciplineReview = buildDisciplineReview(db, ownerId, nowDate, decisionReview.executed.entries, helpers);
  const alertQuality = buildAlertQuality(db, ownerId, period);

  const { errorCategories, oneLineLesson, nextSteps, improvementSuggestions } = buildSuggestions({
    predictionReview,
    decisionReview,
    disciplineReview,
    alertQuality
  });

  return {
    ownerId,
    period,
    generatedAt: nowValue,
    predictionReview,
    decisionReview,
    disciplineReview,
    alertQuality,
    errorCategories,
    oneLineLesson,
    nextSteps,
    improvementSuggestions
  };
}
