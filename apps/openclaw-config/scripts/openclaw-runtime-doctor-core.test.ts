import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { createBrokerExecutorServer } from "../../broker-executor/dist/server.js";
import { openTradingDatabase } from "../../../packages/shared-types/dist/index.js";
import { runBackup } from "./backup-trading-data.mjs";
import { recordJobRun } from "./job-run-log.mjs";
import { buildManagedOpenClawCronJobs } from "./openclaw-cron-jobs.mjs";
import { saveSnapshot } from "./official-paper-monitor.mjs";

const doctor = await import("./openclaw-runtime-doctor-core.mjs");
const newsStore = await import("./news-store.mjs");

/**
 * H3 (2026-07-28, round-5): this file left the typecheck backlog. Most of its
 * 19 errors were three shapes, and each is fixed by asserting the thing the
 * checker could not assume rather than by widening a type until it goes quiet.
 *
 *  - `LAUNCHD_SERVICE_HEALTH[someLabel]` indexes an object whose keys are
 *    literal labels with a `string`, which is an implicit `any`. serviceHealth
 *    makes the missing entry a named failure instead.
 *  - `REQUIRED_LAUNCHD_JOBS`'s `domain` is inferred as `string | undefined`
 *    (buildRequiredLaunchdJobs maps it off a filtered row), so passing it where
 *    a domain is required has to say what happens when it is absent.
 *  - `noUncheckedIndexedAccess` makes every indexed row `T | undefined`; `at`
 *    reports WHICH row was missing rather than throwing "possibly undefined"
 *    into a matcher.
 */
function serviceHealth(label: string): { residency: string; probe: string } {
  const table = doctor.LAUNCHD_SERVICE_HEALTH as Record<string, { residency: string; probe: string } | undefined>;
  const entry = table[label];
  if (entry === undefined) {
    throw new Error(`LAUNCHD_SERVICE_HEALTH has no entry for ${label}`);
  }
  return entry;
}

function requiredDomain(job: { label: string; domain?: string | undefined }): string {
  if (job.domain === undefined) {
    throw new Error(`REQUIRED_LAUNCHD_JOBS entry ${job.label} carries no domain`);
  }
  return job.domain;
}

function at<T>(rows: readonly T[], index: number, what: string): T {
  const row = rows[index];
  if (row === undefined) {
    throw new Error(`${what}: expected a row at index ${index}, got ${rows.length} row(s)`);
  }
  return row;
}

// Shared "everything else is healthy" listener stub so the new task H2
// checks below (launchd-jobs / alerts-poller-health) can be asserted on in
// isolation, without the pre-existing gateway/runner checks also firing.
const CRON_RUNNER_HEALTH_STUBBED_OK = {
  cronRunnerHealthProbe: {
    ok: true,
    url: "http://127.0.0.1:18792/health",
    status: 200,
    body: { ok: true, service: "openclaw-cron-runner" }
  }
};

const HEALTHY_LISTENERS = {
  ...CRON_RUNNER_HEALTH_STUBBED_OK,
  gatewayListeners: [{ pid: 100, command: "node", endpoint: "127.0.0.1:18789" }],
  cronRunnerListeners: [{ pid: 200, command: "node", endpoint: "127.0.0.1:18792" }],
  memorydMcpProbe: { ok: true, url: "http://127.0.0.1:8766/mcp", serverName: "memoryd", sessionId: true }
};

// Round-3 finding F2: "everything is installed correctly" is now derived from
// the real REQUIRED_LAUNCHD_JOBS (itself read from install-launchd-ownership.txt)
// and built in the shape readLaunchdJobStates actually emits - the suite at
// the bottom of this file pins that shape against a REAL launchctl on the
// machine running the tests, so this fixture cannot quietly drift into an
// input no producer ever emits.
// Round-4 finding I5: "loaded" is no longer enough for this fixture to mean
// "healthy" - checkLaunchdJobs now also asserts on the runtime fields the
// probe collects. The healthy state differs per service and this fixture says
// so, exactly as the mini's real `launchctl print` does: KeepAlive services
// report `state = running` with a pid, scheduled ones report `state = not
// running` with `last exit code = 0` BETWEEN runs (measured 2026-07-28 on the
// mini: market-alerts runs=2945 last exit code=0, daily-backup runs=10 last
// exit code=0, official-paper poll/pnl runs=240/239 last exit code=0). The
// old fixture claimed `state: "running"` for all nine, which is a shape no
// real machine ever reports.
const ALL_LAUNCHD_JOBS_LOADED = doctor.REQUIRED_LAUNCHD_JOBS.map((job) => {
  const resident = serviceHealth(job.label).residency === "resident";
  return {
    label: job.label,
    expectedDomain: job.domain,
    loadedDomains: [job.domain],
    state: resident ? "running" : "not running",
    lastExitCode: resident ? null : 0,
    lastExitReason: null,
    pid: resident ? 4242 : null,
    runs: 7,
    stderrPath: `/tmp/${job.label}.err.log`
  };
});

/**
 * The same machine with these labels installed NOWHERE - an ordinary dev
 * laptop as far as those services are concerned. Round-5 finding D2: this is
 * what "unreachable is only a warn" now means, and it has to be stated by the
 * fixture instead of being the accidental default, because the same refused
 * connection on a machine where launchd IS holding the label is a failure.
 */
const launchdJobsWithout = (...labels: string[]) => ALL_LAUNCHD_JOBS_LOADED.map((row) => (labels.includes(row.label)
  ? { ...row, loadedDomains: [], state: null, lastExitCode: null, lastExitReason: null, pid: null, runs: null }
  : row));

/**
 * A machine where NONE of these labels is installed - which is what "an
 * ordinary dev laptop" actually looks like.
 *
 * Round-6 finding S3a made this distinction load-bearing, and doing so exposed
 * a fixture that had been describing the wrong machine. The
 * "warns on a dev box" cases below used `launchdJobsWithout(oneLabel)`, i.e.
 * EIGHT AlphaLoop daemons loaded and one absent, and called that "a machine
 * that never installed it". No dev laptop is in that state; a deploy machine
 * with one service missing is. Now that "installed nowhere" is an error on a
 * machine with a deploy footprint, those cases have to say which machine they
 * mean - so they say it with this.
 */
const NO_LAUNCHD_JOBS_LOADED = doctor.REQUIRED_LAUNCHD_JOBS.map((job) => ({
  label: job.label,
  expectedDomain: job.domain,
  loadedDomains: [] as string[],
  state: null,
  lastExitCode: null,
  lastExitReason: null,
  pid: null,
  runs: null,
  stderrPath: null
}));

// Round-4 finding I5: official-paper-health and daily-backup-health read the
// clock (the first only speaks during US regular market hours; the second
// compares backup file stamps against today's Asia/Shanghai date). Tests that
// supply a real dbPath/runtimeRoot but are NOT about those checks pin the
// clock to a Saturday, so this file cannot behave differently depending on
// what time of day the suite happens to run.
const OUTSIDE_MARKET_HOURS = { nowMs: Date.parse("2026-07-11T12:00:00.000Z") };

const otherDomain = (domain: string): string => (domain === "system" ? "user" : "system");

// analyzeOpenClawRuntimeSnapshot makes three real loopback HTTP calls
// (platform-app /health, broker-executor /health, RSSHub /healthz). Tests that
// are NOT about one of those probes have to neutralise it, or the suite's
// result would depend on whether a real `pnpm platform:dev` or rsshub
// container happens to be running on this machine - which on a dev box it
// often is.
//
// Until round 5 they were neutralised by pointing at port 1 and letting the
// connection be refused, because "unreachable" was always a warn. Round-5
// finding D2 made that severity depend on the launchd view: on a machine where
// launchd holds the label, a refused connection is now an ERROR, which is the
// entire point (it is what lets the deploy gate fail on a dead machine). So
// "every label loaded" + "nothing answers on any port" is no longer a healthy
// machine and cannot be this suite's neutral background.
//
// The three pins therefore answer instead of refusing - each on its OWN dead
// port, replying the way the corresponding real service does. Nothing here is
// taken on trust: the probe suites further down start REAL http servers and
// assert against those, and a test that starts one still reaches it (the stub
// only ever answers the three ports pinned here and delegates everything else
// to the real fetch).
const STUBBED_PLATFORM_APP_PORT = 1;
const STUBBED_BROKER_EXECUTOR_PORT = 2;
const STUBBED_RSSHUB_PORT = 3;

const STUBBED_PROBE_BODIES: Record<number, unknown> = {
  [STUBBED_PLATFORM_APP_PORT]: { ok: true, service: "platform-app" },
  [STUBBED_BROKER_EXECUTOR_PORT]: { ok: true, service: "broker-executor" },
  [STUBBED_RSSHUB_PORT]: { status: "ok" }
};

const stubbedLoopbackFetch = async (url: string, init?: unknown): Promise<unknown> => {
  const port = Number(new URL(String(url)).port);
  const body = STUBBED_PROBE_BODIES[port];
  if (body === undefined) {
    // A real server this test started. Not ours to answer.
    return fetch(String(url), init as RequestInit);
  }
  return { ok: true, status: 200, statusText: "OK", json: async () => body };
};

const PLATFORM_APP_HEALTH_STUBBED_OK = {
  ...CRON_RUNNER_HEALTH_STUBBED_OK,
  platformAppPort: STUBBED_PLATFORM_APP_PORT,
  fetchImpl: stubbedLoopbackFetch
};
const RSSHUB_HEALTH_STUBBED_OK = {
  ...CRON_RUNNER_HEALTH_STUBBED_OK,
  rsshubBaseUrl: `http://127.0.0.1:${STUBBED_RSSHUB_PORT}`,
  fetchImpl: stubbedLoopbackFetch
};
const BROKER_EXECUTOR_HEALTH_STUBBED_OK = {
  ...CRON_RUNNER_HEALTH_STUBBED_OK,
  brokerExecutorPort: STUBBED_BROKER_EXECUTOR_PORT,
  fetchImpl: stubbedLoopbackFetch
};

// v2 persona deployment fix: analyzeOpenClawRuntimeSnapshot now also checks
// that the control agent workspace's AGENTS.md (the persona file
// render-openclaw-config.mjs installs) exists and is non-empty - same
// hermetic-suite concern as PLATFORM_APP_HEALTH_STUBBED_OK /
// RSSHUB_HEALTH_STUBBED_OK above: whether the REAL ~/.openclaw/workspaces/
// control/AGENTS.md exists on the machine running this suite must not change
// any test's outcome. This fixture points every test that isn't specifically
// about that check at a temp file that exists and is non-empty; it outlives
// afterEach's per-test cleanup (module-scoped, removed once in afterAll).
const controlPersonaFixtureDir = mkdtempSync(join(tmpdir(), "alphaloop-doctor-persona-"));
const controlPersonaHealthyPath = join(controlPersonaFixtureDir, "AGENTS.md");
writeFileSync(controlPersonaHealthyPath, "# Trading Copilot\n\n人设已部署。\n");
const CONTROL_PERSONA_HEALTHY = { controlWorkspaceAgentsPath: controlPersonaHealthyPath };

afterAll(() => {
  rmSync(controlPersonaFixtureDir, { recursive: true, force: true });
});

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

describe("OpenClaw runtime doctor core", () => {
  it("flags gateway restart storms and failed runner results", async () => {
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      gatewayListeners: [
        { pid: 100, command: "node", endpoint: "127.0.0.1:18789" }
      ],
      gatewayErrorLines: [
        "Gateway failed to start: listen EADDRINUSE: address already in use 127.0.0.1:18789",
        "Gateway failed to start: listen EADDRINUSE: address already in use 127.0.0.1:18789"
      ],
      cronRunnerListeners: [
        { pid: 200, command: "node", endpoint: "127.0.0.1:18792" }
      ],
      recentRunnerResults: [
        { job: "daily", ok: false, error: "Longbridge unavailable", file: "daily.json" }
      ]
    });

    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "gateway.restart_storm", severity: "error" }),
      expect.objectContaining({ code: "runner.recent_failure", severity: "error" })
    ]));
  });

  it("accepts the desired steady state", async () => {
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      gatewayListeners: [{ pid: 100, command: "node", endpoint: "127.0.0.1:18789" }],
      gatewayErrorLines: [],
      cronRunnerListeners: [{ pid: 200, command: "node", endpoint: "127.0.0.1:18792" }],
      recentRunnerResults: [{ job: "daily", ok: true, file: "daily.json" }]
    });

    expect(report.ok).toBe(true);
    expect(report.findings.every((finding) => finding.severity !== "error")).toBe(true);
  });

  it("does not keep failing a job after a newer successful runner result", async () => {
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      gatewayListeners: [{ pid: 100, command: "node", endpoint: "127.0.0.1:18789" }],
      gatewayErrorLines: [],
      cronRunnerListeners: [{ pid: 200, command: "node", endpoint: "127.0.0.1:18792" }],
      recentRunnerResults: [
        { job: "daily", ok: true, file: "daily-success.json" },
        { job: "daily", ok: false, error: "old Longbridge outage", file: "daily-failure.json" }
      ]
    });

    expect(report.ok).toBe(true);
  });

  it("ignores stale gateway restart errors outside the recent window", async () => {
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      nowMs: Date.parse("2026-06-19T12:10:00.000Z"),
      gatewayListeners: [{ pid: 100, command: "node", endpoint: "127.0.0.1:18789" }],
      gatewayErrorLines: [
        "2026-06-19T12:00:00.000+08:00 Gateway failed to start: listen EADDRINUSE: address already in use 127.0.0.1:18789",
        "2026-06-19T12:00:11.000+08:00 Gateway failed to start: listen EADDRINUSE: address already in use 127.0.0.1:18789"
      ],
      cronRunnerListeners: [{ pid: 200, command: "node", endpoint: "127.0.0.1:18792" }],
      recentRunnerResults: [{ job: "daily", ok: true, file: "daily-success.json" }]
    });

    expect(report.ok).toBe(true);
  });
});

describe("launchd-jobs check (task H2, rebuilt for round-3 finding F2: domain-aware)", () => {
  it("requires every service the ownership manifest names, in the domain that manifest assigns it", () => {
    // The pre-F2 list named four labels and no domain, so the six services
    // ac741d8 promoted to /Library/LaunchDaemons were either absent from the
    // doctor entirely (cron-runner, official-paper poll+pnl, gateway,
    // broker-executor) or checked in the wrong place.
    expect(doctor.REQUIRED_LAUNCHD_JOBS).toEqual([
      { label: "ai.openclaw.system.gateway", domain: "system", slug: "gateway" },
      { label: "com.openclaw.system.trading.broker-executor", domain: "system", slug: "broker-executor" },
      { label: "com.alphaloop.platform-app", domain: "system", slug: "platform-app" },
      { label: "com.alphaloop.memoryd", domain: "system", slug: "memoryd" },
      { label: "com.alphaloop.market-alerts", domain: "system", slug: "market-alerts" },
      { label: "com.alphaloop.daily-backup", domain: "system", slug: "daily-backup" },
      { label: "com.openclaw.trading.cron-runner", domain: "system", slug: "cron-runner" },
      { label: "com.openclaw.trading.official-paper.poll", domain: "system", slug: "official-paper.poll" },
      { label: "com.openclaw.trading.official-paper.pnl", domain: "system", slug: "official-paper.pnl" },
      { label: "com.alphaloop.rsshub", domain: "system", slug: "rsshub" }
    ]);
  });

  it("warns, but does not fail, when none of the required jobs are loaded (a dev machine)", async () => {
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: doctor.REQUIRED_LAUNCHD_JOBS.map((job) => ({
        label: job.label,
        expectedDomain: job.domain,
        loadedDomains: [],
        state: null
      }))
    });

    expect(report.ok).toBe(true);
    for (const job of doctor.REQUIRED_LAUNCHD_JOBS) {
      expect(report.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: `launchd-jobs.${job.slug}.not_loaded`, severity: "warn" })
      ]));
    }
  });

  it("names the installer that really installs each domain, not one that installs it nowhere", async () => {
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: doctor.REQUIRED_LAUNCHD_JOBS.map((job) => ({
        label: job.label,
        expectedDomain: job.domain,
        loadedDomains: [],
        state: null
      }))
    });

    const messageFor = (slug: string): string =>
      report.findings.find((finding: { code: string }) => finding.code === `launchd-jobs.${slug}.not_loaded`)?.message ?? "";

    // The old hint sent every missing job to launchd:install-backup-alerts,
    // which after ac741d8 installs ONLY user-scoped labels - so for a system
    // daemon it was a command that installs it nowhere.
    expect(messageFor("platform-app")).toContain("sudo zsh apps/openclaw-config/scripts/install-system-daemons.sh");
    expect(messageFor("platform-app")).not.toContain("launchd:install-backup-alerts");
    expect(messageFor("cron-runner")).toContain("sudo zsh apps/openclaw-config/scripts/install-system-daemons.sh");
    expect(messageFor("rsshub")).toContain("sudo zsh apps/openclaw-config/scripts/install-system-daemons.sh");
    expect(messageFor("rsshub")).not.toContain("launchd:install-backup-alerts");
  });

  it("reports nothing once every job is loaded in its own domain", async () => {
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED
    });

    expect(report.ok).toBe(true);
    expect(report.findings.some((finding: { code: string }) => finding.code.startsWith("launchd-jobs."))).toBe(false);
  });

  // The regression this whole finding is about: a system daemon that IS
  // loaded and running is invisible to `launchctl list`. Before F2 the doctor
  // read only that command, so a correctly installed machine got a permanent
  // "not loaded" warn for every promoted service.
  it("does not report a correctly installed system daemon as missing", async () => {
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED
    });

    expect(report.findings.some((finding: { code: string }) => finding.code === "launchd-jobs.platform-app.not_loaded")).toBe(false);
    expect(report.findings.some((finding: { code: string }) => finding.code === "launchd-jobs.official-paper.poll.not_loaded")).toBe(false);
  });

  it("fails when a job is loaded in the wrong domain - the state the mini is in until the runbook is run there", async () => {
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: doctor.REQUIRED_LAUNCHD_JOBS.map((job) => ({
        label: job.label,
        expectedDomain: job.domain,
        // Exactly what `ls ~/Library/LaunchAgents` shows on the mini today:
        // every promoted service still user-level.
        loadedDomains: [otherDomain(requiredDomain(job))],
        state: "running"
      }))
    });

    expect(report.ok).toBe(false);
    const wrong = report.findings.find((finding: { code: string }) => finding.code === "launchd-jobs.cron-runner.wrong_domain");
    expect(wrong).toMatchObject({ severity: "error" });
    expect(wrong?.message).toContain("sudo zsh apps/openclaw-config/scripts/install-system-daemons.sh");
  });

  it("fails when both domains hold the same label, because two owners race one database", async () => {
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED.map((row) =>
        row.label === "com.openclaw.system.trading.broker-executor"
          ? { ...row, loadedDomains: ["system", "user"] }
          : row)
    });

    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "launchd-jobs.broker-executor.wrong_domain", severity: "error" })
    ]));
  });

  it("says so instead of staying silent when the probe produced no row for a job", async () => {
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: []
    });

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "launchd-jobs.rsshub.unknown", severity: "warn" })
    ]));
  });
});

