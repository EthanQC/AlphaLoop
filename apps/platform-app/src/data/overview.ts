/**
 * Home-page data aggregation (Task 5). Every read here is filtered by
 * `ownerId` (the calling member's id) at the SQL level - never fetched
 * unfiltered and then trimmed in memory - so a compromised/careless caller
 * can't accidentally leak another member's rows by forgetting a JS-side
 * filter (plan Global Constraints: "服务端强制隔离...在 handler 层查询即过滤").
 *
 * Snapshot reading (SnapshotPosition/OwnerSnapshot/loadLatestSnapshotForOwner/
 * loadPreviousDaySnapshotForOwner and the adjudicated own-row/fallback-set
 * precedence rule they implement) MOVED to ./snapshots.ts in Task 6, which
 * also added the net-worth SERIES reader the paper-trading page needs
 * (loadSnapshotSeriesForOwner) - seeing an obvious "same precedence rule,
 * one row vs. many rows" relationship, Task 6 folded both into one module
 * rather than writing a third independent snapshot reader. Re-exported here
 * so every caller that already imports these names from `data/overview.js`
 * (routes/home.ts, this file's own test) keeps working unchanged - see
 * snapshots.ts's header comment for the full rationale.
 */
import type { DatabaseSync } from "node:sqlite";

export {
  loadLatestSnapshotForOwner,
  loadPreviousDaySnapshotForOwner,
  SHARED_OWNER_SENTINEL,
  type OwnerSnapshot,
  type SnapshotPosition
} from "./snapshots.js";

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
