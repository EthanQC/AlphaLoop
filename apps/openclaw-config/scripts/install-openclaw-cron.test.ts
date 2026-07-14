import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MANAGED_REPORT_LAUNCHD_LABELS } from "./openclaw-report-launchd-jobs.mjs";

const script = readFileSync(join(process.cwd(), "apps/openclaw-config/scripts/install-openclaw-cron.mjs"), "utf8");

describe("OpenClaw cron installer", () => {
  // Task H7 (2026-07-14 legacy audit): single-sourced with
  // install-user-schedules.mjs via openclaw-report-launchd-jobs.mjs - see
  // install-user-schedules.test.ts's "shared report/stock-analysis launchd
  // job list" suite for the cross-installer overlap test.
  it("retires legacy launchd report schedules (single-sourced) so OpenClaw cron is the report owner", () => {
    expect(script).toContain("openclaw-report-launchd-jobs.mjs");
    expect(script).toContain("MANAGED_REPORT_LAUNCHD_LABELS");
    for (const label of MANAGED_REPORT_LAUNCHD_LABELS) {
      expect(script).not.toContain(`"${label}"`);
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