// Round-3 finding F2's premise, re-proved on whatever machine runs this suite
// rather than taken on trust: `launchctl list` reports ONLY the caller's
// gui/$UID domain, so a loaded system daemon is invisible to it. These tests
// drive the REAL readLaunchdJobStates (the exact function
// openclaw-runtime-doctor.mjs calls) against the REAL launchctl, using labels
// discovered from this machine at run time - no recorded fixture, no
// hand-written "what launchctl probably prints".
describe("readLaunchdJobStates against the real launchctl (round-3 finding F2)", () => {
  const launchctlList = execFileSync("launchctl", ["list"], { encoding: "utf8" });
  const userDomainLabels = new Set(
    launchctlList.split(/\r?\n/u).slice(1).map((line) => line.trim().split(/\s+/u).at(-1)).filter(Boolean) as string[]
  );
  // Every label the SYSTEM domain currently holds, straight from
  // `launchctl print system` (its job table is the last column of the
  // "<pid> <status> <label>" rows).
  const systemDomainLabels = execFileSync("launchctl", ["print", "system"], { encoding: "utf8" })
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^(?:\d+|-)\s+(?:\d+|-)\s+\S+$/u.test(line))
    .map((line) => line.split(/\s+/u).at(-1) as string);

  it("proves the premise: system-domain daemons never show up in `launchctl list`", () => {
    const systemOnly = systemDomainLabels.filter((label) => !userDomainLabels.has(label));
    expect(systemOnly.length).toBeGreaterThan(0);
    expect(systemDomainLabels.length).toBeGreaterThan(0);
  });

  it("finds a real system daemon in the system domain and a real agent in the user domain", () => {
    const systemLabel = systemDomainLabels.find((label) => !userDomainLabels.has(label)) as string;
    const userLabel = [...userDomainLabels].find((label) => !systemDomainLabels.includes(label)) as string;

    const rows = doctor.readLaunchdJobStates([
      { label: systemLabel, domain: "system", slug: "sys" },
      { label: userLabel, domain: "user", slug: "usr" },
      { label: "com.alphaloop.definitely-not-installed-anywhere", domain: "system", slug: "missing" }
    ]);
    const systemRow = at(rows, 0, "readLaunchdJobStates(system label)");
    const userRow = at(rows, 1, "readLaunchdJobStates(user label)");
    const missingRow = at(rows, 2, "readLaunchdJobStates(label installed nowhere)");

    expect(systemRow.loadedDomains).toEqual(["system"]);
    expect(typeof systemRow.state).toBe("string");
    expect(userRow.loadedDomains).toEqual(["user"]);
    expect(missingRow.loadedDomains).toEqual([]);
    expect(missingRow.state).toBeNull();
  });

  // The end-to-end statement: feed the REAL probe's output straight into the
  // REAL check. On a dev machine that is nine warns and ok:true - the point
  // being that the wiring between producer and consumer holds without a
  // hand-authored snapshot in between.
  it("feeds the real probe's output into the real check without a hand-written snapshot", async () => {
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: doctor.readLaunchdJobStates()
    });

    expect(report.findings.some((finding: { code: string }) => finding.code.endsWith(".unknown"))).toBe(false);
    for (const finding of report.findings.filter((entry: { code: string }) => entry.code.startsWith("launchd-jobs."))) {
      expect(finding.code).toMatch(/\.(?:not_loaded|wrong_domain)$/u);
    }
  });
});

// Round-4 finding I5. Captured VERBATIM from the mini on 2026-07-28 with
// `launchctl print gui/501/com.alphaloop.rsshub` (read-only ssh, nothing was
// written there). Not hand-authored: it is what the real producer emits for
// a scheduled job whose last run FAILED - the exact case the pre-I5 doctor
// reported as perfectly healthy, because it only ever looked at
// `loadedDomains`. It is also the case that breaks a naive `state` regex: the
// job's own `state = not running` sits at one tab, and two more `state =
// active` lines sit at two tabs inside the coalition dicts further down.
const MINI_RSSHUB_PRINT_FAILED = `gui/501/com.alphaloop.rsshub = {
	active count = 0
	path = /Users/qingchang/Library/LaunchAgents/com.alphaloop.rsshub.plist
	type = LaunchAgent
	state = not running

	program = /bin/zsh
	arguments = {
		/bin/zsh
		-lc
		export PATH="$HOME/.local/node-v24/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"; cd "/Users/qingchang/AlphaLoop" && docker start rsshub
	}

	working directory = /Users/qingchang/AlphaLoop

	stdout path = /Users/qingchang/AlphaLoop/logs/rsshub.log
	stderr path = /Users/qingchang/AlphaLoop/logs/rsshub.err.log
	inherited environment = {
		SSH_AUTH_SOCK => /var/run/com.apple.launchd.dvs9W2Dl02/Listeners
	}

	default environment = {
		PATH => /usr/bin:/bin:/usr/sbin:/sbin
	}

	environment = {
		OSLogRateLimit => 64
		XPC_SERVICE_NAME => com.alphaloop.rsshub
	}

	domain = gui/501 [100015]
	asid = 100015
	minimum runtime = 10
	exit timeout = 5
	runs = 1
	last exit code = 1

	resource coalition = {
		ID = 338238
		type = resource
		state = active
		active count = 1
		name = com.alphaloop.rsshub
	}

	jetsam coalition = {
		ID = 338239
		type = jetsam
		state = active
		active count = 1
		name = com.alphaloop.rsshub
	}

	spawn type = daemon (3)
	jetsam priority = 40
	jetsam memory limit (active) = (unlimited)
	jetsam memory limit (inactive) = (unlimited)
	jetsamproperties category = daemon
	submitted job. ignore execute allowed
	jetsam thread limit = 32
	cpumon = default

	properties = runatload | inferred program
}
`;

// The same capture with the two lines that differ on a healthy run swapped
// for the values the mini's OTHER scheduled agents really report (measured in
// the same session: market-alerts `runs = 2945` / `last exit code = 0`,
// daily-backup `runs = 10` / `last exit code = 0`).
const MINI_RSSHUB_PRINT_OK = MINI_RSSHUB_PRINT_FAILED.replace("\tlast exit code = 1", "\tlast exit code = 0");

// A resident daemon that is up, in the shape `launchctl print system/<label>`
// really answers - measured on the mini for ai.openclaw.system.gateway
// (`state = running`, `runs = 10`, `pid = 21802`, `last exit code = 0`).
//
// Corrected 2026-07-28 (round-4 verification): this comment used to claim the
// mini printed "no `last exit code` line at all while it has never exited",
// which the fixture below contradicts on its own - and re-measuring
// `launchctl print system/ai.openclaw.system.gateway` on the mini shows the
// line IS there (`last exit code = 0`). The job that genuinely has no such
// line is com.alphaloop.platform-app, which is what describeLaunchdExit's
// comment in openclaw-runtime-doctor-core.mjs refers to; both shapes were
// re-measured read-only on 2026-07-28 and both are exercised below - the
// crashed-and-restarted case rewrites this line to `= 1`, and the
// no-exit-code case deletes it outright (`.replace("\tlast exit code = 0\n",
// "")`).
const MINI_RESIDENT_PRINT_RUNNING = `system/ai.openclaw.system.gateway = {
	active count = 1
	path = /Library/LaunchDaemons/ai.openclaw.system.gateway.plist
	type = LaunchDaemon
	state = running

	stdout path = /Users/qingchang/.openclaw/logs/gateway.system.log
	stderr path = /Users/qingchang/.openclaw/logs/gateway.system.err.log
	domain = system
	username = qingchang
	group = staff

	minimum runtime = 10
	exit timeout = 5
	runs = 10
	pid = 21802
	last exit code = 0

	resource coalition = {
		ID = 338240
		type = resource
		state = active
		active count = 1
		name = ai.openclaw.system.gateway
	}
}
`;

