import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { MemberRepository, createId, migrate, type Member } from "../../../packages/shared-types/dist/index.js";

// Two of the three injected helpers (`loadLatestPriceForSymbol`,
// `computeComplianceStats`) exist ONLY as TypeScript in
// apps/platform-app/src/data/strategy.ts - see review-engine.mjs's own
// header comment for why they are received via `helpers` rather than
// imported there. This test file is free to reach across that same app
// boundary for TEST WIRING purposes (vitest/esbuild strips types at the file
// level regardless of which app a relative path points into; apps/
// openclaw-config has no package.json/tsconfig of its own, so nothing here
// is part of any `tsc --build` project reference graph or `pnpm typecheck`
// run - only `vitest run` ever executes these files, exactly like every
// other *.test.ts already living alongside the *.mjs files in this
// directory) - the REAL implementations are used below, not stand-ins, so
// these tests exercise the exact arithmetic production wiring will run.
import { computeComplianceStats, loadLatestPriceForSymbol } from "../../platform-app/src/data/strategy.js";
// `computeThesisOutcome` has a same-app, zero-build-step implementation
// right here - no boundary crossing needed for this one.
import { computeThesisOutcome } from "./thesis-outcome.mjs";

const mod = await import("./review-engine.mjs");
const { buildMonthlyReview, beijingMonthUtcRange } = mod;

const HELPERS = { computeThesisOutcome, loadLatestPriceForSymbol, computeComplianceStats };

