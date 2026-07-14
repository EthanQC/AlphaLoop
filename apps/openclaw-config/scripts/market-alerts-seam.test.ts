// CLI -> store -> engine seam test (whole-branch-review's key recommendation,
// task P2-6 fix round). Unit tests on each layer in isolation can't catch a
// defect that only exists at the SEAM between them - exactly how C1 (runAdd
// hardcoding hysteresis: 0) slipped past every existing test: the CLI's own
// tests never fed the stored rule into the real engine, and the engine's own
// tests always constructed hysteresis by hand (usually the spec's correct
// 0.01), never through runAdd's actual default.
//
// This file wires all three real layers together with no mocks:
//   1. create a rule through the CLI's real runAdd (against a real temp
//      SQLite db, via openTradingDatabase - not an in-memory fake),
//   2. read it back through store.listEnabledRules (exactly as the poller
//      would),
//   3. feed a flapping price/exposure sequence into the REAL evaluateAll
//      (market-alerts-engine.mjs, zero mocks) and assert the fire count.
//
// Per the task brief: a price/ratio wobbling +-0.1% around the rule's
// threshold, 5-minute cadence, ~8 samples - the exact shape that (pre-fix)
// fires repeatedly with hysteresis 0 and (post-fix) fires exactly once with
// the spec's 0.01 hysteresis.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { MemberRepository, openTradingDatabase } from "../../../packages/shared-types/dist/index.js";

const cli = await import("./market-alerts.mjs");
const store = await import("./market-alerts-store.mjs");
const engine = await import("./market-alerts-engine.mjs");

const tempDirs: string[] = [];

function makeDb(): { db: DatabaseSync; options: { dbPath: string } } {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-market-alerts-seam-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "trading.sqlite");
  const db = openTradingDatabase(dbPath);
  return { db, options: { dbPath } };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function seedMember(db: DatabaseSync, id = "member_1"): void {
  new MemberRepository(db).upsert({
    id,
    email: `${id}@example.com`,
    displayName: id,
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z"
  });
}