// Drives the REAL readLaunchdJobStates with a stub `launchctl` that replays
// real captured text, so the scenarios below go through the real parser and
// the real check - no hand-written snapshot rows in between.
function replayLaunchctl(options: {
  userLabels: string[];
  systemLabels: string[];
  textFor?: (domain: "user" | "system", label: string) => string;
}) {
  const text = options.textFor ?? (() => MINI_RESIDENT_PRINT_RUNNING);
  return (args: string[]): string | null => {
    if (args[0] === "list") {
      return ["PID\tStatus\tLabel", ...options.userLabels.map((label) => `-\t0\t${label}`)].join("\n");
    }
    const target = String(args[1] ?? "");
    const label = target.replace(/^system\//u, "").replace(/^gui\/\d+\//u, "");
    if (target.startsWith("system/")) {
      return options.systemLabels.includes(label) ? text("system", label) : null;
    }
    return options.userLabels.includes(label) ? text("user", label) : null;
  };
}

// Deliberately tolerant: called with whatever label the probe stub is asked
// about, including ones outside the manifest, which are simply not resident.
const isResident = (label: string): boolean =>
  (doctor.LAUNCHD_SERVICE_HEALTH as Record<string, { residency: string } | undefined>)[label]?.residency === "resident";

const REQUIRED_LABELS = doctor.REQUIRED_LAUNCHD_JOBS.map((job: { label: string }) => job.label);
const SYSTEM_LABELS = doctor.REQUIRED_LAUNCHD_JOBS
  .filter((job) => job.domain === "system")
  .map((job) => job.label);

// Round-7 finding K6: a restart count is judged against the window since the
// install that reset it, which the doctor reads from the ledger's newest
// successful step-3 receipt. A machine installed an hour ago is the setting in
// which `runs = 918` means a crash loop; the same count against a two-month-old
// receipt, or against no receipt at all, does not - see "will not call a
// restart count a loop when it has no window to have happened in".
const installedAgo = (ms: number, nowMs = OUTSIDE_MARKET_HOURS.nowMs) => [{
  attempt: "r7-window",
  step: 3,
  key: "install-system-daemons",
  exitCode: 0,
  finishedAt: new Date(nowMs - ms).toISOString()
}];
const HOUR_MS = 60 * 60 * 1000;
const INSTALLED_AN_HOUR_AGO = installedAgo(HOUR_MS);

async function analyzeLaunchdOnly(launchdJobs: unknown[], extra: Record<string, unknown> = {}) {
  return doctor.analyzeOpenClawRuntimeSnapshot({
    ...CONTROL_PERSONA_HEALTHY,
    ...HEALTHY_LISTENERS,
    ...PLATFORM_APP_HEALTH_STUBBED_OK,
    ...RSSHUB_HEALTH_STUBBED_OK,
    ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
    ...OUTSIDE_MARKET_HOURS,
    deployLedger: INSTALLED_AN_HOUR_AGO,
    launchdJobs,
    ...extra
  });
}

const launchdFindings = (report: { findings: Array<{ code: string; severity: string; message: string }> }) =>
  report.findings.filter((finding) => finding.code.startsWith("launchd-jobs."));

describe("launchd runtime state (round-4 finding I5: 'loaded' is not 'working')", () => {
  it("gives every label in the ownership manifest a health definition, and nothing else", () => {
    expect(Object.keys(doctor.LAUNCHD_SERVICE_HEALTH).sort()).toEqual([...REQUIRED_LABELS].sort());
    for (const [label, contract] of Object.entries(doctor.LAUNCHD_SERVICE_HEALTH)) {
      expect(["resident", "periodic"], label).toContain((contract as { residency: string }).residency);
      expect((contract as { probe: string }).probe.length, label).toBeGreaterThan(0);
    }
  });

  it("parses the mini's real `launchctl print` output, and is not fooled by the nested `state = active` lines", () => {
    const parsedRow = at(doctor.readLaunchdJobStates(
      [{ label: "com.alphaloop.rsshub", domain: "user", slug: "rsshub" }],
      replayLaunchctl({
        userLabels: ["com.alphaloop.rsshub"],
        systemLabels: [],
        textFor: () => MINI_RSSHUB_PRINT_FAILED
      })
    ), 0, "readLaunchdJobStates(the mini's real rsshub print output)");

    expect(parsedRow.state).toBe("not running");
    expect(parsedRow.lastExitCode).toBe(1);
    expect(parsedRow.runs).toBe(1);
    expect(parsedRow.pid).toBeNull();
    expect(parsedRow.stderrPath).toBe("/Users/qingchang/AlphaLoop/logs/rsshub.err.log");
  });

  it("REPLAY - the mini before the migration: seven wrong_domain errors, plus the one job whose last run really failed", async () => {
    // The mini's actual pre-migration layout, measured read-only on
    // 2026-07-28: seven user-level agents (all of them labels that now belong
    // in the system domain), two real system daemons, and rsshub - which
    // exits 1 every time, because its body is
    // `docker start rsshub`.
    const userLabels = [
      "com.alphaloop.daily-backup",
      "com.alphaloop.market-alerts",
      "com.alphaloop.platform-app",
      "com.alphaloop.rsshub",
      "com.openclaw.trading.cron-runner",
      "com.openclaw.trading.official-paper.poll",
      "com.openclaw.trading.official-paper.pnl"
    ];
    const jobs = doctor.readLaunchdJobStates(
      doctor.REQUIRED_LAUNCHD_JOBS,
      replayLaunchctl({
        userLabels,
        systemLabels: ["ai.openclaw.system.gateway", "com.openclaw.system.trading.broker-executor"],
        textFor: (_domain, label) => (label === "com.alphaloop.rsshub"
          ? MINI_RSSHUB_PRINT_FAILED
          : MINI_RESIDENT_PRINT_RUNNING)
      })
    );

    const findings = launchdFindings(await analyzeLaunchdOnly(jobs));
    expect(findings.filter((finding) => finding.code.endsWith(".wrong_domain"))).toHaveLength(7);
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "launchd-jobs.rsshub.last_run_failed", severity: "error" })
    ]));
    expect(findings).toHaveLength(9);
  });

  it("REPLAY - after the migration, with every service actually up: zero launchd findings", async () => {
    const jobs = doctor.readLaunchdJobStates(
      doctor.REQUIRED_LAUNCHD_JOBS,
      replayLaunchctl({
        userLabels: [],
        systemLabels: SYSTEM_LABELS,
        textFor: (_domain, label) => (label === "com.alphaloop.rsshub"
          ? MINI_RSSHUB_PRINT_OK
          : MINI_RESIDENT_PRINT_RUNNING)
      })
    );

    expect(launchdFindings(await analyzeLaunchdOnly(jobs))).toEqual([]);
  });

  it("REPLAY - the defect: every label bootstrapped in the right domain but crash-looping is NOT a pass", async () => {
    // This is the state that used to produce zero launchd findings and let
    // the deploy runbook's acceptance step certify a machine on which nothing
    // works: all nine labels bootstrapped where they belong, every one of them
    // reporting `state = not running` / `last exit code = 1`.
    const jobs = doctor.readLaunchdJobStates(
      doctor.REQUIRED_LAUNCHD_JOBS,
      replayLaunchctl({
        userLabels: [],
        systemLabels: SYSTEM_LABELS,
        textFor: () => MINI_RSSHUB_PRINT_FAILED
      })
    );

    const report = await analyzeLaunchdOnly(jobs);
    const findings = launchdFindings(report);

    expect(report.ok).toBe(false);
    expect(findings.every((finding) => finding.severity === "error")).toBe(true);
    expect(findings).toHaveLength(REQUIRED_LABELS.length);
    // The four KeepAlive services are called out for being DOWN; the five
    // scheduled ones for their last run having failed. "state = not running"
    // alone must never fail a scheduled job - see the healthy replay above,
    // where the same five report exactly that and produce nothing.
    expect(findings.filter((finding) => finding.code.endsWith(".not_running")).map((f) => f.code).sort()).toEqual([
      "launchd-jobs.broker-executor.not_running",
      "launchd-jobs.cron-runner.not_running",
      "launchd-jobs.gateway.not_running",
      "launchd-jobs.memoryd.not_running",
      "launchd-jobs.platform-app.not_running"
    ]);
    expect(findings.filter((finding) => finding.code.endsWith(".last_run_failed"))).toHaveLength(5);
    // The remediation has to be actionable and correct for the CURRENT
    // installer, not the retired user-level one.
    const platformApp = findings.find((finding) => finding.code === "launchd-jobs.platform-app.not_running");
    expect(platformApp?.message).toContain("sudo zsh apps/openclaw-config/scripts/install-system-daemons.sh");
    expect(platformApp?.message).toContain("/Users/qingchang/AlphaLoop/logs/rsshub.err.log");
    expect(platformApp?.message).not.toContain("launchd:install-backup-alerts");
  });

  it("warns rather than failing when a KeepAlive service is up but has crashed before", async () => {
    const jobs = doctor.readLaunchdJobStates(
      doctor.REQUIRED_LAUNCHD_JOBS,
      replayLaunchctl({
        userLabels: [],
        systemLabels: SYSTEM_LABELS,
        // Only the KeepAlive services carry the crashed-and-restarted text;
        // the scheduled ones stay on their real healthy shape, so this test
        // isolates the resident case instead of tripping five other findings.
        textFor: (_domain, label) => (isResident(label)
          ? MINI_RESIDENT_PRINT_RUNNING.replace("\tlast exit code = 0", "\tlast exit code = 1")
          : MINI_RSSHUB_PRINT_OK)
      })
    );

    const report = await analyzeLaunchdOnly(jobs);
    expect(report.ok).toBe(true);
    expect(launchdFindings(report).map((finding) => finding.code).sort()).toEqual([
      "launchd-jobs.broker-executor.restarted_after_failure",
      "launchd-jobs.cron-runner.restarted_after_failure",
      "launchd-jobs.gateway.restarted_after_failure",
      "launchd-jobs.memoryd.restarted_after_failure",
      "launchd-jobs.platform-app.restarted_after_failure"
    ]);
  });

  // Round-5 finding D2, second half. The sample a crash loop actually hands
  // you is not `state = not running` - launchd restarts the job, so most of
  // the time you catch it a few hundred ms into an instance that is about to
  // die again: `state = running`, `last exit code = 1`, and a `runs` counter
  // in the hundreds. That read as `restarted_after_failure`, a warn, and the
  // gate passed.
  it("FAILS a KeepAlive service whose runs counter shows it is looping, not merely scarred", async () => {
    const jobs = doctor.readLaunchdJobStates(
      doctor.REQUIRED_LAUNCHD_JOBS,
      replayLaunchctl({
        userLabels: [],
        systemLabels: SYSTEM_LABELS,
        textFor: (_domain, label) => (isResident(label)
          ? MINI_RESIDENT_PRINT_RUNNING
            .replace("\tlast exit code = 0", "\tlast exit code = 1")
            .replace("\truns = 10", "\truns = 918")
          : MINI_RSSHUB_PRINT_OK)
      })
    );

    const report = await analyzeLaunchdOnly(jobs);
    expect(report.ok).toBe(false);
    expect(launchdFindings(report).map((finding) => finding.code).sort()).toEqual([
      "launchd-jobs.broker-executor.crash_looping",
      "launchd-jobs.cron-runner.crash_looping",
      "launchd-jobs.gateway.crash_looping",
      "launchd-jobs.memoryd.crash_looping",
      "launchd-jobs.platform-app.crash_looping"
    ]);
    const platformApp = launchdFindings(report).find((f) => f.code === "launchd-jobs.platform-app.crash_looping");
    expect(platformApp?.severity).toBe("error");
    expect(platformApp?.message).toContain("918");
  });

  // Round-7 finding K6. The same 918 relaunches, with the two other windows
  // this machine can be in. MEASURED on the deploy target (2026-07-29,
  // read-only): the gateway is at runs = 10 with a process alive 10 days, so a
  // count-only rule reaches 20 through ordinary restarts and then calls a
  // perfectly healthy machine a crash loop forever.
  it("will not call a restart count a loop when it has no window to have happened in", async () => {
    const looping = (label: string) => label === "com.alphaloop.platform-app";
    const jobs = doctor.readLaunchdJobStates(
      doctor.REQUIRED_LAUNCHD_JOBS,
      replayLaunchctl({
        userLabels: [],
        systemLabels: SYSTEM_LABELS,
        textFor: (_domain, label) => (isResident(label)
          ? MINI_RESIDENT_PRINT_RUNNING.replace("\truns = 10", looping(label) ? "\truns = 918" : "\truns = 2")
          : MINI_RSSHUB_PRINT_OK)
      })
    );

    // (a) no receipt at all: the reset moment is unknown, so the count cannot
    //     be timed - a warn that says so, not an error that guesses.
    const noLedger = await analyzeLaunchdOnly(jobs, { deployLedger: [] });
    const unknownWindow = launchdFindings(noLedger).find((f) => f.code === "launchd-jobs.platform-app.restarted_many_times");
    expect(unknownWindow?.severity).toBe("warn");
    expect(unknownWindow?.message).toMatch(/没有「上次装系统 daemon 是什么时候」的收据/u);
    expect(noLedger.findings.some((f) => f.code.endsWith(".crash_looping"))).toBe(false);

    // (b) installed two months ago: 918 restarts spread over that is still
    //     worth a word, and still not a loop.
    const old = await analyzeLaunchdOnly(jobs, {
      deployLedger: installedAgo(60 * 24 * HOUR_MS)
    });
    const longAgo = launchdFindings(old).find((f) => f.code === "launchd-jobs.platform-app.restarted_many_times");
    expect(longAgo?.severity).toBe("warn");
    expect(longAgo?.message).toMatch(/60 天/u);

    // (c) installed an hour ago: same number, and now it IS a loop.
    const fresh = await analyzeLaunchdOnly(jobs);
    const loop = launchdFindings(fresh).find((f) => f.code === "launchd-jobs.platform-app.crash_looping");
    expect(loop?.severity).toBe("error");
    expect(loop?.message).toMatch(/1 小时/u);
    expect(fresh.ok).toBe(false);
  });

  it("does not invent an exit code launchd never reported (a signal-killed job prints none)", async () => {
    // Measured on the mini: com.alphaloop.platform-app was last terminated by
    // SIGTERM (`launchctl list` status -15) and its `launchctl print` output
    // carries NO `last exit code` line at all. Defaulting that to 0 would
    // claim a clean exit launchd never reported; treating it as a failure
    // would invent one. It must simply not be judged.
    const withoutExitCode = MINI_RESIDENT_PRINT_RUNNING.replace("\tlast exit code = 0\n", "");
    const jobs = doctor.readLaunchdJobStates(
      doctor.REQUIRED_LAUNCHD_JOBS,
      replayLaunchctl({
        userLabels: [],
        systemLabels: SYSTEM_LABELS,
        textFor: (_domain, label) => (isResident(label) ? withoutExitCode : MINI_RSSHUB_PRINT_OK)
      })
    );

    expect(jobs.find((row: { label: string }) => row.label === "com.alphaloop.platform-app")).toMatchObject({
      state: "running",
      lastExitCode: null
    });
    expect(launchdFindings(await analyzeLaunchdOnly(jobs))).toEqual([]);
  });

  it("stays silent for a snapshot from a caller that predates these fields", async () => {
    // Forward/backward compatibility: `state`/`lastExitCode` absent means the
    // probe never reported them, which must read as "not observed", never as
    // "observed to be broken".
    const legacyRows = doctor.REQUIRED_LAUNCHD_JOBS.map((job) => ({
      label: job.label,
      expectedDomain: requiredDomain(job),
      loadedDomains: [requiredDomain(job)]
    }));

    expect(launchdFindings(await analyzeLaunchdOnly(legacyRows))).toEqual([]);
  });
});

describe("alerts-poller-health check (task H2)", () => {
  it("fails when runtime/market-alerts/ALERTER-DOWN.json exists, even with no dbPath supplied at all", async () => {
    const runtimeRoot = makeTempDir("alphaloop-doctor-runtime-");
    mkdirSync(join(runtimeRoot, "market-alerts"), { recursive: true });
    writeFileSync(
      join(runtimeRoot, "market-alerts", "ALERTER-DOWN.json"),
      JSON.stringify({
        since: "2026-07-10T00:00:00.000Z",
        reason: "send_failed",
        consecutiveFailures: 5,
        lastError: "Feishu 发送失败",
        lastAttemptAt: "2026-07-13T00:00:00.000Z"
      })
    );

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      runtimeRoot
      // No dbPath at all - this check must work even when the db is the
      // thing that's broken (see market-alerts-poll.mjs's markAlerterDown).
    });

    expect(report.ok).toBe(false);
    const finding = report.findings.find((entry) => entry.code === "alerts-poller-health.alerter_down");
    expect(finding).toBeTruthy();
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("since=2026-07-10T00:00:00.000Z");
    expect(finding?.message).toContain("reason=send_failed");
    expect(finding?.message).toContain("5");
  });

  it("fails gracefully (never throws) when the trading db cannot even be opened", async () => {
    const dir = makeTempDir("alphaloop-doctor-db-");
    const dbPath = join(dir, "trading.sqlite");
    writeFileSync(dbPath, "not a real sqlite file, just garbage bytes");

    // Directly awaited (not wrapped in expect(...).not.toThrow(), which only
    // checks for a SYNCHRONOUS throw and would not actually wait for this
    // async function's promise to settle) - a rejection here would fail this
    // test itself, which is exactly the "never throws" proof this test wants.
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      ...OUTSIDE_MARKET_HOURS,
      dbPath
    });

    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "alerts-poller-health.db_unreachable", severity: "error" })
    ]));
  });

  it("warns that the poller has never run when run_log has zero market-alerts rows", async () => {
    const dir = makeTempDir("alphaloop-doctor-db-");
    const dbPath = join(dir, "trading.sqlite");
    // Opens (creating the schema via migrate()) and closes immediately -
    // analyzeOpenClawRuntimeSnapshot re-opens it itself from dbPath, exactly
    // like a fresh install that has never run the poller.
    openTradingDatabase(dbPath).close();

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      nowMs: Date.parse("2026-07-11T12:00:00.000Z"), // Saturday - outside market hours
      dbPath
    });

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "alerts-poller-health.never_ran", severity: "warn" })
    ]));
  });

  it("warns when the last market-alerts run is stale during US regular market hours", async () => {
    const dir = makeTempDir("alphaloop-doctor-db-");
    const dbPath = join(dir, "trading.sqlite");
    const db = openTradingDatabase(dbPath);
    recordJobRun(db, {
      job: "market-alerts",
      startedAt: "2026-07-13T14:00:00.000Z",
      finishedAt: "2026-07-13T14:00:01.000Z",
      ok: true
    });
    db.close();

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      nowMs: Date.parse("2026-07-13T15:00:00.000Z"), // Monday 11:00am US Eastern (EDT) - regular market hours
      dbPath
    });

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "alerts-poller-health.stale_heartbeat", severity: "warn" })
    ]));
  });

  it("accepts five minutes of clock skew but warns on a farther-future market-alerts heartbeat", async () => {
    const nowMs = Date.parse("2026-07-13T15:00:00.000Z"); // regular market hours
    const runDoctor = async (offsetMs: number) => {
      const dbPath = join(makeTempDir("alphaloop-doctor-db-"), "trading.sqlite");
      const db = openTradingDatabase(dbPath);
      const startedAt = new Date(nowMs + offsetMs).toISOString();
      recordJobRun(db, { job: "market-alerts", startedAt, finishedAt: startedAt, ok: true });
      db.close();
      return doctor.analyzeOpenClawRuntimeSnapshot({
        ...CONTROL_PERSONA_HEALTHY,
        ...HEALTHY_LISTENERS,
        ...PLATFORM_APP_HEALTH_STUBBED_OK,
        ...RSSHUB_HEALTH_STUBBED_OK,
        ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
        launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
        nowMs,
        dbPath
      });
    };

    const withinReport = await runDoctor(4 * 60_000);
    expect(withinReport.findings.some((entry) => entry.code === "alerts-poller-health.stale_heartbeat")).toBe(false);

    const futureReport = await runDoctor(6 * 60_000);
    expect(futureReport.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "alerts-poller-health.stale_heartbeat", severity: "warn" })
    ]));
    expect(futureReport.findings.find((entry) => entry.code === "alerts-poller-health.stale_heartbeat")?.message)
      .toContain("5 分钟时钟偏差");
  });

  it("does not warn about a stale heartbeat outside US regular market hours", async () => {
    const dir = makeTempDir("alphaloop-doctor-db-");
    const dbPath = join(dir, "trading.sqlite");
    const db = openTradingDatabase(dbPath);
    recordJobRun(db, {
      job: "market-alerts",
      startedAt: "2026-07-10T02:00:00.000Z",
      finishedAt: "2026-07-10T02:00:01.000Z",
      ok: true
    });
    db.close();

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      nowMs: Date.parse("2026-07-11T12:00:00.000Z"), // Saturday - the multi-day gap is expected off-hours
      dbPath
    });

    expect(report.findings.some((entry) => entry.code === "alerts-poller-health.stale_heartbeat")).toBe(false);
  });

  it("still fails via alerter_down, with a degraded message, when ALERTER-DOWN.json exists but cannot be parsed", async () => {
    const runtimeRoot = makeTempDir("alphaloop-doctor-runtime-");
    mkdirSync(join(runtimeRoot, "market-alerts"), { recursive: true });
    writeFileSync(join(runtimeRoot, "market-alerts", "ALERTER-DOWN.json"), "{ this is not valid json ");

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      runtimeRoot
    });

    expect(report.ok).toBe(false);
    const finding = report.findings.find((entry) => entry.code === "alerts-poller-health.alerter_down");
    expect(finding).toBeTruthy();
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("ALERTER-DOWN.json 存在但内容无法解析");
  });

  it("reports both alerter_down and db_unreachable together when the artifact exists AND the trading db cannot be opened", async () => {
    const runtimeRoot = makeTempDir("alphaloop-doctor-runtime-");
    mkdirSync(join(runtimeRoot, "market-alerts"), { recursive: true });
    writeFileSync(
      join(runtimeRoot, "market-alerts", "ALERTER-DOWN.json"),
      JSON.stringify({ since: "2026-07-10T00:00:00.000Z", reason: "send_failed", consecutiveFailures: 5 })
    );

    const dir = makeTempDir("alphaloop-doctor-db-");
    const dbPath = join(dir, "trading.sqlite");
    writeFileSync(dbPath, "not a real sqlite file, just garbage bytes");

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      ...OUTSIDE_MARKET_HOURS,
      runtimeRoot,
      dbPath
    });

    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "alerts-poller-health.alerter_down", severity: "error" }),
      expect.objectContaining({ code: "alerts-poller-health.db_unreachable", severity: "error" })
    ]));
  });

  it("does not crash and still reports the staleness itself when the trading calendar has no data for the current year", async () => {
    // Regression test for the CRITICAL doctor-crash finding: isUsRegularMarketHours
    // throws (via assertCalendarCoverage) whenever `now`'s year isn't in the
    // hardcoded NYSE calendar (trading-schedule.mjs only covers 2026 today).
    // Feeding a 2027 `now` reproduces exactly the "poller stopped AND the
    // calendar rolled over" scenario that used to take the whole doctor
    // process down, printing nothing at all.
    const dir = makeTempDir("alphaloop-doctor-db-");
    const dbPath = join(dir, "trading.sqlite");
    const db = openTradingDatabase(dbPath);
    recordJobRun(db, {
      job: "market-alerts",
      startedAt: "2027-01-01T14:00:00.000Z",
      finishedAt: "2027-01-01T14:00:01.000Z",
      ok: true
    });
    db.close();

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      nowMs: Date.parse("2027-01-01T15:00:00.000Z"), // >30min after last run; year 2027 uncovered
      dbPath
    });

    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "alerts-poller-health.calendar_uncovered", severity: "warn" }),
      expect.objectContaining({ code: "alerts-poller-health.stale_heartbeat_unknown_market_hours", severity: "warn" })
    ]));
    // A calendar-coverage gap is a "we don't know", not a proven hard
    // failure - it must not by itself flip `ok` to false.
    expect(report.findings.some((entry) => entry.severity === "error")).toBe(false);
  });

  it("fails when market-alerts has 3+ consecutive failed runs", async () => {
    const dir = makeTempDir("alphaloop-doctor-db-");
    const dbPath = join(dir, "trading.sqlite");
    const db = openTradingDatabase(dbPath);
    for (let i = 0; i < 3; i += 1) {
      recordJobRun(db, {
        job: "market-alerts",
        startedAt: `2026-07-11T10:0${i}:00.000Z`,
        finishedAt: `2026-07-11T10:0${i}:01.000Z`,
        ok: false,
        failedStep: "fetch_quotes"
      });
    }
    db.close();

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      nowMs: Date.parse("2026-07-11T12:00:00.000Z"), // Saturday - keeps this isolated from the stale-heartbeat check
      dbPath
    });

    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "alerts-poller-health.consecutive_failures", severity: "error" })
    ]));
  });
});

