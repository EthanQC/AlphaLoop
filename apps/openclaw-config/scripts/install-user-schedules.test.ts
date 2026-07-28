// Round-5 finding D5: every test in this file used to be
// `readFileSync(install-user-schedules.mjs)` + `expect(script).toContain(...)`.
// Nothing ran the installer, nothing looked at a filesystem, and the header
// pointed at install-launchd.test.ts for "the behavioural proof" - which ran
// all four installers only on a machine where every daemon bootstraps fine.
// So no test in the repo covered the one case that mattered: what this
// installer does to a user-level plist whose replacement daemon is DOWN. It
// deleted it, with rmSync and no backup (finding D1), including three labels
// that exist in no other copy anywhere in this repo.
//
// These tests run the REAL installer binary against a throwaway $HOME with a
// stub launchctl on PATH, and assert on the FILESYSTEM afterwards.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { launchdLabelsWithScope, userLevelLabelsToRetire } from "./install-launchd-ownership.mjs";
import { systemDaemonReplacing } from "./launchd-agent-archive.mjs";
import { MANAGED_REPORT_LAUNCHD_LABELS } from "./openclaw-report-launchd-jobs.mjs";

const installer = fileURLToPath(new URL("./install-user-schedules.mjs", import.meta.url));
const tempDirs: string[] = [];

interface Machine {
  home: string;
  agentsDir: string;
  archiveParent: string;
  loadedDir: string;
  env: NodeJS.ProcessEnv;
}

/**
 * launchctl stub. The installer asks it exactly two things, and both are
 * modelled the way launchctl(1) answers them:
 *   print system/<label>   exit 0 when that daemon is loaded, 113 when it is not
 *   bootout gui/<uid> <plist>   exit 0
 */
function makeMachine(prefix: string, loadedDaemons: string[]): Machine {
  const home = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(home);
  const binDir = join(home, "bin");
  const loadedDir = join(home, "loaded");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(loadedDir, { recursive: true });
  for (const label of loadedDaemons) {
    writeFileSync(join(loadedDir, label), "");
  }
  const stub = join(binDir, "launchctl");
  writeFileSync(stub, [
    "#!/bin/sh",
    'if [ "$1" = "print" ]; then',
    `  case "$2" in system/*) [ -f "${loadedDir}/\${2#system/}" ] && exit 0 ;; esac`,
    "  exit 113",
    "fi",
    "exit 0",
    ""
  ].join("\n"));
  chmodSync(stub, 0o755);

  return {
    home,
    agentsDir: join(home, "Library", "LaunchAgents"),
    archiveParent: join(home, "Library", "LaunchAgents.disabled"),
    loadedDir,
    env: { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` }
  };
}

function seedAgents(machine: Machine, labels: string[]): void {
  mkdirSync(machine.agentsDir, { recursive: true });
  for (const label of labels) {
    writeFileSync(
      join(machine.agentsDir, `${label}.plist`),
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>${label}</string></dict></plist>\n`
    );
  }
}

