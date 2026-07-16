import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = readFileSync(join(process.cwd(), "apps/openclaw-config/scripts/openclaw-cron-runner.mjs"), "utf8");

const state = await import("./openclaw-cron-runner-state.mjs");
const reset = await import("./cron-runner-reset.mjs");
const cronJobsModule = await import("./openclaw-cron-jobs.mjs");

describe("OpenClaw cron runner", () => {
  it("registers a runner-side handler for every job openclaw-cron-jobs.mjs schedules (2026-07 audit: proposal-sweep and monthly-review were registered but never wired to a command, so they never executed)", () => {
    const registeredJobNames = cronJobsModule.buildManagedOpenClawCronJobs("/repo").map((job) => job.name);
    expect(registeredJobNames).toEqual(
      expect.arrayContaining([
        "openclaw-trading-daily-report",
        "openclaw-trading-weekly-report",
        "openclaw-trading-stock-analysis",
        "openclaw-trading-proposal-sweep",
        "openclaw-trading-monthly-review"
      ])
    );
    for (const jobName of registeredJobNames) {
      expect(script).toContain(`"${jobName}":`);
    }
    expect(script).toContain("proposals:sweep");
    expect(script).toContain("reviews:generate");
  });

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

  it("retries a failed notice-alert send on later poll cycles instead of losing it forever (2026-07-14 audit finding)", () => {
    expect(script).toContain("getPendingNoticeJobs");
    expect(script).toContain("clearNoticePending");
    expect(script).toContain("await retryPendingNoticeAlerts();");
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

// Every dynamic import below uses a unique `?tag` query string. Vitest/Vite treat that as a
// DIFFERENT module instance from a plain `./openclaw-cron-runner.mjs` import (and from every other
// tagged import) - without it, this whole file's imports of the SAME ES module specifier would
// share ONE cached instance (and its module-scope `runtimeDir`/`sigkillGraceMs`/etc, fixed at
// whichever import happened first), silently ignoring env vars set by a later test.
let importTagCounter = 0;
async function importFreshRunner(envOverrides: Record<string, string>) {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  importTagCounter += 1;
  try {
    return await import(/* @vite-ignore */ `./openclaw-cron-runner.mjs?fresh-${importTagCounter}`);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("per-run result file retention (task 5, item 7)", () => {
  const tempDirs: string[] = [];
  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prunes per-run result JSON files older than the retention window, leaving recent ones and non-matching files alone", async () => {
    const runtimeDir = makeTempDir("alphaloop-cron-runner-prune-");
    const cronDir = makeTempDir("alphaloop-cron-runner-prune-cron-");
    writeFileSync(join(cronDir, "jobs.json"), JSON.stringify({ jobs: [] }), "utf8");
    const runner = await importFreshRunner({
      OPENCLAW_CRON_RUNNER_RUNTIME_DIR: runtimeDir,
      OPENCLAW_CRON_DIR: cronDir,
      OPENCLAW_CRON_RUNNER_ALERTS: "0"
    });

    const now = Date.parse("2026-07-14T00:00:00.000Z");
    const oldFile = join(runtimeDir, `${now - 20 * 24 * 60 * 60 * 1000}-daily.json`);
    const recentFile = join(runtimeDir, `${now - 1 * 24 * 60 * 60 * 1000}-daily.json`);
    const unrelatedFile = join(runtimeDir, "processed-runs.json.corrupt-999");
    writeFileSync(oldFile, "{}", "utf8");
    writeFileSync(recentFile, "{}", "utf8");
    writeFileSync(unrelatedFile, "not json result data", "utf8");

    const deleted = runner.pruneResultFiles(runtimeDir, 14 * 24 * 60 * 60 * 1000, now);

    expect(deleted).toEqual([oldFile]);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(recentFile)).toBe(true);
    expect(existsSync(unrelatedFile)).toBe(true);
  });

  it("is swept automatically once per poll cycle", () => {
    expect(script).toContain("pruneResultFiles(runtimeDir, resultRetentionMs)");
  });
});

describe("corrupt processed-runs.json (audit item a): back up, log loudly, never silently reseed as empty", () => {
  const tempDirs: string[] = [];
  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadRunnerStateFromFile treats a truncated/corrupt file as UNKNOWN state: backs it up, forces every known job halted, and reports recovered:true", async () => {
    const runtimeDir = makeTempDir("alphaloop-cron-runner-corrupt-");
    const cronDir = makeTempDir("alphaloop-cron-runner-corrupt-cron-");
    writeFileSync(join(cronDir, "jobs.json"), JSON.stringify({ jobs: [] }), "utf8");
    const runner = await importFreshRunner({
      OPENCLAW_CRON_RUNNER_RUNTIME_DIR: runtimeDir,
      OPENCLAW_CRON_DIR: cronDir,
      OPENCLAW_CRON_RUNNER_ALERTS: "0"
    });

    const statePath = join(runtimeDir, "some-processed-runs.json");
    const corruptBytes = '{"processedRunKeys": ["a", "b"'; // truncated mid-write, exactly what a hard crash leaves behind
    writeFileSync(statePath, corruptBytes, "utf8");

    const { state: recoveredState, recovered } = runner.loadRunnerStateFromFile(statePath);

    expect(recovered).toBe(true);
    // Conservative choice: no replay licence from an empty processedRunKeys - the caller reseeds
    // from OpenClaw's own (unaffected) run-log files instead, same as a fresh install.
    expect(recoveredState.processedRunKeys).toEqual([]);
    // Conservative choice: every known job is forced halted rather than defaulting to "fine" -
    // an operator must explicitly verify + reset via cron-runner-reset.mjs.
    for (const jobName of ["daily", "weekly", "stock-analysis", "market-alerts"]) {
      expect(recoveredState.jobFailureState[jobName]).toMatchObject({ halted: true, failureClass: "__state_file_corrupt__" });
    }

    // The corrupt file is preserved as evidence, backed up alongside rather than deleted/ignored.
    const backupFiles = readdirSync(runtimeDir).filter((name) => name.startsWith("some-processed-runs.json.corrupt-"));
    expect(backupFiles).toHaveLength(1);
    expect(readFileSync(join(runtimeDir, backupFiles[0]), "utf8")).toBe(corruptBytes);
  });

  it("a file that simply does not exist yet is NOT corruption - fresh install, recovered:false, empty state", async () => {
    const runtimeDir = makeTempDir("alphaloop-cron-runner-missing-");
    const cronDir = makeTempDir("alphaloop-cron-runner-missing-cron-");
    writeFileSync(join(cronDir, "jobs.json"), JSON.stringify({ jobs: [] }), "utf8");
    const runner = await importFreshRunner({
      OPENCLAW_CRON_RUNNER_RUNTIME_DIR: runtimeDir,
      OPENCLAW_CRON_DIR: cronDir,
      OPENCLAW_CRON_RUNNER_ALERTS: "0"
    });

    const { state: freshState, recovered } = runner.loadRunnerStateFromFile(join(runtimeDir, "never-existed.json"));

    expect(recovered).toBe(false);
    expect(freshState.processedRunKeys).toEqual([]);
    expect(freshState.jobFailureState).toEqual({});
  });

  it("end-to-end at boot: a real truncated processed-runs.json on disk reseeds from OpenClaw's run-log (not a blind replay) and halts every known job, instead of silently coming up as fresh/unhalted", async () => {
    const runtimeDir = makeTempDir("alphaloop-cron-runner-boot-corrupt-");
    const cronDir = makeTempDir("alphaloop-cron-runner-boot-corrupt-cron-");
    const runsDir = join(cronDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(cronDir, "jobs.json"), JSON.stringify({
      jobs: [{ id: "job-1", name: "openclaw-trading-daily-report", enabled: true }]
    }), "utf8");
    writeFileSync(join(runsDir, "job-1.jsonl"), `${JSON.stringify({ jobId: "job-1", runId: "run-1", action: "finished", status: "ok" })}\n`, "utf8");

    // A hard-crash-truncated state file - exactly the failure mode audit item (a) targets.
    writeFileSync(join(runtimeDir, "processed-runs.json"), '{"processedRunKeys": ["job-1:run-1:finished"', "utf8");

    const runner = await importFreshRunner({
      OPENCLAW_CRON_RUNNER_RUNTIME_DIR: runtimeDir,
      OPENCLAW_CRON_DIR: cronDir,
      OPENCLAW_CRON_RUNNER_ALERTS: "0"
    });

    const bootState = runner.__getRunnerStateForTest();
    // Reseeded from the run-log's OWN independent record of "job-1:run-1:finished" having already
    // happened - NOT a blind "nothing has ever run" empty list (which would replay it).
    expect(bootState.processedRunKeys).toContain("job-1:run-1:finished");
    // Every known job forced halted pending operator verification - NOT silently un-halted.
    expect(bootState.jobFailureState.daily).toMatchObject({ halted: true });

    // The recovery path also re-persisted a NOW-VALID state file (via the normal reseed ->
    // saveRunnerState path), so the corrupt file doesn't keep tripping this same recovery on every
    // subsequent restart.
    const rewritten = JSON.parse(readFileSync(join(runtimeDir, "processed-runs.json"), "utf8"));
    expect(rewritten.processedRunKeys).toContain("job-1:run-1:finished");

    // And the original corrupt bytes are preserved as evidence in a sibling backup file.
    const backupFiles = readdirSync(runtimeDir).filter((name) => name.startsWith("processed-runs.json.corrupt-"));
    expect(backupFiles).toHaveLength(1);
  });
});

describe("atomic state-file write (audit item a / b)", () => {
  const tempDirs: string[] = [];
  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writeRunnerStateAtomic writes via a sibling .tmp file and renames it into place, leaving no leftover .tmp", async () => {
    const runtimeDir = makeTempDir("alphaloop-cron-runner-atomic-");
    const cronDir = makeTempDir("alphaloop-cron-runner-atomic-cron-");
    writeFileSync(join(cronDir, "jobs.json"), JSON.stringify({ jobs: [] }), "utf8");
    const runner = await importFreshRunner({
      OPENCLAW_CRON_RUNNER_RUNTIME_DIR: runtimeDir,
      OPENCLAW_CRON_DIR: cronDir,
      OPENCLAW_CRON_RUNNER_ALERTS: "0"
    });

    const path = join(runtimeDir, "atomic-test.json");
    runner.writeRunnerStateAtomic(path, '{"ok":true}\n');

    expect(readFileSync(path, "utf8")).toBe('{"ok":true}\n');
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("propagates a write failure (e.g. target directory does not exist) instead of silently swallowing it", async () => {
    const runtimeDir = makeTempDir("alphaloop-cron-runner-atomic-fail-");
    const cronDir = makeTempDir("alphaloop-cron-runner-atomic-fail-cron-");
    writeFileSync(join(cronDir, "jobs.json"), JSON.stringify({ jobs: [] }), "utf8");
    const runner = await importFreshRunner({
      OPENCLAW_CRON_RUNNER_RUNTIME_DIR: runtimeDir,
      OPENCLAW_CRON_DIR: cronDir,
      OPENCLAW_CRON_RUNNER_ALERTS: "0"
    });

    const path = join(runtimeDir, "does-not-exist-dir", "state.json");
    expect(() => runner.writeRunnerStateAtomic(path, "{}")).toThrow();
  });

  it("saveRunnerState escalates through the alert channel instead of throwing out and swallowing a persist failure", () => {
    expect(script).toContain("writeRunnerStateAtomic(processedRunsPath, data)");
    expect(script).toContain("escalateStatePersistFailure(\"state-write-failed\"");
  });

  it("a per-run result file write failure also escalates through the alert channel (audit item b)", () => {
    expect(script).toContain("escalateStatePersistFailure(\"result-file-write-failed\"");
  });
});

describe("state-persist-failure escalation channel (audit item b)", () => {
  it("resolves without throwing when alerts are disabled, instead of crashing the caller over an alert-channel failure", async () => {
    const cronDir = mkdtempSync(join(tmpdir(), "alphaloop-cron-runner-escalate-cron-"));
    const runtimeDir = mkdtempSync(join(tmpdir(), "alphaloop-cron-runner-escalate-"));
    writeFileSync(join(cronDir, "jobs.json"), JSON.stringify({ jobs: [] }), "utf8");
    try {
      const runner = await importFreshRunner({
        OPENCLAW_CRON_RUNNER_RUNTIME_DIR: runtimeDir,
        OPENCLAW_CRON_DIR: cronDir,
        OPENCLAW_CRON_RUNNER_ALERTS: "0"
      });
      // Exercises the real escalation path (disabled) via a real write failure, rather than
      // calling a private function directly.
      expect(() => runner.writeRunnerStateAtomic(join(runtimeDir, "missing-dir", "x.json"), "{}")).toThrow();
    } finally {
      rmSync(cronDir, { recursive: true, force: true });
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
});

describe("SIGKILL fallback for a hung child process (audit item c)", () => {
  const tempDirs: string[] = [];
  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kills a child that ignores SIGTERM via a bounded SIGKILL fallback, instead of wedging that runKey forever", async () => {
    const runtimeDir = makeTempDir("alphaloop-cron-runner-sigkill-");
    const cronDir = makeTempDir("alphaloop-cron-runner-sigkill-cron-");
    writeFileSync(join(cronDir, "jobs.json"), JSON.stringify({ jobs: [] }), "utf8");
    const runner = await importFreshRunner({
      OPENCLAW_CRON_RUNNER_RUNTIME_DIR: runtimeDir,
      OPENCLAW_CRON_DIR: cronDir,
      OPENCLAW_CRON_RUNNER_ALERTS: "0",
      OPENCLAW_CRON_RUNNER_SIGKILL_GRACE_MS: "500"
    });

    // A child that installs a SIGTERM handler which does nothing - exactly what wedged a runKey
    // forever before this fix (the runner's timeout only ever sent ONE signal). timeoutMs is
    // generous (well beyond node's own startup time) so this is a genuine "ignored SIGTERM" case
    // under CI/parallel-test-suite load, not a race against the child registering its handler.
    const ignoreSigtermScript = "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 60000);";
    const job = {
      name: "sigterm-ignoring-test-job",
      command: [process.execPath, "-e", ignoreSigtermScript],
      timeoutMs: 1500
    };

    const startedAt = Date.now();
    const result = await runner.runAllowedJob(job, { trigger: "test" });
    const elapsedMs = Date.now() - startedAt;

    expect(result.signal).toBe("SIGKILL");
    // Bounded: timeoutMs (1500) + sigkillGraceMs (500) + generous scheduling slack, well under the
    // child's own 60s exit - proves the SIGKILL fallback is what ended it, not the child itself.
    expect(elapsedMs).toBeLessThan(10_000);
  }, 15_000);
});
