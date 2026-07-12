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
    netAssets = 100_000,
    marketValue = 9_000,
    positions = [] as Array<{ symbol: string; quantity: number; costPrice: number }>
  }: {
    ownerId?: string | null;
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
    "2026-07-01T00:00:00.000Z",
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
});