// Task 24 (2026-07-28 spec-drift remediation). The run_log half for the three
// scheduled daemons that had no heartbeat at all until this task - see
// checkScheduledJobHeartbeats' own header for the mini measurement that
// motivated it.
describe("scheduled-job-heartbeat check (Task 24)", () => {
  const SATURDAY_NOON = Date.parse("2026-07-11T12:00:00.000Z"); // outside market hours

  function snapshotWith(dbPath: string, nowMs = SATURDAY_NOON) {
    return {
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      nowMs,
      dbPath
    };
  }

  it("warns for every scheduled job that has no run_log row while its launchd label is loaded", async () => {
    const dir = makeTempDir("alphaloop-doctor-db-");
    const dbPath = join(dir, "trading.sqlite");
    openTradingDatabase(dbPath).close();

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotWith(dbPath));

    for (const job of ["daily-backup", "official-paper-poll", "official-paper-pnl"]) {
      expect(report.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: `scheduled-job-heartbeat.${job}.never_ran`, severity: "warn" })
      ]));
    }
  });

  it("says nothing about a job whose launchd label is not loaded on this machine", async () => {
    const dir = makeTempDir("alphaloop-doctor-db-");
    const dbPath = join(dir, "trading.sqlite");
    openTradingDatabase(dbPath).close();

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...snapshotWith(dbPath),
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED.filter((job) => job.label !== "com.alphaloop.daily-backup")
    });

    expect(report.findings.some((entry) => entry.code === "scheduled-job-heartbeat.daily-backup.never_ran")).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "scheduled-job-heartbeat.official-paper-poll.never_ran" })
    ]));
  });

  it("warns when a job's heartbeat has gone stale, and stays quiet while it is fresh", async () => {
    const dir = makeTempDir("alphaloop-doctor-db-");
    const dbPath = join(dir, "trading.sqlite");
    const db = openTradingDatabase(dbPath);
    // official-paper-poll is hourly; 3h is its stale threshold.
    recordJobRun(db, { job: "official-paper-poll", startedAt: "2026-07-11T11:30:00.000Z", ok: true });
    recordJobRun(db, { job: "official-paper-pnl", startedAt: "2026-07-11T04:00:00.000Z", ok: true });
    db.close();

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotWith(dbPath));

    expect(report.findings.some((entry) => entry.code === "scheduled-job-heartbeat.official-paper-poll.stale")).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "scheduled-job-heartbeat.official-paper-pnl.stale", severity: "warn" })
    ]));
  });

  it("accepts up to five minutes of clock skew but warns on a farther-future heartbeat", async () => {
    const withinDbPath = join(makeTempDir("alphaloop-doctor-db-"), "trading.sqlite");
    const withinDb = openTradingDatabase(withinDbPath);
    recordJobRun(withinDb, {
      job: "official-paper-poll",
      startedAt: new Date(SATURDAY_NOON + 4 * 60_000).toISOString(),
      ok: true
    });
    withinDb.close();

    const withinReport = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotWith(withinDbPath));
    expect(withinReport.findings.some((entry) => entry.code === "scheduled-job-heartbeat.official-paper-poll.stale")).toBe(false);

    const futureDbPath = join(makeTempDir("alphaloop-doctor-db-"), "trading.sqlite");
    const futureDb = openTradingDatabase(futureDbPath);
    recordJobRun(futureDb, {
      job: "official-paper-poll",
      startedAt: new Date(SATURDAY_NOON + 6 * 60_000).toISOString(),
      ok: true
    });
    futureDb.close();

    const futureReport = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotWith(futureDbPath));
    expect(futureReport.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "scheduled-job-heartbeat.official-paper-poll.stale", severity: "warn" })
    ]));
  });

  it("fails the report when a scheduled job has 3+ consecutive failed runs", async () => {
    const dir = makeTempDir("alphaloop-doctor-db-");
    const dbPath = join(dir, "trading.sqlite");
    const db = openTradingDatabase(dbPath);
    for (let i = 0; i < 3; i += 1) {
      recordJobRun(db, { job: "daily-backup", startedAt: `2026-07-11T1${i}:00:00.000Z`, ok: false, failedStep: "run" });
    }
    db.close();

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotWith(dbPath));

    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "scheduled-job-heartbeat.daily-backup.consecutive_failures", severity: "error" })
    ]));
  });
});

describe("cron-runner-health check", () => {
  function listenEphemeral(server: ReturnType<typeof createServer>): Promise<number> {
    return new Promise((resolvePort) => {
      server.listen(0, "127.0.0.1", () => resolvePort((server.address() as AddressInfo).port));
    });
  }

  function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
    return new Promise((resolveClose) => server.close(() => resolveClose()));
  }

  function snapshotFor(port: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      ...OUTSIDE_MARKET_HOURS,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      cronRunnerPort: port,
      cronRunnerHealthProbe: undefined,
      ...extra
    };
  }

  it("accepts the real cron-runner 200 health contract", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "openclaw-cron-runner", errors: [] }));
    });
    const port = await listenEphemeral(server);

    try {
      const report = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotFor(port));
      expect(report.findings.some((finding) => finding.code.startsWith("runner-health."))).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("reports a 503 with the cron-runner degraded error fields", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: false,
        service: "openclaw-cron-runner",
        alertsDegraded: true,
        lastAlertError: "Feishu delivery timed out",
        errors: ["alert-channel-degraded[report]: Feishu delivery timed out"]
      }));
    });
    const port = await listenEphemeral(server);

    try {
      const report = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotFor(port));
      expect(report.ok).toBe(false);
      const finding = report.findings.find((entry) => entry.code === "runner-health.degraded");
      expect(finding?.severity).toBe("error");
      expect(finding?.message).toContain("alert-channel-degraded[report]");
      expect(finding?.message).toContain("Feishu delivery timed out");
    } finally {
      await closeServer(server);
    }
  });

  it("keeps an unreachable cron-runner health endpoint as a warning on a machine with no deploy footprint", async () => {
    const report = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotFor(18792, {
      launchdJobs: NO_LAUNCHD_JOBS_LOADED,
      launchdPlists: { system: [], user: [] },
      deployLedger: [],
      cronRunnerHealthProbe: {
        ok: false,
        kind: "unreachable",
        url: "http://127.0.0.1:18792/health",
        reason: "connection refused"
      }
    }));

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "runner-health.unreachable", severity: "warn" })
    ]));
  });

  it("rejects a 200 response from the wrong service", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "platform-app" }));
    });
    const port = await listenEphemeral(server);

    try {
      const report = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotFor(port));
      expect(report.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "runner-health.unexpected_body", severity: "error" })
      ]));
    } finally {
      await closeServer(server);
    }
  });

  it("reports a non-200/non-503 response by status even when its body is not JSON", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal failure");
    });
    const port = await listenEphemeral(server);

    try {
      const report = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotFor(port));
      expect(report.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "runner-health.unexpected_status", severity: "error" })
      ]));
    } finally {
      await closeServer(server);
    }
  });

  it("rejects a malformed 503 that omits the degraded errors", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, service: "openclaw-cron-runner", errors: [] }));
    });
    const port = await listenEphemeral(server);

    try {
      const report = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotFor(port));
      expect(report.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "runner-health.unexpected_body", severity: "error" })
      ]));
    } finally {
      await closeServer(server);
    }
  });

  it("times out when the cron-runner never sends response headers", async () => {
    const server = createServer(() => {});
    const port = await listenEphemeral(server);

    try {
      const reportPromise = doctor.analyzeOpenClawRuntimeSnapshot(snapshotFor(port, {
        cronRunnerHealthTimeoutMs: 25
      }));
      const outcome = await Promise.race([
        reportPromise,
        new Promise<{ hung: true }>((resolve) => setTimeout(() => resolve({ hung: true }), 250))
      ]);
      expect(outcome).toMatchObject({ ok: false });
      expect("findings" in outcome && outcome.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "runner-health.unreachable", severity: "error" })
      ]));
    } finally {
      server.closeAllConnections();
      await closeServer(server);
    }
  });

  it("times out when headers arrive but the cron-runner body never completes", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
    });
    const port = await listenEphemeral(server);

    try {
      const reportPromise = doctor.analyzeOpenClawRuntimeSnapshot(snapshotFor(port, {
        cronRunnerHealthTimeoutMs: 25
      }));
      const outcome = await Promise.race([
        reportPromise,
        new Promise<{ hung: true }>((resolve) => setTimeout(() => resolve({ hung: true }), 250))
      ]);
      expect(outcome).toMatchObject({ ok: false });
      expect("findings" in outcome && outcome.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "runner-health.unreachable", severity: "error" })
      ]));
    } finally {
      server.closeAllConnections();
      await closeServer(server);
    }
  });
});

// Phase 3 Task 8: platform-app is a KeepAlive HTTP service (unlike the two
// periodic jobs above) - launchd-jobs above only proves it's *loaded*, this
// check proves its /health route actually answers. Covers all three
// documented outcomes (task brief): reachable-ok, reachable-but-broken
// (non-200 or unexpected body -> error), and unreachable (-> warn, since a
// dev machine legitimately doesn't run this service).
describe("platform-app-health check (Phase 3 Task 8)", () => {
  function listenEphemeral(server: ReturnType<typeof createServer>): Promise<number> {
    return new Promise((resolvePort) => {
      server.listen(0, "127.0.0.1", () => {
        resolvePort((server.address() as AddressInfo).port);
      });
    });
  }

  function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
    return new Promise((resolveClose) => server.close(() => resolveClose()));
  }

  it("reports nothing when platform-app's real /health responds 200 with the expected body", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "platform-app" }));
    });
    const port = await listenEphemeral(server);

    try {
      const report = await doctor.analyzeOpenClawRuntimeSnapshot({
        ...CONTROL_PERSONA_HEALTHY,
        ...HEALTHY_LISTENERS,
        ...RSSHUB_HEALTH_STUBBED_OK,
        ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
        launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
        platformAppPort: port
      });

      expect(report.ok).toBe(true);
      expect(report.findings.some((finding) => finding.code.startsWith("platform-app-health."))).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("reports an error when platform-app responds with a non-200 status", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
    });
    const port = await listenEphemeral(server);

    try {
      const report = await doctor.analyzeOpenClawRuntimeSnapshot({
        ...CONTROL_PERSONA_HEALTHY,
        ...HEALTHY_LISTENERS,
        ...RSSHUB_HEALTH_STUBBED_OK,
        ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
        launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
        platformAppPort: port
      });

      expect(report.ok).toBe(false);
      expect(report.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "platform-app-health.unexpected_status", severity: "error" })
      ]));
    } finally {
      await closeServer(server);
    }
  });

  it("reports an error when platform-app responds 200 but with an unexpected body shape", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "something-else" }));
    });
    const port = await listenEphemeral(server);

    try {
      const report = await doctor.analyzeOpenClawRuntimeSnapshot({
        ...CONTROL_PERSONA_HEALTHY,
        ...HEALTHY_LISTENERS,
        ...RSSHUB_HEALTH_STUBBED_OK,
        ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
        launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
        platformAppPort: port
      });

      expect(report.ok).toBe(false);
      expect(report.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "platform-app-health.unexpected_body", severity: "error" })
      ]));
    } finally {
      await closeServer(server);
    }
  });

  it("warns, but does not fail, when nothing is listening on a machine that never installed it", async () => {
    // Bind an ephemeral port and immediately release it, rather than
    // hardcoding a port number, so this can't collide with anything else
    // actually listening on this machine while the suite runs.
    const probe = createServer();
    const freedPort = await listenEphemeral(probe);
    await closeServer(probe);

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: NO_LAUNCHD_JOBS_LOADED,
      platformAppPort: freedPort,
      platformAppHealthTimeoutMs: 500
    });

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "platform-app-health.unreachable", severity: "warn" })
    ]));
    const message = report.findings.find((entry) => entry.code === "platform-app-health.unreachable")?.message;
    expect(message).toContain("pnpm platform:dev");
    // Round-3 finding F2: platform-app is a system daemon since ac741d8, so
    // the "run it permanently" hint has to name the installer that can
    // actually install it. launchd:install-backup-alerts skips every label
    // the ownership manifest does not scope `user`.
    expect(message).toContain("sudo zsh apps/openclaw-config/scripts/install-system-daemons.sh");
  });

  it("FAILS when launchd is holding the label and the port still refuses", async () => {
    // Round-5 finding D2, measured: platform-app crash-looping (launchd
    // reports state = running because it had just been relaunched) with
    // /health refusing ECONNREFUSED produced ok=true, doctor exit 0, and no
    // error finding at all.
    const probe = createServer();
    const freedPort = await listenEphemeral(probe);
    await closeServer(probe);

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      platformAppPort: freedPort,
      platformAppHealthTimeoutMs: 500
    });

    expect(report.ok).toBe(false);
    const finding = report.findings.find((entry) => entry.code === "platform-app-health.unreachable");
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("launchd 当前持有这个标签");
    expect(finding?.message).toContain("kickstart -k system/com.alphaloop.platform-app");
  });

  it("resolves rather than rejecting when the injected fetch implementation itself throws synchronously", async () => {
    // Alternate injection point (task brief: "inject a fake fetch OR spin a
    // throwaway local server") - proves checkPlatformAppHealth's own
    // try/catch, not just runChecksFailureIsolated's outer net, absorbs a
    // thrower. If this DIDN'T resolve, `await` below would make the whole
    // test fail with an unhandled rejection.
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      launchdJobs: NO_LAUNCHD_JOBS_LOADED,
      fetchImpl: () => {
        throw new Error("boom - injected network failure");
      }
    });

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "platform-app-health.unreachable", severity: "warn" })
    ]));
  });

  it("bounds a platform-app response whose headers arrive but JSON body never completes", async () => {
    const reportPromise = doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      platformAppPort: 991,
      platformAppHealthTimeoutMs: 25,
      fetchImpl: async (url: string, init: RequestInit = {}) => {
        if (Number(new URL(String(url)).port) !== 991) return stubbedLoopbackFetch(url, init);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: () => new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          })
        };
      }
    });

    const outcome = await Promise.race([
      reportPromise,
      new Promise<{ hung: true }>((resolve) => setTimeout(() => resolve({ hung: true }), 250))
    ]);
    expect(outcome).toMatchObject({ ok: false });
    expect("findings" in outcome && outcome.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "platform-app-health.unexpected_body", severity: "error" })
    ]));
  });
});

