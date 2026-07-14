// SQLite repository for the alert system's tables (alert_rules, alert_events,
// alert_runtime_state, alert_daily_quota - created by shared-types' migration
// index 2). All camelCase <-> snake_case mapping and JSON encode/decode lives
// here; market-alerts-engine.mjs never touches SQL or JSON.stringify/parse.
//
// Task P2-4 (market-alerts.mjs, the rule-management CLI) widened this
// module's scope beyond the alert_* tables: it also reads `members` and
// validates against `stock_analysis_targets`/`official_paper_snapshots`,
// because the CLI must not contain raw SQL (per that task's brief) and those
// reads only exist to serve the CLI's write-side validation.

import { createId } from "../../../packages/shared-types/dist/index.js";
import { DEFAULT_HYSTERESIS } from "./market-alerts-engine.mjs";

const DEFAULT_LAST_VALUE = { lastPrice: null, history: [], armedDirection: null };

// Task H4 (phase2.5 hardening): defensive redundancy alongside `enabled = 1`
// - removeRule always sets both `enabled = 0` and `removed_at` together, so
// this AND clause is a no-op against every row this codebase's own write
// paths can produce today. It exists so a future writer that ever sets
// removed_at without also flipping enabled (or a manual DB fixup) can't
// silently resurrect a removed rule into evaluation.
export function listEnabledRules(db) {
  const rows = db.prepare(`SELECT * FROM alert_rules WHERE enabled = 1 AND removed_at IS NULL`).all();
  return rows.map(mapRuleRow);
}

