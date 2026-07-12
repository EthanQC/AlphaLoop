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

describe("classifyFailure", () => {
  it("builds a class key from jobName plus a normalized first line of the error", () => {
    expect(state.classifyFailure("daily", "Longbridge unavailable")).toBe("daily:longbridge unavailable");
  });

  it("collapses whitespace, lowercases, and only looks at the first line", () => {
    const multiline = "  Longbridge   UNAVAILABLE  \nstack trace line 2\nstack trace line 3";
    expect(state.classifyFailure("daily", multiline)).toBe("daily:longbridge unavailable");
  });

  it("truncates the normalized error to 80 characters", () => {
    const longError = "x".repeat(200);
    const classified = state.classifyFailure("daily", longError);
    expect(classified).toBe(`daily:${"x".repeat(80)}`);
  });

  it("treats different first lines as different classes", () => {
    expect(state.classifyFailure("daily", "Longbridge unavailable")).not.toBe(
      state.classifyFailure("daily", "Timeout waiting for quote feed")
    );
  });
});

describe("halt-after-3-same-class-failures state machine", () => {
  const baseNowMs = Date.parse("2026-07-01T00:00:00.000Z");

  it("halts a job after 3 consecutive same-class failures and blocks further attempts", () => {
    let runnerState = state.normalizeRunnerState({});
    for (let i = 0; i < 3; i += 1) {
      runnerState = state.recordRunResult(
        runnerState,
        `daily:run-${i}:finished`,
        { ok: false, job: "daily", error: "Longbridge unavailable" },
        baseNowMs + i * 60_000
      );
    }

    expect(runnerState.jobFailureState.daily).toMatchObject({
      failureClass: "daily:longbridge unavailable",
      consecutiveCount: 3,
      halted: true
    });

    // Far in the future so any backoff window has long since elapsed; only the halt should gate.
    const farFuture = baseNowMs + 365 * 24 * 60 * 60_000;
    expect(state.shouldAttemptRun(runnerState, "daily:run-99:finished", farFuture, { jobName: "daily" })).toBe(false);
    // Without the jobName hint, the halt cannot be checked, so this returns true (no crash, degrades safely).
    expect(state.shouldAttemptRun(runnerState, "daily:run-99:finished", farFuture)).toBe(true);
  });

  it("does not accumulate different failure classes into each other's counts", () => {
    let runnerState = state.normalizeRunnerState({});
    runnerState = state.recordRunResult(runnerState, "daily:run-0:finished", { ok: false, job: "daily", error: "Longbridge unavailable" }, baseNowMs);
    runnerState = state.recordRunResult(runnerState, "daily:run-1:finished", { ok: false, job: "daily", error: "Longbridge unavailable" }, baseNowMs + 60_000);
    expect(runnerState.jobFailureState.daily).toMatchObject({ consecutiveCount: 2, halted: false });

    runnerState = state.recordRunResult(runnerState, "daily:run-2:finished", { ok: false, job: "daily", error: "Timeout waiting for quote feed" }, baseNowMs + 120_000);

    expect(runnerState.jobFailureState.daily).toMatchObject({
      failureClass: "daily:timeout waiting for quote feed",
      consecutiveCount: 1,
      halted: false
    });
  });

  it("clears the count and halted flag on a success", () => {
    let runnerState = state.normalizeRunnerState({});
    for (let i = 0; i < 3; i += 1) {
      runnerState = state.recordRunResult(
        runnerState,
        `daily:run-${i}:finished`,
        { ok: false, job: "daily", error: "Longbridge unavailable" },
        baseNowMs + i * 60_000
      );
    }
    expect(runnerState.jobFailureState.daily.halted).toBe(true);

    runnerState = state.recordRunResult(runnerState, "daily:run-3:finished", { ok: true, job: "daily" }, baseNowMs + 180_000);

    expect(runnerState.jobFailureState.daily).toMatchObject({
      consecutiveCount: 0,
      halted: false
    });

    // A subsequent failure of the same class starts a fresh count instead of continuing from before.
    runnerState = state.recordRunResult(runnerState, "daily:run-4:finished", { ok: false, job: "daily", error: "Longbridge unavailable" }, baseNowMs + 240_000);
    expect(runnerState.jobFailureState.daily).toMatchObject({ consecutiveCount: 1, halted: false });
  });

  it("resetJobFailureState restores a halted job to count 0 / not halted", () => {
    let runnerState = state.normalizeRunnerState({});
    for (let i = 0; i < 3; i += 1) {
      runnerState = state.recordRunResult(
        runnerState,
        `daily:run-${i}:finished`,
        { ok: false, job: "daily", error: "Longbridge unavailable" },
        baseNowMs + i * 60_000
      );
    }
    expect(runnerState.jobFailureState.daily.halted).toBe(true);

    const restored = state.resetJobFailureState(runnerState, "daily");
    expect(restored.jobFailureState.daily).toMatchObject({ consecutiveCount: 0, halted: false });
    expect(state.shouldAttemptRun(restored, "daily:run-99:finished", baseNowMs + 999_000, { jobName: "daily" })).toBe(true);
  });

  it("reads a pre-existing state file without the new fields without crashing, treating it as count 0", () => {
    const legacyState = {
      processedRunKeys: ["a:b:finished"],
      failedRunAttempts: {},
      alertedRunKeys: []
    };

    const normalized = state.normalizeRunnerState(legacyState);
    expect(normalized.jobFailureState).toEqual({});
    expect(state.shouldAttemptRun(normalized, "daily:run-1:finished", baseNowMs, { jobName: "daily" })).toBe(true);
  });
});

