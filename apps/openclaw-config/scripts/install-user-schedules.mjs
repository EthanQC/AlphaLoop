#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const marketWeekdays = [1, 2, 3, 4, 5];
const catchupMinutes = [7, 22, 37, 52];

const jobs = [
  {
    label: "com.openclaw.trading.catchup",
    command: `${quote(nodeBin)} --no-warnings apps/openclaw-config/scripts/reconcile-user-schedules.mjs run`,
    schedule: catchupMinutes.map((Minute) => ({ Minute })),
    runAtLoad: true
  },
  {
    label: "com.openclaw.trading.report.daily.prepare",
    command: `${quote(nodeBin)} apps/openclaw-config/scripts/scheduled-report.mjs daily prepare`,
    schedule: marketWeekdays.map((Weekday) => ({ Weekday, Hour: 19, Minute: 0 }))
  },
  {
    label: "com.openclaw.trading.report.daily.deliver",
    command: `${quote(nodeBin)} apps/openclaw-config/scripts/scheduled-report.mjs daily deliver`,
    schedule: marketWeekdays.map((Weekday) => ({ Weekday, Hour: 20, Minute: 0 }))
  },
  {
    label: "com.openclaw.trading.report.weekly.prepare",
    command: `${quote(nodeBin)} apps/openclaw-config/scripts/scheduled-report.mjs weekly prepare`,
    schedule: [{ Weekday: 1, Hour: 19, Minute: 0 }]
  },
  {
    label: "com.openclaw.trading.report.weekly.deliver",
    command: `${quote(nodeBin)} apps/openclaw-config/scripts/scheduled-report.mjs weekly deliver`,
    schedule: [{ Weekday: 1, Hour: 20, Minute: 0 }]
  },
  {
    label: "com.openclaw.trading.maintenance.latest",
    command: `${quote(nodeBin)} apps/openclaw-config/scripts/maintenance-check.mjs`,
    schedule: [{ Hour: 9, Minute: 10 }]
  },
  {
    label: "com.openclaw.trading.context.maintenance",
    command: `${quote(nodeBin)} --no-warnings apps/openclaw-config/scripts/context-manager.mjs maintenance`,
    schedule: [{ Minute: 20 }]
  }
];

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
  const runAtLoad = job.runAtLoad
    ? "  <key>RunAtLoad</key>\n  <true/>\n"
    : "";

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
${runAtLoad}  <key>StandardOutPath</key>
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
