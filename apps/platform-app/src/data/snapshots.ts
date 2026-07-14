/**
 * Snapshot reading for platform-app (Task 6): the paper-trading page's
 * net-worth series/KPIs, PLUS - as of this task - the single canonical home
 * of the snapshot-row reading primitives Task 5's data/overview.ts
 * originally defined inline (SHARED_OWNER_SENTINEL / SnapshotPosition /
 * OwnerSnapshot / parsePositions / parseDegraded / mapSnapshotRow /
 * loadSnapshotForOwnerImpl / loadLatestSnapshotForOwner /
 * loadPreviousDaySnapshotForOwner).
 *
 * CHOICE MADE (task brief explicitly asks this to be stated): rather than
 * writing a THIRD independent snapshot reader for the new series case - one
 * that would need to re-derive the exact same adjudicated own-row/fallback-
 * set precedence rule a third time - those primitives were MOVED here
 * verbatim from overview.ts, and overview.ts now just re-exports them from
 * this module (see overview.ts's header comment). Every existing import
 * (routes/home.ts, data/overview.test.ts) keeps working unchanged; the
 * precedence rule itself now has exactly one implementation for both the
 * "give me the one latest row" case (loadLatestSnapshotForOwner /
 * loadPreviousDaySnapshotForOwner) and the new "give me up to N most recent
 * rows" case (loadSnapshotSeriesForOwner) below.
 */
import type { DatabaseSync } from "node:sqlite";

/** Mirrors official-paper-monitor.mjs's SHARED_OWNER_SENTINEL: the owner_id
 * written when a snapshot can't be attributed to exactly one active member. */
export const SHARED_OWNER_SENTINEL = "__shared__";

export interface SnapshotPosition {
  symbol: string;
  /** H4 convention (official-paper-monitor.mjs attachPriceSource): 'live' is
   * a real quote; 'cost'/'zero' are degraded-estimate fallbacks that MUST be
   * rendered as a degraded-valuation marker, never silently shown as if live. */
  priceSource?: "live" | "cost" | "zero";
  price?: number;
  costPrice?: number;
  quantity?: number;
  [key: string]: unknown;
}

export interface OwnerSnapshot {
  id: string;
  ownerId: string | null;
  fetchedAt: string;
  netAssets: number | null;
  marketValue: number;
  positions: SnapshotPosition[];
  /** From the snapshot's `raw` JSON blob (report-data.mjs/official-paper-monitor.mjs
   * `degraded`/`degradedReason` field convention) - total-fetch-failure or
   * per-position degradation, must be surfaced, never swallowed. */
  degraded: boolean;
  degradedReason: string | null;
}

const SNAPSHOT_SELECT = `
  SELECT id, fetched_at, net_assets, market_value, positions, raw, owner_id
  FROM official_paper_snapshots
`;

function parsePositions(raw: unknown): SnapshotPosition[] {
  try {
    const parsed: unknown = JSON.parse(String(raw));
    return Array.isArray(parsed) ? (parsed as SnapshotPosition[]) : [];
  } catch {
    return [];
  }
}

function parseDegraded(raw: unknown): { degraded: boolean; degradedReason: string | null } {
  try {
    const parsed = JSON.parse(String(raw)) as { degraded?: unknown; degradedReason?: unknown };
    const degraded = Boolean(parsed.degraded);
    const degradedReason = typeof parsed.degradedReason === "string" ? parsed.degradedReason : null;
    return { degraded, degradedReason };
  } catch {
    return { degraded: false, degradedReason: null };
  }
}

function mapSnapshotRow(row: Record<string, unknown>): OwnerSnapshot {
  const { degraded, degradedReason } = parseDegraded(row.raw);
  return {
    id: String(row.id),
    ownerId: row.owner_id === null || row.owner_id === undefined ? null : String(row.owner_id),
    fetchedAt: String(row.fetched_at),
    netAssets: row.net_assets === null || row.net_assets === undefined ? null : Number(row.net_assets),
    marketValue: Number(row.market_value),
    positions: parsePositions(row.positions),
    degraded,
    degradedReason
  };
}

/**
 * The ONE implementation of the adjudicated snapshot-ownership precedence
 * rule (this module's header comment): the owner's OWN row(s) win even if
 * older than every other row; a row with no single attributable owner
 * (`owner_id IS NULL` - pre-H4 legacy rows - or `owner_id = '__shared__'` -
 * H4's explicit "can't attribute" sentinel) is used only as a fallback when
 * the owner has NONE of their own - own and fallback sets are never mixed
 * within one result.
 *
 * @param boundary Optional ISO instant; when given, both the own-row and
 *   fallback queries are additionally bounded to `fetched_at < boundary`.
 * @param limit Max rows per query (1 for the "latest single row" callers,
 *   N for the series reader).
 * @param order 'DESC' (newest first) for every caller today.
 */
