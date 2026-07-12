// Alert evaluation engine — pure functions, zero IO, fully deterministic.
//
// The engine never reads the clock or touches the filesystem/network/db: all
// time-dependent behavior (cooldowns, once-daily gating) is driven by the
// `sample.atIso` / `sample.tradingDay` fields the caller supplies, so a given
// (rule, runtime, sample, quota) tuple always produces the same result. This
// is what makes the replay test in market-alerts-engine.test.ts possible.
//
// Shapes (all plain JSON-serializable objects):
//
//   sample = {
//     atIso: string,              // ISO instant this sample was taken
//     tradingDay: string,         // from trading-schedule.mjs currentUsEasternTradingDay
//     quotes: { [symbol]: { price, prevClose, volume } },
//     positions: { [symbol]: { quantity, costPrice, marketValue } },
//     exposure: { exposureRatio: number|null, overBudget: boolean }  // from portfolio-exposure.mjs
//   }
//
//   rule = alert_rules row, camelCase'd:
//     { id, ownerId, symbol, ruleType, threshold, direction, frequency, hysteresis, enabled, createdAt }
//
//   runtime = alert_runtime_state row, camelCase'd, with last_value decoded:
//     { ruleId, armed: boolean, cooldownUntil: string|null, lastFiredTradingDay: string|null,
//       lastValue: {
//         lastPrice: number|null,
//         history: Array<{ p: number, v: number, t: number, d: string }>,
//         armedDirection: 'up'|'down'|null
//       } }
//
//     Per the binding design decision (see task-p2-3-brief.md): the DDL's
//     alert_runtime_state.last_value column (declared REAL) is repurposed by
//     the store layer to hold a JSON string `{"lastPrice":...,"history":[...],"armedDirection":...}`
//     instead of a bare number - SQLite's dynamic typing allows a TEXT value
//     in a REAL column. The engine only ever sees the decoded object; JSON
//     encode/decode is entirely the store's job. Both `history[].t`/`.d` and
//     `armedDirection` are new fields added by task-p2-3 fixes (see below);
//     no DDL change was made or is needed - they live inside this same
//     free-form JSON blob.
//
// Return shape of evaluateRule:
//   { decision: 'fire'|'skip', reason: string, value: number|null, newRuntime, quotaDelta: 0|1 }
//
// Return shape of evaluateAll:
//   { fires, skips, results, newRuntimes, newQuotas }
//   - results: one entry per input rule, `{ ruleId, ownerId, symbol, ruleType, decision, reason, value, triggeredAt }`
//   - fires / skips: results filtered by decision (fires ⊆ results, skips ⊆ results) -
//     the brief only names `fires`; `skips`/`results` are an additive, non-breaking
//     extension so callers (and the replay test) can assert full timelines, not
//     just what fired.
//   - newRuntimes: Record<ruleId, runtime> for every rule that was evaluated
//   - newQuotas: Record<ownerId, number> - the running fired_count per owner,
//     already reflecting this batch's fires (caller/store still must persist it
//     via bumpQuota for the delta actually applied)

const QUOTA_LIMIT = 30;
const SPIKE_COOLDOWN_MS = 60 * 60 * 1000;
const SPIKE_HISTORY_SIZE = 3;

// Default `threshold` values per rule type, used by market-alerts.mjs (the
// rule-management CLI) when the operator doesn't pass an explicit
// `--threshold`. Exported from here (not re-declared in the CLI) because the
// engine is this system's single source of truth for what each rule type's
// threshold actually means (see the per-type evaluators below) - keeping the
// CLI's "sane default" in sync with that meaning belongs in one place.
export const DEFAULT_THRESHOLDS = {
  daily_move: 0.04,
  unrealized_pnl: 0.06,
  spike_5m: 0.025,
  exposure: 0.1
};

