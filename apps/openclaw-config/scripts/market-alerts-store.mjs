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

const DEFAULT_LAST_VALUE = { lastPrice: null, history: [], armedDirection: null };

export function listEnabledRules(db) {
  const rows = db.prepare(`SELECT * FROM alert_rules WHERE enabled = 1`).all();
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

// Watchlist membership has no legacy NULL-owner fallback: the brief scopes
// this strictly to `owner_id = actor` (unlike isSymbolInPositions below).
//
// `active = 1` matches stock-analysis.mjs's own listTargets contract: its
// setTargets soft-deletes by flipping a replaced row's `active` to 0 (never
// deleting the row), so a symbol the owner explicitly removed must not stay
// matchable here just because the row still physically exists.
export function isSymbolWatched(db, ownerId, symbol) {
  const row = db
    .prepare(`SELECT 1 FROM stock_analysis_targets WHERE owner_id = ? AND symbol = ? AND active = 1`)
    .get(ownerId, symbol);
  return Boolean(row);
}

// Per the task brief's binding rule: the latest official_paper_snapshots row
// for `owner_id = actor` OR `owner_id IS NULL`. NULL-owner rows are legacy
// data from before per-owner snapshots existed (this system has a single
// shared paper-trading account) - they don't prove the position is
// specifically actor's, but since there's only one account, they're included
// as pool-level evidence rather than excluded outright. A single query
// picking the most recent row across both sets keeps "latest snapshot" a
// single well-defined row instead of two separate lookups with an ordering
// question between them.
export function isSymbolInPositions(db, ownerId, symbol) {
  const row = db
    .prepare(`
      SELECT positions FROM official_paper_snapshots
      WHERE owner_id = ? OR owner_id IS NULL
      ORDER BY fetched_at DESC
      LIMIT 1
    `)
    .get(ownerId);

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

// Counts ALL rules for (owner, symbol, ruleType) regardless of enabled state,
// so pausing/resuming can't be used to churn past the brief's <=10 cap.
export function countRules(db, ownerId, symbol, ruleType) {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM alert_rules WHERE owner_id = ? AND symbol = ? AND rule_type = ?`)
    .get(ownerId, symbol, ruleType);
  return Number(row?.c ?? 0);
}

export function insertRule(db, rule) {
  const id = createId("alert_rule");
  const createdAt = new Date().toISOString();
  const hysteresis = rule.hysteresis ?? 0;
  db.prepare(`
    INSERT INTO alert_rules (id, owner_id, symbol, rule_type, threshold, direction, frequency, hysteresis, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, rule.ownerId, rule.symbol, rule.ruleType, rule.threshold, rule.direction, rule.frequency, hysteresis, createdAt);
  // Built directly from the insert args (matching recordEvents' pattern
  // below) rather than a redundant getRule(db, id) re-fetch - every field
  // returned here is already known, normalized the same way mapRuleRow does.
  return {
    id,
    ownerId: rule.ownerId,
    symbol: rule.symbol,
    ruleType: rule.ruleType,
    threshold: Number(rule.threshold),
    direction: rule.direction,
    frequency: rule.frequency,
    hysteresis: Number(hysteresis),
    enabled: true,
    createdAt
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

export function setRuleEnabled(db, ruleId, enabled) {
  db.prepare(`UPDATE alert_rules SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, ruleId);
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
    createdAt: String(row.created_at)
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
