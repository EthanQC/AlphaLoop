import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { MemberRepository, openTradingDatabase } from "../../../packages/shared-types/dist/index.js";

const poll = await import("./market-alerts-poll.mjs");
const store = await import("./market-alerts-store.mjs");

// A known-good US regular-market-hours instant (Wednesday 10:30am US-Eastern,
// July - EDT, no DST edge case), matching the fixture already used across
// market-alerts-engine.test.ts. tradingDay derives from the same instant via
// trading-schedule.mjs's currentUsEasternTradingDay.
const TRADING_TIME = "2026-07-01T14:30:00.000Z";
const TRADING_DAY = "2026-07-01";
// A Sunday - definitely outside US regular market hours.
const OFF_HOURS_TIME = "2026-07-05T14:30:00.000Z";
// The trading calendar (trading-schedule.mjs) only has data for 2026.
const OUT_OF_COVERAGE_TIME = "2027-01-15T15:00:00.000Z";

const tempDirs: string[] = [];

function makeDb(): { db: DatabaseSync; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-alerts-poll-"));
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
    feishuOpenId: `ou_${id}`,
    displayName: id,
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z"
  });
}

function seedSnapshot(
  db: DatabaseSync,
  {
    ownerId = null,
    fetchedAt = "2026-07-01T00:00:00.000Z",
    netAssets = 100_000,
    marketValue = 9_000,
    positions = [] as Array<{ symbol: string; quantity: number; costPrice: number }>
  }: {
    ownerId?: string | null;
    fetchedAt?: string;
    netAssets?: number;
    marketValue?: number;
    positions?: Array<{ symbol: string; quantity: number; costPrice: number }>;
  } = {}
): void {
  db.prepare(`
    INSERT INTO official_paper_snapshots
      (id, fetched_at, reason, net_assets, total_cash, market_value, positions, raw, owner_id)
    VALUES (?, ?, 'test', ?, ?, ?, ?, '{}', ?)
  `).run(
    `snap_${Math.random().toString(36).slice(2)}`,
    fetchedAt,
    netAssets,
    netAssets - marketValue,
    marketValue,
    JSON.stringify(positions),
    ownerId
  );
}

function fakeTransport(sendCard?: (target: unknown) => Promise<{ ok: boolean; messageId?: string; error?: string }>) {
  return {
    sendCard: sendCard ?? (async () => ({ ok: true, messageId: "om_default" })),
    updateCard: async () => ({ ok: true })
  };
}

