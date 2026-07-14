import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createId, migrate } from "@packages/shared-types";

import {
  computeMaxDrawdownSegment,
  computePaperKpis,
  loadSnapshotSeriesForOwner,
  type SnapshotSeriesPoint
} from "./snapshots.js";

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function seedSnapshot(
  db: DatabaseSync,
  opts: {
    ownerId: string | null;
    fetchedAt: string;
    netAssets?: number | null;
    marketValue?: number;
    positions?: unknown[];
    degraded?: boolean;
    degradedReason?: string | null;
  }
): void {
  const raw = {
    degraded: opts.degraded ?? false,
    degradedReason: opts.degradedReason ?? null
  };
  db.prepare(`
    INSERT INTO official_paper_snapshots
      (id, fetched_at, reason, net_assets, total_cash, market_value, positions, raw, owner_id)
    VALUES (?, ?, 'manual', ?, NULL, ?, ?, ?, ?)
  `).run(
    createId("snapshot"),
    opts.fetchedAt,
    opts.netAssets === undefined ? null : opts.netAssets,
    opts.marketValue ?? 0,
    JSON.stringify(opts.positions ?? []),
    JSON.stringify(raw),
    opts.ownerId
  );
}

describe("loadSnapshotSeriesForOwner", () => {
  it("returns the owner's own rows, oldest first", () => {
    const db = memoryDb();
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: "2026-07-10T00:00:00.000Z", netAssets: 1000 });
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: "2026-07-12T00:00:00.000Z", netAssets: 1100 });
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: "2026-07-11T00:00:00.000Z", netAssets: 1050 });

    const series = loadSnapshotSeriesForOwner(db, "member_1", 10);

    expect(series.map((p) => p.netAssets)).toEqual([1000, 1050, 1100]);
  });

  it("falls back to the NULL/'__shared__' set ONLY when the owner has zero own rows - never mixes the two sets", () => {
    const db = memoryDb();
    // Owner has exactly one own row (older than the shared pool's rows).
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: "2026-06-01T00:00:00.000Z", netAssets: 500 });
    seedSnapshot(db, { ownerId: "__shared__", fetchedAt: "2026-07-10T00:00:00.000Z", netAssets: 2000 });
    seedSnapshot(db, { ownerId: null, fetchedAt: "2026-07-12T00:00:00.000Z", netAssets: 3000 });

    const series = loadSnapshotSeriesForOwner(db, "member_1", 10);

    // Only the owner's own row - the shared/NULL rows must NOT be blended in.
    expect(series).toHaveLength(1);
    expect(series[0]?.netAssets).toBe(500);
  });

  it("falls back to the shared/NULL set (both, combined) when the owner has no own rows at all", () => {
    const db = memoryDb();
    seedSnapshot(db, { ownerId: "__shared__", fetchedAt: "2026-07-10T00:00:00.000Z", netAssets: 2000 });
    seedSnapshot(db, { ownerId: null, fetchedAt: "2026-07-11T00:00:00.000Z", netAssets: 2100 });

    const series = loadSnapshotSeriesForOwner(db, "member_1", 10);

    expect(series.map((p) => p.netAssets)).toEqual([2000, 2100]);
  });

  it("two-member isolation: member B's series never includes member A's rows when B has none of their own (falls back to shared-only, not A's)", () => {
    const db = memoryDb();
    seedSnapshot(db, { ownerId: "member_a", fetchedAt: "2026-07-10T00:00:00.000Z", netAssets: 999 });

    const seriesForB = loadSnapshotSeriesForOwner(db, "member_b", 10);

    expect(seriesForB).toEqual([]);
  });

  it("respects the limit, keeping the MOST RECENT rows (not the oldest)", () => {
    const db = memoryDb();
    for (let i = 0; i < 5; i += 1) {
      seedSnapshot(db, { ownerId: "member_1", fetchedAt: `2026-07-1${i}T00:00:00.000Z`, netAssets: 1000 + i });
    }

    const series = loadSnapshotSeriesForOwner(db, "member_1", 2);

    expect(series.map((p) => p.netAssets)).toEqual([1003, 1004]);
  });

  it("returns an empty array when there is no snapshot at all", () => {
    const db = memoryDb();
    expect(loadSnapshotSeriesForOwner(db, "member_1", 10)).toEqual([]);
  });

  it("carries degraded through to each point", () => {
    const db = memoryDb();
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: "2026-07-10T00:00:00.000Z", netAssets: 1000, degraded: true });

    const series = loadSnapshotSeriesForOwner(db, "member_1", 10);

    expect(series[0]?.degraded).toBe(true);
  });
});

function point(fetchedAt: string, netAssets: number | null, degraded = false): SnapshotSeriesPoint {
  return { fetchedAt, netAssets, marketValue: 0, degraded };
}