function seedTarget(db: DatabaseSync, symbol: string, ownerId: string | null): void {
  // Schema v7 (task H3) rebuilt stock_analysis_targets with a composite
  // PRIMARY KEY (symbol, owner_id) and owner_id NOT NULL. A caller passing
  // `null` here means "seed the legacy shared-pool shape", so normalize it
  // to the migration's sentinel ('__legacy_shared__') rather than a raw SQL
  // NULL, which the NOT NULL constraint would now reject outright.
  const normalizedOwnerId = ownerId ?? "__legacy_shared__";
  db.prepare(`
    INSERT INTO stock_analysis_targets (symbol, owner_id, active, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(symbol, owner_id) DO UPDATE SET active = excluded.active, updated_at = excluded.updated_at
  `).run(symbol, normalizedOwnerId, "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
}

// Runs `rule` against a fixed sequence of samples, threading runtimes/quota
// forward across ticks exactly the way the real poller (via store.persistCycle)
// would, and returns the total number of fires across the whole sequence.
function runFlappingSequence(
  rule: Record<string, unknown>,
  buildSample: (tickIndex: number, atIso: string, tradingDay: string) => Record<string, unknown>
): number {
  let runtimes: Record<string, unknown> = {};
  let quotaByOwner: Record<string, number> = {};
  let fireCount = 0;

  const tradingDay = "2026-07-01";
  const baseMs = new Date("2026-07-01T13:30:00.000Z").getTime();

  for (let i = 0; i < 8; i += 1) {
    const atIso = new Date(baseMs + i * 5 * 60 * 1000).toISOString();
    const sample = buildSample(i, atIso, tradingDay);
    const { fires, newRuntimes, newQuotas } = engine.evaluateAll([rule], runtimes, sample, quotaByOwner);
    runtimes = newRuntimes;
    quotaByOwner = newQuotas;
    fireCount += fires.length;
  }

  return fireCount;
}

describe("CLI -> store -> engine seam: hysteresis actually suppresses flapping (C1 regression)", () => {
  it("unrealized_pnl: a price wobbling +-0.1% around the threshold fires exactly ONCE, not on every crossing", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, "NVDA.US", "member_1");

    // Real CLI call - no --hysteresis flag exists (and none should be added;
    // the spec pins these values). threshold defaults to DEFAULT_THRESHOLDS
    // .unrealized_pnl (0.06); hysteresis must come from DEFAULT_HYSTERESIS
    // .unrealized_pnl (0.01), not a hardcoded 0.
    const created = cli.runAdd({ actor: "member_1", symbol: "NVDA", type: "unrealized_pnl" }, options);
    expect(created.ok).toBe(true);

    // Read the rule back exactly as the poller would - through the store,
    // not the CLI's return value - to prove the persisted row (not just the
    // in-memory object runAdd happened to return) carries the fix.
    const rules = store.listEnabledRules(db);
    const rule = rules.find((r: { id: string }) => r.id === created.rule.id);
    expect(rule).toBeTruthy();

    // Costs 100/share; price wobbles between 105.9 and 106.1 (+-0.1% around
    // the +6% threshold line), 5-minute cadence, 8 samples - the exact
    // scenario from the task brief.
    const prices = [106.1, 105.9, 106.1, 105.9, 106.1, 105.9, 106.1, 105.9];
    const fireCount = runFlappingSequence(rule as Record<string, unknown>, (i, atIso, tradingDay) => ({
      atIso,
      tradingDay,
      quotes: { "NVDA.US": { price: prices[i], prevClose: 100, volume: 1000 } },
      positions: { "NVDA.US": { quantity: 10, costPrice: 100, marketValue: prices[i] * 10 } },
      exposure: { exposureRatio: null, overBudget: false }
    }));

    expect(fireCount).toBe(1);
  });

  it("exposure: a ratio wobbling +-0.1% around the threshold fires exactly ONCE, not on every crossing", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");

    const created = cli.runAdd({ actor: "member_1", type: "exposure" }, options);
    expect(created.ok).toBe(true);

    const rules = store.listEnabledRules(db);
    const rule = rules.find((r: { id: string }) => r.id === created.rule.id);
    expect(rule).toBeTruthy();

    // exposureRatio wobbles between 0.099 and 0.101 (+-0.1% around the
    // default 0.1 threshold), 5-minute cadence, 8 samples.
    const ratios = [0.101, 0.099, 0.101, 0.099, 0.101, 0.099, 0.101, 0.099];
    const fireCount = runFlappingSequence(rule as Record<string, unknown>, (i, atIso, tradingDay) => ({
      atIso,
      tradingDay,
      quotes: {},
      positions: {},
      exposure: { exposureRatio: ratios[i], overBudget: ratios[i] > 0.1 }
    }));

    expect(fireCount).toBe(1);
  });
});

// Task H4 (phase2.5 hardening): the two tests above go through the CLI's
// runAdd, which has ALWAYS explicitly passed `hysteresis: DEFAULT_HYSTERESIS
// [type]` - so they never actually exercised store.insertRule's OWN
// defaulting behavior (previously `rule.hysteresis ?? 0`, now pushed down to
// default from DEFAULT_HYSTERESIS itself). This block bypasses the CLI
// entirely and calls store.insertRule directly, proving the invariant now
// lives in the write layer, not just in market-alerts.mjs.
describe("store.insertRule -> engine.evaluateAll: the STORE (not just the CLI) defaults hysteresis and honors it end to end", () => {
  it("a rule inserted via the bare store call (no CLI, no explicit hysteresis) still suppresses flapping", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");

    const rule = store.insertRule(db, {
      ownerId: "member_1",
      symbol: "NVDA.US",
      ruleType: "unrealized_pnl",
      threshold: 0.06,
      direction: "both",
      frequency: engine.RULE_TYPE_FREQUENCY.unrealized_pnl
      // deliberately no `hysteresis` field
    });
    expect(rule.hysteresis).toBe(engine.DEFAULT_HYSTERESIS.unrealized_pnl);

    // Read back through the store exactly as the poller would - proving the
    // persisted row (not just insertRule's returned object) carries the
    // default.
    const stored = store.listEnabledRules(db).find((r: { id: string }) => r.id === rule.id);
    expect(stored).toBeTruthy();

    const prices = [106.1, 105.9, 106.1, 105.9, 106.1, 105.9, 106.1, 105.9];
    const fireCount = runFlappingSequence(stored as Record<string, unknown>, (i, atIso, tradingDay) => ({
      atIso,
      tradingDay,
      quotes: { "NVDA.US": { price: prices[i], prevClose: 100, volume: 1000 } },
      positions: { "NVDA.US": { quantity: 10, costPrice: 100, marketValue: prices[i] * 10 } },
      exposure: { exposureRatio: null, overBudget: false }
    }));

    expect(fireCount).toBe(1);
  });

  it("insertRule itself rejects a threshold at or below the type's hysteresis, with zero rows written", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");

    expect(() =>
      store.insertRule(db, {
        ownerId: "member_1",
        symbol: "*",
        ruleType: "exposure",
        threshold: engine.DEFAULT_HYSTERESIS.exposure,
        direction: "both",
        frequency: engine.RULE_TYPE_FREQUENCY.exposure
      })
    ).toThrow(/滞回/);

    expect(store.listAllRules(db)).toEqual([]);
  });
});

