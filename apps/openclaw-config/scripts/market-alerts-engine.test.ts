import { describe, expect, it } from "vitest";

import { DEFAULT_HYSTERESIS, DEFAULT_THRESHOLDS, evaluateAll, evaluateRule, RULE_TYPE_FREQUENCY } from "./market-alerts-engine.mjs";

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

  it("records armedDirection = 'up' on an upward fire, and 'down' on a downward fire", () => {
    const upFire = evaluateRule(
      rule,
      makeRuntime({ ruleId: "rule_pnl", armed: true }),
      makeSample({
        quotes: { "MSFT.US": { price: 107, prevClose: 100, volume: 1000 } },
        positions: { "MSFT.US": { quantity: 10, costPrice: 100, marketValue: 1070 } }
      }),
      0
    );
    expect(upFire.decision).toBe("fire");
    expect(upFire.newRuntime.lastValue.armedDirection).toBe("up");

    const downFire = evaluateRule(
      rule,
      makeRuntime({ ruleId: "rule_pnl", armed: true }),
      makeSample({
        quotes: { "MSFT.US": { price: 93, prevClose: 100, volume: 1000 } },
        positions: { "MSFT.US": { quantity: 10, costPrice: 100, marketValue: 930 } }
      }),
      0
    );
    expect(downFire.decision).toBe("fire");
    expect(downFire.newRuntime.lastValue.armedDirection).toBe("down");
  });
});

// ---------------------------------------------------------------------------
// unrealized_pnl armedDirection: signed re-arm and opposite-direction
// whipsaw fires (Finding 2 fix)
//
// The single unsigned `armed` bit used to lose the direction of the fire
// that disarmed it, causing two bugs:
//   (i) a same-sample whipsaw crossing the whole band (fire up, then a huge
//       gap down) was swallowed as skip:disarmed instead of firing again -
//       it's a distinct, oppositely-directed event.
//   (ii) re-arm compared |value| to the rearm band, so a rule that fired
//       upward stayed "disarmed" forever once price cratered deeply
//       negative (a large negative value also has a large absolute value).
// `armedDirection` ('up'|'down'|null, persisted in the runtime JSON
// alongside `armed`) fixes both.
// ---------------------------------------------------------------------------

