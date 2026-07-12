import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = readFileSync(join(process.cwd(), "apps/openclaw-config/scripts/openclaw-cron-runner.mjs"), "utf8");

const state = await import("./openclaw-cron-runner-state.mjs");
const reset = await import("./cron-runner-reset.mjs");

describe("OpenClaw cron runner", () => {
  it("uses the launchd-provided pnpm binary when spawning project jobs", () => {
    expect(script).toContain("process.env.PNPM_BIN");
    expect(script).toContain("[pnpmBin, \"stock-analysis:scheduled\"]");
  });

  it("turns spawn failures into structured run results instead of crashing the service", () => {
    expect(script).toContain("child.on(\"error\"");
    expect(script).toContain("ok: !exit.error && exit.code === 0");
    expect(script).toContain("error: exit.error ? String");
  });

  it("watches OpenClaw cron run logs and records processed runs", () => {
    expect(script).toContain("OPENCLAW_CRON_DIR");
    expect(script).toContain("jobs.json");
    expect(script).toContain("processed-runs.json");
    expect(script).toContain("openclaw-cron-run-log");
    expect(script).toContain("readCronRunEntries");
  });

  it("only records OpenClaw run-log jobs as processed after a successful report run", () => {
    expect(script).toContain("recordRunResult");
    expect(script).toContain("if (!result.ok && shouldAlertFailure");
    expect(script).not.toContain("processedRunKeys.add(runKey)");
  });

  it("marks OpenClaw run-log jobs so stock analysis does not re-check the exact wall-clock minute", () => {
    expect(script).toContain("OPENCLAW_CRON_TRIGGERED");
    expect(script).toContain("context.trigger === \"openclaw-cron-run-log\"");
  });

  it("only starts the HTTP server / poll interval when run directly, not when imported", () => {
    expect(script).toContain("isMainModule");
    expect(script).toContain("if (isMainModule) {");
  });
});

describe("live-runner state reload between poll cycles", () => {
  const tempDirs: string[] = [];
  const envKeys = [
    "OPENCLAW_CRON_RUNNER_RUNTIME_DIR",
    "OPENCLAW_CRON_DIR",
    "OPENCLAW_CRON_RUNNER_ALERTS"
  ];
  const previousEnv: Record<string, string | undefined> = {};

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousEnv[key];
      }
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("picks up a reset written to disk by an external process on the next poll cycle, instead of the stale in-memory state clobbering it", async () => {
    const runtimeDir = makeTempDir("alphaloop-cron-runner-runtime-");
    const cronDir = makeTempDir("alphaloop-cron-runner-cron-");
    const dbDir = makeTempDir("alphaloop-cron-runner-db-");
    // Empty managed-job list: this test isolates the reload mechanism itself, not job execution.
    writeFileSync(join(cronDir, "jobs.json"), JSON.stringify({ jobs: [] }), "utf8");

    const statePath = join(runtimeDir, "processed-runs.json");
    let haltedState = state.normalizeRunnerState({});
    for (let i = 0; i < 3; i += 1) {
      haltedState = state.recordRunResult(
        haltedState,
        `daily:run-${i}:finished`,
        { ok: false, job: "daily", error: "Longbridge unavailable" },
        Date.parse("2026-07-01T00:00:00.000Z") + i * 60_000
      );
    }
    expect(haltedState.jobFailureState.daily.halted).toBe(true);
    writeFileSync(statePath, `${JSON.stringify(state.serializeRunnerState(haltedState), null, 2)}\n`, "utf8");

    for (const key of envKeys) {
      previousEnv[key] = process.env[key];
    }
    process.env.OPENCLAW_CRON_RUNNER_RUNTIME_DIR = runtimeDir;
    process.env.OPENCLAW_CRON_DIR = cronDir;
    process.env.OPENCLAW_CRON_RUNNER_ALERTS = "0";

    const runner = await import("./openclaw-cron-runner.mjs");

    // Boots already halted (as if this process had recorded the 3 failures itself earlier).
    expect(runner.__getRunnerStateForTest().jobFailureState.daily?.halted).toBe(true);

    // The operator's `cron-runner-reset.mjs daily` run while this process stays alive: a direct
    // external write to the same state file, exactly like the CLI does.
    reset.resetCronRunnerJob("daily", { statePath, dbPath: join(dbDir, "trading.sqlite") });

    // Still stale: the running process hasn't reloaded from disk yet.
    expect(runner.__getRunnerStateForTest().jobFailureState.daily?.halted).toBe(true);

    await runner.pollOpenClawRunLogs();

    // The next poll cycle reloaded state from disk, so the reset is now visible in-memory.
    expect(runner.__getRunnerStateForTest().jobFailureState.daily?.halted).toBe(false);
  });
});