describe("memoryd-health check", () => {
  it("refuses a non-loopback probe URL without making a network request", async () => {
    let requested = false;
    const probe = await doctor.probeMemorydMcp({
      url: "http://10.0.0.8:8766/mcp",
      fetchImpl: async () => {
        requested = true;
        return new Response(null, { status: 200 });
      }
    });

    expect(probe).toMatchObject({ ok: false, kind: "unreachable" });
    expect(probe.reason).toMatch(/loopback/i);
    expect(requested).toBe(false);
  });

  it("performs a real MCP initialize exchange and closes the session", async () => {
    const requests: Array<{ method: string; protocolVersion: string | null }> = [];
    const probe = await doctor.probeMemorydMcp({
      url: "http://127.0.0.1:8766/mcp",
      fetchImpl: async (_url: RequestInfo | URL, init: RequestInit = {}) => {
        requests.push({
          method: String(init.method),
          protocolVersion: new Headers(init.headers).get("mcp-protocol-version")
        });
        if (init.method === "DELETE") return new Response(null, { status: 200 });
        return new Response(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "memoryd" } } })}\n\n`,
          { status: 200, headers: { "mcp-session-id": "doctor-session" } }
        );
      }
    });

    expect(probe).toMatchObject({ ok: true, serverName: "memoryd", sessionId: true });
    expect(requests.map(({ method }) => method)).toEqual(["POST", "DELETE"]);
    expect(requests[1]?.protocolVersion).toBe("2025-06-18");
  });

  it("bounds session cleanup so a wedged DELETE cannot hang the doctor", async () => {
    const startedAt = Date.now();
    const probe = await doctor.probeMemorydMcp({
      url: "http://127.0.0.1:8766/mcp",
      timeoutMs: 25,
      fetchImpl: async (_url: RequestInfo | URL, init: RequestInit = {}) => {
        if (init.method !== "DELETE") {
          return new Response(
            `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "memoryd" } } })}\n\n`,
            { status: 200, headers: { "mcp-session-id": "wedged-cleanup" } }
          );
        }
        return await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("cleanup aborted")), { once: true });
        });
      }
    });

    expect(probe).toMatchObject({ ok: true, serverName: "memoryd" });
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("bounds an initialize response whose headers arrive but body never completes", async () => {
    const probePromise = doctor.probeMemorydMcp({
      url: "http://127.0.0.1:8766/mcp",
      timeoutMs: 25,
      fetchImpl: async (_url: RequestInfo | URL, init: RequestInit = {}) => {
        if (init.method === "DELETE") return new Response(null, { status: 200 });
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers({ "mcp-session-id": "hanging-body" }),
          text: () => new Promise<string>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          })
        } as Response;
      }
    });

    const outcome = await Promise.race([
      probePromise,
      new Promise<{ hung: true }>((resolve) => setTimeout(() => resolve({ hung: true }), 250))
    ]);

    expect(outcome).toMatchObject({ ok: false, kind: "unreachable" });
  });

  it("fails a deployed machine and only warns on a dev machine when MCP is unreachable", async () => {
    const failedProbe = { ok: false, kind: "unreachable", url: "http://127.0.0.1:8766/mcp", reason: "ECONNREFUSED" };
    const deployed = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      memorydMcpProbe: failedProbe,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED
    });
    const dev = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      memorydMcpProbe: failedProbe,
      launchdJobs: NO_LAUNCHD_JOBS_LOADED
    });

    expect(deployed.findings).toContainEqual(expect.objectContaining({ code: "memoryd-health.unreachable", severity: "error" }));
    expect(dev.findings).toContainEqual(expect.objectContaining({ code: "memoryd-health.unreachable", severity: "warn" }));
  });

  it("fails on a deploy target even when memoryd itself is the missing launchd label", async () => {
    const launchdJobs = ALL_LAUNCHD_JOBS_LOADED.map((row) => (
      row.label === "com.alphaloop.memoryd" ? { ...row, loadedDomains: [], state: null } : row
    ));
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      memorydMcpProbe: { ok: false, kind: "unreachable", url: "http://127.0.0.1:8766/mcp", reason: "ECONNREFUSED" },
      launchdJobs
    });

    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "memoryd-health.unreachable",
      severity: "error"
    }));
  });

  it("reports malformed initialize responses and non-success HTTP statuses as deployed errors", async () => {
    const common = {
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED
    };
    const wrongBody = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...common,
      memorydMcpProbe: {
        ok: false, kind: "body", url: "http://127.0.0.1:8766/mcp",
        serverName: "not-memoryd", sessionId: false
      }
    });
    const wrongStatus = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...common,
      memorydMcpProbe: {
        ok: false, kind: "status", url: "http://127.0.0.1:8766/mcp",
        status: 503, statusText: "Service Unavailable"
      }
    });

    expect(wrongBody.findings).toContainEqual(expect.objectContaining({
      code: "memoryd-health.unexpected_body", severity: "error"
    }));
    expect(wrongStatus.findings).toContainEqual(expect.objectContaining({
      code: "memoryd-health.unexpected_status", severity: "error"
    }));
  });
});

// Phase 4 Task 8 (news engine deployment wiring) - "rsshub-health" check:
// proves the rsshub Docker container's own health endpoint actually answers,
// mirroring platform-app-health's three-way split (task brief) - reachable-
// ok, reachable-but-broken (-> error), unreachable (-> warn, naming the P10
// ignition command since a dev machine legitimately has never created the
// container at all) - plus the `/healthz` -> `/` fallback RSSHub itself
// needs (older RSSHub builds only serve `/`, not `/healthz`).
describe("rsshub-health check (Phase 4 Task 8)", () => {
  function listenEphemeral(server: ReturnType<typeof createServer>): Promise<number> {
    return new Promise((resolvePort) => {
      server.listen(0, "127.0.0.1", () => {
        resolvePort((server.address() as AddressInfo).port);
      });
    });
  }

  function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
    return new Promise((resolveClose) => server.close(() => resolveClose()));
  }

  it("reports nothing when /healthz responds 200", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200);
        res.end("OK");
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    const port = await listenEphemeral(server);

    try {
      const report = await doctor.analyzeOpenClawRuntimeSnapshot({
        ...CONTROL_PERSONA_HEALTHY,
        ...HEALTHY_LISTENERS,
        ...PLATFORM_APP_HEALTH_STUBBED_OK,
        ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
        launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
        rsshubBaseUrl: `http://127.0.0.1:${port}`
      });

      expect(report.ok).toBe(true);
      expect(report.findings.some((finding) => finding.code.startsWith("rsshub-health."))).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("falls back to / when /healthz 404s, and reports nothing when that fallback responds 200", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(404);
        res.end();
      } else {
        res.writeHead(200);
        res.end("rsshub root page");
      }
    });
    const port = await listenEphemeral(server);

    try {
      const report = await doctor.analyzeOpenClawRuntimeSnapshot({
        ...CONTROL_PERSONA_HEALTHY,
        ...HEALTHY_LISTENERS,
        ...PLATFORM_APP_HEALTH_STUBBED_OK,
        ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
        launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
        rsshubBaseUrl: `http://127.0.0.1:${port}`
      });

      expect(report.ok).toBe(true);
      expect(report.findings.some((finding) => finding.code.startsWith("rsshub-health."))).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("reports an error when both /healthz and the / fallback are non-200 (reachable, but unhealthy)", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const port = await listenEphemeral(server);

    try {
      const report = await doctor.analyzeOpenClawRuntimeSnapshot({
        ...CONTROL_PERSONA_HEALTHY,
        ...HEALTHY_LISTENERS,
        ...PLATFORM_APP_HEALTH_STUBBED_OK,
        ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
        launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
        rsshubBaseUrl: `http://127.0.0.1:${port}`
      });

      expect(report.ok).toBe(false);
      expect(report.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "rsshub-health.unexpected_status", severity: "error" })
      ]));
    } finally {
      await closeServer(server);
    }
  });

  it("reports an error when /healthz responds with a non-404, non-200 status (no fallback attempted)", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    const port = await listenEphemeral(server);

    try {
      const report = await doctor.analyzeOpenClawRuntimeSnapshot({
        ...CONTROL_PERSONA_HEALTHY,
        ...HEALTHY_LISTENERS,
        ...PLATFORM_APP_HEALTH_STUBBED_OK,
        ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
        launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
        rsshubBaseUrl: `http://127.0.0.1:${port}`
      });

      expect(report.ok).toBe(false);
      expect(report.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "rsshub-health.unexpected_status", severity: "error" })
      ]));
    } finally {
      await closeServer(server);
    }
  });

  it("warns, but does not fail, when nothing is listening (no container created yet / P10 not run)", async () => {
    const probe = createServer();
    const freedPort = await listenEphemeral(probe);
    await closeServer(probe);

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      // A machine where com.alphaloop.rsshub was never installed: nothing has
      // claimed responsibility for that container, so nothing is broken yet.
      launchdJobs: NO_LAUNCHD_JOBS_LOADED,
      rsshubBaseUrl: `http://127.0.0.1:${freedPort}`,
      rsshubHealthTimeoutMs: 500
    });

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "rsshub-health.unreachable", severity: "warn" })
    ]));
    const message = report.findings.find((entry) => entry.code === "rsshub-health.unreachable")?.message;
    expect(message).toContain("P10");
    expect(message).toContain("docker run -d --name rsshub -p 127.0.0.1:1200:1200 diygod/rsshub");
  });

  // Round-5 finding D2: com.alphaloop.rsshub's whole job is `docker start
  // rsshub`, so once it is loaded, "1200 refuses" means that job did not do
  // what it exists to do. Measured on the mini: `last exit code = 1`, and the
  // pre-round-5 doctor called it a warn.
  it("FAILS when the launchd job that starts the container is loaded and 1200 still refuses", async () => {
    const probe = createServer();
    const freedPort = await listenEphemeral(probe);
    await closeServer(probe);

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      rsshubBaseUrl: `http://127.0.0.1:${freedPort}`,
      rsshubHealthTimeoutMs: 500
    });

    expect(report.ok).toBe(false);
    const finding = report.findings.find((entry) => entry.code === "rsshub-health.unreachable");
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("logs/rsshub.err.log");
    expect(finding?.message).toContain("colima start");
    expect(finding?.message).toContain("docker start rsshub");
  });

  it("resolves the base URL from process.env.RSSHUB_BASE_URL when no snapshot override is given", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("OK");
    });
    const port = await listenEphemeral(server);
    const previousEnv = process.env.RSSHUB_BASE_URL;
    process.env.RSSHUB_BASE_URL = `http://127.0.0.1:${port}`;

    try {
      const report = await doctor.analyzeOpenClawRuntimeSnapshot({
        ...CONTROL_PERSONA_HEALTHY,
        ...HEALTHY_LISTENERS,
        ...PLATFORM_APP_HEALTH_STUBBED_OK,
        launchdJobs: ALL_LAUNCHD_JOBS_LOADED
        // Deliberately no rsshubBaseUrl override - must fall through to
        // process.env.RSSHUB_BASE_URL (the real production resolution path).
      });

      expect(report.findings.some((finding) => finding.code.startsWith("rsshub-health."))).toBe(false);
    } finally {
      await closeServer(server);
      if (previousEnv === undefined) {
        delete process.env.RSSHUB_BASE_URL;
      } else {
        process.env.RSSHUB_BASE_URL = previousEnv;
      }
    }
  });
});

// Phase 4 Task 8 (news engine deployment wiring) - "news-engine-health"
// check: news_events going quiet for 48h+ (while genuinely having data
// already) means the collection pipeline (RSSHub/Finnhub/openclaw cron) has
// silently stopped, not that there's simply no news yet.
describe("news-engine-health check (Phase 4 Task 8)", () => {
  function seedEvent(db: InstanceType<typeof import("node:sqlite").DatabaseSync>, publishedAt: string | null): void {
    newsStore.upsertEventWithSources(
      db,
      { clusterKey: `cluster-${publishedAt ?? "unknown"}`, titleZh: "美联储维持利率不变" },
      [{
        origin: "wallstreetcn",
        publisher: "华尔街见闻",
        url: publishedAt ? `https://wallstreetcn.com/articles/${Date.now()}` : null,
        titleRaw: "美联储维持利率不变",
        publishedAt,
        lang: "zh"
      }]
    );
  }

  it("reports nothing when dbPath is not supplied at all", async () => {
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED
      // no dbPath
    });

    expect(report.findings.some((finding) => finding.code.startsWith("news-engine-health."))).toBe(false);
  });

  it("reports nothing on a freshly migrated database with zero news_events rows (fresh install)", async () => {
    const dir = makeTempDir("alphaloop-doctor-news-db-");
    const dbPath = join(dir, "trading.sqlite");
    openTradingDatabase(dbPath).close();

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      ...OUTSIDE_MARKET_HOURS,
      dbPath
    });

    expect(report.ok).toBe(true);
    expect(report.findings.some((finding) => finding.code.startsWith("news-engine-health."))).toBe(false);
  });

  it("reports nothing when the freshest event's last_published_at is within the last 48 hours", async () => {
    const dir = makeTempDir("alphaloop-doctor-news-db-");
    const dbPath = join(dir, "trading.sqlite");
    const db = openTradingDatabase(dbPath);
    seedEvent(db, "2026-07-13T12:00:00.000Z");
    db.close();

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      nowMs: Date.parse("2026-07-14T12:00:00.000Z"), // 24h later
      dbPath
    });

    expect(report.ok).toBe(true);
    expect(report.findings.some((finding) => finding.code.startsWith("news-engine-health."))).toBe(false);
  });

  it("warns when the freshest event's last_published_at is more than 48 hours old", async () => {
    const dir = makeTempDir("alphaloop-doctor-news-db-");
    const dbPath = join(dir, "trading.sqlite");
    const db = openTradingDatabase(dbPath);
    seedEvent(db, "2026-07-10T00:00:00.000Z");
    db.close();

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      nowMs: Date.parse("2026-07-14T12:00:00.000Z"), // >48h later
      dbPath
    });

    expect(report.ok).toBe(true); // warn only - never flips the overall report to failing
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "news-engine-health.stale", severity: "warn" })
    ]));
    const message = report.findings.find((entry) => entry.code === "news-engine-health.stale")?.message;
    expect(message).toContain("新闻引擎超过 48 小时无新事件");
  });

  it("accepts up to five minutes of source clock skew but warns on a farther-future news timestamp", async () => {
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const withinDbPath = join(makeTempDir("alphaloop-doctor-news-db-"), "trading.sqlite");
    const withinDb = openTradingDatabase(withinDbPath);
    seedEvent(withinDb, new Date(nowMs + 4 * 60_000).toISOString());
    withinDb.close();

    const withinReport = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      nowMs,
      dbPath: withinDbPath
    });
    expect(withinReport.findings.some((entry) => entry.code === "news-engine-health.stale")).toBe(false);

    const futureDbPath = join(makeTempDir("alphaloop-doctor-news-db-"), "trading.sqlite");
    const futureDb = openTradingDatabase(futureDbPath);
    seedEvent(futureDb, new Date(nowMs + 6 * 60_000).toISOString());
    futureDb.close();

    const futureReport = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      nowMs,
      dbPath: futureDbPath
    });
    expect(futureReport.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "news-engine-health.stale", severity: "warn" })
    ]));
  });

  it("treats an all-unknown-time news_events table (count > 0, MAX(last_published_at) NULL) as stale too", async () => {
    const dir = makeTempDir("alphaloop-doctor-news-db-");
    const dbPath = join(dir, "trading.sqlite");
    const db = openTradingDatabase(dbPath);
    seedEvent(db, null);
    db.close();

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      ...OUTSIDE_MARKET_HOURS,
      dbPath
    });

    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "news-engine-health.stale", severity: "warn" })
    ]));
  });

  it("reports an error (never throws) when the trading db cannot even be opened", async () => {
    const dir = makeTempDir("alphaloop-doctor-news-db-");
    const dbPath = join(dir, "trading.sqlite");
    writeFileSync(dbPath, "not a real sqlite file, just garbage bytes");

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      ...OUTSIDE_MARKET_HOURS,
      dbPath
    });

    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "news-engine-health.db_unreachable", severity: "error" })
    ]));
  });
});

