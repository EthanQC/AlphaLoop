import { describe, expect, it } from "vitest";

import { buildManagedOpenClawCronJobs } from "./openclaw-cron-jobs.mjs";

describe("managed OpenClaw cron jobs", () => {
  it("registers OpenClaw-owned report and analysis jobs with repository quality commands", () => {
    const jobs = buildManagedOpenClawCronJobs("/repo");

    expect(jobs.map((job) => job.name)).toEqual([
      "openclaw-trading-daily-report",
      "openclaw-trading-weekly-report",
      "openclaw-trading-stock-analysis",
      "openclaw-trading-proposal-sweep"
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
    // proposal-expiry sweep is a plain atomic-consume sweep, not a quality
    // pipeline, so it is intentionally excluded from this specific check.
    for (const job of jobs.slice(0, 3)) {
      expect(job.systemEvent).toContain("quality");
    }
    expect(jobs[3]?.systemEvent).toContain("proposal-expiry sweep");
  });
});
