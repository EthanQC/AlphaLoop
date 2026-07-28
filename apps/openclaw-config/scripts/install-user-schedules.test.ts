import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { launchdLabelsWithScope, userLevelLabelsToRetire } from "./install-launchd-ownership.mjs";
import { MANAGED_REPORT_LAUNCHD_LABELS } from "./openclaw-report-launchd-jobs.mjs";

const script = readFileSync(join(process.cwd(), "apps/openclaw-config/scripts/install-user-schedules.mjs"), "utf8");

// The behavioural proof for this installer - a real run against a fake HOME,
// asserting which labels end up in ~/Library/LaunchAgents vs
// /Library/LaunchDaemons after every installer has run in both orders - lives
// in install-launchd.test.ts ("one owner per launchd label across ALL four
// installers"), because the property is a cross-installer one. What is left
// here are the source-level invariants that keep the single-sourcing honest.

describe("user launchd schedule cleanup", () => {
  // Task 9 (2026-07-28): the two official-paper schedules were user-level
  // LaunchAgents, so they only ran once someone had logged in. They are
  // LaunchDaemons now (install-system-daemons.sh). This installer must not
  // define ANY plist any more - a second, user-level copy of a system daemon
  // is exactly the race the ownership manifest exists to prevent.
  it("no longer defines any launchd job of its own", () => {
    expect(script).not.toMatch(/label:\s*"/u);
    expect(script).not.toContain("<key>Label</key>");
    expect(script).not.toContain("StartCalendarInterval");
  });

  it("retires every label a system daemon now owns, read from the shared manifest rather than a private copy", () => {
    expect(script).toContain("install-launchd-ownership.mjs");
    expect(script).toContain("userLevelLabelsToRetire");
    expect(userLevelLabelsToRetire()).toEqual([
      ...launchdLabelsWithScope("system"),
      ...launchdLabelsWithScope("retired")
    ]);
    expect(userLevelLabelsToRetire()).toContain("com.openclaw.trading.official-paper.poll");
    expect(userLevelLabelsToRetire()).toContain("com.openclaw.trading.official-paper.pnl");
  });

  it("still retires the pre-Task-9 user-level trading jobs", () => {
    for (const label of [
      "com.openclaw.trading.event-bus",
      "com.openclaw.trading.event-ingestor",
      "com.openclaw.trading.live-advisor",
      "com.openclaw.trading.paper-trader",
      "com.openclaw.trading.catchup",
      "com.openclaw.trading.maintenance.latest",
      "com.openclaw.trading.context.maintenance"
    ]) {
      expect(script).toContain(label);
    }
  });

  // Task H7 (2026-07-14 legacy audit): install-openclaw-cron.mjs retires
  // these same 5 labels in favor of its openclaw-cron + cron-runner
  // equivalents. This installer used to reinstall them as direct launchd
  // plists, resurrecting a schedule the OTHER installer had just retired -
  // every daily/weekly/stock-analysis report then ran, and delivered, TWICE.
  it("still defensively retires the cron-owned report labels (idempotent if install-openclaw-cron.mjs already did)", () => {
    expect(script.toLowerCase()).toContain("retiredlabels");
    expect(script).toMatch(/\.\.\.MANAGED_REPORT_LAUNCHD_LABELS/u);
  });
});

describe("shared report/stock-analysis launchd job list (task H7)", () => {
  const cronScript = readFileSync(join(process.cwd(), "apps/openclaw-config/scripts/install-openclaw-cron.mjs"), "utf8");

  it("names exactly the 5 report/stock-analysis jobs the openclaw cron channel owns", () => {
    expect(MANAGED_REPORT_LAUNCHD_LABELS).toEqual([
      "com.openclaw.trading.report.daily.prepare",
      "com.openclaw.trading.report.daily.deliver",
      "com.openclaw.trading.report.weekly.prepare",
      "com.openclaw.trading.report.weekly.deliver",
      "com.openclaw.trading.stock-analysis"
    ]);
  });

  it("is imported by both installers instead of being duplicated as a literal array in either", () => {
    expect(script).toContain("openclaw-report-launchd-jobs.mjs");
    expect(cronScript).toContain("openclaw-report-launchd-jobs.mjs");
  });
});
