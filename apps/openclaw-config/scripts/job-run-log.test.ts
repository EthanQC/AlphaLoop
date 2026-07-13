import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openTradingDatabase } from "../../../packages/shared-types/dist/index.js";
import {
  consecutiveFailureCount,
  lastEscalationAt,
  lastRecoveryAt,
  recentFailures,
  recordJobRun
} from "./job-run-log.mjs";

const tempDirs: string[] = [];

function makeDb(): { db: DatabaseSync } {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-job-run-log-"));
  tempDirs.push(dir);
  const db = openTradingDatabase(join(dir, "trading.sqlite"));
  return { db };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("recordJobRun / recentFailures", () => {
  it("round-trips a failed run through recentFailures with every field intact", () => {
    const { db } = makeDb();

    recordJobRun(db, {
      job: "market-alerts",
      startedAt: "2026-07-01T00:00:00.000Z",
      finishedAt: "2026-07-01T00:00:01.000Z",
      ok: false,
      inputs: [{ note: "cycle" }],
      actions: ["poll"],
      failedStep: "fetch_quotes",
      retries: 2,
      callCount: 3,
      evidence: [{ event: "escalation_sent", at: "2026-07-01T00:00:01.000Z" }]
    });

    const failures = recentFailures(db, "market-alerts", 10);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      job: "market-alerts",
      startedAt: "2026-07-01T00:00:00.000Z",
      finishedAt: "2026-07-01T00:00:01.000Z",
      ok: false,
      failedStep: "fetch_quotes",
      retries: 2,
      callCount: 3
    });
    expect(failures[0]?.inputs).toEqual([{ note: "cycle" }]);
    expect(failures[0]?.actions).toEqual(["poll"]);
    expect(failures[0]?.evidence).toEqual([{ event: "escalation_sent", at: "2026-07-01T00:00:01.000Z" }]);
    expect(typeof failures[0]?.id).toBe("string");
  });

  it("round-trips a successful run's defaults (no finishedAt/failedStep/evidence given)", () => {
    const { db } = makeDb();

    recordJobRun(db, { job: "market-alerts", startedAt: "2026-07-01T00:00:00.000Z", ok: true });

    const row = db.prepare("SELECT * FROM run_log WHERE job = ?").get("market-alerts") as Record<string, unknown>;
    expect(row.ok).toBe(1);
    expect(row.finished_at).toBeNull();
    expect(row.failed_step).toBeNull();
    expect(row.inputs).toBe("[]");
    expect(row.actions).toBe("[]");
    expect(row.evidence).toBe("[]");
  });

  it("recentFailures excludes ok runs and returns newest-first, respecting limit", () => {
    const { db } = makeDb();
    recordJobRun(db, { job: "j", startedAt: "t1", ok: false, failedStep: "a" });
    recordJobRun(db, { job: "j", startedAt: "t2", ok: true });
    recordJobRun(db, { job: "j", startedAt: "t3", ok: false, failedStep: "b" });

    const failures = recentFailures(db, "j", 1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.failedStep).toBe("b");

    const both = recentFailures(db, "j", 10);
    expect(both.map((f) => f.failedStep)).toEqual(["b", "a"]);
  });
});

describe("consecutiveFailureCount", () => {
  it("is 0 for a job with no run_log rows at all", () => {
    const { db } = makeDb();
    expect(consecutiveFailureCount(db, "nonexistent")).toBe(0);
  });

  it("counts back from the latest run and resets to 0 immediately after a success", () => {
    const { db } = makeDb();
    recordJobRun(db, { job: "j", startedAt: "t1", ok: false });
    recordJobRun(db, { job: "j", startedAt: "t2", ok: false });
    recordJobRun(db, { job: "j", startedAt: "t3", ok: false });
    expect(consecutiveFailureCount(db, "j")).toBe(3);

    recordJobRun(db, { job: "j", startedAt: "t4", ok: true });
    expect(consecutiveFailureCount(db, "j")).toBe(0);

    recordJobRun(db, { job: "j", startedAt: "t5", ok: false });
    expect(consecutiveFailureCount(db, "j")).toBe(1);
  });

  it("only counts the given job's own runs, not another job's failures", () => {
    const { db } = makeDb();
    recordJobRun(db, { job: "other-job", startedAt: "t1", ok: false });
    recordJobRun(db, { job: "other-job", startedAt: "t2", ok: false });
    recordJobRun(db, { job: "market-alerts", startedAt: "t1", ok: false });

    expect(consecutiveFailureCount(db, "market-alerts")).toBe(1);
    expect(consecutiveFailureCount(db, "other-job")).toBe(2);
  });
});

describe("lastEscalationAt / lastRecoveryAt", () => {
  it("is null when no escalation or recovery marker has ever been recorded", () => {
    const { db } = makeDb();
    recordJobRun(db, { job: "j", startedAt: "t1", ok: false });
    expect(lastEscalationAt(db, "j")).toBeNull();
    expect(lastRecoveryAt(db, "j")).toBeNull();
  });

  it("returns the escalation marker's own `at` timestamp from whichever row carries it", () => {
    const { db } = makeDb();
    recordJobRun(db, {
      job: "j",
      startedAt: "t1",
      ok: false,
      evidence: [{ event: "escalation_sent", at: "2026-07-01T00:00:00.000Z" }]
    });
    expect(lastEscalationAt(db, "j")).toBe("2026-07-01T00:00:00.000Z");
  });

  it("returns the MOST RECENT escalation marker when several rows carry one", () => {
    const { db } = makeDb();
    recordJobRun(db, {
      job: "j",
      startedAt: "t1",
      ok: false,
      evidence: [{ event: "escalation_sent", at: "2026-07-01T00:00:00.000Z" }]
    });
    recordJobRun(db, { job: "j", startedAt: "t2", ok: false });
    recordJobRun(db, {
      job: "j",
      startedAt: "t3",
      ok: false,
      evidence: [{ event: "escalation_sent", at: "2026-07-02T12:00:00.000Z" }]
    });
    expect(lastEscalationAt(db, "j")).toBe("2026-07-02T12:00:00.000Z");
  });

  it("lastRecoveryAt mirrors the same encoding for recovery_sent markers on a later successful row", () => {
    const { db } = makeDb();
    recordJobRun(db, {
      job: "j",
      startedAt: "t1",
      ok: false,
      evidence: [{ event: "escalation_sent", at: "2026-07-01T00:00:00.000Z" }]
    });
    recordJobRun(db, {
      job: "j",
      startedAt: "t2",
      ok: true,
      evidence: [{ event: "recovery_sent", at: "2026-07-01T01:00:00.000Z" }]
    });
    expect(lastEscalationAt(db, "j")).toBe("2026-07-01T00:00:00.000Z");
    expect(lastRecoveryAt(db, "j")).toBe("2026-07-01T01:00:00.000Z");
  });
});
