import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openTradingDatabase } from "../../../packages/shared-types/dist/index.js";
import {
  consecutiveFailureCount,
  consecutiveStickyMarkerCount,
  consecutiveStickyMarkerCountSince,
  DELIVERY_LOOKBACK_GUARD_LIMIT,
  lastEscalationAt,
  lastMarkerAt,
  lastMarkerAtSince,
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

// Fix 1 (task H1 THIRD fix round, this task): the DELIVERY pair's scans must
// be bounded by TIME (started_at >= now - windowMs), not by row count - see
// module header for the full rationale (200 rows is barely 2.5 trading days
// at this poller's cadence, and real delivery-outage attempts are sparse
// enough to routinely span more rows than that while still being well
// within any reasonable "same outage" window).
describe("lastMarkerAtSince / consecutiveStickyMarkerCountSince (Fix 1, task H1 THIRD fix round)", () => {
  const NOW = new Date("2026-07-15T00:00:00.000Z");

  function isoMinutesBeforeNow(minutesBefore: number): string {
    return new Date(NOW.getTime() - minutesBefore * 60 * 1000).toISOString();
  }

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

  // THE regression test: three bad delivery attempts, each separated by ~100
  // healthy/empty rows (>200 rows apart end to end, exactly the row-LIMIT
  // trap the row-bounded consecutiveStickyMarkerCount falls into) - the
  // sticky count across all three must still be 3, proving the fix, not just
  // a smaller-scale unit of the same logic.
  it("counts three bad delivery attempts spanning MORE than 200 rows (RUN_LOG_LOOKBACK_LIMIT), all inside the 30-day window", () => {
    const { db } = makeDb();

    // Oldest -> newest: bad, 100 neutral, bad, 100 neutral, bad. 5-minute
    // ticks (this poller's own cadence), so the whole span is comfortably
    // inside the 30-day window while comfortably exceeding 200 rows.
    let minutesBefore = 210 * 5;
    recordAttempt(db, isoMinutesBeforeNow(minutesBefore), { bad: true });
    for (let i = 0; i < 100; i += 1) {
      minutesBefore -= 5;
      recordNeutral(db, isoMinutesBeforeNow(minutesBefore));
    }
    minutesBefore -= 5;
    recordAttempt(db, isoMinutesBeforeNow(minutesBefore), { bad: true });
    for (let i = 0; i < 100; i += 1) {
      minutesBefore -= 5;
      recordNeutral(db, isoMinutesBeforeNow(minutesBefore));
    }
    minutesBefore -= 5;
    recordAttempt(db, isoMinutesBeforeNow(minutesBefore), { bad: true });

    // 203 rows total - well past RUN_LOG_LOOKBACK_LIMIT (200). The
    // row-bounded consecutiveStickyMarkerCount can only see the newest 200 of
    // them, which excludes the very FIRST bad attempt entirely - proving the
    // bug this fix closes, not a strawman.
    expect(consecutiveStickyMarkerCount(db, "j", "delivery_health_bad", "delivery_attempted")).toBeLessThan(3);

    // The time-bounded twin sees all three - this is the assertion that
    // would have caught the round-3 regression.
    expect(
      consecutiveStickyMarkerCountSince(db, "j", "delivery_health_bad", "delivery_attempted", NOW)
    ).toBe(3);
  });

  it("does not see a bad attempt OLDER than the 30-day window, even though it would still see one inside it", () => {
    const { db } = makeDb();
    const thirtyOneDaysAgo = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const tenDaysAgo = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();

    recordAttempt(db, thirtyOneDaysAgo, { bad: true });
    recordAttempt(db, tenDaysAgo, { bad: true });

    // Only the in-window attempt counts - the streak stops at the window
    // boundary rather than reaching past it to the 31-day-old row.
    expect(
      consecutiveStickyMarkerCountSince(db, "j", "delivery_health_bad", "delivery_attempted", NOW)
    ).toBe(1);
  });

  it("lastMarkerAtSince finds a marker inside the window and returns null once it ages past it", () => {
    const { db } = makeDb();
    const insideWindow = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
    recordJobRun(db, {
      job: "j",
      startedAt: insideWindow,
      ok: true,
      evidence: [{ event: "delivery_escalation_sent", at: insideWindow }]
    });

    expect(lastMarkerAtSince(db, "j", "delivery_escalation_sent", NOW)).toBe(insideWindow);
    expect(
      lastMarkerAtSince(db, "j", "delivery_escalation_sent", NOW, 3 * 24 * 60 * 60 * 1000)
    ).toBeNull();
  });

  // Fix C (task H1 FOURTH fix round): the PREVIOUS default (5,000) was below
  // this module's own derived 30-day worst case (~8,640 rows, this poller's
  // 5-minute cadence ticking day and night on a calendar-coverage failure) -
  // a "guard" that could truncate the very window it claimed to never bite.
  // 50,000 is comfortably (~5.8x) above that worst case.
  it("DELIVERY_LOOKBACK_GUARD_LIMIT's default is comfortably above the derived 30-day worst case (Fix C)", () => {
    const worstCaseRowsPer30Days = 30 * 24 * ((60 * 60) / (5 * 60)); // 5-minute ticks, 24/7
    expect(DELIVERY_LOOKBACK_GUARD_LIMIT).toBeGreaterThanOrEqual(50_000);
    expect(DELIVERY_LOOKBACK_GUARD_LIMIT).toBeGreaterThan(worstCaseRowsPer30Days * 2);
  });

  it("respects an explicit guardLimit override (pure runaway guard, not a real bound)", () => {
    const { db } = makeDb();
    for (let i = 0; i < 5; i += 1) {
      recordAttempt(db, isoMinutesBeforeNow((5 - i) * 5), { bad: true });
    }
    expect(
      consecutiveStickyMarkerCountSince(db, "j", "delivery_health_bad", "delivery_attempted", NOW)
    ).toBe(5);
    expect(
      consecutiveStickyMarkerCountSince(
        db,
        "j",
        "delivery_health_bad",
        "delivery_attempted",
        NOW,
        undefined,
        3
      )
    ).toBe(3);
  });
});