export function getRuntimes(db, ruleIds) {
  if (!ruleIds || ruleIds.length === 0) {
    return {};
  }

  const placeholders = ruleIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT * FROM alert_runtime_state WHERE rule_id IN (${placeholders})`)
    .all(...ruleIds);

  const runtimes = {};
  for (const row of rows) {
    runtimes[row.rule_id] = mapRuntimeRow(row);
  }
  return runtimes;
}

export function saveRuntimes(db, updates) {
  const stmt = db.prepare(`
    INSERT INTO alert_runtime_state (rule_id, armed, last_value, cooldown_until, last_fired_trading_day)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(rule_id) DO UPDATE SET
      armed = excluded.armed,
      last_value = excluded.last_value,
      cooldown_until = excluded.cooldown_until,
      last_fired_trading_day = excluded.last_fired_trading_day
  `);

  for (const [ruleId, runtime] of Object.entries(updates ?? {})) {
    stmt.run(
      ruleId,
      runtime.armed ? 1 : 0,
      encodeLastValue(runtime.lastValue),
      runtime.cooldownUntil ?? null,
      runtime.lastFiredTradingDay ?? null
    );
  }
}

export function recordEvents(db, events) {
  const stmt = db.prepare(`
    INSERT INTO alert_events (id, rule_id, owner_id, triggered_at, value, message_id, feedback)
    VALUES (?, ?, ?, ?, ?, NULL, NULL)
  `);

  const created = [];
  for (const event of events ?? []) {
    const id = createId("alert_event");
    stmt.run(id, event.ruleId, event.ownerId, event.triggeredAt, event.value);
    created.push({ id, ruleId: event.ruleId, ownerId: event.ownerId, value: event.value, triggeredAt: event.triggeredAt });
  }
  return created;
}

export function updateEventMessageId(db, eventId, messageId) {
  db.prepare(`UPDATE alert_events SET message_id = ? WHERE id = ?`).run(messageId, eventId);
}

export function setFeedback(db, eventId, feedback) {
  db.prepare(`UPDATE alert_events SET feedback = ? WHERE id = ?`).run(feedback, eventId);
}

// ---------------------------------------------------------------------------
// Task P2-4 additions: rule CRUD + cross-table validation reads for
// market-alerts.mjs (the owner-enforced rule-management CLI). These reach
// outside the alert_* tables (members, stock_analysis_targets,
// official_paper_snapshots) because the CLI's write-side validation needs
// them and the task brief directs "reuse the store... rather than writing
// raw SQL in the CLI" - so the no-raw-SQL-in-the-CLI rule wins over this
// module's original alert_*-tables-only scope.
// ---------------------------------------------------------------------------

export function getMemberById(db, memberId) {
  const row = db.prepare(`SELECT id, status FROM members WHERE id = ?`).get(memberId);
  return row ? { id: String(row.id), status: String(row.status) } : null;
}

// Spec-owner decision (task P2-4 fix round), superseding the original
// brief's "owner_id = actor" strict gate: stock_analysis_targets used to be
// a SINGLE SHARED watchlist, not a per-owner one - `symbol TEXT PRIMARY KEY`
// meant one row per symbol globally, and stock-analysis.mjs's setTargets
// never wrote owner_id, so every existing row had owner_id NULL. The strict
// gate matched NULL against nothing, making "add an alert for a watchlist
// symbol I don't yet hold" fail 100% of the time in production. NULL-owner
// rows ARE the shared pool - not some other member's private data - so they
// had to match for any actor, mirroring the NULL fallback isSymbolInPositions
// still uses below (that table - official_paper_snapshots - keeps its
// nullable owner_id; only stock_analysis_targets was rebuilt).
//
// Schema v7 (task H3) rebuilt stock_analysis_targets into a genuine
// per-owner table: composite PRIMARY KEY (symbol, owner_id), owner_id NOT
// NULL. A NULL owner_id is no longer representable at all - the migration
// backfilled every pre-v7 NULL row to the sentinel '__legacy_shared__' (see
// database.ts's v7 step), which this function now matches in place of the
// old `owner_id IS NULL` branch, preserving the exact same "shared pool,
// visible to any member" semantics across the schema change. Making
// setTargets itself owner-aware (a `--owner` CLI flag, per-owner caps, etc.)
// is deferred to a later task; this is only the read-side adaptation to the
// new schema's representation of the same shared-pool concept.
//
// `active = 1` matches stock-analysis.mjs's own listTargets contract: its
// setTargets soft-deletes by flipping a replaced row's `active` to 0 (never
// deleting the row), so a symbol the owner explicitly removed must not stay
// matchable here just because the row still physically exists. This filter
// is load-bearing for the shared pool too: a soft-deleted legacy-shared row
// must not be resurrected just because it's globally shared.
// Exported (not just module-private) so other writers into
// stock_analysis_targets - namely stock-analysis.mjs's setTargets (task H4)
// - can guard against ever writing/soft-deleting this sentinel's rows
// instead of re-declaring the same string literal in a second place.
export const LEGACY_SHARED_OWNER = "__legacy_shared__";

export function isSymbolWatched(db, ownerId, symbol) {
  const row = db
    .prepare(`SELECT 1 FROM stock_analysis_targets WHERE (owner_id = ? OR owner_id = ?) AND symbol = ? AND active = 1`)
    .get(ownerId, LEGACY_SHARED_OWNER, symbol);
  return Boolean(row);
}

// I2 fix (whole-branch-review finding): "which official_paper_snapshots row
// belongs to this owner" used to have TWO independent implementations - this
// function's own "OR owner_id IS NULL ORDER BY fetched_at DESC LIMIT 1"
// (newest across both sets wins) and market-alerts-poll.mjs's
// loadLatestSnapshotForOwner (the adjudicated rule: the owner's OWN row wins
// even if older, NULL only as a fallback when the owner has none). They
// agreed by coincidence - every row today has owner_id NULL - but would
// silently diverge the moment Phase 6 adds per-member accounts: this CLI
// validation would match the shared pool while the poller evaluates against
// the owner's own account. Both now call the ONE shared implementation below
// instead of maintaining two copies of the same precedence rule.
export function loadLatestSnapshotForOwner(db, ownerId) {
  if (ownerId !== null && ownerId !== undefined) {
    const ownRow = db
      .prepare(`
        SELECT net_assets, market_value, positions
        FROM official_paper_snapshots
        WHERE owner_id = ?
        ORDER BY fetched_at DESC
        LIMIT 1
      `)
      .get(ownerId);
    if (ownRow) {
      return ownRow;
    }
  }

  const fallbackRow = db
    .prepare(`
      SELECT net_assets, market_value, positions
      FROM official_paper_snapshots
      WHERE owner_id IS NULL
      ORDER BY fetched_at DESC
      LIMIT 1
    `)
    .get();
  return fallbackRow ?? null;
}

// Per the task brief's binding rule: the latest official_paper_snapshots row
// for this owner, using the shared loadLatestSnapshotForOwner precedence
// above (the owner's own row wins even if older; a NULL-owner row is legacy
// pool-level evidence used only as a fallback). NULL-owner rows are legacy
// data from before per-owner snapshots existed (this system has a single
// shared paper-trading account) - they don't prove the position is
// specifically actor's, but since there's only one account, they're included
// as pool-level evidence rather than excluded outright.
export function isSymbolInPositions(db, ownerId, symbol) {
  const row = loadLatestSnapshotForOwner(db, ownerId);

  if (!row) {
    return false;
  }

  let positions;
  try {
    positions = JSON.parse(String(row.positions));
  } catch {
    return false;
  }

  if (!Array.isArray(positions)) {
    return false;
  }

  return positions.some((position) => String(position?.symbol ?? "").toUpperCase() === symbol);
}

// Counts rules for (owner, symbol, ruleType) regardless of enabled state, so
// pausing/resuming can't be used to churn past the brief's <=10 cap - a
// paused rule still occupies its slot. Schema v6's removed_at is the one
// exception: a soft-removed rule is excluded here (removed_at IS NULL), so
// removing a rule frees its slot the way deleting it always implicitly did,
// while pausing (which never sets removed_at) still counts.
export function countRules(db, ownerId, symbol, ruleType) {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM alert_rules WHERE owner_id = ? AND symbol = ? AND rule_type = ? AND removed_at IS NULL`)
    .get(ownerId, symbol, ruleType);
  return Number(row?.c ?? 0);
}

