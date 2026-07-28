#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildManagedOpenClawCronJobs } from "./openclaw-cron-jobs.mjs";
import { userLevelLabelsToRetire } from "./install-launchd-ownership.mjs";
import { retireUserLevelAgents, reportRetireResult } from "./launchd-agent-archive.mjs";
import { MANAGED_REPORT_LAUNCHD_LABELS } from "./openclaw-report-launchd-jobs.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const jobs = buildManagedOpenClawCronJobs(repoRoot);
const uid = process.getuid?.();

// Both, always - `||` here would short-circuit the second one.
const keptReportSchedules = retireLegacyLaunchdReportSchedules();
const keptDaemonAgents = retireUserLevelDaemonAgents();
const keptUserAgents = keptReportSchedules || keptDaemonAgents;

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

// Round-5 finding D1: reported AFTER the cron jobs are installed, and as a
// non-zero exit rather than a silent line, because "a user-level LaunchAgent
// had to be kept" means a system daemon is down - the machine is half
// migrated, and the operator has to know that before treating this step as
// done. The 5 cron jobs above ARE installed either way; nothing here is
// rolled back.
if (keptUserAgents) {
  console.error("install-openclaw-cron: 上面的 5 个 openclaw cron 任务已经装好了，但这台机器仍处于「迁移了一半」的状态：");
  console.error("install-openclaw-cron: 有用户级 LaunchAgent 被有意保留，因为接管它的系统 daemon 当前没有加载。");
  console.error("install-openclaw-cron: 先修好 sudo zsh apps/openclaw-config/scripts/install-system-daemons.sh，再重跑本命令。");
  process.exitCode = 1;
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
// What replaces the install here is its inverse: retire the user-level copy of
// every label a system daemon now owns. That is what makes
// `openclaw:cron:install` safe to re-run after `launchd:install-system`
// without resurrecting a second cron-runner racing the first one.
//
// Round-5 finding D1: this used to be `rmSync(plistPath)`, unconditionally and
// with no backup - the same defect as install-user-schedules.mjs, in a second
// place, deleting the fallback install-system-daemons.sh had deliberately kept
// for a service whose daemon did not come up. Both now share
// launchd-agent-archive.mjs, which only retires a label once its replacement
// daemon answers `launchctl print system/<label>` and always MOVES the plist
// into ~/Library/LaunchAgents.disabled/ instead of deleting it.
//
// @returns {boolean} whether anything was deliberately kept (half-migrated).
function retireUserLevelDaemonAgents() {
  if (uid === undefined) {
    return false;
  }
  return reportRetireResult(retireUserLevelAgents({
    labels: userLevelLabelsToRetire(),
    requireReplacementDaemon: true
  }));
}

function retireLegacyLaunchdReportSchedules() {
  if (uid === undefined) {
    return false;
  }
  // Task H7 (2026-07-14 legacy audit): single-sourced with
  // install-user-schedules.mjs via openclaw-report-launchd-jobs.mjs - see
  // that module's doc comment for why (the two installers used to fight
  // over this exact list). Nothing in launchd replaces these - the openclaw
  // cron jobs this script installs below do - so there is no daemon to wait
  // for; they are stopped and archived unconditionally.
  return reportRetireResult(retireUserLevelAgents({
    labels: MANAGED_REPORT_LAUNCHD_LABELS,
    requireReplacementDaemon: false
  }));
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

