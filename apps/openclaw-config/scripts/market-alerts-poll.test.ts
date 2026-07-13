import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

// Fix 4 (task H1 THIRD fix round): renameSync is mocked the same way
// (wrapping the REAL implementation via vi.fn(actual.renameSync), so every
// OTHER test's use of node:fs - mkdtempSync/rmSync/existsSync/readFileSync
// etc., all left untouched via `...actual` - behaves identically) purely so
// the atomic-write test below can assert market-alerts-poll.mjs's own
// writeJsonAtomic actually calls renameSync(tmpPath, path), not just that a
// plain writeFileSync happened to leave no `.tmp` file lying around either
// (which would pass a weaker "no leftover .tmp" check for the wrong reason).
vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, renameSync: vi.fn(actual.renameSync as (...args: unknown[]) => unknown) };
});

const poll = await import("./market-alerts-poll.mjs");
const store = await import("./market-alerts-store.mjs");
const jobRunLog = await import("./job-run-log.mjs");
const fsModule = await import("node:fs");

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

// A review of the delivery-blindness detector added by the fix round above
// found it was ITSELF inert in production - see market-alerts-poll.mjs's
// module header for the full four-fix account. Each fix below is TDD'd
// against the exact scenario the review named.
describe("task H1 second fix round: the delivery-health detector's own inert paths", () => {
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

  function seedUnrealizedPnlRule(db: DatabaseSync, ownerId = "member_1") {
    return store.insertRule(db, {
      ownerId,
      symbol: "NVDA.US",
      ruleType: "unrealized_pnl",
      threshold: 0.05,
      direction: "both",
      frequency: "continuous"
    });
  }

  const highQuote = async () => ({ "NVDA.US": { price: 110, prevClose: 105, volume: 1000 } });
  const lowQuote = async () => ({ "NVDA.US": { price: 90, prevClose: 95, volume: 1000 } });

  // Local to this describe block (the sibling block above defines its own
  // copy scoped to its own callback) - deliberately embeds a secret-shaped
  // token, mirroring the sibling block's own rationale for reusing it here.
  const failingQuoteProvider = async (): Promise<never> => {
    throw new Error("Longbridge quote failed: LARK_APP_SECRET=shh-do-not-leak-this should never leak");
  };

  // Fix 1: a broken transport (real card sends always fail) with SPARSE fires
  // (a rearmed rule fires, then disarms and stays quiet on a repeated
  // same-direction cycle, then fires again on the next opposite breach) must
  // still escalate - the old streak-based counter reset on every "empty"
  // (fires===0) cycle in between and never reached the threshold.
  it("(a) a sparse-fire sequence (unhealthy, empty, unhealthy, empty, unhealthy) still escalates the delivery-health card", async () => {
    const { db, dbPath } = makeDb();
    seedMember(db, "member_1");
    seedUnrealizedPnlRule(db);
    seedSnapshot(db, { positions: [{ symbol: "NVDA.US", quantity: 10, costPrice: 100 }] });

    const sent: Array<{ target: unknown; cardJson: any; title: string }> = [];
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

    // high (fires up) -> high again (same direction, disarmed, NO fire) ->
    // low (opposite breach, fires down) -> low again (same direction,
    // disarmed, NO fire) -> high (opposite breach, fires up).
    const results = [];
    for (const quoteProvider of [highQuote, highQuote, lowQuote, lowQuote, highQuote]) {
      results.push(
        await poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), quoteProvider, transport })
      );
    }

    expect(results.map((r) => r.fires)).toEqual([1, 0, 1, 0, 1]);
    for (const r of results) {
      expect(r.sent).toBe(0);
    }

    const escalationCards = sent.filter((entry) => entry.title === "⚠ 提醒卡片投递持续失败");
    expect(escalationCards).toHaveLength(1);
  });

  // Fix 2: `skipped` (a fire for a member with no feishuOpenId on file - the
  // current production shape) must count as unhealthy exactly like `failed`
  // does, with its own distinct card text pointing at the actual fix (bind a
  // Feishu account), not the auth-troubleshooting text.
  it("(b) fires with only `skipped` misses (no member has a feishuOpenId) escalate with the no-recipient card text", async () => {
    const { db, dbPath } = makeDb();
    seedMemberNoFeishu(db, "member_1");
    seedUnrealizedPnlRule(db);
    seedSnapshot(db, { positions: [{ symbol: "NVDA.US", quantity: 10, costPrice: 100 }] });

    const sent: Array<{ target: unknown; cardJson: any; title: string }> = [];
    const transport = {
      sendCard: async (target: unknown, cardJson: any) => {
        sent.push({ target, cardJson, title: String(cardJson?.header?.title?.content ?? "") });
        return { ok: true };
      },
      updateCard: async () => ({ ok: true })
    };

    const results = [];
    for (const quoteProvider of [highQuote, lowQuote, highQuote]) {
      results.push(
        await poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), quoteProvider, transport })
      );
    }

    for (const r of results) {
      expect(r.fires).toBe(1);
      expect(r.sent).toBe(0);
      expect(r.failed).toBe(0);
      expect(r.skipped).toBe(1);
    }

    const noRecipientCards = sent.filter((entry) => entry.title === "⚠ 提醒无法送达：无可达收件人");
    expect(noRecipientCards).toHaveLength(1);
    const bodyText = JSON.stringify(noRecipientCards[0]?.cardJson.body);
    expect(bodyText).toContain("绑定");
    expect(bodyText).toContain("飞书");
    // The auth-troubleshooting text must NOT also fire for a pure no-recipient outage.
    expect(sent.some((entry) => entry.title === "⚠ 提醒卡片投递持续失败")).toBe(false);
  });

  // Fix 3: an empty (fires===0) cycle right after a delivery escalation used
  // to take the recovery branch anyway and send a false "recovered" card,
  // which also reset the throttle - allowing an escalate/false-recover loop.
  it("(c) an empty cycle after a delivery escalation does NOT send a recovery card; a later cycle with a REAL delivery does", async () => {
    const { db, dbPath } = makeDb();
    seedMember(db, "member_1");
    seedUnrealizedPnlRule(db);
    seedSnapshot(db, { positions: [{ symbol: "NVDA.US", quantity: 10, costPrice: 100 }] });

    const sent: Array<{ target: unknown; cardJson: any; title: string }> = [];
    const failingTransport = {
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

    // 3 consecutive real fires, all undelivered -> escalates on the 3rd.
    for (const quoteProvider of [highQuote, lowQuote, highQuote]) {
      const r = await poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), quoteProvider, transport: failingTransport });
      expect(r.sent).toBe(0);
    }
    expect(sent.filter((e) => e.title === "⚠ 提醒卡片投递持续失败")).toHaveLength(1);

    // An EMPTY cycle: same direction/price as the last fire (still "high",
    // armedDirection already 'up') - disarmed, no breach, fires===0.
    const emptyResult = await poll.runMarketAlertsPoll({
      dbPath,
      now: new Date(TRADING_TIME),
      quoteProvider: highQuote,
      transport: failingTransport
    });
    expect(emptyResult.fires).toBe(0);
    expect(sent.some((e) => e.title === "✅ 提醒卡片投递已恢复")).toBe(false);

    // A REAL successful delivery (opposite breach off "high"/'up', delivered
    // this time) - only THIS may send the recovery card.
    const healthyTransport = {
      sendCard: async (target: unknown, cardJson: any) => {
        sent.push({ target, cardJson, title: String(cardJson?.header?.title?.content ?? "") });
        return { ok: true };
      },
      updateCard: async () => ({ ok: true })
    };
    const recoveredResult = await poll.runMarketAlertsPoll({
      dbPath,
      now: new Date(TRADING_TIME),
      quoteProvider: lowQuote,
      transport: healthyTransport
    });
    expect(recoveredResult.sent).toBe(1);
    expect(sent.filter((e) => e.title === "✅ 提醒卡片投递已恢复")).toHaveLength(1);
  });

  // Fix 4: a write-blocked db means recordJobRun throws on EVERY cycle, so
  // the db-derived consecutiveFailureCount never advances past 1 (no row
  // ever lands) and the 3-failure escalation threshold is never reached - a
  // file-based fallback counter (kept in sync alongside the db, and used as
  // max(dbCount, fileCount)) must still cross the threshold on the 3rd
  // consecutive failure.
  it("(d) db writes always throw: the 3rd consecutive failure still escalates via the file-based counter", async () => {
    const { db, dbPath } = makeDb();
    seedOneRule(db);
    for (let i = 0; i < 3; i += 1) {
      vi.mocked(jobRunLog.recordJobRun).mockImplementationOnce(() => {
        throw new Error("simulated persistent db lock while writing run_log");
      });
    }

    const sent: Array<{ target: unknown; cardJson: any; title: string }> = [];
    const transport = {
      sendCard: async (target: unknown, cardJson: any) => {
        sent.push({ target, cardJson, title: String(cardJson?.header?.title?.content ?? "") });
        return { ok: true };
      },
      updateCard: async () => ({ ok: true })
    };

    for (let i = 0; i < 3; i += 1) {
      await expect(
        poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), quoteProvider: failingQuoteProvider, transport })
      ).rejects.toThrow();
    }

    // Proves the db-only counter really was stuck: not one run_log row ever
    // landed (every recordJobRun call threw), yet the escalation still fired.
    expect((db.prepare("SELECT COUNT(*) AS c FROM run_log").get() as { c: number }).c).toBe(0);
    const escalationCards = sent.filter((entry) => entry.title === "⚠ 提醒器连续失败");
    expect(escalationCards).toHaveLength(1);
  });
});

