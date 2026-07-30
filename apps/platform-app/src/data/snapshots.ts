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

import {
  NYSE_EARLY_CLOSE_DATES,
  TRADING_CALENDAR_YEARS,
  isUsTradingDay,
  usEasternTradingDayUtcRange
} from "@packages/shared-types";

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
  /** The currency `price`/`costPrice` are quoted in, straight from Longbridge's
   * `trade positions` row (live blobs carry `"USD"` for `QQQ.US`). Typed
   * because `parsePerformanceBasis` below REFUSES to add two positions whose
   * currencies differ - see that function for why. */
  currency?: string;
  [key: string]: unknown;
}

export interface OwnerSnapshot {
  id: string;
  ownerId: string | null;
  fetchedAt: string;
  netAssets: number | null;
  /**
   * The `market_value` column, verbatim. HAZARD, stated because it is not
   * visible in the number: official-paper-monitor.mjs's `estimateMarketValue`
   * computes it as a plain `sum(quantity * price)` over the positions, and a
   * position's price is in the POSITION's own currency - so on a portfolio
   * holding both a US and an HK name this column adds USD to HKD. On the live
   * account it happens to be a single USD holding (670.90) sitting under an
   * HKD-reporting account, so it is not even in the same currency as
   * `netAssets`: subtracting it from `netAssets` to get "cash", or dividing it
   * by `netAssets` to get an exposure ratio, produces a number in no currency
   * at all. Nothing in this module builds a percentage or a difference from it;
   * a new caller must not either. Use `basis`, which is single-currency by
   * construction, or the per-position values with their own `currency`.
   */
  marketValue: number;
  positions: SnapshotPosition[];
  /** From the snapshot's `raw` JSON blob (report-data.mjs/official-paper-monitor.mjs
   * `degraded`/`degradedReason` field convention) - total-fetch-failure or
   * per-position degradation, must be surfaced, never swallowed. */
  degraded: boolean;
  degradedReason: string | null;
  /**
   * The currency `netAssets` is DENOMINATED IN, as the broker itself reported
   * it (`raw.primaryAsset.currency`), or null when the blob does not say.
   *
   * Not cosmetic. Measured 2026-07-30 against the mini's live
   * runtime/trading.sqlite: this deployment's Longbridge paper account reports
   * `primaryAsset.currency = "HKD"` with `net_assets = 860251.88`, while its
   * only funded cash bucket is USD 122,079.05. Every net-asset renderer used
   * to hardcode " 美元", so the home page and /paper both told the operator
   * they held "860,251.88 美元" - roughly eight times their actual value - and
   * flatly contradicted the personal page, which reads the same field through
   * scheduled-report.mjs's `translateCurrency` and correctly prints 港元.
   * Nothing may claim a currency this field does not state; see
   * render/format.ts's formatAccountAmount for the unknown-currency case.
   */
  reportingCurrency: string | null;
  /**
   * The account value on an FX-FREE basis - see `parsePerformanceBasis`. This,
   * NOT `netAssets`, is what every return/drawdown percentage on the paper page
   * is measured from.
   */
  basis: PerformanceBasisResult;
  /**
   * The conversion rate the broker's own reporting-currency aggregate implies,
   * when it can be attributed to one funded bucket - see
   * `parseImpliedConversion`. Null when nothing is being converted (or when the
   * blob does not say enough to tell).
   */
  impliedConversion: ImpliedConversion | null;
}

// ---------------------------------------------------------------------------
// F1: the FX-free performance basis
//
// WHY THIS EXISTS - measured, not hypothesised. On 2026-07-30 the deployed
// mini's 64 `official_paper_snapshots` rows were parsed one by one. Across the
// ENTIRE history `primaryAsset.cash_infos[USD].available_cash` is constant at
// 122,079.05 and the single position is 1 share of QQQ.US: nothing was bought
// or sold. Yet `net_assets` (HKD) fell 957,876.46 -> 860,251.88 between the
// 2026-07-22 and 2026-07-23 sessions, because the rate the broker's own
// `total_cash` implies (total_cash / available_cash[USD]) jumped
// 7.801554 -> 7.008233 at `fetched_at = 2026-07-23T13:30:02.603Z`. USD/HKD is
// pegged into a 7.75-7.85 band, so 7.008 is a broker rate-table artifact.
// /paper turned that artifact into 累计收益 -10.19% and 最大回撤 -10.20%.
//
// THE RULE, stated as a rule rather than as a patch for this one glitch: a
// percentage between two account values is only evidence of performance when
// both values are measured on the SAME basis. `net_assets` is not such a
// basis - it is a reporting-currency aggregate the broker rebuilds each poll
// from whatever its rate table says at that instant, so a difference between
// two of them mixes real P&L with rate-table movement and cannot be split
// back apart after the fact. What IS trustworthy is the account's own
// single-currency amounts: a funded cash bucket is stated in its own currency
// and a position is priced in its own currency, and neither passes through a
// cross rate.
//
// So the basis is rebuilt from those amounts, and ONLY when every one of them
// is in a single currency. A genuinely multi-currency account has no FX-free
// total, and this module returns a gap for it rather than picking a rate -
// which is the whole defect, one level up.
// ---------------------------------------------------------------------------

