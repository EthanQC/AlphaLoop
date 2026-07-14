import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openTradingDatabase } from "../../../packages/shared-types/dist/index.js";
import { recordJobRun } from "./job-run-log.mjs";

const doctor = await import("./openclaw-runtime-doctor-core.mjs");

// Shared "everything else is healthy" listener stub so the new task H2
// checks below (launchd-jobs / alerts-poller-health) can be asserted on in
// isolation, without the pre-existing gateway/runner checks also firing.
const HEALTHY_LISTENERS = {
  gatewayListeners: [{ pid: 100, command: "node", endpoint: "127.0.0.1:18789" }],
  cronRunnerListeners: [{ pid: 200, command: "node", endpoint: "127.0.0.1:18792" }]
};

const BOTH_JOBS_LOADED = ["com.alphaloop.daily-backup", "com.alphaloop.market-alerts"];

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
  it("flags gateway restart storms and failed runner results", () => {
    const report = doctor.analyzeOpenClawRuntimeSnapshot({
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

  it("accepts the desired steady state", () => {
    const report = doctor.analyzeOpenClawRuntimeSnapshot({
      gatewayListeners: [{ pid: 100, command: "node", endpoint: "127.0.0.1:18789" }],
      gatewayErrorLines: [],
      cronRunnerListeners: [{ pid: 200, command: "node", endpoint: "127.0.0.1:18792" }],
      recentRunnerResults: [{ job: "daily", ok: true, file: "daily.json" }]
    });

    expect(report.ok).toBe(true);
    expect(report.findings.every((finding) => finding.severity !== "error")).toBe(true);
  });

  it("does not keep failing a job after a newer successful runner result", () => {
    const report = doctor.analyzeOpenClawRuntimeSnapshot({
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

  it("ignores stale gateway restart errors outside the recent window", () => {
    const report = doctor.analyzeOpenClawRuntimeSnapshot({
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

describe("launchd-jobs check (task H2)", () => {
  it("warns, but does not fail, when neither required job is loaded", () => {
    const report = doctor.analyzeOpenClawRuntimeSnapshot({
      ...HEALTHY_LISTENERS,
      launchdJobLabels: []
    });

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "launchd-jobs.daily-backup.not_loaded", severity: "warn" }),
      expect.objectContaining({ code: "launchd-jobs.market-alerts.not_loaded", severity: "warn" })
    ]));
  });

  it("reports nothing for launchd-jobs once both are loaded", () => {
    const report = doctor.analyzeOpenClawRuntimeSnapshot({
      ...HEALTHY_LISTENERS,
      launchdJobLabels: [...BOTH_JOBS_LOADED, "com.openclaw.gateway"]
    });

    expect(report.ok).toBe(true);
    expect(report.findings.some((finding) => finding.code.startsWith("launchd-jobs."))).toBe(false);
  });
});

describe("alerts-poller-health check (task H2)", () => {
  it("fails when runtime/market-alerts/ALERTER-DOWN.json exists, even with no dbPath supplied at all", () => {
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

    const report = doctor.analyzeOpenClawRuntimeSnapshot({
      ...HEALTHY_LISTENERS,
      launchdJobLabels: BOTH_JOBS_LOADED,
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

  it("fails gracefully (never throws) when the trading db cannot even be opened", () => {
    const dir = makeTempDir("alphaloop-doctor-db-");
    const dbPath = join(dir, "trading.sqlite");
    writeFileSync(dbPath, "not a real sqlite file, just garbage bytes");

    let report: ReturnType<typeof doctor.analyzeOpenClawRuntimeSnapshot> | undefined;
    expect(() => {
      report = doctor.analyzeOpenClawRuntimeSnapshot({
        ...HEALTHY_LISTENERS,
        launchdJobLabels: BOTH_JOBS_LOADED,
        dbPath
      });
    }).not.toThrow();

    expect(report?.ok).toBe(false);
    expect(report?.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "alerts-poller-health.db_unreachable", severity: "error" })
    ]));
  });

  it("warns that the poller has never run when run_log has zero market-alerts rows", () => {
    const dir = makeTempDir("alphaloop-doctor-db-");
    const dbPath = join(dir, "trading.sqlite");
    // Opens (creating the schema via migrate()) and closes immediately -
    // analyzeOpenClawRuntimeSnapshot re-opens it itself from dbPath, exactly
    // like a fresh install that has never run the poller.
    openTradingDatabase(dbPath).close();

    const report = doctor.analyzeOpenClawRuntimeSnapshot({
      ...HEALTHY_LISTENERS,
      launchdJobLabels: BOTH_JOBS_LOADED,
      nowMs: Date.parse("2026-07-11T12:00:00.000Z"), // Saturday - outside market hours
      dbPath
    });

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "alerts-poller-health.never_ran", severity: "warn" })
    ]));
  });

  it("warns when the last market-alerts run is stale during US regular market hours", () => {
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

    const report = doctor.analyzeOpenClawRuntimeSnapshot({
      ...HEALTHY_LISTENERS,
      launchdJobLabels: BOTH_JOBS_LOADED,
      nowMs: Date.parse("2026-07-13T15:00:00.000Z"), // Monday 11:00am US Eastern (EDT) - regular market hours
      dbPath
    });

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "alerts-poller-health.stale_heartbeat", severity: "warn" })
    ]));
  });

  it("does not warn about a stale heartbeat outside US regular market hours", () => {
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

    const report = doctor.analyzeOpenClawRuntimeSnapshot({
      ...HEALTHY_LISTENERS,
      launchdJobLabels: BOTH_JOBS_LOADED,
      nowMs: Date.parse("2026-07-11T12:00:00.000Z"), // Saturday - the multi-day gap is expected off-hours
      dbPath
    });

    expect(report.findings.some((entry) => entry.code === "alerts-poller-health.stale_heartbeat")).toBe(false);
  });

  it("still fails via alerter_down, with a degraded message, when ALERTER-DOWN.json exists but cannot be parsed", () => {
    const runtimeRoot = makeTempDir("alphaloop-doctor-runtime-");
    mkdirSync(join(runtimeRoot, "market-alerts"), { recursive: true });
    writeFileSync(join(runtimeRoot, "market-alerts", "ALERTER-DOWN.json"), "{ this is not valid json ");

    const report = doctor.analyzeOpenClawRuntimeSnapshot({
      ...HEALTHY_LISTENERS,
      launchdJobLabels: BOTH_JOBS_LOADED,
      runtimeRoot
    });

    expect(report.ok).toBe(false);
    const finding = report.findings.find((entry) => entry.code === "alerts-poller-health.alerter_down");
    expect(finding).toBeTruthy();
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("ALERTER-DOWN.json 存在但内容无法解析");
  });

  it("reports both alerter_down and db_unreachable together when the artifact exists AND the trading db cannot be opened", () => {
    const runtimeRoot = makeTempDir("alphaloop-doctor-runtime-");
    mkdirSync(join(runtimeRoot, "market-alerts"), { recursive: true });
    writeFileSync(
      join(runtimeRoot, "market-alerts", "ALERTER-DOWN.json"),
      JSON.stringify({ since: "2026-07-10T00:00:00.000Z", reason: "send_failed", consecutiveFailures: 5 })
    );

    const dir = makeTempDir("alphaloop-doctor-db-");
    const dbPath = join(dir, "trading.sqlite");
    writeFileSync(dbPath, "not a real sqlite file, just garbage bytes");

    let report: ReturnType<typeof doctor.analyzeOpenClawRuntimeSnapshot> | undefined;
    expect(() => {
      report = doctor.analyzeOpenClawRuntimeSnapshot({
        ...HEALTHY_LISTENERS,
        launchdJobLabels: BOTH_JOBS_LOADED,
        runtimeRoot,
        dbPath
      });
    }).not.toThrow();

    expect(report?.ok).toBe(false);
    expect(report?.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "alerts-poller-health.alerter_down", severity: "error" }),
      expect.objectContaining({ code: "alerts-poller-health.db_unreachable", severity: "error" })
    ]));
  });

  it("does not crash and still reports the staleness itself when the trading calendar has no data for the current year", () => {
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

    let report: ReturnType<typeof doctor.analyzeOpenClawRuntimeSnapshot> | undefined;
    expect(() => {
      report = doctor.analyzeOpenClawRuntimeSnapshot({
        ...HEALTHY_LISTENERS,
        launchdJobLabels: BOTH_JOBS_LOADED,
        nowMs: Date.parse("2027-01-01T15:00:00.000Z"), // >30min after last run; year 2027 uncovered
        dbPath
      });
    }).not.toThrow();

    expect(report?.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "alerts-poller-health.calendar_uncovered", severity: "warn" }),
      expect.objectContaining({ code: "alerts-poller-health.stale_heartbeat_unknown_market_hours", severity: "warn" })
    ]));
    // A calendar-coverage gap is a "we don't know", not a proven hard
    // failure - it must not by itself flip `ok` to false.
    expect(report?.findings.some((entry) => entry.severity === "error")).toBe(false);
  });

  it("fails when market-alerts has 3+ consecutive failed runs", () => {
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

    const report = doctor.analyzeOpenClawRuntimeSnapshot({
      ...HEALTHY_LISTENERS,
      launchdJobLabels: BOTH_JOBS_LOADED,
      nowMs: Date.parse("2026-07-11T12:00:00.000Z"), // Saturday - keeps this isolated from the stale-heartbeat check
      dbPath
    });

    expect(report.ok).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "alerts-poller-health.consecutive_failures", severity: "error" })
    ]));
  });
});

