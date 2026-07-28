#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { userLevelLabelsToRetire } from "./install-launchd-ownership.mjs";
import { MANAGED_REPORT_LAUNCHD_LABELS } from "./openclaw-report-launchd-jobs.mjs";

// Task 9 (2026-07-28 spec-drift remediation): this installer no longer
// installs ANY plist. It used to own the two official-paper schedules
// (com.openclaw.trading.official-paper.poll / .pnl) as user-level
// LaunchAgents - which launchd only bootstraps once a GUI login session
// exists, so a reboot that stopped at the login window left the official
// paper account unpolled (and, with no snapshot fresher than 90 minutes, every
// paper order server-side-rejected) until a human logged in. Those two labels
// are LaunchDaemons now, installed by install-system-daemons.sh; see
// install-launchd-ownership.txt for the label -> owner manifest.
//
// What is left here is the cleanup half, kept because it is what makes the
// migration safe to run in any order and any number of times: it boots out and
// deletes the user-level copy of every label a system daemon now owns, plus
// the labels nobody may own. Running this AFTER install-system-daemons.sh can
// therefore never resurrect a second, user-level copy of a daemon - the
// installer-fight failure mode task H7 already had to fix once.
//
// Task H7 (2026-07-14 legacy audit) context, still true: the daily/weekly
// report and stock-analysis jobs are owned by the openclaw cron channel
// (install-openclaw-cron.mjs), never by launchd. Their labels are retired here
// too, single-sourced from openclaw-report-launchd-jobs.mjs.

const launchAgentsDir = join(homedir(), "Library", "LaunchAgents");
const uid = process.getuid?.();

if (uid === undefined) {
  throw new Error("Cannot determine current uid for launchctl bootout.");
}

mkdirSync(launchAgentsDir, { recursive: true });

const retiredLabels = [
  ...userLevelLabelsToRetire(),
  "com.openclaw.trading.event-bus",
  "com.openclaw.trading.event-ingestor",
  "com.openclaw.trading.live-advisor",
  "com.openclaw.trading.paper-trader",
  "com.openclaw.trading.catchup",
  "com.openclaw.trading.maintenance.latest",
  "com.openclaw.trading.context.maintenance",
  ...MANAGED_REPORT_LAUNCHD_LABELS
];

for (const label of retiredLabels) {
  const plistPath = join(launchAgentsDir, `${label}.plist`);
  try {
    execFileSync("launchctl", ["bootout", `gui/${uid}`, plistPath], { stdio: "ignore" });
  } catch {
    // It may not be loaded on a fresh machine.
  }
  if (existsSync(plistPath)) {
    rmSync(plistPath);
    console.log(JSON.stringify({ retiredLaunchAgent: true, label, plistPath }, null, 2));
  }
}

console.log(JSON.stringify({
  installedLaunchAgents: [],
  note: "所有无人值守服务已改为 /Library/LaunchDaemons，请运行 pnpm launchd:install-system 安装。"
}, null, 2));