// Task H4 (phase2.5 hardening): stock-analysis.mjs's setTargets writes
// stock_analysis_targets; market-alerts-store.mjs's isSymbolWatched reads it
// to gate rule creation. Both were previously tested only in isolation - a
// unit test on either side alone can't catch a defect that only exists at
// their seam (the exact class of bug this whole hardening phase is about:
// writer-side and reader-side each individually "correct" but disagreeing
// with each other). This drives the REAL CLI command function (no hand-
// rolled SQL insert, unlike this file's own seedTarget-equivalent) against a
// real temp db, then reads it back through the real isSymbolWatched.
const stockAnalysis = await import("./stock-analysis.mjs");

describe("stock-analysis CLI setTargets -> market-alerts-store isSymbolWatched (writer/reader seam)", () => {
  it("a symbol set via the real --owner CLI path is visible to isSymbolWatched for that owner only", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");

    const result = stockAnalysis.runTargetsCommand(["--owner", "member_1", "NVDA"], options);
    expect(result.ownerId).toBe("member_1");
    expect(result.saved).toEqual(["NVDA.US"]);

    expect(store.isSymbolWatched(db, "member_1", "NVDA.US")).toBe(true);
    expect(store.isSymbolWatched(db, "member_2", "NVDA.US")).toBe(false);
  });

  it("a symbol removed (replaced) by a later setTargets call for the same owner stops matching isSymbolWatched", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");

    stockAnalysis.runTargetsCommand(["--owner", "member_1", "NVDA"], options);
    expect(store.isSymbolWatched(db, "member_1", "NVDA.US")).toBe(true);

    // Replacing the target list with a disjoint symbol soft-deletes NVDA for
    // this owner only (setTargets' scoped soft-delete).
    stockAnalysis.runTargetsCommand(["--owner", "member_1", "MSFT"], options);
    expect(store.isSymbolWatched(db, "member_1", "NVDA.US")).toBe(false);
    expect(store.isSymbolWatched(db, "member_1", "MSFT.US")).toBe(true);
    expect(db).toBeTruthy();
  });

  it("rejects a missing --owner instead of silently operating on a global pool", () => {
    const { options } = makeDb();
    expect(() => stockAnalysis.runTargetsCommand(["NVDA"], options)).toThrow(/owner/);
  });

  it("rejects writing to the read-only legacy shared-pool sentinel", () => {
    const { db, options } = makeDb();
    expect(() => stockAnalysis.runTargetsCommand(["--owner", "__legacy_shared__", "NVDA"], options)).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS c FROM stock_analysis_targets").get()).toMatchObject({ c: 0 });
  });

  it("rejects an owner id that is not an active member", () => {
    const { options } = makeDb();
    expect(() => stockAnalysis.runTargetsCommand(["--owner", "no_such_member", "NVDA"], options)).toThrow(/成员/);
  });

  it("enforces the 20-symbol-per-owner cap", () => {
    const { db, options } = makeDb();
    seedMember(db, "member_1");
    const symbols = Array.from({ length: 21 }, (_, i) => `${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)}${String.fromCharCode(65 + i)}`);

    expect(() => stockAnalysis.runTargetsCommand(["--owner", "member_1", ...symbols], options)).toThrow(/20/);
    expect(db.prepare("SELECT COUNT(*) AS c FROM stock_analysis_targets").get()).toMatchObject({ c: 0 });
  });
});
