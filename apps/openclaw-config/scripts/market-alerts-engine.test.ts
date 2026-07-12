import { describe, expect, it } from "vitest";

import { evaluateAll, evaluateRule } from "./market-alerts-engine.mjs";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeRule(overrides: Record<string, unknown> = {}) {
  return {
    id: "rule_1",
    ownerId: "member_1",
    symbol: "AAPL.US",
    ruleType: "daily_move",
    threshold: 0.04,
    direction: "both",
    frequency: "once_daily",
    hysteresis: 0,
    enabled: true,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

function makeRuntime(overrides: Record<string, unknown> = {}) {
  return {
    ruleId: "rule_1",
    armed: true,
    cooldownUntil: null,
    lastFiredTradingDay: null,
    lastValue: { lastPrice: null, history: [] },
    ...overrides
  };
}

function makeSample(overrides: Record<string, unknown> = {}) {
  return {
    atIso: "2026-07-01T14:30:00.000Z",
    tradingDay: "2026-07-01",
    quotes: {},
    positions: {},
    exposure: { exposureRatio: null, overBudget: false },
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// daily_move (once_daily)
// ---------------------------------------------------------------------------

describe("evaluateRule: daily_move", () => {
  it("fires when the absolute daily move meets threshold and hasn't fired today", () => {
    const rule = makeRule({ ruleType: "daily_move", threshold: 0.04 });
    const runtime = makeRuntime();
    const sample = makeSample({
      quotes: { "AAPL.US": { price: 105, prevClose: 100, volume: 1000 } }
    });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("fire");
    expect(result.reason).toBe("daily_move");
    expect(result.value).toBeCloseTo(0.05);
    expect(result.newRuntime.lastFiredTradingDay).toBe("2026-07-01");
    expect(result.quotaDelta).toBe(1);
  });

  it("skips when the move is below threshold", () => {
    const rule = makeRule({ ruleType: "daily_move", threshold: 0.04 });
    const runtime = makeRuntime();
    const sample = makeSample({
      quotes: { "AAPL.US": { price: 102, prevClose: 100, volume: 1000 } }
    });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("below_threshold");
    expect(result.newRuntime.lastFiredTradingDay).toBeNull();
  });

  it("does not repeat within the same trading day (once_daily)", () => {
    const rule = makeRule({ ruleType: "daily_move", threshold: 0.04 });
    const runtime = makeRuntime({ lastFiredTradingDay: "2026-07-01" });
    const sample = makeSample({
      quotes: { "AAPL.US": { price: 110, prevClose: 100, volume: 1000 } }
    });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("already_fired_today");
  });

  it("fires again on a new trading day after firing on a prior day", () => {
    const rule = makeRule({ ruleType: "daily_move", threshold: 0.04 });
    const runtime = makeRuntime({ lastFiredTradingDay: "2026-06-30" });
    const sample = makeSample({
      tradingDay: "2026-07-01",
      quotes: { "AAPL.US": { price: 110, prevClose: 100, volume: 1000 } }
    });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("fire");
    expect(result.newRuntime.lastFiredTradingDay).toBe("2026-07-01");
  });

  it("respects direction: 'up' does not fire on a down move even past threshold magnitude", () => {
    const rule = makeRule({ ruleType: "daily_move", threshold: 0.04, direction: "up" });
    const runtime = makeRuntime();
    const sample = makeSample({
      quotes: { "AAPL.US": { price: 90, prevClose: 100, volume: 1000 } }
    });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("below_threshold");
  });

  it("respects direction: 'down' fires on a down move", () => {
    const rule = makeRule({ ruleType: "daily_move", threshold: 0.04, direction: "down" });
    const runtime = makeRuntime();
    const sample = makeSample({
      quotes: { "AAPL.US": { price: 90, prevClose: 100, volume: 1000 } }
    });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("fire");
    expect(result.value).toBeCloseTo(-0.1);
  });

  it("skips with reason 'no_data' when the symbol's quote is missing", () => {
    const rule = makeRule({ ruleType: "daily_move" });
    const runtime = makeRuntime();
    const sample = makeSample({ quotes: {} });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("no_data");
  });

  it("is blocked by quota even when the threshold condition is met, and does not consume last_fired_trading_day", () => {
    const rule = makeRule({ ruleType: "daily_move", threshold: 0.04 });
    const runtime = makeRuntime();
    const sample = makeSample({
      quotes: { "AAPL.US": { price: 110, prevClose: 100, volume: 1000 } }
    });

    const result = evaluateRule(rule, runtime, sample, 30);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("quota");
    expect(result.quotaDelta).toBe(0);
    // Quota-blocked fires must not consume the once-daily slot: the rule should
    // still be able to fire later (e.g. once quota resets) rather than silently
    // treating this as "already handled today."
    expect(result.newRuntime.lastFiredTradingDay).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// unrealized_pnl (continuous + hysteresis)
// ---------------------------------------------------------------------------

describe("evaluateRule: unrealized_pnl", () => {
  const rule = makeRule({
    id: "rule_pnl",
    ruleType: "unrealized_pnl",
    symbol: "MSFT.US",
    threshold: 0.06,
    hysteresis: 0.01,
    frequency: "continuous"
  });

  it("fires when |price/costPrice - 1| >= threshold and armed, then disarms", () => {
    const runtime = makeRuntime({ ruleId: "rule_pnl", armed: true });
    const sample = makeSample({
      quotes: { "MSFT.US": { price: 107, prevClose: 100, volume: 1000 } },
      positions: { "MSFT.US": { quantity: 10, costPrice: 100, marketValue: 1070 } }
    });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("fire");
    expect(result.reason).toBe("unrealized_pnl");
    expect(result.value).toBeCloseTo(0.07);
    expect(result.newRuntime.armed).toBe(false);
  });

  it("stays disarmed (skip) while still elevated above the rearm band", () => {
    const runtime = makeRuntime({ ruleId: "rule_pnl", armed: false });
    const sample = makeSample({
      quotes: { "MSFT.US": { price: 106, prevClose: 100, volume: 1000 } },
      positions: { "MSFT.US": { quantity: 10, costPrice: 100, marketValue: 1060 } }
    });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("disarmed");
    expect(result.newRuntime.armed).toBe(false);
  });

  it("re-arms once the value falls to within (threshold - hysteresis)", () => {
    const runtime = makeRuntime({ ruleId: "rule_pnl", armed: false });
    const sample = makeSample({
      quotes: { "MSFT.US": { price: 104, prevClose: 100, volume: 1000 } },
      positions: { "MSFT.US": { quantity: 10, costPrice: 100, marketValue: 1040 } }
    });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("rearmed");
    expect(result.newRuntime.armed).toBe(true);
  });

  it("fires a second time after re-arming", () => {
    const runtime = makeRuntime({ ruleId: "rule_pnl", armed: true });
    const sample = makeSample({
      quotes: { "MSFT.US": { price: 108, prevClose: 100, volume: 1000 } },
      positions: { "MSFT.US": { quantity: 10, costPrice: 100, marketValue: 1080 } }
    });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("fire");
    expect(result.newRuntime.armed).toBe(false);
  });

  it("is blocked by quota and leaves armed state untouched (no silent disarm)", () => {
    const runtime = makeRuntime({ ruleId: "rule_pnl", armed: true });
    const sample = makeSample({
      quotes: { "MSFT.US": { price: 107, prevClose: 100, volume: 1000 } },
      positions: { "MSFT.US": { quantity: 10, costPrice: 100, marketValue: 1070 } }
    });

    const result = evaluateRule(rule, runtime, sample, 30);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("quota");
    expect(result.newRuntime.armed).toBe(true);
  });

  it("skips with 'no_data' when the position's costPrice is missing", () => {
    const runtime = makeRuntime({ ruleId: "rule_pnl", armed: true });
    const sample = makeSample({
      quotes: { "MSFT.US": { price: 107, prevClose: 100, volume: 1000 } },
      positions: {}
    });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("no_data");
  });
});

// ---------------------------------------------------------------------------
// spike_5m (continuous + 60min cooldown + liquidity precondition)
// ---------------------------------------------------------------------------

describe("evaluateRule: spike_5m", () => {
  const rule = makeRule({
    id: "rule_spike",
    ruleType: "spike_5m",
    symbol: "TSLA.US",
    threshold: 0.025,
    hysteresis: 0,
    frequency: "continuous"
  });

  it("skips with 'insufficient_history' until 3 prior samples have accumulated", () => {
    const runtime = makeRuntime({ ruleId: "rule_spike" });
    const sample = makeSample({ quotes: { "TSLA.US": { price: 200, prevClose: 200, volume: 1000 } } });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("insufficient_history");
    expect(result.newRuntime.lastValue.history).toEqual([{ p: 200, v: 1000 }]);
  });

  it("fires once 3 prior samples exist, the move vs. 3-samples-ago exceeds threshold, and all 3 had volume", () => {
    const runtime = makeRuntime({
      ruleId: "rule_spike",
      lastValue: {
        lastPrice: 202,
        history: [
          { p: 200, v: 1000 },
          { p: 201, v: 1000 },
          { p: 202, v: 1000 }
        ]
      }
    });
    const sample = makeSample({ quotes: { "TSLA.US": { price: 210, prevClose: 200, volume: 1000 } } });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("fire");
    expect(result.reason).toBe("spike_5m");
    expect(result.value).toBeCloseTo(210 / 200 - 1);
    expect(result.newRuntime.cooldownUntil).toBe(
      new Date(new Date(sample.atIso).getTime() + 60 * 60 * 1000).toISOString()
    );
    expect(result.newRuntime.lastValue.history).toEqual([
      { p: 201, v: 1000 },
      { p: 202, v: 1000 },
      { p: 210, v: 1000 }
    ]);
  });

  it("does NOT fire when one of the 3 history points has zero volume (low-volume spurious spike)", () => {
    const runtime = makeRuntime({
      ruleId: "rule_spike",
      lastValue: {
        lastPrice: 202,
        history: [
          { p: 200, v: 1000 },
          { p: 201, v: 0 },
          { p: 202, v: 1000 }
        ]
      }
    });
    const sample = makeSample({ quotes: { "TSLA.US": { price: 210, prevClose: 200, volume: 1000 } } });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("zero_volume");
  });

  it("skips with 'below_threshold' when the move vs. 3-samples-ago is too small", () => {
    const runtime = makeRuntime({
      ruleId: "rule_spike",
      lastValue: {
        lastPrice: 200,
        history: [
          { p: 200, v: 1000 },
          { p: 200, v: 1000 },
          { p: 200, v: 1000 }
        ]
      }
    });
    const sample = makeSample({ quotes: { "TSLA.US": { price: 201, prevClose: 200, volume: 1000 } } });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("below_threshold");
  });

  it("skips with 'cooldown' when a fire happened within the last 60 minutes", () => {
    const runtime = makeRuntime({
      ruleId: "rule_spike",
      cooldownUntil: "2026-07-01T15:00:00.000Z",
      lastValue: {
        lastPrice: 202,
        history: [
          { p: 200, v: 1000 },
          { p: 201, v: 1000 },
          { p: 202, v: 1000 }
        ]
      }
    });
    const sample = makeSample({
      atIso: "2026-07-01T14:30:00.000Z",
      quotes: { "TSLA.US": { price: 210, prevClose: 200, volume: 1000 } }
    });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("cooldown");
  });

  it("fires again once cooldown has elapsed (cooldown_until < now)", () => {
    const runtime = makeRuntime({
      ruleId: "rule_spike",
      cooldownUntil: "2026-07-01T14:00:00.000Z",
      lastValue: {
        lastPrice: 202,
        history: [
          { p: 200, v: 1000 },
          { p: 201, v: 1000 },
          { p: 202, v: 1000 }
        ]
      }
    });
    const sample = makeSample({
      atIso: "2026-07-01T14:30:00.000Z",
      quotes: { "TSLA.US": { price: 210, prevClose: 200, volume: 1000 } }
    });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("fire");
  });

  it("skips with 'no_data' and does not corrupt the rolling history window when the quote is temporarily missing", () => {
    const runtime = makeRuntime({
      ruleId: "rule_spike",
      lastValue: {
        lastPrice: 202,
        history: [
          { p: 200, v: 1000 },
          { p: 201, v: 1000 },
          { p: 202, v: 1000 }
        ]
      }
    });
    const sample = makeSample({ quotes: {} }); // TSLA.US quote missing this tick

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("no_data");
    // The window must be left exactly as it was, not padded with a garbage
    // {p: undefined, v: undefined} entry that would corrupt future windows.
    expect(result.newRuntime.lastValue.history).toEqual([
      { p: 200, v: 1000 },
      { p: 201, v: 1000 },
      { p: 202, v: 1000 }
    ]);
  });

  it("is blocked by quota and leaves cooldown_until untouched", () => {
    const runtime = makeRuntime({
      ruleId: "rule_spike",
      lastValue: {
        lastPrice: 202,
        history: [
          { p: 200, v: 1000 },
          { p: 201, v: 1000 },
          { p: 202, v: 1000 }
        ]
      }
    });
    const sample = makeSample({ quotes: { "TSLA.US": { price: 210, prevClose: 200, volume: 1000 } } });

    const result = evaluateRule(rule, runtime, sample, 30);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("quota");
    expect(result.newRuntime.cooldownUntil).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// exposure (continuous + 1% hysteresis)
// ---------------------------------------------------------------------------

describe("evaluateRule: exposure", () => {
  const rule = makeRule({
    id: "rule_exposure",
    ruleType: "exposure",
    symbol: "PORTFOLIO",
    threshold: 0.1,
    hysteresis: 0.01,
    frequency: "continuous"
  });

  it("fires when exposureRatio > threshold and armed, then disarms", () => {
    const runtime = makeRuntime({ ruleId: "rule_exposure", armed: true });
    const sample = makeSample({ exposure: { exposureRatio: 0.12, overBudget: true } });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("fire");
    expect(result.reason).toBe("exposure");
    expect(result.value).toBeCloseTo(0.12);
    expect(result.newRuntime.armed).toBe(false);
  });

  it("does not fire exactly at the threshold (strict >)", () => {
    const runtime = makeRuntime({ ruleId: "rule_exposure", armed: true });
    const sample = makeSample({ exposure: { exposureRatio: 0.1, overBudget: false } });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("below_threshold");
  });

  it("stays disarmed while exposure remains above the rearm band", () => {
    const runtime = makeRuntime({ ruleId: "rule_exposure", armed: false });
    const sample = makeSample({ exposure: { exposureRatio: 0.095, overBudget: false } });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("disarmed");
    expect(result.newRuntime.armed).toBe(false);
  });

  it("re-arms once exposure falls to <= (threshold - hysteresis)", () => {
    const runtime = makeRuntime({ ruleId: "rule_exposure", armed: false });
    const sample = makeSample({ exposure: { exposureRatio: 0.09, overBudget: false } });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("rearmed");
    expect(result.newRuntime.armed).toBe(true);
  });

  it("fires a second time after re-arming", () => {
    const runtime = makeRuntime({ ruleId: "rule_exposure", armed: true });
    const sample = makeSample({ exposure: { exposureRatio: 0.15, overBudget: true } });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("fire");
  });

  it("skips with 'no_data' when exposureRatio is null (missing net assets, per computeExposure)", () => {
    const runtime = makeRuntime({ ruleId: "rule_exposure", armed: true });
    const sample = makeSample({ exposure: { exposureRatio: null, overBudget: false } });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("no_data");
  });

  it("is blocked by quota and leaves armed state untouched", () => {
    const runtime = makeRuntime({ ruleId: "rule_exposure", armed: true });
    const sample = makeSample({ exposure: { exposureRatio: 0.2, overBudget: true } });

    const result = evaluateRule(rule, runtime, sample, 30);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("quota");
    expect(result.newRuntime.armed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluateAll: per-owner quota trimming across a batch of rules
// ---------------------------------------------------------------------------

describe("evaluateAll", () => {
  function makeQuotaRules(count: number, ownerId: string) {
    return Array.from({ length: count }, (_, i) =>
      makeRule({
        id: `rule_${i}`,
        ownerId,
        symbol: `SYM${i}.US`,
        ruleType: "daily_move",
        threshold: 0.04
      })
    );
  }

  it("trims fires past 30-per-owner-per-day, in rule order", () => {
    const rules = makeQuotaRules(31, "owner_a");
    const runtimes: Record<string, unknown> = {};
    const sample = makeSample({
      quotes: Object.fromEntries(
        rules.map((r) => [r.symbol, { price: 110, prevClose: 100, volume: 1000 }])
      )
    });

    const { fires, skips, newQuotas } = evaluateAll(rules, runtimes, sample, { owner_a: 0 });

    expect(fires).toHaveLength(30);
    expect(fires.map((f) => f.ruleId)).toEqual(rules.slice(0, 30).map((r) => r.id));
    expect(skips).toHaveLength(1);
    expect(skips[0].ruleId).toBe("rule_30");
    expect(skips[0].reason).toBe("quota");
    expect(newQuotas.owner_a).toBe(30);
  });

  it("tracks quota independently per owner", () => {
    const rulesA = makeQuotaRules(2, "owner_a");
    const rulesB = makeQuotaRules(2, "owner_b").map((r) => ({ ...r, id: `b_${r.id}` }));
    const rules = [...rulesA, ...rulesB];
    const sample = makeSample({
      quotes: Object.fromEntries(rules.map((r) => [r.symbol, { price: 110, prevClose: 100, volume: 1000 }]))
    });

    const { fires, newQuotas } = evaluateAll(rules, {}, sample, { owner_a: 29, owner_b: 0 });

    // owner_a starts at 29: first of its 2 rules fires (29->30), second is quota-trimmed.
    const ownerAFires = fires.filter((f) => f.ownerId === "owner_a");
    const ownerBFires = fires.filter((f) => f.ownerId === "owner_b");
    expect(ownerAFires).toHaveLength(1);
    expect(ownerBFires).toHaveLength(2);
    expect(newQuotas.owner_a).toBe(30);
    expect(newQuotas.owner_b).toBe(2);
  });

  it("returns a newRuntimes entry for every rule, including ones that only skip", () => {
    const rule = makeRule({ id: "rule_x", threshold: 0.04 });
    const sample = makeSample({ quotes: { "AAPL.US": { price: 100, prevClose: 100, volume: 1000 } } });

    const { newRuntimes } = evaluateAll([rule], {}, sample, {});

    expect(newRuntimes.rule_x).toBeTruthy();
    expect(newRuntimes.rule_x.ruleId).toBe("rule_x");
  });
});

// ---------------------------------------------------------------------------
// Replay: deterministic multi-day, multi-symbol sample sequence
// ---------------------------------------------------------------------------
//
// Drives evaluateAll tick-by-tick across a fixed rule set, threading
// `runtimes` and `quotaByOwner` forward exactly the way a real poller +
// SQLite-backed store would (quota keyed by trading day, reset when the
// trading day rolls over). Asserts the full fire/skip timeline.

describe("replay: deterministic multi-day multi-symbol sequence", () => {
  const dailyMoveRule = makeRule({
    id: "replay_daily_move",
    ownerId: "m1",
    symbol: "AAPL.US",
    ruleType: "daily_move",
    threshold: 0.04,
    frequency: "once_daily"
  });

  const pnlRule = makeRule({
    id: "replay_pnl",
    ownerId: "m2",
    symbol: "MSFT.US",
    ruleType: "unrealized_pnl",
    threshold: 0.06,
    hysteresis: 0.01,
    frequency: "continuous"
  });

  const spikeRule = makeRule({
    id: "replay_spike",
    ownerId: "m3",
    symbol: "TSLA.US",
    ruleType: "spike_5m",
    threshold: 0.02,
    hysteresis: 0,
    frequency: "continuous"
  });

  const quotaRules = Array.from({ length: 31 }, (_, i) =>
    makeRule({
      id: `replay_quota_${i}`,
      ownerId: "m4",
      symbol: `QSYM${i}.US`,
      ruleType: "daily_move",
      threshold: 0.04,
      frequency: "once_daily"
    })
  );

  const rules = [dailyMoveRule, pnlRule, spikeRule, ...quotaRules];

  // Every tick supplies a full quotes snapshot; unrelated symbols hold steady.
  function buildQuotes(overrides: Record<string, { price: number; prevClose: number; volume: number }>) {
    const steady = Object.fromEntries(
      quotaRules.map((r) => [r.symbol, { price: 100, prevClose: 100, volume: 1000 }])
    );
    return { ...steady, ...overrides };
  }

  const msftPosition = { quantity: 10, costPrice: 100, marketValue: 1000 };

  type Tick = {
    label: string;
    atIso: string;
    tradingDay: string;
    quotes: Record<string, { price: number; prevClose: number; volume: number }>;
  };

  const day1 = "2026-07-01";
  const day2 = "2026-07-02";

  const ticks: Tick[] = [
    // --- t0: day1 open. AAPL gaps up 5% (daily_move fires). MSFT flat. TSLA
    // warm-up sample #1 (insufficient spike history). The 31 quota rules all
    // gap up together -> exercises the 31-rule quota trim.
    {
      label: "t0_day1_open",
      atIso: "2026-07-01T13:30:00.000Z",
      tradingDay: day1,
      quotes: buildQuotes({
        "AAPL.US": { price: 105, prevClose: 100, volume: 1000 },
        "MSFT.US": { price: 100, prevClose: 100, volume: 1000 },
        "TSLA.US": { price: 200, prevClose: 200, volume: 1000 },
        ...Object.fromEntries(quotaRules.map((r) => [r.symbol, { price: 110, prevClose: 100, volume: 1000 }]))
      })
    },
    // --- t1: AAPL still up big, but already fired today -> must not repeat.
    // TSLA warm-up #2. MSFT climbs to +7% -> pnl fires, disarms.
    {
      label: "t1_still_up",
      atIso: "2026-07-01T13:35:00.000Z",
      tradingDay: day1,
      quotes: buildQuotes({
        "AAPL.US": { price: 108, prevClose: 100, volume: 1000 },
        "MSFT.US": { price: 107, prevClose: 100, volume: 1000 },
        "TSLA.US": { price: 200, prevClose: 200, volume: 1000 }
      })
    },
    // --- t2: TSLA warm-up #3, deliberately zero volume (the point that will
    // later sit inside the 3-sample window and block a spike as a spurious
    // low-volume glitch). MSFT falls back to +6% (still elevated, disarmed).
    {
      label: "t2_tsla_zero_volume_sample",
      atIso: "2026-07-01T13:40:00.000Z",
      tradingDay: day1,
      quotes: buildQuotes({
        "AAPL.US": { price: 108, prevClose: 100, volume: 1000 },
        "MSFT.US": { price: 106, prevClose: 100, volume: 1000 },
        "TSLA.US": { price: 200, prevClose: 200, volume: 0 }
      })
    },
    // --- t3: TSLA now has exactly 3 prior samples (200/1000, 200/1000,
    // 200/0). A jump to 220 (+10% vs. 3-samples-ago) would clear the
    // threshold, but the zero-volume sample in the window must block it.
    // MSFT drops to +4% -> within the rearm band -> re-arms (skip, no fire).
    {
      label: "t3_tsla_spurious_spike_blocked",
      atIso: "2026-07-01T13:45:00.000Z",
      tradingDay: day1,
      quotes: buildQuotes({
        "AAPL.US": { price: 108, prevClose: 100, volume: 1000 },
        "MSFT.US": { price: 104, prevClose: 100, volume: 1000 },
        "TSLA.US": { price: 220, prevClose: 200, volume: 1000 }
      })
    },
    // --- t4: TSLA window is now [200/1000, 200/0, 220/1000] - the
    // zero-volume sample is still inside it, so a further jump still must
    // NOT fire. MSFT jumps to +8% -> re-armed, so this is the second fire.
    {
      label: "t4_tsla_still_blocked_msft_refires",
      atIso: "2026-07-01T13:50:00.000Z",
      tradingDay: day1,
      quotes: buildQuotes({
        "AAPL.US": { price: 108, prevClose: 100, volume: 1000 },
        "MSFT.US": { price: 108, prevClose: 100, volume: 1000 },
        "TSLA.US": { price: 221, prevClose: 200, volume: 1000 }
      })
    },
    // --- t5: TSLA window is now [200/0, 220/1000, 221/1000] - the
    // zero-volume sample is STILL inside it (one more tick to flush). Must
    // still not fire.
    {
      label: "t5_tsla_still_blocked",
      atIso: "2026-07-01T13:55:00.000Z",
      tradingDay: day1,
      quotes: buildQuotes({
        "AAPL.US": { price: 108, prevClose: 100, volume: 1000 },
        "MSFT.US": { price: 108, prevClose: 100, volume: 1000 },
        "TSLA.US": { price: 222, prevClose: 200, volume: 1000 }
      })
    },
    // --- t6: TSLA window is finally [220/1000, 221/1000, 222/1000] - clean.
    // A further jump to 230 (vs. 220, +4.5%) clears threshold with all-clear
    // volumes -> genuine spike fires.
    {
      label: "t6_tsla_clean_spike_fires",
      atIso: "2026-07-01T14:00:00.000Z",
      tradingDay: day1,
      quotes: buildQuotes({
        "AAPL.US": { price: 108, prevClose: 100, volume: 1000 },
        "MSFT.US": { price: 108, prevClose: 100, volume: 1000 },
        "TSLA.US": { price: 230, prevClose: 200, volume: 1000 }
      })
    },
    // --- t7: 20 minutes later, TSLA jumps again (vs. 3-samples-ago) past
    // threshold, but the 60-minute cooldown from t6 is still active.
    {
      label: "t7_tsla_cooldown_blocks",
      atIso: "2026-07-01T14:20:00.000Z",
      tradingDay: day1,
      quotes: buildQuotes({
        "AAPL.US": { price: 108, prevClose: 100, volume: 1000 },
        "MSFT.US": { price: 108, prevClose: 100, volume: 1000 },
        "TSLA.US": { price: 245, prevClose: 200, volume: 1000 }
      })
    },
    // --- t8: day2 open. AAPL gaps up again -> once_daily resets, fires.
    // The 31 quota rules gap up again -> quota must have reset to 0 for the
    // new trading day (30 fire, the 31st is trimmed again).
    {
      label: "t8_day2_open",
      atIso: "2026-07-02T13:30:00.000Z",
      tradingDay: day2,
      quotes: buildQuotes({
        "AAPL.US": { price: 106, prevClose: 100, volume: 1000 },
        "MSFT.US": { price: 108, prevClose: 100, volume: 1000 },
        "TSLA.US": { price: 246, prevClose: 200, volume: 1000 },
        ...Object.fromEntries(quotaRules.map((r) => [r.symbol, { price: 111, prevClose: 100, volume: 1000 }]))
      })
    }
  ];

  it("produces the expected fire/skip timeline across all scenarios", () => {
    let runtimes: Record<string, any> = {};
    let quotaByOwner: Record<string, number> = {};
    let previousTradingDay: string | null = null;
    const timeline: Array<{ tick: string; ruleId: string; decision: string; reason: string }> = [];

    for (const tick of ticks) {
      if (previousTradingDay !== null && previousTradingDay !== tick.tradingDay) {
        // A new trading day: the store's per-(owner, trading_day) quota row
        // starts fresh, so the replay driver resets its local tracking too.
        quotaByOwner = {};
      }
      previousTradingDay = tick.tradingDay;

      const sample = {
        atIso: tick.atIso,
        tradingDay: tick.tradingDay,
        quotes: tick.quotes,
        positions: { "MSFT.US": msftPosition },
        exposure: { exposureRatio: null, overBudget: false }
      };

      const { results, newRuntimes, newQuotas } = evaluateAll(rules, runtimes, sample, quotaByOwner);
      runtimes = newRuntimes;
      quotaByOwner = newQuotas;

      for (const r of results) {
        timeline.push({ tick: tick.label, ruleId: r.ruleId, decision: r.decision, reason: r.reason });
      }
    }

    function outcome(tick: string, ruleId: string) {
      const entry = timeline.find((e) => e.tick === tick && e.ruleId === ruleId);
      if (!entry) {
        throw new Error(`no timeline entry for ${tick}/${ruleId}`);
      }
      return `${entry.decision}:${entry.reason}`;
    }

    // --- once_daily non-repetition ---
    expect(outcome("t0_day1_open", "replay_daily_move")).toBe("fire:daily_move");
    expect(outcome("t1_still_up", "replay_daily_move")).toBe("skip:already_fired_today");
    expect(outcome("t4_tsla_still_blocked_msft_refires", "replay_daily_move")).toBe("skip:already_fired_today");
    expect(outcome("t8_day2_open", "replay_daily_move")).toBe("fire:daily_move");

    // --- hysteresis: fire -> disarmed -> rearmed -> fire again ---
    expect(outcome("t1_still_up", "replay_pnl")).toBe("fire:unrealized_pnl");
    expect(outcome("t2_tsla_zero_volume_sample", "replay_pnl")).toBe("skip:disarmed");
    expect(outcome("t3_tsla_spurious_spike_blocked", "replay_pnl")).toBe("skip:rearmed");
    expect(outcome("t4_tsla_still_blocked_msft_refires", "replay_pnl")).toBe("fire:unrealized_pnl");

    // --- low-volume spike precondition: must NOT fire while the zero-volume
    // sample is inside the rolling 3-sample window, across 3 consecutive ticks ---
    expect(outcome("t0_day1_open", "replay_spike")).toBe("skip:insufficient_history");
    expect(outcome("t1_still_up", "replay_spike")).toBe("skip:insufficient_history");
    expect(outcome("t2_tsla_zero_volume_sample", "replay_spike")).toBe("skip:insufficient_history");
    expect(outcome("t3_tsla_spurious_spike_blocked", "replay_spike")).toBe("skip:zero_volume");
    expect(outcome("t4_tsla_still_blocked_msft_refires", "replay_spike")).toBe("skip:zero_volume");
    expect(outcome("t5_tsla_still_blocked", "replay_spike")).toBe("skip:zero_volume");
    expect(outcome("t6_tsla_clean_spike_fires", "replay_spike")).toBe("fire:spike_5m");
    expect(outcome("t7_tsla_cooldown_blocks", "replay_spike")).toBe("skip:cooldown");

    // --- quota: 30 fire, 31st is trimmed; resets on the new trading day ---
    const day1QuotaOutcomes = quotaRules.map((r) => outcome("t0_day1_open", r.id));
    expect(day1QuotaOutcomes.filter((o) => o === "fire:daily_move")).toHaveLength(30);
    expect(day1QuotaOutcomes.filter((o) => o === "skip:quota")).toHaveLength(1);
    expect(outcome("t0_day1_open", "replay_quota_30")).toBe("skip:quota");

    const day2QuotaOutcomes = quotaRules.map((r) => outcome("t8_day2_open", r.id));
    expect(day2QuotaOutcomes.filter((o) => o === "fire:daily_move")).toHaveLength(30);
    expect(day2QuotaOutcomes.filter((o) => o === "skip:quota")).toHaveLength(1);
    // Quota resets per trading day: if m4's day1 count (already at 30) had
    // carried over instead of resetting, every one of these 31 rules would
    // skip:quota on day2 rather than 30 of them firing again. (Separately,
    // evaluateRule's unit tests above pin that a quota-blocked fire leaves
    // last_fired_trading_day untouched, so a rule trimmed today can still
    // fire once quota allows it - same-day or later.)
    expect(outcome("t8_day2_open", "replay_quota_30")).toBe("skip:quota");
  });
});