describe("computeMaxDrawdownSegment", () => {
  it("returns null (incomputable) for fewer than 2 usable points", () => {
    expect(computeMaxDrawdownSegment([])).toBeNull();
    expect(computeMaxDrawdownSegment([point("2026-07-10T00:00:00.000Z", 1000)])).toBeNull();
  });

  it("returns null when there is only 1 point with a non-null netAssets (the other is null)", () => {
    const series = [point("2026-07-10T00:00:00.000Z", null), point("2026-07-11T00:00:00.000Z", 1000)];
    expect(computeMaxDrawdownSegment(series)).toBeNull();
  });

  it("returns pct: 0 for a monotonically rising series (no drawdown observed is a real, computable answer)", () => {
    const series = [
      point("2026-07-10T00:00:00.000Z", 1000),
      point("2026-07-11T00:00:00.000Z", 1100),
      point("2026-07-12T00:00:00.000Z", 1200)
    ];
    const segment = computeMaxDrawdownSegment(series);
    expect(segment?.pct).toBe(0);
  });

  it("finds the correct peak-to-trough segment across a rise-then-fall-then-partial-recovery series", () => {
    // peak at index 1 (1200), trough at index 3 (900) -> (900-1200)/1200 = -25%
    const series = [
      point("2026-07-10T00:00:00.000Z", 1000),
      point("2026-07-11T00:00:00.000Z", 1200),
      point("2026-07-12T00:00:00.000Z", 1050),
      point("2026-07-13T00:00:00.000Z", 900),
      point("2026-07-14T00:00:00.000Z", 950)
    ];

    const segment = computeMaxDrawdownSegment(series);

    expect(segment?.peakIndex).toBe(1);
    expect(segment?.troughIndex).toBe(3);
    expect(segment?.pct).toBeCloseTo(-25, 5);
  });

  it("skips null-netAssets gap points rather than treating them as zero", () => {
    const series = [
      point("2026-07-10T00:00:00.000Z", 1000),
      point("2026-07-11T00:00:00.000Z", null),
      point("2026-07-12T00:00:00.000Z", 800)
    ];

    const segment = computeMaxDrawdownSegment(series);

    expect(segment?.peakIndex).toBe(0);
    expect(segment?.troughIndex).toBe(2);
    expect(segment?.pct).toBeCloseTo(-20, 5);
  });
});

describe("computePaperKpis", () => {
  it("returns all-null KPIs for an empty series (数据不足 across the board)", () => {
    const kpis = computePaperKpis([]);
    expect(kpis).toEqual({
      netAssets: null,
      todayChangePct: null,
      cumulativeChangePct: null,
      maxDrawdownPct: null
    });
  });

  it("净值 is the latest point's netAssets", () => {
    const series = [point("2026-07-13T00:00:00.000Z", 1000), point("2026-07-14T02:00:00.000Z", 1100)];
    expect(computePaperKpis(series).netAssets).toBe(1100);
  });

  it("今日 compares the latest point against the most recent point on an earlier Beijing calendar day", () => {
    // 2026-07-14T02:00:00Z = 2026-07-14 10:00 Beijing; 2026-07-13T05:00:00Z is the day before.
    const series = [
      point("2026-07-13T05:00:00.000Z", 1000),
      point("2026-07-14T02:00:00.000Z", 1100)
    ];
    const kpis = computePaperKpis(series);
    expect(kpis.todayChangePct).toBeCloseTo(10, 5);
  });

  it("今日 is null (数据不足) when every point in the series is on the SAME Beijing day as the latest", () => {
    const series = [
      point("2026-07-14T01:00:00.000Z", 1000),
      point("2026-07-14T02:00:00.000Z", 1100)
    ];
    expect(computePaperKpis(series).todayChangePct).toBeNull();
  });

  it("今日 is null when the latest point's netAssets itself is null", () => {
    const series = [point("2026-07-13T05:00:00.000Z", 1000), point("2026-07-14T02:00:00.000Z", null)];
    expect(computePaperKpis(series).todayChangePct).toBeNull();
  });

  it("累计 compares the latest point against the series' first point", () => {
    const series = [
      point("2026-06-01T00:00:00.000Z", 1000),
      point("2026-07-01T00:00:00.000Z", 1050),
      point("2026-07-14T00:00:00.000Z", 1200)
    ];
    expect(computePaperKpis(series).cumulativeChangePct).toBeCloseTo(20, 5);
  });

  it("累计 is null (数据不足) for a single-point series", () => {
    const series = [point("2026-07-14T00:00:00.000Z", 1000)];
    expect(computePaperKpis(series).cumulativeChangePct).toBeNull();
  });

  it("最大回撤 reflects computeMaxDrawdownSegment's pct", () => {
    const series = [
      point("2026-07-10T00:00:00.000Z", 1000),
      point("2026-07-11T00:00:00.000Z", 1200),
      point("2026-07-12T00:00:00.000Z", 900)
    ];
    expect(computePaperKpis(series).maxDrawdownPct).toBeCloseTo(-25, 5);
  });

  it("every field is null when the series has fewer than 2 points (all incomputable)", () => {
    const series = [point("2026-07-14T00:00:00.000Z", 1000)];
    const kpis = computePaperKpis(series);
    expect(kpis.netAssets).toBe(1000); // 净值 alone only needs 1 point
    expect(kpis.todayChangePct).toBeNull();
    expect(kpis.cumulativeChangePct).toBeNull();
    expect(kpis.maxDrawdownPct).toBeNull();
  });
});
