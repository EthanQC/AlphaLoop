import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemberRepository, openTradingDatabase } from "../../../packages/shared-types/dist/index.js";

// Fix 4 (task H1 fix round): recordJobRun is mocked (wrapping the REAL
// implementation by default via vi.fn(actual.recordJobRun)) purely so a
// couple of tests below can force ONE call to throw - to prove a
// bookkeeping failure never masks the original poll error/never turns a
// successful run into a rejection. Every other test in this file never
// overrides the mock, so it behaves identically to the unmocked function.
vi.mock("./job-run-log.mjs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, recordJobRun: vi.fn(actual.recordJobRun as (...args: unknown[]) => unknown) };
});

const poll = await import("./market-alerts-poll.mjs");
const store = await import("./market-alerts-store.mjs");
const jobRunLog = await import("./job-run-log.mjs");

// A known-good US regular-market-hours instant (Wednesday 10:30am US-Eastern,
// July - EDT, no DST edge case), matching the fixture already used across
// market-alerts-engine.test.ts. tradingDay derives from the same instant via
// trading-schedule.mjs's currentUsEasternTradingDay.
const TRADING_TIME = "2026-07-01T14:30:00.000Z";
const TRADING_DAY = "2026-07-01";
// A Sunday - definitely outside US regular market hours.
const OFF_HOURS_TIME = "2026-07-05T14:30:00.000Z";
// The next trading day at the same US-Eastern hour as TRADING_TIME - 24h
// later, comfortably past the 12h escalation-card throttle window, while
// still landing inside regular market hours (unlike TRADING_TIME + 12h,
// which would land at ~10:30pm ET the same evening, off-hours).
const LATER_TRADING_TIME = "2026-07-02T14:30:00.000Z";
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