// Default `hysteresis` (滞回/anti-flap band) values per rule type, from the
// spec's Global Constraints (not to be changed). Exported from here for the
// same single-source-of-truth reason as DEFAULT_THRESHOLDS above: market-
// alerts.mjs's runAdd must consume this instead of hardcoding a value.
//
// daily_move and spike_5m have NO hysteresis by design - they use once-daily
// gating and a 60-minute cooldown (respectively) as their anti-flap
// mechanism instead. unrealized_pnl and exposure have no cooldown of any
// kind, so hysteresis is their ONLY anti-flap mechanism - a 0 here (as the
// CLI used to hardcode) means zero protection against a value wobbling
// across the threshold line.
//
// Hysteresis is an ABSOLUTE band (rearmBand = threshold - hysteresis), not a
// fraction of threshold, so a caller-supplied custom --threshold must NOT
// scale it: the type default below applies unchanged regardless of the
// rule's own threshold.
export const DEFAULT_HYSTERESIS = {
  daily_move: 0,
  unrealized_pnl: 0.01,
  spike_5m: 0,
  exposure: 0.01
};

// Sentinel `symbol` value for portfolio-level (rule_type 'exposure') fires,
// which are not about any one ticker. Exported from here (not re-declared in
// market-alerts.mjs the CLI, or market-alerts-cards.mjs the card renderer -
// both already import from this module) for the same single-source-of-truth
// reason as DEFAULT_THRESHOLDS above: two independent copies of the same
// string literal can silently drift.
export const EXPOSURE_SYMBOL = "*";

// spike_5m compares the current sample against the oldest of the 3 retained
// prior samples. At a steady 5-minute poll cadence that oldest point is
// normally ~15 minutes old (3 samples x 5 min). Bound the window so a stale
// baseline (poller restart, overnight gap, missed cycles) can never be used
// as the comparison point - 15 min base + 1 min slack for poll jitter.
const SPIKE_WINDOW_MAX_MS = 15 * 60 * 1000 + 60 * 1000;

// rule_type has an inherent, fixed cadence; `frequency` is user/config-facing
// but must agree with it. A mismatch is a config bug, not a runtime
// condition - fail loud rather than silently misinterpreting the rule.
// Exported so market-alerts.mjs can derive the correct `frequency` to store
// for a new rule from its `rule_type` alone, instead of re-declaring (and
// risking drifting from) this same mapping.
export const RULE_TYPE_FREQUENCY = {
  daily_move: "once_daily",
  unrealized_pnl: "continuous",
  spike_5m: "continuous",
  exposure: "continuous"
};

/**
 * Evaluate a single alert rule against one sample.
 * @param {object} rule
 * @param {object|undefined|null} runtime
 * @param {object} sample
 * @param {number} [quota] current fired_count for (rule.ownerId, sample.tradingDay) BEFORE this call
 */
export function evaluateRule(rule, runtime, sample, quota = 0) {
  assertFrequencyMatchesRuleType(rule);

  const rt = normalizeRuntime(rule.id, runtime);

  if (rule.enabled === false) {
    return { decision: "skip", reason: "disabled", value: null, newRuntime: rt, quotaDelta: 0 };
  }

  switch (rule.ruleType) {
    case "daily_move":
      return evaluateDailyMove(rule, rt, sample, quota);
    case "unrealized_pnl":
      return evaluateUnrealizedPnl(rule, rt, sample, quota);
    case "spike_5m":
      return evaluateSpike(rule, rt, sample, quota);
    case "exposure":
      return evaluateExposure(rule, rt, sample, quota);
    default:
      throw new Error(`Unsupported alert rule type: ${rule.ruleType}`);
  }
}

/**
 * Evaluate a batch of rules against one sample, threading a running
 * per-owner quota count across the batch so that e.g. rule #31 for the same
 * owner in the same tick is correctly trimmed even before any DB write
 * happens.
 * @param {object[]} rules
 * @param {Record<string, object>} runtimes keyed by rule.id
 * @param {object} sample
 * @param {Record<string, number>} quotaByOwner current fired_count per ownerId, already scoped to sample.tradingDay
 */
