import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openTradingDatabase } from "../../../packages/shared-types/dist/index.js";

const reset = await import("./cron-runner-reset.mjs");
const state = await import("./openclaw-cron-runner-state.mjs");

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function haltedStateFor(jobName: string) {
  let runnerState = state.normalizeRunnerState({});
  for (let i = 0; i < 3; i += 1) {
    runnerState = state.recordRunResult(
      runnerState,
      `${jobName}:run-${i}:finished`,
      { ok: false, job: jobName, error: "Longbridge unavailable" },
      Date.parse("2026-07-01T00:00:00.000Z") + i * 60_000
    );
  }
  return runnerState;
}

describe("cron-runner-reset", () => {
  it("clears a halted job's counters/flag, persists the state, and writes an audit log entry", () => {
    const runtimeDir = makeTempDir("alphaloop-cron-reset-state-");
    const dbDir = makeTempDir("alphaloop-cron-reset-db-");
    const statePath = join(runtimeDir, "processed-runs.json");
    const dbPath = join(dbDir, "trading.sqlite");

    const haltedState = haltedStateFor("daily");
    expect(haltedState.jobFailureState.daily.halted).toBe(true);
    writeFileSync(statePath, `${JSON.stringify(state.serializeRunnerState(haltedState), null, 2)}\n`, "utf8");

    const result = reset.resetCronRunnerJob("daily", { statePath, dbPath });

    expect(result.ok).toBe(true);
    expect(result.jobName).toBe("daily");
    expect(result.wasHalted).toBe(true);
    expect(typeof result.auditId).toBe("string");

    const persisted = state.normalizeRunnerState(JSON.parse(readFileSync(statePath, "utf8")));
    expect(persisted.jobFailureState.daily).toMatchObject({ consecutiveCount: 0, halted: false });

    const db = openTradingDatabase(dbPath);
    const row = db.prepare("SELECT category, action, payload FROM audit_log WHERE id = ?").get(result.auditId) as
      | { category: string; action: string; payload: string }
      | undefined;
    db.close();

    expect(row).toBeDefined();
    expect(row?.category).toBe("openclaw-cron-runner");
    expect(row?.action).toBe("job.reset");
    expect(JSON.parse(row?.payload ?? "{}")).toMatchObject({ jobName: "daily", wasHalted: true });
  });

  it("rejects an unknown job name with a clear, non-throwing-to-the-CLI-caller message", () => {
    const runtimeDir = makeTempDir("alphaloop-cron-reset-state-");
    const dbDir = makeTempDir("alphaloop-cron-reset-db-");
    const statePath = join(runtimeDir, "processed-runs.json");
    const dbPath = join(dbDir, "trading.sqlite");

    expect(() => reset.resetCronRunnerJob("not-a-real-job", { statePath, dbPath })).toThrow(/unknown/i);
  });

  it("rejects a missing job name", () => {
    const runtimeDir = makeTempDir("alphaloop-cron-reset-state-");
    const dbDir = makeTempDir("alphaloop-cron-reset-db-");
    const statePath = join(runtimeDir, "processed-runs.json");
    const dbPath = join(dbDir, "trading.sqlite");

    expect(() => reset.resetCronRunnerJob(undefined, { statePath, dbPath })).toThrow();
  });

  it("succeeds as a no-op when the job was never halted", () => {
    const runtimeDir = makeTempDir("alphaloop-cron-reset-state-");
    const dbDir = makeTempDir("alphaloop-cron-reset-db-");
    const statePath = join(runtimeDir, "processed-runs.json");
    const dbPath = join(dbDir, "trading.sqlite");

    const result = reset.resetCronRunnerJob("weekly", { statePath, dbPath });
    expect(result.ok).toBe(true);
    expect(result.wasHalted).toBe(false);
  });
});
