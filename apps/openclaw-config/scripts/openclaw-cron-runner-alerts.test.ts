import { describe, expect, it } from "vitest";

const alerts = await import("./openclaw-cron-runner-alerts.mjs");

describe("OpenClaw cron runner alerts", () => {
  it("builds a Chinese failure alert with marker identity and sanitized evidence", () => {
    const markdown = alerts.buildCronFailureAlertMarkdown({
      job: "daily",
      trigger: "openclaw-cron-run-log",
      openclawJobName: "openclaw-trading-daily-report",
      openclawRunId: "run-123",
      command: "pnpm report:daily:run",
      startedAt: "2026-06-19T12:00:00.000Z",
      finishedAt: "2026-06-19T12:01:00.000Z",
      code: 1,
      signal: null,
      error: "Authorization: Bearer secret-token failed",
      stdoutTail: "quality gate failed",
      stderrTail: "LONGBRIDGE_ACCESS_TOKEN=abc123 Longbridge connect failed"
    }, {
      nextRetryAt: "2026-06-19T12:02:00.000Z",
      attempts: 1
    });

    expect(markdown).toContain("# OpenClaw 自动报告失败告警");
    expect(markdown).toContain("任务：daily");
    expect(markdown).toContain("OpenClaw marker：openclaw-trading-daily-report / run-123");
    expect(markdown).toContain("下一次自动重试：2026-06-19T12:02:00.000Z");
    expect(markdown).toContain("quality gate failed");
    expect(markdown).not.toContain("secret-token");
    expect(markdown).not.toContain("abc123");
  });
});
