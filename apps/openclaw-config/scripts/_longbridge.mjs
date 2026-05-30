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

const LONG_BRIDGE_LIMITS = {
  quote: {
    windowMs: 1_000,
    maxCalls: 10,
    minIntervalMs: 100,
    lockTtlMs: 10_000
  },
  trade: {
    windowMs: 30_000,
    maxCalls: 30,
    minIntervalMs: 20,
    lockTtlMs: 40_000
  }
};

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
      timeout: Number(process.env.LONGBRIDGE_CLI_TIMEOUT_MS ?? 45_000)
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

function parseLongbridgeJson(output) {
  const trimmed = output.trim();
  if (!trimmed) {
    return {};
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
