#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildManagedOpenClawCronJobs } from "./openclaw-cron-jobs.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const jobs = buildManagedOpenClawCronJobs(repoRoot);
const uid = process.getuid?.();

retireLegacyLaunchdReportSchedules();
installCronRunnerService();

for (const job of jobs) {
  removeExistingJob(job.name);
  const output = execOpenClaw([
    "cron",
    "add",
    "--name",
    job.name,
    "--description",
    job.description,
    "--cron",
    job.cron,
    "--tz",
    job.timezone,
    "--agent",
    job.agent,
    "--session",
    job.session,
    "--system-event",
    job.systemEvent,
    "--wake",
    job.wake,
    "--expect-final",
    "--timeout-seconds",
    String(job.timeoutSeconds),
    "--json"
  ]);
  const created = parseJson(output);
  console.log(JSON.stringify({
    installed: true,
    name: job.name,
    id: created?.id ?? created?.job?.id ?? null,
    cron: job.cron,
    timezone: job.timezone
  }, null, 2));
}

function installCronRunnerService() {
  if (uid === undefined) {
    return;
  }
  const label = "com.openclaw.trading.cron-runner";
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const logDir = join(repoRoot, "runtime", "launchd");
  const runnerPath = join(repoRoot, "apps", "openclaw-config", "scripts", "openclaw-cron-runner.mjs");
  const nodeBin = process.execPath;
  const pnpmBin = resolveExecutable("pnpm");
  const runnerPathEnv = buildLaunchdPath([dirname(nodeBin), dirname(pnpmBin)]);
  mkdirp(logDir);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodeBin)}</string>
    <string>${escapeXml(runnerPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(repoRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(runnerPathEnv)}</string>
    <key>PNPM_BIN</key>
    <string>${escapeXml(pnpmBin)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(logDir, `${label}.out.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(logDir, `${label}.err.log`))}</string>
</dict>
</plist>
`;
  writeText(plistPath, plist);
  try {
    execFileSync("launchctl", ["bootout", `gui/${uid}`, plistPath], { stdio: "ignore" });
  } catch {
    // Not loaded yet.
  }
  execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { stdio: "ignore" });
  execFileSync("launchctl", ["enable", `gui/${uid}/${label}`], { stdio: "ignore" });
  console.log(JSON.stringify({ installedRunner: true, label, plistPath }, null, 2));
}

function retireLegacyLaunchdReportSchedules() {
  if (uid === undefined) {
    return;
  }
  const labels = [
    "com.openclaw.trading.report.daily.prepare",
    "com.openclaw.trading.report.daily.deliver",
    "com.openclaw.trading.report.weekly.prepare",
    "com.openclaw.trading.report.weekly.deliver",
    "com.openclaw.trading.stock-analysis"
  ];
  for (const label of labels) {
    const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}`, plistPath], { stdio: "ignore" });
    } catch {
      // It may not be loaded on this machine.
    }
    if (existsSync(plistPath)) {
      rmSync(plistPath);
      console.log(JSON.stringify({ retiredLaunchd: true, label, plistPath }, null, 2));
    }
  }
}

function removeExistingJob(name) {
  let existing;
  try {
    existing = parseJson(execOpenClaw(["cron", "show", name, "--json"]));
  } catch {
    return;
  }
  const id = existing?.id ?? existing?.job?.id;
  if (!id) {
    return;
  }
  execOpenClaw(["cron", "rm", String(id), "--json"]);
}

function execOpenClaw(args) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return execFileSync("openclaw", args, {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      lastError = error;
      const stderr = String(error?.stderr ?? error?.message ?? "");
      if (!/GatewayTransportError|ECONNREFUSED|abnormal closure/iu.test(stderr) || attempt === 4) {
        throw error;
      }
      sleepSync(1000 * attempt);
    }
  }
  throw lastError;
}

function parseJson(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function resolveExecutable(command) {
  return execFileSync("which", [command], { encoding: "utf8" }).trim();
}

function buildLaunchdPath(extraDirs) {
  return [
    ...extraDirs,
    ...(process.env.PATH ?? "").split(":"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ].filter(Boolean).filter((value, index, all) => all.indexOf(value) === index).join(":");
}

function mkdirp(path) {
  mkdirSync(path, { recursive: true });
}

function writeText(path, value) {
  writeFileSync(path, value, "utf8");
}

function escapeXml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}
