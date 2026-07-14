/**
 * Home-page data aggregation (Task 5). Every read here is filtered by
 * `ownerId` (the calling member's id) at the SQL level - never fetched
 * unfiltered and then trimmed in memory - so a compromised/careless caller
 * can't accidentally leak another member's rows by forgetting a JS-side
 * filter (plan Global Constraints: "服务端强制隔离...在 handler 层查询即过滤").
 *
 * Snapshot ownership precedence mirrors the ONE adjudicated rule already
 * shared between market-alerts-store.mjs and market-alerts-poll.mjs
 * (apps/openclaw-config/scripts/market-alerts-store.mjs's
 * `loadLatestSnapshotForOwner`): the owner's own row wins even if older than
 * every other row; a row that can't be attributed to a single owner is used
 * as a fallback ONLY when the owner has none of their own. That repo's
 * fallback set was originally just `owner_id IS NULL` (every row predates
 * per-owner snapshots); official-paper-monitor.mjs's `saveSnapshot` (task H4)
 * now also writes the `'__shared__'` sentinel (SHARED_OWNER_SENTINEL) when
 * 0 or >1 members are active, so this port of the rule folds that sentinel
 * into the SAME fallback set rather than inventing a third precedence
 * variant. The sentinel string is re-declared here (not imported from the
 * .mjs script) because apps/openclaw-config/scripts is a plain-Node script
 * directory, not a TS project this workspace package depends on - the same
 * "re-declare the literal, comment cross-references the source of truth"
 * convention already used for `__legacy_system__` across identity.ts and
 * members.mjs.
 */
import type { DatabaseSync } from "node:sqlite";

/** Mirrors official-paper-monitor.mjs's SHARED_OWNER_SENTINEL: the owner_id
 * written when a snapshot can't be attributed to exactly one active member. */
const SHARED_OWNER_SENTINEL = "__shared__";

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

export interface AlertEventRow {
  id: string;
  ruleId: string;
  ownerId: string;
  symbol: string;
  ruleType: string;
  triggeredAt: string;
  value: number;
}

export interface ProposalRow {
  id: string;
  symbol: string;
  side: string;
  quantity: number;
  orderType: string;
  limitPrice: number | null;
  reason: string;
  status: string;
  createdAt: string;
  expiresAt: string;
}

export interface DisciplineRuleRow {
  id: string;
  ruleText: string;
  enforcement: "hard" | "proposal_check" | "self";
  linkedStrategy: string | null;
  enabled: boolean;
  createdAt: string;
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
 * rule (this module's header comment): the owner's OWN row wins even if
 * older than every other row; a row with no single attributable owner
 * (`owner_id IS NULL` - pre-H4 legacy rows - or `owner_id = '__shared__'` -
 * H4's explicit "can't attribute" sentinel) is used only as a fallback when
 * the owner has none of their own. `loadLatestSnapshotForOwner` and
 * `loadPreviousDaySnapshotForOwner` are both thin wrappers around this, so
 * the precedence logic itself exists in exactly one place - a future change
 * to the fallback set (or the rule itself) cannot update one entry point
 * and silently miss the other, which is exactly the "two independent copies
 * agree by coincidence, diverge later" failure mode
 * market-alerts-store.mjs's own loadLatestSnapshotForOwner was written to
 * eliminate (see this module's header comment).
 *
 * @param boundary Optional ISO instant; when given, both the own-row and
 *   fallback queries are additionally bounded to `fetched_at < boundary`
 *   (used by `loadPreviousDaySnapshotForOwner` to mean "before today").
 */
function loadSnapshotForOwnerImpl(db: DatabaseSync, ownerId: string, boundary?: string): OwnerSnapshot | null {
  const boundaryClause = boundary ? "AND fetched_at < ?" : "";
  const boundaryParams = boundary ? [boundary] : [];

  const ownRow = db
    .prepare(`${SNAPSHOT_SELECT} WHERE owner_id = ? ${boundaryClause} ORDER BY fetched_at DESC LIMIT 1`)
    .get(ownerId, ...boundaryParams) as Record<string, unknown> | undefined;
  if (ownRow) {
    return mapSnapshotRow(ownRow);
  }

  const fallbackRow = db
    .prepare(
      `${SNAPSHOT_SELECT} WHERE (owner_id IS NULL OR owner_id = ?) ${boundaryClause} ORDER BY fetched_at DESC LIMIT 1`
    )
    .get(SHARED_OWNER_SENTINEL, ...boundaryParams) as Record<string, unknown> | undefined;
  return fallbackRow ? mapSnapshotRow(fallbackRow) : null;
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

/**
 * Recent alert_events for this owner, joined to alert_rules for the
 * symbol/rule_type the mobile/desktop alert feed needs to render a
 * meaningful line (raw alert_events rows have neither). Owner-filtered at
 * the SQL level via `ae.owner_id = ?` - never joined-then-filtered in JS.
 */
export function loadRecentAlertEvents(db: DatabaseSync, ownerId: string, limit: number): AlertEventRow[] {
  const rows = db
    .prepare(`
      SELECT ae.id AS id, ae.rule_id AS rule_id, ae.owner_id AS owner_id,
             ae.triggered_at AS triggered_at, ae.value AS value,
             ar.symbol AS symbol, ar.rule_type AS rule_type
      FROM alert_events ae
      JOIN alert_rules ar ON ar.id = ae.rule_id
      WHERE ae.owner_id = ?
      ORDER BY ae.triggered_at DESC
      LIMIT ?
    `)
    .all(ownerId, limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    ruleId: String(row.rule_id),
    ownerId: String(row.owner_id),
    symbol: String(row.symbol),
    ruleType: String(row.rule_type),
    triggeredAt: String(row.triggered_at),
    value: Number(row.value)
  }));
}

/**
 * Pending proposals for this owner. Always empty in practice today (P6
 * hasn't shipped proposal creation yet) - the query itself is still real and
 * owner-filtered so P6 only has to start writing rows, not build this read.
 */
export function loadPendingProposals(db: DatabaseSync, ownerId: string): ProposalRow[] {
  const rows = db
    .prepare(`SELECT * FROM proposals WHERE owner_id = ? AND status = 'pending' ORDER BY created_at DESC`)
    .all(ownerId) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    symbol: String(row.symbol),
    side: String(row.side),
    quantity: Number(row.quantity),
    orderType: String(row.order_type),
    limitPrice: row.limit_price === null || row.limit_price === undefined ? null : Number(row.limit_price),
    reason: String(row.reason),
    status: String(row.status),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at)
  }));
}

/**
 * Enabled discipline_rules for this owner. Always empty in practice today
 * (P7 hasn't shipped strategy-memory writes yet) - same "real, owner-filtered
 * query ahead of the data existing" shape as loadPendingProposals above.
 */
export function loadDisciplineRules(db: DatabaseSync, ownerId: string): DisciplineRuleRow[] {
  const rows = db
    .prepare(`SELECT * FROM discipline_rules WHERE owner_id = ? AND enabled = 1 ORDER BY created_at DESC`)
    .all(ownerId) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    ruleText: String(row.rule_text),
    enforcement: row.enforcement as "hard" | "proposal_check" | "self",
    linkedStrategy: row.linked_strategy === null || row.linked_strategy === undefined ? null : String(row.linked_strategy),
    enabled: Boolean(row.enabled),
    createdAt: String(row.created_at)
  }));
}