function queryOwnerRows(
  db: DatabaseSync,
  ownerId: string,
  limit: number,
  boundary?: string
): Array<Record<string, unknown>> {
  const boundaryClause = boundary ? "AND fetched_at < ?" : "";
  const boundaryParams = boundary ? [boundary] : [];
  return db
    .prepare(`${SNAPSHOT_SELECT} WHERE owner_id = ? ${boundaryClause} ORDER BY fetched_at DESC LIMIT ?`)
    .all(ownerId, ...boundaryParams, limit) as Array<Record<string, unknown>>;
}

function queryFallbackRows(
  db: DatabaseSync,
  limit: number,
  boundary?: string
): Array<Record<string, unknown>> {
  const boundaryClause = boundary ? "AND fetched_at < ?" : "";
  const boundaryParams = boundary ? [boundary] : [];
  return db
    .prepare(
      `${SNAPSHOT_SELECT} WHERE (owner_id IS NULL OR owner_id = ?) ${boundaryClause} ORDER BY fetched_at DESC LIMIT ?`
    )
    .all(SHARED_OWNER_SENTINEL, ...boundaryParams, limit) as Array<Record<string, unknown>>;
}

function loadSnapshotForOwnerImpl(db: DatabaseSync, ownerId: string, boundary?: string): OwnerSnapshot | null {
  const ownRows = queryOwnerRows(db, ownerId, 1, boundary);
  if (ownRows.length > 0 && ownRows[0]) {
    return mapSnapshotRow(ownRows[0]);
  }

  const fallbackRows = queryFallbackRows(db, 1, boundary);
  return fallbackRows.length > 0 && fallbackRows[0] ? mapSnapshotRow(fallbackRows[0]) : null;
}

/**
 * Returns the newest `official_paper_snapshots` row this owner can see, per
 * the adjudicated precedence rule documented on `loadSnapshotForOwnerImpl`.
 */
export function loadLatestSnapshotForOwner(db: DatabaseSync, ownerId: string): OwnerSnapshot | null {
  return loadSnapshotForOwnerImpl(db, ownerId);
}

/**
 * Same precedence rule as `loadLatestSnapshotForOwner`, but bounded to
 * strictly before the start of `now`'s Beijing calendar day - used by the
 * home page to find "yesterday's close" so it can compute 今日涨跌 (today's
 * change). Beijing has no DST, so a fixed UTC+8 offset is exact year-round.
 */
export function loadPreviousDaySnapshotForOwner(
  db: DatabaseSync,
  ownerId: string,
  now: Date
): OwnerSnapshot | null {
  return loadSnapshotForOwnerImpl(db, ownerId, beijingDayStartUtcIso(now));
}