// task H2 fix round (this task, CRITICAL finding): the doctor is this
// system's only external observer - if any ONE check throws, the whole
// process used to die with it, printing NOTHING (not even findings other
// checks had already computed). Every check must now be failure-isolated.
describe("failure isolation across checks (task H2 fix round)", () => {
  it("keeps every other check's findings intact, plus one error finding for the thrower, when a single check throws", () => {
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

    const report = doctor.analyzeOpenClawRuntimeSnapshot({
      ...HEALTHY_LISTENERS,
      launchdJobLabels: [],
      recentRunnerResults: [throwingRunnerResult]
    });

    // The thrower gets its own scoped error finding...
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", code: "doctor.check_failed.runner-recent-failures" })
    ]));

    // ...and every OTHER check still ran and reported normally: gateway/
    // runner listeners are healthy (no findings for them), and launchd-jobs
    // still produced its usual two warns exactly as it would with no
    // thrower in the picture at all.
    expect(report.findings.some((entry) => entry.code === "gateway.not_listening")).toBe(false);
    expect(report.findings.some((entry) => entry.code === "runner.not_listening")).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "launchd-jobs.daily-backup.not_loaded", severity: "warn" }),
      expect.objectContaining({ code: "launchd-jobs.market-alerts.not_loaded", severity: "warn" })
    ]));
  });
});