export function evaluateAll(rules, runtimes, sample, quotaByOwner) {
  assertValidAtIso(sample?.atIso);

  const newRuntimes = {};
  const newQuotas = { ...(quotaByOwner ?? {}) };
  const results = [];

  for (const rule of rules) {
    const runtime = runtimes ? runtimes[rule.id] : undefined;
    const quota = newQuotas[rule.ownerId] ?? 0;
    const outcome = evaluateRule(rule, runtime, sample, quota);
    newRuntimes[rule.id] = outcome.newRuntime;

    results.push({
      ruleId: rule.id,
      ownerId: rule.ownerId,
      symbol: rule.symbol,
      ruleType: rule.ruleType,
      decision: outcome.decision,
      reason: outcome.reason,
      value: outcome.value,
      triggeredAt: sample.atIso
    });

    if (outcome.decision === "fire") {
      newQuotas[rule.ownerId] = quota + outcome.quotaDelta;
    }
  }

  const fires = results.filter((r) => r.decision === "fire");
  const skips = results.filter((r) => r.decision === "skip");

  return { fires, skips, results, newRuntimes, newQuotas };
}

// ---------------------------------------------------------------------------
// Per rule-type evaluators
// ---------------------------------------------------------------------------

function evaluateDailyMove(rule, runtime, sample, quota) {
  const quote = sample.quotes?.[rule.symbol];
  const price = quote?.price;
  const prevClose = quote?.prevClose;
  const baseRuntime = withLastPrice(runtime, price);

  if (!Number.isFinite(price) || !Number.isFinite(prevClose) || prevClose === 0) {
    return { decision: "skip", reason: "no_data", value: null, newRuntime: baseRuntime, quotaDelta: 0 };
  }

  const rawValue = price / prevClose - 1;

  // daily_move is once-daily and has no armed bit (see evaluateUnrealizedPnl
  // for the signed-armed-direction logic) - `direction` here only gates
  // which sign of move is eligible to fire at all; there's no hysteresis or
  // re-arm state to keep signed, so it's left exactly as originally written.
  if (!directionMatches(rule.direction, rawValue, rule.threshold)) {
    return { decision: "skip", reason: "below_threshold", value: rawValue, newRuntime: baseRuntime, quotaDelta: 0 };
  }

  if (runtime.lastFiredTradingDay === sample.tradingDay) {
    return { decision: "skip", reason: "already_fired_today", value: rawValue, newRuntime: baseRuntime, quotaDelta: 0 };
  }

  if (quota >= QUOTA_LIMIT) {
    // Quota-blocked: do NOT consume the once-daily slot. The condition was
    // met but the user was never notified, so the rule must remain free to
    // fire later (same day if quota frees up, or the next trading day).
    return { decision: "skip", reason: "quota", value: rawValue, newRuntime: baseRuntime, quotaDelta: 0 };
  }

  return {
    decision: "fire",
    reason: "daily_move",
    value: rawValue,
    newRuntime: { ...baseRuntime, lastFiredTradingDay: sample.tradingDay },
    quotaDelta: 1
  };
}

