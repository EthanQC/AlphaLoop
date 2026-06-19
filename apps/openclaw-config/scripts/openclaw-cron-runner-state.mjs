export function normalizeRunnerState(value = {}) {
  return {
    processedRunKeys: uniqueStrings(value.processedRunKeys),
    failedRunAttempts: normalizeFailedRunAttempts(value.failedRunAttempts),
    alertedRunKeys: uniqueStrings(value.alertedRunKeys)
  };
}

export function shouldAttemptRun(state, runKey, nowMs = Date.now()) {
  const normalized = normalizeRunnerState(state);
  const key = String(runKey);
  if (normalized.processedRunKeys.includes(key)) {
    return false;
  }

  const failure = normalized.failedRunAttempts[key];
  if (!failure?.nextRetryAt) {
    return true;
  }
  const retryAtMs = Date.parse(failure.nextRetryAt);
  return !Number.isFinite(retryAtMs) || nowMs >= retryAtMs;
}

export function recordRunResult(state, runKey, result, nowMs = Date.now(), options = {}) {
  const normalized = normalizeRunnerState(state);
  const key = String(runKey);

  if (result?.ok) {
    normalized.processedRunKeys = pushUnique(normalized.processedRunKeys, key).slice(-limit(options.limit));
    delete normalized.failedRunAttempts[key];
    normalized.alertedRunKeys = normalized.alertedRunKeys.filter((value) => value !== key);
    return normalized;
  }

  const previous = normalized.failedRunAttempts[key];
  const attempts = Number(previous?.attempts ?? 0) + 1;
  const delayMs = retryDelayMs(attempts, options);
  normalized.failedRunAttempts[key] = {
    attempts,
    lastAttemptAt: new Date(nowMs).toISOString(),
    nextRetryAt: new Date(nowMs + delayMs).toISOString(),
    lastResultPath: stringOrUndefined(result?.resultPath ?? previous?.lastResultPath),
    lastError: stringOrUndefined(result?.error ?? result?.stderrTail ?? previous?.lastError)
  };
  return normalized;
}

export function shouldAlertFailure(state, runKey) {
  const normalized = normalizeRunnerState(state);
  return !normalized.alertedRunKeys.includes(String(runKey));
}

export function recordFailureAlerted(state, runKey, options = {}) {
  const normalized = normalizeRunnerState(state);
  normalized.alertedRunKeys = pushUnique(normalized.alertedRunKeys, String(runKey)).slice(-limit(options.limit));
  return normalized;
}

export function serializeRunnerState(state, options = {}) {
  const normalized = normalizeRunnerState(state);
  normalized.processedRunKeys = normalized.processedRunKeys.slice(-limit(options.limit));
  normalized.alertedRunKeys = normalized.alertedRunKeys.slice(-limit(options.limit));
  return normalized;
}

function retryDelayMs(attempts, options) {
  const base = Math.max(1, Number(options.retryBaseMs ?? 60_000));
  const max = Math.max(base, Number(options.retryMaxMs ?? 30 * 60_000));
  return Math.min(max, base * 2 ** Math.max(0, attempts - 1));
}

function normalizeFailedRunAttempts(value) {
  const entries = value && typeof value === "object" ? Object.entries(value) : [];
  return Object.fromEntries(entries.flatMap(([key, raw]) => {
    if (!raw || typeof raw !== "object") {
      return [];
    }
    const attempts = Math.max(0, Number(raw.attempts ?? 0));
    return [[String(key), {
      attempts,
      lastAttemptAt: stringOrUndefined(raw.lastAttemptAt),
      nextRetryAt: stringOrUndefined(raw.nextRetryAt),
      lastResultPath: stringOrUndefined(raw.lastResultPath),
      lastError: stringOrUndefined(raw.lastError)
    }]];
  }));
}

function uniqueStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean)));
}

function pushUnique(values, value) {
  return Array.from(new Set([...values, value].filter(Boolean)));
}

function stringOrUndefined(value) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function limit(value) {
  return Math.max(1, Number(value ?? 1000));
}
