#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AuditLogRepository, openTradingDatabase, resolveRuntimePaths } from "../../../packages/shared-types/dist/index.js";
import {
  KNOWN_CRON_JOB_NAMES,
  normalizeRunnerState,
  resetJobFailureState,
  serializeRunnerState
} from "./openclaw-cron-runner-state.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const defaultStatePath = join(repoRoot, "runtime", "openclaw-cron-runner", "processed-runs.json");

/**
 * Clears the halted flag and same-class failure counter for `jobName`, so the cron runner's
 * shouldAttemptRun gate resumes normal (backoff) retries for it, and records an audit_log entry
 * so there is a durable trail of who/when reset a halted job.
 *
 * Rejects unknown job names up front (before touching the state file or database) so operator
 * typos fail loudly instead of silently no-op'ing.
 */
export function resetCronRunnerJob(jobName, options = {}) {
  const name = String(jobName ?? "").trim();
  if (!name) {
    throw new Error("Missing required job name. Usage: node apps/openclaw-config/scripts/cron-runner-reset.mjs <jobName>");
  }
  if (!KNOWN_CRON_JOB_NAMES.includes(name)) {
    throw new Error(
      `Unknown cron job name: "${name}" (expected one of: ${KNOWN_CRON_JOB_NAMES.join(", ")})`
    );
  }

  const statePath = options.statePath ?? defaultStatePath;
  if (!existsSync(statePath)) {
    // The runner writes this file on first boot (seeding history) and after every recorded run.
    // If it doesn't exist yet, there is no halted job to clear — and pre-creating an empty one
    // here would make the runner's next boot skip its first-boot run-log seeding. Refuse instead.
    throw new Error(
      `No cron runner state file found at "${statePath}"; nothing to reset.`
    );
  }
  const beforeState = normalizeRunnerState(readJsonFile(statePath, {}));
  const previousJobFailure = beforeState.jobFailureState[name];
  const wasHalted = Boolean(previousJobFailure?.halted);
  const previousConsecutiveCount = Number(previousJobFailure?.consecutiveCount ?? 0);

  const afterState = resetJobFailureState(beforeState, name);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(serializeRunnerState(afterState), null, 2)}\n`, "utf8");

  const dbPath = options.dbPath ?? resolveRuntimePaths(repoRoot).dbPath;
  const db = openTradingDatabase(dbPath);
  let auditId;
  try {
    const audit = new AuditLogRepository(db);
    const resetAt = new Date().toISOString();
    auditId = audit.write("openclaw-cron-runner", "job.reset", {
      jobName: name,
      wasHalted,
      previousConsecutiveCount,
      resetAt
    });
  } finally {
    db.close();
  }

  return {
    ok: true,
    jobName: name,
    wasHalted,
    previousConsecutiveCount,
    auditId
  };
}

function readJsonFile(path, fallback) {
  try {
    if (!existsSync(path)) {
      return fallback;
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function main() {
  const jobName = process.argv[2];
  try {
    const result = resetCronRunnerJob(jobName);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}

const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  await main();
}
