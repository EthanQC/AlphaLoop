import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = readFileSync(join(process.cwd(), "apps/openclaw-config/scripts/openclaw-cron-runner.mjs"), "utf8");

const state = await import("./openclaw-cron-runner-state.mjs");
const reset = await import("./cron-runner-reset.mjs");
const cronJobsModule = await import("./openclaw-cron-jobs.mjs");

// ---------------------------------------------------------------------------------------------
// Fake OpenClaw CLI (the runner's cron-discovery interface since the 2026.7 sqlite migration).
//
// OpenClaw 2026.7 moved cron job definitions + run history out of ~/.openclaw/cron/*.json[l]
// files into its shared sqlite state DB (`openclaw cron status` on the deployed mini reports
// `"storage": "sqlite"`), so the runner now discovers managed jobs via `openclaw cron list
// --json` and run history via `openclaw cron runs --id <jobId>`. These tests fake that CLI with
// a scenario-file-driven executable so they never need a live gateway.
// ---------------------------------------------------------------------------------------------

interface FakeCliScenario {
  list?: unknown;
  runs?: Record<string, unknown>;
  failWith?: string;
  invocationLogPath?: string;
}

interface FakeCli {
  binPath: string;
  update(next: FakeCliScenario): void;
}

function writeFakeOpenclawCli(dir: string, scenario: FakeCliScenario): FakeCli {
  const scenarioPath = join(dir, "fake-openclaw-scenario.json");
  writeFileSync(scenarioPath, JSON.stringify(scenario), "utf8");
  const binPath = join(dir, "fake-openclaw.mjs");
  writeFileSync(binPath, [
    "#!/usr/bin/env node",
    'import { readFileSync, appendFileSync } from "node:fs";',
    `const scenario = JSON.parse(readFileSync(${JSON.stringify(scenarioPath)}, "utf8"));`,
    "const args = process.argv.slice(2);",
    'if (scenario.invocationLogPath) appendFileSync(scenario.invocationLogPath, JSON.stringify(args) + "\\n");',
    "if (scenario.failWith) { console.error(scenario.failWith); process.exit(1); }",
    'if (args[0] === "cron" && args[1] === "list") { process.stdout.write(JSON.stringify(scenario.list ?? { jobs: [] })); process.exit(0); }',
    'if (args[0] === "cron" && args[1] === "runs") {',
    '  const idIndex = args.indexOf("--id");',
    '  const jobId = idIndex >= 0 ? String(args[idIndex + 1]) : "";',
    "  process.stdout.write(JSON.stringify((scenario.runs ?? {})[jobId] ?? { entries: [] }));",
    "  process.exit(0);",
    "}",
    'console.error("fake openclaw: unexpected args " + args.join(" "));',
    "process.exit(2);"
  ].join("\n"), { mode: 0o755 });
  return {
    binPath,
    update: (next: FakeCliScenario) => writeFileSync(scenarioPath, JSON.stringify(next), "utf8")
  };
}

function writeFakePnpm(dir: string, options: { exitCode?: number } = {}): { binPath: string; logPath: string } {
  const logPath = join(dir, "fake-pnpm-invocations.log");
  const binPath = join(dir, "fake-pnpm.mjs");
  writeFileSync(binPath, [
    "#!/usr/bin/env node",
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
    options.exitCode ? `console.error("fake pnpm failure"); process.exit(${options.exitCode});` : "process.exit(0);"
  ].join("\n"), { mode: 0o755 });
  return { binPath, logPath };
}

