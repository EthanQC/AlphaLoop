import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openTradingDatabase } from "../../../packages/shared-types/dist/index.js";
import {
  consecutiveFailureCount,
  consecutiveStickyMarkerCount,
  lastEscalationAt,
  lastMarkerAt,
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

// Fix 5 (task H1 second fix round): every run_log scan keyed on a job must
// stay flat-cost as the table grows, not re-scan the entire history every
// cycle forever. `limit` is exposed as an explicit override (rather than only
// a baked-in default) precisely so this can be tested without inserting
// hundreds of rows per case.
describe("bounded LIMIT lookback (Fix 5, task H1 second fix round)", () => {
  it("consecutiveFailureCount stops counting past the given limit even if more failures precede it", () => {
    const { db } = makeDb();
    for (let i = 0; i < 5; i += 1) {
      recordJobRun(db, { job: "j", startedAt: `t${i}`, ok: false });
    }
    expect(consecutiveFailureCount(db, "j")).toBe(5);
    expect(consecutiveFailureCount(db, "j", 3)).toBe(3);
  });

  it("lastMarkerAt does not see a marker older than the given limit's row window", () => {
    const { db } = makeDb();
    recordJobRun(db, {
      job: "j",
      startedAt: "t0",
      ok: false,
      evidence: [{ event: "escalation_sent", at: "2026-07-01T00:00:00.000Z" }]
    });
    for (let i = 1; i <= 4; i += 1) {
      recordJobRun(db, { job: "j", startedAt: `t${i}`, ok: false });
    }
    // 5 rows total; the marker is on the OLDEST one.
    expect(lastMarkerAt(db, "j", "escalation_sent")).toBe("2026-07-01T00:00:00.000Z");
    expect(lastMarkerAt(db, "j", "escalation_sent", 3)).toBeNull();
  });
});

// Fix 1 (task H1 second fix round): the delivery-health detector's original
// consecutiveMarkerCount-based streak broke on the very first row lacking the
// `delivery_health_bad` marker - including a `fires === 0` row, which carries
// no marker at all (it never attempted delivery). Real alert fires are
// sparse (once_daily rules, a daily quota), so a persistently broken
// transport produces exactly this "bad, empty, bad, empty, bad, ..." pattern
// forever and the plain streak-based count never reaches the escalation
// threshold. consecutiveStickyMarkerCount fixes this: rows carrying neither
// `markerEvent` nor `attemptEvent` (neutral - no delivery attempted at all)
// are skipped entirely (neither counted nor breaking the streak); the streak
// only resets on a row that DID attempt delivery (`attemptEvent`) but was
// healthy (lacks `markerEvent`).
describe("consecutiveStickyMarkerCount (Fix 1, task H1 second fix round)", () => {
  function recordAttempt(db: DatabaseSync, startedAt: string, { bad }: { bad: boolean }): void {
    const evidence: Array<Record<string, unknown>> = [{ event: "delivery_attempted", at: startedAt }];
    if (bad) {
      evidence.push({ event: "delivery_health_bad", at: startedAt });
    }
    recordJobRun(db, { job: "j", startedAt, ok: true, evidence });
  }

  function recordNeutral(db: DatabaseSync, startedAt: string): void {
    recordJobRun(db, { job: "j", startedAt, ok: true, evidence: [] });
  }

  it("is 0 when no row has ever attempted delivery", () => {
    const { db } = makeDb();
    recordNeutral(db, "t1");
    expect(consecutiveStickyMarkerCount(db, "j", "delivery_health_bad", "delivery_attempted")).toBe(0);
  });

  it("counts consecutive bad ATTEMPTS, skipping neutral (no-attempt) rows entirely - the sparse-fire regression case", () => {
    const { db } = makeDb();
    // Oldest -> newest: bad, neutral, bad, neutral, bad (a broken transport
    // with sparse real fires - exactly the production failure mode this task
    // exists to catch).
    recordAttempt(db, "t1", { bad: true });
    recordNeutral(db, "t2");
    recordAttempt(db, "t3", { bad: true });
    recordNeutral(db, "t4");
    recordAttempt(db, "t5", { bad: true });

    // A plain break-on-first-miss streak (the pre-fix consecutiveMarkerCount)
    // would see only 1 here (t4 lacks the marker). Sticky counting must see
    // all 3 real bad attempts.
    expect(consecutiveStickyMarkerCount(db, "j", "delivery_health_bad", "delivery_attempted")).toBe(3);
  });

  it("a HEALTHY attempt (attempted but not bad) ends the streak - neutral rows never do", () => {
    const { db } = makeDb();
    recordAttempt(db, "t1", { bad: true });
    recordAttempt(db, "t2", { bad: false }); // a real successful delivery
    recordAttempt(db, "t3", { bad: true });
    recordAttempt(db, "t4", { bad: true });

    // Counting back from newest (t4): t4 bad, t3 bad, t2 healthy -> stop.
    expect(consecutiveStickyMarkerCount(db, "j", "delivery_health_bad", "delivery_attempted")).toBe(2);
  });

  it("respects an explicit limit override", () => {
    const { db } = makeDb();
    for (let i = 0; i < 5; i += 1) {
      recordAttempt(db, `t${i}`, { bad: true });
    }
    expect(consecutiveStickyMarkerCount(db, "j", "delivery_health_bad", "delivery_attempted")).toBe(5);
    expect(consecutiveStickyMarkerCount(db, "j", "delivery_health_bad", "delivery_attempted", 3)).toBe(3);
  });
});
