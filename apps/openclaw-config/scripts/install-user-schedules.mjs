#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MANAGED_REPORT_LAUNCHD_LABELS } from "./openclaw-report-launchd-jobs.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const nodeBin = process.execPath;
const launchAgentsDir = join(homedir(), "Library", "LaunchAgents");
const runtimeLogDir = join(repoRoot, "runtime", "launchd");
const uid = process.getuid?.();

if (uid === undefined) {
  throw new Error("Cannot determine current uid for launchctl bootstrap.");
}

mkdirSync(launchAgentsDir, { recursive: true });
mkdirSync(runtimeLogDir, { recursive: true });

// Task H7 (2026-07-14 legacy audit): the daily/weekly report and
// stock-analysis jobs used to be installed HERE as direct launchd plists -
// the exact same 5 jobs install-openclaw-cron.mjs retires in favor of its
// openclaw-cron + cron-runner equivalents (per
// docs/superpowers/specs/2026-06-14-openclaw-report-quality-cron-design.md,
// the openclaw cron channel is the intended owner of scheduled report
// production, not direct launchd). Re-running this installer after
// `openclaw:cron:install` - the documented fix when official-paper polling
// needs a (re)install, since ONLY this script installs those two jobs -
// used to silently resurrect the 5 retired jobs, so every report was
// generated and delivered TWICE. Those 5 are no longer installed here at
// all; only the two jobs unique to this installer remain.
const jobs = [
  {
    label: "com.openclaw.trading.official-paper.poll",
    command: `${quote(nodeBin)} apps/openclaw-config/scripts/official-paper-monitor.mjs poll`,
    schedule: [{ Minute: 30 }]
  },
  {
    label: "com.openclaw.trading.official-paper.pnl",
    command: `${quote(nodeBin)} apps/openclaw-config/scripts/official-paper-monitor.mjs pnl`,
    schedule: [{ Minute: 0 }]
  }
];

const retiredLabels = [
  "com.openclaw.trading.event-bus",
  "com.openclaw.trading.event-ingestor",
  "com.openclaw.trading.live-advisor",
  "com.openclaw.trading.paper-trader",
  "com.openclaw.trading.catchup",
  "com.openclaw.trading.maintenance.latest",
  "com.openclaw.trading.context.maintenance",
  // Task H7: defensively retire these too (idempotent no-op if
  // install-openclaw-cron.mjs already did) - single-sourced from
  // openclaw-report-launchd-jobs.mjs so this installer can never again
  // reinstall what the cron channel owns.
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
  }
}

for (const job of jobs) {
  const plistPath = join(launchAgentsDir, `${job.label}.plist`);
  writeFileSync(plistPath, renderPlist(job), "utf8");

  try {
    execFileSync("launchctl", ["bootout", `gui/${uid}`, plistPath], { stdio: "ignore" });
  } catch {
    // Not loaded yet.
  }

  execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { stdio: "inherit" });
  execFileSync("launchctl", ["enable", `gui/${uid}/${job.label}`], { stdio: "ignore" });
  console.log(plistPath);
}

function renderPlist(job) {
  const outPath = join(runtimeLogDir, `${job.label}.out.log`);
  const errPath = join(runtimeLogDir, `${job.label}.err.log`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(job.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${escapeXml(`cd ${quote(repoRoot)} && ${job.command}`)}</string>
  </array>
  <key>StartCalendarInterval</key>
  ${renderSchedule(job.schedule)}
  <key>StandardOutPath</key>
  <string>${escapeXml(outPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(errPath)}</string>
  <key>WorkingDirectory</key>
  <string>${escapeXml(repoRoot)}</string>
</dict>
</plist>
`;
}

function renderSchedule(schedule) {
  const items = schedule.map((entry) => {
    const keys = Object.entries(entry).map(([key, value]) => `    <key>${key}</key>\n    <integer>${value}</integer>`).join("\n");
    return `  <dict>\n${keys}\n  </dict>`;
  });
  return `<array>\n${items.join("\n")}\n  </array>`;
}

function quote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