// Fix 1 (task H1 fix round): a member with NO linked Feishu account - alert_
// rules.owner_id has a NOT NULL FK to members(id), so a rule still needs a
// real member row to exist even when simulating "zero REACHABLE members"
// (production today: 0 active members have a feishuOpenId at all).
function seedMemberNoFeishu(db: DatabaseSync, id = "member_1"): void {
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

  it("off-hours writes NO run_log row and sends NO card (not a real run)", async () => {
    const { db, dbPath } = makeDb();
    let sendCalled = false;
    const transport = fakeTransport(async () => {
      sendCalled = true;
      return { ok: true, messageId: "om_should_not_happen" };
    });

    const result = await poll.runMarketAlertsPoll({ now: new Date(OFF_HOURS_TIME), dbPath, transport });

    expect(result).toEqual({ ok: true, skipped: "off-hours" });
    expect(sendCalled).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS c FROM run_log").get() as { c: number }).c).toBe(0);
  });

  it("rejects (non-zero at the CLI layer) for a year the trading calendar has no data for", async () => {
    // dbPath is passed explicitly (unlike the off-hours test above, which
    // never opens any db) - a calendar-coverage error IS one of this task's
    // three named failure modes for run_log/escalation (see module header),
    // so this now opens its OWN db just to log the failure; without an
    // explicit dbPath this would silently fall back to (and pollute) the
    // real repo's runtime/trading.sqlite.
    const { db, dbPath } = makeDb();
    await expect(poll.runMarketAlertsPoll({ now: new Date(OUT_OF_COVERAGE_TIME), dbPath })).rejects.toThrow(
      /calendar/i
    );

    const row = db.prepare("SELECT ok, failed_step FROM run_log WHERE job = 'market-alerts'").get() as
      | { ok: number; failed_step: string }
      | undefined;
    expect(row?.ok).toBe(0);
    expect(row?.failed_step).toBe("calendar_coverage");
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
    // --dry-run is not a real run either (see off-hours test above / module
    // header) - no run_log row, ever.
    expect((db.prepare("SELECT COUNT(*) AS c FROM run_log").get() as { c: number }).c).toBe(0);
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

// Task H1 (Phase 2.5 hardening): every REAL run (not off-hours, not
// --dry-run - see the two tests above) writes a run_log row, ok or not, and
// a persistently failing poller (3+ consecutive failures) escalates to
// every active member with a linked Feishu account, throttled to one card
// per 12h, followed by exactly one recovery card once it succeeds again.
describe("run_log heartbeat + failure escalation (task H1)", () => {
  function seedOneRule(db: DatabaseSync) {
    seedMember(db, "member_1");
    return store.insertRule(db, {
      ownerId: "member_1",
      symbol: "NVDA.US",
      ruleType: "daily_move",
      threshold: 0.04,
      direction: "both",
      frequency: "once_daily"
    });
  }

  // Deliberately embeds an obviously-secret-shaped token so the escalation
  // card assertions below can prove sanitizeAlertText actually redacts it
  // before the message reaches Feishu.
  const failingQuoteProvider = async (): Promise<never> => {
    throw new Error("Longbridge quote failed: LARK_APP_SECRET=shh-do-not-leak-this should never leak");
  };

  function cardTransport(sink: Array<{ target: unknown; cardJson: any }>) {
    return {
      sendCard: async (target: unknown, cardJson: any) => {
        sink.push({ target, cardJson });
        return { ok: true };
      },
      updateCard: async () => ({ ok: true })
    };
  }

  // Like cardTransport, but `shouldFail` decides per-call whether the send
  // reports ok:false - used by the Fix 1/Fix 3 tests below to simulate a
  // specific channel (a member's openId, or the fallback's empty target, or
  // real alert cards specifically) being unreachable while others succeed.
  function cardTransportWithFailures(
    sink: Array<{ target: unknown; cardJson: any }>,
    shouldFail: (target: unknown, cardJson: any) => boolean
  ) {
    return {
      sendCard: async (target: unknown, cardJson: any) => {
        sink.push({ target, cardJson });
        if (shouldFail(target, cardJson)) {
          return { ok: false, error: "simulated send failure" };
        }
        return { ok: true };
      },
      updateCard: async () => ({ ok: true })
    };
  }

  it("a successful real run writes exactly one ok=1 run_log row with no failedStep", async () => {
    const { db, dbPath } = makeDb();
    seedOneRule(db);
    seedSnapshot(db, { positions: [{ symbol: "NVDA.US", quantity: 10, costPrice: 900 }] });

    await poll.runMarketAlertsPoll({
      dbPath,
      now: new Date(TRADING_TIME),
      quoteProvider: async () => ({ "NVDA.US": { price: 950, prevClose: 900, volume: 1000 } }),
      transport: fakeTransport()
    });

    const rows = db.prepare("SELECT ok, failed_step FROM run_log WHERE job = 'market-alerts'").all() as Array<{
      ok: number;
      failed_step: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ok).toBe(1);
    expect(rows[0]?.failed_step).toBeNull();
  });

  it("a failing real run writes a failed run_log row tagged with the phase that threw, no escalation yet (1st failure)", async () => {
    const { db, dbPath } = makeDb();
    seedOneRule(db);
    const sent: Array<{ target: unknown; cardJson: any }> = [];

    await expect(
      poll.runMarketAlertsPoll({
        dbPath,
        now: new Date(TRADING_TIME),
        quoteProvider: failingQuoteProvider,
        transport: cardTransport(sent)
      })
    ).rejects.toThrow(/Longbridge quote failed/);

    const row = db.prepare("SELECT ok, failed_step FROM run_log WHERE job = 'market-alerts'").get() as {
      ok: number;
      failed_step: string;
    };
    expect(row.ok).toBe(0);
    expect(row.failed_step).toBe("fetch_quotes");
    expect(sent).toHaveLength(0);
  });

  it("sends the escalation card on the 3rd consecutive failure (not the 1st or 2nd), sanitized", async () => {
    const { db, dbPath } = makeDb();
    seedOneRule(db);
    const sent: Array<{ target: unknown; cardJson: any }> = [];
    const transport = cardTransport(sent);

    for (let i = 0; i < 3; i += 1) {
      await expect(
        poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), quoteProvider: failingQuoteProvider, transport })
      ).rejects.toThrow();
    }

    expect(sent).toHaveLength(1);
    expect(sent[0]?.target).toEqual({ openId: "ou_member_1" });
    expect(sent[0]?.cardJson.header.title.content).toBe("⚠ 提醒器连续失败");
    const bodyText = JSON.stringify(sent[0]?.cardJson.body);
    expect(bodyText).toContain("已连续失败 3 次");
    expect(bodyText).toContain("提醒功能当前不可用");
    expect(bodyText).not.toContain("shh-do-not-leak-this");
  });

  it("does NOT resend the escalation card on the 4th/5th consecutive failures (12h throttle)", async () => {
    const { db, dbPath } = makeDb();
    seedOneRule(db);
    const sent: Array<{ target: unknown; cardJson: any }> = [];
    const transport = cardTransport(sent);

    for (let i = 0; i < 5; i += 1) {
      await expect(
        poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), quoteProvider: failingQuoteProvider, transport })
      ).rejects.toThrow();
    }

    expect(sent).toHaveLength(1);
    const failureRows = db.prepare("SELECT COUNT(*) AS c FROM run_log WHERE job = 'market-alerts' AND ok = 0").get() as {
      c: number;
    };
    expect(failureRows.c).toBe(5);
  });

  it("sends a new escalation card once the 12h throttle window has passed", async () => {
    const { db, dbPath } = makeDb();
    seedOneRule(db);
    const sent: Array<{ target: unknown; cardJson: any }> = [];
    const transport = cardTransport(sent);

    for (let i = 0; i < 3; i += 1) {
      await expect(
        poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), quoteProvider: failingQuoteProvider, transport })
      ).rejects.toThrow();
    }
    expect(sent).toHaveLength(1);

    await expect(
      poll.runMarketAlertsPoll({
        dbPath,
        now: new Date(LATER_TRADING_TIME),
        quoteProvider: failingQuoteProvider,
        transport
      })
    ).rejects.toThrow();

    expect(sent).toHaveLength(2);
  });

  it("sends the recovery card exactly once after the first successful run following an escalation", async () => {
    const { db, dbPath } = makeDb();
    seedOneRule(db);
    seedSnapshot(db, { positions: [{ symbol: "NVDA.US", quantity: 10, costPrice: 950 }] });
    const sent: Array<{ target: unknown; cardJson: any }> = [];
    const transport = cardTransport(sent);

    for (let i = 0; i < 3; i += 1) {
      await expect(
        poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), quoteProvider: failingQuoteProvider, transport })
      ).rejects.toThrow();
    }
    expect(sent).toHaveLength(1); // escalation only

    // prevClose === price (0% daily move, well under the 4% threshold) so
    // this successful run's own rule evaluation does NOT also fire a real
    // alert card on the shared transport - this test isolates the
    // escalation/recovery cards specifically, not rule fires (daily_move's
    // value is price-vs-prevClose, not price-vs-costPrice).
    const okQuoteProvider = async () => ({ "NVDA.US": { price: 950, prevClose: 950, volume: 1000 } });

    await poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), quoteProvider: okQuoteProvider, transport });
    expect(sent).toHaveLength(2);
    expect(sent[1]?.cardJson.header.title.content).toBe("✅ 提醒器已恢复");

    // A second consecutive success - Fix 5: at a STRICTLY LATER `now` than
    // the first (not the same instant, which would pass even by accident) -
    // must NOT resend the recovery card.
    const secondSuccessNow = new Date(new Date(TRADING_TIME).getTime() + 5 * 60 * 1000);
    await poll.runMarketAlertsPoll({ dbPath, now: secondSuccessNow, quoteProvider: okQuoteProvider, transport });
    expect(sent).toHaveLength(2);

    const okRows = db.prepare("SELECT COUNT(*) AS c FROM run_log WHERE job = 'market-alerts' AND ok = 1").get() as {
      c: number;
    };
    expect(okRows.c).toBe(2);
  });

  // A review of the original H1 implementation above found three ways the
  // escalation machinery could ITSELF go silently dead - defeating the
  // whole point of this task. Each fix below is TDD'd against the exact
  // scenario the review named.
  describe("task H1 fix round: killing the escalation machinery's own dead-alerter paths", () => {
    // Fix 1: production has ZERO active members with a feishuOpenId today.
    it("zero reachable members + a failing fallback: never records escalation_sent, records escalation_undeliverable(no_recipients), and keeps retrying every cycle", async () => {
      const { db, dbPath } = makeDb();
      seedMemberNoFeishu(db, "member_1");
      store.insertRule(db, {
        ownerId: "member_1",
        symbol: "NVDA.US",
        ruleType: "daily_move",
        threshold: 0.04,
        direction: "both",
        frequency: "once_daily"
      });
      const sent: Array<{ target: unknown; cardJson: any }> = [];
      // Every send fails - there is no member to reach AND the fallback
      // channel is (simulated) also down.
      const transport = cardTransportWithFailures(sent, () => true);

      for (let i = 0; i < 5; i += 1) {
        await expect(
          poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), quoteProvider: failingQuoteProvider, transport })
        ).rejects.toThrow();
      }

      // Escalation is attempted on the 3rd/4th/5th failures (never
      // throttled - no escalation_sent marker is ever written) - each
      // attempt is exactly the one fallback send (target {}), since there
      // is no member with a feishuOpenId to try first.
      expect(sent).toHaveLength(3);
      expect(sent.every((entry) => JSON.stringify(entry.target) === "{}")).toBe(true);

      const rows = db
        .prepare("SELECT evidence FROM run_log WHERE job = 'market-alerts' ORDER BY rowid ASC")
        .all() as Array<{ evidence: string }>;
      const allMarkers = rows.flatMap((row) => JSON.parse(row.evidence) as Array<Record<string, unknown>>);
      expect(allMarkers.some((marker) => marker.event === "escalation_sent")).toBe(false);
      const undeliverable = allMarkers.filter((marker) => marker.event === "escalation_undeliverable");
      expect(undeliverable).toHaveLength(3);
      expect(undeliverable.every((marker) => marker.reason === "no_recipients")).toBe(true);
    });

    it("zero reachable members but a WORKING fallback channel: the escalation still gets delivered (escalation_sent, target {})", async () => {
      const { db, dbPath } = makeDb();
      seedMemberNoFeishu(db, "member_1");
      store.insertRule(db, {
        ownerId: "member_1",
        symbol: "NVDA.US",
        ruleType: "daily_move",
        threshold: 0.04,
        direction: "both",
        frequency: "once_daily"
      });
      const sent: Array<{ target: unknown; cardJson: any }> = [];
      const transport = cardTransport(sent);

      for (let i = 0; i < 3; i += 1) {
        await expect(
          poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), quoteProvider: failingQuoteProvider, transport })
        ).rejects.toThrow();
      }

      expect(sent).toHaveLength(1);
      expect(sent[0]?.target).toEqual({});
      const row = db
        .prepare("SELECT evidence FROM run_log WHERE job = 'market-alerts' ORDER BY rowid DESC LIMIT 1")
        .get() as { evidence: string };
      const markers = JSON.parse(row.evidence) as Array<Record<string, unknown>>;
      expect(markers).toContainEqual(expect.objectContaining({ event: "escalation_sent" }));
    });

    it("a reachable member whose send fails, with a failing fallback too: records escalation_undeliverable(send_failed), never escalation_sent", async () => {
      const { db, dbPath } = makeDb();
      seedOneRule(db); // member_1 HAS a feishuOpenId this time
      const sent: Array<{ target: unknown; cardJson: any }> = [];
      const transport = cardTransportWithFailures(sent, () => true);

      for (let i = 0; i < 3; i += 1) {
        await expect(
          poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), quoteProvider: failingQuoteProvider, transport })
        ).rejects.toThrow();
      }

      // The real member is tried first, THEN the fallback - both fail.
      expect(sent).toHaveLength(2);
      expect(sent[0]?.target).toEqual({ openId: "ou_member_1" });
      expect(sent[1]?.target).toEqual({});

      const row = db
        .prepare("SELECT evidence FROM run_log WHERE job = 'market-alerts' ORDER BY rowid DESC LIMIT 1")
        .get() as { evidence: string };
      const markers = JSON.parse(row.evidence) as Array<Record<string, unknown>>;
      expect(markers).toContainEqual(expect.objectContaining({ event: "escalation_undeliverable", reason: "send_failed" }));
      expect(markers.some((marker) => marker.event === "escalation_sent")).toBe(false);
    });

    // Fix 5
    it("escalation goes to EVERY active member with a feishuOpenId; members without one are skipped", async () => {
      const { db, dbPath } = makeDb();
      seedMember(db, "member_1");
      seedMember(db, "member_2");
      seedMemberNoFeishu(db, "member_3");
      store.insertRule(db, {
        ownerId: "member_1",
        symbol: "NVDA.US",
        ruleType: "daily_move",
        threshold: 0.04,
        direction: "both",
        frequency: "once_daily"
      });
      const sent: Array<{ target: unknown; cardJson: any }> = [];
      const transport = cardTransport(sent);

      for (let i = 0; i < 3; i += 1) {
        await expect(
          poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), quoteProvider: failingQuoteProvider, transport })
        ).rejects.toThrow();
      }

      const targets = sent.map((entry) => entry.target);
      expect(targets).toHaveLength(2);
      expect(targets).toEqual(expect.arrayContaining([{ openId: "ou_member_1" }, { openId: "ou_member_2" }]));
    });

    // Fix 5: the throttle boundary is >=, not >. Driven through the
    // calendar-coverage failure path specifically (rather than a real
    // trading-hours failure) because a real 12h gap can never land inside
    // BOTH endpoints' US regular market hours (a ~6.5h daily window, fixed
    // UTC time-of-day) - the calendar-coverage check runs before the
    // market-hours check and has no such constraint.
    it("resends the escalation card at exactly the 12h throttle boundary (>= semantics)", async () => {
      const { db, dbPath } = makeDb();
      const sent: Array<{ target: unknown; cardJson: any }> = [];
      const transport = cardTransport(sent);
      const t1 = new Date(OUT_OF_COVERAGE_TIME);

      for (let i = 0; i < 3; i += 1) {
        await expect(poll.runMarketAlertsPoll({ dbPath, now: t1, transport })).rejects.toThrow(/calendar/i);
      }
      expect(sent).toHaveLength(1);

      const justUnder12h = new Date(t1.getTime() + 12 * 60 * 60 * 1000 - 1);
      await expect(poll.runMarketAlertsPoll({ dbPath, now: justUnder12h, transport })).rejects.toThrow(/calendar/i);
      expect(sent).toHaveLength(1);

      const exactly12h = new Date(t1.getTime() + 12 * 60 * 60 * 1000);
      await expect(poll.runMarketAlertsPoll({ dbPath, now: exactly12h, transport })).rejects.toThrow(/calendar/i);
      expect(sent).toHaveLength(2);
    });

    // Fix 2: the exact flapping sequence named in the task brief - fail ->
    // escalate -> recover -> fail again (well inside the 12h window) -> 3
    // consecutive failures -> must escalate immediately (not suppressed by
    // the stale throttle) -> recover again -> must NOT be swallowed either.
    it("a recovery ends the outage: a NEW outage after a recovery escalates immediately, and its own recovery is not swallowed", async () => {
      const { db, dbPath } = makeDb();
      seedOneRule(db);
      seedSnapshot(db, { positions: [{ symbol: "NVDA.US", quantity: 10, costPrice: 950 }] });
      const sent: Array<{ target: unknown; cardJson: any }> = [];
      const transport = cardTransport(sent);
      const okQuoteProvider = async () => ({ "NVDA.US": { price: 950, prevClose: 950, volume: 1000 } });

      const t1 = new Date("2026-07-01T14:00:00.000Z"); // ~10:00am ET
      const t2 = new Date(t1.getTime() + 5 * 60 * 1000);
      const t3 = new Date(t1.getTime() + 10 * 60 * 1000); // 3rd consecutive failure -> escalates
      const t4 = new Date(t1.getTime() + 30 * 60 * 1000); // recovers
      const t5 = new Date(t1.getTime() + 4 * 60 * 60 * 1000); // NEW outage begins, well under 12h since t3
      const t6 = new Date(t5.getTime() + 5 * 60 * 1000);
      const t7 = new Date(t5.getTime() + 10 * 60 * 1000); // 3rd consecutive failure of the NEW outage
      const t8 = new Date(t7.getTime() + 20 * 60 * 1000); // recovers again

      for (const t of [t1, t2, t3]) {
        await expect(
          poll.runMarketAlertsPoll({ dbPath, now: t, quoteProvider: failingQuoteProvider, transport })
        ).rejects.toThrow();
      }
      expect(sent).toHaveLength(1);
      expect(sent[0]?.cardJson.header.title.content).toBe("⚠ 提醒器连续失败");

      await poll.runMarketAlertsPoll({ dbPath, now: t4, quoteProvider: okQuoteProvider, transport });
      expect(sent).toHaveLength(2);
      expect(sent[1]?.cardJson.header.title.content).toBe("✅ 提醒器已恢复");

      for (const t of [t5, t6, t7]) {
        await expect(
          poll.runMarketAlertsPoll({ dbPath, now: t, quoteProvider: failingQuoteProvider, transport })
        ).rejects.toThrow();
      }
      // Pre-Fix-2 bug: t7 is only ~4h10m after t3's escalation (well under
      // the 12h throttle) - the old code would have suppressed this because
      // it only checked elapsed time, ignoring that t4's recovery already
      // ended the FIRST outage.
      expect(sent).toHaveLength(3);
      expect(sent[2]?.cardJson.header.title.content).toBe("⚠ 提醒器连续失败");

      await poll.runMarketAlertsPoll({ dbPath, now: t8, quoteProvider: okQuoteProvider, transport });
      // Pre-Fix-2 bug: since t7's failure never wrote a FRESH escalation_sent
      // marker (it was wrongly throttled), this second recovery would have
      // seen t4's OLD recovery >= t3's OLD escalation and skipped the card
      // entirely - total silence after the first "recovered" card.
      expect(sent).toHaveLength(4);
      expect(sent[3]?.cardJson.header.title.content).toBe("✅ 提醒器已恢复");
    });

    // Fix 3: deliverAlertCards deliberately swallows delivery failures (by
    // design - no retry, no storm), so a poller that only records ok/fail on
    // the CYCLE never notices "fires happened, zero delivered". This drives
    // 3 consecutive REAL (non-throwing) cycles through that exact blind spot.
    it("3 consecutive cycles that generate fires but deliver ZERO cards escalate a distinct delivery-health card, independent of hard failures", async () => {
      const { db, dbPath } = makeDb();
      seedMember(db, "member_1");
      store.insertRule(db, {
        ownerId: "member_1",
        symbol: "NVDA.US",
        ruleType: "unrealized_pnl",
        threshold: 0.05,
        direction: "both",
        frequency: "continuous"
      });
      seedSnapshot(db, { positions: [{ symbol: "NVDA.US", quantity: 10, costPrice: 100 }] });

      const sent: Array<{ target: unknown; cardJson: any; title: string }> = [];
      // Real alert cards ("盘中提醒 N 条") always fail to send (simulates an
      // expired Feishu token) - operator cards (any other title) succeed,
      // isolating this test to Fix 3's own mechanism rather than also
      // exercising Fix 1's member/fallback fan-out.
      const transport = {
        sendCard: async (target: unknown, cardJson: any) => {
          const title = String(cardJson?.header?.title?.content ?? "");
          sent.push({ target, cardJson, title });
          if (title.startsWith("盘中提醒")) {
            return { ok: false, error: "simulated Feishu auth expiry" };
          }
          return { ok: true };
        },
        updateCard: async () => ({ ok: true })
      };

      // Alternates price above/below cost each cycle so unrealized_pnl
      // re-arms and fires on 3 CONSECUTIVE cycles - a rule that fires once
      // just disarms and stays quiet on a repeated same-direction breach
      // (see market-alerts-engine.mjs's evaluateUnrealizedPnl armedDirection
      // logic), so a constant quote would only fire on the FIRST cycle.
      const highQuote = async () => ({ "NVDA.US": { price: 110, prevClose: 105, volume: 1000 } });
      const lowQuote = async () => ({ "NVDA.US": { price: 90, prevClose: 95, volume: 1000 } });

      const r1 = await poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), quoteProvider: highQuote, transport });
      const r2 = await poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), quoteProvider: lowQuote, transport });
      const r3 = await poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), quoteProvider: highQuote, transport });

      for (const r of [r1, r2, r3]) {
        expect(r.ok).toBe(true);
        expect(r.fires).toBe(1);
        expect(r.sent).toBe(0);
        expect(r.failed).toBe(1);
      }

      const escalationCards = sent.filter((entry) => entry.title === "⚠ 提醒卡片投递持续失败");
      expect(escalationCards).toHaveLength(1);

      const rows = db
        .prepare("SELECT evidence FROM run_log WHERE job = 'market-alerts' ORDER BY rowid ASC")
        .all() as Array<{ evidence: string }>;
      const markersByRow = rows.map((row) => JSON.parse(row.evidence) as Array<Record<string, unknown>>);
      expect(markersByRow[0]).toContainEqual(expect.objectContaining({ event: "delivery_counts", fires: 1, sent: 0, failed: 1 }));
      expect(markersByRow[2]).toContainEqual(expect.objectContaining({ event: "delivery_escalation_sent" }));

      // Recovery: the next cycle that DOES deliver sends a distinct recovery card.
      const healthyTransport = {
        sendCard: async (target: unknown, cardJson: any) => {
          sent.push({ target, cardJson, title: String(cardJson?.header?.title?.content ?? "") });
          return { ok: true };
        },
        updateCard: async () => ({ ok: true })
      };
      const r4 = await poll.runMarketAlertsPoll({
        dbPath,
        now: new Date(TRADING_TIME),
        quoteProvider: lowQuote,
        transport: healthyTransport
      });
      expect(r4.sent).toBe(1);
      const recoveryCards = sent.filter((entry) => entry.title === "✅ 提醒卡片投递已恢复");
      expect(recoveryCards).toHaveLength(1);
    });

    // Fix 4
    it("a bookkeeping throw while recording a FAILING run does not mask the original error, and writes no row", async () => {
      const { db, dbPath } = makeDb();
      seedOneRule(db);
      vi.mocked(jobRunLog.recordJobRun).mockImplementationOnce(() => {
        throw new Error("simulated db lock while writing run_log");
      });

      await expect(
        poll.runMarketAlertsPoll({
          dbPath,
          now: new Date(TRADING_TIME),
          quoteProvider: async () => {
            throw new Error("Longbridge quote failed: original cause");
          },
          transport: fakeTransport()
        })
      ).rejects.toThrow(/Longbridge quote failed: original cause/);

      expect((db.prepare("SELECT COUNT(*) AS c FROM run_log").get() as { c: number }).c).toBe(0);
    });

    it("a bookkeeping throw while recording a SUCCESSFUL run still resolves ok:true with its summary", async () => {
      const { db, dbPath } = makeDb();
      seedOneRule(db);
      seedSnapshot(db, { positions: [{ symbol: "NVDA.US", quantity: 10, costPrice: 900 }] });
      vi.mocked(jobRunLog.recordJobRun).mockImplementationOnce(() => {
        throw new Error("simulated db lock while writing run_log");
      });

      const result = await poll.runMarketAlertsPoll({
        dbPath,
        now: new Date(TRADING_TIME),
        quoteProvider: async () => ({ "NVDA.US": { price: 950, prevClose: 900, volume: 1000 } }),
        transport: fakeTransport()
      });

      expect(result.ok).toBe(true);
      expect(result.fires).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS c FROM run_log").get() as { c: number }).c).toBe(0);
    });
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