/** Why a snapshot has no FX-free performance basis. Every value is a stated
 * reason a caller must show; none of them may be rendered as a number. */
export type PerformanceBasisGap =
  /** The blob carries no `primaryAsset`, or does not parse at all. */
  | "no-account-data"
  /** No funded cash bucket and no priced position: nothing to total. */
  | "no-currency-evidence"
  /** Funded cash and/or held positions span MORE than one currency, so any
   * total would need a cross rate - the defect this module exists to refuse. */
  | "mixed-currencies"
  /** A held position the producer itself could not value (`priceSource:
   * 'zero'`, or no finite price at all). Counting it as 0 would understate the
   * basis by an unknown amount, which is a fabrication, not a gap. */
  | "position-not-valued";

export interface PerformanceBasis {
  /** The ONE currency every amount in `value` is stated in. */
  currency: string;
  /** Funded cash + position market value, all in `currency`, no conversion. */
  value: number;
  /** True when the broker reports the account in a DIFFERENT currency than
   * `currency`, i.e. its `net_assets` is an FX-converted aggregate and this
   * value was rebuilt from the account's own amounts instead of read off it. */
  rebuiltFromReportingCurrency: boolean;
}

export type PerformanceBasisResult =
  | { ok: true; basis: PerformanceBasis }
  | { ok: false; gap: PerformanceBasisGap };

/** The reporting-currency-per-held-currency rate the broker's own numbers
 * imply. Not a market quote and never rendered as one - it exists so the page
 * can say "this aggregate is converted, and the conversion moved". */
export interface ImpliedConversion {
  /** Currency `total_cash`/`net_assets` are stated in (e.g. `HKD`). */
  reportingCurrency: string;
  /** Currency the money is actually held in (e.g. `USD`). */
  heldCurrency: string;
  /** `total_cash / available_cash[heldCurrency]`. */
  rate: number;
}