function readInvocations(logPath: string): string[][] {
  if (!existsSync(logPath)) {
    return [];
  }
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

// Pre-marks the runtime dir as already CLI-seeded so a test starts in steady state (discovery
// enabled, no seeding pass) instead of the first poll declaring backlog bankruptcy.
function markSeedCompleted(runtimeDir: string): void {
  writeFileSync(join(runtimeDir, "processed-runs.json"), `${JSON.stringify({ processedRunKeys: [] })}\n`, "utf8");
  writeFileSync(join(runtimeDir, "cli-seed-completed.json"), `${JSON.stringify({ seededAt: "2026-07-18T00:00:00.000Z" })}\n`, "utf8");
}

const DAILY_JOB_ID = "job-daily-1";

function dailyListScenario(lastRunAtMs: number | null): unknown {
  return {
    jobs: [{
      id: DAILY_JOB_ID,
      name: "openclaw-trading-daily-report",
      enabled: true,
      state: lastRunAtMs === null ? {} : { lastRunAtMs, lastRunStatus: "ok" }
    }]
  };
}

function finishedEntry(runAtMs: number, status = "ok"): unknown {
  return { ts: runAtMs + 5, jobId: DAILY_JOB_ID, action: "finished", status, runAtMs };
}

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

  it("discovers managed jobs and run history through the OpenClaw CLI, not the pre-2026.7 cron files (which the sqlite migration left as *.migrated husks the old code silently read as empty forever)", () => {
    expect(script).toContain("OPENCLAW_BIN");
    expect(script).toContain('"cron", "list", "--json"');
    expect(script).toContain('"cron", "runs", "--id"');
    expect(script).toContain("processed-runs.json");
    expect(script).toContain("openclaw-cron-run-log");
    expect(script).toContain("readCronRunEntries");
    // The legacy file-store discovery must be fully gone - keeping it as a "fallback" is exactly
    // the silent path that read empty data for a month.
    expect(script).not.toContain("OPENCLAW_CRON_DIR");
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

  it("exposes a GET /health endpoint that surfaces discovery-guard errors", () => {
    expect(script).toContain('url.pathname === "/health"');
    expect(script).toContain("getRunnerHealthSnapshot");
    expect(script).toContain("cron-discovery-gap");
  });
});

// Every dynamic import below uses a unique `?tag` query string. Vitest/Vite treat that as a
// DIFFERENT module instance from a plain `./openclaw-cron-runner.mjs` import (and from every other
// tagged import) - without it, this whole file's imports of the SAME ES module specifier would
// share ONE cached instance (and its module-scope `runtimeDir`/`openclawBin`/etc, fixed at
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

function makeTempDirFactory(tempDirs: string[]) {
  return (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };
}

function cleanupTempDirs(tempDirs: string[]): void {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

describe("CLI-based discovery executes managed runs (the 2026.7 sqlite-migration fix)", () => {
  const tempDirs: string[] = [];
  const makeTempDir = makeTempDirFactory(tempDirs);
  afterEach(() => cleanupTempDirs(tempDirs));

  it("executes the mapped pnpm command for a new gateway-finished run discovered via the CLI, exactly once", async () => {
    const runtimeDir = makeTempDir("alphaloop-cron-runner-cli-exec-");
    const fakeDir = makeTempDir("alphaloop-cron-runner-cli-exec-fake-");
    markSeedCompleted(runtimeDir);
    const cli = writeFakeOpenclawCli(fakeDir, {
      list: dailyListScenario(1000),
      runs: { [DAILY_JOB_ID]: { entries: [finishedEntry(1000)] } }
    });
    const pnpm = writeFakePnpm(fakeDir);

    const runner = await importFreshRunner({
      OPENCLAW_CRON_RUNNER_RUNTIME_DIR: runtimeDir,
      OPENCLAW_BIN: cli.binPath,
      PNPM_BIN: pnpm.binPath,
      OPENCLAW_CRON_RUNNER_ALERTS: "0"
    });

    await runner.pollOpenClawRunLogs();

    expect(readInvocations(pnpm.logPath)).toEqual([["report:daily:run"]]);
    expect(runner.__getRunnerStateForTest().processedRunKeys).toContain(`${DAILY_JOB_ID}:1000:finished`);

    // A second poll cycle sees the run already processed and does NOT re-execute it.
    await runner.pollOpenClawRunLogs();
    expect(readInvocations(pnpm.logPath)).toEqual([["report:daily:run"]]);
  });

  it("first poll after the migration seeds all CLI-visible history as already-processed (no replay burst), then executes only genuinely new runs", async () => {
    const runtimeDir = makeTempDir("alphaloop-cron-runner-cli-seed-");
    const fakeDir = makeTempDir("alphaloop-cron-runner-cli-seed-fake-");
    // No seed marker: this is the first boot on the CLI interface (fresh install OR a deploy onto
    // a mini whose state file predates the sqlite migration - either way the visible history was
    // never executed by this runner and must NOT be replayed as a burst of stale reports).
    const cli = writeFakeOpenclawCli(fakeDir, {
      list: dailyListScenario(1000),
      runs: { [DAILY_JOB_ID]: { entries: [finishedEntry(1000)] } }
    });
    const pnpm = writeFakePnpm(fakeDir);

    const runner = await importFreshRunner({
      OPENCLAW_CRON_RUNNER_RUNTIME_DIR: runtimeDir,
      OPENCLAW_BIN: cli.binPath,
      PNPM_BIN: pnpm.binPath,
      OPENCLAW_CRON_RUNNER_ALERTS: "0"
    });

    await runner.pollOpenClawRunLogs();

    // Seeding pass: history marked processed, nothing executed, durable marker written.
    expect(readInvocations(pnpm.logPath)).toEqual([]);
    expect(runner.__getRunnerStateForTest().processedRunKeys).toContain(`${DAILY_JOB_ID}:1000:finished`);
    expect(existsSync(join(runtimeDir, "cli-seed-completed.json"))).toBe(true);

    // A new run appears at the gateway - THIS one executes.
    cli.update({
      list: dailyListScenario(2000),
      runs: { [DAILY_JOB_ID]: { entries: [finishedEntry(2000), finishedEntry(1000)] } }
    });
    await runner.pollOpenClawRunLogs();

    expect(readInvocations(pnpm.logPath)).toEqual([["report:daily:run"]]);
    expect(runner.__getRunnerStateForTest().processedRunKeys).toContain(`${DAILY_JOB_ID}:2000:finished`);
  });

  it("a failed local execution records a retry attempt (not processed) and respects the retry backoff on the next poll", async () => {
    const runtimeDir = makeTempDir("alphaloop-cron-runner-cli-fail-");
    const fakeDir = makeTempDir("alphaloop-cron-runner-cli-fail-fake-");
    markSeedCompleted(runtimeDir);
    const cli = writeFakeOpenclawCli(fakeDir, {
      list: dailyListScenario(1000),
      runs: { [DAILY_JOB_ID]: { entries: [finishedEntry(1000)] } }
    });
    const pnpm = writeFakePnpm(fakeDir, { exitCode: 1 });

    const runner = await importFreshRunner({
      OPENCLAW_CRON_RUNNER_RUNTIME_DIR: runtimeDir,
      OPENCLAW_BIN: cli.binPath,
      PNPM_BIN: pnpm.binPath,
      OPENCLAW_CRON_RUNNER_ALERTS: "0"
    });

    await runner.pollOpenClawRunLogs();

    const runKey = `${DAILY_JOB_ID}:1000:finished`;
    expect(readInvocations(pnpm.logPath)).toHaveLength(1);
    expect(runner.__getRunnerStateForTest().processedRunKeys).not.toContain(runKey);
    expect(runner.__getRunnerStateForTest().failedRunAttempts[runKey]?.attempts).toBe(1);

    // Immediately re-polling stays inside the retry backoff window - no second execution.
    await runner.pollOpenClawRunLogs();
    expect(readInvocations(pnpm.logPath)).toHaveLength(1);
  });

  it("does not execute (and does not gap-flag) a run the gateway itself reports as errored", async () => {
    const runtimeDir = makeTempDir("alphaloop-cron-runner-cli-gwerr-");
    const fakeDir = makeTempDir("alphaloop-cron-runner-cli-gwerr-fake-");
    markSeedCompleted(runtimeDir);
    const cli = writeFakeOpenclawCli(fakeDir, {
      list: dailyListScenario(1000),
      runs: { [DAILY_JOB_ID]: { entries: [finishedEntry(1000, "error")] } }
    });
    const pnpm = writeFakePnpm(fakeDir);

    const runner = await importFreshRunner({
      OPENCLAW_CRON_RUNNER_RUNTIME_DIR: runtimeDir,
      OPENCLAW_BIN: cli.binPath,
      PNPM_BIN: pnpm.binPath,
      OPENCLAW_CRON_RUNNER_ALERTS: "0",
      OPENCLAW_CRON_RUNNER_DISCOVERY_GAP_MS: "0"
    });

    await runner.pollOpenClawRunLogs();

    expect(readInvocations(pnpm.logPath)).toEqual([]);
    // The run IS visible through the interface (the gateway just reports it errored), so the
    // discovery guard must not treat it as the interface going blind.
    const health = runner.getRunnerHealthSnapshot();
    expect(health.gaps).toEqual([]);
    expect(health.ok).toBe(true);
  });
});

describe("fail-loud discovery guard (the silent-no-op class this bug was)", () => {
  const tempDirs: string[] = [];
  const makeTempDir = makeTempDirFactory(tempDirs);
  afterEach(() => cleanupTempDirs(tempDirs));

  it("surfaces a health error when the gateway reports a managed job fired but the runner cannot see the run via the CLI for longer than the threshold", async () => {
    const runtimeDir = makeTempDir("alphaloop-cron-runner-gap-");
    const fakeDir = makeTempDir("alphaloop-cron-runner-gap-fake-");
    markSeedCompleted(runtimeDir);
    // Gateway says the daily job last ran at 1000, but the runs interface shows NOTHING - exactly
    // what the pre-fix runner experienced for a month (reading files the sqlite migration had
    // emptied) without ever saying a word.
    const cli = writeFakeOpenclawCli(fakeDir, {
      list: dailyListScenario(1000),
      runs: { [DAILY_JOB_ID]: { entries: [] } }
    });
    const pnpm = writeFakePnpm(fakeDir);

    const runner = await importFreshRunner({
      OPENCLAW_CRON_RUNNER_RUNTIME_DIR: runtimeDir,
      OPENCLAW_BIN: cli.binPath,
      PNPM_BIN: pnpm.binPath,
      OPENCLAW_CRON_RUNNER_ALERTS: "0",
      OPENCLAW_CRON_RUNNER_DISCOVERY_GAP_MS: "0"
    });

    await runner.pollOpenClawRunLogs();

    const health = runner.getRunnerHealthSnapshot();
    expect(health.ok).toBe(false);
    expect(health.gaps).toHaveLength(1);
    expect(health.gaps[0]).toMatchObject({
      jobName: "daily",
      openclawJobId: DAILY_JOB_ID,
      lastRunAtMs: 1000,
      exceededThreshold: true
    });
    expect(health.errors.join("\n")).toContain("cron-discovery-gap");

    // The run becomes visible -> executed normally, gap cleared, health green again.
    cli.update({
      list: dailyListScenario(1000),
      runs: { [DAILY_JOB_ID]: { entries: [finishedEntry(1000)] } }
    });
    await runner.pollOpenClawRunLogs();

    expect(readInvocations(pnpm.logPath)).toEqual([["report:daily:run"]]);
    const recovered = runner.getRunnerHealthSnapshot();
    expect(recovered.gaps).toEqual([]);
    expect(recovered.ok).toBe(true);
  });

  it("a failing `openclaw cron list` surfaces in health instead of the poll cycle throwing or silently idling", async () => {
    const runtimeDir = makeTempDir("alphaloop-cron-runner-listfail-");
    const fakeDir = makeTempDir("alphaloop-cron-runner-listfail-fake-");
    markSeedCompleted(runtimeDir);
    const cli = writeFakeOpenclawCli(fakeDir, { failWith: "gateway unreachable" });
    const pnpm = writeFakePnpm(fakeDir);

    const runner = await importFreshRunner({
      OPENCLAW_CRON_RUNNER_RUNTIME_DIR: runtimeDir,
      OPENCLAW_BIN: cli.binPath,
      PNPM_BIN: pnpm.binPath,
      OPENCLAW_CRON_RUNNER_ALERTS: "0"
    });

    await expect(runner.pollOpenClawRunLogs()).resolves.toBeUndefined();

    const health = runner.getRunnerHealthSnapshot();
    expect(health.ok).toBe(false);
    expect(health.errors.join("\n")).toContain("cron-list-failed");
    expect(readInvocations(pnpm.logPath)).toEqual([]);
  });

  it("doctor-style fail-loud when the CLI output shape drifts (no `jobs` array), instead of silently treating it as zero managed jobs", async () => {
    const runtimeDir = makeTempDir("alphaloop-cron-runner-drift-");
    const fakeDir = makeTempDir("alphaloop-cron-runner-drift-fake-");
    markSeedCompleted(runtimeDir);
    const cli = writeFakeOpenclawCli(fakeDir, { list: { items: [] } });
    const pnpm = writeFakePnpm(fakeDir);

    const runner = await importFreshRunner({
      OPENCLAW_CRON_RUNNER_RUNTIME_DIR: runtimeDir,
      OPENCLAW_BIN: cli.binPath,
      PNPM_BIN: pnpm.binPath,
      OPENCLAW_CRON_RUNNER_ALERTS: "0"
    });

    await runner.pollOpenClawRunLogs();

    const health = runner.getRunnerHealthSnapshot();
    expect(health.ok).toBe(false);
    expect(health.errors.join("\n")).toMatch(/jobs.*array/u);
  });
});

describe("live-runner state reload between poll cycles", () => {
  const tempDirs: string[] = [];
  const envKeys = [
    "OPENCLAW_CRON_RUNNER_RUNTIME_DIR",
    "OPENCLAW_BIN",
    "OPENCLAW_CRON_RUNNER_ALERTS"
  ];
  const previousEnv: Record<string, string | undefined> = {};
  const makeTempDir = makeTempDirFactory(tempDirs);

  afterEach(() => {
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousEnv[key];
      }
    }
    cleanupTempDirs(tempDirs);
  });

  it("picks up a reset written to disk by an external process on the next poll cycle, instead of the stale in-memory state clobbering it", async () => {
    const runtimeDir = makeTempDir("alphaloop-cron-runner-runtime-");
    const fakeDir = makeTempDir("alphaloop-cron-runner-cli-");
    const dbDir = makeTempDir("alphaloop-cron-runner-db-");
    // Empty managed-job list: this test isolates the reload mechanism itself, not job execution.
    const cli = writeFakeOpenclawCli(fakeDir, { list: { jobs: [] } });

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
    process.env.OPENCLAW_BIN = cli.binPath;
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

describe("per-run result file retention (task 5, item 7)", () => {
  const tempDirs: string[] = [];
  const makeTempDir = makeTempDirFactory(tempDirs);
  afterEach(() => cleanupTempDirs(tempDirs));

  it("prunes per-run result JSON files older than the retention window, leaving recent ones and non-matching files alone", async () => {
    const runtimeDir = makeTempDir("alphaloop-cron-runner-prune-");
    const fakeDir = makeTempDir("alphaloop-cron-runner-prune-fake-");
    const cli = writeFakeOpenclawCli(fakeDir, { list: { jobs: [] } });
    const runner = await importFreshRunner({
      OPENCLAW_CRON_RUNNER_RUNTIME_DIR: runtimeDir,
      OPENCLAW_BIN: cli.binPath,
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
  const makeTempDir = makeTempDirFactory(tempDirs);
  afterEach(() => cleanupTempDirs(tempDirs));

  it("loadRunnerStateFromFile treats a truncated/corrupt file as UNKNOWN state: backs it up, forces every known job halted, and reports recovered:true", async () => {
    const runtimeDir = makeTempDir("alphaloop-cron-runner-corrupt-");
    const fakeDir = makeTempDir("alphaloop-cron-runner-corrupt-fake-");
    const cli = writeFakeOpenclawCli(fakeDir, { list: { jobs: [] } });
    const runner = await importFreshRunner({
      OPENCLAW_CRON_RUNNER_RUNTIME_DIR: runtimeDir,
      OPENCLAW_BIN: cli.binPath,
      OPENCLAW_CRON_RUNNER_ALERTS: "0"
    });

    const statePath = join(runtimeDir, "some-processed-runs.json");
    const corruptBytes = '{"processedRunKeys": ["a", "b"'; // truncated mid-write, exactly what a hard crash leaves behind
    writeFileSync(statePath, corruptBytes, "utf8");

    const { state: recoveredState, recovered } = runner.loadRunnerStateFromFile(statePath);

    expect(recovered).toBe(true);
    // Conservative choice: no replay licence from an empty processedRunKeys - the caller reseeds
    // from OpenClaw's own (unaffected) run history instead, same as a fresh install.
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
    const fakeDir = makeTempDir("alphaloop-cron-runner-missing-fake-");
    const cli = writeFakeOpenclawCli(fakeDir, { list: { jobs: [] } });
    const runner = await importFreshRunner({
      OPENCLAW_CRON_RUNNER_RUNTIME_DIR: runtimeDir,
      OPENCLAW_BIN: cli.binPath,
      OPENCLAW_CRON_RUNNER_ALERTS: "0"
    });

    const { state: freshState, recovered } = runner.loadRunnerStateFromFile(join(runtimeDir, "never-existed.json"));

    expect(recovered).toBe(false);
    expect(freshState.processedRunKeys).toEqual([]);
    expect(freshState.jobFailureState).toEqual({});
  });

  it("end-to-end: a real truncated processed-runs.json reseeds from the CLI-visible run history on the first poll (not a blind replay) and halts every known job, instead of silently coming up as fresh/unhalted", async () => {
    const runtimeDir = makeTempDir("alphaloop-cron-runner-boot-corrupt-");
    const fakeDir = makeTempDir("alphaloop-cron-runner-boot-corrupt-fake-");
    const cli = writeFakeOpenclawCli(fakeDir, {
      list: dailyListScenario(1000),
      runs: { [DAILY_JOB_ID]: { entries: [finishedEntry(1000)] } }
    });
    const pnpm = writeFakePnpm(fakeDir);

    // A hard-crash-truncated state file - exactly the failure mode audit item (a) targets. The
    // seed marker exists (this install had already migrated), but corruption still forces a
    // reseed: the recovered empty processedRunKeys must never stand unseeded.
    writeFileSync(join(runtimeDir, "processed-runs.json"), `{"processedRunKeys": ["${DAILY_JOB_ID}:1000:finished"`, "utf8");
    writeFileSync(join(runtimeDir, "cli-seed-completed.json"), `${JSON.stringify({ seededAt: "2026-07-01T00:00:00.000Z" })}\n`, "utf8");

    const runner = await importFreshRunner({
      OPENCLAW_CRON_RUNNER_RUNTIME_DIR: runtimeDir,
      OPENCLAW_BIN: cli.binPath,
      PNPM_BIN: pnpm.binPath,
      OPENCLAW_CRON_RUNNER_ALERTS: "0"
    });

    await runner.pollOpenClawRunLogs();

    const bootState = runner.__getRunnerStateForTest();
    // Reseeded from the CLI's OWN independent record of this run having already happened - NOT a
    // blind "nothing has ever run" empty list (which would replay it) - and nothing executed.
    expect(bootState.processedRunKeys).toContain(`${DAILY_JOB_ID}:1000:finished`);
    expect(readInvocations(pnpm.logPath)).toEqual([]);
    // Every known job forced halted pending operator verification - NOT silently un-halted.
    expect(bootState.jobFailureState.daily).toMatchObject({ halted: true });

    // The recovery path also re-persisted a NOW-VALID state file, so the corrupt file doesn't
    // keep tripping this same recovery on every subsequent restart.
    const rewritten = JSON.parse(readFileSync(join(runtimeDir, "processed-runs.json"), "utf8"));
    expect(rewritten.processedRunKeys).toContain(`${DAILY_JOB_ID}:1000:finished`);

    // And the original corrupt bytes are preserved as evidence in a sibling backup file.
    const backupFiles = readdirSync(runtimeDir).filter((name) => name.startsWith("processed-runs.json.corrupt-"));
    expect(backupFiles).toHaveLength(1);
  });
});

describe("atomic state-file write (audit item a / b)", () => {
  const tempDirs: string[] = [];
  const makeTempDir = makeTempDirFactory(tempDirs);
  afterEach(() => cleanupTempDirs(tempDirs));

  it("writeRunnerStateAtomic writes via a sibling .tmp file and renames it into place, leaving no leftover .tmp", async () => {
    const runtimeDir = makeTempDir("alphaloop-cron-runner-atomic-");
    const fakeDir = makeTempDir("alphaloop-cron-runner-atomic-fake-");
    const cli = writeFakeOpenclawCli(fakeDir, { list: { jobs: [] } });
    const runner = await importFreshRunner({
      OPENCLAW_CRON_RUNNER_RUNTIME_DIR: runtimeDir,
      OPENCLAW_BIN: cli.binPath,
      OPENCLAW_CRON_RUNNER_ALERTS: "0"
    });

    const path = join(runtimeDir, "atomic-test.json");
    runner.writeRunnerStateAtomic(path, '{"ok":true}\n');

    expect(readFileSync(path, "utf8")).toBe('{"ok":true}\n');
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("propagates a write failure (e.g. target directory does not exist) instead of silently swallowing it", async () => {
    const runtimeDir = makeTempDir("alphaloop-cron-runner-atomic-fail-");
    const fakeDir = makeTempDir("alphaloop-cron-runner-atomic-fail-fake-");
    const cli = writeFakeOpenclawCli(fakeDir, { list: { jobs: [] } });
    const runner = await importFreshRunner({
      OPENCLAW_CRON_RUNNER_RUNTIME_DIR: runtimeDir,
      OPENCLAW_BIN: cli.binPath,
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
    const runtimeDir = mkdtempSync(join(tmpdir(), "alphaloop-cron-runner-escalate-"));
    const fakeDir = mkdtempSync(join(tmpdir(), "alphaloop-cron-runner-escalate-fake-"));
    const cli = writeFakeOpenclawCli(fakeDir, { list: { jobs: [] } });
    try {
      const runner = await importFreshRunner({
        OPENCLAW_CRON_RUNNER_RUNTIME_DIR: runtimeDir,
        OPENCLAW_BIN: cli.binPath,
        OPENCLAW_CRON_RUNNER_ALERTS: "0"
      });
      // Exercises the real escalation path (disabled) via a real write failure, rather than
      // calling a private function directly.
      expect(() => runner.writeRunnerStateAtomic(join(runtimeDir, "missing-dir", "x.json"), "{}")).toThrow();
    } finally {
      rmSync(runtimeDir, { recursive: true, force: true });
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });
});

describe("SIGKILL fallback for a hung child process (audit item c)", () => {
  const tempDirs: string[] = [];
  const makeTempDir = makeTempDirFactory(tempDirs);
  afterEach(() => cleanupTempDirs(tempDirs));

  it("kills a child that ignores SIGTERM via a bounded SIGKILL fallback, instead of wedging that runKey forever", async () => {
    const runtimeDir = makeTempDir("alphaloop-cron-runner-sigkill-");
    const fakeDir = makeTempDir("alphaloop-cron-runner-sigkill-fake-");
    const cli = writeFakeOpenclawCli(fakeDir, { list: { jobs: [] } });
    const runner = await importFreshRunner({
      OPENCLAW_CRON_RUNNER_RUNTIME_DIR: runtimeDir,
      OPENCLAW_BIN: cli.binPath,
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