describe("escalation alert retry (escalationPending)", () => {
  const baseNowMs = Date.parse("2026-07-01T00:00:00.000Z");

  function haltedDailyState() {
    let runnerState = state.normalizeRunnerState({});
    for (let i = 0; i < 3; i += 1) {
      runnerState = state.recordRunResult(
        runnerState,
        `daily:run-${i}:finished`,
        { ok: false, job: "daily", error: "Longbridge unavailable", resultPath: `/tmp/daily-${i}.json` },
        baseNowMs + i * 60_000
      );
    }
    return runnerState;
  }

  it("marks escalationPending true the moment a job transitions into halted, recording the halting failure's resultPath", () => {
    const runnerState = haltedDailyState();
    expect(runnerState.jobFailureState.daily).toMatchObject({
      halted: true,
      escalationPending: true,
      lastResultPath: "/tmp/daily-2.json"
    });
  });

  it("does not re-mark escalationPending on failures after the halting one (already surfaced via getPendingEscalationJobs)", () => {
    let runnerState = haltedDailyState();
    // Clear it as if the escalation alert already succeeded once.
    runnerState = state.clearEscalationPending(runnerState, "daily");
    expect(runnerState.jobFailureState.daily.escalationPending).toBe(false);

    // A further same-class failure while already halted (defensive case; shouldAttemptRun would
    // normally prevent the runner itself from reaching this) must not flip it back to true.
    runnerState = state.recordRunResult(
      runnerState,
      "daily:run-3:finished",
      { ok: false, job: "daily", error: "Longbridge unavailable", resultPath: "/tmp/daily-3.json" },
      baseNowMs + 180_000
    );
    expect(runnerState.jobFailureState.daily).toMatchObject({ halted: true, escalationPending: false });
  });

  it("getPendingEscalationJobs surfaces only halted jobs with a pending escalation", () => {
    const runnerState = haltedDailyState();
    expect(state.getPendingEscalationJobs(runnerState)).toEqual([
      { jobName: "daily", jobFailure: runnerState.jobFailureState.daily }
    ]);

    const cleared = state.clearEscalationPending(runnerState, "daily");
    expect(state.getPendingEscalationJobs(cleared)).toEqual([]);
  });

  it("clearEscalationPending is a no-op for a job with no failure history", () => {
    const runnerState = state.normalizeRunnerState({});
    expect(state.clearEscalationPending(runnerState, "weekly").jobFailureState.weekly).toBeUndefined();
  });

  it("a success clears escalationPending along with the rest of the job failure state", () => {
    let runnerState = haltedDailyState();
    runnerState = state.recordRunResult(runnerState, "daily:run-3:finished", { ok: true, job: "daily" }, baseNowMs + 180_000);
    expect(runnerState.jobFailureState.daily).toMatchObject({ consecutiveCount: 0, halted: false, escalationPending: false });
  });

  it("resetJobFailureState (the reset CLI's write) clears escalationPending too", () => {
    const runnerState = haltedDailyState();
    const restored = state.resetJobFailureState(runnerState, "daily");
    expect(restored.jobFailureState.daily).toMatchObject({ halted: false, escalationPending: false });
    expect(state.getPendingEscalationJobs(restored)).toEqual([]);
  });

  it("treats a state file written before this flag existed as escalationPending: false (backward compatible)", () => {
    const legacyHaltedState = {
      jobFailureState: {
        daily: { failureClass: "daily:longbridge unavailable", consecutiveCount: 3, halted: true }
      }
    };
    const normalized = state.normalizeRunnerState(legacyHaltedState);
    expect(normalized.jobFailureState.daily).toMatchObject({ halted: true, escalationPending: false });
    expect(state.getPendingEscalationJobs(normalized)).toEqual([]);
  });
});

describe("failure alert level (1st + 3rd only)", () => {
  const baseNowMs = Date.parse("2026-07-01T00:00:00.000Z");

  it("reports notice on the 1st same-class failure, none on the 2nd, and escalation on the 3rd", () => {
    let runnerState = state.normalizeRunnerState({});

    runnerState = state.recordRunResult(runnerState, "daily:run-0:finished", { ok: false, job: "daily", error: "Longbridge unavailable" }, baseNowMs);
    expect(state.getFailureAlertLevel(runnerState, "daily")).toBe("notice");

    runnerState = state.recordRunResult(runnerState, "daily:run-1:finished", { ok: false, job: "daily", error: "Longbridge unavailable" }, baseNowMs + 60_000);
    expect(state.getFailureAlertLevel(runnerState, "daily")).toBe("none");

    runnerState = state.recordRunResult(runnerState, "daily:run-2:finished", { ok: false, job: "daily", error: "Longbridge unavailable" }, baseNowMs + 120_000);
    expect(state.getFailureAlertLevel(runnerState, "daily")).toBe("escalation");
  });

  it("does not re-alert past the halting failure", () => {
    let runnerState = state.normalizeRunnerState({});
    for (let i = 0; i < 3; i += 1) {
      runnerState = state.recordRunResult(
        runnerState,
        `daily:run-${i}:finished`,
        { ok: false, job: "daily", error: "Longbridge unavailable" },
        baseNowMs + i * 60_000
      );
    }
    // Simulate a 4th recorded failure directly (the real runner would never reach this because
    // shouldAttemptRun blocks further attempts once halted) to confirm no further alert is reported.
    runnerState = state.recordRunResult(runnerState, "daily:run-3:finished", { ok: false, job: "daily", error: "Longbridge unavailable" }, baseNowMs + 180_000);
    expect(state.getFailureAlertLevel(runnerState, "daily")).toBe("none");
  });
});
