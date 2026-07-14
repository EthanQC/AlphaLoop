#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { loadLocalEnv } from "../../../packages/shared-types/dist/index.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const runtimeRoot = join(repoRoot, "runtime");

loadLocalEnv(repoRoot);
mkdirSync(runtimeRoot, { recursive: true });

// Task H7 (2026-07-14 legacy audit): the quote lock is held across the
// WHOLE execFileSync call below (default CLI timeout 45s), but lockTtlMs
// used to be a fixed 10s - shorter than the timeout it's supposed to guard.
// A call running past 10s (slow network, not yet an actual failure) had its
// lock declared stale and stolen by a concurrent caller (market-alerts-poll,
// scheduled-report, stock-analysis, official-paper-monitor all share this
// same lock file), and the original caller's eventual release() then force-
// deleted the thief's lock, letting a THIRD caller in - cascading concurrent
// CLI calls that clobber the shared rate-limit state and can burst past
// Longbridge's real call-rate limit. Fix: derive the TTL from the actual CLI
// timeout (with a margin for the lock/IPC overhead around the call itself)
// instead of a hardcoded, independently-drifting constant - this also closes
// the same gap for `trade` (its previous 40_000 was likewise under the 45s
// default timeout, just not the specific case the audit named).
const LONGBRIDGE_CLI_TIMEOUT_MS = Number(process.env.LONGBRIDGE_CLI_TIMEOUT_MS ?? 45_000);
const LOCK_TTL_MARGIN_MS = 5_000;
const LOCK_TTL_MS = LONGBRIDGE_CLI_TIMEOUT_MS + LOCK_TTL_MARGIN_MS;

const LONG_BRIDGE_LIMITS = {
  quote: {
    windowMs: 1_000,
    maxCalls: 10,
    minIntervalMs: 100,
    lockTtlMs: LOCK_TTL_MS
  },
  trade: {
    windowMs: 30_000,
    maxCalls: 30,
    minIntervalMs: 20,
    lockTtlMs: LOCK_TTL_MS
  }
};

// Exported for testing the H7 "lock TTL must be >= the CLI timeout it
// guards" invariant directly (and for any future caller reasoning about the
// effective lock windows) without reaching into module internals.
export function getLongbridgeRateLimitConfig() {
  return LONG_BRIDGE_LIMITS;
}

export async function runLongbridgeJson(category, args) {
  const payload = parseLongbridgeJson(await runLongbridgeText(category, [...args, "--format", "json"]));
  if (args[0] === "check") {
    healLongbridgeRegionCacheFromCheck(payload);
  }
  return payload;
}

export async function runLongbridgeJsonWithRetry(category, args, options = {}) {
  const payload = parseLongbridgeJson(await runLongbridgeTextWithRetry(category, [...args, "--format", "json"], options));
  if (args[0] === "check") {
    healLongbridgeRegionCacheFromCheck(payload);
  }
  return payload;
}

export async function runLongbridgeTextWithRetry(category, args, options = {}) {
  const attempts = Math.max(1, Number(options.attempts ?? process.env.LONGBRIDGE_READ_RETRY_ATTEMPTS ?? 4));
  const label = options.label ?? `${category}:${args.join(" ")}`;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await runLongbridgeText(category, args);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientLongbridgeError(error)) {
        break;
      }

      await sleep(backoffMs(attempt));
      if (args[0] !== "check") {
        await healLongbridgeRegionCache(category);
      }
    }
  }

  throw new Error(`Longbridge 只读请求失败（${label}，已尝试 ${attempts} 次）：${sanitizeLongbridgeError(lastError)}`);
}

export async function runLongbridgeText(category, args) {
  const config = LONG_BRIDGE_LIMITS[category];
  if (!config) {
    throw new Error(`Unsupported Longbridge rate-limit category: ${category}`);
  }

  const statePath = join(runtimeRoot, `longbridge-rate-limit-${category}.json`);
  const lockPath = join(runtimeRoot, `longbridge-rate-limit-${category}.lock`);
  const release = await acquireLock(lockPath, config.lockTtlMs);

  try {
    await waitForWindow(statePath, config);
    const cli = resolveLongbridgeCli();
    return execFileSync(cli, args, {
      encoding: "utf8",
      env: buildLongbridgeCliEnv(),
      // Reads the SAME module-level constant the lock TTL is derived from
      // (see LONGBRIDGE_CLI_TIMEOUT_MS above) rather than re-reading
      // process.env here - the two must never be able to drift apart, or
      // the H7 "lock TTL >= CLI timeout" invariant silently breaks again.
      timeout: LONGBRIDGE_CLI_TIMEOUT_MS
    }).trim();
  } finally {
    release();
  }
}

function isTransientLongbridgeError(error) {
  const text = `${error?.message ?? ""}\n${error?.stderr ?? ""}`;
  return /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNABORTED|ENOTFOUND|EAI_AGAIN|client error \(Connect\)|socket|TLS|network/iu.test(text);
}

function backoffMs(attempt) {
  const base = Number(process.env.LONGBRIDGE_READ_RETRY_BASE_MS ?? 1200);
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(15_000, base * 2 ** Math.max(0, attempt - 1)) + jitter;
}

