import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  CircuitBreakerRepository,
  MemberRepository,
  createId,
  openTradingDatabase
} from "../../../packages/shared-types/dist/index.js";

const circuitBreaker = await import("./circuit-breaker.mjs");

const tempDirs: string[] = [];

function makeDb(): { db: DatabaseSync; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-circuit-breaker-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "trading.sqlite");
  const db = openTradingDatabase(dbPath);
  return { db, dbPath };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function seedMember(db: DatabaseSync, id: string): void {
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

function seedSnapshot(
  db: DatabaseSync,
  opts: { ownerId: string | null; fetchedAt: string; netAssets?: number | null; marketValue?: number }
): void {
  db.prepare(`
    INSERT INTO official_paper_snapshots
      (id, fetched_at, reason, net_assets, total_cash, market_value, positions, raw, owner_id)
    VALUES (?, ?, 'manual', ?, NULL, ?, '[]', '{}', ?)
  `).run(
    createId("snapshot"),
    opts.fetchedAt,
    opts.netAssets === undefined ? null : opts.netAssets,
    opts.marketValue ?? 0,
    opts.ownerId
  );
}

// Wednesday 2026-07-15 (EDT) - the trading week this file's tests use as
// "now" is Monday 2026-07-13T04:00:00.000Z (America/New_York midnight,
// UTC-4) through Friday 2026-07-17 - pinned directly against
// trading-schedule.test.ts's own currentUsEasternTradingWeek assertion for
// this same instant, so a week-boundary regression there would also surface
// here.
const NOW = new Date("2026-07-15T18:00:00.000Z");
const BEFORE_WEEK_START = "2026-07-10T12:00:00.000Z";
const WITHIN_WEEK = "2026-07-15T12:00:00.000Z";

describe("computeWeeklyLoss", () => {
  it("computes loss from the last snapshot before week start vs. the latest snapshot", () => {
    const { db } = makeDb();
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: BEFORE_WEEK_START, netAssets: 100000 });
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: WITHIN_WEEK, netAssets: 97010 });

    const loss = circuitBreaker.computeWeeklyLoss(db, "member_1", NOW);

    expect(loss).toBeCloseTo(-0.0299, 6);
  });

  it("falls back to the earliest snapshot IN the week as baseline when none exists before week start", () => {
    const { db } = makeDb();
    // Both snapshots fall inside the current week (Mon 07-13 .. Fri 07-17) -
    // no pre-week snapshot at all.
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: "2026-07-13T12:00:00.000Z", netAssets: 100000 });
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: WITHIN_WEEK, netAssets: 95000 });

    const loss = circuitBreaker.computeWeeklyLoss(db, "member_1", NOW);

    expect(loss).toBeCloseTo(-0.05, 6);
  });

  it("returns null with zero snapshots", () => {
    const { db } = makeDb();
    expect(circuitBreaker.computeWeeklyLoss(db, "member_1", NOW)).toBeNull();
  });

  it("returns null with exactly one snapshot (need at least 2 usable points)", () => {
    const { db } = makeDb();
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: WITHIN_WEEK, netAssets: 100000 });

    expect(circuitBreaker.computeWeeklyLoss(db, "member_1", NOW)).toBeNull();
  });

  it("uses only the owner's own rows when the owner has any, never blending in the shared/NULL fallback pool", () => {
    const { db } = makeDb();
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: BEFORE_WEEK_START, netAssets: 100000 });
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: WITHIN_WEEK, netAssets: 99000 });
    // A shared-pool snapshot showing a much bigger drop - must be ignored
    // entirely since member_1 has own rows.
    seedSnapshot(db, { ownerId: "__shared__", fetchedAt: WITHIN_WEEK, netAssets: 10000 });

    const loss = circuitBreaker.computeWeeklyLoss(db, "member_1", NOW);

    expect(loss).toBeCloseTo(-0.01, 6);
  });

  it("falls back to the shared/NULL pool when the owner has zero own rows", () => {
    const { db } = makeDb();
    seedSnapshot(db, { ownerId: null, fetchedAt: BEFORE_WEEK_START, netAssets: 100000 });
    seedSnapshot(db, { ownerId: "__shared__", fetchedAt: WITHIN_WEEK, netAssets: 98000 });

    const loss = circuitBreaker.computeWeeklyLoss(db, "member_1", NOW);

    expect(loss).toBeCloseTo(-0.02, 6);
  });

  it("ignores snapshots after 'now'", () => {
    const { db } = makeDb();
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: BEFORE_WEEK_START, netAssets: 100000 });
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: WITHIN_WEEK, netAssets: 90000 });
    // Future snapshot (after NOW) must not be picked as "latest".
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: "2026-07-20T00:00:00.000Z", netAssets: 500000 });

    const loss = circuitBreaker.computeWeeklyLoss(db, "member_1", NOW);

    expect(loss).toBeCloseTo(-0.1, 6);
  });
});

