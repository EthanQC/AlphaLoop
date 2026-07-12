import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { MemberRepository, openTradingDatabase } from "../../../packages/shared-types/dist/index.js";

const store = await import("./market-alerts-store.mjs");

const tempDirs: string[] = [];

function makeDb(): { db: DatabaseSync; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-alerts-store-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "trading.sqlite");
  const db = openTradingDatabase(dbPath);
  return { db, dbPath };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function seedMember(db: DatabaseSync, id = "member_1"): void {
  new MemberRepository(db).upsert({
    id,
    email: `${id}@example.com`,
    displayName: id,
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z"
  });
}

function seedRule(
  db: DatabaseSync,
  overrides: Partial<{
    id: string;
    ownerId: string;
    symbol: string;
    ruleType: string;
    threshold: number;
    direction: string;
    frequency: string;
    hysteresis: number;
    enabled: number;
  }> = {}
): string {
  const rule = {
    id: "rule_1",
    ownerId: "member_1",
    symbol: "AAPL.US",
    ruleType: "daily_move",
    threshold: 0.04,
    direction: "both",
    frequency: "once_daily",
    hysteresis: 0,
    enabled: 1,
    ...overrides
  };
  db.prepare(`
    INSERT INTO alert_rules (id, owner_id, symbol, rule_type, threshold, direction, frequency, hysteresis, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rule.id,
    rule.ownerId,
    rule.symbol,
    rule.ruleType,
    rule.threshold,
    rule.direction,
    rule.frequency,
    rule.hysteresis,
    rule.enabled,
    "2026-07-01T00:00:00.000Z"
  );
  return rule.id;
}

describe("listEnabledRules", () => {
  it("returns only enabled rules, camelCase-mapped", () => {
    const { db } = makeDb();
    seedMember(db);
    seedRule(db, { id: "rule_enabled", enabled: 1, ruleType: "daily_move", threshold: 0.04 });
    seedRule(db, { id: "rule_disabled", symbol: "MSFT.US", enabled: 0 });

    const rules = store.listEnabledRules(db);

    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      id: "rule_enabled",
      ownerId: "member_1",
      symbol: "AAPL.US",
      ruleType: "daily_move",
      threshold: 0.04,
      direction: "both",
      frequency: "once_daily",
      hysteresis: 0,
      enabled: true
    });
    expect(typeof rules[0].createdAt).toBe("string");
  });
});

describe("getRuntimes / saveRuntimes", () => {
  it("returns an empty map for rules with no runtime row yet", () => {
    const { db } = makeDb();
    seedMember(db);
    const ruleId = seedRule(db);

    const runtimes = store.getRuntimes(db, [ruleId]);

    expect(runtimes).toEqual({});
  });

  it("round-trips a JSON-encoded {lastPrice, history} payload through the REAL-typed last_value column", () => {
    const { db, dbPath } = makeDb();
    seedMember(db);
    const ruleId = seedRule(db, { id: "rule_spike", ruleType: "spike_5m", threshold: 0.025 });

    const runtime = {
      ruleId,
      armed: true,
      cooldownUntil: "2026-07-01T15:00:00.000Z",
      lastFiredTradingDay: null,
      lastValue: {
        lastPrice: 202.5,
        history: [
          { p: 200, v: 1000, t: 1751378400000, d: "2026-07-01" },
          { p: 201, v: 1100, t: 1751378700000, d: "2026-07-01" },
          { p: 202, v: 1200, t: 1751379000000, d: "2026-07-01" }
        ],
        armedDirection: "up"
      }
    };

    store.saveRuntimes(db, { [ruleId]: runtime });

    // Prove SQLite's dynamic typing actually accepted a TEXT payload in the
    // REAL-declared last_value column: read the raw column value back
    // without going through the store's decoder.
    const rawRow = db.prepare("SELECT typeof(last_value) AS t, last_value AS v FROM alert_runtime_state WHERE rule_id = ?").get(ruleId) as
      | { t: string; v: string }
      | undefined;
    expect(rawRow?.t).toBe("text");
    expect(() => JSON.parse(String(rawRow?.v))).not.toThrow();
    expect(JSON.parse(String(rawRow?.v))).toEqual({
      lastPrice: 202.5,
      history: runtime.lastValue.history,
      armedDirection: "up"
    });

    // Now prove the round trip through a fresh DatabaseSync handle too (not
    // just the same connection that wrote it), to rule out any
    // connection-local caching from masking a real persistence issue.
    db.close();
    const reopened = new DatabaseSync(dbPath);
    const rows = reopened.prepare("SELECT * FROM alert_runtime_state WHERE rule_id = ?").all(ruleId);
    reopened.close();
    expect(rows).toHaveLength(1);

    const db2 = openTradingDatabase(dbPath);
    const decoded = store.getRuntimes(db2, [ruleId]);
    expect(decoded[ruleId]).toEqual(runtime);
  });

  it("upserts on repeated saves for the same rule_id", () => {
    const { db } = makeDb();
    seedMember(db);
    const ruleId = seedRule(db, { id: "rule_pnl", ruleType: "unrealized_pnl", threshold: 0.06 });

    store.saveRuntimes(db, {
      [ruleId]: { ruleId, armed: true, cooldownUntil: null, lastFiredTradingDay: null, lastValue: { lastPrice: 100, history: [] } }
    });
    store.saveRuntimes(db, {
      [ruleId]: { ruleId, armed: false, cooldownUntil: null, lastFiredTradingDay: null, lastValue: { lastPrice: 107, history: [] } }
    });

    const runtimes = store.getRuntimes(db, [ruleId]);
    expect(runtimes[ruleId].armed).toBe(false);
    expect(runtimes[ruleId].lastValue.lastPrice).toBe(107);

    const count = db.prepare("SELECT COUNT(*) AS c FROM alert_runtime_state WHERE rule_id = ?").get(ruleId) as { c: number };
    expect(count.c).toBe(1);
  });

  it("fetches multiple rules' runtimes in one call, keyed by rule_id", () => {
    const { db } = makeDb();
    seedMember(db);
    const ruleA = seedRule(db, { id: "rule_a", symbol: "AAPL.US" });
    const ruleB = seedRule(db, { id: "rule_b", symbol: "MSFT.US" });

    store.saveRuntimes(db, {
      [ruleA]: { ruleId: ruleA, armed: true, cooldownUntil: null, lastFiredTradingDay: "2026-07-01", lastValue: { lastPrice: 1, history: [] } },
      [ruleB]: { ruleId: ruleB, armed: false, cooldownUntil: null, lastFiredTradingDay: null, lastValue: { lastPrice: 2, history: [] } }
    });

    const runtimes = store.getRuntimes(db, [ruleA, ruleB]);
    expect(Object.keys(runtimes).sort()).toEqual([ruleA, ruleB].sort());
    expect(runtimes[ruleA].lastFiredTradingDay).toBe("2026-07-01");
    expect(runtimes[ruleB].armed).toBe(false);
  });
});

describe("recordEvents / updateEventMessageId / setFeedback", () => {
  it("records fire events with owner_id/value/triggered_at, with message_id and feedback initially null", () => {
    const { db } = makeDb();
    seedMember(db);
    const ruleId = seedRule(db);

    const created = store.recordEvents(db, [
      { ruleId, ownerId: "member_1", value: 0.05, triggeredAt: "2026-07-01T14:30:00.000Z" }
    ]);

    expect(created).toHaveLength(1);
    expect(typeof created[0].id).toBe("string");

    const row = db.prepare("SELECT * FROM alert_events WHERE id = ?").get(created[0].id) as Record<string, unknown>;
    expect(row.rule_id).toBe(ruleId);
    expect(row.owner_id).toBe("member_1");
    expect(row.value).toBe(0.05);
    expect(row.triggered_at).toBe("2026-07-01T14:30:00.000Z");
    expect(row.message_id).toBeNull();
    expect(row.feedback).toBeNull();
  });

  it("records multiple events in one call and returns one id per event, in order", () => {
    const { db } = makeDb();
    seedMember(db);
    const ruleId = seedRule(db);

    const created = store.recordEvents(db, [
      { ruleId, ownerId: "member_1", value: 0.05, triggeredAt: "2026-07-01T14:30:00.000Z" },
      { ruleId, ownerId: "member_1", value: 0.06, triggeredAt: "2026-07-01T14:35:00.000Z" }
    ]);

    expect(created).toHaveLength(2);
    expect(new Set(created.map((c) => c.id)).size).toBe(2);
    const rows = db.prepare("SELECT value FROM alert_events ORDER BY triggered_at ASC").all() as Array<{ value: number }>;
    expect(rows.map((r) => r.value)).toEqual([0.05, 0.06]);
  });

  it("backfills message_id after card delivery", () => {
    const { db } = makeDb();
    seedMember(db);
    const ruleId = seedRule(db);
    const [event] = store.recordEvents(db, [{ ruleId, ownerId: "member_1", value: 0.05, triggeredAt: "2026-07-01T14:30:00.000Z" }]);

    store.updateEventMessageId(db, event.id, "om_abc123");

    const row = db.prepare("SELECT message_id FROM alert_events WHERE id = ?").get(event.id) as { message_id: string };
    expect(row.message_id).toBe("om_abc123");
  });

  it("sets feedback on an event", () => {
    const { db } = makeDb();
    seedMember(db);
    const ruleId = seedRule(db);
    const [event] = store.recordEvents(db, [{ ruleId, ownerId: "member_1", value: 0.05, triggeredAt: "2026-07-01T14:30:00.000Z" }]);

    store.setFeedback(db, event.id, "useful");

    const row = db.prepare("SELECT feedback FROM alert_events WHERE id = ?").get(event.id) as { feedback: string };
    expect(row.feedback).toBe("useful");
  });
});

describe("getQuota / bumpQuota", () => {
  it("returns 0 fired_count when no quota row exists yet", () => {
    const { db } = makeDb();
    expect(store.getQuota(db, "member_1", "2026-07-01")).toBe(0);
  });

  it("creates and increments the quota row across repeated bumps", () => {
    const { db } = makeDb();
    store.bumpQuota(db, "member_1", "2026-07-01", 1);
    expect(store.getQuota(db, "member_1", "2026-07-01")).toBe(1);

    store.bumpQuota(db, "member_1", "2026-07-01", 5);
    expect(store.getQuota(db, "member_1", "2026-07-01")).toBe(6);
  });

  it("keeps quota isolated per trading day", () => {
    const { db } = makeDb();
    store.bumpQuota(db, "member_1", "2026-07-01", 30);
    expect(store.getQuota(db, "member_1", "2026-07-01")).toBe(30);
    expect(store.getQuota(db, "member_1", "2026-07-02")).toBe(0);
  });

  it("keeps quota isolated per owner", () => {
    const { db } = makeDb();
    store.bumpQuota(db, "member_1", "2026-07-01", 10);
    expect(store.getQuota(db, "member_2", "2026-07-01")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Task P2-4 additions: rule CRUD + cross-table validation reads consumed by
// market-alerts.mjs (the rule-management CLI). Added here rather than as raw
// SQL in the CLI, per the task brief's "reuse the store" instruction.
// ---------------------------------------------------------------------------

function seedTarget(db: DatabaseSync, overrides: Partial<{ symbol: string; ownerId: string | null; active: number }> = {}): void {
  const target = { symbol: "AAPL.US", ownerId: null as string | null, active: 1, ...overrides };
  db.prepare(`
    INSERT INTO stock_analysis_targets (symbol, active, created_at, updated_at, owner_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(symbol) DO UPDATE SET active = excluded.active, owner_id = excluded.owner_id
  `).run(target.symbol, target.active, "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z", target.ownerId);
}

function seedSnapshot(
  db: DatabaseSync,
  overrides: Partial<{ id: string; ownerId: string | null; fetchedAt: string; positions: Array<{ symbol: string }> }> = {}
): void {
  const snapshot = {
    id: `snapshot_${Math.random().toString(36).slice(2)}`,
    ownerId: null as string | null,
    fetchedAt: "2026-07-01T00:00:00.000Z",
    positions: [{ symbol: "AAPL.US" }],
    ...overrides
  };
  db.prepare(`
    INSERT INTO official_paper_snapshots (id, fetched_at, reason, net_assets, total_cash, market_value, positions, raw, owner_id)
    VALUES (?, ?, 'test', 1000, 500, 500, ?, '{}', ?)
  `).run(snapshot.id, snapshot.fetchedAt, JSON.stringify(snapshot.positions), snapshot.ownerId);
}

describe("getMemberById", () => {
  it("returns id/status for an existing member", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");

    expect(store.getMemberById(db, "member_1")).toEqual({ id: "member_1", status: "active" });
  });

  it("returns null for an unknown member id", () => {
    const { db } = makeDb();

    expect(store.getMemberById(db, "no_such_member")).toBeNull();
  });
});

describe("isSymbolWatched", () => {
  it("returns true when the symbol is in that owner's stock_analysis_targets", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, { symbol: "AAPL.US", ownerId: "member_1" });

    expect(store.isSymbolWatched(db, "member_1", "AAPL.US")).toBe(true);
  });

  it("returns false for a different owner's watchlist entry", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    seedTarget(db, { symbol: "AAPL.US", ownerId: "member_2" });

    expect(store.isSymbolWatched(db, "member_1", "AAPL.US")).toBe(false);
  });

  it("returns false for a legacy owner_id=NULL row (no per-owner fallback for the watchlist)", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, { symbol: "AAPL.US", ownerId: null });

    expect(store.isSymbolWatched(db, "member_1", "AAPL.US")).toBe(false);
  });

  // Regression (code review finding): stock-analysis.mjs's setTargets soft-
  // deletes by flipping a row's `active` to 0 (it never deletes the row),
  // and its own listTargets reader filters `WHERE active = 1`. isSymbolWatched
  // must honor that same "currently on the watchlist" contract, or a symbol
  // an owner explicitly removed would stay matchable forever.
  it("returns false for a soft-deleted (active=0) watchlist entry", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedTarget(db, { symbol: "AAPL.US", ownerId: "member_1", active: 0 });

    expect(store.isSymbolWatched(db, "member_1", "AAPL.US")).toBe(false);
  });
});

describe("isSymbolInPositions", () => {
  it("returns true when the symbol is in the owner's latest snapshot", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: "2026-07-01T00:00:00.000Z", positions: [{ symbol: "NVDA.US" }] });

    expect(store.isSymbolInPositions(db, "member_1", "NVDA.US")).toBe(true);
  });

  it("returns false when the symbol isn't in the owner's latest snapshot", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedSnapshot(db, { ownerId: "member_1", positions: [{ symbol: "NVDA.US" }] });

    expect(store.isSymbolInPositions(db, "member_1", "TSLA.US")).toBe(false);
  });

  it("falls back to a legacy owner_id=NULL snapshot (single-account pool data, pre-multi-tenant)", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedSnapshot(db, { ownerId: null, positions: [{ symbol: "MSFT.US" }] });

    expect(store.isSymbolInPositions(db, "member_1", "MSFT.US")).toBe(true);
  });

  it("does not leak a different owner's explicitly-owned snapshot", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    seedSnapshot(db, { ownerId: "member_2", positions: [{ symbol: "MSFT.US" }] });

    expect(store.isSymbolInPositions(db, "member_1", "MSFT.US")).toBe(false);
  });

  it("uses the single latest row across owner_id=actor and owner_id=NULL snapshots", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedSnapshot(db, { ownerId: null, fetchedAt: "2026-07-01T00:00:00.000Z", positions: [{ symbol: "OLD.US" }] });
    seedSnapshot(db, { ownerId: "member_1", fetchedAt: "2026-07-02T00:00:00.000Z", positions: [{ symbol: "NEW.US" }] });

    expect(store.isSymbolInPositions(db, "member_1", "NEW.US")).toBe(true);
    expect(store.isSymbolInPositions(db, "member_1", "OLD.US")).toBe(false);
  });

  it("returns false when there is no snapshot at all", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");

    expect(store.isSymbolInPositions(db, "member_1", "AAPL.US")).toBe(false);
  });
});

describe("countRules", () => {
  it("counts rules scoped to (owner, symbol, ruleType), including disabled ones", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedRule(db, { id: "r1", ownerId: "member_1", symbol: "AAPL.US", ruleType: "daily_move", enabled: 1 });
    seedRule(db, { id: "r2", ownerId: "member_1", symbol: "AAPL.US", ruleType: "daily_move", enabled: 0 });
    seedRule(db, { id: "r3", ownerId: "member_1", symbol: "AAPL.US", ruleType: "unrealized_pnl", threshold: 0.06 });
    seedRule(db, { id: "r4", ownerId: "member_1", symbol: "MSFT.US", ruleType: "daily_move" });

    expect(store.countRules(db, "member_1", "AAPL.US", "daily_move")).toBe(2);
  });

  it("returns 0 when no matching rules exist", () => {
    const { db } = makeDb();
    expect(store.countRules(db, "member_1", "AAPL.US", "daily_move")).toBe(0);
  });
});

describe("insertRule / getRule", () => {
  it("inserts a rule and returns the camelCase-mapped row", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");

    const rule = store.insertRule(db, {
      ownerId: "member_1",
      symbol: "NVDA.US",
      ruleType: "daily_move",
      threshold: 0.04,
      direction: "both",
      frequency: "once_daily",
      hysteresis: 0
    });

    expect(rule).toMatchObject({
      ownerId: "member_1",
      symbol: "NVDA.US",
      ruleType: "daily_move",
      threshold: 0.04,
      direction: "both",
      frequency: "once_daily",
      hysteresis: 0,
      enabled: true
    });
    expect(typeof rule.id).toBe("string");
    expect(typeof rule.createdAt).toBe("string");

    expect(store.getRule(db, rule.id)).toEqual(rule);
  });

  it("getRule returns null for an unknown id", () => {
    const { db } = makeDb();
    expect(store.getRule(db, "no_such_rule")).toBeNull();
  });
});

describe("listRulesByOwner / listAllRules", () => {
  it("listRulesByOwner only returns that owner's rules", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    seedRule(db, { id: "r1", ownerId: "member_1" });
    seedRule(db, { id: "r2", ownerId: "member_2", symbol: "MSFT.US" });

    const rules = store.listRulesByOwner(db, "member_1");
    expect(rules.map((r: { id: string }) => r.id)).toEqual(["r1"]);
  });

  it("listAllRules returns rules across all owners", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    seedRule(db, { id: "r1", ownerId: "member_1" });
    seedRule(db, { id: "r2", ownerId: "member_2", symbol: "MSFT.US" });

    const rules = store.listAllRules(db);
    expect(rules.map((r: { id: string }) => r.id).sort()).toEqual(["r1", "r2"]);
  });
});

describe("setRuleEnabled", () => {
  it("disables and re-enables a rule", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    const ruleId = seedRule(db, { id: "r1", ownerId: "member_1" });

    store.setRuleEnabled(db, ruleId, false);
    expect(store.getRule(db, ruleId)?.enabled).toBe(false);

    store.setRuleEnabled(db, ruleId, true);
    expect(store.getRule(db, ruleId)?.enabled).toBe(true);
  });
});

describe("deleteRule", () => {
  it("deletes a rule with no runtime/events rows", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    const ruleId = seedRule(db, { id: "r1", ownerId: "member_1" });

    store.deleteRule(db, ruleId);

    expect(store.getRule(db, ruleId)).toBeNull();
  });

  it("cascades: deletes dependent alert_runtime_state and alert_events rows first (DDL has no ON DELETE CASCADE)", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    const ruleId = seedRule(db, { id: "r1", ownerId: "member_1" });
    store.saveRuntimes(db, {
      [ruleId]: { ruleId, armed: true, cooldownUntil: null, lastFiredTradingDay: null, lastValue: { lastPrice: 1, history: [] } }
    });
    const [event] = store.recordEvents(db, [{ ruleId, ownerId: "member_1", value: 0.05, triggeredAt: "2026-07-01T14:30:00.000Z" }]);

    expect(() => store.deleteRule(db, ruleId)).not.toThrow();

    expect(store.getRule(db, ruleId)).toBeNull();
    expect(db.prepare("SELECT * FROM alert_runtime_state WHERE rule_id = ?").get(ruleId)).toBeUndefined();
    expect(db.prepare("SELECT * FROM alert_events WHERE id = ?").get(event.id)).toBeUndefined();
  });
});

describe("getEvent", () => {
  it("returns the camelCase-mapped event row", () => {
    const { db } = makeDb();
    seedMember(db, "member_1");
    const ruleId = seedRule(db);
    const [created] = store.recordEvents(db, [{ ruleId, ownerId: "member_1", value: 0.05, triggeredAt: "2026-07-01T14:30:00.000Z" }]);

    const event = store.getEvent(db, created.id);
    expect(event).toMatchObject({
      id: created.id,
      ruleId,
      ownerId: "member_1",
      value: 0.05,
      triggeredAt: "2026-07-01T14:30:00.000Z",
      messageId: null,
      feedback: null
    });
  });

  it("returns null for an unknown event id", () => {
    const { db } = makeDb();
    expect(store.getEvent(db, "no_such_event")).toBeNull();
  });
});