function evaluateUnrealizedPnl(rule, runtime, sample, quota) {
  const quote = sample.quotes?.[rule.symbol];
  const position = sample.positions?.[rule.symbol];
  const price = quote?.price;
  const costPrice = position?.costPrice;
  const baseRuntime = withLastPrice(runtime, price);

  if (!Number.isFinite(price) || !Number.isFinite(costPrice) || costPrice === 0) {
    return { decision: "skip", reason: "no_data", value: null, newRuntime: baseRuntime, quotaDelta: 0 };
  }

  const rawValue = price / costPrice - 1;
  const rearmBand = rule.threshold - rule.hysteresis;
  const armedDirection = runtime.lastValue.armedDirection ?? null;

  if (runtime.armed) {
    if (!directionMatches(rule.direction, rawValue, rule.threshold)) {
      return { decision: "skip", reason: "below_threshold", value: rawValue, newRuntime: baseRuntime, quotaDelta: 0 };
    }
    if (quota >= QUOTA_LIMIT) {
      // Quota-blocked: leave `armed` (and armedDirection) untouched (do not
      // silently disarm an alert the user was never actually shown).
      return { decision: "skip", reason: "quota", value: rawValue, newRuntime: baseRuntime, quotaDelta: 0 };
    }
    const fireDirection = rawValue >= 0 ? "up" : "down";
    return {
      decision: "fire",
      reason: "unrealized_pnl",
      value: rawValue,
      newRuntime: {
        ...baseRuntime,
        armed: false,
        lastValue: { ...baseRuntime.lastValue, armedDirection: fireDirection }
      },
      quotaDelta: 1
    };
  }

  // Disarmed. The single unsigned armed bit used to lose information about
  // *which* side fired, which caused two bugs (see task-p2-3-report.md
  // Finding 2):
  //   (i) a whipsaw/gap crossing the whole band in one sample (fire up, then
  //       next sample far negative) was swallowed as skip:disarmed - it is
  //       actually a distinct, oppositely-directed breach and must fire.
  //   (ii) re-arm compared |value| to the rearm band, so a rule that fired
  //       upward stayed "disarmed" forever once price cratered deeply
  //       negative (a huge negative value has a huge absolute value too).
  // Recording `armedDirection` (the sign of the fire that disarmed us) lets
  // both be fixed: re-arm is now a signed comparison relative to that
  // direction, and a breach on the *opposite* side while still nominally
  // disarmed is treated as its own fire (and flips armedDirection).
  if (armedDirection === null) {
    // Legacy/unknown direction (disarmed runtime persisted before this field
    // existed, or before any fire recorded a direction). No signed history
    // to work with - fall back to the original unsigned rearm check rather
    // than guess a direction.
    if (Math.abs(rawValue) <= rearmBand) {
      return { decision: "skip", reason: "rearmed", value: rawValue, newRuntime: { ...baseRuntime, armed: true }, quotaDelta: 0 };
    }
    return { decision: "skip", reason: "disarmed", value: rawValue, newRuntime: baseRuntime, quotaDelta: 0 };
  }

  const oppositeDirection = armedDirection === "up" ? "down" : "up";
  const currentDirection = rawValue >= 0 ? "up" : "down";
  const oppositeBreach =
    directionMatches(rule.direction, rawValue, rule.threshold) && currentDirection === oppositeDirection;

  if (oppositeBreach) {
    if (quota >= QUOTA_LIMIT) {
      return { decision: "skip", reason: "quota", value: rawValue, newRuntime: baseRuntime, quotaDelta: 0 };
    }
    return {
      decision: "fire",
      reason: "unrealized_pnl",
      value: rawValue,
      newRuntime: {
        ...baseRuntime,
        armed: false,
        lastValue: { ...baseRuntime.lastValue, armedDirection: oppositeDirection }
      },
      quotaDelta: 1
    };
  }

  const rearmed = armedDirection === "down" ? rawValue >= -rearmBand : rawValue <= rearmBand;

  if (rearmed) {
    return { decision: "skip", reason: "rearmed", value: rawValue, newRuntime: { ...baseRuntime, armed: true }, quotaDelta: 0 };
  }

  return { decision: "skip", reason: "disarmed", value: rawValue, newRuntime: baseRuntime, quotaDelta: 0 };
}

