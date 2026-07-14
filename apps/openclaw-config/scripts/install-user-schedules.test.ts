import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MANAGED_REPORT_LAUNCHD_LABELS } from "./openclaw-report-launchd-jobs.mjs";

const script = readFileSync(join(process.cwd(), "apps/openclaw-config/scripts/install-user-schedules.mjs"), "utf8");

describe("user launchd schedule cleanup", () => {
  it("installs the official-paper polling and PnL schedules (the two jobs unique to this installer)", () => {
    expect(script).toContain('label: "com.openclaw.trading.official-paper.poll"');
    expect(script).toContain('label: "com.openclaw.trading.official-paper.pnl"');
  });

  it("retires old user-level trading jobs when installing retained schedules", () => {
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
  // every daily/weekly/stock-analysis report then ran, and delivered,
  // TWICE. They must never again appear in this script's own `jobs` array
  // (the list this installer actually installs as plists); the raw label
  // strings should only ever appear via the single shared import.
  it("no longer installs the 5 report/stock-analysis jobs the openclaw cron channel owns (the installer fight this task fixes)", () => {
    for (const label of MANAGED_REPORT_LAUNCHD_LABELS) {
      expect(script).not.toContain(`label: "${label}"`);
    }
  });

  it("imports the single-sourced managed-report-label list instead of duplicating it as a literal array", () => {
    expect(script).toContain("openclaw-report-launchd-jobs.mjs");
    expect(script).toContain("MANAGED_REPORT_LAUNCHD_LABELS");
  });

  it("still defensively retires the cron-owned labels (idempotent if install-openclaw-cron.mjs already did)", () => {
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

  it("the set install-user-schedules.mjs installs and the set it retires (== the cron-owned set) cannot overlap", () => {
    const installedLabelMatches = [...script.matchAll(/label:\s*"([^"]+)"/gu)].map((match) => match[1]);
    const overlap = installedLabelMatches.filter((label) => MANAGED_REPORT_LAUNCHD_LABELS.includes(label));
    expect(overlap).toEqual([]);
  });
});
