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
  db.prepare(`
    INSERT INTO stock_analysis_targets (symbol, active, created_at, updated_at, owner_id)
    VALUES (?, 1, ?, ?, ?)
    ON CONFLICT(symbol) DO UPDATE SET owner_id = excluded.owner_id
  `).run(symbol, "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z", ownerId);
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
