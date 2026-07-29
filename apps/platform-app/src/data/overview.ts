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

function mapAlertEventRow(row: Record<string, unknown>): AlertEventRow {
  return {
    id: String(row.id),
    ruleId: String(row.rule_id),
    ownerId: String(row.owner_id),
    symbol: String(row.symbol),
    ruleType: String(row.rule_type),
    triggeredAt: String(row.triggered_at),
    value: Number(row.value)
  };
}

const ALERT_EVENT_SELECT = `
  SELECT ae.id AS id, ae.rule_id AS rule_id, ae.owner_id AS owner_id,
         ae.triggered_at AS triggered_at, ae.value AS value,
         ar.symbol AS symbol, ar.rule_type AS rule_type
  FROM alert_events ae
  JOIN alert_rules ar ON ar.id = ae.rule_id
`;

/**
 * Recent alert_events for this owner, joined to alert_rules for the
 * symbol/rule_type the mobile/desktop alert feed needs to render a
 * meaningful line (raw alert_events rows have neither). Owner-filtered at
 * the SQL level via `ae.owner_id = ?` - never joined-then-filtered in JS.
 *
 * NOT SESSION-SCOPED - this is "the newest N, whenever they happened". The
 * home page uses `loadAlertEventsInSession` below instead; this one stays for
 * callers that genuinely want the unbounded history.
 */
export function loadRecentAlertEvents(db: DatabaseSync, ownerId: string, limit: number): AlertEventRow[] {
  const rows = db
    .prepare(`${ALERT_EVENT_SELECT} WHERE ae.owner_id = ? ORDER BY ae.triggered_at DESC LIMIT ?`)
    .all(ownerId, limit) as Array<Record<string, unknown>>;

  return rows.map(mapAlertEventRow);
}

/**
 * This owner's alert_events inside ONE US trading session's half-open window
 * `[startUtcIso, endUtcIso)` (Task 22, req §1.1: 提醒流水 = 最近一个美股交易
 * 时段). Owner-filtered AND window-filtered in SQL.
 *
 * Why this had to exist: the home page's alert block already TOLD the reader
 * its rows were from the most recent session (「最近一个美股交易时段…」) while
 * calling `loadRecentAlertEvents`, which has no time bound at all - an alert
 * from three sessions ago was presented as having fired in the latest one.
 *
 * Both bounds are compared lexicographically, which is exact here: every
 * `alert_events.triggered_at` is written by market-alerts-poll.mjs as
 * `new Date().toISOString()` and both bounds come from
 * `latestUsTradingSession`, so all three share the fixed-width
 * `YYYY-MM-DDTHH:mm:ss.sssZ` form, where string order IS chronological order.
 * (This is the same argument database.ts's trading-day quota window makes.)
 */
export function loadAlertEventsInSession(
  db: DatabaseSync,
  ownerId: string,
  window: { startUtcIso: string; endUtcIso: string },
  limit: number
): AlertEventRow[] {
  const rows = db
    .prepare(`
      ${ALERT_EVENT_SELECT}
      WHERE ae.owner_id = ? AND ae.triggered_at >= ? AND ae.triggered_at < ?
      ORDER BY ae.triggered_at DESC
      LIMIT ?
    `)
    .all(ownerId, window.startUtcIso, window.endUtcIso, limit) as Array<Record<string, unknown>>;

  return rows.map(mapAlertEventRow);
}

/**
 * Pending proposals for this owner, owner-filtered in the WHERE clause.
 * (The doc comment here used to claim "always empty in practice today - P6
 * hasn't shipped proposal creation yet". P6 shipped; the claim was stale and
 * is removed - 2026-07-30.)
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

function mapDisciplineRuleRow(row: Record<string, unknown>): DisciplineRuleRow {
  return {
    id: String(row.id),
    ruleText: String(row.rule_text),
    enforcement: row.enforcement as "hard" | "proposal_check" | "self",
    linkedStrategy: row.linked_strategy === null || row.linked_strategy === undefined ? null : String(row.linked_strategy),
    enabled: Boolean(row.enabled),
    createdAt: String(row.created_at)
  };
}

/**
 * Enabled discipline_rules for this owner, owner-filtered in the WHERE
 * clause. (This doc comment used to claim "always empty in practice today -
 * P7 hasn't shipped strategy-memory writes yet". P7 shipped; removed
 * 2026-07-30.)
 */
export function loadDisciplineRules(db: DatabaseSync, ownerId: string): DisciplineRuleRow[] {
  const rows = db
    .prepare(`SELECT * FROM discipline_rules WHERE owner_id = ? AND enabled = 1 ORDER BY created_at DESC`)
    .all(ownerId) as Array<Record<string, unknown>>;

  return rows.map(mapDisciplineRuleRow);
}

/**
 * ALL of this owner's discipline_rules - both enabled AND disabled - enabled
 * rows first, then newest-first within each group (Task 7, strategy page's
 * 我的纪律 section, req §1.7). Unlike `loadDisciplineRules` above (the home
 * page's 纪律速览, which only ever shows *active* rules to keep that summary
 * short), a member's own strategy page is the authoritative place to see
 * every rule they've ever set, including ones they've since disabled -
 * "stopped" is a fact about the rule worth showing its owner, not a reason to
 * hide it from them.
 */
export function loadAllDisciplineRulesForOwner(db: DatabaseSync, ownerId: string): DisciplineRuleRow[] {
  const rows = db
    .prepare(`SELECT * FROM discipline_rules WHERE owner_id = ? ORDER BY enabled DESC, created_at DESC`)
    .all(ownerId) as Array<Record<string, unknown>>;

  return rows.map(mapDisciplineRuleRow);
}

// ---------------------------------------------------------------------------
// 提案与成交历史 (req §1.6) - 2026-07-30. The paper page rendered a
// "提案与成交历史 P6 上线" placeholder long after P6 shipped, so a reader with
// real proposals in the database was told the feature did not exist.
// ---------------------------------------------------------------------------

export interface ProposalHistoryRow {
  id: string;
  symbol: string;
  side: string;
  quantity: number;
  status: string;
  createdAt: string;
  decidedAt: string | null;
}

/**
 * This owner's proposals, newest first. OWNER-SCOPED IN THE WHERE CLAUSE:
 * a proposal is private to its owner (Global Constraints; routes/proposal.ts
 * enforces the same rule on the detail page), so this reader takes an
 * ownerId and never accepts a "show me everyone's" mode - the paper page
 * only ever calls it with the VIEWER's own id, never the member being
 * viewed.
 */
export function loadProposalHistory(db: DatabaseSync, ownerId: string, limit: number): ProposalHistoryRow[] {
  const rows = db
    .prepare(`
      SELECT id, symbol, side, quantity, status, created_at, decided_at
      FROM proposals
      WHERE owner_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(ownerId, limit) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    symbol: String(row.symbol),
    side: String(row.side),
    quantity: Number(row.quantity),
    status: String(row.status),
    createdAt: String(row.created_at),
    decidedAt: row.decided_at === null || row.decided_at === undefined ? null : String(row.decided_at)
  }));
}