function sanitizeLongbridgeError(error) {
  const text = String(error?.message ?? error ?? "unknown");
  return text
    .replace(/(token|secret|authorization)[^\s]*/giu, "$1=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gu, "Bearer [REDACTED]")
    .slice(0, 500);
}

async function healLongbridgeRegionCache(category) {
  try {
    const payload = parseLongbridgeJson(await runLongbridgeText(category, ["check", "--format", "json"]));
    healLongbridgeRegionCacheFromCheck(payload);
  } catch {
    // The next real attempt decides success; this only shortens repeated region failures.
  }
}

function healLongbridgeRegionCacheFromCheck(payload) {
  const connectivity = payload?.connectivity;
  if (!connectivity || typeof connectivity !== "object") {
    return;
  }

  const active = normalizeRegion(payload?.region?.active);
  const candidates = [active, "global", "cn"].filter(Boolean);
  const best = candidates.find((region) => connectivity?.[region]?.ok === true);
  if (!best) {
    return;
  }

  try {
    writeFileSync(resolveRegionCachePath(), best);
  } catch {
    // Region healing is an optimization. Do not hide the actual API result behind it.
  }
}

function normalizeRegion(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "global" || normalized === "cn") {
    return normalized;
  }
  return "";
}

function resolveRegionCachePath() {
  return `${process.env.HOME}/.longbridge/openapi/region-cache`;
}

function resolveLongbridgeCli() {
  return process.env.LONGBRIDGE_CLI_PATH ?? `${process.env.HOME}/.local/bin/longbridge`;
}

function buildLongbridgeCliEnv() {
  const env = { ...process.env };
  for (const key of [
    "LONGBRIDGE_ACCESS_TOKEN",
    "LONGPORT_ACCESS_TOKEN"
  ]) {
    if (!env[key]?.trim()) {
      delete env[key];
    }
  }
  return env;
}

// Task H7 (2026-07-14 legacy audit): empty/whitespace-only stdout used to be
// treated as a successful `{}` payload. The alerts poller's quote provider
// (market-alerts-poll.mjs's defaultQuoteProvider) turns `{}` into
// `rows=[{}]` -> no symbol -> an empty quotes map, and the engine's guards
// silently skip every price/prevClose/volume rule on `no_data` - the poll
// cycle still records a GREEN heartbeat while zero alerts can ever fire.
// This is the data-side twin of the delivery-blindness bug H1 fixed: a
// "successful" run that accomplished nothing. Throwing here instead makes
// runLongbridgeJsonWithRetry's caller see a real failure, which (via every
// caller's existing error handling - see this task's audit of
// market-alerts-poll.mjs/official-paper-monitor.mjs/stock-analysis.mjs/
// scheduled-report.mjs) now correctly feeds H1's run_log + escalation chain
// instead of a silently-green no-op cycle.
function parseLongbridgeJson(output) {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error("Longbridge CLI returned empty output (no stdout to parse).");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const embedded = parseFirstEmbeddedJson(trimmed);
    if (embedded !== undefined) {
      return embedded;
    }
    throw new Error(`Longbridge CLI did not return parseable JSON: ${trimmed.slice(0, 120)}`);
  }
}

function parseFirstEmbeddedJson(text) {
  for (let index = 0; index < text.length; index += 1) {
    const marker = text[index];
    if (marker !== "{" && marker !== "[") {
      continue;
    }

    const jsonText = readBalancedJson(text, index);
    if (!jsonText) {
      continue;
    }

    try {
      return JSON.parse(jsonText);
    } catch {
      // Keep scanning; Longbridge progress text can contain bracketed terminal sequences.
    }
  }

  return undefined;
}

function readBalancedJson(text, start) {
  const stack = [];
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }

    if (char === "}" || char === "]") {
      const expected = stack.pop();
      if (expected !== char) {
        return undefined;
      }

      if (stack.length === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

async function waitForWindow(statePath, config) {
  while (true) {
    const now = Date.now();
    const state = loadState(statePath);
    const calls = state.calls.filter((value) => now - value < config.windowMs);
    const oldest = calls[0] ?? 0;
    const last = calls[calls.length - 1] ?? 0;

    let waitMs = 0;
    if (calls.length >= config.maxCalls) {
      waitMs = Math.max(waitMs, oldest + config.windowMs - now);
    }
    if (last > 0) {
      waitMs = Math.max(waitMs, last + config.minIntervalMs - now);
    }

    if (waitMs <= 0) {
      calls.push(Date.now());
      saveState(statePath, { calls });
      return;
    }

    await sleep(waitMs);
  }
}

async function acquireLock(lockPath, lockTtlMs) {
  while (true) {
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify({
        pid: process.pid,
        createdAt: Date.now()
      }));
      return () => {
        rmSync(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      if (isLockStale(lockPath, lockTtlMs)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }

      await sleep(25);
    }
  }
}

function isLockStale(lockPath, lockTtlMs) {
  try {
    const stats = statSync(lockPath);
    return Date.now() - stats.mtimeMs > lockTtlMs;
  } catch {
    return false;
  }
}

function loadState(statePath) {
  try {
    const raw = readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      calls: Array.isArray(parsed.calls) ? parsed.calls.filter((value) => Number.isFinite(value)) : []
    };
  } catch {
    return { calls: [] };
  }
}

function saveState(statePath, state) {
  const tempPath = `${statePath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(state));
  renameSync(tempPath, statePath);
}
