import { describe, expect, it } from "vitest";

import { buildManagedOpenClawCronJobs } from "./openclaw-cron-jobs.mjs";

describe("managed OpenClaw cron jobs", () => {
  it("registers OpenClaw-owned report and analysis jobs with repository quality commands", () => {
    const jobs = buildManagedOpenClawCronJobs("/repo");

    expect(jobs.map((job) => job.name)).toEqual([
      "openclaw-trading-daily-report",
      "openclaw-trading-weekly-report",
      "openclaw-trading-stock-analysis"
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
      })
    ]);
    for (const job of jobs) {
      expect(job.systemEvent).toContain("cd /repo");
      expect(job.systemEvent).toContain("quality");
      expect(job.systemEvent).toContain("schedule marker");
      expect(job).not.toHaveProperty("webhook");
      expect(job.systemEvent).toContain("runner watches this run log");
      expect(job.agent).toBe("control");
      expect(job.session).toBe("main");
      expect(job.wake).toBe("next-heartbeat");
    }
  });
});