// A review of the SECOND fix round above found (1) its own Fix 5 row-LIMIT
// optimization re-broke Fix 1's sticky delivery-health counter, and two more
// silent-death paths in the escalation machinery itself: (2) a db that can't
// even be OPENED still gets no escalation at all, and (3) a delivery
// escalation whose whole point is "the Feishu channel is broken" rides that
// exact same broken channel to report itself, so it's undeliverable by
// construction with no external signal. Fix 4 (atomic writes) is exercised
// throughout every test below implicitly (every state-file read after a
// write goes through the same writeJsonAtomic path) and isn't its own
// separate scenario to construct.
describe("task H1 THIRD fix round: the 200-row LIMIT re-break, db-open failure, and the unreportable-outage artifact", () => {
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

  function failingRealCardTransport(sink: Array<{ target: unknown; cardJson: any; title: string }>) {
    return {
      sendCard: async (target: unknown, cardJson: any) => {
        const title = String(cardJson?.header?.title?.content ?? "");
        sink.push({ target, cardJson, title });
        if (title.startsWith("盘中提醒")) {
          return { ok: false, error: "simulated Feishu auth expiry" };
        }
        return { ok: true };
      },
      updateCard: async () => ({ ok: true })
    };
  }

  // Fix 1: THE regression test - three bad delivery attempts, each separated
  // by ~100 healthy/empty rows (>200 rows apart end to end, well past
  // job-run-log.mjs's RUN_LOG_LOOKBACK_LIMIT of 200), synthetically seeded
  // directly into run_log (the same shape recordSuccessRun itself writes) so
  // the test stays fast - then ONE real poll cycle that ALSO fails to
  // deliver must still see the count as 3 and escalate, proving
  // consecutiveStickyMarkerCountSince (not the row-bounded original) is what
  // recordSuccessRun actually calls.
  it("Fix 1: three bad delivery attempts spanning >200 run_log rows still escalate (the row-LIMIT regression this fix closes)", async () => {
    const { db, dbPath } = makeDb();
    seedOneRule(db);
    seedSnapshot(db, { positions: [{ symbol: "NVDA.US", quantity: 10, costPrice: 900 }] });

    const liveNow = new Date(TRADING_TIME);
    let msBefore = 210 * 5 * 60 * 1000; // 5-minute ticks, this poller's own cadence

    function seedRow(bad: boolean): void {
      const startedAt = new Date(liveNow.getTime() - msBefore).toISOString();
      msBefore -= 5 * 60 * 1000;
      const evidence: Array<Record<string, unknown>> = [
        { event: "delivery_counts", evaluated: 1, fires: bad ? 1 : 0, sent: 0, failed: bad ? 1 : 0, skipped: 0 }
      ];
      if (bad) {
        evidence.push({ event: "delivery_attempted", at: startedAt });
        evidence.push({ event: "delivery_health_bad", at: startedAt, reason: "send_failed" });
      }
      jobRunLog.recordJobRun(db, {
        job: "market-alerts",
        startedAt,
        finishedAt: startedAt,
        ok: true,
        actions: ["poll"],
        evidence
      });
    }

    // Oldest -> newest: bad, 100 neutral, bad, 100 neutral (202 seeded rows -
    // already past the 200-row LIMIT before the live 3rd bad attempt below
    // even runs).
    seedRow(true);
    for (let i = 0; i < 100; i += 1) seedRow(false);
    seedRow(true);
    for (let i = 0; i < 100; i += 1) seedRow(false);

    const preExistingRows = (db.prepare("SELECT COUNT(*) AS c FROM run_log").get() as { c: number }).c;
    expect(preExistingRows).toBeGreaterThan(200);

    const sent: Array<{ target: unknown; cardJson: any; title: string }> = [];
    const transport = failingRealCardTransport(sent);

    const result = await poll.runMarketAlertsPoll({
      dbPath,
      now: liveNow,
      quoteProvider: async () => ({ "NVDA.US": { price: 950, prevClose: 900, volume: 1000 } }),
      transport
    });

    expect(result.ok).toBe(true);
    expect(result.fires).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);

    const escalationCards = sent.filter((entry) => entry.title === "⚠ 提醒卡片投递持续失败");
    expect(escalationCards).toHaveLength(1);
  });

  // Fix 2: openTradingDatabase itself throws on every attempt (not a
  // transient write-lock with a db handle that DID open - see the "(d) db
  // writes always throw" test in the sibling describe block above for that
  // case). Reproduced by making dbPath an actual directory rather than
  // mocking anything: `new DatabaseSync(aDirectoryPath)` throws for real, the
  // same class of failure as a corrupt sqlite file or a read-only runtime
  // dir.
  it("Fix 2: openTradingDatabase failing to OPEN AT ALL still escalates via the file counter (3rd fails->throttles->resets on recovery)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alphaloop-alerts-poll-dbopen-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "trading.sqlite");
    mkdirSync(dbPath, { recursive: true }); // dbPath itself is a directory - opening it as a db always throws

    const sent: Array<{ target: unknown; cardJson: any }> = [];
    const transport = {
      sendCard: async (target: unknown, cardJson: any) => {
        sent.push({ target, cardJson });
        return { ok: true };
      },
      updateCard: async () => ({ ok: true })
    };

    for (let i = 0; i < 3; i += 1) {
      await expect(
        poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), transport })
      ).rejects.toThrow(/unable to open database file/i);
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]?.target).toEqual({});
    expect(sent[0]?.cardJson.header.title.content).toBe("⚠ 提醒器数据库不可用");
    const bodyText = JSON.stringify(sent[0]?.cardJson.body);
    expect(bodyText).toContain("已连续 3 次");
    expect(bodyText).toContain("无法打开");

    // 4th consecutive failure: throttled, no resend.
    await expect(
      poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), transport })
    ).rejects.toThrow(/unable to open database file/i);
    expect(sent).toHaveLength(1);

    const statePath = join(dir, "market-alerts", "poller-state.json");
    const stateAfterFailures = JSON.parse(readFileSync(statePath, "utf8"));
    expect(stateAfterFailures.consecutiveFailures).toBe(4);

    // "a later successful run resets the file counter": remove the
    // stand-in directory so the SAME dbPath now opens as a genuine (fresh)
    // sqlite file.
    rmSync(dbPath, { recursive: true, force: true });
    const result = await poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), transport });
    expect(result.ok).toBe(true);

    const stateAfterRecovery = JSON.parse(readFileSync(statePath, "utf8"));
    expect(stateAfterRecovery.consecutiveFailures).toBe(0);
  });

  // Fix 3 + Fix 4: an escalation that ends up undeliverable (the member send
  // AND the `{}` fallback both fail - exactly "the wire it reports as dead")
  // writes runtime/market-alerts/ALERTER-DOWN.json; a subsequent cycle that
  // is otherwise "ok" (0 enabled rules - nothing to evaluate at all) still
  // reports `alerterDown: true` while the artifact persists; the first
  // delivery that actually gets through deletes it and clears the flag.
  it("Fix 3: an undeliverable escalation writes ALERTER-DOWN.json (rewritten each cycle), and a later otherwise-ok cycle still reports alerterDown:true", async () => {
    const { db, dbPath } = makeDb();
    seedOneRule(db);
    const sent: Array<{ target: unknown; cardJson: any }> = [];
    const alwaysFailTransport = {
      sendCard: async (target: unknown, cardJson: any) => {
        sent.push({ target, cardJson });
        return { ok: false, error: "simulated total Feishu outage" };
      },
      updateCard: async () => ({ ok: true })
    };

    const failingQuoteProvider = async (): Promise<never> => {
      throw new Error("Longbridge quote failed: forcing a hard-failure escalation");
    };

    const artifactPath = join(dirname(dbPath), "market-alerts", "ALERTER-DOWN.json");
    expect(existsSync(artifactPath)).toBe(false);

    for (let i = 0; i < 3; i += 1) {
      await expect(
        poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), quoteProvider: failingQuoteProvider, transport: alwaysFailTransport })
      ).rejects.toThrow();
    }
    // Member send + fallback send, both failing, on the 3rd consecutive failure.
    expect(sent.length).toBeGreaterThan(0);
    expect(existsSync(artifactPath)).toBe(true);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    expect(artifact).toMatchObject({ consecutiveFailures: 3, reason: "send_failed" });
    expect(typeof artifact.since).toBe("string");
    expect(typeof artifact.lastAttemptAt).toBe("string");

    // The undeliverable escalation is never throttled (no "_sent" marker was
    // ever written), so it retries - and rewrites the artifact - on the very
    // next consecutive failure too. `since` (the ORIGINAL onset) must be
    // preserved across the rewrite even as `lastAttemptAt`/consecutiveFailures
    // advance. A strictly later `now` (not the same instant) proves
    // `lastAttemptAt` actually moved rather than passing by coincidence.
    const fourthNow = new Date(new Date(TRADING_TIME).getTime() + 60_000);
    await expect(
      poll.runMarketAlertsPoll({ dbPath, now: fourthNow, quoteProvider: failingQuoteProvider, transport: alwaysFailTransport })
    ).rejects.toThrow();
    const rewritten = JSON.parse(readFileSync(artifactPath, "utf8"));
    expect(rewritten.consecutiveFailures).toBe(4);
    expect(rewritten.since).toBe(artifact.since);
    expect(rewritten.lastAttemptAt).not.toBe(artifact.lastAttemptAt);

    // A later cycle with NOTHING to do (delete the rule so pollOnce
    // quick-exits with 0 enabled rules) is otherwise a totally "ok" cycle.
    //
    // Fix B (task H1 FOURTH fix round) revises this from the PRE-Fix-B
    // expectation (the artifact staying `alerterDown: true` forever, because
    // the escalation was never DELIVERED so the marker-based recovery check
    // could never see an outage "on record" to close): this quiet cycle is a
    // genuine poll SUCCESS that ends the 4-failure hard-failure streak
    // recorded above - one of Fix B's own independent proofs of health, even
    // though the best-effort recovery notice this cycle also attempts still
    // fails to deliver (still `alwaysFailTransport`). Proof of health is this
    // cycle's own poll outcome, not whether that one extra notice happens to
    // get through - so the artifact clears and the exit-code signal turns
    // off immediately instead of latching forever, which was precisely the
    // bug Fix B closes.
    db.prepare("DELETE FROM alert_rules").run();
    const quietResult = await poll.runMarketAlertsPoll({
      dbPath,
      now: new Date(TRADING_TIME),
      transport: alwaysFailTransport
    });
    expect(quietResult.ok).toBe(true);
    expect(quietResult.alerterDown).toBeUndefined();
    expect(existsSync(artifactPath)).toBe(false);
  });

  it("Fix 3: the artifact is deleted the moment an escalation actually gets delivered again", async () => {
    const { db, dbPath } = makeDb();
    seedOneRule(db);
    const sent: Array<{ target: unknown; cardJson: any }> = [];
    let deliverable = false;
    // Fails for the first 3 cycles, then starts succeeding - simulates the
    // Feishu channel itself coming back up, independent of whatever the
    // underlying hard failure (a bad quote provider, below) is doing.
    const transport = {
      sendCard: async (target: unknown, cardJson: any) => {
        sent.push({ target, cardJson });
        return deliverable ? { ok: true } : { ok: false, error: "simulated total Feishu outage" };
      },
      updateCard: async () => ({ ok: true })
    };

    const failingQuoteProvider = async (): Promise<never> => {
      throw new Error("Longbridge quote failed: forcing a hard-failure escalation");
    };

    const artifactPath = join(dirname(dbPath), "market-alerts", "ALERTER-DOWN.json");

    for (let i = 0; i < 3; i += 1) {
      await expect(
        poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), quoteProvider: failingQuoteProvider, transport })
      ).rejects.toThrow();
    }
    expect(existsSync(artifactPath)).toBe(true);

    // The underlying hard failure is STILL happening (same failingQuoteProvider)
    // but the Feishu channel itself now works - the escalation RETRY (not a
    // recovery card - the outage per run_log hasn't ended) gets through and
    // must clear the artifact.
    deliverable = true;
    await expect(
      poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), quoteProvider: failingQuoteProvider, transport })
    ).rejects.toThrow();

    expect(existsSync(artifactPath)).toBe(false);
  });

  // Fix 4: poller-state.json/ALERTER-DOWN.json must be written via
  // tmp+renameSync (mirroring backup-trading-data.mjs's
  // backupTradingDatabase), not a bare writeFileSync - a crash mid-write
  // must never leave a half-written state file (a rename is atomic; a bare
  // writeFileSync is not). Asserts the ACTUAL renameSync(tmpPath, path) call
  // happened (via the node:fs mock above) rather than just checking for the
  // absence of a leftover `.tmp` file - a plain writeFileSync wouldn't leave
  // one lying around EITHER in the success case, so that weaker check would
  // pass for the wrong reason and not actually catch a regression back to a
  // bare writeFileSync.
  it("Fix 4: state files are written via tmp+renameSync, not a bare writeFileSync - content round-trips", async () => {
    const { db, dbPath } = makeDb();
    seedOneRule(db);

    const dir = dirname(dbPath);
    const statePath = join(dir, "market-alerts", "poller-state.json");
    const artifactPath = join(dir, "market-alerts", "ALERTER-DOWN.json");

    const alwaysFailTransport = {
      sendCard: async () => ({ ok: false, error: "simulated total Feishu outage" }),
      updateCard: async () => ({ ok: true })
    };
    const failingQuoteProvider = async (): Promise<never> => {
      throw new Error("Longbridge quote failed: forcing atomic-write coverage");
    };

    for (let i = 0; i < 3; i += 1) {
      await expect(
        poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), quoteProvider: failingQuoteProvider, transport: alwaysFailTransport })
      ).rejects.toThrow();
    }

    expect(vi.mocked(fsModule.renameSync)).toHaveBeenCalledWith(`${statePath}.tmp`, statePath);
    expect(vi.mocked(fsModule.renameSync)).toHaveBeenCalledWith(`${artifactPath}.tmp`, artifactPath);
    expect(existsSync(`${statePath}.tmp`)).toBe(false);
    expect(existsSync(`${artifactPath}.tmp`)).toBe(false);

    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.consecutiveFailures).toBe(3);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    expect(artifact.consecutiveFailures).toBe(3);
  });
});