describe("evaluateRule: unrealized_pnl armedDirection (signed re-arm)", () => {
  const bothRule = makeRule({
    id: "rule_pnl_both",
    ruleType: "unrealized_pnl",
    symbol: "MSFT.US",
    threshold: 0.06,
    hysteresis: 0.01,
    direction: "both",
    frequency: "continuous"
  });

  function pnlSample(price: number) {
    return makeSample({
      quotes: { "MSFT.US": { price, prevClose: 100, volume: 1000 } },
      positions: { "MSFT.US": { quantity: 10, costPrice: 100, marketValue: price * 10 } }
    });
  }

  it("fires on an opposite-direction whipsaw while nominally disarmed, and flips armedDirection", () => {
    // Disarmed by a prior up-fire (armedDirection: 'up'); a same-sample gap
    // down to -7% is a distinct event and must fire, not be swallowed as
    // skip:disarmed.
    const runtime = makeRuntime({
      ruleId: "rule_pnl_both",
      armed: false,
      lastValue: { lastPrice: 108, history: [], armedDirection: "up" }
    });

    const result = evaluateRule(bothRule, runtime, pnlSample(93), 0);

    expect(result.decision).toBe("fire");
    expect(result.reason).toBe("unrealized_pnl");
    expect(result.value).toBeCloseTo(-0.07);
    expect(result.newRuntime.armed).toBe(false);
    expect(result.newRuntime.lastValue.armedDirection).toBe("down");
  });

  it("a direction='up' rule that fired at +7% re-arms once price craters far negative (was stuck disarmed forever under the old unsigned check)", () => {
    const upRule = makeRule({
      id: "rule_pnl_up",
      ruleType: "unrealized_pnl",
      symbol: "MSFT.US",
      threshold: 0.06,
      hysteresis: 0.01,
      direction: "up",
      frequency: "continuous"
    });
    const runtime = makeRuntime({
      ruleId: "rule_pnl_up",
      armed: false,
      lastValue: { lastPrice: 107, history: [], armedDirection: "up" }
    });

    // -20%: old code computed abs(-0.20) = 0.20 > rearmBand (0.05), so it
    // would stay skip:disarmed forever. A 'up'-only rule can never have an
    // opposite-direction breach (directionMatches gates it out), so this
    // must go through the signed rearm path instead.
    const rearmResult = evaluateRule(upRule, runtime, pnlSample(80), 0);
    expect(rearmResult.decision).toBe("skip");
    expect(rearmResult.reason).toBe("rearmed");
    expect(rearmResult.newRuntime.armed).toBe(true);

    // And it's usable again: a fresh climb back past threshold fires.
    const refireResult = evaluateRule(upRule, rearmResult.newRuntime, pnlSample(108), 0);
    expect(refireResult.decision).toBe("fire");
    expect(refireResult.newRuntime.lastValue.armedDirection).toBe("up");
  });

  it("legacy runtime without a recorded armedDirection falls back to the original unsigned rearm check", () => {
    // Simulates a disarmed row persisted before this field existed.
    const runtime = makeRuntime({
      ruleId: "rule_pnl_both",
      armed: false,
      lastValue: { lastPrice: 108, history: [] } // no armedDirection key at all
    });

    const result = evaluateRule(bothRule, runtime, pnlSample(80), 0); // -20%

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("disarmed"); // abs(-0.20) > rearmBand(0.05), same as pre-fix behavior
    expect(result.newRuntime.armed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// spike_5m (continuous + 60min cooldown + liquidity precondition + bounded
// window)
//
// History points are `{ p, v, t, d }` (t = epoch ms, d = tradingDay). Unless
// a test is deliberately exercising staleness, fixtures below space history
// points 15/10/5 minutes before the sample's default atIso (2026-07-01
// 14:30Z) on the sample's default tradingDay ("2026-07-01"), which is well
// within SPIKE_WINDOW_MAX_MS (16 min) - i.e. what a real 5-minute poll
// cadence would look like.
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

  const DEFAULT_NOW_ISO = "2026-07-01T14:30:00.000Z";
  const DEFAULT_DAY = "2026-07-01";

  function historyPoint(p: number, v: number, minutesAgo: number, day = DEFAULT_DAY, nowIso = DEFAULT_NOW_ISO) {
    return { p, v, t: new Date(nowIso).getTime() - minutesAgo * 60 * 1000, d: day };
  }

  it("skips with 'insufficient_history' until 3 prior samples have accumulated", () => {
    const runtime = makeRuntime({ ruleId: "rule_spike" });
    const sample = makeSample({ quotes: { "TSLA.US": { price: 200, prevClose: 200, volume: 1000 } } });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("insufficient_history");
    expect(result.newRuntime.lastValue.history).toEqual([
      { p: 200, v: 1000, t: new Date(DEFAULT_NOW_ISO).getTime(), d: DEFAULT_DAY }
    ]);
  });

  it("fires once 3 prior samples exist, the move vs. 3-samples-ago exceeds threshold, and all 3 had volume", () => {
    const runtime = makeRuntime({
      ruleId: "rule_spike",
      lastValue: {
        lastPrice: 202,
        history: [historyPoint(200, 1000, 15), historyPoint(201, 1000, 10), historyPoint(202, 1000, 5)]
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
      historyPoint(201, 1000, 10),
      historyPoint(202, 1000, 5),
      { p: 210, v: 1000, t: new Date(DEFAULT_NOW_ISO).getTime(), d: DEFAULT_DAY }
    ]);
  });

  it("does NOT fire when one of the 3 history points has zero volume (low-volume spurious spike)", () => {
    const runtime = makeRuntime({
      ruleId: "rule_spike",
      lastValue: {
        lastPrice: 202,
        history: [historyPoint(200, 1000, 15), historyPoint(201, 0, 10), historyPoint(202, 1000, 5)]
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
        history: [historyPoint(200, 1000, 15), historyPoint(200, 1000, 10), historyPoint(200, 1000, 5)]
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
        history: [historyPoint(200, 1000, 15), historyPoint(201, 1000, 10), historyPoint(202, 1000, 5)]
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
        history: [historyPoint(200, 1000, 15), historyPoint(201, 1000, 10), historyPoint(202, 1000, 5)]
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
    const history = [historyPoint(200, 1000, 15), historyPoint(201, 1000, 10), historyPoint(202, 1000, 5)];
    const runtime = makeRuntime({
      ruleId: "rule_spike",
      lastValue: { lastPrice: 202, history }
    });
    const sample = makeSample({ quotes: {} }); // TSLA.US quote missing this tick

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("no_data");
    // The window must be left exactly as it was, not padded with a garbage
    // {p: undefined, v: undefined} entry that would corrupt future windows.
    expect(result.newRuntime.lastValue.history).toEqual(history);
  });

  it("is blocked by quota and leaves cooldown_until untouched", () => {
    const runtime = makeRuntime({
      ruleId: "rule_spike",
      lastValue: {
        lastPrice: 202,
        history: [historyPoint(200, 1000, 15), historyPoint(201, 1000, 10), historyPoint(202, 1000, 5)]
      }
    });
    const sample = makeSample({ quotes: { "TSLA.US": { price: 210, prevClose: 200, volume: 1000 } } });

    const result = evaluateRule(rule, runtime, sample, 30);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("quota");
    expect(result.newRuntime.cooldownUntil).toBeNull();
  });

  // I1 (Important, whole-branch-review finding): evaluateSpike used to gate
  // purely on Math.abs(rawValue) >= threshold, never consulting
  // rule.direction - even though the CLI accepts/stores/echoes back
  // --direction for every rule type including spike_5m. A down-spike would
  // silently fire an up-only rule. Route through the same directionMatches
  // gate daily_move/unrealized_pnl already use.
  it("direction 'up': does not fire on a down-spike even past threshold magnitude", () => {
    const upRule = { ...rule, direction: "up" };
    const runtime = makeRuntime({
      ruleId: "rule_spike",
      lastValue: {
        lastPrice: 208,
        history: [historyPoint(210, 1000, 15), historyPoint(209, 1000, 10), historyPoint(208, 1000, 5)]
      }
    });
    // vs. 3-samples-ago reference (210): 200/210 - 1 ~= -4.76%, well past the
    // 2.5% threshold in magnitude, but it's a DOWN move on an 'up'-only rule.
    const sample = makeSample({ quotes: { "TSLA.US": { price: 200, prevClose: 200, volume: 1000 } } });

    const result = evaluateRule(upRule, runtime, sample, 0);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("below_threshold");
  });

  it("direction 'down': fires on a down-spike of matching magnitude", () => {
    const downRule = { ...rule, direction: "down" };
    const runtime = makeRuntime({
      ruleId: "rule_spike",
      lastValue: {
        lastPrice: 208,
        history: [historyPoint(210, 1000, 15), historyPoint(209, 1000, 10), historyPoint(208, 1000, 5)]
      }
    });
    const sample = makeSample({ quotes: { "TSLA.US": { price: 200, prevClose: 200, volume: 1000 } } });

    const result = evaluateRule(downRule, runtime, sample, 0);

    expect(result.decision).toBe("fire");
    expect(result.reason).toBe("spike_5m");
    expect(result.value).toBeCloseTo(200 / 210 - 1);
  });

  it("direction 'down': does not fire on an up-spike of matching magnitude", () => {
    const downRule = { ...rule, direction: "down" };
    const runtime = makeRuntime({
      ruleId: "rule_spike",
      lastValue: {
        lastPrice: 202,
        history: [historyPoint(200, 1000, 15), historyPoint(201, 1000, 10), historyPoint(202, 1000, 5)]
      }
    });
    const sample = makeSample({ quotes: { "TSLA.US": { price: 210, prevClose: 200, volume: 1000 } } });

    const result = evaluateRule(downRule, runtime, sample, 0);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("below_threshold");
  });

  // -------------------------------------------------------------------------
  // Finding 1 fix: bounded window - never fire off a stale baseline.
  // -------------------------------------------------------------------------

  it("skips with 'stale_window' and rebuilds when the retained window is older than the staleness bound (same trading day, but a poller gap)", () => {
    // Oldest point is 45 minutes old - same trading day, but well past
    // SPIKE_WINDOW_MAX_MS (16 min), e.g. a poller that missed several cycles.
    const runtime = makeRuntime({
      ruleId: "rule_spike",
      lastValue: {
        lastPrice: 202,
        history: [historyPoint(200, 1000, 45), historyPoint(201, 1000, 40), historyPoint(202, 1000, 35)]
      }
    });
    const sample = makeSample({ quotes: { "TSLA.US": { price: 210, prevClose: 200, volume: 1000 } } });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("stale_window");
    expect(result.value).toBeNull();
    // Rebuilt from scratch: this sample becomes the sole seed, exactly like a
    // fresh start (the next 2 ticks will report insufficient_history again).
    expect(result.newRuntime.lastValue.history).toEqual([
      { p: 210, v: 1000, t: new Date(DEFAULT_NOW_ISO).getTime(), d: DEFAULT_DAY }
    ]);
  });

  it("skips with 'stale_window' when the retained window's trading day differs from the current sample's, even if the time gap is short (overnight gap)", () => {
    // Only ~10 minutes of wall-clock time (within the staleness bound), but
    // the retained points are tagged with yesterday's trading day - an
    // overnight gap shorter than the staleness bound must still not fire.
    const runtime = makeRuntime({
      ruleId: "rule_spike",
      lastValue: {
        lastPrice: 202,
        history: [
          historyPoint(200, 1000, 10, "2026-06-30", "2026-07-01T00:05:00.000Z"),
          historyPoint(201, 1000, 7, "2026-06-30", "2026-07-01T00:05:00.000Z"),
          historyPoint(202, 1000, 4, "2026-06-30", "2026-07-01T00:05:00.000Z")
        ]
      }
    });
    const sample = makeSample({
      atIso: "2026-07-01T00:05:00.000Z",
      tradingDay: "2026-07-01",
      quotes: { "TSLA.US": { price: 210, prevClose: 200, volume: 1000 } }
    });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("stale_window");
    expect(result.newRuntime.lastValue.history).toEqual([
      { p: 210, v: 1000, t: new Date("2026-07-01T00:05:00.000Z").getTime(), d: "2026-07-01" }
    ]);
  });

  it("regression: does not fire a bogus spike comparing today's price against a stale prior-day baseline (the exact day-2 replay bug)", () => {
    // TSLA.US 245 -> 246 (+0.4%) is the real move, but the retained window's
    // oldest point is a ~24h-old prior-day sample at 222 - comparing against
    // it would read as +10.8%, clearing the 2% threshold. Must not fire.
    const runtime = makeRuntime({
      ruleId: "rule_spike",
      lastValue: {
        lastPrice: 245,
        history: [
          historyPoint(222, 1000, 1445, "2026-07-01", "2026-07-02T13:30:00.000Z"), // day 1, 24h05m ago
          historyPoint(230, 1000, 1420, "2026-07-01", "2026-07-02T13:30:00.000Z"),
          historyPoint(245, 1000, 1400, "2026-07-01", "2026-07-02T13:30:00.000Z")
        ]
      }
    });
    const sample = makeSample({
      atIso: "2026-07-02T13:30:00.000Z",
      tradingDay: "2026-07-02",
      quotes: { "TSLA.US": { price: 246, prevClose: 200, volume: 1000 } }
    });

    const result = evaluateRule(rule, runtime, sample, 0);

    expect(result.decision).toBe("skip");
    expect(result.reason).toBe("stale_window");
  });
});

// ---------------------------------------------------------------------------
// exposure (continuous + 1% hysteresis)
//
// Known limitation, inherited on purpose (not fixed here): sample.exposure
// comes from portfolio-exposure.mjs's computeExposure, which treats
// netAssets <= 0 as exposureRatio 0 rather than an error - so if net assets
// ever reads as zero/negative while real market value is still held, this
// rule sees exposureRatio 0 and will never fire, a false negative it
// silently inherits. The engine consumes exposureRatio exactly as given;
// see portfolio-exposure.mjs's module doc comment for the full rationale.
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

  const exposureRule = makeRule({
    id: "replay_exposure",
    ownerId: "m5",
    symbol: "PORTFOLIO",
    ruleType: "exposure",
    threshold: 0.1,
    hysteresis: 0.01,
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

  const rules = [dailyMoveRule, pnlRule, spikeRule, exposureRule, ...quotaRules];

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
    exposureRatio?: number | null;
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
    // --- t7: 5 minutes later (realistic poll cadence - still within the
    // spike window's staleness bound), TSLA jumps again (vs. 3-samples-ago)
    // past threshold, but the 60-minute cooldown from t6 is still active.
    {
      label: "t7_tsla_cooldown_blocks",
      atIso: "2026-07-01T14:05:00.000Z",
      tradingDay: day1,
      quotes: buildQuotes({
        "AAPL.US": { price: 108, prevClose: 100, volume: 1000 },
        "MSFT.US": { price: 108, prevClose: 100, volume: 1000 },
        "TSLA.US": { price: 245, prevClose: 200, volume: 1000 }
      })
    },
    // --- t8: day2 open. AAPL gaps up again -> once_daily resets, fires.
    // The 31 quota rules gap up again -> quota must have reset to 0 for the
    // new trading day (30 fire, the 31st is trimmed again). TSLA's spike
    // window is the FINDING 1 regression case: 246 is only +0.4% vs. the
    // real prior sample (245 at t7), but the retained window's oldest point
    // is a ~24h-old prior-day sample (222 from t5) - must skip:stale_window,
    // not fire off that stale baseline. Exposure ramp also starts here at a
    // below-threshold baseline (0.08).
    {
      label: "t8_day2_open",
      atIso: "2026-07-02T13:30:00.000Z",
      tradingDay: day2,
      quotes: buildQuotes({
        "AAPL.US": { price: 106, prevClose: 100, volume: 1000 },
        "MSFT.US": { price: 108, prevClose: 100, volume: 1000 },
        "TSLA.US": { price: 246, prevClose: 200, volume: 1000 },
        ...Object.fromEntries(quotaRules.map((r) => [r.symbol, { price: 111, prevClose: 100, volume: 1000 }]))
      }),
      exposureRatio: 0.08
    },
    // --- t9: FINDING 2/3 - MSFT gaps down hard in a single sample, from
    // +8% (still nominally "disarmed" from the earlier up-side fire) to
    // -7%: a whipsaw crossing the whole band in one sample. Under the old
    // unsigned-armed-bit logic this was swallowed as skip:disarmed; it must
    // now fire as a distinct opposite-direction event. This is also the
    // real 急跌 (downside move) the replay was missing. Exposure ramps to
    // 0.105 -> fires, disarms.
    {
      label: "t9_msft_whipsaw_down_fires",
      atIso: "2026-07-02T13:35:00.000Z",
      tradingDay: day2,
      quotes: buildQuotes({
        "AAPL.US": { price: 106, prevClose: 100, volume: 1000 },
        "MSFT.US": { price: 93, prevClose: 100, volume: 1000 },
        "TSLA.US": { price: 246, prevClose: 200, volume: 1000 },
        ...Object.fromEntries(quotaRules.map((r) => [r.symbol, { price: 111, prevClose: 100, volume: 1000 }]))
      }),
      exposureRatio: 0.105
    },
    // --- t10: MSFT recovers most of the way back (-2%), inside the rearm
    // band on the down side -> re-arms (no fire). Exposure eases to 0.10:
    // still above the rearm band (0.09) -> stays disarmed, no fire.
    {
      label: "t10_msft_rearms_down",
      atIso: "2026-07-02T13:40:00.000Z",
      tradingDay: day2,
      quotes: buildQuotes({
        "AAPL.US": { price: 106, prevClose: 100, volume: 1000 },
        "MSFT.US": { price: 98, prevClose: 100, volume: 1000 },
        "TSLA.US": { price: 246, prevClose: 200, volume: 1000 },
        ...Object.fromEntries(quotaRules.map((r) => [r.symbol, { price: 111, prevClose: 100, volume: 1000 }]))
      }),
      exposureRatio: 0.1
    },
    // --- t11: MSFT drops hard again to -10%, now armed -> fires downward a
    // second time (proves the signed re-arm doesn't get permanently stuck,
    // the Finding 2(ii) fix, mirrored on the down side). Exposure eases
    // further to 0.089, at/under the rearm band -> re-arms (no fire).
    {
      label: "t11_msft_fires_down_again",
      atIso: "2026-07-02T13:45:00.000Z",
      tradingDay: day2,
      quotes: buildQuotes({
        "AAPL.US": { price: 106, prevClose: 100, volume: 1000 },
        "MSFT.US": { price: 90, prevClose: 100, volume: 1000 },
        "TSLA.US": { price: 246, prevClose: 200, volume: 1000 },
        ...Object.fromEntries(quotaRules.map((r) => [r.symbol, { price: 111, prevClose: 100, volume: 1000 }]))
      }),
      exposureRatio: 0.089
    },
    // --- t12: MSFT holds steady at -10% (already disarmed by t11's fire,
    // stays disarmed - no opposite breach, no rearm). Exposure climbs back
    // to 0.11 -> fires again (completing the ramp: fire -> disarm -> still
    // disarmed -> re-arm -> fire again).
    {
      label: "t12_exposure_fires_again",
      atIso: "2026-07-02T13:50:00.000Z",
      tradingDay: day2,
      quotes: buildQuotes({
        "AAPL.US": { price: 106, prevClose: 100, volume: 1000 },
        "MSFT.US": { price: 90, prevClose: 100, volume: 1000 },
        "TSLA.US": { price: 246, prevClose: 200, volume: 1000 },
        ...Object.fromEntries(quotaRules.map((r) => [r.symbol, { price: 111, prevClose: 100, volume: 1000 }]))
      }),
      exposureRatio: 0.11
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

      const exposureRatio = tick.exposureRatio ?? null;
      const sample = {
        atIso: tick.atIso,
        tradingDay: tick.tradingDay,
        quotes: tick.quotes,
        positions: { "MSFT.US": msftPosition },
        exposure: { exposureRatio, overBudget: exposureRatio !== null && exposureRatio > 0.1 }
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

    // --- FINDING 1 (critical, TDD red first): day-2's first tick has TSLA at
    // 246, a +0.4% move vs. the real prior sample (245 at t7). But `history`
    // counts samples, not time, and is never reset across a trading-day
    // boundary: at this point in the replay the retained window's oldest
    // point is still the one recorded at t5 (13:55 on day 1, price 222) - a
    // ~24h-old baseline from the previous day. Comparing 246 against that
    // stale 222 yields +10.8%, clearing the 2% threshold, so this currently
    // (pre-fix) fires a bogus "5 分钟急涨" alert on a tick that barely moved.
    // Must be a bounded-window skip instead, never a fire off a stale
    // baseline.
    expect(outcome("t8_day2_open", "replay_spike")).toBe("skip:stale_window");

    // --- FINDING 2/3: pnl whipsaw - a real downside move (急跌), a
    // same-sample band-crossing fire while nominally disarmed, and a
    // signed re-arm + refire on the down side ---
    expect(outcome("t8_day2_open", "replay_pnl")).toBe("skip:disarmed"); // still +8%, elevated from the day-1 up-fire
    expect(outcome("t9_msft_whipsaw_down_fires", "replay_pnl")).toBe("fire:unrealized_pnl"); // opposite-direction breach
    expect(outcome("t10_msft_rearms_down", "replay_pnl")).toBe("skip:rearmed");
    expect(outcome("t11_msft_fires_down_again", "replay_pnl")).toBe("fire:unrealized_pnl"); // re-armed, fires down again
    expect(outcome("t12_exposure_fires_again", "replay_pnl")).toBe("skip:disarmed");

    // --- FINDING 3: exposure ramp - fire -> disarm -> still disarmed ->
    // re-arm -> fire again ---
    expect(outcome("t8_day2_open", "replay_exposure")).toBe("skip:below_threshold"); // 0.08, baseline
    expect(outcome("t9_msft_whipsaw_down_fires", "replay_exposure")).toBe("fire:exposure"); // 0.105
    expect(outcome("t10_msft_rearms_down", "replay_exposure")).toBe("skip:disarmed"); // 0.10, still elevated
    expect(outcome("t11_msft_fires_down_again", "replay_exposure")).toBe("skip:rearmed"); // 0.089
    expect(outcome("t12_exposure_fires_again", "replay_exposure")).toBe("fire:exposure"); // 0.11

    // --- FINDING 4: exhaustive assertion. The spot checks above are
    // readable documentation of the scenarios, but they can't catch an
    // unexpected fire/skip on a (tick, ruleId) pair nobody thought to assert
    // on (exactly how the day-2 spike bug slipped through originally). Pin
    // the complete timeline - any change to any rule's decision on any tick
    // fails this immediately.
    expect(timeline).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Finding 5(a): rule.frequency must agree with the rule type's inherent
// cadence. It's currently a dead column (semantics are hardcoded by
// ruleType), so a contradiction is a config bug - fail loud rather than
// silently misinterpreting the rule.
// ---------------------------------------------------------------------------

describe("evaluateRule: frequency validation", () => {
  it("throws when a daily_move rule's frequency isn't 'once_daily'", () => {
    const rule = makeRule({ ruleType: "daily_move", frequency: "continuous" });
    const sample = makeSample({ quotes: { "AAPL.US": { price: 100, prevClose: 100, volume: 1000 } } });

    expect(() => evaluateRule(rule, makeRuntime(), sample, 0)).toThrow(/frequency/i);
  });

  it("throws when a continuous-cadence rule's frequency isn't 'continuous'", () => {
    const rule = makeRule({
      ruleType: "unrealized_pnl",
      symbol: "MSFT.US",
      threshold: 0.06,
      hysteresis: 0.01,
      frequency: "once_daily"
    });
    const sample = makeSample({
      quotes: { "MSFT.US": { price: 107, prevClose: 100, volume: 1000 } },
      positions: { "MSFT.US": { quantity: 10, costPrice: 100, marketValue: 1070 } }
    });

    expect(() => evaluateRule(rule, makeRuntime(), sample, 0)).toThrow(/frequency/i);
  });

  it("does not throw when frequency matches the rule type", () => {
    const rule = makeRule({ ruleType: "daily_move", frequency: "once_daily" });
    const sample = makeSample({ quotes: { "AAPL.US": { price: 100, prevClose: 100, volume: 1000 } } });

    expect(() => evaluateRule(rule, makeRuntime(), sample, 0)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Finding 5(b): evaluateAll must validate sample.atIso up front. Previously
// an invalid atIso would surface as a raw RangeError deep inside a specific
// rule's evaluation (e.g. `new Date(NaN).toISOString()` in the spike
// cooldown calculation), aborting the whole batch with a confusing error
// that didn't name the offending value.
// ---------------------------------------------------------------------------

describe("evaluateAll: sample.atIso validation", () => {
  const rule = makeRule({ ruleType: "daily_move", threshold: 0.04 });

  it("throws a clear error naming the bad value when atIso is not a valid date string", () => {
    const sample = makeSample({ atIso: "not-a-date", quotes: { "AAPL.US": { price: 105, prevClose: 100, volume: 1000 } } });

    expect(() => evaluateAll([rule], {}, sample, {})).toThrow(/invalid sample\.atIso.*not-a-date/i);
  });

  it("throws when atIso is missing", () => {
    const sample = makeSample({ quotes: { "AAPL.US": { price: 105, prevClose: 100, volume: 1000 } } });
    delete (sample as { atIso?: string }).atIso;

    expect(() => evaluateAll([rule], {}, sample, {})).toThrow(/invalid sample\.atIso/i);
  });

  it("does not throw for a valid atIso", () => {
    const sample = makeSample({ quotes: { "AAPL.US": { price: 105, prevClose: 100, volume: 1000 } } });

    expect(() => evaluateAll([rule], {}, sample, {})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Task P2-4: market-alerts.mjs (the rule-management CLI) imports these two
// maps as its single source of truth for per-type default thresholds and the
// rule_type -> frequency mapping, instead of re-declaring them. Pinning their
// values here so a change to either is a deliberate, visible edit.
// ---------------------------------------------------------------------------

describe("DEFAULT_THRESHOLDS / RULE_TYPE_FREQUENCY (consumed by market-alerts.mjs)", () => {
  it("exposes the per-type default thresholds from the brief", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      daily_move: 0.04,
      unrealized_pnl: 0.06,
      spike_5m: 0.025,
      exposure: 0.1
    });
  });

  it("exposes the rule_type -> frequency mapping", () => {
    expect(RULE_TYPE_FREQUENCY).toEqual({
      daily_move: "once_daily",
      unrealized_pnl: "continuous",
      spike_5m: "continuous",
      exposure: "continuous"
    });
  });
});

// ---------------------------------------------------------------------------
// C1 (CRITICAL, whole-branch-review finding): the spec's per-type hysteresis
// (滞回) values pinned here as the single source of truth market-alerts.mjs
// (the CLI) must consume instead of hardcoding hysteresis: 0. daily_move and
// spike_5m have no hysteresis by spec design (once-daily / cooldown gate
// them instead); unrealized_pnl and exposure have NO other anti-flap
// mechanism, so 0 there means zero anti-flap protection in production.
// ---------------------------------------------------------------------------

describe("DEFAULT_HYSTERESIS (consumed by market-alerts.mjs's runAdd)", () => {
  it("exposes the per-type default hysteresis from the spec", () => {
    expect(DEFAULT_HYSTERESIS).toEqual({
      daily_move: 0,
      unrealized_pnl: 0.01,
      spike_5m: 0,
      exposure: 0.01
    });
  });
});