// Task H4 (phase2.5 hardening, invariant push-down): both the hysteresis
// default and the rearmBand guard used to live ONLY in market-alerts.mjs's
// runAdd (see that file's "C1 fix" / "Hardening found while verifying the
// C1 fix" comments) - a caller that reached insertRule directly (bypassing
// the CLI) got hysteresis 0 and no protection against a threshold at or
// below the type's hysteresis (which drives rearmBand = threshold -
// hysteresis to <= 0 - for exposure specifically a PERMANENT latch, since
// its re-arm check can never be satisfied again once exposureRatio has
// nowhere negative to go). Both now live here so every future caller
// inherits them automatically, not just the CLI. The CLI's own duplicate
// checks (runAdd) stay in place for fast feedback - this is a second,
// independent line of defense, not a replacement.
export function insertRule(db, rule) {
  const id = createId("alert_rule");
  const createdAt = new Date().toISOString();
  const threshold = Number(rule.threshold);
  const typeHysteresis = DEFAULT_HYSTERESIS[rule.ruleType];
  // Guard against the EFFECTIVE hysteresis (the value actually inserted),
  // not the type default - a direct caller passing an explicit
  // rule.hysteresis larger than the type default could otherwise still
  // create a permanently-latched rule (threshold <= hysteresis =>
  // rearmBand <= 0), which is precisely what this push-down exists to stop.
  const hysteresis = Number(rule.hysteresis ?? typeHysteresis ?? 0);

  if (!(threshold > 0)) {
    throw new Error(`threshold 必须为正数；收到 ${rule.threshold}。`);
  }
  if (hysteresis > 0 && threshold <= hysteresis) {
    throw new Error(
      `threshold 太小：必须大于滞回值 ${hysteresis}` +
      `（否则规则触发一次后将永远无法重新武装）；收到 ${threshold}。`
    );
  }

  db.prepare(`
    INSERT INTO alert_rules (id, owner_id, symbol, rule_type, threshold, direction, frequency, hysteresis, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, rule.ownerId, rule.symbol, rule.ruleType, threshold, rule.direction, rule.frequency, hysteresis, createdAt);
  // Built directly from the insert args (matching recordEvents' pattern
  // below) rather than a redundant getRule(db, id) re-fetch - every field
  // returned here is already known, normalized the same way mapRuleRow does.
  return {
    id,
    ownerId: rule.ownerId,
    symbol: rule.symbol,
    ruleType: rule.ruleType,
    threshold,
    direction: rule.direction,
    frequency: rule.frequency,
    hysteresis: Number(hysteresis),
    enabled: true,
    createdAt,
    removedAt: null
  };
}

export function getRule(db, ruleId) {
  const row = db.prepare(`SELECT * FROM alert_rules WHERE id = ?`).get(ruleId);
  return row ? mapRuleRow(row) : null;
}

export function listRulesByOwner(db, ownerId) {
  const rows = db.prepare(`SELECT * FROM alert_rules WHERE owner_id = ? ORDER BY created_at ASC`).all(ownerId);
  return rows.map(mapRuleRow);
}

export function listAllRules(db) {
  const rows = db.prepare(`SELECT * FROM alert_rules ORDER BY created_at ASC`).all();
  return rows.map(mapRuleRow);
}

// Flips `enabled` only - used by pause/resume. Deliberately does not touch
// `removed_at`: pausing (and resuming a paused rule) must never look like a
// soft-remove, and vice versa (see removeRule below, schema v6).
export function setRuleEnabled(db, ruleId, enabled) {
  db.prepare(`UPDATE alert_rules SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, ruleId);
}

