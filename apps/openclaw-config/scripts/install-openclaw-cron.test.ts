import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(join(process.cwd(), "apps/openclaw-config/scripts/install-openclaw-cron.mjs"), "utf8");

describe("OpenClaw cron installer", () => {
  it("retires legacy launchd report schedules so OpenClaw cron is the report owner", () => {
    for (const label of [
      "com.openclaw.trading.report.daily.prepare",
      "com.openclaw.trading.report.daily.deliver",
      "com.openclaw.trading.report.weekly.prepare",
      "com.openclaw.trading.report.weekly.deliver",
      "com.openclaw.trading.stock-analysis"
    ]) {
      expect(script).toContain(label);
    }
  });

  it("uses system events for main-session cron jobs and avoids SSRF-blocked webhook delivery", () => {
    expect(script).toContain("\"--system-event\"");
    expect(script).toContain("\"--wake\"");
    expect(script).not.toContain("\"--webhook\"");
    expect(script).not.toContain("\"--message\"");
  });

  it("installs a loopback runner service instead of launchd schedules", () => {
    expect(script).toContain("com.openclaw.trading.cron-runner");
    expect(script).toContain("openclaw-cron-runner.mjs");
  });

  it("pins launchd to the local pnpm binary so cron runner jobs can spawn commands", () => {
    expect(script).toContain("<key>EnvironmentVariables</key>");
    expect(script).toContain("<key>PNPM_BIN</key>");
    expect(script).toContain("resolveExecutable(\"pnpm\")");
  });
});
