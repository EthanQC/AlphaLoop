import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { userLevelLabelsToRetire } from "./install-launchd-ownership.mjs";
import { MANAGED_REPORT_LAUNCHD_LABELS } from "./openclaw-report-launchd-jobs.mjs";

const script = readFileSync(join(process.cwd(), "apps/openclaw-config/scripts/install-openclaw-cron.mjs"), "utf8");
const systemDaemons = readFileSync(join(process.cwd(), "apps/openclaw-config/scripts/install-system-daemons.sh"), "utf8");

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

  // Task 9 (2026-07-28): the cron runner was a user-level LaunchAgent written
  // by THIS script, so a reboot that stopped at the login window left every
  // scheduled report/poll/sweep undispatched. The runner is a LaunchDaemon
  // now; this installer keeps only the `openclaw cron add` half, which
  // genuinely needs the operator's own gateway session and ~/.openclaw config.
  // The behavioural proof (real run, fake HOME, both installer orders) is in
  // install-launchd.test.ts's cross-installer suite.
  it("no longer writes a cron-runner LaunchAgent, and retires the user-level copy instead", () => {
    expect(script).not.toContain("<key>Label</key>");
    expect(script).not.toMatch(/launchctl",\s*\["bootstrap"/u);
    expect(script).toContain("install-launchd-ownership.mjs");
    expect(script).toContain("userLevelLabelsToRetire");
    expect(userLevelLabelsToRetire()).toContain("com.openclaw.trading.cron-runner");
  });

  it("hands the runner's PNPM_BIN pin over to the system-daemon installer rather than dropping it", () => {
    // openclaw-cron-runner.mjs reads PNPM_BIN to spawn each job's `pnpm ...`;
    // losing it during the promotion would give a daemon that boots fine and
    // then fails every single job with ENOENT.
    expect(systemDaemons).toContain("PNPM_BIN");
    expect(systemDaemons).toContain("openclaw-cron-runner.mjs");
    expect(systemDaemons).toContain("cannot resolve a pnpm binary");
  });
});
