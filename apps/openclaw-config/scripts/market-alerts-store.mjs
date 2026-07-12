// SQLite repository for the alert system's tables (alert_rules, alert_events,
// alert_runtime_state, alert_daily_quota - created by shared-types' migration
// index 2). All camelCase <-> snake_case mapping and JSON encode/decode lives
// here; market-alerts-engine.mjs never touches SQL or JSON.stringify/parse.

import { createId } from "../../../packages/shared-types/dist/index.js";

const DEFAULT_LAST_VALUE = { lastPrice: null, history: [] };

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
// { lastPrice, history }. Verified by market-alerts-store.test.ts asserting
// `typeof(last_value) = 'text'` on the raw stored value.
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
      history: Array.isArray(parsed?.history) ? parsed.history : []
    };
  } catch {
    return { ...DEFAULT_LAST_VALUE };
  }
}
