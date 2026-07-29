import { describe, expect, it } from "vitest";

import { buildManagedOpenClawCronJobs } from "./openclaw-cron-jobs.mjs";

describe("managed OpenClaw cron jobs", () => {
  it("registers OpenClaw-owned report and analysis jobs with repository quality commands", () => {
    const jobs = buildManagedOpenClawCronJobs("/repo");

    expect(jobs.map((job) => job.name)).toEqual([
      "openclaw-trading-daily-report",
      "openclaw-trading-weekly-report",
      "openclaw-trading-stock-analysis",
      "openclaw-trading-proposal-sweep",
      "openclaw-trading-monthly-review"
    ]);
    expect(jobs).toEqual([
      expect.objectContaining({
        cron: "0 20 * * 2-6",
        timezone: "Asia/Shanghai",
        systemEvent: expect.stringContaining("pnpm report:daily:run")
      }),
      expect.objectContaining({
        cron: "0 20 * * 1",
        timezone: "Asia/Shanghai",
        systemEvent: expect.stringContaining("pnpm report:weekly:run")
      }),
      expect.objectContaining({
        cron: "0 21 * * *",
        timezone: "Asia/Shanghai",
        systemEvent: expect.stringContaining("pnpm stock-analysis:scheduled")
      }),
      expect.objectContaining({
        cron: "0 * * * *",
        timezone: "Asia/Shanghai",
        systemEvent: expect.stringContaining("pnpm proposals:sweep")
      }),
      expect.objectContaining({
        cron: "0 10 * * 6,0",
        timezone: "Asia/Shanghai",
        systemEvent: expect.stringContaining("pnpm reviews:generate")
      })
    ]);
    for (const job of jobs) {
      expect(job.systemEvent).toContain("cd /repo");
      expect(job.systemEvent).toContain("schedule marker");
      expect(job).not.toHaveProperty("webhook");
      expect(job.systemEvent).toContain("runner watches this run log");
      expect(job.agent).toBe("control");
      expect(job.session).toBe("main");
      expect(job.wake).toBe("next-heartbeat");
    }
    // The three original report/analysis jobs each run a report-quality
    // validation pipeline (their "quality" label is literal); the Task 3
    // proposal-expiry sweep and the Phase 9 monthly-review generation are
    // plain atomic sweeps, not quality pipelines, so both are intentionally
    // excluded from this specific check.
    for (const job of jobs.slice(0, 3)) {
      expect(job.systemEvent).toContain("quality");
    }
    expect(jobs[3]?.systemEvent).toContain("proposal-expiry sweep");
    expect(jobs[4]?.systemEvent).toContain("monthly per-owner review draft generation");
  });

  // Task 21 (2026-07-28 spec-drift plan). The monthly review carried
  // `0 10 1-7 * 6,0` with a comment calling day-of-month AND day-of-week an
  // intersection. OpenClaw schedules through croner, whose legacyMode default
  // is the POSIX/Vixie OR rule, so that expression fires on days 1-7 *or* any
  // weekend - 14 times in August 2026, enumerated against the croner build on
  // the deployed mini. Restricting only day-of-week means the same thing under
  // either reading; the "first weekend" half is reviews.mjs's own guard.
  it("expresses the monthly review with day-of-week only, so no cron DOM/DOW semantics can widen it", () => {
    const monthly = buildManagedOpenClawCronJobs("/repo").find(
      (job) => job.name === "openclaw-trading-monthly-review"
    );

    expect(monthly?.cron).toBe("0 10 * * 6,0");
    const [, , dayOfMonth, month] = String(monthly?.cron).split(" ");
    expect(dayOfMonth).toBe("*");
    expect(month).toBe("*");
  });
});
