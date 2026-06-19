import { describe, expect, it } from "vitest";

const doctor = await import("./openclaw-runtime-doctor-core.mjs");

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
