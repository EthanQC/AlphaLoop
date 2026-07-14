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