function runInstaller(machine: Machine): { status: number; output: string } {
  try {
    return { status: 0, output: execFileSync(process.execPath, [installer], { env: machine.env, encoding: "utf8", stdio: "pipe" }) };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    if (typeof failure.status !== "number") {
      throw error;
    }
    return { status: failure.status, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

function agentsOnDisk(machine: Machine): string[] {
  return existsSync(machine.agentsDir)
    ? readdirSync(machine.agentsDir).map((name) => name.replace(/\.plist$/u, "")).sort()
    : [];
}

function archivedPlists(machine: Machine): string[] {
  if (!existsSync(machine.archiveParent)) {
    return [];
  }
  return readdirSync(machine.archiveParent)
    .flatMap((dir) => readdirSync(join(machine.archiveParent, dir)))
    .map((name) => name.replace(/\.plist$/u, ""))
    .sort();
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("pnpm launchd:install-user, run for real against a throwaway HOME", () => {
  // The exact machine finding D1 was measured on: install-system-daemons.sh
  // could not bootstrap com.alphaloop.market-alerts, so it deliberately KEPT
  // that service's user-level agent and exited 1. This installer is the very
  // next runbook step.
  it("leaves a user agent completely alone while its replacement daemon is down", () => {
    const downLabel = "com.alphaloop.market-alerts";
    const machine = makeMachine("alphaloop-user-sched-down-", launchdLabelsWithScope("system").filter((label) => label !== downLabel));
    seedAgents(machine, [downLabel]);

    const { status, output } = runInstaller(machine);

    expect(agentsOnDisk(machine)).toEqual([downLabel]);
    expect(archivedPlists(machine)).toEqual([]);
    // Loud, not silent: a half-migrated machine must not look like a clean run.
    expect(status).toBe(1);
    expect(output).toContain("keptLaunchAgent");
    expect(output).toMatch(/迁移了一半/u);
  });

  it("archives - never deletes - a user agent whose daemon is verified up", () => {
    const machine = makeMachine("alphaloop-user-sched-up-", launchdLabelsWithScope("system"));
    seedAgents(machine, ["com.alphaloop.market-alerts", "com.openclaw.trading.official-paper.poll"]);

    const { status } = runInstaller(machine);

    expect(agentsOnDisk(machine)).toEqual([]);
    // The old code called rmSync here. official-paper.poll has no template
    // under apps/openclaw-config/launchd/, so a delete was unrecoverable.
    expect(archivedPlists(machine)).toEqual(["com.alphaloop.market-alerts", "com.openclaw.trading.official-paper.poll"]);
    expect(status).toBe(0);
  });

  it("keeps the plist when the archive itself cannot be written, rather than deleting it anyway", () => {
    const machine = makeMachine("alphaloop-user-sched-ro-", launchdLabelsWithScope("system"));
    seedAgents(machine, ["com.openclaw.trading.cron-runner"]);
    // Reproduces the mini, where ~/Library/LaunchAgents.disabled is `root staff`
    // from a pre-M7 sudo run and the unprivileged operator cannot write into it.
    mkdirSync(machine.archiveParent, { recursive: true });
    chmodSync(machine.archiveParent, 0o500);

    const { status, output } = runInstaller(machine);
    chmodSync(machine.archiveParent, 0o700);

    expect(agentsOnDisk(machine)).toEqual(["com.openclaw.trading.cron-runner"]);
    expect(status).toBe(1);
    expect(output).toContain("无法创建归档目录");
  });

  it("retires the report/legacy labels nothing replaces without waiting for any daemon", () => {
    // No daemon is loaded at all here: the report schedules are owned by the
    // openclaw cron channel, not by launchd, so there is nothing to wait for.
    const machine = makeMachine("alphaloop-user-sched-orphan-", []);
    seedAgents(machine, [...MANAGED_REPORT_LAUNCHD_LABELS, "com.openclaw.trading.event-bus"]);

    runInstaller(machine);

    expect(agentsOnDisk(machine)).toEqual([]);
    expect(archivedPlists(machine)).toEqual([...MANAGED_REPORT_LAUNCHD_LABELS, "com.openclaw.trading.event-bus"].sort());
  });

  it("never touches the operator's own 185-agent OpenClaw plists", () => {
    const foreign = ["com.qingverse.openclaw.auto-update", "com.xhs.openclaw-safe-cleanup", "homebrew.mxcl.colima"];
    const machine = makeMachine("alphaloop-user-sched-foreign-", launchdLabelsWithScope("system"));
    seedAgents(machine, foreign);

    runInstaller(machine);

    expect(agentsOnDisk(machine)).toEqual([...foreign].sort());
    expect(archivedPlists(machine)).toEqual([]);
  });

  it("installs no plist of its own, whatever the machine looks like", () => {
    const machine = makeMachine("alphaloop-user-sched-empty-", launchdLabelsWithScope("system"));
    const { output } = runInstaller(machine);
    expect(agentsOnDisk(machine)).toEqual([]);
    expect(output).toContain("\"installedLaunchAgents\": []");
  });
});

describe("the retire list is derived, not copied", () => {
  it("asks the shared manifest which labels a system daemon now owns", () => {
    expect(userLevelLabelsToRetire()).toEqual([
      ...launchdLabelsWithScope("system"),
      ...launchdLabelsWithScope("retired")
    ]);
    expect(userLevelLabelsToRetire()).toContain("com.openclaw.trading.official-paper.poll");
    expect(userLevelLabelsToRetire()).toContain("com.openclaw.trading.official-paper.pnl");
  });

  it("maps each legacy user-level name onto the daemon that replaced it", () => {
    expect(systemDaemonReplacing("com.openclaw.trading.broker-executor")).toBe("com.openclaw.system.trading.broker-executor");
    expect(systemDaemonReplacing("ai.openclaw.gateway")).toBe("ai.openclaw.system.gateway");
    // Everything else is its own replacement, so a new system label needs no
    // extra row to be gated correctly.
    for (const label of launchdLabelsWithScope("system")) {
      expect(systemDaemonReplacing(label)).toBe(label);
    }
  });
});

describe("shared report/stock-analysis launchd job list (task H7)", () => {
  it("names exactly the 5 report/stock-analysis jobs the openclaw cron channel owns", () => {
    expect(MANAGED_REPORT_LAUNCHD_LABELS).toEqual([
      "com.openclaw.trading.report.daily.prepare",
      "com.openclaw.trading.report.daily.deliver",
      "com.openclaw.trading.report.weekly.prepare",
      "com.openclaw.trading.report.weekly.deliver",
      "com.openclaw.trading.stock-analysis"
    ]);
  });
});
