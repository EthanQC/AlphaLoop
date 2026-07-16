// Phase 9 Task 3 (2026-07-16 plan, review flywheel): THE DELIVERY GATE.
// review-engine.mjs's buildMonthlyReview (the primary review engine, Task 2)
// and review-verifier.mjs's recomputeReviewMetrics (an independent SECOND
// implementation, Task 3 - see that file's own header for why it shares no
// metric-computation code with the primary) are run against the SAME
// deterministic fixture, on the SAME db, and every headline number the plan
// names for this gate ("命中率/置信度校准各档/收益对比/遵守率/误报率") must come
// back IDENTICAL. That is this phase's whole promise: a correct primary and
// a correct verifier are guaranteed to agree (same math, different code), so
// a passing gate here is real evidence the primary is not fabricating a
// number - not just "these two files happen to look similar".
//
// The second half of this file proves the gate has TEETH: corrupting a single
// headline number in the primary's own result_json (simulating a report that
// fabricated/mis-typed a figure) must make compareReviewMetrics flag it. A
// gate that always says "consistent" no matter what would be worse than no
// gate at all.
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { MemberRepository, createId, migrate, type Member } from "../../../packages/shared-types/dist/index.js";

// Same cross-app-boundary test-wiring rationale as review-engine.test.ts's own
// header comment: these two TS-only helpers live in apps/platform-app/src/
// data/strategy.ts with no dist/ this DIFFERENT app can `import` outside a
// test run; vitest/esbuild strips types at the file level regardless of which
// app a relative path points into, so this test file (never `tsc --build`,
// never anything but `vitest run`) is free to reach across that boundary for
// wiring the PRIMARY engine's injected helpers - it is the runtime CLI
// (reviews.mjs) that owns the production cross-app wiring.
import { computeComplianceStats, loadLatestPriceForSymbol } from "../../platform-app/src/data/strategy.js";
import { computeThesisOutcome } from "./thesis-outcome.mjs";

const { buildMonthlyReview } = await import("./review-engine.mjs");
const { recomputeReviewMetrics, compareReviewMetrics } = await import("./review-verifier.mjs");

const HELPERS = { computeThesisOutcome, loadLatestPriceForSymbol, computeComplianceStats };

const OWNER_A = "member_a";
const PERIOD = "2026-07";
const NOW = "2026-07-20T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Seed helpers (mirrors review-engine.test.ts's own seed* helper conventions
// for the same tables - this is fixture-building test code, not a metric
// implementation, so reusing the same shapes here is fine).
// ---------------------------------------------------------------------------

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    id: OWNER_A,
    email: `${overrides.id ?? OWNER_A}@example.com`,
    displayName: "Test Member",
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function seedMembers(db: DatabaseSync, ids: string[]): void {
  const repo = new MemberRepository(db);
  for (const id of ids) {
    repo.upsert(makeMember({ id }));
  }
}