const OWNER_A = "member_a";
const OWNER_B = "member_b";
const PERIOD = "2026-07";
const NOW = "2026-07-20T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Seed helpers (mirrors apps/platform-app/src/data/strategy.test.ts's own
// seed* helper conventions for the same tables).
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
    createdAt?: string;
  }
): string {
  const id = createId("thesis");
  db.prepare(`
    INSERT INTO theses (id, owner_id, symbol, direction, target_low, target_high, invalidation_price, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.ownerId,
    opts.symbol,
    opts.direction ?? "bull",
    opts.targetLow ?? null,
    opts.targetHigh ?? null,
    opts.invalidationPrice ?? null,
    opts.createdAt ?? "2026-01-01T00:00:00.000Z",
    opts.createdAt ?? "2026-01-01T00:00:00.000Z"
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
    id?: string;
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
  const id = opts.id ?? createId("proposal");
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

function seedDisciplineRule(db: DatabaseSync, opts: { ownerId: string; ruleText?: string }): string {
  const id = createId("discipline_rule");
  db.prepare(`
    INSERT INTO discipline_rules (id, owner_id, rule_text, enforcement, enabled, created_at)
    VALUES (?, ?, ?, 'proposal_check', 1, '2026-01-01T00:00:00.000Z')
  `).run(id, opts.ownerId, opts.ruleText ?? "仓位≤30%");
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

function seedAlertEvent(
  db: DatabaseSync,
  opts: { ruleId: string; ownerId: string; triggeredAt?: string; feedback?: string | null }
): void {
  db.prepare(`
    INSERT INTO alert_events (id, rule_id, owner_id, triggered_at, value, feedback)
    VALUES (?, ?, ?, ?, 1.0, ?)
  `).run(createId("alert_event"), opts.ruleId, opts.ownerId, opts.triggeredAt ?? "2026-07-10T00:00:00.000Z", opts.feedback ?? null);
}

function seedPrediction(
  db: DatabaseSync,
  opts: { symbol?: string; confidence: "low" | "medium" | "high"; outcome: string | null }
): void {
  db.prepare(`
    INSERT INTO analysis_predictions (id, symbol, report_path, conclusion, confidence, review_trigger, review_date, outcome, created_at)
    VALUES (?, ?, '/tmp/report.md', '测试结论', ?, NULL, NULL, ?, '2026-07-01T00:00:00.000Z')
  `).run(createId("analysis_prediction"), opts.symbol ?? "SYS.US", opts.confidence, opts.outcome);
}

// ---------------------------------------------------------------------------
// beijingMonthUtcRange
// ---------------------------------------------------------------------------

describe("beijingMonthUtcRange", () => {
  it("returns the half-open Beijing-calendar-month UTC range", () => {
    const { periodStart, periodEnd } = beijingMonthUtcRange("2026-07");
    expect(periodStart).toBe(new Date("2026-07-01T00:00:00+08:00").toISOString());
    expect(periodEnd).toBe(new Date("2026-08-01T00:00:00+08:00").toISOString());
  });

  it("rolls over across a year boundary (December)", () => {
    const { periodEnd } = beijingMonthUtcRange("2026-12");
    expect(periodEnd).toBe(new Date("2027-01-01T00:00:00+08:00").toISOString());
  });

  it("rejects a malformed period", () => {
    expect(() => beijingMonthUtcRange("2026/07")).toThrow(/Invalid period/);
    expect(() => beijingMonthUtcRange("not-a-period")).toThrow(/Invalid period/);
  });
});

// ---------------------------------------------------------------------------
// buildMonthlyReview: input validation
// ---------------------------------------------------------------------------

describe("buildMonthlyReview: input validation", () => {
  it("throws without a db handle", () => {
    expect(() => buildMonthlyReview({ ownerId: OWNER_A, period: PERIOD, helpers: HELPERS })).toThrow(/db handle/);
  });

  it("throws without ownerId", () => {
    const db = memoryDb();
    expect(() => buildMonthlyReview({ db, period: PERIOD, helpers: HELPERS })).toThrow(/ownerId/);
  });

  it("throws without period", () => {
    const db = memoryDb();
    expect(() => buildMonthlyReview({ db, ownerId: OWNER_A, helpers: HELPERS })).toThrow(/period/);
  });

  it("throws without the required helpers", () => {
    const db = memoryDb();
    expect(() => buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, helpers: {} })).toThrow(/helpers/);
    expect(() =>
      buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, helpers: { computeThesisOutcome } })
    ).toThrow(/helpers/);
  });
});

// ---------------------------------------------------------------------------
// predictionReview.selfThesisHitRate
// ---------------------------------------------------------------------------

describe("predictionReview.selfThesisHitRate", () => {
  it("n < 10 -> sample insufficient, no rate exposed", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);
    const thesisId = seedThesis(db, { ownerId: OWNER_A, symbol: "AAA.US", direction: "bull", targetHigh: 120, invalidationPrice: 90 });
    seedStockFact(db, { symbol: "AAA.US", tradingDay: "2026-07-15", valueNum: 118 });
    seedJudgments(db, thesisId, 5);

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(result.predictionReview.selfThesisHitRate).toEqual({ sample: "insufficient", n: 5 });
  });

  it("n >= 10, price near target -> sample ok, hitFraction 1.0", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);
    const thesisId = seedThesis(db, { ownerId: OWNER_A, symbol: "AAA.US", direction: "bull", targetHigh: 120, invalidationPrice: 90 });
    seedStockFact(db, { symbol: "AAA.US", tradingDay: "2026-07-15", valueNum: 118 }); // closer to 120 than 90
    seedJudgments(db, thesisId, 10);

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(result.predictionReview.selfThesisHitRate).toEqual({ sample: "ok", n: 10, hits: 10, total: 10, hitFraction: 1 });
  });

  it("no price on record -> sample insufficient with a reason, even at n >= 10", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);
    const thesisId = seedThesis(db, { ownerId: OWNER_A, symbol: "NOPRICE.US", direction: "bull", targetHigh: 120, invalidationPrice: 90 });
    seedJudgments(db, thesisId, 10);

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(result.predictionReview.selfThesisHitRate.sample).toBe("insufficient");
    expect(result.predictionReview.selfThesisHitRate.n).toBe(10);
    expect(result.predictionReview.selfThesisHitRate.reason).toMatch(/无法计算方向命中率/);
  });

  it("aggregates hits/misses across MULTIPLE theses (not per-thesis)", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);
    const hitThesis = seedThesis(db, { ownerId: OWNER_A, symbol: "HIT.US", direction: "bull", targetHigh: 120, invalidationPrice: 90 });
    seedStockFact(db, { symbol: "HIT.US", tradingDay: "2026-07-15", valueNum: 118 }); // toward_target
    seedJudgments(db, hitThesis, 6);

    const missThesis = seedThesis(db, { ownerId: OWNER_A, symbol: "MISS.US", direction: "bull", targetHigh: 120, invalidationPrice: 90 });
    seedStockFact(db, { symbol: "MISS.US", tradingDay: "2026-07-15", valueNum: 85 }); // toward_invalidation
    seedJudgments(db, missThesis, 6);

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(result.predictionReview.selfThesisHitRate).toEqual({ sample: "ok", n: 12, hits: 6, total: 12, hitFraction: 0.5 });
  });

  it("owner isolation: B's theses/judgments never counted in A's review", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A, OWNER_B]);
    const bThesis = seedThesis(db, { ownerId: OWNER_B, symbol: "BONLY.US", direction: "bull", targetHigh: 120, invalidationPrice: 90 });
    seedStockFact(db, { symbol: "BONLY.US", tradingDay: "2026-07-15", valueNum: 118 });
    seedJudgments(db, bThesis, 10);

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(result.predictionReview.selfThesisHitRate).toEqual({ sample: "insufficient", n: 0 });
  });
});

// ---------------------------------------------------------------------------
// predictionReview.systemConfidenceCalibration (PUBLIC, not owner-filtered)
// ---------------------------------------------------------------------------

describe("predictionReview.systemConfidenceCalibration", () => {
  it("buckets by confidence tier with none/insufficient/ok sample labels, excludes pending (outcome NULL) rows", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);
    // low: zero graded rows -> none
    // medium: 3 graded rows -> insufficient
    seedPrediction(db, { confidence: "medium", outcome: "hit" });
    seedPrediction(db, { confidence: "medium", outcome: "hit" });
    seedPrediction(db, { confidence: "medium", outcome: "miss" });
    // high: 12 graded rows (3 hit, 9 miss) -> ok, hitFraction 0.25
    for (let i = 0; i < 3; i += 1) seedPrediction(db, { confidence: "high", outcome: "hit" });
    for (let i = 0; i < 9; i += 1) seedPrediction(db, { confidence: "high", outcome: "miss" });
    // pending rows (outcome NULL) must never be counted
    seedPrediction(db, { confidence: "high", outcome: null });
    seedPrediction(db, { confidence: "low", outcome: null });

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });
    const byTier = Object.fromEntries(result.predictionReview.systemConfidenceCalibration.map((t: any) => [t.tier, t]));

    expect(byTier.low).toEqual({ tier: "low", sample: "none", n: 0 });
    expect(byTier.medium).toEqual({ tier: "medium", sample: "insufficient", n: 3 });
    expect(byTier.high).toEqual({ tier: "high", sample: "ok", n: 12, hits: 3, hitFraction: 0.25 });
  });

  it("is NOT owner-filtered: identical for two different owners against the same db", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A, OWNER_B]);
    for (let i = 0; i < 10; i += 1) seedPrediction(db, { confidence: "high", outcome: i < 6 ? "hit" : "miss" });

    const resultA = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });
    const resultB = buildMonthlyReview({ db, ownerId: OWNER_B, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(resultA.predictionReview.systemConfidenceCalibration).toEqual(resultB.predictionReview.systemConfidenceCalibration);
  });
});

// ---------------------------------------------------------------------------
// decisionReview
// ---------------------------------------------------------------------------

describe("decisionReview", () => {
  it("empty data -> executed and rejected both empty-state, never fabricated", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(result.decisionReview.executed).toEqual({ sample: "none", n: 0, priced: 0, entries: [] });
    expect(result.decisionReview.rejected.sample).toBe("none");
    expect(result.decisionReview.rejected.n).toBe(0);
  });

  it("resolves entry price from proposal.limit_price when no ticket_id/lifecycle row exists", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);
    seedStockFact(db, { symbol: "QQQ", tradingDay: "2026-07-01", valueNum: 400 });
    seedStockFact(db, { symbol: "QQQ", tradingDay: "2026-07-20", valueNum: 440 });
    seedStockFact(db, { symbol: "AAA.US", tradingDay: "2026-07-20", valueNum: 110 });
    seedProposal(db, { ownerId: OWNER_A, symbol: "AAA.US", side: "buy", limitPrice: 100, createdAt: "2026-07-05T00:00:00.000Z" });

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });
    const entry = result.decisionReview.executed.entries[0];

    expect(entry.entryPrice).toBe(100);
    expect(entry.reviewPrice).toBe(110);
    expect(entry.decisionReturnPct).toBe(10);
    expect(entry.benchmarkEntryPrice).toBe(400);
    expect(entry.benchmarkReviewPrice).toBe(440);
    expect(entry.benchmarkReturnPct).toBe(10);
    expect(entry.alphaPct).toBe(0);
    expect(result.decisionReview.executed.sample).toBe("insufficient"); // n=1 < 10
  });

  it("prefers the lifecycle row's limit_price over the proposal's own limit_price (ticket_id link)", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);
    seedStockFact(db, { symbol: "QQQ", tradingDay: "2026-07-01", valueNum: 400 });
    seedStockFact(db, { symbol: "QQQ", tradingDay: "2026-07-20", valueNum: 440 });
    seedStockFact(db, { symbol: "BBB.US", tradingDay: "2026-07-20", valueNum: 60.5 });
    seedLifecycle(db, { ticketId: "TCK1", symbol: "BBB.US", limitPrice: 55 });
    seedProposal(db, {
      ownerId: OWNER_A,
      symbol: "BBB.US",
      side: "buy",
      limitPrice: 50, // deliberately different from the lifecycle's 55 - lifecycle must win
      ticketId: "TCK1",
      createdAt: "2026-07-05T00:00:00.000Z"
    });

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });
    const entry = result.decisionReview.executed.entries[0];

    expect(entry.entryPrice).toBe(55);
    expect(entry.decisionReturnPct).toBe(10);
  });

  it("sell side is direction-aware: price falling after a sell is a POSITIVE decision return", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);
    seedStockFact(db, { symbol: "QQQ", tradingDay: "2026-07-01", valueNum: 400 });
    seedStockFact(db, { symbol: "QQQ", tradingDay: "2026-07-20", valueNum: 440 });
    seedStockFact(db, { symbol: "CCC.US", tradingDay: "2026-07-20", valueNum: 180 });
    seedProposal(db, { ownerId: OWNER_A, symbol: "CCC.US", side: "sell", limitPrice: 200, createdAt: "2026-07-05T00:00:00.000Z" });

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });
    const entry = result.decisionReview.executed.entries[0];

    expect(entry.decisionReturnPct).toBe(10); // sold at 200, now 180 - avoided a 10% decline
  });

  it("aggregates avgDecisionReturnPct/avgBenchmarkReturnPct/avgAlphaPct once priced count reaches 10", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);
    seedStockFact(db, { symbol: "QQQ", tradingDay: "2026-07-01", valueNum: 400 });
    seedStockFact(db, { symbol: "QQQ", tradingDay: "2026-07-20", valueNum: 440 });
    for (let i = 0; i < 10; i += 1) {
      const symbol = `SYM${i}.US`;
      seedStockFact(db, { symbol, tradingDay: "2026-07-20", valueNum: 110 });
      seedProposal(db, { ownerId: OWNER_A, symbol, side: "buy", limitPrice: 100, createdAt: "2026-07-05T00:00:00.000Z" });
    }

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(result.decisionReview.executed.sample).toBe("ok");
    expect(result.decisionReview.executed.n).toBe(10);
    expect(result.decisionReview.executed.priced).toBe(10);
    expect(result.decisionReview.executed.avgDecisionReturnPct).toBe(10);
    expect(result.decisionReview.executed.avgBenchmarkReturnPct).toBe(10);
    expect(result.decisionReview.executed.avgAlphaPct).toBe(0);
  });

  it("rejected proposals get the simplified proposal-price -> review-day-price calc plus the fixed disclaimer", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);
    seedStockFact(db, { symbol: "REJ.US", tradingDay: "2026-07-20", valueNum: 120 });
    seedProposal(db, {
      ownerId: OWNER_A,
      symbol: "REJ.US",
      side: "buy",
      limitPrice: 100,
      status: "rejected",
      createdAt: "2026-07-05T00:00:00.000Z"
    });

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(result.decisionReview.rejected.sample).toBe("ok");
    expect(result.decisionReview.rejected.n).toBe(1);
    const entry = result.decisionReview.rejected.entries[0];
    expect(entry.hypotheticalReturnPct).toBe(20);
    expect(entry.disclaimer).toBe("未执行，仅口径参考");
  });

  it("owner isolation: B's executed proposal never appears in A's decisionReview", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A, OWNER_B]);
    seedStockFact(db, { symbol: "BONLY.US", tradingDay: "2026-07-20", valueNum: 110 });
    seedProposal(db, { ownerId: OWNER_B, symbol: "BONLY.US", side: "buy", limitPrice: 100, createdAt: "2026-07-05T00:00:00.000Z" });

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(result.decisionReview.executed).toEqual({ sample: "none", n: 0, priced: 0, entries: [] });
  });

  it("proposals outside the period window are excluded", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);
    seedStockFact(db, { symbol: "OUT.US", tradingDay: "2026-07-20", valueNum: 110 });
    seedProposal(db, { ownerId: OWNER_A, symbol: "OUT.US", side: "buy", limitPrice: 100, createdAt: "2026-06-15T00:00:00.000Z" });

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(result.decisionReview.executed.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// disciplineReview
// ---------------------------------------------------------------------------

describe("disciplineReview.complianceRate", () => {
  it("no discipline_rules / no checks -> sample none", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(result.disciplineReview.complianceRate).toEqual({ sample: "none" });
  });

  it("checked < 10 -> sample insufficient, no rate exposed", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);
    const ruleId = seedDisciplineRule(db, { ownerId: OWNER_A });
    for (let i = 0; i < 3; i += 1) {
      seedProposal(db, {
        ownerId: OWNER_A,
        symbol: `S${i}.US`,
        createdAt: "2026-07-05T00:00:00.000Z",
        disciplineReport: [{ ruleId, ruleText: "仓位≤30%", enforcement: "proposal_check", pass: true, detail: "ok" }]
      });
    }

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(result.disciplineReview.complianceRate).toEqual({ sample: "insufficient", checked: 3 });
  });

  it("checked >= 10 -> sample ok with a real compliance rate", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);
    const ruleId = seedDisciplineRule(db, { ownerId: OWNER_A });
    for (let i = 0; i < 8; i += 1) {
      seedProposal(db, {
        ownerId: OWNER_A,
        symbol: `P${i}.US`,
        createdAt: "2026-07-05T00:00:00.000Z",
        disciplineReport: [{ ruleId, ruleText: "仓位≤30%", enforcement: "proposal_check", pass: true, detail: "ok" }]
      });
    }
    for (let i = 0; i < 2; i += 1) {
      seedProposal(db, {
        ownerId: OWNER_A,
        symbol: `F${i}.US`,
        createdAt: "2026-07-06T00:00:00.000Z",
        disciplineReport: [{ ruleId, ruleText: "仓位≤30%", enforcement: "proposal_check", pass: false, detail: "over cap" }]
      });
    }

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(result.disciplineReview.complianceRate).toEqual({ sample: "ok", checked: 10, passed: 8, failed: 2, rate: 0.8 });
  });
});

describe("disciplineReview.complianceValue (守规矩值多少钱)", () => {
  it("small sample (< 10 per bucket) -> both buckets flagged insufficient/none, no delta", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);
    seedStockFact(db, { symbol: "QQQ", tradingDay: "2026-07-01", valueNum: 400 });
    seedStockFact(db, { symbol: "QQQ", tradingDay: "2026-07-20", valueNum: 440 });
    seedStockFact(db, { symbol: "CMP.US", tradingDay: "2026-07-20", valueNum: 110 });
    seedProposal(db, {
      ownerId: OWNER_A,
      symbol: "CMP.US",
      limitPrice: 100,
      createdAt: "2026-07-05T00:00:00.000Z",
      disciplineReport: [{ ruleId: "r1", pass: true }]
    });

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(result.disciplineReview.complianceValue.compliant.sample).toBe("insufficient");
    expect(result.disciplineReview.complianceValue.violating.sample).toBe("none");
    expect(result.disciplineReview.complianceValue.deltaPct).toBeNull();
  });

  it("n >= 10 per bucket -> ok with a real return delta between compliant and violating trades", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);
    seedStockFact(db, { symbol: "QQQ", tradingDay: "2026-07-01", valueNum: 400 });
    seedStockFact(db, { symbol: "QQQ", tradingDay: "2026-07-20", valueNum: 440 });

    for (let i = 0; i < 10; i += 1) {
      const symbol = `OK${i}.US`;
      seedStockFact(db, { symbol, tradingDay: "2026-07-20", valueNum: 110 }); // +10% decision return
      seedProposal(db, {
        ownerId: OWNER_A,
        symbol,
        limitPrice: 100,
        createdAt: "2026-07-05T00:00:00.000Z",
        disciplineReport: [{ ruleId: "r1", pass: true }]
      });
    }
    for (let i = 0; i < 10; i += 1) {
      const symbol = `BAD${i}.US`;
      seedStockFact(db, { symbol, tradingDay: "2026-07-20", valueNum: 95 }); // -5% decision return
      seedProposal(db, {
        ownerId: OWNER_A,
        symbol,
        limitPrice: 100,
        createdAt: "2026-07-05T00:00:00.000Z",
        disciplineReport: [{ ruleId: "r1", pass: false }]
      });
    }

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });
    const { complianceValue } = result.disciplineReview;

    expect(complianceValue.compliant).toEqual({ sample: "ok", n: 10, avgReturnPct: 10 });
    expect(complianceValue.violating).toEqual({ sample: "ok", n: 10, avgReturnPct: -5 });
    expect(complianceValue.deltaPct).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// alertQuality
// ---------------------------------------------------------------------------

describe("alertQuality", () => {
  it("no alert_events in period -> sample none", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(result.alertQuality).toEqual({ sample: "none", triggeredCount: 0, misreportCount: 0, misreportRate: null });
  });

  it("computes triggered/misreport counts and rate from feedback containing '误报'", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);
    const ruleId = seedAlertRule(db, { ownerId: OWNER_A });
    seedAlertEvent(db, { ruleId, ownerId: OWNER_A, feedback: "误报，阈值待调整" });
    seedAlertEvent(db, { ruleId, ownerId: OWNER_A, feedback: "误报" });
    seedAlertEvent(db, { ruleId, ownerId: OWNER_A, feedback: null });
    seedAlertEvent(db, { ruleId, ownerId: OWNER_A, feedback: "已核实" });

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(result.alertQuality).toEqual({ sample: "ok", triggeredCount: 4, misreportCount: 2, misreportRate: 0.5 });
  });

  it("events outside the period window are excluded", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);
    const ruleId = seedAlertRule(db, { ownerId: OWNER_A });
    seedAlertEvent(db, { ruleId, ownerId: OWNER_A, triggeredAt: "2026-06-01T00:00:00.000Z", feedback: "误报" });

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(result.alertQuality.sample).toBe("none");
  });

  it("owner isolation: B's alert_events never appear in A's alertQuality", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A, OWNER_B]);
    const ruleId = seedAlertRule(db, { ownerId: OWNER_B });
    seedAlertEvent(db, { ruleId, ownerId: OWNER_B, feedback: "误报" });

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(result.alertQuality.sample).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// errorCategories / oneLineLesson / nextSteps / improvementSuggestions
// (deterministic rule-based mapping - NOT LLM)
// ---------------------------------------------------------------------------

describe("deterministic suggestion mapping", () => {
  it("empty/normal data -> default lesson, default next step, no categories, no suggestion items", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(result.errorCategories).toEqual([]);
    expect(result.oneLineLesson).toBe("本月各项指标样本不足或表现正常，暂无可归纳的一句话教训。");
    expect(result.nextSteps).toEqual(["暂无下一步动作建议——数据不足或本月各项指标均在正常范围内。"]);
    expect(result.improvementSuggestions).toEqual({
      disclaimer: "以上为规则推导的改进建议，仅供参考；任何策略/纪律变更须本人在飞书或 CLI 中手动确认后生效。",
      items: []
    });
  });

  it("low compliance rate (< 80%, n >= 10) triggers a 策略纪律 suggestion", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);
    const ruleId = seedDisciplineRule(db, { ownerId: OWNER_A });
    for (let i = 0; i < 5; i += 1) {
      seedProposal(db, {
        ownerId: OWNER_A,
        symbol: `P${i}.US`,
        createdAt: "2026-07-05T00:00:00.000Z",
        disciplineReport: [{ ruleId, pass: true }]
      });
    }
    for (let i = 0; i < 5; i += 1) {
      seedProposal(db, {
        ownerId: OWNER_A,
        symbol: `F${i}.US`,
        createdAt: "2026-07-06T00:00:00.000Z",
        disciplineReport: [{ ruleId, pass: false }]
      });
    }

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(result.errorCategories).toContain("策略纪律");
    expect(result.oneLineLesson).toMatch(/遵守率/);
  });

  it("high-tier system confidence hit rate below 50% triggers a 系统置信度校准 suggestion (labeled system-level)", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);
    for (let i = 0; i < 3; i += 1) seedPrediction(db, { confidence: "high", outcome: "hit" });
    for (let i = 0; i < 9; i += 1) seedPrediction(db, { confidence: "high", outcome: "miss" });

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(result.errorCategories).toContain("系统置信度校准");
    expect(result.improvementSuggestions.items.some((s: string) => s.includes("系统级"))).toBe(true);
  });

  it("negative average alpha (executed underperforms QQQ) triggers a 决策择时 suggestion", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);
    seedStockFact(db, { symbol: "QQQ", tradingDay: "2026-07-01", valueNum: 400 });
    seedStockFact(db, { symbol: "QQQ", tradingDay: "2026-07-20", valueNum: 440 }); // QQQ +10%
    for (let i = 0; i < 10; i += 1) {
      const symbol = `LAG${i}.US`;
      seedStockFact(db, { symbol, tradingDay: "2026-07-20", valueNum: 100 }); // 0% decision return
      seedProposal(db, { ownerId: OWNER_A, symbol, limitPrice: 100, createdAt: "2026-07-05T00:00:00.000Z" });
    }

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(result.decisionReview.executed.avgAlphaPct).toBe(-10);
    expect(result.errorCategories).toContain("决策择时");
  });

  it("misreport rate above 30% triggers a 提醒质量 suggestion", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);
    const ruleId = seedAlertRule(db, { ownerId: OWNER_A });
    seedAlertEvent(db, { ruleId, ownerId: OWNER_A, feedback: "误报" });
    seedAlertEvent(db, { ruleId, ownerId: OWNER_A, feedback: "误报" });
    seedAlertEvent(db, { ruleId, ownerId: OWNER_A, feedback: null });

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(result.errorCategories).toContain("提醒质量");
  });
});

// ---------------------------------------------------------------------------
// Full-shape / integration
// ---------------------------------------------------------------------------

describe("buildMonthlyReview: overall result shape", () => {
  it("brand-new owner with zero rows anywhere -> every block is an honest empty state, never fabricated", () => {
    const db = memoryDb();
    seedMembers(db, [OWNER_A]);

    const result = buildMonthlyReview({ db, ownerId: OWNER_A, period: PERIOD, now: NOW, helpers: HELPERS });

    expect(result.ownerId).toBe(OWNER_A);
    expect(result.period).toBe(PERIOD);
    expect(result.generatedAt).toBe(NOW);
    expect(result.predictionReview.selfThesisHitRate).toEqual({ sample: "insufficient", n: 0 });
    expect(result.predictionReview.systemConfidenceCalibration.every((t: any) => t.sample === "none")).toBe(true);
    expect(result.decisionReview.executed.sample).toBe("none");
    expect(result.decisionReview.rejected.sample).toBe("none");
    expect(result.disciplineReview.complianceRate).toEqual({ sample: "none" });
    expect(result.disciplineReview.complianceValue.compliant.sample).toBe("none");
    expect(result.disciplineReview.complianceValue.violating.sample).toBe("none");
    expect(result.alertQuality.sample).toBe("none");
    expect(result.errorCategories).toEqual([]);
  });
});