// task H2 fix round (this task, CRITICAL finding): the doctor is this
// system's only external observer - if any ONE check throws, the whole
// process used to die with it, printing NOTHING (not even findings other
// checks had already computed). Every check must now be failure-isolated.
// Round-4 finding I5: broker-executor was one of the four daemons with no
// health probe at all.
describe("broker-executor-health check (round-4 finding I5)", () => {
  function listenEphemeral(server: ReturnType<typeof createServer>): Promise<number> {
    return new Promise((resolvePort) => {
      server.listen(0, "127.0.0.1", () => resolvePort((server.address() as AddressInfo).port));
    });
  }

  function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
    return new Promise((resolveClose) => server.close(() => resolveClose()));
  }

  it("reports nothing against the REAL broker-executor /health route", async () => {
    // Not a stub shaped to match the doctor's expectation - this is
    // apps/broker-executor's own createBrokerExecutorServer, the exact code
    // the com.openclaw.system.trading.broker-executor daemon runs, answering
    // over a real loopback socket. If that route's body ever stops carrying
    // {ok:true, service:"broker-executor"}, this fails instead of the doctor
    // quietly reporting a false error on the deploy machine.
    const dir = makeTempDir("alphaloop-doctor-broker-db-");
    const db = openTradingDatabase(join(dir, "trading.sqlite"));
    const server = createBrokerExecutorServer({ db, sharedSecret: "test-only-not-a-real-secret" });
    const port = await listenEphemeral(server as unknown as ReturnType<typeof createServer>);

    try {
      const report = await doctor.analyzeOpenClawRuntimeSnapshot({
        ...CONTROL_PERSONA_HEALTHY,
        ...HEALTHY_LISTENERS,
        ...PLATFORM_APP_HEALTH_STUBBED_OK,
        ...RSSHUB_HEALTH_STUBBED_OK,
        ...OUTSIDE_MARKET_HOURS,
        launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
        brokerExecutorPort: port
      });

      expect(report.ok).toBe(true);
      expect(report.findings.some((finding) => finding.code.startsWith("broker-executor-health."))).toBe(false);
    } finally {
      await closeServer(server as unknown as ReturnType<typeof createServer>);
      db.close();
    }
  });

  it("fails when the port answers but the process behind it is not broker-executor", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "platform-app" }));
    });
    const port = await listenEphemeral(server);

    try {
      const report = await doctor.analyzeOpenClawRuntimeSnapshot({
        ...CONTROL_PERSONA_HEALTHY,
        ...HEALTHY_LISTENERS,
        ...PLATFORM_APP_HEALTH_STUBBED_OK,
        ...RSSHUB_HEALTH_STUBBED_OK,
        ...OUTSIDE_MARKET_HOURS,
        launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
        brokerExecutorPort: port
      });

      expect(report.ok).toBe(false);
      expect(report.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "broker-executor-health.unexpected_body", severity: "error" })
      ]));
    } finally {
      await closeServer(server);
    }
  });

  it("fails when broker-executor answers with a non-200 status", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("unavailable");
    });
    const port = await listenEphemeral(server);

    try {
      const report = await doctor.analyzeOpenClawRuntimeSnapshot({
        ...CONTROL_PERSONA_HEALTHY,
        ...HEALTHY_LISTENERS,
        ...PLATFORM_APP_HEALTH_STUBBED_OK,
        ...RSSHUB_HEALTH_STUBBED_OK,
        ...OUTSIDE_MARKET_HOURS,
        launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
        brokerExecutorPort: port
      });

      expect(report.ok).toBe(false);
      expect(report.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "broker-executor-health.unexpected_status", severity: "error" })
      ]));
    } finally {
      await closeServer(server);
    }
  });

  it("warns, but does not fail, when nothing is listening on a machine that never installed it", async () => {
    const probe = createServer();
    const freedPort = await listenEphemeral(probe);
    await closeServer(probe);

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...OUTSIDE_MARKET_HOURS,
      launchdJobs: NO_LAUNCHD_JOBS_LOADED,
      brokerExecutorPort: freedPort,
      brokerExecutorHealthTimeoutMs: 500
    });

    expect(report.ok).toBe(true);
    const finding = report.findings.find((entry) => entry.code === "broker-executor-health.unreachable");
    expect(finding?.severity).toBe("warn");
    expect(finding?.message).toContain("sudo zsh apps/openclaw-config/scripts/install-system-daemons.sh");
    expect(finding?.message).toContain("BROKER_EXECUTOR_SHARED_SECRET");
  });

  // Round-5 finding D2. The measured defect: launchd says the daemon is loaded
  // and `state = running` (it was, for the 200ms after the last relaunch), the
  // port refuses, and the doctor said ok=true / exit 0.
  it("FAILS when launchd is holding the label and the port still refuses", async () => {
    const probe = createServer();
    const freedPort = await listenEphemeral(probe);
    await closeServer(probe);

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...OUTSIDE_MARKET_HOURS,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      brokerExecutorPort: freedPort,
      brokerExecutorHealthTimeoutMs: 500
    });

    expect(report.ok).toBe(false);
    const finding = report.findings.find((entry) => entry.code === "broker-executor-health.unreachable");
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("launchd 当前持有这个标签");
  });

  it("bounds a broker-executor response whose headers arrive but JSON body never completes", async () => {
    const reportPromise = doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...OUTSIDE_MARKET_HOURS,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      brokerExecutorPort: 992,
      brokerExecutorHealthTimeoutMs: 25,
      fetchImpl: async (url: string, init: RequestInit = {}) => {
        if (Number(new URL(String(url)).port) !== 992) return stubbedLoopbackFetch(url, init);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: () => new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          })
        };
      }
    });

    const outcome = await Promise.race([
      reportPromise,
      new Promise<{ hung: true }>((resolve) => setTimeout(() => resolve({ hung: true }), 250))
    ]);
    expect(outcome).toMatchObject({ ok: false });
    expect("findings" in outcome && outcome.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "broker-executor-health.unexpected_body", severity: "error" })
    ]));
  });
});

// Round-4 finding I5: daily-backup has no port and writes no run_log row -
// the only observable proof it worked is the backup file it produces.
describe("daily-backup-health check (round-4 finding I5)", () => {
  // Wednesday 2026-07-29 12:00 Asia/Shanghai, i.e. after that morning's 05:30
  // run would have fired.
  const NOW_MS = Date.parse("2026-07-29T04:00:00.000Z");

  function backupSnapshot(runtimeRoot: string, extra: Record<string, unknown> = {}) {
    return {
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      nowMs: NOW_MS,
      runtimeRoot,
      ...extra
    };
  }

  // Produces the backup file by running the REAL producer (runBackup), so the
  // name the doctor looks for is the name the daemon actually writes - not a
  // second guess at its date format.
  function seedRealBackup(runtimeRoot: string, whenMs: number): void {
    const dbDir = makeTempDir("alphaloop-doctor-backup-src-");
    const dbPath = join(dbDir, "trading.sqlite");
    const memorydRoot = join(dbDir, "memoryd");
    mkdirSync(memorydRoot, { recursive: true });
    writeFileSync(join(memorydRoot, "state.txt"), "memoryd-state", "utf8");
    openTradingDatabase(dbPath).close();
    const result = runBackup({
      dbPath,
      dest: join(runtimeRoot, "backups"),
      retentionDays: 3650,
      memorydRoot,
      now: new Date(whenMs)
    });
    expect(result.ok).toBe(true);
  }

  it("reports nothing when the newest backup is from today", async () => {
    const runtimeRoot = makeTempDir("alphaloop-doctor-backup-");
    seedRealBackup(runtimeRoot, NOW_MS);

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(backupSnapshot(runtimeRoot));

    expect(report.ok).toBe(true);
    expect(report.findings.some((finding) => finding.code.startsWith("daily-backup-health."))).toBe(false);
  });

  it("reports nothing when the newest backup is yesterday's (before today's 05:30 run)", async () => {
    const runtimeRoot = makeTempDir("alphaloop-doctor-backup-");
    seedRealBackup(runtimeRoot, NOW_MS - 24 * 60 * 60_000);

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(backupSnapshot(runtimeRoot));

    expect(report.findings.some((finding) => finding.code.startsWith("daily-backup-health."))).toBe(false);
  });

  it("fails when the newest backup is two days old - at least one scheduled run was missed", async () => {
    const runtimeRoot = makeTempDir("alphaloop-doctor-backup-");
    seedRealBackup(runtimeRoot, NOW_MS - 2 * 24 * 60 * 60_000);

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(backupSnapshot(runtimeRoot));

    expect(report.ok).toBe(false);
    const finding = report.findings.find((entry) => entry.code === "daily-backup-health.stale");
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("trading-2026-07-27.sqlite");
  });

  it("fails closed when future-dated backup names would otherwise look perpetually fresh", async () => {
    const runtimeRoot = makeTempDir("alphaloop-doctor-backup-");
    seedRealBackup(runtimeRoot, NOW_MS + 24 * 60 * 60_000);

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(backupSnapshot(runtimeRoot));

    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "daily-backup-health.future_timestamp", severity: "error" })
    ]));
  });

  it("warns, without failing, when the daemon is installed but has never produced a backup", async () => {
    const runtimeRoot = makeTempDir("alphaloop-doctor-backup-");

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(backupSnapshot(runtimeRoot));

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "daily-backup-health.never_ran", severity: "warn" })
    ]));
  });

  it("fails when SQLite is backed up but the managed memoryd root is not", async () => {
    const runtimeRoot = makeTempDir("alphaloop-doctor-backup-");
    const dbDir = makeTempDir("alphaloop-doctor-backup-src-");
    const dbPath = join(dbDir, "trading.sqlite");
    openTradingDatabase(dbPath).close();
    runBackup({
      dbPath,
      dest: join(runtimeRoot, "backups"),
      retentionDays: 3650,
      now: new Date(NOW_MS)
    });

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(backupSnapshot(runtimeRoot));

    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "daily-backup-health.memoryd_missing", severity: "error" })
    ]));
  });

  it("fails when today's SQLite backup exists but the newest memoryd archive is two days old", async () => {
    const runtimeRoot = makeTempDir("alphaloop-doctor-backup-");
    seedRealBackup(runtimeRoot, NOW_MS - 2 * 24 * 60 * 60_000);
    const dbDir = makeTempDir("alphaloop-doctor-backup-src-");
    const dbPath = join(dbDir, "trading.sqlite");
    openTradingDatabase(dbPath).close();
    runBackup({
      dbPath,
      dest: join(runtimeRoot, "backups"),
      retentionDays: 3650,
      now: new Date(NOW_MS)
    });

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(backupSnapshot(runtimeRoot));

    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "daily-backup-health.memoryd_stale", severity: "error" })
    ]));
  });

  it("stays silent on a machine where the daily-backup daemon is not installed at all", async () => {
    const runtimeRoot = makeTempDir("alphaloop-doctor-backup-");

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(backupSnapshot(runtimeRoot, {
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED.map((row) => (
        row.label === "com.alphaloop.daily-backup" ? { ...row, loadedDomains: [], state: null } : row
      ))
    }));

    expect(report.findings.some((finding) => finding.code.startsWith("daily-backup-health."))).toBe(false);
  });
});

// Round-4 finding I5: the official-paper poll and pnl jobs were the other two
// daemons with no probe. Neither binds a port nor writes run_log; each proves
// itself by the official_paper_snapshots row it writes under its own `reason`.
describe("official-paper-health check (round-4 finding I5)", () => {
  // Tuesday 2026-07-28 12:00 America/New_York: 150 minutes past the open (so
  // the hourly poll is judgeable) and an hour past the 10:00 pnl run.
  const MIDDAY_ET = Date.parse("2026-07-28T16:00:00.000Z");

  // Writes the row through the REAL producer (official-paper-monitor.mjs's
  // own saveSnapshot), so the `reason` values and column names the doctor
  // queries are the ones the daemon actually writes.
  function seedSnapshot(
    dbPath: string,
    reason: string,
    fetchedAt: string,
    ownerId = "__shared__"
  ): void {
    const db = openTradingDatabase(dbPath);
    try {
      saveSnapshot(db, {
        fetchedAt,
        primaryAsset: { net_assets: 100000, total_cash: 50000 },
        positions: []
      }, reason, ownerId);
    } finally {
      db.close();
    }
  }

  function paperSnapshot(dbPath: string, extra: Record<string, unknown> = {}) {
    return {
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      nowMs: MIDDAY_ET,
      dbPath,
      ...extra
    };
  }

  function freshDbPath(): string {
    const dbPath = join(makeTempDir("alphaloop-doctor-paper-db-"), "trading.sqlite");
    openTradingDatabase(dbPath).close();
    return dbPath;
  }

  it("fails when the hourly poll has produced nothing for over two hours mid-session", async () => {
    const dbPath = freshDbPath();
    seedSnapshot(dbPath, "hourly_poll", new Date(MIDDAY_ET - 3 * 60 * 60_000).toISOString());
    seedSnapshot(dbPath, "post_open_pnl", new Date(MIDDAY_ET - 2 * 60 * 60_000).toISOString());

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(paperSnapshot(dbPath));

    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "official-paper-health.poll.stale", severity: "error" })
    ]));
    expect(report.findings.some((finding) => finding.code === "official-paper-health.pnl.stale")).toBe(false);
  });

  it("reports nothing when both jobs have written recent rows", async () => {
    const dbPath = freshDbPath();
    seedSnapshot(dbPath, "hourly_poll", new Date(MIDDAY_ET - 30 * 60_000).toISOString());
    seedSnapshot(dbPath, "post_open_pnl", new Date(MIDDAY_ET - 2 * 60 * 60_000).toISOString());
    // The pnl job also renders this file; see the report_missing case below.
    const repoRoot = makeTempDir("alphaloop-doctor-paper-repo-");
    mkdirSync(join(repoRoot, "reports", "official-paper"), { recursive: true });
    writeFileSync(
      join(repoRoot, "reports", "official-paper", `${new Date(MIDDAY_ET - 2 * 60 * 60_000).toISOString().slice(0, 10)}-post-open.md`),
      "# 官方模拟盘\n"
    );

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(paperSnapshot(dbPath, { repoRoot }));

    expect(report.ok).toBe(true);
    expect(report.findings.some((finding) => finding.code.startsWith("official-paper-health."))).toBe(false);
  });

  it("accepts up to five minutes of snapshot clock skew but fails closed beyond it", async () => {
    const withinDbPath = freshDbPath();
    seedSnapshot(withinDbPath, "hourly_poll", new Date(MIDDAY_ET + 4 * 60_000).toISOString());
    const withinReport = await doctor.analyzeOpenClawRuntimeSnapshot(paperSnapshot(withinDbPath, {
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED.filter((job) => job.label !== "com.openclaw.trading.official-paper.pnl")
    }));
    expect(withinReport.findings.some((finding) => finding.code === "official-paper-health.poll.stale")).toBe(false);

    const futureDbPath = freshDbPath();
    seedSnapshot(futureDbPath, "hourly_poll", new Date(MIDDAY_ET + 6 * 60_000).toISOString());
    const futureReport = await doctor.analyzeOpenClawRuntimeSnapshot(paperSnapshot(futureDbPath, {
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED.filter((job) => job.label !== "com.openclaw.trading.official-paper.pnl")
    }));
    expect(futureReport.ok).toBe(false);
    expect(futureReport.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "official-paper-health.poll.stale", severity: "error" })
    ]));
  });

  it("accepts fresh per-member poll/PnL rows only when every owner artifact exists", async () => {
    const dbPath = freshDbPath();
    const fetchedAt = new Date(MIDDAY_ET - 30 * 60_000).toISOString();
    for (const ownerId of ["member_1", "member_2"]) {
      seedSnapshot(dbPath, "hourly_poll_per_member", fetchedAt, ownerId);
      seedSnapshot(dbPath, "post_open_pnl_per_member", fetchedAt, ownerId);
    }
    const repoRoot = makeTempDir("alphaloop-doctor-paper-members-");
    const reportDir = join(repoRoot, "reports", "official-paper");
    mkdirSync(reportDir, { recursive: true });
    for (const ownerId of ["member_1", "member_2"]) {
      writeFileSync(join(reportDir, `${fetchedAt.slice(0, 10)}-post-open--${ownerId}.md`), "# 官方模拟盘\n");
    }

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(paperSnapshot(dbPath, { repoRoot }));

    expect(report.ok).toBe(true);
    expect(report.findings.some((finding) => finding.code.startsWith("official-paper-health."))).toBe(false);
  });

  it("fails when one fresh per-member PnL row has no owner-matching artifact", async () => {
    const dbPath = freshDbPath();
    const fetchedAt = new Date(MIDDAY_ET - 30 * 60_000).toISOString();
    for (const ownerId of ["member_1", "member_2"]) {
      seedSnapshot(dbPath, "hourly_poll_per_member", fetchedAt, ownerId);
      seedSnapshot(dbPath, "post_open_pnl_per_member", fetchedAt, ownerId);
    }
    const repoRoot = makeTempDir("alphaloop-doctor-paper-member-missing-");
    const reportDir = join(repoRoot, "reports", "official-paper");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, `${fetchedAt.slice(0, 10)}-post-open--member_1.md`), "# 官方模拟盘\n");

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(paperSnapshot(dbPath, { repoRoot }));

    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "official-paper-health.pnl.report_missing", severity: "error" })
    ]));
    expect(report.findings.find((finding) => finding.code === "official-paper-health.pnl.report_missing")?.message)
      .toContain("member_2");
  });

  it("switches back to a newer legacy family instead of following historical per-member rows forever", async () => {
    const dbPath = freshDbPath();
    const oldMemberAt = new Date(MIDDAY_ET - 26 * 60 * 60_000).toISOString();
    const legacyAt = new Date(MIDDAY_ET - 30 * 60_000).toISOString();
    seedSnapshot(dbPath, "hourly_poll_per_member", oldMemberAt, "member_retired");
    seedSnapshot(dbPath, "post_open_pnl_per_member", oldMemberAt, "member_retired");
    seedSnapshot(dbPath, "hourly_poll", legacyAt);
    seedSnapshot(dbPath, "post_open_pnl", legacyAt);
    const repoRoot = makeTempDir("alphaloop-doctor-paper-return-legacy-");
    const reportDir = join(repoRoot, "reports", "official-paper");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, `${legacyAt.slice(0, 10)}-post-open.md`), "# 官方模拟盘\n");

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(paperSnapshot(dbPath, { repoRoot }));

    expect(report.ok).toBe(true);
    expect(report.findings.some((finding) => finding.code.startsWith("official-paper-health."))).toBe(false);
  });

  it("does not require artifacts for owners absent from the latest per-member run date", async () => {
    const dbPath = freshDbPath();
    const retiredAt = new Date(MIDDAY_ET - 26 * 60 * 60_000).toISOString();
    const currentAt = new Date(MIDDAY_ET - 30 * 60_000).toISOString();
    seedSnapshot(dbPath, "hourly_poll_per_member", retiredAt, "member_retired");
    seedSnapshot(dbPath, "post_open_pnl_per_member", retiredAt, "member_retired");
    seedSnapshot(dbPath, "hourly_poll_per_member", currentAt, "member_1");
    seedSnapshot(dbPath, "post_open_pnl_per_member", currentAt, "member_1");
    const repoRoot = makeTempDir("alphaloop-doctor-paper-retired-owner-");
    const reportDir = join(repoRoot, "reports", "official-paper");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, `${currentAt.slice(0, 10)}-post-open--member_1.md`), "# 官方模拟盘\n");

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(paperSnapshot(dbPath, { repoRoot }));

    expect(report.ok).toBe(true);
    expect(report.findings.some((finding) => finding.code.startsWith("official-paper-health."))).toBe(false);
  });

  it("does not keep a withdrawn poll owner in later same-day hourly batches", async () => {
    const dbPath = freshDbPath();
    const retiredPollAt = new Date(MIDDAY_ET - 3 * 60 * 60_000).toISOString();
    const currentAt = new Date(MIDDAY_ET - 30 * 60_000).toISOString();
    seedSnapshot(dbPath, "hourly_poll_per_member", retiredPollAt, "member_retired");
    seedSnapshot(dbPath, "hourly_poll_per_member", currentAt, "member_1");
    seedSnapshot(dbPath, "post_open_pnl_per_member", currentAt, "member_1");
    const repoRoot = makeTempDir("alphaloop-doctor-paper-retired-poll-");
    const reportDir = join(repoRoot, "reports", "official-paper");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, `${currentAt.slice(0, 10)}-post-open--member_1.md`), "# 官方模拟盘\n");

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(paperSnapshot(dbPath, { repoRoot }));

    expect(report.ok).toBe(true);
    expect(report.findings.some((finding) => finding.code.startsWith("official-paper-health."))).toBe(false);
  });

  it("fails when yesterday's pnl row is the newest one an hour after today's run was due", async () => {
    const dbPath = freshDbPath();
    seedSnapshot(dbPath, "hourly_poll", new Date(MIDDAY_ET - 30 * 60_000).toISOString());
    seedSnapshot(dbPath, "post_open_pnl", new Date(MIDDAY_ET - 26 * 60 * 60_000).toISOString());

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(paperSnapshot(dbPath));

    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "official-paper-health.pnl.stale", severity: "error" })
    ]));
  });

  it("fails when the pnl job wrote its snapshot but never produced the report file", async () => {
    const dbPath = freshDbPath();
    seedSnapshot(dbPath, "hourly_poll", new Date(MIDDAY_ET - 30 * 60_000).toISOString());
    seedSnapshot(dbPath, "post_open_pnl", new Date(MIDDAY_ET - 2 * 60 * 60_000).toISOString());
    const repoRoot = makeTempDir("alphaloop-doctor-paper-repo-");

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(paperSnapshot(dbPath, { repoRoot }));

    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "official-paper-health.pnl.report_missing", severity: "error" })
    ]));
  });

  it("warns, without failing, when the daemons are installed but have never written a row", async () => {
    const report = await doctor.analyzeOpenClawRuntimeSnapshot(paperSnapshot(freshDbPath()));

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "official-paper-health.poll.never_ran", severity: "warn" }),
      expect.objectContaining({ code: "official-paper-health.pnl.never_ran", severity: "warn" })
    ]));
  });

  it("says nothing outside US regular market hours, when both jobs legitimately skip every tick", async () => {
    const dbPath = freshDbPath();
    seedSnapshot(dbPath, "hourly_poll", "2026-07-01T14:00:00.000Z");

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(paperSnapshot(dbPath, {
      ...OUTSIDE_MARKET_HOURS
    }));

    expect(report.findings.some((finding) => finding.code.startsWith("official-paper-health."))).toBe(false);
  });

  it("says nothing in the first two hours of the session, when yesterday's row is still the newest one legitimately", async () => {
    const dbPath = freshDbPath();
    seedSnapshot(dbPath, "hourly_poll", "2026-07-27T18:00:00.000Z");
    seedSnapshot(dbPath, "post_open_pnl", "2026-07-27T14:00:00.000Z");

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(paperSnapshot(dbPath, {
      // 2026-07-28 10:00 America/New_York - 30 minutes past the open.
      nowMs: Date.parse("2026-07-28T14:00:00.000Z")
    }));

    expect(report.findings.some((finding) => finding.code.startsWith("official-paper-health."))).toBe(false);
  });

  it("stays silent on a machine where neither official-paper daemon is installed", async () => {
    const dbPath = freshDbPath();

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(paperSnapshot(dbPath, {
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED.map((row) => (
        row.label.startsWith("com.openclaw.trading.official-paper.")
          ? { ...row, loadedDomains: [], state: null }
          : row
      ))
    }));

    expect(report.findings.some((finding) => finding.code.startsWith("official-paper-health."))).toBe(false);
  });
});