function seedThesis(
  db: DatabaseSync,
  opts: {
    ownerId: string;
    symbol: string;
    direction?: "bull" | "bear" | "neutral";
    targetLow?: number | null;
    targetHigh?: number | null;
    invalidationPrice?: number | null;
  }
): string {
  const id = createId("thesis");
  db.prepare(`
    INSERT INTO theses (id, owner_id, symbol, direction, target_low, target_high, invalidation_price, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run(
    id,
    opts.ownerId,
    opts.symbol,
    opts.direction ?? "bull",
    opts.targetLow ?? null,
    opts.targetHigh ?? null,
    opts.invalidationPrice ?? null
  );
  return id;
}

function seedJudgments(db: DatabaseSync, thesisId: string, count: number): void {
  for (let i = 0; i < count; i += 1) {
    db.prepare(`INSERT INTO thesis_history (id, thesis_id, note, source, created_at) VALUES (?, ?, ?, 'test', ?)`).run(
      createId("thesis_history"),
      thesisId,
      `judgment ${i}`,
      `2026-0${1 + (i % 6)}-01T00:00:00.000Z`
    );
  }
}

function seedStockFact(db: DatabaseSync, opts: { symbol: string; tradingDay: string; valueNum: number }): void {
  db.prepare(`
    INSERT INTO stock_facts (id, trading_day, symbol, fact_key, value_num, value_text, unit, source, data_time, created_at)
    VALUES (?, ?, ?, 'quote.last', ?, NULL, 'USD', 'test', ?, ?)
  `).run(createId("stock_fact"), opts.tradingDay, opts.symbol, opts.valueNum, opts.tradingDay, opts.tradingDay);
}

function seedProposal(
  db: DatabaseSync,
  opts: {
    ownerId: string;
    symbol: string;
    side?: "buy" | "sell";
    limitPrice?: number | null;
    ticketId?: string | null;
    status?: string;
    disciplineReport?: unknown[];
    createdAt?: string;
  }
): string {
  const id = createId("proposal");
  db.prepare(`
    INSERT INTO proposals
      (id, owner_id, symbol, side, quantity, order_type, limit_price, reason, discipline_report, status, ticket_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, 1, 'limit', ?, 'test reason', ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.ownerId,
    opts.symbol,
    opts.side ?? "buy",
    opts.limitPrice ?? null,
    JSON.stringify(opts.disciplineReport ?? []),
    opts.status ?? "executed",
    opts.ticketId ?? null,
    opts.createdAt ?? "2026-07-05T00:00:00.000Z",
    opts.createdAt ?? "2026-07-05T00:00:00.000Z"
  );
  return id;
}

function seedLifecycle(db: DatabaseSync, opts: { ticketId: string; symbol: string; limitPrice: number | null }): void {
  db.prepare(`
    INSERT INTO official_paper_order_lifecycle
      (id, ticket_id, external_order_id, provider, environment, account_mode, symbol, asset_class, side, quantity,
       limit_price, broker_status, local_status, lifecycle_stage, submitted_at, last_observed_at, raw, notes)
    VALUES (?, ?, ?, 'longbridge', 'paper', 'paper', ?, 'equity', 'buy', 1, ?, 'filled', 'filled', 'filled', ?, ?, '{}', '')
  `).run(
    createId("lifecycle"),
    opts.ticketId,
    `ext_${opts.ticketId}`,
    opts.symbol,
    opts.limitPrice,
    "2026-07-05T00:00:00.000Z",
    "2026-07-05T00:00:00.000Z"
  );
}

function seedDisciplineRule(db: DatabaseSync, opts: { ownerId: string }): string {
  const id = createId("discipline_rule");
  db.prepare(`
    INSERT INTO discipline_rules (id, owner_id, rule_text, enforcement, enabled, created_at)
    VALUES (?, ?, '仓位≤30%', 'proposal_check', 1, '2026-01-01T00:00:00.000Z')
  `).run(id, opts.ownerId);
  return id;
}

function seedAlertRule(db: DatabaseSync, opts: { ownerId: string; symbol?: string }): string {
  const id = createId("alert_rule");
  db.prepare(`
    INSERT INTO alert_rules (id, owner_id, symbol, rule_type, threshold, frequency, created_at)
    VALUES (?, ?, ?, 'daily_move', 5, 'once_daily', '2026-01-01T00:00:00.000Z')
  `).run(id, opts.ownerId, opts.symbol ?? "AAA.US");
  return id;
}

function seedAlertEvent(db: DatabaseSync, opts: { ruleId: string; ownerId: string; feedback?: string | null }): void {
  db.prepare(`
    INSERT INTO alert_events (id, rule_id, owner_id, triggered_at, value, feedback)
    VALUES (?, ?, ?, '2026-07-10T00:00:00.000Z', 1.0, ?)
  `).run(createId("alert_event"), opts.ruleId, opts.ownerId, opts.feedback ?? null);
}

function seedPrediction(db: DatabaseSync, opts: { symbol?: string; confidence: "low" | "medium" | "high"; outcome: string | null }): void {
  db.prepare(`
    INSERT INTO analysis_predictions (id, symbol, report_path, conclusion, confidence, review_trigger, review_date, outcome, created_at)
    VALUES (?, ?, '/tmp/report.md', '测试结论', ?, NULL, NULL, ?, '2026-07-01T00:00:00.000Z')
  `).run(createId("analysis_prediction"), opts.symbol ?? "SYS.US", opts.confidence, opts.outcome);
}

// ---------------------------------------------------------------------------
// The rich deterministic fixture: one owner, every metric block populated
// with a KNOWN answer.
// ---------------------------------------------------------------------------

function seedRichFixture(db: DatabaseSync): void {
  seedMembers(db, [OWNER_A]);

  // --- predictionReview.selfThesisHitRate: n=12, hits=6, misses=6 -> 0.5 ---
  const hitThesis = seedThesis(db, { ownerId: OWNER_A, symbol: "HIT.US", direction: "bull", targetHigh: 120, invalidationPrice: 90 });
  seedStockFact(db, { symbol: "HIT.US", tradingDay: "2026-07-15", valueNum: 118 }); // closer to target -> toward_target
  seedJudgments(db, hitThesis, 6);

  const missThesis = seedThesis(db, { ownerId: OWNER_A, symbol: "MISS.US", direction: "bull", targetHigh: 120, invalidationPrice: 90 });
  seedStockFact(db, { symbol: "MISS.US", tradingDay: "2026-07-15", valueNum: 85 }); // closer to invalidation -> toward_invalidation
  seedJudgments(db, missThesis, 6);

  // --- predictionReview.systemConfidenceCalibration: low=none, medium=insufficient(3), high=ok(12, 3 hit/9 miss -> 0.25) ---
  seedPrediction(db, { confidence: "medium", outcome: "hit" });
  seedPrediction(db, { confidence: "medium", outcome: "hit" });
  seedPrediction(db, { confidence: "medium", outcome: "miss" });
  for (let i = 0; i < 3; i += 1) seedPrediction(db, { confidence: "high", outcome: "hit" });
  for (let i = 0; i < 9; i += 1) seedPrediction(db, { confidence: "high", outcome: "miss" });
  seedPrediction(db, { confidence: "high", outcome: null }); // pending - never counted
  seedPrediction(db, { confidence: "low", outcome: null }); // pending - never counted

  // --- decisionReview + disciplineReview shared fixture: QQQ benchmark ---
  seedStockFact(db, { symbol: "QQQ", tradingDay: "2026-07-01", valueNum: 400 });
  seedStockFact(db, { symbol: "QQQ", tradingDay: "2026-07-20", valueNum: 440 }); // QQQ +10% over the period

  // 10 "compliant" executed trades: entry 100 -> review 110 (+10%), pass:true.
  // The first one deliberately resolves its entry price via ticket_id ->
  // official_paper_order_lifecycle (limit_price 100) with a DECOY proposal.limit_price
  // (999) that must NOT be used, exercising that code path in both engines.
  const ruleId = seedDisciplineRule(db, { ownerId: OWNER_A });
  seedLifecycle(db, { ticketId: "TCK_OK0", symbol: "OK0.US", limitPrice: 100 });
  seedStockFact(db, { symbol: "OK0.US", tradingDay: "2026-07-20", valueNum: 110 });
  seedProposal(db, {
    ownerId: OWNER_A,
    symbol: "OK0.US",
    limitPrice: 999,
    ticketId: "TCK_OK0",
    disciplineReport: [{ ruleId, ruleText: "仓位≤30%", enforcement: "proposal_check", pass: true, detail: "ok" }]
  });
  for (let i = 1; i < 10; i += 1) {
    const symbol = `OK${i}.US`;
    seedStockFact(db, { symbol, tradingDay: "2026-07-20", valueNum: 110 });
    seedProposal(db, {
      ownerId: OWNER_A,
      symbol,
      limitPrice: 100,
      disciplineReport: [{ ruleId, ruleText: "仓位≤30%", enforcement: "proposal_check", pass: true, detail: "ok" }]
    });
  }

  // 10 "violating" executed trades: entry 100 -> review 95 (-5%), pass:false.
  for (let i = 0; i < 10; i += 1) {
    const symbol = `BAD${i}.US`;
    seedStockFact(db, { symbol, tradingDay: "2026-07-20", valueNum: 95 });
    seedProposal(db, {
      ownerId: OWNER_A,
      symbol,
      limitPrice: 100,
      disciplineReport: [{ ruleId, ruleText: "仓位≤30%", enforcement: "proposal_check", pass: false, detail: "over cap" }]
    });
  }

  // 1 rejected proposal: proposal price 100 -> review-day price 120 (+20% hypothetical).
  seedStockFact(db, { symbol: "REJ.US", tradingDay: "2026-07-20", valueNum: 120 });
  seedProposal(db, { ownerId: OWNER_A, symbol: "REJ.US", limitPrice: 100, status: "rejected" });

  // --- alertQuality: 4 triggered, 2 misreport-flagged -> 0.5 ---
  const alertRuleId = seedAlertRule(db, { ownerId: OWNER_A });
  seedAlertEvent(db, { ruleId: alertRuleId, ownerId: OWNER_A, feedback: "误报，阈值待调整" });
  seedAlertEvent(db, { ruleId: alertRuleId, ownerId: OWNER_A, feedback: "误报" });
  seedAlertEvent(db, { ruleId: alertRuleId, ownerId: OWNER_A, feedback: null });
  seedAlertEvent(db, { ruleId: alertRuleId, ownerId: OWNER_A, feedback: "已核实" });
}

// ---------------------------------------------------------------------------
// THE GATE: primary === verifier, headline-number by headline-number.
// ---------------------------------------------------------------------------

describe("review-consistency gate: buildMonthlyReview (primary) vs recomputeReviewMetrics (verifier)", () => {
  it("agree exactly on every headline number for a rich, deterministic, multi-block fixture", () => {
    const db = memoryDb();
    seedRichFixture(db);

    const primaryResult = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });
    const verifierResult = recomputeReviewMetrics({ db, ownerId: OWNER_A, period: PERIOD, now: NOW });

    // Sanity: the fixture actually produced non-trivial "ok" samples
    // everywhere, not a wall of "insufficient"/"none" that would make this
    // gate vacuous.
    expect(primaryResult.predictionReview.selfThesisHitRate).toEqual({ sample: "ok", n: 12, hits: 6, total: 12, hitFraction: 0.5 });
    expect(primaryResult.decisionReview.executed.sample).toBe("ok");
    expect(primaryResult.disciplineReview.complianceRate.sample).toBe("ok");
    expect(primaryResult.disciplineReview.complianceValue.compliant.sample).toBe("ok");
    expect(primaryResult.disciplineReview.complianceValue.violating.sample).toBe("ok");
    expect(primaryResult.alertQuality.sample).toBe("ok");

    // The actual gate: every headline number, primary vs. verifier.
    expect(verifierResult.predictionReview.selfThesisHitRate).toEqual(primaryResult.predictionReview.selfThesisHitRate);
    expect(verifierResult.predictionReview.systemConfidenceCalibration).toEqual(
      primaryResult.predictionReview.systemConfidenceCalibration
    );
    expect(verifierResult.decisionReview.executed).toEqual(primaryResult.decisionReview.executed);
    expect(verifierResult.decisionReview.rejected).toEqual(primaryResult.decisionReview.rejected);
    expect(verifierResult.disciplineReview.complianceRate).toEqual(primaryResult.disciplineReview.complianceRate);
    expect(verifierResult.disciplineReview.complianceValue).toEqual(primaryResult.disciplineReview.complianceValue);
    expect(verifierResult.alertQuality).toEqual(primaryResult.alertQuality);

    // And the actual comparison helper reviews.mjs's runtime self-check uses:
    expect(compareReviewMetrics(primaryResult, verifierResult)).toEqual([]);
  });

  it("agrees on an all-empty-state owner too (no vacuous 'both threw' pass)", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);

    const primaryResult = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });
    const verifierResult = recomputeReviewMetrics({ db, ownerId: OWNER_A, period: PERIOD, now: NOW });

    expect(compareReviewMetrics(primaryResult, verifierResult)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Bad sample: the gate must have teeth. Corrupting ONE headline number in
  // the primary's own result_json (simulating a fabricated/mis-typed figure)
  // must be caught by compareReviewMetrics.
  // -------------------------------------------------------------------------

  it("catches a corrupted selfThesisHitRate.hitFraction", () => {
    const db = memoryDb();
    seedRichFixture(db);
    const primaryResult = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });
    const verifierResult = recomputeReviewMetrics({ db, ownerId: OWNER_A, period: PERIOD, now: NOW });

    const corrupted = JSON.parse(JSON.stringify(primaryResult));
    corrupted.predictionReview.selfThesisHitRate.hitFraction = 0.99; // fabricated

    const mismatches = compareReviewMetrics(corrupted, verifierResult);
    expect(mismatches.length).toBeGreaterThan(0);
    expect(mismatches.some((m: { path: string }) => m.path === "predictionReview.selfThesisHitRate.hitFraction")).toBe(true);
  });

  it("catches a corrupted confidence-calibration tier hitFraction", () => {
    const db = memoryDb();
    seedRichFixture(db);
    const primaryResult = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });
    const verifierResult = recomputeReviewMetrics({ db, ownerId: OWNER_A, period: PERIOD, now: NOW });

    const corrupted = JSON.parse(JSON.stringify(primaryResult));
    const highTierIndex = corrupted.predictionReview.systemConfidenceCalibration.findIndex((t: { tier: string }) => t.tier === "high");
    corrupted.predictionReview.systemConfidenceCalibration[highTierIndex].hitFraction = 0.9; // fabricated

    const mismatches = compareReviewMetrics(corrupted, verifierResult);
    expect(mismatches.length).toBeGreaterThan(0);
    expect(
      mismatches.some((m: { path: string }) => m.path === `predictionReview.systemConfidenceCalibration[${highTierIndex}].hitFraction`)
    ).toBe(true);
  });

  it("catches a corrupted decisionReview.executed.avgAlphaPct (fabricated 收益对比)", () => {
    const db = memoryDb();
    seedRichFixture(db);
    const primaryResult = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });
    const verifierResult = recomputeReviewMetrics({ db, ownerId: OWNER_A, period: PERIOD, now: NOW });

    const corrupted = JSON.parse(JSON.stringify(primaryResult));
    corrupted.decisionReview.executed.avgAlphaPct = 12345;

    const mismatches = compareReviewMetrics(corrupted, verifierResult);
    expect(mismatches.length).toBeGreaterThan(0);
    expect(mismatches.some((m: { path: string }) => m.path === "decisionReview.executed.avgAlphaPct")).toBe(true);
  });

  it("catches a corrupted disciplineReview.complianceRate.rate (fabricated 遵守率)", () => {
    const db = memoryDb();
    seedRichFixture(db);
    const primaryResult = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });
    const verifierResult = recomputeReviewMetrics({ db, ownerId: OWNER_A, period: PERIOD, now: NOW });

    const corrupted = JSON.parse(JSON.stringify(primaryResult));
    corrupted.disciplineReview.complianceRate.rate = 1;

    const mismatches = compareReviewMetrics(corrupted, verifierResult);
    expect(mismatches.length).toBeGreaterThan(0);
    expect(mismatches.some((m: { path: string }) => m.path === "disciplineReview.complianceRate.rate")).toBe(true);
  });

  it("catches a corrupted alertQuality.misreportRate (fabricated 误报率)", () => {
    const db = memoryDb();
    seedRichFixture(db);
    const primaryResult = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });
    const verifierResult = recomputeReviewMetrics({ db, ownerId: OWNER_A, period: PERIOD, now: NOW });

    const corrupted = JSON.parse(JSON.stringify(primaryResult));
    corrupted.alertQuality.misreportRate = 0;

    const mismatches = compareReviewMetrics(corrupted, verifierResult);
    expect(mismatches.length).toBeGreaterThan(0);
    expect(mismatches.some((m: { path: string }) => m.path === "alertQuality.misreportRate")).toBe(true);
  });

  it("a perfectly-matching pair still reports zero mismatches (no false positives)", () => {
    const db = memoryDb();
    seedRichFixture(db);
    const primaryResult = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });
    const verifierResult = recomputeReviewMetrics({ db, ownerId: OWNER_A, period: PERIOD, now: NOW });

    expect(compareReviewMetrics(primaryResult, verifierResult)).toEqual([]);
  });
});