function beijingDayStartUtcIso(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const dateStamp = `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
  return new Date(`${dateStamp}T00:00:00+08:00`).toISOString();
}

/** `YYYY-MM-DD` Beijing calendar-day stamp for an ISO instant - used by
 * `computePaperKpis`'s today-vs-previous-day comparison below. Beijing has
 * no DST, so a fixed IANA zone is exact year-round. */
function beijingDateStamp(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(iso));
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

// ---------------------------------------------------------------------------
// Task 6: series reader (paper page's KPI row / net-worth curve / drawdown)
// ---------------------------------------------------------------------------

/** A single lightweight point of the paper page's net-worth series - just
 * enough for the chart/KPI computations below. Deliberately excludes
 * `positions` (unlike `OwnerSnapshot`) - the holdings table needs the FULL
 * latest snapshot (with per-position priceSource), which callers get
 * straight from `loadLatestSnapshotForOwner`, not from this series. */
export interface SnapshotSeriesPoint {
  fetchedAt: string;
  netAssets: number | null;
  marketValue: number;
  degraded: boolean;
}

function toSeriesPoint(snapshot: OwnerSnapshot): SnapshotSeriesPoint {
  return {
    fetchedAt: snapshot.fetchedAt,
    netAssets: snapshot.netAssets,
    marketValue: snapshot.marketValue,
    degraded: snapshot.degraded
  };
}

/**
 * Returns up to `limit` of this owner's most recent snapshots, in
 * chronological (oldest-first) order - the shape charts/KPI math want to
 * consume directly. Follows the SAME adjudicated precedence rule as
 * `loadLatestSnapshotForOwner`: own rows are queried first; the NULL/
 * `'__shared__'` fallback set is only used when the owner has ZERO own rows
 * at all. The two sets are NEVER mixed into one series - an owner with 1 own
 * row gets a series of length 1 (their own row alone), not their row plus
 * padding from the shared pool.
 */
export function loadSnapshotSeriesForOwner(db: DatabaseSync, ownerId: string, limit: number): SnapshotSeriesPoint[] {
  const ownRows = queryOwnerRows(db, ownerId, limit);
  const rows = ownRows.length > 0 ? ownRows : queryFallbackRows(db, limit);
  // Queried newest-first (for LIMIT to keep the N most recent rows); reverse
  // to the chronological order charts/KPI math expect.
  return rows.map(mapSnapshotRow).map(toSeriesPoint).reverse();
}

// ---------------------------------------------------------------------------
// Task 6: KPI derivation (净值/今日/累计/最大回撤)
// ---------------------------------------------------------------------------

export interface DrawdownSegment {
  /** Index into the series array of the local peak that precedes the trough. */
  peakIndex: number;
  /** Index into the series array of the trough itself. */
  troughIndex: number;
  /** Signed percent, always <= 0 (0 when the series never declines from its
   * running peak). */
  pct: number;
}

/**
 * Classic peak-to-trough max-drawdown scan over the series' netAssets,
 * skipping points with a null netAssets (a gap, not a zero). Returns `null`
 * only when fewer than 2 usable (non-null netAssets) points exist - the
 * "incomputable" case the plan calls for (never a fabricated number). A
 * series that only ever rises still returns a real segment with `pct: 0`
 * (peakIndex === troughIndex === the first usable point) - "no drawdown
 * observed" is a computable answer, not an incomputable one.
 */
export function computeMaxDrawdownSegment(series: ReadonlyArray<SnapshotSeriesPoint>): DrawdownSegment | null {
  const usable = series
    .map((point, index) => ({ index, netAssets: point.netAssets }))
    .filter((p): p is { index: number; netAssets: number } => p.netAssets !== null && Number.isFinite(p.netAssets));

  if (usable.length < 2) {
    return null;
  }

  const first = usable[0] as { index: number; netAssets: number };
  let peak = first;
  let worst: DrawdownSegment = { peakIndex: first.index, troughIndex: first.index, pct: 0 };

  for (let i = 1; i < usable.length; i += 1) {
    const point = usable[i] as { index: number; netAssets: number };
    if (point.netAssets > peak.netAssets) {
      peak = point;
      continue;
    }
    if (peak.netAssets === 0) {
      continue; // can't express a percentage decline off a zero base.
    }
    const pct = ((point.netAssets - peak.netAssets) / peak.netAssets) * 100;
    if (Number.isFinite(pct) && pct < worst.pct) {
      worst = { peakIndex: peak.index, troughIndex: point.index, pct };
    }
  }

  return worst;
}

/**
 * Today's change vs. the most recent point in the series whose Beijing
 * calendar day is strictly before the latest point's day - the series-local
 * analog of `loadPreviousDaySnapshotForOwner` (same "most recent snapshot
 * before today" idea), used here because `computePaperKpis` only receives
 * the series, not a separate DB round-trip. Returns null (never a fabricated
 * "+0.00%") when no earlier-day point exists in the given series.
 */
function computeTodayChangePct(series: ReadonlyArray<SnapshotSeriesPoint>): number | null {
  if (series.length === 0) {
    return null;
  }
  const latest = series[series.length - 1] as SnapshotSeriesPoint;
  if (latest.netAssets === null) {
    return null;
  }
  const latestDay = beijingDateStamp(latest.fetchedAt);

  for (let i = series.length - 2; i >= 0; i -= 1) {
    const point = series[i] as SnapshotSeriesPoint;
    if (beijingDateStamp(point.fetchedAt) < latestDay) {
      if (point.netAssets === null || point.netAssets === 0) {
        return null;
      }
      const pct = ((latest.netAssets - point.netAssets) / point.netAssets) * 100;
      return Number.isFinite(pct) ? pct : null;
    }
  }
  return null;
}

/** Cumulative change: latest point's netAssets vs. the series' FIRST point
 * (the oldest point the caller's `limit` reached back to) - null when there
 * are fewer than 2 points or either end's netAssets is missing/zero. */
function computeCumulativeChangePct(series: ReadonlyArray<SnapshotSeriesPoint>): number | null {
  if (series.length < 2) {
    return null;
  }
  const first = series[0] as SnapshotSeriesPoint;
  const latest = series[series.length - 1] as SnapshotSeriesPoint;
  if (first.netAssets === null || latest.netAssets === null || first.netAssets === 0) {
    return null;
  }
  const pct = ((latest.netAssets - first.netAssets) / first.netAssets) * 100;
  return Number.isFinite(pct) ? pct : null;
}

export interface PaperKpis {
  /** 净值: the latest point's netAssets, or null if the series is empty or
   * the latest point's netAssets itself is missing. */
  netAssets: number | null;
  /** 今日: see computeTodayChangePct. */
  todayChangePct: number | null;
  /** 累计: see computeCumulativeChangePct. */
  cumulativeChangePct: number | null;
  /** 最大回撤: see computeMaxDrawdownSegment; always <= 0 when computable. */
  maxDrawdownPct: number | null;
}

/**
 * Derives the paper page's four KPI-row values from a chronologically
 * ordered snapshot series (as returned by `loadSnapshotSeriesForOwner`).
 * Every field independently resolves to `null` (never a fabricated number)
 * when its own data requirement isn't met - callers render `null` as the
 * honest 「数据不足」 placeholder (plan Task 6).
 */
export function computePaperKpis(series: ReadonlyArray<SnapshotSeriesPoint>): PaperKpis {
  const drawdown = computeMaxDrawdownSegment(series);
  return {
    netAssets: series.length > 0 ? (series[series.length - 1] as SnapshotSeriesPoint).netAssets : null,
    todayChangePct: computeTodayChangePct(series),
    cumulativeChangePct: computeCumulativeChangePct(series),
    maxDrawdownPct: drawdown ? drawdown.pct : null
  };
}