function evaluateExposure(rule, runtime, sample, quota) {
  const exposureRatio = sample.exposure?.exposureRatio;
  const baseRuntime = runtime; // exposure has no natural "price"; lastValue passes through untouched

  if (exposureRatio === null || exposureRatio === undefined || !Number.isFinite(exposureRatio)) {
    return { decision: "skip", reason: "no_data", value: null, newRuntime: baseRuntime, quotaDelta: 0 };
  }

  const rearmBand = rule.threshold - rule.hysteresis;

  if (runtime.armed) {
    if (!(exposureRatio > rule.threshold)) {
      return { decision: "skip", reason: "below_threshold", value: exposureRatio, newRuntime: baseRuntime, quotaDelta: 0 };
    }
    if (quota >= QUOTA_LIMIT) {
      return { decision: "skip", reason: "quota", value: exposureRatio, newRuntime: baseRuntime, quotaDelta: 0 };
    }
    return {
      decision: "fire",
      reason: "exposure",
      value: exposureRatio,
      newRuntime: { ...baseRuntime, armed: false },
      quotaDelta: 1
    };
  }

  // Unlike unrealized_pnl, exposure is intentionally left with the original
  // unsigned re-arm check: exposureRatio is one-sided by nature (over-budget
  // only - it isn't a signed value that can breach a symmetric "down" side),
  // so there is no opposite-direction breach to detect and no direction to
  // record. This is the "leave exposure as is" case named in Finding 2.
  if (exposureRatio <= rearmBand) {
    return { decision: "skip", reason: "rearmed", value: exposureRatio, newRuntime: { ...baseRuntime, armed: true }, quotaDelta: 0 };
  }

  return { decision: "skip", reason: "disarmed", value: exposureRatio, newRuntime: baseRuntime, quotaDelta: 0 };
}

