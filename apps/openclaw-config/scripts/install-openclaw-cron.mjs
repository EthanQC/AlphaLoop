#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildManagedOpenClawCronJobs } from "./openclaw-cron-jobs.mjs";
import { userLevelLabelsToRetire } from "./install-launchd-ownership.mjs";
import { MANAGED_REPORT_LAUNCHD_LABELS } from "./openclaw-report-launchd-jobs.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const jobs = buildManagedOpenClawCronJobs(repoRoot);
const uid = process.getuid?.();

retireLegacyLaunchdReportSchedules();
retireUserLevelDaemonAgents();

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

// Task 9 (2026-07-28 spec-drift remediation): this installer used to write
// com.openclaw.trading.cron-runner into ~/Library/LaunchAgents. launchd only
// bootstraps a LaunchAgent once a GUI login session exists, so a reboot that
// stopped at the login window left the runner - and therefore every scheduled
// report, poll and sweep the openclaw cron channel dispatches to it - dead
// until a human logged in. The runner is a LaunchDaemon now
// (install-system-daemons.sh, with UserName + RunAtLoad and the PNPM_BIN it
// needs). This installer keeps owning the `openclaw cron add` jobs below,
// which genuinely need the operator's own gateway session and ~/.openclaw
// config and so cannot move to a system daemon.
//
// What replaces the install here is its inverse: boot out and delete the
// user-level copy of every label a system daemon now owns. That is what makes
// `openclaw:cron:install` safe to re-run after `launchd:install-system`
// without resurrecting a second cron-runner racing the first one.
function retireUserLevelDaemonAgents() {
  if (uid === undefined) {
    return;
  }
  for (const label of userLevelLabelsToRetire()) {
    const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}`, plistPath], { stdio: "ignore" });
    } catch {
      // Not loaded on this machine.
    }
    if (existsSync(plistPath)) {
      rmSync(plistPath);
      console.log(JSON.stringify({ retiredLaunchAgent: true, label, plistPath }, null, 2));
    }
  }
}

function retireLegacyLaunchdReportSchedules() {
  if (uid === undefined) {
    return;
  }
  // Task H7 (2026-07-14 legacy audit): single-sourced with
  // install-user-schedules.mjs via openclaw-report-launchd-jobs.mjs - see
  // that module's doc comment for why (the two installers used to fight
  // over this exact list).
  for (const label of MANAGED_REPORT_LAUNCHD_LABELS) {
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