describe("runMarketAlertsPoll", () => {
  it("skips cleanly off-hours, returning exactly {ok:true, skipped:'off-hours'} with no db touched", async () => {
    const result = await poll.runMarketAlertsPoll({ now: new Date(OFF_HOURS_TIME) });
    expect(result).toEqual({ ok: true, skipped: "off-hours" });
  });

  it("rejects (non-zero at the CLI layer) for a year the trading calendar has no data for", async () => {
    await expect(poll.runMarketAlertsPoll({ now: new Date(OUT_OF_COVERAGE_TIME) })).rejects.toThrow(/calendar/i);
  });

  it("quick-exits with zero counts and touches nothing when there are no enabled rules", async () => {
    const { db, dbPath } = makeDb();

    const result = await poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME) });

    expect(result).toMatchObject({
      ok: true,
      evaluated: 0,
      fires: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      skippedRules: []
    });
    expect((db.prepare("SELECT COUNT(*) AS c FROM alert_events").get() as { c: number }).c).toBe(0);
  });

  it("runs the happy path end to end: fires, persists events/runtimes/quota, delivers, backfills message_id", async () => {
    const { db, dbPath } = makeDb();
    seedMember(db, "member_1");
    const rule = store.insertRule(db, {
      ownerId: "member_1",
      symbol: "NVDA.US",
      ruleType: "daily_move",
      threshold: 0.04,
      direction: "both",
      frequency: "once_daily"
    });
    seedSnapshot(db, { positions: [{ symbol: "NVDA.US", quantity: 10, costPrice: 900 }] });

    let sentTarget: unknown;
    const transport = fakeTransport(async (target) => {
      sentTarget = target;
      return { ok: true, messageId: "om_happy" };
    });

    const result = await poll.runMarketAlertsPoll({
      dbPath,
      now: new Date(TRADING_TIME),
      quoteProvider: async () => ({ "NVDA.US": { price: 950, prevClose: 900, volume: 1000 } }),
      transport
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.evaluated).toBe(1);
    expect(result.fires).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.skippedRules).toEqual([]);
    expect(sentTarget).toEqual({ openId: "ou_member_1" });

    const events = db.prepare("SELECT rule_id, owner_id, message_id FROM alert_events").all() as Array<{
      rule_id: string;
      owner_id: string;
      message_id: string | null;
    }>;
    expect(events).toHaveLength(1);
    expect(events[0]?.rule_id).toBe(rule.id);
    expect(events[0]?.owner_id).toBe("member_1");
    expect(events[0]?.message_id).toBe("om_happy");

    const runtimes = store.getRuntimes(db, [rule.id]);
    expect(runtimes[rule.id]?.lastFiredTradingDay).toBe(TRADING_DAY);

    expect(store.getQuota(db, "member_1", TRADING_DAY)).toBe(1);
  });

  it("--dry-run evaluates and reports would-fire but writes nothing and delivers nothing", async () => {
    const { db, dbPath } = makeDb();
    seedMember(db, "member_1");
    const rule = store.insertRule(db, {
      ownerId: "member_1",
      symbol: "NVDA.US",
      ruleType: "daily_move",
      threshold: 0.04,
      direction: "both",
      frequency: "once_daily"
    });
    seedSnapshot(db, { positions: [{ symbol: "NVDA.US", quantity: 10, costPrice: 900 }] });

    let sendCalled = false;
    const transport = fakeTransport(async () => {
      sendCalled = true;
      return { ok: true, messageId: "om_should_not_happen" };
    });

    const result = await poll.runMarketAlertsPoll({
      dbPath,
      now: new Date(TRADING_TIME),
      dryRun: true,
      quoteProvider: async () => ({ "NVDA.US": { price: 950, prevClose: 900, volume: 1000 } }),
      transport
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.fires).toBe(1);
    expect(result.wouldFire).toHaveLength(1);
    expect(result.wouldFire[0]).toMatchObject({ ruleId: rule.id, ownerId: "member_1", symbol: "NVDA.US" });

    expect(sendCalled).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS c FROM alert_events").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM alert_runtime_state").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM alert_daily_quota").get() as { c: number }).c).toBe(0);
  });

  it("isolates a config-error rule (rule_type/frequency mismatch): other rules still evaluate and fire", async () => {
    const { db, dbPath } = makeDb();
    seedMember(db, "member_1");

    // A pre-existing bad row: rule_type daily_move requires frequency
    // once_daily (see RULE_TYPE_FREQUENCY) - inserted directly via raw SQL
    // since store.insertRule always derives a consistent frequency.
    const badRuleId = "rule_bad_config";
    db.prepare(`
      INSERT INTO alert_rules (id, owner_id, symbol, rule_type, threshold, direction, frequency, hysteresis, enabled, created_at)
      VALUES (?, 'member_1', 'MSFT.US', 'daily_move', 0.04, 'both', 'continuous', 0, 1, ?)
    `).run(badRuleId, "2026-07-01T00:00:00.000Z");

    const goodRule = store.insertRule(db, {
      ownerId: "member_1",
      symbol: "NVDA.US",
      ruleType: "daily_move",
      threshold: 0.04,
      direction: "both",
      frequency: "once_daily"
    });

    const result = await poll.runMarketAlertsPoll({
      dbPath,
      now: new Date(TRADING_TIME),
      quoteProvider: async () => ({
        "NVDA.US": { price: 950, prevClose: 900, volume: 1000 },
        "MSFT.US": { price: 100, prevClose: 100, volume: 1000 }
      }),
      transport: fakeTransport()
    });

    expect(result.ok).toBe(true);
    expect(result.evaluated).toBe(1);
    expect(result.fires).toBe(1);
    expect(result.skippedRules).toEqual([{ ruleId: badRuleId, reason: "config_error" }]);

    const events = db.prepare("SELECT rule_id FROM alert_events").all() as Array<{ rule_id: string }>;
    expect(events).toHaveLength(1);
    expect(events[0]?.rule_id).toBe(goodRule.id);
  });

  it("does not throw when card delivery fails - reports the failure, no retry, event kept without message_id", async () => {
    const { db, dbPath } = makeDb();
    seedMember(db, "member_1");
    const rule = store.insertRule(db, {
      ownerId: "member_1",
      symbol: "NVDA.US",
      ruleType: "daily_move",
      threshold: 0.04,
      direction: "both",
      frequency: "once_daily"
    });
    seedSnapshot(db, { positions: [{ symbol: "NVDA.US", quantity: 10, costPrice: 900 }] });

    const result = await poll.runMarketAlertsPoll({
      dbPath,
      now: new Date(TRADING_TIME),
      quoteProvider: async () => ({ "NVDA.US": { price: 950, prevClose: 900, volume: 1000 } }),
      transport: fakeTransport(async () => ({ ok: false, error: "chat not found" }))
    });

    expect(result.ok).toBe(true);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);

    const row = db.prepare("SELECT message_id FROM alert_events WHERE rule_id = ?").get(rule.id) as {
      message_id: string | null;
    };
    expect(row.message_id).toBeNull();
  });

  // Fix 1 (reviewer-flagged, task P2-6 fix round): saveRuntimes/recordEvents/
  // bumpQuota used to be three separate implicit transactions - a throw
  // between them left state permanently corrupted. They must now all
  // commit (or all roll back) as one unit via store.persistCycle.
  it("rolls back the ENTIRE cycle - including a sibling rule's ALREADY-WRITTEN runtime - if persistence fails partway through", async () => {
    const { db, dbPath } = makeDb();
    seedMember(db, "member_1");
    // Two rules for the SAME owner, inserted in this order - listEnabledRules
    // has no explicit ORDER BY but SQLite returns a simple full-table scan in
    // rowid/insertion order in practice (the existing config-error-isolation
    // test above already relies on this same assumption), so keptRule's
    // runtime upsert is attempted before doomedRule's within saveRuntimes'
    // own loop.
    const keptRule = store.insertRule(db, {
      ownerId: "member_1",
      symbol: "NVDA.US",
      ruleType: "daily_move",
      threshold: 0.04,
      direction: "both",
      frequency: "once_daily"
    });
    const doomedRule = store.insertRule(db, {
      ownerId: "member_1",
      symbol: "MSFT.US",
      ruleType: "daily_move",
      threshold: 0.04,
      direction: "both",
      frequency: "once_daily"
    });
    seedSnapshot(db, { positions: [{ symbol: "NVDA.US", quantity: 10, costPrice: 900 }] });

    const attempt = poll.runMarketAlertsPoll({
      dbPath,
      now: new Date(TRADING_TIME),
      quoteProvider: async () => {
        // Simulate a mid-cycle failure that hits only ONE of two rules for
        // the same owner - e.g. a concurrent `market-alerts remove --purge`
        // racing this poll cycle for doomedRule only. alert_runtime_state.rule_id
        // REFERENCES alert_rules(id) with foreign_keys=ON and no ON DELETE
        // CASCADE, so writing runtime state for a now-missing rule throws a
        // genuine FOREIGN KEY constraint error partway through saveRuntimes'
        // own upsert loop - AFTER keptRule's own upsert (for a rule that
        // still exists) already ran. Under the pre-fix design (three
        // separate implicit transactions, no wrapping BEGIN), keptRule's
        // write would already be auto-committed to disk by the time
        // doomedRule's throws - this is exactly the corruption Fix 1 closes.
        db.prepare("DELETE FROM alert_rules WHERE id = ?").run(doomedRule.id);
        return {
          "NVDA.US": { price: 950, prevClose: 900, volume: 1000 },
          "MSFT.US": { price: 100, prevClose: 100, volume: 1000 }
        };
      },
      transport: fakeTransport()
    });

    await expect(attempt).rejects.toThrow();

    // Neither rule's runtime survives - not even keptRule's, whose own write
    // would have already auto-committed under the pre-fix design by the time
    // doomedRule's write threw.
    expect((db.prepare("SELECT COUNT(*) AS c FROM alert_runtime_state").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM alert_events").get() as { c: number }).c).toBe(0);
    expect(store.getQuota(db, "member_1", TRADING_DAY)).toBe(0);
  });
});