// A final review of the THIRD fix round found two more ways the counters/
// artifact could go silently dead, plus smaller gaps in the same machinery -
// see market-alerts-poll.mjs's module header ("task H1 FOURTH fix round")
// for the full account. Each fix below is TDD'd against the exact scenario
// the review named.
describe("task H1 FOURTH fix round: unpersistable counters and the permanently-latched artifact", () => {
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

  // Fix A - the CONTRACT's test (a): both db writes AND file writes fail on
  // the SAME cycle. recordFailureRun's path: the db opened fine (a real
  // handle exists) but THIS cycle's own INSERT still throws (mocked, mirrors
  // the sibling "(d) db writes always throw" test in the second-fix-round
  // describe block above), and poller-state.json's write ALSO fails (the
  // shared node:fs renameSync mock, throwing once). Neither backstop can
  // record this cycle's failure, so the normal 3-failure threshold can never
  // be reached from here on - the fix must escalate on THIS, the very FIRST,
  // failing cycle instead.
  it("(Fix A) db INSERT throws AND the state file also fails to write: escalates on the FIRST failing cycle, not the 3rd", async () => {
    const { db, dbPath } = makeDb();
    seedOneRule(db);
    const sent: Array<{ target: unknown; cardJson: any }> = [];
    const transport = {
      sendCard: async (target: unknown, cardJson: any) => {
        sent.push({ target, cardJson });
        return { ok: true };
      },
      updateCard: async () => ({ ok: true })
    };

    vi.mocked(jobRunLog.recordJobRun).mockImplementationOnce(() => {
      throw new Error("simulated db insert failure (disk full)");
    });
    vi.mocked(fsModule.renameSync).mockImplementationOnce(() => {
      throw new Error("simulated state file write failure (disk full)");
    });

    await expect(
      poll.runMarketAlertsPoll({
        dbPath,
        now: new Date(TRADING_TIME),
        quoteProvider: async () => {
          throw new Error("Longbridge quote failed: forcing a hard-failure cycle");
        },
        transport
      })
    ).rejects.toThrow(/Longbridge quote failed/);

    // Escalated immediately - not throttled/waiting for a 3rd consecutive
    // failure the counter can never actually reach from this state.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.target).toEqual({});
    expect(sent[0]?.cardJson.header.title.content).toBe("⚠ 提醒器状态无法持久化（磁盘/权限故障）");

    // Proves neither backstop actually persisted this cycle - the db insert
    // really did throw (no row landed) and the state write really did fail.
    expect((db.prepare("SELECT COUNT(*) AS c FROM run_log").get() as { c: number }).c).toBe(0);
  });

  // Fix A, the db-can't-even-OPEN twin (escalateWithoutDb): reproduced the
  // same way as the sibling "Fix 2: openTradingDatabase failing to OPEN AT
  // ALL" test above (dbPath IS a directory), with the state-file write ALSO
  // failing this same cycle.
  it("(Fix A) db cannot even be opened AND the state file also fails to write: escalates on the FIRST cycle, not the 3rd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alphaloop-alerts-poll-dbopen-unpersistable-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "trading.sqlite");
    mkdirSync(dbPath, { recursive: true }); // dbPath itself is a directory - opening it as a db always throws

    const sent: Array<{ target: unknown; cardJson: any }> = [];
    const transport = {
      sendCard: async (target: unknown, cardJson: any) => {
        sent.push({ target, cardJson });
        return { ok: true };
      },
      updateCard: async () => ({ ok: true })
    };

    vi.mocked(fsModule.renameSync).mockImplementationOnce(() => {
      throw new Error("simulated state file write failure (disk full)");
    });

    await expect(poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), transport })).rejects.toThrow(
      /unable to open database file/i
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.target).toEqual({});
    expect(sent[0]?.cardJson.header.title.content).toBe("⚠ 提醒器状态无法持久化（磁盘/权限故障）");

    const statePath = join(dir, "market-alerts", "poller-state.json");
    expect(existsSync(statePath)).toBe(false); // the write really failed - nothing persisted
  });

  // Fix B/C - the CONTRACT's tests (b) and (c): an escalation that itself
  // never reaches anyone (the whole Feishu channel is dead) writes ONLY an
  // `*_undeliverable` marker, never `delivery_escalation_sent` - so the
  // EXISTING marker-based recovery branch (isRecoveryDue) can never fire once
  // the channel comes back, and pre-fix, the artifact would never clear. The
  // next cycle that actually delivers (sent > 0) must clear it anyway, and a
  // BRAND NEW outage afterward must start a fresh `since`.
  it("(Fix B/C) an undeliverable delivery escalation writes the artifact; a later sent>0 cycle clears it with no *_sent marker ever recorded; a NEW outage afterward gets a fresh `since`", async () => {
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

    let channelDead = true;
    const sent: Array<{ target: unknown; cardJson: any; title: string }> = [];
    const transport = {
      sendCard: async (target: unknown, cardJson: any) => {
        const title = String(cardJson?.header?.title?.content ?? "");
        sent.push({ target, cardJson, title });
        return channelDead ? { ok: false, error: "simulated total Feishu outage" } : { ok: true };
      },
      updateCard: async () => ({ ok: true })
    };

    const artifactPath = join(dirname(dbPath), "market-alerts", "ALERTER-DOWN.json");
    const highQuote = async () => ({ "NVDA.US": { price: 110, prevClose: 105, volume: 1000 } });
    const lowQuote = async () => ({ "NVDA.US": { price: 90, prevClose: 95, volume: 1000 } });

    // 3 consecutive real fires, all undelivered - AND the escalation card
    // ITSELF fails to reach anyone too (the whole channel is dead), so the
    // artifact gets written.
    for (const quoteProvider of [highQuote, lowQuote, highQuote]) {
      const r = await poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), quoteProvider, transport });
      expect(r.sent).toBe(0);
    }
    expect(existsSync(artifactPath)).toBe(true);
    const firstSince = (JSON.parse(readFileSync(artifactPath, "utf8")) as { since: string }).since;

    // Proves the gap this fix closes: no `delivery_escalation_sent` marker
    // was EVER recorded for this outage (every attempt was undeliverable).
    const rowsBefore = db
      .prepare("SELECT evidence FROM run_log WHERE job = 'market-alerts' ORDER BY rowid ASC")
      .all() as Array<{ evidence: string }>;
    const markersBefore = rowsBefore.flatMap((row) => JSON.parse(row.evidence) as Array<Record<string, unknown>>);
    expect(markersBefore.some((m) => m.event === "delivery_escalation_sent")).toBe(false);

    // The channel recovers. The next fire is delivered - the EXISTING
    // isRecoveryDue-gated branch still would NOT fire (no escalation marker
    // on record for it to react to) - only Fix B's belt-and-suspenders block
    // clears the artifact here.
    channelDead = false;
    const recovered = await poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), quoteProvider: lowQuote, transport });
    expect(recovered.sent).toBeGreaterThan(0);
    expect(existsSync(artifactPath)).toBe(false);
    expect(sent.some((e) => e.title.startsWith("✅"))).toBe(true); // the user is told the outage ended

    // Fix C: a NEW outage afterward (channel dies again) must start a FRESH
    // `since`, not resume the old one. A strictly LATER `now` (not the same
    // instant as the first outage) proves this isn't passing by coincidence.
    channelDead = true;
    for (const quoteProvider of [highQuote, lowQuote, highQuote]) {
      const r = await poll.runMarketAlertsPoll({ dbPath, now: new Date(LATER_TRADING_TIME), quoteProvider, transport });
      expect(r.sent).toBe(0);
    }
    expect(existsSync(artifactPath)).toBe(true);
    const secondSince = (JSON.parse(readFileSync(artifactPath, "utf8")) as { since: string }).since;
    expect(secondSince).not.toBe(firstSince);
  });

  // Fix E bullet 2: the off-hours early return used to happen BEFORE any
  // alerterDown check, so launchd/ops tooling watching this poller's exit
  // code saw a false "all clear" for the ~17.5 hours/day outside US regular
  // market hours even while the alerter was down.
  it("(Fix E) an off-hours tick still reports alerterDown:true while the artifact persists", async () => {
    const { db, dbPath } = makeDb();
    seedOneRule(db);
    const alwaysFailTransport = {
      sendCard: async () => ({ ok: false, error: "simulated total Feishu outage" }),
      updateCard: async () => ({ ok: true })
    };
    const failingQuoteProvider = async (): Promise<never> => {
      throw new Error("Longbridge quote failed: forcing a hard-failure escalation");
    };

    for (let i = 0; i < 3; i += 1) {
      await expect(
        poll.runMarketAlertsPoll({ dbPath, now: new Date(TRADING_TIME), quoteProvider: failingQuoteProvider, transport: alwaysFailTransport })
      ).rejects.toThrow();
    }
    const artifactPath = join(dirname(dbPath), "market-alerts", "ALERTER-DOWN.json");
    expect(existsSync(artifactPath)).toBe(true);

    const result = await poll.runMarketAlertsPoll({ dbPath, now: new Date(OFF_HOURS_TIME) });
    expect(result).toEqual({ ok: true, skipped: "off-hours", alerterDown: true });
  });

  // Fix E bullet 1: a throw from sending the hard-failure escalation card
  // (not just an ok:false send) used to be logged and swallowed WITHOUT
  // marking the alerter down, even though nobody was told anything either
  // way. Reproduced by dropping the `members` table AFTER seeding the rule -
  // sendOperatorCard's `new MemberRepository(db).listActive()` call now
  // throws for real, while the failure itself is forced via a throwing
  // quoteProvider at the "fetch_quotes" step (before pollOnce ever reaches
  // its own member lookups), so this stays a pure hard-failure scenario.
  it("(Fix E) a throw from sending the hard-failure escalation card still marks the alerter down", async () => {
    const { db, dbPath } = makeDb();
    seedOneRule(db);
    // foreign_keys is ON by default (openTradingDatabase) - alert_rules.owner_id
    // REFERENCES members(id), so dropping members outright would fail with a
    // FOREIGN KEY constraint error. Toggled off just for the drop - this test
    // only needs `new MemberRepository(db).listActive()` to throw for real,
    // not for the FK to keep being enforced afterward.
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("DROP TABLE members");
    db.exec("PRAGMA foreign_keys = ON");

    const transport = fakeTransport();
    for (let i = 0; i < 3; i += 1) {
      await expect(
        poll.runMarketAlertsPoll({
          dbPath,
          now: new Date(TRADING_TIME),
          quoteProvider: async () => {
            throw new Error("Longbridge quote failed: forcing the escalation attempt");
          },
          transport
        })
      ).rejects.toThrow();
    }

    const artifactPath = join(dirname(dbPath), "market-alerts", "ALERTER-DOWN.json");
    expect(existsSync(artifactPath)).toBe(true);
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
