import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemberRepository, openTradingDatabase } from "../../../packages/shared-types/dist/index.js";
import { composeAlertCards, deliverAlertCards } from "./market-alerts-cards.mjs";
import * as store from "./market-alerts-store.mjs";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

// `fire` here is composeAlertCards' expected input shape - NOT the bare
// object evaluateAll returns. See market-alerts-cards.mjs's header comment
// for why `eventId` and `threshold` must be zipped in by the caller.
function makeFire(overrides: Record<string, unknown> = {}) {
  return {
    ruleId: "rule_1",
    ownerId: "member_1",
    symbol: "NVDA.US",
    ruleType: "daily_move",
    value: -0.043,
    // 2026-07-13T14:10:00.000Z is 22:10 in Asia/Shanghai (UTC+8).
    triggeredAt: "2026-07-13T14:10:00.000Z",
    threshold: 0.04,
    eventId: "event_1",
    ...overrides
  };
}

const memberById = {
  member_1: { feishuOpenId: "ou_member_1" },
  member_2: { feishuOpenId: "ou_member_2" }
};

// ---------------------------------------------------------------------------
// composeAlertCards
// ---------------------------------------------------------------------------

describe("composeAlertCards", () => {
  it("merges multiple fires for one owner into a single card", () => {
    const fires = [
      makeFire({ eventId: "event_1", symbol: "NVDA.US", ruleType: "daily_move", value: -0.043, threshold: 0.04 }),
      makeFire({
        eventId: "event_2",
        ruleId: "rule_2",
        symbol: "TSLA.US",
        ruleType: "spike_5m",
        value: 0.03,
        threshold: 0.025,
        triggeredAt: "2026-07-13T14:15:00.000Z"
      })
    ];

    const batches = composeAlertCards(fires, memberById, {});

    expect(batches).toHaveLength(1);
    expect(batches[0].ownerId).toBe("member_1");
    expect(batches[0].openId).toBe("ou_member_1");
    expect(batches[0].card.title).toBe("盘中提醒 2 条");
    // 2 fire lines + the fixed footer line.
    expect(batches[0].card.lines).toHaveLength(3);
    expect(batches[0].card.lines.at(-1)).toBe("详情见今日日报（站点上线后将直达）");
    expect(batches[0].eventIds).toEqual(["event_1", "event_2"]);
    expect(batches[0].card.buttons).toBeUndefined();
  });

  it("produces two separate cards for two different owners", () => {
    const fires = [
      makeFire({ eventId: "event_1", ownerId: "member_1" }),
      makeFire({ eventId: "event_2", ownerId: "member_2", ruleId: "rule_2", symbol: "AAPL.US" })
    ];

    const batches = composeAlertCards(fires, memberById, {});

    expect(batches).toHaveLength(2);
    expect(batches.map((b) => b.ownerId).sort()).toEqual(["member_1", "member_2"]);
    for (const batch of batches) {
      expect(batch.card.lines).toHaveLength(2); // 1 fire line + footer
    }
  });

  it("renders exact Chinese copy with a position and dollar impact", () => {
    const fires = [makeFire({ symbol: "NVDA.US", ruleType: "daily_move", value: -0.043, threshold: 0.04 })];
    const positionsByOwner = {
      member_1: { "NVDA.US": { quantity: 12, price: 1000 } }
    };

    const batches = composeAlertCards(fires, memberById, positionsByOwner);

    // amount = round(12 * 1000 * 0.043) = round(516) = 516
    expect(batches[0].card.lines[0]).toBe("22:10 NVDA 日内 -4.3%（阈值 ±4%）· 持仓 12 股 · 影响 -$516");
  });

  it("renders a positive move with an explicit + sign on both percent and dollar amount", () => {
    const fires = [makeFire({ symbol: "TSLA.US", ruleType: "spike_5m", value: 0.03, threshold: 0.025 })];
    const positionsByOwner = {
      member_1: { "TSLA.US": { quantity: 10, price: 200 } }
    };

    const batches = composeAlertCards(fires, memberById, positionsByOwner);

    // amount = round(10 * 200 * 0.03) = 60
    expect(batches[0].card.lines[0]).toBe("22:10 TSLA 5分钟 +3.0%（阈值 ±2.5%）· 持仓 10 股 · 影响 +$60");
  });

  it("thousands-separates a large dollar impact", () => {
    const fires = [makeFire({ symbol: "NVDA.US", ruleType: "daily_move", value: -0.05, threshold: 0.04 })];
    const positionsByOwner = {
      member_1: { "NVDA.US": { quantity: 500, price: 500 } }
    };

    const batches = composeAlertCards(fires, memberById, positionsByOwner);

    // amount = round(500 * 500 * 0.05) = 12500
    expect(batches[0].card.lines[0]).toBe("22:10 NVDA 日内 -5.0%（阈值 ±4%）· 持仓 500 股 · 影响 -$12,500");
  });

  it("uses the unrealized_pnl label", () => {
    const fires = [makeFire({ ruleType: "unrealized_pnl", value: -0.061, threshold: 0.06 })];

    const batches = composeAlertCards(fires, memberById, {});

    expect(batches[0].card.lines[0]).toBe("22:10 NVDA 浮动盈亏 -6.1%（阈值 ±6%）");
  });

  it("omits the 持仓/影响 clauses entirely when there is no known position for that symbol", () => {
    const fires = [makeFire({ symbol: "NVDA.US" })];

    const batches = composeAlertCards(fires, memberById, { member_1: {} });

    expect(batches[0].card.lines[0]).toBe("22:10 NVDA 日内 -4.3%（阈值 ±4%）");
    expect(batches[0].card.lines[0]).not.toMatch(/NaN/);
  });

  it("omits only the 影响 clause when quantity is known but price is not", () => {
    const fires = [makeFire({ symbol: "NVDA.US" })];
    const positionsByOwner = {
      member_1: { "NVDA.US": { quantity: 12, price: null } }
    };

    const batches = composeAlertCards(fires, memberById, positionsByOwner);

    expect(batches[0].card.lines[0]).toBe("22:10 NVDA 日内 -4.3%（阈值 ±4%）· 持仓 12 股");
    expect(batches[0].card.lines[0]).not.toMatch(/NaN/);
  });

  it("renders the exposure line shape with no symbol, no time, and no position clause", () => {
    const fires = [
      makeFire({
        symbol: "*",
        ruleType: "exposure",
        value: 0.104,
        threshold: 0.1
      })
    ];
    // Even if a stray position entry existed under '*' it must never be used.
    const positionsByOwner = { member_1: { "*": { quantity: 999, price: 1 } } };

    const batches = composeAlertCards(fires, memberById, positionsByOwner);

    expect(batches[0].card.lines[0]).toBe("组合敞口 10.4%（预算 10%）");
  });

  it("skips (and reports via stderr) an owner with no feishuOpenId on file", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fires = [makeFire({ ownerId: "member_no_open_id" })];

    const batches = composeAlertCards(fires, { member_no_open_id: {} }, {});

    expect(batches).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/member_no_open_id/);
    errorSpy.mockRestore();
  });

  it("skips an owner entirely absent from memberById", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fires = [makeFire({ ownerId: "member_unknown" })];

    const batches = composeAlertCards(fires, {}, {});

    expect(batches).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it("returns an empty array for an empty fires list", () => {
    expect(composeAlertCards([], memberById, {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deliverAlertCards
// ---------------------------------------------------------------------------

describe("deliverAlertCards", () => {
  let db: DatabaseSync;
  const tempDirs: string[] = [];

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "alphaloop-alerts-cards-"));
    tempDirs.push(dir);
    db = openTradingDatabase(join(dir, "trading.sqlite"));
    const members = new MemberRepository(db);
    for (const id of ["member_1", "member_2"]) {
      members.upsert({
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
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function seedEvent(): string {
    const rule = store.insertRule(db, {
      ownerId: "member_1",
      symbol: "NVDA.US",
      ruleType: "daily_move",
      threshold: 0.04,
      direction: "both",
      frequency: "once_daily"
    });
    const [event] = store.recordEvents(db, [
      { ruleId: rule.id, ownerId: "member_1", value: -0.043, triggeredAt: "2026-07-13T14:10:00.000Z" }
    ]);
    return event.id;
  }

  function makeBatch(eventIds: string[]) {
    return {
      ownerId: "member_1",
      openId: "ou_member_1",
      card: { title: "盘中提醒 1 条", lines: ["22:10 NVDA 日内 -4.3%（阈值 ±4%）", "详情见今日日报（站点上线后将直达）"] },
      eventIds
    };
  }

  it("delivers a card and backfills message_id onto every event in the batch", async () => {
    const eventId = seedEvent();
    let receivedTarget: unknown;
    const fakeTransport = {
      sendCard: async (target: unknown) => {
        receivedTarget = target;
        return { ok: true, messageId: "om_fake_123" };
      },
      updateCard: async () => ({ ok: true })
    };

    const summary = await deliverAlertCards(db, [makeBatch([eventId])], fakeTransport);

    expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(receivedTarget).toEqual({ openId: "ou_member_1" });
    expect(store.getEvent(db, eventId)?.messageId).toBe("om_fake_123");
  });

  it("backfills the same message_id onto every eventId in a merged batch", async () => {
    const eventId1 = seedEvent();
    const rule2 = store.insertRule(db, {
      ownerId: "member_1",
      symbol: "TSLA.US",
      ruleType: "spike_5m",
      threshold: 0.025,
      direction: "both",
      frequency: "continuous"
    });
    const [event2] = store.recordEvents(db, [
      { ruleId: rule2.id, ownerId: "member_1", value: 0.03, triggeredAt: "2026-07-13T14:15:00.000Z" }
    ]);

    const fakeTransport = {
      sendCard: async () => ({ ok: true, messageId: "om_merged_1" }),
      updateCard: async () => ({ ok: true })
    };

    const summary = await deliverAlertCards(db, [makeBatch([eventId1, event2.id])], fakeTransport);

    expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(store.getEvent(db, eventId1)?.messageId).toBe("om_merged_1");
    expect(store.getEvent(db, event2.id)?.messageId).toBe("om_merged_1");
  });

  it("does not throw on transport failure, logs to stderr, and leaves events without message_id (no retry)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const eventId = seedEvent();
    const fakeTransport = {
      sendCard: async () => ({ ok: false, error: "chat not found" }),
      updateCard: async () => ({ ok: true })
    };

    const summary = await expect(deliverAlertCards(db, [makeBatch([eventId])], fakeTransport)).resolves.toEqual({
      sent: 0,
      failed: 1,
      skipped: 0
    });

    expect(store.getEvent(db, eventId)?.messageId).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    void summary;
  });

  it("does not throw when the transport itself throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const eventId = seedEvent();
    const fakeTransport = {
      sendCard: async () => {
        throw new Error("boom");
      },
      updateCard: async () => ({ ok: true })
    };

    await expect(deliverAlertCards(db, [makeBatch([eventId])], fakeTransport)).resolves.toEqual({
      sent: 0,
      failed: 1,
      skipped: 0
    });
    expect(store.getEvent(db, eventId)?.messageId).toBeNull();
    errorSpy.mockRestore();
  });

  it("processes independent batches independently: one failure does not block another owner's delivery", async () => {
    const eventId1 = seedEvent();
    const rule2 = store.insertRule(db, {
      ownerId: "member_2",
      symbol: "AAPL.US",
      ruleType: "daily_move",
      threshold: 0.04,
      direction: "both",
      frequency: "once_daily"
    });
    const [event2] = store.recordEvents(db, [
      { ruleId: rule2.id, ownerId: "member_2", value: 0.05, triggeredAt: "2026-07-13T14:10:00.000Z" }
    ]);

    let call = 0;
    const fakeTransport = {
      sendCard: async () => {
        call += 1;
        return call === 1 ? { ok: false, error: "first owner fails" } : { ok: true, messageId: "om_second_owner" };
      },
      updateCard: async () => ({ ok: true })
    };

    const batch1 = makeBatch([eventId1]);
    const batch2 = { ...makeBatch([event2.id]), ownerId: "member_2", openId: "ou_member_2" };

    const summary = await deliverAlertCards(db, [batch1, batch2], fakeTransport);

    expect(summary).toEqual({ sent: 1, failed: 1, skipped: 0 });
    expect(store.getEvent(db, eventId1)?.messageId).toBeNull();
    expect(store.getEvent(db, event2.id)?.messageId).toBe("om_second_owner");
  });

  it("skips a malformed batch (no openId) without attempting delivery", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const eventId = seedEvent();
    const batch = { ...makeBatch([eventId]), openId: undefined };
    let sendCalled = false;
    const fakeTransport = {
      sendCard: async () => {
        sendCalled = true;
        return { ok: true, messageId: "om_should_not_happen" };
      },
      updateCard: async () => ({ ok: true })
    };

    const summary = await deliverAlertCards(db, [batch], fakeTransport);

    expect(summary).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(sendCalled).toBe(false);
    errorSpy.mockRestore();
  });

  it("returns a zeroed summary for an empty batch list", async () => {
    const summary = await deliverAlertCards(db, [], { sendCard: async () => ({ ok: true }), updateCard: async () => ({ ok: true }) });
    expect(summary).toEqual({ sent: 0, failed: 0, skipped: 0 });
  });
});
