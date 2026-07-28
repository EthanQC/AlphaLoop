#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { userLevelLabelsToRetire } from "./install-launchd-ownership.mjs";
import { retireUserLevelAgents, reportRetireResult } from "./launchd-agent-archive.mjs";
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
// migration safe to run in any order and any number of times: it retires the
// user-level copy of every label a system daemon now owns, plus the labels
// nobody may own. Running this AFTER install-system-daemons.sh can therefore
// never resurrect a second, user-level copy of a daemon - the installer-fight
// failure mode task H7 already had to fix once.
//
// Round-5 finding D1: "retire" used to mean `rmSync`, unconditionally. That
// deleted, without a backup, exactly the plists install-system-daemons.sh had
// just DELIBERATELY kept for services whose daemon failed to come up - three
// of which cannot be recreated from this repo at all. Both halves now go
// through launchd-agent-archive.mjs: the system-owned labels are only touched
// once their replacement daemon answers `launchctl print`, and every retired
// plist is MOVED into ~/Library/LaunchAgents.disabled/openclaw-system-backup-
// <ts>/ rather than deleted. See that module's header for the measurement.
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

// Labels a system daemon took over: gated on that daemon actually being up.
const gated = retireUserLevelAgents({ labels: userLevelLabelsToRetire(), requireReplacementDaemon: true });

// Labels nothing replaces - the pre-Task-9 trading jobs (deleted from the
// codebase) and the 5 report/stock-analysis schedules the openclaw cron
// channel owns. There is no daemon to wait for, so these are stopped and
// archived unconditionally. Archived, not deleted: same rule for everything.
const orphaned = retireUserLevelAgents({
  labels: [
    "com.openclaw.trading.event-bus",
    "com.openclaw.trading.event-ingestor",
    "com.openclaw.trading.live-advisor",
    "com.openclaw.trading.paper-trader",
    "com.openclaw.trading.catchup",
    "com.openclaw.trading.maintenance.latest",
    "com.openclaw.trading.context.maintenance",
    ...MANAGED_REPORT_LAUNCHD_LABELS
  ],
  requireReplacementDaemon: false
});

const result = { archived: [...gated.archived, ...orphaned.archived], kept: [...gated.kept, ...orphaned.kept] };
const hasKept = reportRetireResult(result);

console.log(JSON.stringify({
  installedLaunchAgents: [],
  archivedLaunchAgents: result.archived.length,
  keptLaunchAgents: result.kept.length,
  note: "所有无人值守服务已改为 /Library/LaunchDaemons，请运行 sudo zsh apps/openclaw-config/scripts/install-system-daemons.sh 安装。"
}, null, 2));

if (hasKept) {
  console.error("install-user-schedules: 这台机器还处于「迁移了一半」的状态：上面列出的用户级 LaunchAgent 被有意保留，");
  console.error("install-user-schedules: 因为接管它们的系统 daemon 当前没有加载，删掉就等于让这些服务彻底停摆。");
  console.error("install-user-schedules: 先修好 sudo zsh apps/openclaw-config/scripts/install-system-daemons.sh，再重跑本命令。");
  process.exitCode = 1;
}
