/**
 * Behavioural parity between `computeWeeklyLossRatio` (data/strategy.ts, the
 * home page's read-side figure) and `computeWeeklyLoss` (apps/openclaw-config/
 * scripts/circuit-breaker.mjs, the engine that actually trips the breaker).
 *
 * WHY IT IS A PARITY TEST AND NOT A UNIT TEST OF EITHER SIDE. The home page
 * tells a member 「本交易周净值 -2.63%，正在接近 -3.00% 熔断线」. That sentence is
 * only true if the number on the page is measured over the SAME window, from
 * the SAME baseline, with the SAME "usable snapshot" rule as the breaker. Two
 * independently-correct implementations would still be a lie the first time
 * they disagreed. So this file runs BOTH against one seeded database over a
 * table of cases - including the awkward ones (no pre-week snapshot, a
 * degraded null net_assets in the middle, a zero baseline, the shared-owner
 * fallback set) - and asserts identical output.
 *
 * The .mjs is imported dynamically because it is outside this app's tsc
 * project; data/strategy-write-parity.test.ts and reports/format-era.test.ts
 * already do exactly this.
 */
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createId, migrate } from "@packages/shared-types";

import { computeWeeklyLossRatio } from "./strategy.js";

const circuitBreaker: {
  computeWeeklyLoss: (db: DatabaseSync, ownerId: string, now: Date) => number | null;
} = await import("../../../openclaw-config/scripts/circuit-breaker.mjs");

const OWNER = "member_parity_1";
/** Thursday 2026-07-30 14:00Z; this trading week starts Monday 2026-07-27
 * 04:00Z (EDT). */
const NOW = new Date("2026-07-30T14:00:00.000Z");

let db: DatabaseSync;

function seed(fetchedAt: string, netAssets: number | null, ownerId: string | null = OWNER): void {
  db.prepare(`
    INSERT INTO official_paper_snapshots (id, fetched_at, reason, net_assets, total_cash, market_value, positions, raw, owner_id)
    VALUES (?, ?, 'hourly_poll', ?, NULL, 0, '[]', '{}', ?)
  `).run(createId("snapshot"), fetchedAt, netAssets, ownerId);
}

/** Both implementations, on the same rows, must return the same thing. */
function expectParity(): number | null {
  const ours = computeWeeklyLossRatio(db, OWNER, NOW);
  const theirs = circuitBreaker.computeWeeklyLoss(db, OWNER, NOW);
  expect(ours).toEqual(theirs);
  return ours;
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
});

afterEach(() => {
  db.close();
});

describe("computeWeeklyLossRatio matches circuit-breaker.mjs's computeWeeklyLoss", () => {
  it("agrees on the ordinary case: pre-week baseline vs latest", () => {
    seed("2026-07-24T20:00:00.000Z", 100_000); // Friday, before the week start
    seed("2026-07-28T20:00:00.000Z", 99_000);
    seed("2026-07-30T13:45:00.000Z", 97_400);
    const value = expectParity();
    expect(value).toBeCloseTo(-0.026, 6);
  });

  it("agrees when there is NO pre-week snapshot (baseline falls back to the earliest in-week row)", () => {
    seed("2026-07-27T20:00:00.000Z", 50_000);
    seed("2026-07-30T13:45:00.000Z", 48_000);
    const value = expectParity();
    expect(value).toBeCloseTo(-0.04, 6);
  });

  it("agrees that a single usable point is not computable", () => {
    seed("2026-07-28T20:00:00.000Z", 99_000);
    expect(expectParity()).toBeNull();
  });

  it("agrees that no snapshots at all is not computable", () => {
    expect(expectParity()).toBeNull();
  });

  it("agrees on skipping null net_assets rows rather than treating them as zero", () => {
    seed("2026-07-24T20:00:00.000Z", 100_000);
    seed("2026-07-29T20:00:00.000Z", null); // degraded fetch
    seed("2026-07-30T13:45:00.000Z", 95_000);
    const value = expectParity();
    expect(value).toBeCloseTo(-0.05, 6);
  });

  it("agrees that a zero baseline is not expressible as a percentage", () => {
    seed("2026-07-24T20:00:00.000Z", 0);
    seed("2026-07-30T13:45:00.000Z", 1_000);
    expect(expectParity()).toBeNull();
  });

  it("agrees on a GAIN week (a positive ratio, not clamped to zero)", () => {
    seed("2026-07-24T20:00:00.000Z", 100_000);
    seed("2026-07-30T13:45:00.000Z", 104_000);
    const value = expectParity();
    expect(value).toBeCloseTo(0.04, 6);
  });

  it("agrees on ignoring rows dated after `now`", () => {
    seed("2026-07-24T20:00:00.000Z", 100_000);
    seed("2026-07-30T13:45:00.000Z", 98_000);
    seed("2026-07-31T20:00:00.000Z", 50_000); // future row must not leak in
    const value = expectParity();
    expect(value).toBeCloseTo(-0.02, 6);
  });

  it("agrees on the shared-owner fallback set when the owner has zero own rows", () => {
    seed("2026-07-24T20:00:00.000Z", 200_000, null);
    seed("2026-07-30T13:45:00.000Z", 190_000, "__shared__");
    const value = expectParity();
    expect(value).toBeCloseTo(-0.05, 6);
  });

  it("agrees that own rows win outright over the fallback set, even when older", () => {
    seed("2026-07-20T20:00:00.000Z", 10_000);
    seed("2026-07-28T20:00:00.000Z", 9_500);
    seed("2026-07-30T13:45:00.000Z", 999_999, null); // fallback row, must be ignored
    const value = expectParity();
    expect(value).toBeCloseTo(-0.05, 6);
  });
});