// Fix 2 (spec-owner decision, task P2-6 fix round): positions/exposure must
// be resolved PER OWNER against each owner's own latest official_paper_snapshots
// row, not one globally-latest row shared by every owner. Inert today (only
// NULL-owner rows exist - a single shared paper account) but Phase 6
// introduces per-member paper accounts, at which point sharing one row would
// silently evaluate owner A's rules against owner B's positions.
describe("per-owner snapshot resolution (Fix 2)", () => {
  it("(a) preserves today's shared-account behavior: two owners with no per-owner row both use the same legacy owner_id=NULL snapshot", async () => {
    const { db, dbPath } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    store.insertRule(db, {
      ownerId: "member_1",
      symbol: "NVDA.US",
      ruleType: "unrealized_pnl",
      threshold: 0.05,
      direction: "both",
      frequency: "continuous"
    });
    store.insertRule(db, {
      ownerId: "member_2",
      symbol: "NVDA.US",
      ruleType: "unrealized_pnl",
      threshold: 0.05,
      direction: "both",
      frequency: "continuous"
    });
    seedSnapshot(db, { ownerId: null, positions: [{ symbol: "NVDA.US", quantity: 10, costPrice: 900 }] });

    const result = await poll.runMarketAlertsPoll({
      dbPath,
      now: new Date(TRADING_TIME),
      dryRun: true,
      quoteProvider: async () => ({ "NVDA.US": { price: 1000, prevClose: 950, volume: 1000 } })
    });

    expect(result.fires).toBe(2);
    const valueByOwner = Object.fromEntries(
      (result.wouldFire as Array<{ ownerId: string; value: number }>).map((f) => [f.ownerId, f.value])
    );
    expect(valueByOwner["member_1"]).toBeCloseTo(1000 / 900 - 1, 6);
    expect(valueByOwner["member_2"]).toBeCloseTo(1000 / 900 - 1, 6);
  });

  it("(b) evaluates each owner against their OWN snapshot when one owner has their own row and the other only has the legacy NULL row", async () => {
    const { db, dbPath } = makeDb();
    seedMember(db, "member_1");
    seedMember(db, "member_2");
    store.insertRule(db, {
      ownerId: "member_1",
      symbol: "NVDA.US",
      ruleType: "unrealized_pnl",
      threshold: 0.03,
      direction: "both",
      frequency: "continuous"
    });
    store.insertRule(db, {
      ownerId: "member_2",
      symbol: "NVDA.US",
      ruleType: "unrealized_pnl",
      threshold: 0.03,
      direction: "both",
      frequency: "continuous"
    });
    // member_1 has its own snapshot row (Phase 6-style per-member account).
    seedSnapshot(db, {
      ownerId: "member_1",
      fetchedAt: "2026-07-01T00:00:00.000Z",
      positions: [{ symbol: "NVDA.US", quantity: 10, costPrice: 900 }]
    });
    // member_2 has no row of its own - only the legacy shared NULL row.
    seedSnapshot(db, {
      ownerId: null,
      fetchedAt: "2026-07-01T00:00:00.000Z",
      positions: [{ symbol: "NVDA.US", quantity: 5, costPrice: 950 }]
    });

    const result = await poll.runMarketAlertsPoll({
      dbPath,
      now: new Date(TRADING_TIME),
      quoteProvider: async () => ({ "NVDA.US": { price: 1000, prevClose: 950, volume: 1000 } }),
      transport: fakeTransport()
    });

    expect(result.fires).toBe(2);

    const events = db.prepare("SELECT owner_id, value FROM alert_events").all() as Array<{
      owner_id: string;
      value: number;
    }>;
    const valueByOwner = Object.fromEntries(events.map((e) => [e.owner_id, e.value]));
    expect(valueByOwner["member_1"]).toBeCloseTo(1000 / 900 - 1, 6); // own row: costPrice 900
    expect(valueByOwner["member_2"]).toBeCloseTo(1000 / 950 - 1, 6); // NULL fallback: costPrice 950
    expect(valueByOwner["member_1"]).not.toBe(valueByOwner["member_2"]);
  });

  it("(c) prefers an owner's own snapshot row even when it is OLDER than the legacy NULL row", async () => {
    const { db, dbPath } = makeDb();
    seedMember(db, "member_1");
    store.insertRule(db, {
      ownerId: "member_1",
      symbol: "NVDA.US",
      ruleType: "unrealized_pnl",
      threshold: 0.05,
      direction: "up",
      frequency: "continuous"
    });
    // member_1's own row is OLDER.
    seedSnapshot(db, {
      ownerId: "member_1",
      fetchedAt: "2026-06-01T00:00:00.000Z",
      positions: [{ symbol: "NVDA.US", quantity: 1, costPrice: 500 }]
    });
    // A NEWER legacy NULL row exists too - it must NOT win just for being newer.
    seedSnapshot(db, {
      ownerId: null,
      fetchedAt: "2026-07-05T00:00:00.000Z",
      positions: [{ symbol: "NVDA.US", quantity: 99, costPrice: 999 }]
    });

    const result = await poll.runMarketAlertsPoll({
      dbPath,
      now: new Date(TRADING_TIME),
      dryRun: true,
      quoteProvider: async () => ({ "NVDA.US": { price: 550, prevClose: 500, volume: 1000 } })
    });

    // Own (older) row: 550/500 - 1 = +0.10, direction 'up' -> fires.
    // The newer NULL row would instead give 550/999 - 1 ~= -0.4495 (direction
    // 'down', would NOT fire under direction:'up') - proving the own row was
    // actually used, not merely the latest row across both.
    expect(result.fires).toBe(1);
    expect(result.wouldFire[0].value).toBeCloseTo(550 / 500 - 1, 6);
  });
});