function readAmount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readCurrency(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

interface PrimaryAssetBlob {
  currency?: unknown;
  total_cash?: unknown;
  cash_infos?: Array<{ currency?: unknown; available_cash?: unknown }> | null;
}

function parsePrimaryAsset(raw: unknown): PrimaryAssetBlob | null {
  try {
    const parsed = JSON.parse(String(raw)) as { primaryAsset?: PrimaryAssetBlob | null };
    return parsed.primaryAsset ?? null;
  } catch {
    return null;
  }
}

/** Cash buckets with a non-zero balance, in their OWN currency. A zero bucket
 * is skipped rather than treated as a currency the account is exposed to -
 * live blobs carry an all-zero HKD bucket alongside the funded USD one, and
 * counting it would make every account look multi-currency. */
function fundedCashBuckets(asset: PrimaryAssetBlob): Array<{ currency: string; amount: number }> {
  const buckets: Array<{ currency: string; amount: number }> = [];
  for (const info of asset.cash_infos ?? []) {
    const currency = readCurrency(info?.currency);
    const amount = readAmount(info?.available_cash);
    if (currency === null || amount === null || amount === 0) {
      continue;
    }
    buckets.push({ currency, amount });
  }
  return buckets;
}

/**
 * Rebuilds the account's value on a single-currency, conversion-free basis, or
 * says why it cannot. See the section header above for the rule; the short
 * version is that this is the only number on this page that can carry a
 * percentage, because it is the only one no exchange rate touched.
 *
 * `positions` is the parsed `positions` column, which official-paper-monitor.mjs
 * writes from the same object it puts in `raw.positions` - each row carries its
 * own `currency` and the `price` attachPriceSource resolved for it.
 */
function parsePerformanceBasis(raw: unknown, positions: readonly SnapshotPosition[]): PerformanceBasisResult {
  const asset = parsePrimaryAsset(raw);
  if (!asset) {
    return { ok: false, gap: "no-account-data" };
  }

  const amounts = fundedCashBuckets(asset);

  for (const position of positions) {
    const quantity = readAmount(position.quantity);
    if (quantity === null || quantity === 0) {
      continue; // not held; its currency and price are irrelevant either way.
    }
    const currency = readCurrency(position.currency);
    const price = readAmount(position.price);
    if (currency === null || price === null || position.priceSource === "zero") {
      return { ok: false, gap: "position-not-valued" };
    }
    amounts.push({ currency, amount: quantity * price });
  }

  if (amounts.length === 0) {
    return { ok: false, gap: "no-currency-evidence" };
  }
  const currencies = new Set(amounts.map((entry) => entry.currency));
  if (currencies.size > 1) {
    return { ok: false, gap: "mixed-currencies" };
  }

  const currency = amounts[0]?.currency as string;
  const reportingCurrency = readCurrency(asset.currency);
  return {
    ok: true,
    basis: {
      currency,
      value: amounts.reduce((sum, entry) => sum + entry.amount, 0),
      rebuiltFromReportingCurrency: reportingCurrency !== null && reportingCurrency !== currency
    }
  };
}

/**
 * The conversion rate implied by the broker's own two statements of the same
 * cash: `total_cash` in the reporting currency and `available_cash` in the
 * currency the cash is actually held in. Returns null unless there is EXACTLY
 * one funded bucket in a different currency - with two funded buckets the
 * single `total_cash` figure cannot be attributed to one rate, and with the
 * bucket already in the reporting currency there is no conversion to describe.
 */
function parseImpliedConversion(raw: unknown): ImpliedConversion | null {
  const asset = parsePrimaryAsset(raw);
  if (!asset) {
    return null;
  }
  const reportingCurrency = readCurrency(asset.currency);
  const totalCash = readAmount(asset.total_cash);
  if (reportingCurrency === null || totalCash === null) {
    return null;
  }
  const buckets = fundedCashBuckets(asset);
  const only = buckets.length === 1 ? buckets[0] : undefined;
  if (!only || only.currency === reportingCurrency) {
    return null;
  }
  const rate = totalCash / only.amount;
  return Number.isFinite(rate) ? { reportingCurrency, heldCurrency: only.currency, rate } : null;
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

/**
 * Reads the account's reporting currency out of the snapshot `raw` blob.
 * `primaryAsset` is the exact object official-paper-monitor.mjs persists from
 * Longbridge's `trade assets` response (see report-data.mjs's
 * normalizeOfficialPaperSnapshot), and `currency` is the field Longbridge
 * itself uses to say what `net_assets`/`total_cash` are denominated in.
 *
 * Returns null - never a guessed "USD" - for a blob that has no primaryAsset,
 * no currency, a blank one, or that does not parse. A caller must then decline
 * to make a currency claim rather than print a plausible one.
 */
function parseReportingCurrency(raw: unknown): string | null {
  try {
    const parsed = JSON.parse(String(raw)) as { primaryAsset?: { currency?: unknown } | null };
    const currency = parsed.primaryAsset?.currency;
    if (typeof currency !== "string") {
      return null;
    }
    const trimmed = currency.trim().toUpperCase();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function mapSnapshotRow(row: Record<string, unknown>): OwnerSnapshot {
  const { degraded, degradedReason } = parseDegraded(row.raw);
  const positions = parsePositions(row.positions);
  return {
    reportingCurrency: parseReportingCurrency(row.raw),
    basis: parsePerformanceBasis(row.raw, positions),
    impliedConversion: parseImpliedConversion(row.raw),
    id: String(row.id),
    ownerId: row.owner_id === null || row.owner_id === undefined ? null : String(row.owner_id),
    fetchedAt: String(row.fetched_at),
    netAssets: row.net_assets === null || row.net_assets === undefined ? null : Number(row.net_assets),
    marketValue: Number(row.market_value),
    positions,
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
  /**
   * The broker's reporting-currency aggregate, verbatim. A point-in-time
   * statement of what the broker says the account is worth, and fine to PRINT
   * next to `reportingCurrency` - but it must never be differenced against
   * another point's, because on a converted account the difference is part FX
   * rate-table movement (see the F1 section header). Use `basis` for anything
   * that becomes a percentage or a plotted curve.
   */
  netAssets: number | null;
  /** Carries OwnerSnapshot.marketValue's cross-currency hazard unchanged - read
   * that field's note before differencing or dividing this. */
  marketValue: number;
  /** The FX-free basis every percentage and the net-worth curve are built on. */
  basis: PerformanceBasisResult;
  /** Present so a page can disclose that `netAssets` is converted, and that
   * the conversion moved. See ImpliedConversion / summarizeFxConversion. */
  impliedConversion: ImpliedConversion | null;
  degraded: boolean;
  /** Carried per point (not per series) because it is a property of the row
   * the broker returned, and it CAN change between rows - on this deployment
   * it is the same HKD for all 64 live rows, but a series that silently
   * mixed two denominations into one curve would be exactly the kind of
   * number nobody could trust. See OwnerSnapshot.reportingCurrency. */
  reportingCurrency: string | null;
}

function toSeriesPoint(snapshot: OwnerSnapshot): SnapshotSeriesPoint {
  return {
    fetchedAt: snapshot.fetchedAt,
    netAssets: snapshot.netAssets,
    marketValue: snapshot.marketValue,
    basis: snapshot.basis,
    impliedConversion: snapshot.impliedConversion,
    degraded: snapshot.degraded,
    reportingCurrency: snapshot.reportingCurrency
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
//
// F1 (2026-07-30): every percentage below is measured on `basis`, the FX-free
// single-currency total, NOT on `netAssets`. See the "F1: the FX-free
// performance basis" section header for the measurement that forced this and
// the rule it follows. Until this change /paper printed 累计收益 -10.19% and
// 最大回撤 -10.20% for an account that never traded, both of them the same
// broker rate-table jump seen twice.
// ---------------------------------------------------------------------------

/** One point of the series reduced to the number a percentage may be built
 * from: its FX-free basis value, in a named currency, at a known index. */
export interface BasisPoint {
  /** Index into the ORIGINAL series array, so a caller can map a result back
   * to the point's `fetchedAt` (and the curve renderer can place it on the x
   * axis it already computed from the full series). */
  index: number;
  currency: string;
  value: number;
}

/** Why a series cannot carry a return figure at all. Both variants are stated
 * reasons the page must print; neither may be shown as a number. */
export type ReturnSeriesGap =
  /** Fewer than two points have an FX-free basis. `gaps` lists the distinct
   * reasons the unusable points gave, so the page can name them instead of
   * saying only 数据不足. */
  | { kind: "too-few-points"; usable: number; gaps: PerformanceBasisGap[] }
  /**
   * The basis currency CHANGES within the series (e.g. an account refunded
   * from USD into HKD midway). Differencing across that switch would be the
   * same cross-currency comparison this whole section exists to refuse, and no
   * rate we could pick to bridge it would be evidence of anything.
   */
  | { kind: "mixed-basis-currency"; currencies: string[] };

export type ReturnSeriesResult =
  | { ok: true; points: BasisPoint[] }
  | { ok: false; gap: ReturnSeriesGap };

/**
 * The one gate every return/drawdown/curve computation in this module goes
 * through: reduce the series to its FX-free basis points, and refuse the whole
 * series if there are fewer than two of them or if their currency is not
 * constant. Exported because the paper page plots exactly these points - a
 * curve drawn from a different set than the KPI numbers were computed from
 * would let the picture and the figures disagree.
 */
export function resolveReturnSeries(series: ReadonlyArray<SnapshotSeriesPoint>): ReturnSeriesResult {
  const points: BasisPoint[] = [];
  const gaps = new Set<PerformanceBasisGap>();
  series.forEach((point, index) => {
    if (point.basis.ok) {
      points.push({ index, currency: point.basis.basis.currency, value: point.basis.basis.value });
    } else {
      gaps.add(point.basis.gap);
    }
  });

  if (points.length < 2) {
    return { ok: false, gap: { kind: "too-few-points", usable: points.length, gaps: [...gaps] } };
  }
  const currencies = [...new Set(points.map((point) => point.currency))];
  if (currencies.length > 1) {
    return { ok: false, gap: { kind: "mixed-basis-currency", currencies } };
  }
  return { ok: true, points };
}

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
 * Classic peak-to-trough max-drawdown scan over the series' FX-free basis
 * values (`resolveReturnSeries`). Returns `null` for any series that gate
 * rejects - the "incomputable" case (never a fabricated number). A series that
 * only ever rises still returns a real segment with `pct: 0` (peakIndex ===
 * troughIndex === the first usable point): "no drawdown observed" is a
 * computable answer, not an incomputable one.
 */
export function computeMaxDrawdownSegment(series: ReadonlyArray<SnapshotSeriesPoint>): DrawdownSegment | null {
  const resolved = resolveReturnSeries(series);
  if (!resolved.ok) {
    return null;
  }
  const usable = resolved.points;

  const first = usable[0] as BasisPoint;
  let peak = first;
  let worst: DrawdownSegment = { peakIndex: first.index, troughIndex: first.index, pct: 0 };

  for (let i = 1; i < usable.length; i += 1) {
    const point = usable[i] as BasisPoint;
    if (point.value > peak.value) {
      peak = point;
      continue;
    }
    if (peak.value === 0) {
      continue; // can't express a percentage decline off a zero base.
    }
    const pct = ((point.value - peak.value) / peak.value) * 100;
    if (Number.isFinite(pct) && pct < worst.pct) {
      worst = { peakIndex: peak.index, troughIndex: point.index, pct };
    }
  }

  return worst;
}

/**
 * Today's change vs. the most recent basis point whose Beijing calendar day is
 * strictly before the latest basis point's day - the series-local analog of
 * `loadPreviousDaySnapshotForOwner` (same "most recent snapshot before today"
 * idea), used here because `computePaperKpis` only receives the series, not a
 * separate DB round-trip. Returns null (never a fabricated "+0.00%") when no
 * earlier-day basis point exists.
 */
function computeTodayChangePct(points: ReadonlyArray<BasisPoint>, series: ReadonlyArray<SnapshotSeriesPoint>): number | null {
  const latest = points[points.length - 1];
  if (!latest) {
    return null;
  }
  const latestDay = beijingDateStamp((series[latest.index] as SnapshotSeriesPoint).fetchedAt);

  for (let i = points.length - 2; i >= 0; i -= 1) {
    const point = points[i] as BasisPoint;
    if (beijingDateStamp((series[point.index] as SnapshotSeriesPoint).fetchedAt) < latestDay) {
      if (point.value === 0) {
        return null;
      }
      const pct = ((latest.value - point.value) / point.value) * 100;
      return Number.isFinite(pct) ? pct : null;
    }
  }
  return null;
}

/** Cumulative change: latest basis point vs. the FIRST basis point (the oldest
 * point the caller's `limit` reached back to) - null when the first point's
 * value is zero, so there is no base to express a percentage off. */
function computeCumulativeChangePct(points: ReadonlyArray<BasisPoint>): number | null {
  const first = points[0];
  const latest = points[points.length - 1];
  if (!first || !latest || first.value === 0) {
    return null;
  }
  const pct = ((latest.value - first.value) / first.value) * 100;
  return Number.isFinite(pct) ? pct : null;
}

/**
 * How the broker's reporting-currency aggregate relates to the currency the
 * money is actually held in, across the whole series - the input to the
 * disclosure that has to sit next to 净值 once we know that number is
 * converted.
 *
 * `rateChanges` is what makes this worth computing: on the live series the rate
 * takes exactly ONE step (7.801554 -> 7.008233 at 2026-07-23T13:30:02.603Z),
 * and that step is the entire ~10% move a reader sees in 净值 over a history
 * with no trades in it.
 */
export interface FxConversionSummary {
  reportingCurrency: string;
  heldCurrency: string;
  firstRate: number;
  latestRate: number;
  minRate: number;
  maxRate: number;
  /** Every point at which the implied rate differs from the previous point's. */
  rateChanges: Array<{ fetchedAt: string; fromRate: number; toRate: number }>;
}

/**
 * Null when nothing in the series is being converted (or the blobs never said
 * enough to tell), so a caller can skip the disclosure entirely rather than
 * print an empty one. Null too when the reporting/held currency PAIR is not
 * constant across the series, because one summary cannot then describe it -
 * a caller in that position must fall back to per-point disclosure, and the
 * return figures are already refused by `resolveReturnSeries`'s
 * mixed-basis-currency gate.
 */
export function summarizeFxConversion(series: ReadonlyArray<SnapshotSeriesPoint>): FxConversionSummary | null {
  const converted = series.filter(
    (point): point is SnapshotSeriesPoint & { impliedConversion: ImpliedConversion } => point.impliedConversion !== null
  );
  if (converted.length === 0) {
    return null;
  }
  const pairs = new Set(converted.map((p) => `${p.impliedConversion.reportingCurrency}/${p.impliedConversion.heldCurrency}`));
  if (pairs.size > 1) {
    return null;
  }

  const first = converted[0] as SnapshotSeriesPoint & { impliedConversion: ImpliedConversion };
  const latest = converted[converted.length - 1] as SnapshotSeriesPoint & { impliedConversion: ImpliedConversion };
  const rates = converted.map((p) => p.impliedConversion.rate);
  const rateChanges: Array<{ fetchedAt: string; fromRate: number; toRate: number }> = [];
  for (let i = 1; i < converted.length; i += 1) {
    const previous = converted[i - 1] as SnapshotSeriesPoint & { impliedConversion: ImpliedConversion };
    const current = converted[i] as SnapshotSeriesPoint & { impliedConversion: ImpliedConversion };
    // Exact inequality on purpose: these are two derived quotients, and any
    // epsilon we picked would be a claim about how much rate movement is
    // "really" a change. A reader gets the numbers and decides.
    if (current.impliedConversion.rate !== previous.impliedConversion.rate) {
      rateChanges.push({
        fetchedAt: current.fetchedAt,
        fromRate: previous.impliedConversion.rate,
        toRate: current.impliedConversion.rate
      });
    }
  }

  return {
    reportingCurrency: first.impliedConversion.reportingCurrency,
    heldCurrency: first.impliedConversion.heldCurrency,
    firstRate: first.impliedConversion.rate,
    latestRate: latest.impliedConversion.rate,
    minRate: Math.min(...rates),
    maxRate: Math.max(...rates),
    rateChanges
  };
}

export interface PaperKpis {
  /** 净值: the latest point's `netAssets` - the broker's own reporting-currency
   * statement, printed as-is. NOT the basis the percentages below use; see
   * `fxConversion` for the disclosure that must accompany it when the two
   * currencies differ. */
  netAssets: number | null;
  /** The currency `netAssets` is denominated in - the LATEST point's, i.e. the
   * same point `netAssets` itself came from. Null when the series is empty or
   * that point's blob never stated one. See OwnerSnapshot.reportingCurrency. */
  reportingCurrency: string | null;
  /** The currency 今日/累计/最大回撤 were MEASURED in (the FX-free basis
   * currency), which on a converted account is NOT `reportingCurrency`. Null
   * exactly when `returnGap` is non-null. */
  basisCurrency: string | null;
  /** 今日: see computeTodayChangePct. */
  todayChangePct: number | null;
  /** 累计: see computeCumulativeChangePct. */
  cumulativeChangePct: number | null;
  /** 最大回撤: see computeMaxDrawdownSegment; always <= 0 when computable. */
  maxDrawdownPct: number | null;
  /** Non-null exactly when the three percentages above are ALL null because no
   * return series could be built at all. A caller must render the reason, not
   * a bare 数据不足 - and must never substitute a netAssets-derived number. */
  returnGap: ReturnSeriesGap | null;
  /** Non-null when `netAssets` is a converted aggregate. See
   * summarizeFxConversion. */
  fxConversion: FxConversionSummary | null;
}

/**
 * Derives the paper page's KPI-row values from a chronologically ordered
 * snapshot series (as returned by `loadSnapshotSeriesForOwner`). Every field
 * independently resolves to `null` (never a fabricated number) when its own
 * data requirement isn't met - callers render `null` alongside the stated
 * reason in `returnGap`, never a bare placeholder.
 */
export function computePaperKpis(series: ReadonlyArray<SnapshotSeriesPoint>): PaperKpis {
  const latest = series.length > 0 ? (series[series.length - 1] as SnapshotSeriesPoint) : null;
  const resolved = resolveReturnSeries(series);
  const shared = {
    netAssets: latest ? latest.netAssets : null,
    reportingCurrency: latest ? latest.reportingCurrency : null,
    fxConversion: summarizeFxConversion(series)
  };

  if (!resolved.ok) {
    return {
      ...shared,
      basisCurrency: null,
      todayChangePct: null,
      cumulativeChangePct: null,
      maxDrawdownPct: null,
      returnGap: resolved.gap
    };
  }

  const drawdown = computeMaxDrawdownSegment(series);
  return {
    ...shared,
    basisCurrency: (resolved.points[0] as BasisPoint).currency,
    todayChangePct: computeTodayChangePct(resolved.points, series),
    cumulativeChangePct: computeCumulativeChangePct(resolved.points),
    maxDrawdownPct: drawdown ? drawdown.pct : null,
    returnGap: null
  };
}

// ---------------------------------------------------------------------------
// F2 (req §1.6): the QQQ benchmark line for the net-worth curve
//
// THE HARD PART IS ALIGNMENT, and the previous round deliberately shipped an
// honest "not wired up yet" note rather than risk a benchmark that was off by
// a day. This is that alignment, done against the live table rather than
// against an assumption about it.
//
// WHAT `daily_facts.trading_day` ACTUALLY IS. It is not a US trading day. It
// is `resolveReportWindow`'s `label` in scheduled-report.mjs - the BEIJING
// calendar date of the report RUN (or its `--date` argument) - and that
// function's own header states the relationship: "a daily report's window
// brackets exactly one US regular session: the one on L-1".
//
// WHY THIS MODULE ALIGNS ON `data_time` AND NOT ON THAT LABEL. Because the
// label only holds when the run happens on schedule, and on the live table it
// frequently did not. Measured 2026-07-30 on the mini, all six `qqq.price`
// rows:
//
//   trading_day  value   data_time                 -> US/Eastern instant
//   2026-07-21   696.06  2026-07-20T20:00:00.000Z     07-20 16:00  (a close)
//   2026-07-26   684.23  2026-07-24T20:00:00.000Z     07-24 16:00  (a close)
//   2026-07-27   677.96  2026-07-27T15:52:37.000Z     07-27 11:52  (intraday)
//   2026-07-28   682.12  2026-07-27T20:00:00.000Z     07-27 16:00  (a close)
//   2026-07-29   668.47  2026-07-29T14:34:12.000Z     07-29 10:34  (intraday)
//   2026-07-30   665.08  2026-07-29T16:22:29.000Z     07-29 12:22  (intraday)
//
// Row `2026-07-26` is the clincher: label-1 is 07-25, a Saturday, and the
// value is in fact Friday 07-24's close - the label is off by two sessions
// because the run slipped a day. Aligning on the label would have filed a
// 07-29 intraday quote (row 2026-07-29) against the 07-28 session, which is
// exactly the silently-wrong-by-one-day curve the previous round refused to
// draw. `data_time` is the Longbridge quote's own timestamp, written by
// report-facts.mjs's `buildQqqFacts` from `qqqQuote.timestamp`; it cannot be
// off by a day because it is not derived from the run's clock at all.
//
// AND ONLY CLOSES COUNT. Three of those six rows are intraday quotes from
// late/manual runs. A daily benchmark line built partly from closes and partly
// from whenever-the-job-happened-to-run is not a daily benchmark. This module
// therefore accepts a row only when its own `data_time` is at or after the
// regular close of the session it falls in, and reports the rest as rejected
// WITH the reason - which is also why the page can no longer claim "QQQ 每日
// 收盘数据已入库": half of it is not closing data.
// ---------------------------------------------------------------------------

/** Next/previous `YYYY-MM-DD` label, anchored at noon UTC before shifting -
 * the same trick trading-schedule.mjs's and trading-session.ts's own
 * `shiftDateLabel` use, so it is DST-proof for any zone within +/-12h. Pure
 * calendar arithmetic; all ZONE math in this section goes through
 * shared-types' `usEasternTradingDayUtcRange`, which is itself parity-checked
 * against the .mjs implementation. */
function shiftDateLabel(dateLabel: string, days: number): string {
  const anchor = new Date(`${dateLabel}T12:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return anchor.toISOString().slice(0, 10);
}

/**
 * The US/Eastern calendar date an instant falls on - the session key for US
 * equities. Derived using ONLY `usEasternTradingDayUtcRange` (no fourth copy
 * of the zoned-date-label computation): America/New_York is UTC-4 or UTC-5, so
 * an instant's Eastern date is either its own UTC date or the day before it,
 * never after, and comparing against that UTC date's Eastern midnight decides
 * which.
 *
 * Returns null for an unparseable instant, or for one outside the years
 * `TRADING_CALENDAR_YEARS` covers - past that boundary `isUsTradingDay` can
 * only answer "weekday", which would silently call a holiday a session.
 */
export function usEasternSessionDate(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return null;
  }
  const utcLabel = new Date(ms).toISOString().slice(0, 10);
  const sessionDate = ms >= Date.parse(usEasternTradingDayUtcRange(utcLabel).dayStart)
    ? utcLabel
    : shiftDateLabel(utcLabel, -1);
  return TRADING_CALENDAR_YEARS.includes(Number(sessionDate.slice(0, 4))) ? sessionDate : null;
}

/** UTC instant of the regular-session close on `sessionDate` (13:00 ET on an
 * NYSE early-close date, 16:00 ET otherwise - the same two cases
 * trading-session.ts's own `closeMinute` splits on, reading the same exported
 * `NYSE_EARLY_CLOSE_DATES` set). */
function usEasternSessionCloseMs(sessionDate: string): number {
  const dayStartMs = Date.parse(usEasternTradingDayUtcRange(sessionDate).dayStart);
  const closeMinute = NYSE_EARLY_CLOSE_DATES.has(sessionDate) ? 13 * 60 : 16 * 60;
  return dayStartMs + closeMinute * 60_000;
}

/** True when `a` and `b` are consecutive US regular sessions, i.e. no regular
 * trading day sits strictly between them. Used to decide whether two
 * benchmark observations may be JOINED BY A LINE: joining across a session
 * that has no observation would draw an interpolation as if it were data. */
function areAdjacentSessions(a: string, b: string): boolean {
  for (let day = shiftDateLabel(a, 1); day < b; day = shiftDateLabel(day, 1)) {
    if (isUsTradingDay(day)) {
      return false;
    }
  }
  return true;
}

/** One US session covered by a snapshot series. */
interface SnapshotSession {
  sessionDate: string;
  /** Index of the LAST series point in this session - the point contemporaneous
   * with that session's close, and therefore the one a daily benchmark
   * observation is compared against. */
  lastIndex: number;
}

/**
 * Groups a snapshot series into the US sessions it covers, oldest first.
 * A point whose session cannot be determined, or whose session is not a
 * regular trading session (a weekend/holiday capture), is skipped - there is
 * no daily benchmark observation for a day the market did not open.
 */
function snapshotSessions(series: ReadonlyArray<SnapshotSeriesPoint>): SnapshotSession[] {
  const sessions: SnapshotSession[] = [];
  series.forEach((point, index) => {
    const sessionDate = usEasternSessionDate(point.fetchedAt);
    if (sessionDate === null || !isUsTradingDay(sessionDate)) {
      return;
    }
    const last = sessions[sessions.length - 1];
    if (last && last.sessionDate === sessionDate) {
      last.lastIndex = index;
      return;
    }
    sessions.push({ sessionDate, lastIndex: index });
  });
  return sessions;
}

/** One aligned benchmark observation. */
export interface BenchmarkPoint {
  sessionDate: string;
  /** Index into the snapshot series this observation is aligned to (the last
   * snapshot of `sessionDate`), so the curve can place it at an x the self
   * curve already uses. */
  seriesIndex: number;
  /** `daily_facts.qqq.price` for that session, in USD. */
  price: number;
  /** The fact's own `data_time` - the close instant it was accepted for. */
  dataTime: string;
  /** `daily_facts.trading_day` this row was filed under. Kept so the page can
   * show that the label and the session differ, rather than quietly papering
   * over it. */
  filedUnder: string;
  /** True when this point may be joined to the PREVIOUS accepted point by a
   * line, i.e. their sessions are consecutive. False on the first point and
   * across any session that has no accepted close. */
  joinsPrevious: boolean;
}

export interface BenchmarkSeries {
  symbolLabel: string;
  points: BenchmarkPoint[];
  /** Sessions the snapshot series covers that got no accepted close. */
  unalignedSessions: string[];
  /** Rows read but not accepted, each with the reason - the page prints these
   * so "the benchmark is thin" is legible as a data problem with a named
   * cause rather than as a bug in the chart. */
  rejected: Array<{ filedUnder: string; reason: string }>;
}

const QQQ_PRICE_FACT_KEY = "qqq.price";

/**
 * Loads the QQQ daily-close benchmark aligned to `series`, per the alignment
 * rule documented in this section's header. Never interpolates: a session with
 * no accepted close produces no point and is named in `unalignedSessions`.
 */
export function loadQqqBenchmarkSeries(db: DatabaseSync, series: ReadonlyArray<SnapshotSeriesPoint>): BenchmarkSeries {
  const sessions = snapshotSessions(series);
  const empty: BenchmarkSeries = { symbolLabel: "QQQ", points: [], unalignedSessions: [], rejected: [] };
  if (sessions.length === 0) {
    return empty;
  }

  const rows = db
    .prepare(`SELECT trading_day, value_num, data_time FROM daily_facts WHERE fact_key = ? ORDER BY data_time ASC`)
    .all(QQQ_PRICE_FACT_KEY) as Array<Record<string, unknown>>;

  const rejected: Array<{ filedUnder: string; reason: string }> = [];
  const closeBySession = new Map<string, { price: number; dataTime: string; filedUnder: string }>();

  for (const row of rows) {
    const filedUnder = String(row.trading_day ?? "");
    const price = readAmount(row.value_num);
    const dataTime = String(row.data_time ?? "");
    if (price === null) {
      rejected.push({ filedUnder, reason: "这一行没有数值（value_num 为空）" });
      continue;
    }
    const sessionDate = usEasternSessionDate(dataTime);
    if (sessionDate === null) {
      // report-facts.mjs's buildQqqFacts falls back to the bare trading_day
      // label when the quote carried no timestamp at all, which lands here.
      rejected.push({ filedUnder, reason: `数据时间「${dataTime}」不是一个可判定交易时段的时刻，无法确定它属于哪个交易日` });
      continue;
    }
    if (!isUsTradingDay(sessionDate)) {
      rejected.push({ filedUnder, reason: `数据时间落在非交易日 ${sessionDate}` });
      continue;
    }
    if (Date.parse(dataTime) < usEasternSessionCloseMs(sessionDate)) {
      rejected.push({ filedUnder, reason: `${sessionDate} 的盘中报价（抓取于收盘前），不是收盘价` });
      continue;
    }
    // Rows are read oldest-first, so a later row for the same session (a
    // re-run) wins - the freshest accepted close for that session.
    closeBySession.set(sessionDate, { price, dataTime, filedUnder });
  }

  const points: BenchmarkPoint[] = [];
  const unalignedSessions: string[] = [];
  let previousAccepted: string | null = null;
  for (const session of sessions) {
    const close = closeBySession.get(session.sessionDate);
    if (!close) {
      unalignedSessions.push(session.sessionDate);
      continue;
    }
    points.push({
      sessionDate: session.sessionDate,
      seriesIndex: session.lastIndex,
      price: close.price,
      dataTime: close.dataTime,
      filedUnder: close.filedUnder,
      joinsPrevious: previousAccepted !== null && areAdjacentSessions(previousAccepted, session.sessionDate)
    });
    previousAccepted = session.sessionDate;
  }

  return { symbolLabel: "QQQ", points, unalignedSessions, rejected };
}
