import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { openTradingDatabase } from "../../../packages/shared-types/dist/index.js";
import { recordJobRun } from "./job-run-log.mjs";

const doctor = await import("./openclaw-runtime-doctor-core.mjs");
const newsStore = await import("./news-store.mjs");

// Shared "everything else is healthy" listener stub so the new task H2
// checks below (launchd-jobs / alerts-poller-health) can be asserted on in
// isolation, without the pre-existing gateway/runner checks also firing.
const HEALTHY_LISTENERS = {
  gatewayListeners: [{ pid: 100, command: "node", endpoint: "127.0.0.1:18789" }],
  cronRunnerListeners: [{ pid: 200, command: "node", endpoint: "127.0.0.1:18792" }]
};

// Phase 3 Task 8 added com.alphaloop.platform-app as a third required
// launchd job alongside the original two from task H2. Phase 4 Task 8 adds
// com.alphaloop.rsshub as a fourth.
const ALL_LAUNCHD_JOBS_LOADED = [
  "com.alphaloop.daily-backup",
  "com.alphaloop.market-alerts",
  "com.alphaloop.platform-app",
  "com.alphaloop.rsshub"
];

// Phase 3 Task 8: analyzeOpenClawRuntimeSnapshot now always runs a real HTTP
// check against platform-app's /health (see checkPlatformAppHealth) -
// pointing every test below that ISN'T specifically about that check at a
// port nothing ever listens on keeps the whole suite hermetic. This matters
// in practice, not just in theory: a real `pnpm platform:dev` happens to be
// running on the production default port (4314) on dev machines fairly
// often, and this suite must not silently change behavior depending on
// whether that's true when it runs.
const PLATFORM_APP_HEALTH_DISABLED = { platformAppPort: 1 };

// Phase 4 Task 8 (news engine deployment wiring): analyzeOpenClawRuntimeSnapshot
// now also runs a real HTTP check against RSSHub's /healthz (see
// checkRsshubHealth) - same hermetic-suite concern as
// PLATFORM_APP_HEALTH_DISABLED above (a dev box legitimately running the
// rsshub Docker container on its default port 1200 must not change this
// suite's behavior). Port 1 refuses the connection practically instantly
// without needing a fake listener.
const RSSHUB_HEALTH_DISABLED = { rsshubBaseUrl: "http://127.0.0.1:1" };

// v2 persona deployment fix: analyzeOpenClawRuntimeSnapshot now also checks
// that the control agent workspace's AGENTS.md (the persona file
// render-openclaw-config.mjs installs) exists and is non-empty - same
// hermetic-suite concern as PLATFORM_APP_HEALTH_DISABLED /
// RSSHUB_HEALTH_DISABLED above: whether the REAL ~/.openclaw/workspaces/
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
      ...PLATFORM_APP_HEALTH_DISABLED,
      ...RSSHUB_HEALTH_DISABLED,
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
      ...PLATFORM_APP_HEALTH_DISABLED,
      ...RSSHUB_HEALTH_DISABLED,
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
      ...PLATFORM_APP_HEALTH_DISABLED,
      ...RSSHUB_HEALTH_DISABLED,
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
      ...PLATFORM_APP_HEALTH_DISABLED,
      ...RSSHUB_HEALTH_DISABLED,
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