// Schema v6 (task P2-4 follow-up): soft-delete a rule in a way that's
// distinguishable from pause. Sets enabled=0 (same immediate effect as
// pause - listEnabledRules/the engine stop evaluating it) AND removed_at to
// now, so `removed_at IS NOT NULL` marks "removed" independent of `enabled`.
// The CLI's `resume` checks removed_at and refuses to revive a removed rule
// (previously an accepted limitation - see the CLI's runResume/history).
export function removeRule(db, ruleId) {
  db.prepare(`UPDATE alert_rules SET enabled = 0, removed_at = ? WHERE id = ?`).run(new Date().toISOString(), ruleId);
}

// alert_runtime_state.rule_id and alert_events.rule_id both REFERENCE
// alert_rules(id) with no ON DELETE CASCADE in the (frozen) DDL, and this
// database opens with `PRAGMA foreign_keys = ON` - so deleting a rule that
// already has runtime state or fired events would otherwise fail with a
// FOREIGN KEY constraint error. Cascade manually here, in one transaction,
// since the DDL can't be changed.
export function deleteRule(db, ruleId) {
  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    db.prepare(`DELETE FROM alert_events WHERE rule_id = ?`).run(ruleId);
    db.prepare(`DELETE FROM alert_runtime_state WHERE rule_id = ?`).run(ruleId);
    db.prepare(`DELETE FROM alert_rules WHERE id = ?`).run(ruleId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getEvent(db, eventId) {
  const row = db.prepare(`SELECT * FROM alert_events WHERE id = ?`).get(eventId);
  return row ? mapEventRow(row) : null;
}

// Task P2-4 fix round (Fix 3, non-destructive `remove`): lets the CLI report
// how many alert_events a rule has (eventsPreserved on the soft-delete path,
// eventsDeleted on the --purge/hard-delete path) without needing to fetch
// and count full rows itself.
export function countEventsForRule(db, ruleId) {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM alert_events WHERE rule_id = ?`).get(ruleId);
  return Number(row?.c ?? 0);
}

// Task P2-6 fix round (reviewer-flagged finding): persists one poll cycle's
// runtime/event/quota writes as a SINGLE atomic unit. Before this helper
// existed, market-alerts-poll.mjs called saveRuntimes -> recordEvents ->
// bumpQuota as three separate implicit transactions - a crash, or a throw
// in a later step, between them left state permanently corrupted (e.g.
// saveRuntimes commits `lastFiredTradingDay`, then recordEvents throws: the
// once_daily rule is now marked as already-fired today with no alert_events
// row and no card ever sent, silently losing that alert for the rest of the
// trading day; the reverse ordering under-counts the quota instead, causing
// over-alerting). Mirrors deleteRule's BEGIN IMMEDIATE / COMMIT / ROLLBACK
// pattern above - the only other multi-statement write in this module - so
// the transaction lives with the SQL, keeping the poller orchestration-only.
//
// Card DELIVERY deliberately stays OUTSIDE this transaction (and outside
// this function entirely) - it's network IO, and the existing "delivery
// failure leaves message_id NULL, no retry" behavior (see
// market-alerts-cards.mjs's deliverAlertCards) must be preserved unchanged.
// updateEventMessageId's post-send backfill likewise stays a separate,
// later write, same as before this fix.
//
// Returns recordEvents' `created` array, in the exact same rule/fire-order
// as the input `events` array - composeAlertCards' eventId zip-on (see that
// module's header: `createdEvents[index]?.id` onto `fires[index]`) depends
// on this order being preserved end to end.
//
// @param {import('node:sqlite').DatabaseSync} db
// @param {{
//   runtimes: Record<string, object>,
//   events: Array<{ruleId: string, ownerId: string, value: number, triggeredAt: string}>,
//   quotaBumps: Array<{ownerId: string, tradingDay: string, delta: number}>
// }} cycle
// @returns {Array<{id: string, ruleId: string, ownerId: string, value: number, triggeredAt: string}>}
export function persistCycle(db, { runtimes, events, quotaBumps }) {
  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    saveRuntimes(db, runtimes);
    const created = recordEvents(db, events);
    for (const bump of quotaBumps ?? []) {
      if (bump.delta > 0) {
        bumpQuota(db, bump.ownerId, bump.tradingDay, bump.delta);
      }
    }
    db.exec("COMMIT");
    return created;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getQuota(db, ownerId, tradingDay) {
  const row = db
    .prepare(`SELECT fired_count FROM alert_daily_quota WHERE owner_id = ? AND trading_day = ?`)
    .get(ownerId, tradingDay);
  return row ? Number(row.fired_count) : 0;
}

export function bumpQuota(db, ownerId, tradingDay, n) {
  db.prepare(`
    INSERT INTO alert_daily_quota (owner_id, trading_day, fired_count)
    VALUES (?, ?, ?)
    ON CONFLICT(owner_id, trading_day) DO UPDATE SET fired_count = fired_count + excluded.fired_count
  `).run(ownerId, tradingDay, n);
}

// ---------------------------------------------------------------------------
// Row <-> camelCase mapping
// ---------------------------------------------------------------------------

function mapRuleRow(row) {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    symbol: String(row.symbol),
    ruleType: String(row.rule_type),
    threshold: Number(row.threshold),
    direction: String(row.direction),
    frequency: String(row.frequency),
    hysteresis: Number(row.hysteresis),
    enabled: Number(row.enabled) === 1,
    createdAt: String(row.created_at),
    removedAt: row.removed_at ?? null
  };
}

function mapEventRow(row) {
  return {
    id: String(row.id),
    ruleId: String(row.rule_id),
    ownerId: String(row.owner_id),
    triggeredAt: String(row.triggered_at),
    value: Number(row.value),
    messageId: row.message_id ?? null,
    feedback: row.feedback ?? null
  };
}

function mapRuntimeRow(row) {
  return {
    ruleId: String(row.rule_id),
    armed: Number(row.armed) === 1,
    cooldownUntil: row.cooldown_until ?? null,
    lastFiredTradingDay: row.last_fired_trading_day ?? null,
    lastValue: decodeLastValue(row.last_value)
  };
}

// Binding design decision (task-p2-3-brief.md): alert_runtime_state.last_value
// is declared REAL in the DDL, but SQLite's dynamic typing lets a column
// store any type regardless of its declared affinity for values that don't
// cleanly coerce - so this column instead holds a JSON string encoding
// { lastPrice, history, armedDirection }. Verified by market-alerts-store.test.ts
// asserting `typeof(last_value) = 'text'` on the raw stored value.
//
// `history` entries are `{ p, v, t, d }` (price, volume, sample epoch ms,
// trading day) and `armedDirection` is `'up'|'down'|null` - both added by
// task-p2-3's spike-window and signed-pnl-armed-state fixes. This column
// stays a free-form JSON blob either way, so no DDL change was needed for
// either field; the store just passes them through opaquely.
function encodeLastValue(lastValue) {
  return JSON.stringify(lastValue ?? DEFAULT_LAST_VALUE);
}

function decodeLastValue(raw) {
  if (raw === null || raw === undefined) {
    return { ...DEFAULT_LAST_VALUE };
  }

  try {
    const parsed = JSON.parse(String(raw));
    return {
      lastPrice: typeof parsed?.lastPrice === "number" ? parsed.lastPrice : null,
      history: Array.isArray(parsed?.history) ? parsed.history : [],
      armedDirection: parsed?.armedDirection === "up" || parsed?.armedDirection === "down" ? parsed.armedDirection : null
    };
  } catch {
    return { ...DEFAULT_LAST_VALUE };
  }
}
