import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createId, migrate } from "@packages/shared-types";

import {
  computeMaxDrawdownSegment,
  computePaperKpis,
  loadQqqBenchmarkSeries,
  loadSnapshotSeriesForOwner,
  usEasternSessionDate,
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
    /** Written into `raw.primaryAsset.currency`, exactly where
     * official-paper-monitor.mjs puts Longbridge's own account currency.
     * Defaults to `"USD"`; pass `null` for a primaryAsset with no currency key
     * (a blob that never stated one), or `omitPrimaryAsset` for no primaryAsset
     * at all. */
    reportingCurrency?: string | null;
    /**
     * `raw.primaryAsset.cash_infos` - Longbridge's per-currency cash buckets.
     * Defaults to a single bucket of `netAssets` in the reporting currency
     * (the simplest real account shape: all cash, no conversion), which makes
     * the FX-free basis equal `netAssets` so the percentage expectations below
     * stay readable. The LIVE deployment's shape - HKD reporting over a USD
     * bucket - is exercised explicitly in the F1 block at the bottom.
     */
    cashInfos?: Array<{ currency: string; available_cash: string }>;
    /** `raw.primaryAsset.total_cash`, in the reporting currency. */
    totalCash?: string;
    /** Writes a blob with NO `primaryAsset` key at all - a pre-H4-style row.
     * Explicit rather than the default, because official-paper-monitor.mjs
     * always writes one (all 64 live rows carry it), so a helper that defaulted
     * to omitting it would make every other test in this file run against a
     * shape the producer never emits. */
    omitPrimaryAsset?: boolean;
  }
): void {
  // Mirrors the REAL blob official-paper-monitor.mjs persists, measured
  // 2026-07-30 against the mini's runtime/trading.sqlite: the top level
  // carries source/fetchedAt/accountMode/check/assets/primaryAsset/positions/
  // quotes/degraded/degradedReason, and `primaryAsset` is Longbridge's own
  // asset row - `{net_assets, total_cash, currency, buy_power, cash_infos…}`
  // with `currency: "HKD"` on this deployment. Only the fields the readers
  // under test actually parse are populated here; the shape of THOSE fields
  // is the producer's, not invented.
  const raw: Record<string, unknown> = {
    degraded: opts.degraded ?? false,
    degradedReason: opts.degradedReason ?? null
  };
  const currency = opts.reportingCurrency === undefined ? "USD" : opts.reportingCurrency;
  const cashInfos =
    opts.cashInfos ?? (currency === null ? [] : [{ currency, available_cash: String(opts.netAssets ?? 0) }]);
  const primaryAsset: Record<string, unknown> = {
    net_assets: String(opts.netAssets ?? 0),
    total_cash: opts.totalCash ?? String(opts.netAssets ?? 0),
    cash_infos: cashInfos
  };
  if (currency !== null) {
    primaryAsset.currency = currency;
  }
  if (!opts.omitPrimaryAsset) {
    raw.primaryAsset = primaryAsset;
  }
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

/**
 * One `SnapshotSeriesPoint`, produced by SEEDING A ROW AND READING IT BACK
 * through `loadSnapshotSeriesForOwner` - the same reader the pages use.
 *
 * It used to be a hand-written object literal, which is the fixture-dishonesty
 * trap: the shape was ours, not the reader's, so it could not disagree with the
 * reader no matter what the reader did. When `basis` was added to the point in
 * 2026-07-30's F1 fix, every one of those literals silently carried
 * `undefined` there and the KPI math under test would have been exercised
 * against a point this codebase never emits.
 *
 * `reportingCurrency` defaults to USD with a matching USD cash bucket - the
 * simplest complete account (all cash, no conversion), which makes the FX-free
 * basis equal `netAssets` so the percentage expectations below read directly.
 * A `netAssets: null` point seeds a zero cash bucket, so it has no basis
 * either - the gap stays a gap on both fields, never a zero.
 */
function point(
  fetchedAt: string,
  netAssets: number | null,
  degraded = false,
  reportingCurrency: string | null = "USD"
): SnapshotSeriesPoint {
  const db = memoryDb();
  seedSnapshot(db, { ownerId: "member_point", fetchedAt, netAssets, degraded, reportingCurrency });
  return loadSnapshotSeriesForOwner(db, "member_point", 1)[0] as SnapshotSeriesPoint;
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
      maxDrawdownPct: null,
      reportingCurrency: null,
      basisCurrency: null,
      fxConversion: null,
      returnGap: { kind: "too-few-points", usable: 0, gaps: [] }
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

// ---------------------------------------------------------------------------
// Reporting currency (2026-07-30)
// ---------------------------------------------------------------------------
//
// Regression cover for a live misstatement: the mini's Longbridge paper
// account reports `primaryAsset.currency = "HKD"`, and every net-asset
// renderer used to append a hardcoded " 美元", so /、/paper and /member each
// told the operator their HK$860,251.88 was "860,251.88 美元".
describe("OwnerSnapshot.reportingCurrency", () => {
  it("reads the broker's own account currency out of the raw blob", () => {
    const db = memoryDb();
    seedSnapshot(db, {
      ownerId: "member_1",
      fetchedAt: "2026-07-29T19:30:04.000Z",
      netAssets: 860251.88,
      reportingCurrency: "HKD"
    });
    const series = loadSnapshotSeriesForOwner(db, "member_1", 10);
    expect(series).toHaveLength(1);
    expect((series[0] as SnapshotSeriesPoint).reportingCurrency).toBe("HKD");
    expect(computePaperKpis(series).reportingCurrency).toBe("HKD");
  });

  it("is null - never a guessed USD - when the blob states no currency", () => {
    const db = memoryDb();
    // primaryAsset present but with no currency key.
    seedSnapshot(db, {
      ownerId: "member_1",
      fetchedAt: "2026-07-29T19:30:04.000Z",
      netAssets: 1000,
      reportingCurrency: null
    });
    // No primaryAsset at all (pre-H4 style blob).
    seedSnapshot(db, {
      ownerId: "member_2",
      fetchedAt: "2026-07-29T19:30:04.000Z",
      netAssets: 1000,
      omitPrimaryAsset: true
    });

    for (const owner of ["member_1", "member_2"]) {
      const series = loadSnapshotSeriesForOwner(db, owner, 10);
      expect((series[0] as SnapshotSeriesPoint).reportingCurrency).toBeNull();
      expect(computePaperKpis(series).reportingCurrency).toBeNull();
    }
  });

  it("takes the currency from the SAME point 净值 came from (the latest)", () => {
    const db = memoryDb();
    seedSnapshot(db, {
      ownerId: "member_1",
      fetchedAt: "2026-07-20T13:30:00.000Z",
      netAssets: 957876.46,
      reportingCurrency: "USD"
    });
    seedSnapshot(db, {
      ownerId: "member_1",
      fetchedAt: "2026-07-29T19:30:04.000Z",
      netAssets: 860251.88,
      reportingCurrency: "HKD"
    });
    const kpis = computePaperKpis(loadSnapshotSeriesForOwner(db, "member_1", 10));
    expect(kpis.netAssets).toBe(860251.88);
    expect(kpis.reportingCurrency).toBe("HKD");
  });
});

// ---------------------------------------------------------------------------
// F1 (2026-07-30): a currency-conversion artifact must not become a P&L number
//
// Every fixture below is the LIVE blob shape and the LIVE numbers, read off the
// deployed mini's runtime/trading.sqlite: `primaryAsset.currency = "HKD"`, one
// funded bucket `cash_infos[USD].available_cash = 122079.05` constant across
// all 64 rows, one position (1 share of QQQ.US, priced in USD), and a
// `total_cash` that fell 952406.29 -> 855558.45 purely because the rate those
// two figures imply stepped 7.801554 -> 7.008233 on the 2026-07-23 session.
// USD/HKD is pegged into 7.75-7.85, so 7.0082 is a broker rate-table artifact.
// ---------------------------------------------------------------------------

/** The live account's snapshot for one poll: cash constant, one QQQ share at
 * `qqqPrice`, `total_cash` = cash * `impliedRate` exactly as the broker stated
 * both numbers. */
function seedLiveShapeSnapshot(
  db: DatabaseSync,
  opts: { fetchedAt: string; qqqPrice: number; impliedRate: number }
): void {
  const usdCash = 122079.05;
  const totalCash = usdCash * opts.impliedRate;
  seedSnapshot(db, {
    ownerId: "member_live",
    fetchedAt: opts.fetchedAt,
    // net_assets is the broker's own HKD aggregate: converted cash plus the
    // converted position, which is exactly why it cannot carry a percentage.
    netAssets: totalCash + opts.qqqPrice * opts.impliedRate,
    marketValue: opts.qqqPrice,
    reportingCurrency: "HKD",
    totalCash: totalCash.toFixed(2),
    cashInfos: [
      { currency: "USD", available_cash: usdCash.toFixed(2) },
      // The live blob carries an all-zero HKD bucket alongside the funded one.
      // An account that counted it as a second currency would look
      // multi-currency and lose its basis, so this stays in the fixture.
      { currency: "HKD", available_cash: "0.00" }
    ],
    positions: [
      { symbol: "QQQ.US", currency: "USD", quantity: 1, costPrice: 663.88, price: opts.qqqPrice, priceSource: "live" }
    ]
  });
}

/** The live series, trimmed to the two sessions that bracket the rate step:
 * four polls before it at 7.801554 and four after at 7.008233. QQQ prices are
 * the real ones from those rows. */
function seedLiveRateStepSeries(db: DatabaseSync): void {
  const before = 7.801553911174768;
  const after = 7.008233189888027;
  seedLiveShapeSnapshot(db, { fetchedAt: "2026-07-22T13:30:03.284Z", qqqPrice: 703.87, impliedRate: before });
  seedLiveShapeSnapshot(db, { fetchedAt: "2026-07-22T15:30:02.477Z", qqqPrice: 709.1, impliedRate: before });
  seedLiveShapeSnapshot(db, { fetchedAt: "2026-07-22T19:30:01.414Z", qqqPrice: 707.36, impliedRate: before });
  seedLiveShapeSnapshot(db, { fetchedAt: "2026-07-23T13:30:02.603Z", qqqPrice: 694.35, impliedRate: after });
  seedLiveShapeSnapshot(db, { fetchedAt: "2026-07-23T15:30:04.516Z", qqqPrice: 688.42, impliedRate: after });
  seedLiveShapeSnapshot(db, { fetchedAt: "2026-07-23T19:30:00.788Z", qqqPrice: 691.43, impliedRate: after });
}

describe("F1: FX-free performance basis", () => {
  it("rebuilds the basis in the currency the money is actually held in, not the reporting currency", () => {
    const db = memoryDb();
    seedLiveShapeSnapshot(db, { fetchedAt: "2026-07-29T19:30:04.594Z", qqqPrice: 670.9, impliedRate: 7.008233189888027 });

    const point = loadSnapshotSeriesForOwner(db, "member_live", 10)[0] as SnapshotSeriesPoint;

    expect(point.reportingCurrency).toBe("HKD");
    expect(point.basis.ok).toBe(true);
    if (!point.basis.ok) {
      throw new Error("unreachable");
    }
    expect(point.basis.basis.currency).toBe("USD");
    // 122,079.05 USD cash + 1 QQQ share at 670.90 USD. No rate anywhere in it.
    expect(point.basis.basis.value).toBeCloseTo(122749.95, 2);
    expect(point.basis.basis.rebuiltFromReportingCurrency).toBe(true);
  });

  it("does NOT turn the 2026-07-23 rate step into 累计收益 or 最大回撤", () => {
    const db = memoryDb();
    seedLiveRateStepSeries(db);
    const series = loadSnapshotSeriesForOwner(db, "member_live", 50);
    const kpis = computePaperKpis(series);

    // What the page used to print, computed the old way off net_assets, for
    // comparison - a double-digit loss out of a rate table.
    const firstNet = (series[0] as SnapshotSeriesPoint).netAssets as number;
    const lastNet = (series[series.length - 1] as SnapshotSeriesPoint).netAssets as number;
    expect(((lastNet - firstNet) / firstNet) * 100).toBeLessThan(-10);

    // What it prints now: the real move of 1 QQQ share against a six-figure
    // cash pile, measured in USD end to end.
    expect(kpis.basisCurrency).toBe("USD");
    expect(kpis.cumulativeChangePct).toBeCloseTo(((122079.05 + 691.43) / (122079.05 + 703.87) - 1) * 100, 6);
    expect(kpis.cumulativeChangePct as number).toBeGreaterThan(-0.05);
    expect(kpis.maxDrawdownPct as number).toBeGreaterThan(-0.05);
    expect(kpis.returnGap).toBeNull();
  });

  it("still reports 净值 verbatim in the broker's own currency, with the conversion disclosed", () => {
    const db = memoryDb();
    seedLiveRateStepSeries(db);
    const kpis = computePaperKpis(loadSnapshotSeriesForOwner(db, "member_live", 50));

    expect(kpis.reportingCurrency).toBe("HKD");
    expect(kpis.fxConversion).not.toBeNull();
    const fx = kpis.fxConversion as NonNullable<typeof kpis.fxConversion>;
    expect(fx.reportingCurrency).toBe("HKD");
    expect(fx.heldCurrency).toBe("USD");
    expect(fx.rateChanges).toHaveLength(1);
    expect(fx.rateChanges[0]?.fetchedAt).toBe("2026-07-23T13:30:02.603Z");
    expect(fx.rateChanges[0]?.fromRate).toBeCloseTo(7.8016, 4);
    expect(fx.rateChanges[0]?.toRate).toBeCloseTo(7.0082, 4);
  });

  it("refuses a return figure - naming multi-currency - rather than picking a rate to bridge two currencies", () => {
    const db = memoryDb();
    for (const fetchedAt of ["2026-07-22T13:30:00.000Z", "2026-07-23T13:30:00.000Z"]) {
      seedSnapshot(db, {
        ownerId: "member_mixed",
        fetchedAt,
        netAssets: 1000,
        reportingCurrency: "HKD",
        totalCash: "1000",
        cashInfos: [
          { currency: "USD", available_cash: "100" },
          { currency: "HKD", available_cash: "220" }
        ]
      });
    }
    const kpis = computePaperKpis(loadSnapshotSeriesForOwner(db, "member_mixed", 10));

    expect(kpis.cumulativeChangePct).toBeNull();
    expect(kpis.maxDrawdownPct).toBeNull();
    expect(kpis.basisCurrency).toBeNull();
    expect(kpis.returnGap).toEqual({ kind: "too-few-points", usable: 0, gaps: ["mixed-currencies"] });
  });

  it("refuses a return figure when the basis currency CHANGES mid-series", () => {
    const db = memoryDb();
    seedSnapshot(db, {
      ownerId: "member_switch",
      fetchedAt: "2026-07-22T13:30:00.000Z",
      netAssets: 1000,
      reportingCurrency: "USD"
    });
    seedSnapshot(db, {
      ownerId: "member_switch",
      fetchedAt: "2026-07-23T13:30:00.000Z",
      netAssets: 7800,
      reportingCurrency: "HKD"
    });
    const kpis = computePaperKpis(loadSnapshotSeriesForOwner(db, "member_switch", 10));

    expect(kpis.returnGap).toEqual({ kind: "mixed-basis-currency", currencies: ["USD", "HKD"] });
    expect(kpis.cumulativeChangePct).toBeNull();
  });

  it("refuses the basis for a position the producer itself could not value", () => {
    const db = memoryDb();
    seedSnapshot(db, {
      ownerId: "member_zero",
      fetchedAt: "2026-07-23T13:30:00.000Z",
      netAssets: 1000,
      positions: [{ symbol: "NVDA.US", currency: "USD", quantity: 3, price: 0, priceSource: "zero" }]
    });
    const point = loadSnapshotSeriesForOwner(db, "member_zero", 10)[0] as SnapshotSeriesPoint;

    expect(point.basis).toEqual({ ok: false, gap: "position-not-valued" });
  });
});

// ---------------------------------------------------------------------------
// F2 (req §1.6): QQQ benchmark alignment
// ---------------------------------------------------------------------------

function seedQqqFact(
  db: DatabaseSync,
  opts: { tradingDay: string; price: number; dataTime: string }
): void {
  db.prepare(`
    INSERT INTO daily_facts (id, trading_day, fact_key, value_num, value_text, unit, source, data_time, created_at)
    VALUES (?, ?, 'qqq.price', ?, NULL, 'USD', 'longbridge-quote', ?, '2026-07-30T00:00:00.000Z')
  `).run(createId("fact"), opts.tradingDay, opts.price, opts.dataTime);
}

/** The six live `qqq.price` rows, verbatim (trading_day, value, data_time) -
 * including the three whose `data_time` is an intraday instant from a
 * late/manual run, and row `2026-07-26`, whose label is two sessions away from
 * the Friday close it actually holds. */
function seedLiveQqqFacts(db: DatabaseSync): void {
  seedQqqFact(db, { tradingDay: "2026-07-21", price: 696.06, dataTime: "2026-07-20T20:00:00.000Z" });
  seedQqqFact(db, { tradingDay: "2026-07-26", price: 684.23, dataTime: "2026-07-24T20:00:00.000Z" });
  seedQqqFact(db, { tradingDay: "2026-07-27", price: 677.96, dataTime: "2026-07-27T15:52:37.000Z" });
  seedQqqFact(db, { tradingDay: "2026-07-28", price: 682.12, dataTime: "2026-07-27T20:00:00.000Z" });
  seedQqqFact(db, { tradingDay: "2026-07-29", price: 668.47, dataTime: "2026-07-29T14:34:12.000Z" });
  seedQqqFact(db, { tradingDay: "2026-07-30", price: 665.08, dataTime: "2026-07-29T16:22:29.000Z" });
}

/** One poll per live session, at 15:30 ET (the last snapshot of each session on
 * the live series), so the sessions the benchmark must align to are real. */
function seedSessionSnapshots(db: DatabaseSync): void {
  const sessions: Array<[string, number]> = [
    ["2026-07-20T19:30:04.887Z", 697.5],
    ["2026-07-21T19:30:05.017Z", 708.43],
    ["2026-07-22T19:30:01.414Z", 707.36],
    ["2026-07-23T19:30:00.788Z", 691.43],
    ["2026-07-24T19:30:03.123Z", 683.714],
    ["2026-07-27T19:30:01.253Z", 683.3],
    ["2026-07-28T19:30:03.115Z", 677.955],
    ["2026-07-29T19:30:04.594Z", 670.9]
  ];
  for (const [fetchedAt, qqqPrice] of sessions) {
    seedLiveShapeSnapshot(db, { fetchedAt, qqqPrice, impliedRate: 7.008233189888027 });
  }
}

describe("F2: QQQ benchmark alignment", () => {
  it("maps each snapshot poll to its US/Eastern session", () => {
    // 13:30Z = 09:30 ET (the open) and 19:30Z = 15:30 ET, both inside the same
    // session; 02:00Z is 22:00 ET on the PREVIOUS calendar day.
    expect(usEasternSessionDate("2026-07-20T13:30:00.297Z")).toBe("2026-07-20");
    expect(usEasternSessionDate("2026-07-29T19:30:04.594Z")).toBe("2026-07-29");
    expect(usEasternSessionDate("2026-07-21T02:00:00.000Z")).toBe("2026-07-20");
    expect(usEasternSessionDate("not-an-instant")).toBeNull();
  });

  it("aligns on the fact's own data_time, NOT on daily_facts.trading_day", () => {
    const db = memoryDb();
    seedSessionSnapshots(db);
    seedLiveQqqFacts(db);

    const benchmark = loadQqqBenchmarkSeries(db, loadSnapshotSeriesForOwner(db, "member_live", 50));

    // Only the three rows whose data_time IS a session close survive, and each
    // lands on the session its timestamp falls in - never on `trading_day - 1`.
    expect(benchmark.points.map((p) => [p.sessionDate, p.price, p.filedUnder])).toEqual([
      ["2026-07-20", 696.06, "2026-07-21"],
      ["2026-07-24", 684.23, "2026-07-26"],
      ["2026-07-27", 682.12, "2026-07-28"]
    ]);
    // Row 2026-07-29 holds a 07-29 intraday quote. Aligning on its label would
    // have filed it against the 07-28 session - the off-by-one-day benchmark.
    expect(benchmark.points.some((p) => p.sessionDate === "2026-07-28")).toBe(false);
  });

  it("names every rejected row and every unaligned session instead of interpolating", () => {
    const db = memoryDb();
    seedSessionSnapshots(db);
    seedLiveQqqFacts(db);

    const benchmark = loadQqqBenchmarkSeries(db, loadSnapshotSeriesForOwner(db, "member_live", 50));

    expect(benchmark.unalignedSessions).toEqual([
      "2026-07-21",
      "2026-07-22",
      "2026-07-23",
      "2026-07-28",
      "2026-07-29"
    ]);
    expect(benchmark.rejected.map((r) => r.filedUnder)).toEqual(["2026-07-27", "2026-07-29", "2026-07-30"]);
    for (const rejected of benchmark.rejected) {
      expect(rejected.reason).toContain("盘中报价");
    }
  });

  it("joins two observations by a line only across CONSECUTIVE sessions", () => {
    const db = memoryDb();
    seedSessionSnapshots(db);
    seedLiveQqqFacts(db);

    const benchmark = loadQqqBenchmarkSeries(db, loadSnapshotSeriesForOwner(db, "member_live", 50));

    // 07-20 -> 07-24 skips three sessions, so no line.
    expect(benchmark.points[1]?.joinsPrevious).toBe(false);
    // 07-24 -> 07-27 spans only a weekend, so they ARE consecutive sessions.
    expect(benchmark.points[2]?.joinsPrevious).toBe(true);
    // The first point can never join anything before it.
    expect(benchmark.points[0]?.joinsPrevious).toBe(false);
  });

  it("anchors each observation on the LAST snapshot of its session", () => {
    const db = memoryDb();
    seedLiveShapeSnapshot(db, { fetchedAt: "2026-07-20T13:30:00.297Z", qqqPrice: 702.395, impliedRate: 7.8 });
    seedLiveShapeSnapshot(db, { fetchedAt: "2026-07-20T19:30:04.887Z", qqqPrice: 697.5, impliedRate: 7.8 });
    seedLiveShapeSnapshot(db, { fetchedAt: "2026-07-21T19:30:05.017Z", qqqPrice: 708.43, impliedRate: 7.8 });
    seedQqqFact(db, { tradingDay: "2026-07-21", price: 696.06, dataTime: "2026-07-20T20:00:00.000Z" });

    const benchmark = loadQqqBenchmarkSeries(db, loadSnapshotSeriesForOwner(db, "member_live", 50));

    expect(benchmark.points).toHaveLength(1);
    expect(benchmark.points[0]?.seriesIndex).toBe(1); // the 19:30Z poll, not the 13:30Z one
  });

  it("returns nothing at all - not a zero-length line - when daily_facts is empty", () => {
    const db = memoryDb();
    seedSessionSnapshots(db);

    const benchmark = loadQqqBenchmarkSeries(db, loadSnapshotSeriesForOwner(db, "member_live", 50));

    expect(benchmark.points).toEqual([]);
    expect(benchmark.rejected).toEqual([]);
    expect(benchmark.unalignedSessions).toHaveLength(8);
  });
});