describe("launchd-jobs check (task H2, extended Phase 3 Task 8 with platform-app, Phase 4 Task 8 with rsshub)", () => {
  it("warns, but does not fail, when none of the required jobs are loaded", async () => {
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_DISABLED,
      ...RSSHUB_HEALTH_DISABLED,
      launchdJobLabels: []
    });

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "launchd-jobs.daily-backup.not_loaded", severity: "warn" }),
      expect.objectContaining({ code: "launchd-jobs.market-alerts.not_loaded", severity: "warn" }),
      expect.objectContaining({ code: "launchd-jobs.platform-app.not_loaded", severity: "warn" }),
      expect.objectContaining({ code: "launchd-jobs.rsshub.not_loaded", severity: "warn" })
    ]));
  });

  it("reports nothing for launchd-jobs once all four are loaded", async () => {
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_DISABLED,
      ...RSSHUB_HEALTH_DISABLED,
      launchdJobLabels: [...ALL_LAUNCHD_JOBS_LOADED, "com.openclaw.gateway"]
    });

    expect(report.ok).toBe(true);
    expect(report.findings.some((finding) => finding.code.startsWith("launchd-jobs."))).toBe(false);
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
      ...PLATFORM_APP_HEALTH_DISABLED,
      ...RSSHUB_HEALTH_DISABLED,
      launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED,
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
      ...PLATFORM_APP_HEALTH_DISABLED,
      ...RSSHUB_HEALTH_DISABLED,
      launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED,
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
      ...PLATFORM_APP_HEALTH_DISABLED,
      ...RSSHUB_HEALTH_DISABLED,
      launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED,
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
      ...PLATFORM_APP_HEALTH_DISABLED,
      ...RSSHUB_HEALTH_DISABLED,
      launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED,
      nowMs: Date.parse("2026-07-13T15:00:00.000Z"), // Monday 11:00am US Eastern (EDT) - regular market hours
      dbPath
    });

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "alerts-poller-health.stale_heartbeat", severity: "warn" })
    ]));
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
      ...PLATFORM_APP_HEALTH_DISABLED,
      ...RSSHUB_HEALTH_DISABLED,
      launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED,
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
      ...PLATFORM_APP_HEALTH_DISABLED,
      ...RSSHUB_HEALTH_DISABLED,
      launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED,
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
      ...PLATFORM_APP_HEALTH_DISABLED,
      ...RSSHUB_HEALTH_DISABLED,
      launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED,
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
      ...PLATFORM_APP_HEALTH_DISABLED,
      ...RSSHUB_HEALTH_DISABLED,
      launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED,
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
      ...PLATFORM_APP_HEALTH_DISABLED,
      ...RSSHUB_HEALTH_DISABLED,
      launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED,
      nowMs: Date.parse("2026-07-11T12:00:00.000Z"), // Saturday - keeps this isolated from the stale-heartbeat check
      dbPath
    });

    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "alerts-poller-health.consecutive_failures", severity: "error" })
    ]));
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
        ...RSSHUB_HEALTH_DISABLED,
        launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED,
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
        ...RSSHUB_HEALTH_DISABLED,
        launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED,
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
        ...RSSHUB_HEALTH_DISABLED,
        launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED,
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

  it("warns, but does not fail, when nothing is listening on the platform-app port", async () => {
    // Bind an ephemeral port and immediately release it, rather than
    // hardcoding a port number, so this can't collide with anything else
    // actually listening on this machine while the suite runs.
    const probe = createServer();
    const freedPort = await listenEphemeral(probe);
    await closeServer(probe);

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...RSSHUB_HEALTH_DISABLED,
      launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED,
      platformAppPort: freedPort,
      platformAppHealthTimeoutMs: 500
    });

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "platform-app-health.unreachable", severity: "warn" })
    ]));
    const message = report.findings.find((entry) => entry.code === "platform-app-health.unreachable")?.message;
    expect(message).toContain("pnpm platform:dev");
    expect(message).toContain("pnpm launchd:install-backup-alerts");
  });

  it("warns (resolves rather than rejects) when the injected fetch implementation itself throws synchronously", async () => {
    // Alternate injection point (task brief: "inject a fake fetch OR spin a
    // throwaway local server") - proves checkPlatformAppHealth's own
    // try/catch, not just runChecksFailureIsolated's outer net, absorbs a
    // thrower. If this DIDN'T resolve, `await` below would make the whole
    // test fail with an unhandled rejection.
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED,
      fetchImpl: () => {
        throw new Error("boom - injected network failure");
      }
    });

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "platform-app-health.unreachable", severity: "warn" })
    ]));
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
        ...PLATFORM_APP_HEALTH_DISABLED,
        launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED,
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
        ...PLATFORM_APP_HEALTH_DISABLED,
        launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED,
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
        ...PLATFORM_APP_HEALTH_DISABLED,
        launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED,
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
        ...PLATFORM_APP_HEALTH_DISABLED,
        launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED,
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
      ...PLATFORM_APP_HEALTH_DISABLED,
      launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED,
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
        ...PLATFORM_APP_HEALTH_DISABLED,
        launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED
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
      ...PLATFORM_APP_HEALTH_DISABLED,
      ...RSSHUB_HEALTH_DISABLED,
      launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED
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
      ...PLATFORM_APP_HEALTH_DISABLED,
      ...RSSHUB_HEALTH_DISABLED,
      launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED,
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
      ...PLATFORM_APP_HEALTH_DISABLED,
      ...RSSHUB_HEALTH_DISABLED,
      launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED,
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
      ...PLATFORM_APP_HEALTH_DISABLED,
      ...RSSHUB_HEALTH_DISABLED,
      launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED,
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

  it("treats an all-unknown-time news_events table (count > 0, MAX(last_published_at) NULL) as stale too", async () => {
    const dir = makeTempDir("alphaloop-doctor-news-db-");
    const dbPath = join(dir, "trading.sqlite");
    const db = openTradingDatabase(dbPath);
    seedEvent(db, null);
    db.close();

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      ...CONTROL_PERSONA_HEALTHY,
      ...HEALTHY_LISTENERS,
      ...PLATFORM_APP_HEALTH_DISABLED,
      ...RSSHUB_HEALTH_DISABLED,
      launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED,
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
      ...PLATFORM_APP_HEALTH_DISABLED,
      ...RSSHUB_HEALTH_DISABLED,
      launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED,
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
      ...PLATFORM_APP_HEALTH_DISABLED,
      ...RSSHUB_HEALTH_DISABLED,
      launchdJobLabels: [],
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
      ...PLATFORM_APP_HEALTH_DISABLED,
      ...RSSHUB_HEALTH_DISABLED,
      launchdJobLabels: ALL_LAUNCHD_JOBS_LOADED
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