describe("checkAndTripCircuit", () => {
  it("does not trip at exactly -2.99% weekly loss (below the -3% threshold)", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: BEFORE_WEEK_START, netAssets: 100000 });
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: WITHIN_WEEK, netAssets: 97010 });

    const result = circuitBreaker.checkAndTripCircuit(db, "member_1", NOW);

    expect(result).toEqual({ ok: true });
    expect(new CircuitBreakerRepository(db).getState("member_1")).toBeNull();
  });

  it("trips at -3.01% weekly loss, pausing for 7 days with a Chinese card", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: BEFORE_WEEK_START, netAssets: 100000 });
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: WITHIN_WEEK, netAssets: 96990 });

    const result = circuitBreaker.checkAndTripCircuit(db, "member_1", NOW);

    expect(result.tripped).toBe(true);
    expect(result.card.title).toBe("⛔ 熔断触发");
    expect(result.card.lines.join(" ")).toMatch(/-3\.01%/);
    expect(result.card.lines.join(" ")).toMatch(/暂停/);

    const state = new CircuitBreakerRepository(db).getState("member_1");
    expect(state).not.toBeNull();
    expect(state?.pausedUntil).toBe(new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString());
    expect(state?.weeklyLossPct).toBeCloseTo(-3.01, 1);
  });

  it("insufficient data (0 or 1 snapshots) never trips", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");

    expect(circuitBreaker.checkAndTripCircuit(db, "member_1", NOW)).toEqual({ ok: true });

    seedSnapshot(db, { ownerId: "member_1", fetchedAt: WITHIN_WEEK, netAssets: 100000 });
    expect(circuitBreaker.checkAndTripCircuit(db, "member_1", NOW)).toEqual({ ok: true });
  });

  it("does not re-trip (pausedUntil/reason unchanged) while already paused, even if still losing", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: BEFORE_WEEK_START, netAssets: 100000 });
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: WITHIN_WEEK, netAssets: 96990 });

    const first = circuitBreaker.checkAndTripCircuit(db, "member_1", NOW);
    expect(first.tripped).toBe(true);
    const stateAfterFirst = new CircuitBreakerRepository(db).getState("member_1");

    // A later call, still inside the pause window, with an even worse loss
    // on the books - must report {paused: true} and must NOT touch the
    // existing pausedUntil/reason/weeklyLossPct.
    const laterNow = new Date(NOW.getTime() + 60 * 60 * 1000);
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: laterNow.toISOString(), netAssets: 50000 });
    const second = circuitBreaker.checkAndTripCircuit(db, "member_1", laterNow);

    expect(second).toEqual({ paused: true, until: stateAfterFirst?.pausedUntil });
    const stateAfterSecond = new CircuitBreakerRepository(db).getState("member_1");
    expect(stateAfterSecond).toEqual(stateAfterFirst);
  });

  it("trip persists across a brand-new db connection (cross-restart semantics)", () => {
    const { db, dbPath } = makeDb();
    seedMember(db, "member_1");
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: BEFORE_WEEK_START, netAssets: 100000 });
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: WITHIN_WEEK, netAssets: 96990 });

    const tripped = circuitBreaker.checkAndTripCircuit(db, "member_1", NOW);
    expect(tripped.tripped).toBe(true);
    const pausedUntilIso = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    // Simulate a process restart: open a completely independent connection
    // to the SAME file.
    const restarted = openTradingDatabase(dbPath);
    const laterNow = new Date(NOW.getTime() + 60 * 60 * 1000);

    expect(new CircuitBreakerRepository(restarted).isPaused("member_1", laterNow.toISOString())).toBe(true);
    expect(circuitBreaker.checkAndTripCircuit(restarted, "member_1", laterNow)).toEqual({
      paused: true,
      until: pausedUntilIso
    });
  });
});

describe("assertProposalAllowed", () => {
  it("throws a Chinese error (with the recovery time) while paused", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: BEFORE_WEEK_START, netAssets: 100000 });
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: WITHIN_WEEK, netAssets: 96990 });
    circuitBreaker.checkAndTripCircuit(db, "member_1", NOW);

    const pausedUntilIso = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    expect(() => circuitBreaker.assertProposalAllowed(db, "member_1", NOW)).toThrow(/熔断暂停中/);
    expect(() => circuitBreaker.assertProposalAllowed(db, "member_1", NOW)).toThrow(
      new RegExp(pausedUntilIso.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
  });

  it("passes silently after the pause expires (clearIfExpired clears the stale row)", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: BEFORE_WEEK_START, netAssets: 100000 });
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: WITHIN_WEEK, netAssets: 96990 });
    circuitBreaker.checkAndTripCircuit(db, "member_1", NOW);

    const afterExpiry = new Date(NOW.getTime() + 8 * 24 * 60 * 60 * 1000);
    expect(() => circuitBreaker.assertProposalAllowed(db, "member_1", afterExpiry)).not.toThrow();

    // The stale row must actually be gone, not merely bypassed.
    expect(new CircuitBreakerRepository(db).getState("member_1")).toBeNull();
  });

  it("never throws for an owner who was never tripped", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    expect(() => circuitBreaker.assertProposalAllowed(db, "member_1", NOW)).not.toThrow();
  });
});