// Round-4 finding I5 (b): the doctor used to open the live trading database
// through openTradingDatabase, which runs migrate() - a health check able to
// change the schema of the database it is inspecting, and to CREATE it from
// nothing on a machine where no service had ever run.
describe("the health probes never write to the trading database (round-4 finding I5b)", () => {
  it("leaves the schema version, the file bytes and every table untouched", async () => {
    const dir = makeTempDir("alphaloop-doctor-readonly-");
    const dbPath = join(dir, "trading.sqlite");
    const seed = openTradingDatabase(dbPath);
    recordJobRun(seed, {
      job: "market-alerts",
      startedAt: new Date(Date.parse("2026-07-11T11:50:00.000Z")).toISOString(),
      ok: true
    });
    // Deliberately roll the schema version BACKWARDS. If anything in the
    // doctor still called migrate(), this row would be silently upgraded
    // again and the assertion below would catch it.
    seed.exec("PRAGMA user_version = 1;");
    const versionBefore = seed.prepare("PRAGMA user_version").get() as { user_version: number };
    seed.close();

    const before = statSync(dbPath);

    await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      ...OUTSIDE_MARKET_HOURS,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      runtimeRoot: dir,
      dbPath
    });

    const check = new DatabaseSync(dbPath, { readOnly: true });
    const versionAfter = check.prepare("PRAGMA user_version").get() as { user_version: number };
    check.close();

    expect(versionAfter.user_version).toBe(versionBefore.user_version);
    expect(versionBefore.user_version).toBe(1);
    expect(statSync(dbPath).size).toBe(before.size);
    expect(statSync(dbPath).mtimeMs).toBe(before.mtimeMs);
  });

  it("does not create the trading database on a machine where nothing has ever run", async () => {
    const dir = makeTempDir("alphaloop-doctor-nodb-");
    const dbPath = join(dir, "trading.sqlite");

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      ...OUTSIDE_MARKET_HOURS,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
      dbPath
    });

    expect(existsSync(dbPath)).toBe(false);
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "alerts-poller-health.db_missing", severity: "warn" })
    ]));
  });
});

describe("failure isolation across checks (task H2 fix round)", () => {
  it("keeps every other check's findings intact, plus one error finding for the thrower, when a single check throws", async () => {
    // A crafted "malicious" runner result whose `job` getter throws - this
    // drives a REAL throw out of the existing runner.recent_failure check
    // (via latestRunnerResultsByJob's `result?.job` access) rather than
    // mocking anything, so this proves the isolation mechanism against an
    // actual failure mode, not a strawman.
    const throwingRunnerResult = Object.defineProperty({}, "job", {
      get() {
        throw new Error("boom - injected throwing check");
      }
    });

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: doctor.REQUIRED_LAUNCHD_JOBS.map((job) => ({
        label: job.label,
        expectedDomain: job.domain,
        loadedDomains: [],
        state: null
      })),
      recentRunnerResults: [throwingRunnerResult]
    });

    // The thrower gets its own scoped error finding...
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", code: "doctor.check_failed.runner-recent-failures" })
    ]));

    // ...and every OTHER check still ran and reported normally: gateway/
    // runner listeners are healthy (no findings for them), and launchd-jobs
    // still produced its usual three warns exactly as it would with no
    // thrower in the picture at all.
    expect(report.findings.some((entry) => entry.code === "gateway.not_listening")).toBe(false);
    expect(report.findings.some((entry) => entry.code === "runner.not_listening")).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "launchd-jobs.daily-backup.not_loaded", severity: "warn" }),
      expect.objectContaining({ code: "launchd-jobs.market-alerts.not_loaded", severity: "warn" }),
      expect.objectContaining({ code: "launchd-jobs.platform-app.not_loaded", severity: "warn" })
    ]));
  });
});

// v2 persona deployment fix (the #1 user complaint: the deployed Feishu bot
// answered as vanilla Codex) - "control-persona" check: the control
// workspace's AGENTS.md is the persona file the embedded codex harness
// reads, and with skipBootstrap:true only render-openclaw-config.mjs's
// installControlPersona ever writes it. Missing or empty means the bot runs
// with no persona while every other signal stays green -> severity error.
describe("control-persona check (v2 persona deployment fix)", () => {
  function baseSnapshot() {
    return {
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_STUBBED_OK,
      ...RSSHUB_HEALTH_STUBBED_OK,
      ...BROKER_EXECUTOR_HEALTH_STUBBED_OK,
      launchdJobs: ALL_LAUNCHD_JOBS_LOADED
    };
  }

  it("fails when the control workspace AGENTS.md does not exist, pointing at the render script", async () => {
    const dir = makeTempDir("alphaloop-doctor-persona-missing-");
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...baseSnapshot(),
      controlWorkspaceAgentsPath: join(dir, "AGENTS.md")
    });

    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "control-persona.missing", severity: "error" })
    ]));
    const message = report.findings.find((entry) => entry.code === "control-persona.missing")?.message;
    expect(message).toContain("render-openclaw-config.mjs");
  });

  it("fails when the control workspace AGENTS.md exists but is empty (whitespace-only counts as empty)", async () => {
    const dir = makeTempDir("alphaloop-doctor-persona-empty-");
    const personaPath = join(dir, "AGENTS.md");
    writeFileSync(personaPath, "  \n\n\t\n");

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...baseSnapshot(),
      controlWorkspaceAgentsPath: personaPath
    });

    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "control-persona.empty", severity: "error" })
    ]));
    const message = report.findings.find((entry) => entry.code === "control-persona.empty")?.message;
    expect(message).toContain("render-openclaw-config.mjs");
  });

  it("reports nothing when the persona file exists and is non-empty", async () => {
    const dir = makeTempDir("alphaloop-doctor-persona-ok-");
    const personaPath = join(dir, "AGENTS.md");
    writeFileSync(personaPath, "# Trading Copilot\n\n人设内容。\n");

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...baseSnapshot(),
      controlWorkspaceAgentsPath: personaPath
    });

    expect(report.ok).toBe(true);
    expect(report.findings.some((finding) => finding.code.startsWith("control-persona."))).toBe(false);
  });
});

