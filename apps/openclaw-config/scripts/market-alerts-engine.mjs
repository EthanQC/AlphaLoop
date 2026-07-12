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
//       lastValue: { lastPrice: number|null, history: Array<{ p: number, v: number }> } }
//
//     Per the binding design decision (see task-p2-3-brief.md): the DDL's
//     alert_runtime_state.last_value column (declared REAL) is repurposed by
//     the store layer to hold a JSON string `{"lastPrice":...,"history":[...]}`
//     instead of a bare number - SQLite's dynamic typing allows a TEXT value
//     in a REAL column. The engine only ever sees the decoded object; JSON
//     encode/decode is entirely the store's job.
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

/**
 * Evaluate a single alert rule against one sample.
 * @param {object} rule
 * @param {object|undefined|null} runtime
 * @param {object} sample
 * @param {number} [quota] current fired_count for (rule.ownerId, sample.tradingDay) BEFORE this call
 */
export function evaluateRule(rule, runtime, sample, quota = 0) {
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

  if (runtime.armed) {
    if (!directionMatches(rule.direction, rawValue, rule.threshold)) {
      return { decision: "skip", reason: "below_threshold", value: rawValue, newRuntime: baseRuntime, quotaDelta: 0 };
    }
    if (quota >= QUOTA_LIMIT) {
      // Quota-blocked: leave `armed` untouched (do not silently disarm an
      // alert the user was never actually shown).
      return { decision: "skip", reason: "quota", value: rawValue, newRuntime: baseRuntime, quotaDelta: 0 };
    }
    return {
      decision: "fire",
      reason: "unrealized_pnl",
      value: rawValue,
      newRuntime: { ...baseRuntime, armed: false },
      quotaDelta: 1
    };
  }

  if (Math.abs(rawValue) <= rearmBand) {
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
    // with a garbage {p, v} entry - leave state untouched and wait for the
    // next valid sample.
    return { decision: "skip", reason: "no_data", value: null, newRuntime: runtime, quotaDelta: 0 };
  }

  // The window used for THIS evaluation is whatever accumulated from prior
  // ticks (up to the 3 most recent samples strictly before this one) - it is
  // only updated with the current sample afterwards, for the NEXT call.
  const priorHistory = runtime.lastValue.history;
  const nextHistory = [...priorHistory, { p: price, v: volume }].slice(-SPIKE_HISTORY_SIZE);
  const withPrice = withLastPrice(runtime, price);
  const baseRuntime = { ...withPrice, lastValue: { ...withPrice.lastValue, history: nextHistory } };

  if (priorHistory.length < SPIKE_HISTORY_SIZE) {
    return { decision: "skip", reason: "insufficient_history", value: null, newRuntime: baseRuntime, quotaDelta: 0 };
  }

  const referencePrice = priorHistory[0].p;
  if (!Number.isFinite(referencePrice) || referencePrice === 0) {
    return { decision: "skip", reason: "no_data", value: null, newRuntime: baseRuntime, quotaDelta: 0 };
  }

  const rawValue = price / referencePrice - 1;
  const now = new Date(sample.atIso).getTime();
  const cooldownUntilMs = runtime.cooldownUntil ? new Date(runtime.cooldownUntil).getTime() : null;
  const cooldownActive = cooldownUntilMs !== null && cooldownUntilMs >= now;
  const volumesOk = priorHistory.every((point) => Number.isFinite(point.v) && point.v > 0);
  const thresholdOk = Math.abs(rawValue) >= rule.threshold;

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

function normalizeRuntime(ruleId, runtime) {
  if (!runtime) {
    return {
      ruleId,
      armed: true,
      cooldownUntil: null,
      lastFiredTradingDay: null,
      lastValue: { lastPrice: null, history: [] }
    };
  }

  return {
    ruleId,
    armed: runtime.armed !== false,
    cooldownUntil: runtime.cooldownUntil ?? null,
    lastFiredTradingDay: runtime.lastFiredTradingDay ?? null,
    lastValue: {
      lastPrice: runtime.lastValue?.lastPrice ?? null,
      history: Array.isArray(runtime.lastValue?.history) ? runtime.lastValue.history : []
    }
  };
}

function withLastPrice(runtime, price) {
  if (!Number.isFinite(price)) {
    return runtime;
  }
  return { ...runtime, lastValue: { ...runtime.lastValue, lastPrice: price } };
}
