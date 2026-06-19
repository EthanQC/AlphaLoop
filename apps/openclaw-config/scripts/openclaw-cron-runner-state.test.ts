import { describe, expect, it } from "vitest";

const state = await import("./openclaw-cron-runner-state.mjs");

describe("OpenClaw cron runner state", () => {
  it("does not mark a failed OpenClaw marker as processed and schedules a retry", () => {
    const runnerState = state.normalizeRunnerState({
      processedRunKeys: []
    });

    const updated = state.recordRunResult(runnerState, "daily:run-1:finished", {
      ok: false,
      resultPath: "/tmp/daily-failure.json",
      error: "Longbridge unavailable"
    }, Date.parse("2026-06-19T12:00:00.000Z"), {
      retryBaseMs: 60_000,
      retryMaxMs: 300_000
    });

    expect(updated.processedRunKeys).not.toContain("daily:run-1:finished");
    expect(updated.failedRunAttempts["daily:run-1:finished"]).toMatchObject({
      attempts: 1,
      lastResultPath: "/tmp/daily-failure.json",
      nextRetryAt: "2026-06-19T12:01:00.000Z"
    });
    expect(state.shouldAttemptRun(updated, "daily:run-1:finished", Date.parse("2026-06-19T12:00:30.000Z"))).toBe(false);
    expect(state.shouldAttemptRun(updated, "daily:run-1:finished", Date.parse("2026-06-19T12:01:00.000Z"))).toBe(true);
  });

  it("marks a successful retry as processed and clears failure bookkeeping", () => {
    const runnerState = state.normalizeRunnerState({
      failedRunAttempts: {
        "stock:run-2:finished": {
          attempts: 2,
          lastAttemptAt: "2026-06-19T12:02:00.000Z",
          nextRetryAt: "2026-06-19T12:04:00.000Z",
          lastResultPath: "/tmp/stock-failure.json"
        }
      },
      alertedRunKeys: ["stock:run-2:finished"]
    });

    const updated = state.recordRunResult(runnerState, "stock:run-2:finished", {
      ok: true,
      resultPath: "/tmp/stock-success.json"
    }, Date.parse("2026-06-19T12:05:00.000Z"));

    expect(updated.processedRunKeys).toContain("stock:run-2:finished");
    expect(updated.failedRunAttempts["stock:run-2:finished"]).toBeUndefined();
    expect(updated.alertedRunKeys).not.toContain("stock:run-2:finished");
  });

  it("alerts once per failing run key until the run succeeds", () => {
    const runnerState = state.normalizeRunnerState({});
    expect(state.shouldAlertFailure(runnerState, "weekly:run-3:finished")).toBe(true);

    const alerted = state.recordFailureAlerted(runnerState, "weekly:run-3:finished");
    expect(state.shouldAlertFailure(alerted, "weekly:run-3:finished")).toBe(false);
  });
});