// ===========================================================================
// Round 6 (2026-07-29): the checks that close the "failure did not become a red
// light" class. Each case is written from a MEASURED shape - the mini's own
// `launchctl print` output, the deploy target's own unset variables - and each
// asserts on `ok`, because `ok` is what runbook step 8 turns into an exit code.
// ===========================================================================
describe("round 6 - deploy-path checks", () => {
  const persona = () => {
    const dir = mkdtempSync(join(tmpdir(), "alphaloop-r6-persona-"));
    const path = join(dir, "AGENTS.md");
    writeFileSync(path, "# 控制人设\n");
    return path;
  };

  const baseline = (extra: Record<string, unknown> = {}) => ({
    ...HEALTHY_LISTENERS,
    controlWorkspaceAgentsPath: persona(),
    launchdJobs: ALL_LAUNCHD_JOBS_LOADED,
    fetchImpl: async (url: string) => new Response(
      JSON.stringify({ ok: true, service: url.includes("4312") ? "broker-executor" : "platform-app" }),
      { status: 200, headers: { "content-type": "application/json" } }
    ),
    ...extra
  });

  describe("S3c: a resident daemon killed by a SIGNAL", () => {
    // The shape the mini's com.alphaloop.platform-app prints RIGHT NOW: a job
    // whose last termination was by signal prints NO `last exit code` line at
    // all, it prints `last terminating signal` instead. The old rule keyed the
    // entire crash-detection branch off a non-zero `last exit code`, so this
    // whole family of deaths was invisible.
    const signalKilled = (overrides: Record<string, unknown>) => ALL_LAUNCHD_JOBS_LOADED.map((row) => (
      row.label === "com.alphaloop.platform-app" ? { ...row, ...overrides } : row
    ));

    it("reports a crash loop even though launchd printed no exit code", async () => {
      const analysis = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({
        // Round-7 K6: 918 relaunches an hour after the install that zeroed the
        // counter. The window is what makes this a loop rather than a number.
        deployLedger: installedAgo(HOUR_MS, Date.now()),
        launchdJobs: signalKilled({
          state: "running",
          lastExitCode: null,
          lastTerminatingSignal: "Segmentation fault: 11",
          runs: 918,
          pid: 4242
        })
      }));

      const finding = analysis.findings.find((f) => f.code === "launchd-jobs.platform-app.crash_looping");
      expect(finding?.severity).toBe("error");
      expect(finding?.message).toMatch(/Segmentation fault: 11/u);
      expect(analysis.ok).toBe(false);
    });

    it("does NOT cry crash for the SIGTERM the installer itself sends", async () => {
      // `launchctl kickstart -k` - which install-system-daemons.sh runs against
      // every daemon on every run - terminates the job with SIGTERM and leaves
      // exactly this record. Counting it would make every healthy install
      // report eight crashes. Measured on the mini: platform-app prints
      // `last terminating signal = Terminated: 15`, state = running, runs = 2.
      const analysis = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({
        launchdJobs: signalKilled({
          state: "running",
          lastExitCode: null,
          lastTerminatingSignal: "Terminated: 15",
          runs: 2,
          pid: 4242
        })
      }));

      expect(analysis.findings.filter((f) => f.code.startsWith("launchd-jobs.platform-app."))).toEqual([]);
      expect(analysis.ok).toBe(true);
    });

    it("still reports a signal death that is not an orderly stop, below the loop threshold", async () => {
      const analysis = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({
        launchdJobs: signalKilled({
          state: "running",
          lastExitCode: null,
          lastTerminatingSignal: "Abort trap: 6",
          runs: 3,
          pid: 4242
        })
      }));

      const finding = analysis.findings.find((f) => f.code === "launchd-jobs.platform-app.restarted_after_failure");
      expect(finding?.severity).toBe("warn");
      expect(finding?.message).toMatch(/Abort trap: 6/u);
    });
  });

  describe("S3g: the five report cron jobs", () => {
    it("fails the gate when openclaw cron holds none of them", async () => {
      const analysis = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({
        openclawCron: { ok: true, names: ["some-unrelated-personal-job"] }
      }));

      const finding = analysis.findings.find((f) => f.code === "openclaw-cron.jobs_missing");
      expect(finding?.severity).toBe("error");
      expect(finding?.message).toMatch(/缺 5\/5 个报告类任务/u);
      expect(analysis.ok).toBe(false);
    });

    it("passes when all five are registered", async () => {
      const names = buildManagedOpenClawCronJobs(
        fileURLToPath(new URL("../../..", import.meta.url))
      ).map((job) => job.name);
      const analysis = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({
        openclawCron: { ok: true, names }
      }));

      expect(analysis.findings.filter((f) => f.code.startsWith("openclaw-cron."))).toEqual([]);
    });

    // Round-7 finding K8. This gateway also serves the operator's personal
    // 186-agent fleet and the registry is paged; "not in the page I was handed"
    // must not be reported as "not installed", because that is a red light on a
    // machine where all five jobs exist.
    it("does not call a truncated page a missing job", async () => {
      const analysis = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({
        openclawCron: { ok: true, names: ["someone-elses-job"], total: 240, truncated: true }
      }));

      expect(analysis.findings.map((f) => f.code)).not.toContain("openclaw-cron.jobs_missing");
      const finding = analysis.findings.find((f) => f.code === "openclaw-cron.list_truncated");
      expect(finding?.severity).toBe("warn");
      expect(finding?.message).toMatch(/这次没看全/u);
      expect(analysis.ok).toBe(true);
    });

    // The other K8 half: `openclaw cron list` hides disabled jobs unless asked,
    // so a job that exists and will never fire used to read as missing. Both
    // are broken; the repair is different, so the message has to be.
    it("reports a disabled job as disabled rather than missing", async () => {
      const names = buildManagedOpenClawCronJobs(
        fileURLToPath(new URL("../../..", import.meta.url))
      ).map((job) => job.name);
      const analysis = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({
        openclawCron: { ok: true, names: names.slice(1), disabledNames: [names[0]] }
      }));

      expect(analysis.findings.map((f) => f.code)).not.toContain("openclaw-cron.jobs_missing");
      const finding = analysis.findings.find((f) => f.code === "openclaw-cron.jobs_disabled");
      expect(finding?.severity).toBe("error");
      expect(finding?.message).toMatch(/disabled 的任务不会被派发/u);
      expect(analysis.ok).toBe(false);
    });

    it("an unreadable cron registry is an error on a deployed machine and a warn on a dev box", async () => {
      const deployed = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({
        openclawCron: { ok: false, error: "GatewayTransportError: connect ECONNREFUSED 127.0.0.1:18789", names: [] }
      }));
      expect(deployed.findings.find((f) => f.code === "openclaw-cron.unreadable")?.severity).toBe("error");

      const devBox = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({
        launchdJobs: doctor.REQUIRED_LAUNCHD_JOBS.map((job) => ({
          label: job.label,
          expectedDomain: job.domain,
          loadedDomains: [],
          state: null
        })),
        launchdPlists: { system: [], user: [] },
        openclawCron: { ok: false, error: "gateway cron.list requires credentials", names: [] }
      }));
      expect(devBox.findings.find((f) => f.code === "openclaw-cron.unreadable")?.severity).toBe("warn");
    });
  });

  describe("S3h: where a public report card actually lands", () => {
    it("fails the gate when FEISHU_GROUP_CHAT_ID and PLATFORM_PUBLIC_BASE_URL are unset", async () => {
      // The deploy target's shape today (verified read-only; the values, when
      // set, are never read or printed by this check - only their presence).
      const analysis = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({
        notificationRouting: {
          groupChatIdConfigured: false,
          publicBaseUrlConfigured: false,
          fallbackTargetConfigured: true,
          lastDeliveryGroupFallback: false
        }
      }));

      const codes = analysis.findings.filter((f) => f.severity === "error").map((f) => f.code);
      expect(codes).toContain("notification-routing.no_group_chat");
      expect(codes).toContain("notification-routing.no_public_base_url");
      expect(analysis.findings.find((f) => f.code === "notification-routing.no_group_chat")?.message)
        .toMatch(/改投默认单聊/u);
      expect(analysis.ok).toBe(false);
    });

    it("reports a delivery that actually fell back to a DM", async () => {
      const analysis = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({
        notificationRouting: {
          groupChatIdConfigured: true,
          publicBaseUrlConfigured: true,
          fallbackTargetConfigured: true,
          lastDeliveryGroupFallback: true,
          lastDeliverySent: true,
          lastDeliveryLabel: "daily:2026-07-28",
          lastDeliveryAt: "2026-07-28T12:00:00.000Z",
          lastDeliveryReason: "未配置 FEISHU_GROUP_CHAT_ID，公共报告卡改发默认目标"
        }
      }));

      const finding = analysis.findings.find((f) => f.code === "notification-routing.last_delivery_missed_group");
      expect(finding?.severity).toBe("error");
      expect(finding?.message).toMatch(/daily:2026-07-28/u);
      expect(analysis.ok).toBe(false);
    });

    // Round-7 finding K5. This is the shape the deploy target produces TODAY,
    // and the shape the check could not see: after J2 a circle-public report
    // with no group chat is refused, so `groupFallback: true` arrives with
    // `sent: false` - an entry that carries `deliveryFailedAt` and never a
    // `deliveredAt`. The CLI half of this (ranking by
    // `deliveredAt ?? deliveryFailedAt`) is covered in the doctor CLI's own
    // reading of report-delivery-state.json; this asserts the analyzer says the
    // right thing about it.
    it("reports the refusal shape too, and says the report never reached the group", async () => {
      const analysis = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({
        notificationRouting: {
          groupChatIdConfigured: false,
          publicBaseUrlConfigured: true,
          fallbackTargetConfigured: true,
          lastDeliveryGroupFallback: true,
          lastDeliverySent: false,
          lastDeliveryLabel: "weekly:2026-07-26",
          lastDeliveryAt: "2026-07-26T12:00:00.000Z",
          lastDeliveryReason: "圈子公共报告没有配置群聊目标（FEISHU_GROUP_CHAT_ID）"
        }
      }));

      const finding = analysis.findings.find((f) => f.code === "notification-routing.last_delivery_missed_group");
      expect(finding?.severity).toBe("error");
      expect(finding?.message).toMatch(/被投递层拒发/u);
      expect(finding?.message).toMatch(/weekly:2026-07-26/u);
      expect(analysis.ok).toBe(false);
    });

    it("says nothing when routing is configured and the last delivery reached the group", async () => {
      const analysis = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({
        notificationRouting: {
          groupChatIdConfigured: true,
          publicBaseUrlConfigured: true,
          fallbackTargetConfigured: true,
          lastDeliveryGroupFallback: false
        }
      }));

      expect(analysis.findings.filter((f) => f.code.startsWith("notification-routing."))).toEqual([]);
    });
  });

  describe("S3b: is this checkout the code that was pushed", () => {
    it("fails the gate when HEAD is behind origin/main", async () => {
      const analysis = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({
        git: { head: "14b1202", remoteHead: "a4e39c1", behind: 43, dirtyFiles: ["README.md"] }
      }));

      const finding = analysis.findings.find((f) => f.code === "deploy-checkout.behind_origin");
      expect(finding?.severity).toBe("error");
      expect(finding?.message).toMatch(/落后 43 个提交/u);
      expect(finding?.message).toMatch(/README\.md/u);
      expect(analysis.ok).toBe(false);
    });

    it("only warns about a dirty tree when the commit itself is current", async () => {
      const analysis = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({
        git: {
          head: "a4e39c1",
          remoteHead: "a4e39c1",
          behind: 0,
          dirtyFiles: ["README.md"],
          remoteTip: "a4e39c1",
          remoteTipKnownLocally: true,
          behindRemoteTip: 0
        }
      }));

      expect(analysis.findings.find((f) => f.code === "deploy-checkout.dirty")?.severity).toBe("warn");
      expect(analysis.ok).toBe(true);
    });

    // Round-7 finding K7. THE DEPLOY TARGET'S SHAPE TODAY, measured read-only
    // on 2026-07-29: HEAD = 14b1202, the LOCAL origin/main ref = 14b1202,
    // behind = 0, tree clean - and the real origin/main is a4e39c1, five
    // commits ahead. Every input this check used to have said "fine".
    it("fails the gate on a machine that never fetched the commits it is behind by", async () => {
      const analysis = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({
        git: {
          head: "14b1202",
          remoteHead: "14b1202",
          behind: 0,
          ahead: 0,
          dirtyFiles: [],
          remoteTip: "a4e39c1",
          remoteTipKnownLocally: false,
          behindRemoteTip: null
        }
      }));

      const finding = analysis.findings.find((f) => f.code === "deploy-checkout.never_fetched");
      expect(finding?.severity).toBe("error");
      expect(finding?.message).toMatch(/连这个 commit 都没有/u);
      expect(analysis.ok).toBe(false);
    });

    // Round-8 finding L4. K7's own fix had the round-5/6/7 shape inside it: when
    // `ls-remote` cannot answer, the check fell straight back to `behind`,
    // computed from the very local ref K7 had just proved untrustworthy, and
    // said so as a WARN. MEASURED with the deploy target's exact git state plus
    // an unreachable origin: gate ok=TRUE, zero errors, two warns - a machine
    // running code that was never fetched passed whenever the network was down.
    //
    // The severity now depends on whether anything corroborates the local ref.
    // Step 0's receipt is the only thing that can: it IS `git fetch origin &&
    // git pull --ff-only`, so an exit-0 step-0 receipt at the commit checked out
    // now proves a real fetch reached origin and landed here.
    const UNREACHABLE_ORIGIN = {
      head: "14b1202",
      remoteHead: "14b1202",
      behind: 0,
      ahead: 0,
      dirtyFiles: [],
      remoteTip: null,
      remoteTipError: "ssh: connect to host github.com port 22: Network is unreachable",
      remoteTipKnownLocally: null,
      behindRemoteTip: null
    };

    it("fails the gate when origin cannot be reached and nothing corroborates the local ref", async () => {
      // The mini's shape today: a heavy deploy footprint, no ledger at all.
      const analysis = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({
        deployLedger: [],
        gitHead: "14b1202",
        git: UNREACHABLE_ORIGIN
      }));

      const finding = analysis.findings.find((f) => f.code === "deploy-checkout.remote_unverified");
      expect(finding?.severity).toBe("error");
      expect(finding?.message).toMatch(/Network is unreachable/u);
      expect(finding?.message).toMatch(/没有】任何一条"在当前检出 14b1202 上成功跑过第 0 步"的收据/u);
      expect(analysis.ok).toBe(false);
    });

    it("downgrades to a warning when a step-0 receipt for THIS commit corroborates it", async () => {
      const analysis = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({
        deployLedger: [
          ...INSTALLED_AN_HOUR_AGO,
          { attempt: "a1", step: 0, key: "pull", exitCode: 0, head: "14b1202", finishedAt: "2026-07-29T02:00:00Z" }
        ],
        gitHead: "14b1202",
        git: UNREACHABLE_ORIGIN
      }));

      const finding = analysis.findings.find((f) => f.code === "deploy-checkout.remote_unverified");
      expect(finding?.severity).toBe("warn");
      expect(finding?.message).toMatch(/只基于本地那份 origin\/main 引用/u);
      expect(finding?.message).toMatch(/那一次 fetch \+ pull 确实连上了 origin/u);
    });

    it("does not accept a step-0 receipt from a different commit as corroboration", async () => {
      const analysis = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({
        deployLedger: [
          { attempt: "a1", step: 0, key: "pull", exitCode: 0, head: "deadbee", finishedAt: "2026-07-01T02:00:00Z" }
        ],
        gitHead: "14b1202",
        git: UNREACHABLE_ORIGIN
      }));

      expect(analysis.findings.find((f) => f.code === "deploy-checkout.remote_unverified")?.severity).toBe("error");
      expect(analysis.ok).toBe(false);
    });
  });

  describe("the deploy ledger", () => {
    it("turns a failed step into an error, and a re-run of that step clears it", async () => {
      const failed = [
        { attempt: "a1", step: 3, key: "install-system-daemons", exitCode: 1, head: "a4e39c1", finishedAt: "2026-07-29T01:00:00Z" }
      ];
      const analysis = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({
        deployLedger: failed,
        gitHead: "a4e39c1"
      }));
      expect(analysis.findings.find((f) => f.code === "deploy-ledger.step_3_failed")?.severity).toBe("error");
      expect(analysis.ok).toBe(false);

      const fixed = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({
        deployLedger: [
          ...failed,
          { attempt: "a2", step: 3, key: "install-system-daemons", exitCode: 0, head: "a4e39c1", finishedAt: "2026-07-29T01:10:00Z" }
        ],
        gitHead: "a4e39c1"
      }));
      expect(fixed.findings.filter((f) => f.code === "deploy-ledger.step_3_failed")).toEqual([]);
    });

    it("says nothing at all on a machine that has never deployed", async () => {
      const analysis = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({
        launchdJobs: doctor.REQUIRED_LAUNCHD_JOBS.map((job) => ({
          label: job.label,
          expectedDomain: job.domain,
          loadedDomains: [],
          state: null
        })),
        launchdPlists: { system: [], user: [] },
        deployLedger: []
      }));

      expect(analysis.findings.filter((f) => f.code.startsWith("deploy-ledger."))).toEqual([]);
    });

    // Round 7: `deploy-ledger.incomplete` shipped in round 6 as part of the
    // mechanism described as catching a half-finished deploy, and no test in
    // the tree named it - which is a claim of coverage rather than coverage.
    // It stays a WARN on purpose: an operator who ran the runbook by hand
    // before this file existed leaves exactly this shape, and "we have no
    // receipt" is not "the step failed".
    it("reports steps with no receipt without calling them failures", async () => {
      const analysis = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({
        deployLedger: [
          { attempt: "a1", step: 3, key: "install-system-daemons", exitCode: 0, head: "a4e39c1", finishedAt: "2026-07-29T01:00:00Z" }
        ],
        gitHead: "a4e39c1"
      }));

      const finding = analysis.findings.find((f) => f.code === "deploy-ledger.incomplete");
      expect(finding?.severity).toBe("warn");
      // Every required step except the one that left a receipt.
      expect(finding?.message).toMatch(/第 0 步/u);
      expect(finding?.message).not.toMatch(/第 3 步/u);
      expect(analysis.ok).toBe(true);
    });

    // =====================================================================
    // Round-8 finding L3: THE READ HALF. K1 closed the write half (a receipt
    // that cannot be APPENDED aborts the deploy and reddens the gate). Reading
    // still answered `[]` for every kind of failure, and `[]` means
    // `deployed: false`, which is at most a warn.
    //
    // MEASURED, both starting from a real deploy whose step 3 had failed - the
    // receipt `3:1` was on disk in each case:
    //   `chmod 0222 steps.jsonl` -> gate ok=TRUE with ZERO deploy-ledger
    //       findings, not even `absent`, because deployFootprint's own first
    //       signal was "readLedgerEntries().length > 0" too;
    //   `rm steps.jsonl`         -> gate ok=TRUE, one warn.
    // A failed deploy erased by deleting one file.
    // =====================================================================
    const ledgerOnDisk = (prefix: string, lines: string[]): string => {
      const runtimeRoot = join(makeTempDir(prefix), "runtime");
      mkdirSync(join(runtimeRoot, "deploy"), { recursive: true });
      writeFileSync(join(runtimeRoot, "deploy", "steps.jsonl"), lines.map((line) => `${line}\n`).join(""));
      return runtimeRoot;
    };

    const FAILED_STEP_3 = JSON.stringify({
      attempt: "a1", step: 3, key: "install-system-daemons", exitCode: 1, head: "a4e39c1", finishedAt: "2026-07-29T01:00:00Z"
    });

    it("fails the gate when the ledger is there and cannot be read", async () => {
      const runtimeRoot = ledgerOnDisk("alphaloop-r8-ledger-unreadable-", [FAILED_STEP_3]);
      const ledgerPath = join(runtimeRoot, "deploy", "steps.jsonl");
      chmodSync(ledgerPath, 0o222);
      try {
        const analysis = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({ runtimeRoot, gitHead: "a4e39c1" }));

        const finding = analysis.findings.find((f) => f.code === "deploy-ledger.unreadable");
        expect(finding?.severity).toBe("error");
        expect(finding?.message).toMatch(/EACCES/u);
        expect(analysis.ok).toBe(false);
      } finally {
        chmodSync(ledgerPath, 0o644);
      }
    });

    it("fails the gate when the ledger was deleted but its directory is still there", async () => {
      const runtimeRoot = ledgerOnDisk("alphaloop-r8-ledger-removed-", [FAILED_STEP_3]);
      rmSync(join(runtimeRoot, "deploy", "steps.jsonl"));

      const analysis = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({ runtimeRoot, gitHead: "a4e39c1" }));

      const finding = analysis.findings.find((f) => f.code === "deploy-ledger.lost");
      expect(finding?.severity).toBe("error");
      expect(finding?.message).toMatch(/那个目录只有写收据的时候才会被建出来/u);
      expect(analysis.ok).toBe(false);
    });

    it("fails the gate when the ledger file survives with nothing usable in it", async () => {
      const runtimeRoot = ledgerOnDisk("alphaloop-r8-ledger-emptied-", []);

      const analysis = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({ runtimeRoot, gitHead: "a4e39c1" }));

      const finding = analysis.findings.find((f) => f.code === "deploy-ledger.lost");
      expect(finding?.severity).toBe("error");
      expect(finding?.message).toMatch(/一条可用的收据都没有/u);
      expect(analysis.ok).toBe(false);
    });

    // The other side of the same rule, so it cannot be satisfied by turning
    // every quiet machine red: a runtime tree that never had a ledger at all is
    // the hand-run runbook, and that is still a warn.
    it("still only warns when no ledger was ever written on this machine", async () => {
      const runtimeRoot = join(makeTempDir("alphaloop-r8-ledger-never-"), "runtime");
      mkdirSync(runtimeRoot, { recursive: true });

      const analysis = await doctor.analyzeOpenClawRuntimeSnapshot(baseline({ runtimeRoot, gitHead: "a4e39c1" }));

      expect(analysis.findings.find((f) => f.code === "deploy-ledger.absent")?.severity).toBe("warn");
      expect(analysis.findings.filter((f) => f.code === "deploy-ledger.lost")).toEqual([]);
    });
  });
});
