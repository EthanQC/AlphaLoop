#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const runtimeRoot = join(repoRoot, "runtime");

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
  return JSON.parse(await runLongbridgeText(category, [...args, "--format", "json"]));
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
      encoding: "utf8"
    }).trim();
  } finally {
    release();
  }
}

function resolveLongbridgeCli() {
  return process.env.LONGBRIDGE_CLI_PATH ?? `${process.env.HOME}/.local/bin/longbridge`;
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