function evaluateSpike(rule, runtime, sample, quota) {
  const quote = sample.quotes?.[rule.symbol];
  const price = quote?.price;
  const volume = quote?.volume;

  if (!Number.isFinite(price) || !Number.isFinite(volume)) {
    // A missing/invalid quote must not corrupt the rolling history window
    // with a garbage {p, v, t, d} entry - leave state untouched and wait for
    // the next valid sample.
    return { decision: "skip", reason: "no_data", value: null, newRuntime: runtime, quotaDelta: 0 };
  }

  const now = new Date(sample.atIso).getTime();
  const priorHistory = runtime.lastValue.history;
  const withPrice = withLastPrice(runtime, price);
  const freshPoint = { p: price, v: volume, t: now, d: sample.tradingDay };

  if (priorHistory.length < SPIKE_HISTORY_SIZE) {
    // The window used for THIS evaluation is whatever accumulated from prior
    // ticks (up to the 3 most recent samples strictly before this one) - it
    // is only updated with the current sample afterwards, for the NEXT call.
    const nextHistory = [...priorHistory, freshPoint].slice(-SPIKE_HISTORY_SIZE);
    const baseRuntime = { ...withPrice, lastValue: { ...withPrice.lastValue, history: nextHistory } };
    return { decision: "skip", reason: "insufficient_history", value: null, newRuntime: baseRuntime, quotaDelta: 0 };
  }

  // Finding 1: `history` used to count samples, not time, and was persisted
  // across days unbounded - so a poller restart, an overnight gap, or a few
  // missed cycles could leave a many-hours-old (even prior trading day's)
  // sample as the comparison baseline. Comparing a fresh price against a
  // stale baseline produces a bogus "spike" out of an ordinary tick-to-tick
  // move. Guard both ways (belt and braces): the retained window is only a
  // valid baseline if ALL 3 points are within SPIKE_WINDOW_MAX_MS of now AND
  // share the current sample's trading day (a short overnight gap could pass
  // the time bound but must still not straddle a trading-day boundary).
  const windowFresh = priorHistory.every(
    (point) => Number.isFinite(point.t) && now - point.t <= SPIKE_WINDOW_MAX_MS && point.d === sample.tradingDay
  );

  if (!windowFresh) {
    // Never fire off a stale baseline: reset and rebuild the window from
    // fresh samples instead. This sample becomes the sole seed; the next 2
    // ticks will report insufficient_history again, exactly as if the
    // poller had just (re)started.
    const baseRuntime = { ...withPrice, lastValue: { ...withPrice.lastValue, history: [freshPoint] } };
    return { decision: "skip", reason: "stale_window", value: null, newRuntime: baseRuntime, quotaDelta: 0 };
  }

  const nextHistory = [...priorHistory, freshPoint].slice(-SPIKE_HISTORY_SIZE);
  const baseRuntime = { ...withPrice, lastValue: { ...withPrice.lastValue, history: nextHistory } };

  const referencePrice = priorHistory[0].p;
  if (!Number.isFinite(referencePrice) || referencePrice === 0) {
    return { decision: "skip", reason: "no_data", value: null, newRuntime: baseRuntime, quotaDelta: 0 };
  }

  const rawValue = price / referencePrice - 1;
  const cooldownUntilMs = runtime.cooldownUntil ? new Date(runtime.cooldownUntil).getTime() : null;
  const cooldownActive = cooldownUntilMs !== null && cooldownUntilMs >= now;
  const volumesOk = priorHistory.every((point) => Number.isFinite(point.v) && point.v > 0);
  // I1 fix (whole-branch-review finding): this used to be a bare
  // Math.abs(rawValue) >= threshold, never consulting rule.direction - even
  // though the CLI accepts/stores/echoes --direction for spike_5m same as
  // every other type. Route through the same directionMatches gate
  // daily_move/unrealized_pnl already use, so a down-spike can't fire an
  // up-only rule (and vice versa).
  const thresholdOk = directionMatches(rule.direction, rawValue, rule.threshold);

  if (cooldownActive) {
    return { decision: "skip", reason: "cooldown", value: rawValue, newRuntime: baseRuntime, quotaDelta: 0 };
  }
  if (!volumesOk) {
    return { decision: "skip", reason: "zero_volume", value: rawValue, newRuntime: baseRuntime, quotaDelta: 0 };
  }
  if (!thresholdOk) {
    return { decision: "skip", reason: "below_threshold", value: rawValue, newRuntime: baseRuntime, quotaDelta: 0 };
  }
  if (quota >= QUOTA_LIMIT) {
    // Quota-blocked: leave cooldown_until untouched, matching the other rule
    // types' "no silent side-effects on a fire the user never saw" policy.
    return { decision: "skip", reason: "quota", value: rawValue, newRuntime: baseRuntime, quotaDelta: 0 };
  }

  const cooldownUntil = new Date(now + SPIKE_COOLDOWN_MS).toISOString();
  return {
    decision: "fire",
    reason: "spike_5m",
    value: rawValue,
    newRuntime: { ...baseRuntime, cooldownUntil },
    quotaDelta: 1
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function directionMatches(direction, rawValue, threshold) {
  if (direction === "up") {
    return rawValue >= threshold;
  }
  if (direction === "down") {
    return rawValue <= -threshold;
  }
  return Math.abs(rawValue) >= threshold;
}

function assertFrequencyMatchesRuleType(rule) {
  const expected = RULE_TYPE_FREQUENCY[rule.ruleType];
  if (expected && rule.frequency !== expected) {
    throw new Error(
      `Alert rule ${rule.id} has ruleType '${rule.ruleType}' but frequency '${rule.frequency}' ` +
        `(expected '${expected}'). This is a config bug, not a runtime condition.`
    );
  }
}

function assertValidAtIso(atIso) {
  const parsed = new Date(atIso).getTime();
  if (!Number.isFinite(parsed)) {
    throw new Error(`evaluateAll: invalid sample.atIso: ${JSON.stringify(atIso)}`);
  }
}

function normalizeRuntime(ruleId, runtime) {
  if (!runtime) {
    return {
      ruleId,
      armed: true,
      cooldownUntil: null,
      lastFiredTradingDay: null,
      lastValue: { lastPrice: null, history: [], armedDirection: null }
    };
  }

  return {
    ruleId,
    armed: runtime.armed !== false,
    cooldownUntil: runtime.cooldownUntil ?? null,
    lastFiredTradingDay: runtime.lastFiredTradingDay ?? null,
    lastValue: {
      lastPrice: runtime.lastValue?.lastPrice ?? null,
      history: Array.isArray(runtime.lastValue?.history) ? runtime.lastValue.history : [],
      armedDirection: runtime.lastValue?.armedDirection ?? null
    }
  };
}

function withLastPrice(runtime, price) {
  if (!Number.isFinite(price)) {
    return runtime;
  }
  return { ...runtime, lastValue: { ...runtime.lastValue, lastPrice: price } };
}
