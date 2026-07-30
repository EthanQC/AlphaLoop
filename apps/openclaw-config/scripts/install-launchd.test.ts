// Phase 3 Task 8: proves install-launchd.sh actually picks up the new
// com.alphaloop.platform-app.plist.template - "H2 made it glob
// *.plist.template" was a claim to verify, not assume. Runs the REAL script
// against the REAL templates in apps/openclaw-config/launchd/, with only
// $HOME redirected to a throwaway temp directory so the render/load flow is
// exercised end-to-end without ever touching the operator's real
// ~/Library/LaunchAgents or the real launchd job table (H2's incident this
// task must not repeat).
//
// The install-launchd.sh script itself rebuilds PATH from `$HOME` on its
// very first line (`export PATH="${HOME}/.local/node-v24/bin:${HOME}/.local/bin:..."`),
// so pointing $HOME at a fake directory that ALSO has stub `launchctl` and
// `openclaw` executables under `.local/bin` is enough to make the script's
// own PATH construction resolve to those stubs ahead of the real system
// binaries - no extra PATH plumbing needed on this test's end.
//
// Task 9 (2026-07-28 spec-drift remediation) extends this file to cover the
// whole installer family, because the property under test is now a
// CROSS-installer one - "exactly one owner per label" cannot be proven by any
// single installer's own suite. Every suite below runs the REAL installer
// binary (bash/zsh/node) and reads the generated plists back through Apple's
// own parser (`plutil`), which is the real consumer of these files: a plist
// that only satisfies our string matching but not launchd's parser would be
// worthless. This file already lives in vitest.config.ts's serial lane, which
// is where subprocess-spawning suites belong.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import * as doctor from "./openclaw-runtime-doctor-core.mjs";
import { readLaunchdOwnership, launchdLabelsWithScope, userLevelLabelsToRetire } from "./install-launchd-ownership.mjs";
import { SYSTEM_DAEMON_SUPERSEDING } from "./launchd-agent-archive.mjs";

const scriptPath = fileURLToPath(new URL("./install-launchd.sh", import.meta.url));
const systemDaemonsScript = fileURLToPath(new URL("./install-system-daemons.sh", import.meta.url));
const userSchedulesScript = fileURLToPath(new URL("./install-user-schedules.mjs", import.meta.url));
const cronInstallScript = fileURLToPath(new URL("./install-openclaw-cron.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/u, "");

const SYSTEM_LABELS = launchdLabelsWithScope("system");
const USER_LABELS = launchdLabelsWithScope("user");
const RETIRED_LABELS = launchdLabelsWithScope("retired");

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeStub(path: string, logPath: string): void {
  // `$@` (not `$0`) so the log records exactly what install-launchd.sh
  // passed - e.g. "load /fake/home/Library/LaunchAgents/com.alphaloop.rsshub.plist".
  const contents = `#!/bin/sh\necho "$@" >> "${logPath}"\nexit 0\n`;
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

interface LaunchctlStubOptions {
  /** Directory holding the stub's job table and disabled database. */
  stateDir: string;
  /** Label whose `bootstrap` fails, to inject the partial failure of C2. */
  failBootstrapLabel?: string;
  /**
   * Which domain that injected failure applies to. "any" (the default) models a
   * plist launchd rejects wherever it is loaded from; "system" models a daemon
   * that cannot start while the old user-level agent is still perfectly
   * loadable - the case round 5's restore step exists for.
   */
  failBootstrapDomain?: "any" | "system";
  /** Labels seeded into the disabled database, to inject the wedge of C3. */
  disabledLabels?: string[];
  /**
   * Round-6 finding S3e. Labels whose `print` answers the way a daemon that
   * bootstrapped and then DIED answers: `state = not running` with a non-zero
   * `last exit code`, exactly the shape the mini's rsshub agent prints today.
   * `bootstrap` still succeeds for them and `print` still exits 0 - which is
   * precisely why an installer that verified with `print`'s exit code called
   * them loaded.
   */
  deadOnArrivalLabels?: string[];
  /**
   * Round-6 finding S3c. A resident daemon sampled just after launchd relaunched
   * it, whose last death was by SIGNAL: `state = running`, a high `runs`, and NO
   * `last exit code` line at all - the shape com.alphaloop.platform-app prints on
   * the mini right now (measured: `last terminating signal = Terminated: 15`;
   * the signal here is SIGSEGV, reproduced locally on a throwaway label).
   */
  signalCrashLoopLabels?: string[];
  /**
   * Round-6 finding S3f. A user-level agent that is STILL loaded after
   * `launchctl bootout` - the case the installer used to warn about and then
   * carry on regardless, bootstrapping the daemon next to it.
   */
  surviveBootoutLabels?: string[];
  /**
   * Task 28. Seconds a label stays visible to `print` after `bootout` when the
   * job was started less than `bootoutDrainRecentWindowSeconds` ago. Models the
   * drain measured on a real launchd (2026-07-30, throwaway agent with the real
   * ai.openclaw.gateway plist's KeepAlive=true + ExitTimeOut=20): `bootout`
   * returns 0 in ~35ms, `launchctl print` keeps answering for ~20.2s while the
   * SIGTERM-slow process drains, the pid never changes (so it is a drain, NOT a
   * KeepAlive restart), then the label vanishes. A TERM-obedient agent is gone
   * in ~40ms - which is why every pre-task-28 test passed with the instant
   * removal below: they modelled only the obedient case, and the mini's first
   * full deploy run hit the other one three labels wide.
   */
  bootoutDrainSeconds?: number;
  /** How recently started (seconds) a job must be for its bootout to drain. */
  bootoutDrainRecentWindowSeconds?: number;
}

/**
 * launchctl stub as a STATE MACHINE over a job table on disk.
 *
 * Round 4: the installer no longer trusts `bootstrap`'s exit code - it asks
 * launchd whether the label actually loaded (`launchctl print system/<label>`)
 * and decides on that answer whether the old user-level LaunchAgent may be
 * archived. The previous stub answered every `print` with exit 1, i.e. "no job
 * is ever loaded, before or after bootstrap", which no real launchctl does; it
 * modelled only the post-bootout half of the contract because that was the
 * only half the installer used to read.
 *
 * The four behaviours modelled here are the four the installer depends on, and
 * each matches launchctl(1):
 *   print      exits 0 iff the target was bootstrapped and not since booted out
 *   bootout    fails when the target is not loaded (the ordinary second-run case)
 *   bootstrap  fails on a missing plist, and fails on a label sitting in the
 *              disabled database - the wedge finding C3 is about
 *   enable     removes the label from the disabled database
 */
function writeLaunchctlStub(path: string, logPath: string, options: LaunchctlStubOptions): void {
  const loadedDir = join(options.stateDir, "loaded");
  const disabledDir = join(options.stateDir, "disabled");
  const deadDir = join(options.stateDir, "dead");
  const loopDir = join(options.stateDir, "signalloop");
  const stickyDir = join(options.stateDir, "sticky");
  const drainingDir = join(options.stateDir, "draining");
  mkdirSync(loadedDir, { recursive: true });
  mkdirSync(disabledDir, { recursive: true });
  mkdirSync(deadDir, { recursive: true });
  mkdirSync(loopDir, { recursive: true });
  mkdirSync(stickyDir, { recursive: true });
  mkdirSync(drainingDir, { recursive: true });
  for (const label of options.disabledLabels ?? []) {
    writeFileSync(join(disabledDir, `system_${label}`), "");
  }
  for (const label of options.deadOnArrivalLabels ?? []) {
    writeFileSync(join(deadDir, label), "");
  }
  for (const label of options.signalCrashLoopLabels ?? []) {
    writeFileSync(join(loopDir, label), "");
  }
  for (const label of options.surviveBootoutLabels ?? []) {
    writeFileSync(join(stickyDir, label), "");
  }

  const domainGuard = options.failBootstrapDomain === "system" ? ' && [ "$dom" = "system" ]' : "";
  const failLine = options.failBootstrapLabel
    ? `    if [ "$lbl" = "${options.failBootstrapLabel}" ]${domainGuard}; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi`
    : "    :";

  const contents = [
    "#!/bin/sh",
    `echo "$@" >> "${logPath}"`,
    `S="${options.stateDir}"`,
    `DRAIN=${options.bootoutDrainSeconds ?? 0}`,
    `WINDOW=${options.bootoutDrainRecentWindowSeconds ?? 0}`,
    'key() { printf "%s" "$1" | tr / _; }',
    // Task 28: a drain that has run its course is resolved lazily, by whichever
    // subcommand looks next - the same way the real launchd's removal becomes
    // visible to the next `print` rather than being pushed anywhere.
    'expire_drain() { if [ -f "$S/draining/$1" ] && [ "$(date +%s)" -ge "$(cat "$S/draining/$1")" ]; then rm -f "$S/draining/$1" "$S/loaded/$1"; fi; }',
    'case "$1" in',
    // Round 6: `print` answers with a real launchctl payload, not just an exit
    // code. The installer now judges the daemon on what this says (see
    // launchd-health.mjs), so a stub that printed nothing would model a
    // launchctl no version of macOS ships - and would make every verification
    // trivially pass or trivially fail. Field spellings and the single-tab
    // indent are copied from the mini's own output.
    '  print)',
    '    expire_drain "$(key "$2")"',
    '    [ -f "$S/loaded/$(key "$2")" ] || exit 113',
    '    lbl="${2##*/}"',
    '    printf "%s = {\n" "$2"',
    '    if [ -f "$S/dead/$lbl" ]; then',
    '      printf "\tstate = not running\n\truns = 1\n\tlast exit code = 1\n"',
    '    elif [ -f "$S/signalloop/$lbl" ]; then',
    '      printf "\tstate = running\n\truns = 918\n\tpid = 4242\n\tlast terminating signal = Segmentation fault: 11\n"',
    '    else',
    '      printf "\tstate = running\n\truns = 2\n\tpid = 4242\n"',
    '    fi',
    '    printf "\tstderr path = /tmp/%s.err.log\n}\n" "$lbl"',
    "    exit 0 ;;",
    '  enable) rm -f "$S/disabled/$(key "$2")"; exit 0 ;;',
    '  disable) touch "$S/disabled/$(key "$2")"; exit 0 ;;',
    // Both spellings launchctl(1) accepts, because the installers use both:
    // `bootout <domain>/<label>` (the daemons) and `bootout <domain> <plist>`
    // (the node installers, and the gui restore path).
    "  bootout)",
    '    tgt="$2"',
    '    case "$3" in *.plist) tgt="$2/$(basename "$3" .plist)" ;; esac',
    '    k="$(key "$tgt")"',
    '    expire_drain "$k"',
    '    [ -f "$S/loaded/$k" ] || { echo "Boot-out failed: 113: Could not find specified service" >&2; exit 113; }',
    // S3f: a "sticky" label reports success and stays loaded, which is what a
    // wedged agent does - bootout returns 0 and the job is still there.
    '    case "$tgt" in gui/*) [ -f "$S/sticky/${tgt##*/}" ] && exit 0 ;; esac',
    // Task 28: a second bootout landing mid-drain changes nothing - the first
    // one already condemned the job, its removal just has not finished.
    '    [ -f "$S/draining/$k" ] && exit 0',
    // Task 28: booting out a RECENTLY-STARTED job does not remove it here and
    // now. It returns 0 (measured: ~35ms on the real launchd) and the label
    // stays visible to `print` for DRAIN more seconds - the ExitTimeOut window
    // in which launchd is still escalating SIGTERM to SIGKILL.
    '    if [ "$DRAIN" -gt 0 ]; then',
    '      age=$(( $(date +%s) - $(stat -f %m "$S/loaded/$k") ))',
    '      if [ "$age" -le "$WINDOW" ]; then echo $(( $(date +%s) + DRAIN )) > "$S/draining/$k"; exit 0; fi',
    '    fi',
    '    rm -f "$S/loaded/$k"; exit 0 ;;',
    "  bootstrap)",
    '    lbl="$(basename "$3" .plist)"',
    '    [ -f "$3" ] || { echo "Bootstrap failed: 2: No such file or directory" >&2; exit 2; }',
    // The domain is an argument, not an assumption: `bootstrap gui/<uid> <plist>`
    // (the restore path) must load the job in the USER domain, not the system one.
    '    case "$2" in gui/*) dom="$2" ;; *) dom="system" ;; esac',
    '    if [ -f "$S/disabled/$(key "$dom/$lbl")" ]; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi',
    failLine,
    // A fresh load starts a fresh life: any leftover drain marker from the
    // previous incarnation must not be allowed to "expire" the new one.
    '    rm -f "$S/draining/$(key "$dom/$lbl")"',
    '    touch "$S/loaded/$(key "$dom/$lbl")"; exit 0 ;;',
    "  kickstart)",
    '    [ -f "$S/loaded/$(key "$3")" ] || { echo "Could not find service" >&2; exit 113; }',
    "    exit 0 ;;",
    "esac",
    "exit 0"
  ].join("\n");
  writeFileSync(path, `${contents}\n`);
  chmodSync(path, 0o755);
}

// `openclaw cron show` must fail (nothing installed yet) so the installer's
// removeExistingJob() takes its "no existing job" path; `cron add` must return
// parseable JSON, which is what the real CLI's --json flag emits.
//
// Task 28: `gatewayInstallStartsAgent` makes `gateway install` DO what the
// real CLI does, reduced to the part launchd sees - read off the mini's
// archived copy: it renders ~/Library/LaunchAgents/ai.openclaw.gateway.plist
// (KeepAlive=true, ExitTimeOut=20) and STARTS it. That side effect is the
// full-run defect's trigger, so the full-deploy suite opts in; every other
// suite keeps the inert stub, because it is testing template rendering, not
// the gateway handover.
function writeOpenClawStub(
  path: string,
  logPath: string,
  options: { gatewayInstallStartsAgent?: { launchctl: string; agentsDir: string; uid: number } } = {}
): void {
  const gateway = options.gatewayInstallStartsAgent;
  const gatewayLines = gateway
    ? [
        'if [ "$1" = "gateway" ] && [ "$2" = "install" ]; then',
        `  mkdir -p "${gateway.agentsDir}"`,
        '  printf \'<?xml version="1.0" encoding="UTF-8"?>\\n<plist version="1.0"><dict><key>Label</key><string>ai.openclaw.gateway</string><key>KeepAlive</key><true/><key>ExitTimeOut</key><integer>20</integer></dict></plist>\\n\''
          + ` > "${gateway.agentsDir}/ai.openclaw.gateway.plist"`,
        `  "${gateway.launchctl}" bootstrap "gui/${gateway.uid}" "${gateway.agentsDir}/ai.openclaw.gateway.plist"`,
        "  exit 0",
        "fi"
      ]
    : [];
  const contents = [
    "#!/bin/sh",
    `echo "$@" >> "${logPath}"`,
    'if [ "$1" = "cron" ] && [ "$2" = "add" ]; then echo \'{"id":1}\'; exit 0; fi',
    ...gatewayLines,
    'if [ "$1" = "gateway" ]; then exit 0; fi',
    "exit 1"
  ].join("\n");
  writeFileSync(path, `${contents}\n`);
  chmodSync(path, 0o755);
}

/**
 * Reads a value out of a generated plist through Apple's OWN plist parser.
 * `plutil` is what launchd itself uses, so a file that survives this reads
 * back exactly the way the real consumer will read it - unlike a substring
 * assertion, which would happily pass on XML launchd rejects.
 */
function plistValue(file: string, keyPath: string): string {
  return execFileSync("plutil", ["-extract", keyPath, "raw", "-o", "-", file], { encoding: "utf8" }).trim();
}

function lintPlist(file: string): string {
  return execFileSync("plutil", ["-lint", file], { encoding: "utf8" }).trim();
}

interface FakeMachine {
  home: string;
  systemDir: string;
  agentsDir: string;
  stubBinDir: string;
  launchctlLog: string;
  openclawLog: string;
  /** The stub launchd's job table, so tests can ask what is actually loaded. */
  stateDir: string;
  env: NodeJS.ProcessEnv;
}

function makeFakeMachine(prefix: string, stub: Omit<LaunchctlStubOptions, "stateDir"> = {}): FakeMachine {
  const home = makeTempDir(prefix);
  const systemDir = join(makeTempDir(`${prefix}sys-`), "LaunchDaemons");
  const stubBinDir = join(home, ".local", "bin");
  const nodeBinDir = join(home, ".local", "node-v24", "bin");
  const stateDir = join(home, "launchd-state");
  mkdirSync(stubBinDir, { recursive: true });
  mkdirSync(nodeBinDir, { recursive: true });
  mkdirSync(systemDir, { recursive: true });

  const launchctlLog = join(home, "launchctl-calls.log");
  const openclawLog = join(home, "openclaw-calls.log");
  writeLaunchctlStub(join(stubBinDir, "launchctl"), launchctlLog, { ...stub, stateDir });
  writeOpenClawStub(join(stubBinDir, "openclaw"), openclawLog);
  // install-system-daemons.sh resolves PNPM_BIN under the TARGET user's own
  // node install and refuses to install when it cannot find one, so the fake
  // machine has to actually have it (this is the branch a real mini takes).
  writeStub(join(nodeBinDir, "pnpm"), join(home, "pnpm-calls.log"));
  // A REAL node, not a stub: round 6 made the installer run
  // launchd-health.mjs to decide whether a daemon actually came up, and a
  // stub node that logs its arguments and exits 0 would answer "healthy" for
  // a machine where nothing runs - i.e. it would re-create, inside the test
  // harness, the exact defect the check exists to close.
  symlinkSync(process.execPath, join(nodeBinDir, "node"));

  return {
    home,
    systemDir,
    agentsDir: join(home, "Library", "LaunchAgents"),
    stubBinDir,
    launchctlLog,
    openclawLog,
    stateDir,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${stubBinDir}:${process.env.PATH ?? ""}`,
      TARGET_USER: userInfo().username,
      TARGET_HOME: home,
      SYSTEM_DIR: systemDir,
      LAUNCHCTL: join(stubBinDir, "launchctl"),
      BOOTSTRAP_SETTLE_SECONDS: "0",
      VERIFY_SETTLE_SECONDS: "0",
      // Task 28: 1s, not the production 30s - a sticky label (S3f) must fail
      // the run in about a second here, not half a minute per label. Tests
      // that exercise the drain itself override this with their own deadline.
      BOOTOUT_SETTLE_SECONDS: "1",
      // Deploy receipts go to the fake machine's own runtime tree. Without
      // this the real installer would append to the repo's runtime/, which is
      // what test/runtime-write-guard.ts exists to stop.
      DEPLOY_RUNTIME_ROOT: join(home, "runtime")
    }
  };
}

function runSystemDaemons(machine: FakeMachine, shell: "bash" | "zsh" = "bash"): string {
  return execFileSync(shell, [systemDaemonsScript], { env: machine.env, encoding: "utf8" });
}

/**
 * Marks user-level agents as currently LOADED in the stub's job table, i.e. the
 * machine is really running the old copy right now. Round 5: the installer no
 * longer boots out a label blindly - it asks `launchctl print gui/<uid>/<label>`
 * first - so a test that wants to observe the handover has to model a machine
 * where there is something to hand over.
 */
function seedRunningUserAgents(machine: FakeMachine, labels: string[]): void {
  seedLegacyUserAgents(machine, labels);
  const uid = process.getuid?.();
  const loadedDir = join(machine.stateDir, "loaded");
  mkdirSync(loadedDir, { recursive: true });
  for (const label of labels) {
    writeFileSync(join(loadedDir, `gui_${uid}_${label}`), "");
  }
}

function seedLegacyUserAgents(machine: FakeMachine, labels: string[]): void {
  mkdirSync(machine.agentsDir, { recursive: true });
  for (const label of labels) {
    writeFileSync(
      join(machine.agentsDir, `${label}.plist`),
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string></dict></plist>\n`
    );
  }
}

function plistLabelsIn(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).filter((name) => name.endsWith(".plist")).map((name) => name.replace(/\.plist$/u, "")).sort();
}

function launchAgentLabels(machine: FakeMachine): string[] {
  return plistLabelsIn(machine.agentsDir);
}

function launchDaemonLabels(machine: FakeMachine): string[] {
  return plistLabelsIn(machine.systemDir);
}

/**
 * What the stub launchd is actually RUNNING, as opposed to which plist files
 * exist on disk. The distinction is the whole point of C2: the old installer
 * left eight plists in /Library/LaunchDaemons while only two of them were
 * loaded, so `launchDaemonLabels` alone reported a healthy machine.
 */
function loadedSystemLabels(machine: FakeMachine): string[] {
  const loadedDir = join(machine.stateDir, "loaded");
  if (!existsSync(loadedDir)) {
    return [];
  }
  return readdirSync(loadedDir)
    .filter((name) => name.startsWith("system_"))
    .map((name) => name.slice("system_".length))
    .sort();
}

function backupDirs(machine: FakeMachine): string[] {
  const parent = join(machine.home, "Library", "LaunchAgents.disabled");
  return existsSync(parent) ? readdirSync(parent).sort() : [];
}

/** Every plist inside every archive directory, whichever installer put it there. */
function archivedLabels(machine: FakeMachine): string[] {
  const parent = join(machine.home, "Library", "LaunchAgents.disabled");
  if (!existsSync(parent)) {
    return [];
  }
  return readdirSync(parent).flatMap((dir) => plistLabelsIn(join(parent, dir))).sort();
}

/** What the stub launchd is running in the USER domain. */
function loadedUserLabels(machine: FakeMachine): string[] {
  const loadedDir = join(machine.stateDir, "loaded");
  if (!existsSync(loadedDir)) {
    return [];
  }
  return readdirSync(loadedDir)
    .filter((name) => name.startsWith("gui_"))
    .map((name) => name.replace(/^gui_\d+_/u, ""))
    .sort();
}

/** Runs the installer expecting a non-zero exit, and returns what it printed. */
function runSystemDaemonsExpectingFailure(machine: FakeMachine): { status: number; output: string } {
  try {
    const stdout = execFileSync("bash", [systemDaemonsScript], { env: machine.env, encoding: "utf8", stdio: "pipe" });
    throw new Error(`expected a non-zero exit, got success:\n${stdout}`);
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    if (typeof failure.status !== "number") {
      throw error;
    }
    return { status: failure.status, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("launchd ownership manifest", () => {
  it("scopes every unattended service to the system domain and keeps only rsshub user-level", () => {
    expect(SYSTEM_LABELS).toEqual([
      "ai.openclaw.system.gateway",
      "com.openclaw.system.trading.broker-executor",
      "com.alphaloop.platform-app",
      "com.alphaloop.market-alerts",
      "com.alphaloop.daily-backup",
      "com.openclaw.trading.cron-runner",
      "com.openclaw.trading.official-paper.poll",
      "com.openclaw.trading.official-paper.pnl"
    ]);
    expect(USER_LABELS).toEqual(["com.alphaloop.rsshub"]);
  });

  it("gives every label exactly one row, so 'who owns this label' can never be ambiguous", () => {
    const labels = readLaunchdOwnership().map((row) => row.label);
    expect(labels.length).toBe(new Set(labels).size);
  });

  it("asks every installer to retire the same set: system-owned plus nobody-owned", () => {
    expect(userLevelLabelsToRetire()).toEqual([...SYSTEM_LABELS, ...RETIRED_LABELS]);
  });

  // The manifest's prose explains each decision and therefore names labels
  // inside comments (why rsshub stays user-level, which daemon supersedes
  // broker-executor). A parser that took the first line mentioning a label
  // resolved rsshub's scope to "#" and skipped installing it entirely - which
  // is exactly what the awk lookups in both shell installers did before the
  // `/^[[:space:]]*#/ {next}` guard.
  it("never reads a label mentioned in a comment as if it were a row", () => {
    const commentedLabels = readFileSync(
      fileURLToPath(new URL("./install-launchd-ownership.txt", import.meta.url)),
      "utf8"
    )
      .split(/\r?\n/u)
      .filter((line) => line.trimStart().startsWith("#"))
      .flatMap((line) => line.match(/\b(?:com|ai|pm2|homebrew)\.[\w.-]+\b/gu) ?? []);
    expect(commentedLabels.length).toBeGreaterThan(0);
    expect(readLaunchdOwnership().every((row) => row.scope !== "#")).toBe(true);
    expect(launchdLabelsWithScope("user")).toEqual(["com.alphaloop.rsshub"]);
  });
});

describe("install-launchd.sh fake-HOME dry run (Phase 3 Task 8)", () => {
  it("renders only the user-scoped template and refuses to write a second copy of any system-owned label", () => {
    const fakeHome = makeTempDir("alphaloop-fake-home-");
    const stubBinDir = join(fakeHome, ".local", "bin");
    mkdirSync(stubBinDir, { recursive: true });

    const launchctlLog = join(fakeHome, "launchctl-calls.log");
    const openclawLog = join(fakeHome, "openclaw-calls.log");
    writeStub(join(stubBinDir, "launchctl"), launchctlLog);
    writeStub(join(stubBinDir, "openclaw"), openclawLog);

    execFileSync("zsh", [scriptPath], {
      env: { ...process.env, HOME: fakeHome },
      encoding: "utf8"
    });

    const destDir = join(fakeHome, "Library", "LaunchAgents");

    // Phase 4 Task 8 (news engine deployment wiring): proves
    // com.alphaloop.rsshub.plist.template is picked up - the script's
    // `*.plist.template` glob already covers new files with zero script
    // changes, but that claim is worth verifying against the REAL
    // script/template pair rather than assuming.
    const rsshubPlist = join(destDir, "com.alphaloop.rsshub.plist");
    expect(existsSync(rsshubPlist)).toBe(true);
    const rsshubRendered = readFileSync(rsshubPlist, "utf8");
    expect(rsshubRendered).not.toContain("__REPO_ROOT__");
    expect(rsshubRendered).toContain(repoRoot);
    expect(plistValue(rsshubPlist, "Label")).toBe("com.alphaloop.rsshub");
    expect(plistValue(rsshubPlist, "ProgramArguments.2")).toContain("docker start rsshub");

    // The rendered file's destination path was actually handed to `launchctl
    // load` (our stub), not just written to disk - proves the install path,
    // not only the render step.
    expect(readFileSync(launchctlLog, "utf8")).toContain(`load ${rsshubPlist}`);

    // Task 9: platform-app / market-alerts / daily-backup are LaunchDaemons
    // now. Their templates are still on disk (install-system-daemons.sh
    // carries their commands and schedules verbatim), and the ONLY thing
    // stopping this script from rendering a second, user-level copy of each
    // is the ownership manifest - so assert against the real run, not the
    // manifest we just read.
    for (const label of [...SYSTEM_LABELS, ...RETIRED_LABELS]) {
      expect(existsSync(join(destDir, `${label}.plist`))).toBe(false);
    }
    expect(plistLabelsIn(destDir)).toEqual(["com.alphaloop.rsshub"]);

    // com.openclaw.gateway.plist is scoped `external` (the `openclaw` CLI owns
    // that label) - confirms the fake-HOME run still exercises that carve-out
    // rather than silently no-op'ing everything.
    expect(existsSync(join(destDir, "com.openclaw.gateway.plist"))).toBe(false);

    // The script's final `openclaw gateway install` step still ran to
    // completion (i.e. nothing upstream aborted the script early).
    expect(readFileSync(openclawLog, "utf8")).toContain("gateway install");
  });

  it("fails loudly on a template with no ownership row instead of silently not installing it", () => {
    const fakeHome = makeTempDir("alphaloop-fake-home-unlisted-");
    const stubBinDir = join(fakeHome, ".local", "bin");
    mkdirSync(stubBinDir, { recursive: true });
    writeStub(join(stubBinDir, "launchctl"), join(fakeHome, "launchctl.log"));
    writeStub(join(stubBinDir, "openclaw"), join(fakeHome, "openclaw.log"));

    // A manifest missing rsshub stands in for "someone added a template and
    // forgot the row" without having to write into the real launchd/ dir.
    const partialManifest = join(fakeHome, "ownership.txt");
    writeFileSync(partialManifest, "system ai.openclaw.system.gateway\n");

    expect(() =>
      execFileSync("zsh", [scriptPath], {
        env: { ...process.env, HOME: fakeHome, OWNERSHIP_FILE: partialManifest },
        encoding: "utf8",
        stdio: "pipe"
      })
    ).toThrow(/has no row in/u);
  });
});

describe("install-system-daemons.sh (Task 9: unattended services survive a login-window reboot)", () => {
  it("writes every unattended service to /Library/LaunchDaemons with UserName and RunAtLoad, and nothing to ~/Library/LaunchAgents", () => {
    const machine = makeFakeMachine("alphaloop-daemons-");
    // Running the old user-level copy of every label, which is the machine the
    // bootout assertions below are about.
    seedRunningUserAgents(machine, SYSTEM_LABELS);
    const stdout = runSystemDaemons(machine);

    expect(launchDaemonLabels(machine).sort()).toEqual([...SYSTEM_LABELS].sort());
    expect(stdout).toContain(machine.systemDir);

    const launchctlCalls = readFileSync(machine.launchctlLog, "utf8");
    const uid = process.getuid?.();

    for (const label of SYSTEM_LABELS) {
      const plist = join(machine.systemDir, `${label}.plist`);

      // Apple's own parser accepts it. A daemon plist launchd cannot parse is
      // a daemon that never starts, no matter what our string matching says.
      expect(lintPlist(plist)).toContain("OK");

      expect(plistValue(plist, "Label")).toBe(label);
      // UserName is what lets a root-domain daemon still run as the operator
      // (repo checkout, ~/.openclaw credentials and node all live there).
      expect(plistValue(plist, "UserName")).toBe(userInfo().username);
      // RunAtLoad is the actual "重启自愈" property: launchd starts it at boot.
      expect(plistValue(plist, "RunAtLoad")).toBe("true");
      expect(plistValue(plist, "EnvironmentVariables.HOME")).toBe(machine.home);

      // Idempotent bootout -> bootstrap against the SYSTEM domain.
      expect(launchctlCalls).toContain(`bootout system/${label}`);
      expect(launchctlCalls).toContain(`bootstrap system ${plist}`);
      expect(launchctlCalls).toContain(`enable system/${label}`);
      // ...and the user-domain copy is booted out so the two can never race.
      expect(launchctlCalls).toContain(`bootout gui/${uid}/${label}`);

      expect(existsSync(join(machine.agentsDir, `${label}.plist`))).toBe(false);
    }

    expect(launchAgentLabels(machine)).toEqual([]);
  });

  it("keeps each promoted job's real command and cadence (KeepAlive for services, a schedule for the periodic ones)", () => {
    const machine = makeFakeMachine("alphaloop-daemons-cadence-");
    runSystemDaemons(machine);

    const plistFor = (label: string) => join(machine.systemDir, `${label}.plist`);
    const commandOf = (label: string) => plistValue(plistFor(label), "ProgramArguments.2");

    // Long-running services: KeepAlive relaunches them if they crash.
    for (const label of [
      "com.alphaloop.platform-app",
      "com.openclaw.trading.cron-runner",
      "ai.openclaw.system.gateway",
      "com.openclaw.system.trading.broker-executor"
    ]) {
      expect(plistValue(plistFor(label), "KeepAlive")).toBe("true");
    }
    expect(commandOf("com.alphaloop.platform-app")).toContain("pnpm --filter @apps/platform-app start");
    expect(commandOf("com.openclaw.trading.cron-runner")).toContain("openclaw-cron-runner.mjs");
    // openclaw-cron-runner.mjs spawns每个 cron job via PNPM_BIN; a daemon that
    // lost it would boot fine and then ENOENT on every job.
    expect(commandOf("com.openclaw.trading.cron-runner")).toContain("export PNPM_BIN=");

    // Periodic jobs: KeepAlive must be false or launchd would relaunch the
    // one-shot command the instant it exits (a busy loop, not a schedule).
    expect(plistValue(plistFor("com.alphaloop.market-alerts"), "KeepAlive")).toBe("false");
    expect(plistValue(plistFor("com.alphaloop.market-alerts"), "StartInterval")).toBe("300");
    expect(commandOf("com.alphaloop.market-alerts")).toContain("pnpm alerts:poll");

    expect(plistValue(plistFor("com.alphaloop.daily-backup"), "KeepAlive")).toBe("false");
    expect(plistValue(plistFor("com.alphaloop.daily-backup"), "StartCalendarInterval.Hour")).toBe("5");
    expect(plistValue(plistFor("com.alphaloop.daily-backup"), "StartCalendarInterval.Minute")).toBe("30");
    expect(commandOf("com.alphaloop.daily-backup")).toContain("pnpm backup:daily");

    expect(plistValue(plistFor("com.openclaw.trading.official-paper.poll"), "StartCalendarInterval.Minute")).toBe("30");
    expect(commandOf("com.openclaw.trading.official-paper.poll")).toContain("official-paper-monitor.mjs' poll");
    expect(plistValue(plistFor("com.openclaw.trading.official-paper.pnl"), "StartCalendarInterval.Minute")).toBe("0");
    expect(commandOf("com.openclaw.trading.official-paper.pnl")).toContain("official-paper-monitor.mjs' pnl");
  });

  it("migrates a machine that still has the old user-level agents, and is safe to re-run", () => {
    const machine = makeFakeMachine("alphaloop-daemons-migrate-");
    // Exactly what `ls ~/Library/LaunchAgents` shows on the mini today.
    seedLegacyUserAgents(machine, [
      "com.alphaloop.daily-backup",
      "com.alphaloop.market-alerts",
      "com.alphaloop.platform-app",
      "com.openclaw.trading.cron-runner",
      "com.openclaw.trading.official-paper.pnl",
      "com.openclaw.trading.official-paper.poll",
      "com.openclaw.trading.broker-executor"
    ]);
    // A label belonging to the operator's unrelated personal OpenClaw must be
    // left completely alone.
    seedLegacyUserAgents(machine, ["com.qingverse.openclaw.auto-update"]);

    runSystemDaemons(machine);
    expect(launchAgentLabels(machine)).toEqual(["com.qingverse.openclaw.auto-update"]);

    // Second run: same result, no duplicate plists, still no user-level copy.
    runSystemDaemons(machine);
    expect(launchAgentLabels(machine)).toEqual(["com.qingverse.openclaw.auto-update"]);
    expect(launchDaemonLabels(machine).sort()).toEqual([...SYSTEM_LABELS].sort());
  });

  it("runs identically under zsh (its shebang) and bash (the pnpm launchd:install-system entry point)", () => {
    const bashMachine = makeFakeMachine("alphaloop-daemons-bash-");
    const zshMachine = makeFakeMachine("alphaloop-daemons-zsh-");
    runSystemDaemons(bashMachine, "bash");
    runSystemDaemons(zshMachine, "zsh");
    expect(launchDaemonLabels(zshMachine).sort()).toEqual(launchDaemonLabels(bashMachine).sort());
    expect(launchDaemonLabels(zshMachine).sort()).toEqual([...SYSTEM_LABELS].sort());
  });

  // Round-3 finding F1: TARGET_USER defaulted to the literal "abble" - the
  // laptop this repo was written on. `id -u abble` fails on the mini (user
  // `qingchang`) and with `set -e` that aborted the installer on its third
  // line, so the only script that installs the unattended services could not
  // be run there at all with its documented arguments. These tests drive the
  // REAL script's own resolution via PRINT_CONFIG_ONLY, which stops before it
  // creates a directory, writes a plist or calls launchctl.
  describe("who it installs for (round-3 finding F1)", () => {
    function printConfig(env: NodeJS.ProcessEnv): Record<string, string> {
      const stdout = execFileSync("zsh", [systemDaemonsScript], {
        env: { ...process.env, TARGET_USER: "", TARGET_HOME: "", SUDO_USER: "", PRINT_CONFIG_ONLY: "1", PNPM_BIN: "/usr/bin/true", ...env },
        encoding: "utf8"
      });
      return Object.fromEntries(
        stdout.split(/\r?\n/u).filter(Boolean).map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        })
      );
    }

    it("defaults to the operator running it, not a username hardcoded from another machine", () => {
      const config = printConfig({});
      expect(config.target_user).toBe(userInfo().username);
      expect(config.target_user).not.toBe("abble-hardcoded-placeholder");
      expect(config.target_home).toBe(userInfo().homedir);
    });

    it("really writes nothing during the preflight, including a temp directory", () => {
      // The preflight's whole value is that an operator can run it before the
      // `sudo` invocation without consequences, so "creates nothing" has to be
      // asserted rather than asserted-in-a-comment: an earlier draft called
      // `mktemp -d` at the top of the script and leaked one directory per
      // preflight while the comment above it claimed otherwise. `mktemp`
      // honours TMPDIR, so pointing TMPDIR at a scratch directory makes the
      // leak observable.
      const scratchTmp = makeTempDir("alphaloop-daemons-preflight-tmp-");
      const scratchSystemDir = join(makeTempDir("alphaloop-daemons-preflight-sys-"), "LaunchDaemons");

      execFileSync("zsh", [systemDaemonsScript], {
        env: {
          ...process.env,
          TARGET_USER: userInfo().username,
          PRINT_CONFIG_ONLY: "1",
          PNPM_BIN: "/usr/bin/true",
          SYSTEM_DIR: scratchSystemDir,
          TMPDIR: scratchTmp
        },
        encoding: "utf8"
      });

      expect(readdirSync(scratchTmp)).toEqual([]);
      expect(existsSync(scratchSystemDir)).toBe(false);
    });

    it("resolves SUDO_USER under sudo, because `id -un` there is root and root is the wrong answer", () => {
      const config = printConfig({ SUDO_USER: userInfo().username });
      expect(config.target_user).toBe(userInfo().username);
    });

    it("refuses rather than installing eight daemons that run as root", () => {
      expect(() =>
        execFileSync("zsh", [systemDaemonsScript], {
          env: { ...process.env, TARGET_USER: "root", PRINT_CONFIG_ONLY: "1" },
          encoding: "utf8",
          stdio: "pipe"
        })
      ).toThrow(/refusing to install daemons that run as root/u);
    });

    it("names the missing user instead of dying on an unexplained `id: no such user`", () => {
      expect(() =>
        execFileSync("zsh", [systemDaemonsScript], {
          env: { ...process.env, TARGET_USER: "nobody-with-this-name-exists", PRINT_CONFIG_ONLY: "1" },
          encoding: "utf8",
          stdio: "pipe"
        })
      ).toThrow(/no such user 'nobody-with-this-name-exists'/u);
    });

    // Skipped under root ON PURPOSE, and this is not squeamishness: with no
    // SYSTEM_DIR override this case points the real installer at the real
    // /Library/LaunchDaemons, so as root it would sail past the guard it is
    // testing and install eight daemons on the machine running the suite.
    // The guard is "am I root", so the only way to observe it firing is to
    // not be root.
    it.skipIf(process.getuid?.() === 0)("stops with the sudo command up front instead of failing halfway into /Library/LaunchDaemons", () => {
      // No SYSTEM_DIR override => the real system directory => needs root.
      expect(() =>
        execFileSync("zsh", [systemDaemonsScript], {
          env: { ...process.env, TARGET_USER: userInfo().username, PNPM_BIN: "/usr/bin/true" },
          encoding: "utf8",
          stdio: "pipe"
        })
      ).toThrow(/needs root[\s\S]*re-run as: sudo zsh/u);
    });
  });

  // Round-3 finding F3: the proxy block used to be written for every daemon
  // this script renders. Before ac741d8 it only ever reached gateway and
  // broker-executor - the six promoted services came from templates that
  // exported PATH and nothing else (see apps/openclaw-config/launchd/
  // *.plist.template), so they silently changed egress path when they moved
  // here. Asserted through plutil, i.e. the key really is absent from the
  // parsed plist rather than merely absent from our string matching.
  describe("per-service egress policy (round-3 finding F3)", () => {
    const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"];

    function hasProxyEnv(file: string): boolean {
      return PROXY_KEYS.some((key) => {
        try {
          execFileSync("plutil", ["-extract", `EnvironmentVariables.${key}`, "raw", "-o", "-", file], { stdio: "pipe" });
          return true;
        } catch {
          return false;
        }
      });
    }

    it("proxies only the two services that were already proxied before the promotion", () => {
      const machine = makeFakeMachine("alphaloop-daemons-egress-");
      runSystemDaemons(machine);

      const proxied = SYSTEM_LABELS.filter((label) => hasProxyEnv(join(machine.systemDir, `${label}.plist`)));
      expect(proxied.sort()).toEqual([
        "ai.openclaw.system.gateway",
        "com.openclaw.system.trading.broker-executor"
      ]);
    });

    it("gives the six promoted services back the PATH-only environment their LaunchAgent templates had", () => {
      const machine = makeFakeMachine("alphaloop-daemons-egress-direct-");
      runSystemDaemons(machine);

      for (const label of [
        "com.alphaloop.platform-app",
        "com.alphaloop.market-alerts",
        "com.alphaloop.daily-backup",
        "com.openclaw.trading.cron-runner",
        "com.openclaw.trading.official-paper.poll",
        "com.openclaw.trading.official-paper.pnl"
      ]) {
        const plist = join(machine.systemDir, `${label}.plist`);
        expect(lintPlist(plist)).toContain("OK");
        expect(hasProxyEnv(plist)).toBe(false);
        // PATH and HOME are still there - "no proxy" must not mean "no env".
        expect(plistValue(plist, "EnvironmentVariables.HOME")).toBe(machine.home);
        expect(plistValue(plist, "EnvironmentVariables.PATH")).toContain("/opt/homebrew/bin");
      }
    });

    it("lets a machine without a transparent proxy opt a service in explicitly", () => {
      const machine = makeFakeMachine("alphaloop-daemons-egress-optin-");
      runSystemDaemons({
        ...machine,
        env: { ...machine.env, OPENCLAW_PROXY_LABELS: "com.openclaw.trading.cron-runner", OPENCLAW_PROXY_URL: "http://127.0.0.1:1080" }
      });

      const runner = join(machine.systemDir, "com.openclaw.trading.cron-runner.plist");
      expect(plistValue(runner, "EnvironmentVariables.HTTPS_PROXY")).toBe("http://127.0.0.1:1080");
      // ...and opting one in does not opt everything else in.
      expect(hasProxyEnv(join(machine.systemDir, "ai.openclaw.system.gateway.plist"))).toBe(false);
      expect(hasProxyEnv(join(machine.systemDir, "com.alphaloop.daily-backup.plist"))).toBe(false);
    });
  });

  // Round-4 findings C2/C3. This installer is about to be run with sudo on the
  // machine that also hosts the operator's personal 185-agent OpenClaw, and
  // both defects turned a single failed launchctl call into a machine running
  // NEITHER the old copy nor the new one, un-recoverable by re-running.
  //
  // Measured against the pre-fix script with the same stub used below
  // (bootstrap fails on com.alphaloop.market-alerts, the third label of eight
  // in sorted order): the run exited 5, ~/Library/LaunchAgents was empty of
  // every AlphaLoop label because the retire loop had already MOVED all seven,
  // and only two daemons were loaded.
  describe("a partial failure is survivable (round-4 findings C2/C3)", () => {
    const MIGRATED_AGENTS = [
      "com.alphaloop.daily-backup",
      "com.alphaloop.market-alerts",
      "com.alphaloop.platform-app",
      "com.openclaw.trading.cron-runner",
      "com.openclaw.trading.official-paper.pnl",
      "com.openclaw.trading.official-paper.poll",
      "com.openclaw.trading.broker-executor"
    ];

    it("keeps the other seven daemons up when one cannot bootstrap, instead of aborting the loop", () => {
      const machine = makeFakeMachine("alphaloop-daemons-c2-", { failBootstrapLabel: "com.alphaloop.market-alerts" });
      seedLegacyUserAgents(machine, MIGRATED_AGENTS);

      const { status } = runSystemDaemonsExpectingFailure(machine);

      // Non-zero, because something really did fail - `|| true` would have
      // turned "broken" into "silently broken".
      expect(status).not.toBe(0);
      // ...but the other seven are LOADED, not merely present as plist files.
      expect(loadedSystemLabels(machine)).toEqual(SYSTEM_LABELS.filter((l) => l !== "com.alphaloop.market-alerts").sort());
      expect(launchDaemonLabels(machine).sort()).toEqual([...SYSTEM_LABELS].sort());
    });

    it("leaves the failed label's user LaunchAgent on disk, so that service keeps running the old copy", () => {
      const machine = makeFakeMachine("alphaloop-daemons-c2-keep-", { failBootstrapLabel: "com.alphaloop.market-alerts" });
      seedLegacyUserAgents(machine, MIGRATED_AGENTS);
      seedLegacyUserAgents(machine, ["com.qingverse.openclaw.auto-update"]);

      runSystemDaemonsExpectingFailure(machine);

      // The one label whose replacement is down keeps its agent - launchd
      // re-bootstraps it at the next login, so the machine is not left with
      // nothing running that service. Every label whose daemon IS up is
      // archived as usual: this is per-label, not all-or-nothing.
      expect(launchAgentLabels(machine)).toEqual([
        "com.alphaloop.market-alerts",
        "com.qingverse.openclaw.auto-update"
      ]);
    });

    it("tells the operator which label failed, why, and that a re-run is safe", () => {
      const machine = makeFakeMachine("alphaloop-daemons-c2-report-", { failBootstrapLabel: "com.alphaloop.platform-app" });
      seedLegacyUserAgents(machine, MIGRATED_AGENTS);

      const { output } = runSystemDaemonsExpectingFailure(machine);

      expect(output).toContain("com.alphaloop.platform-app");
      expect(output).toContain("Bootstrap failed: 5: Input/output error");
      // Names how many are up, so "it failed" is never read as "nothing runs".
      expect(output).toMatch(/7 of 8 ARE running/u);
      // Round-5 D1/D4: the failed service's own fallback is put back, and the
      // operator is told not to reach for the installer that used to delete it.
      expect(output).toMatch(/DO NOT run 'pnpm launchd:install-user' as a workaround/u);
      expect(output).toMatch(/re-run converges rather than repeating/u);
      // The failure summary must not claim the label came up.
      expect(output).toMatch(/com\.alphaloop\.platform-app {2}egress=direct {2}NOT RUNNING/u);
    });

    it("converges when the operator fixes the cause and re-runs", () => {
      const failing = makeFakeMachine("alphaloop-daemons-c2-converge-", { failBootstrapLabel: "com.alphaloop.market-alerts" });
      seedLegacyUserAgents(failing, MIGRATED_AGENTS);
      runSystemDaemonsExpectingFailure(failing);
      // The state a re-run has to converge FROM: seven daemons up, one down,
      // one agent still on disk. An installer that aborted the loop would
      // leave a different, much emptier machine here.
      expect(loadedSystemLabels(failing)).toHaveLength(SYSTEM_LABELS.length - 1);
      expect(launchAgentLabels(failing)).toEqual(["com.alphaloop.market-alerts"]);

      // "Fix the cause" = the same machine, same job table, same half-migrated
      // ~/Library/LaunchAgents, with a launchctl that no longer fails. Nothing
      // else is reset, which is the point: the previous run must not have left
      // state that blocks this one.
      writeLaunchctlStub(join(failing.stubBinDir, "launchctl"), failing.launchctlLog, { stateDir: failing.stateDir });

      const stdout = runSystemDaemons(failing);
      expect(stdout).toContain("com.alphaloop.market-alerts");
      expect(loadedSystemLabels(failing)).toEqual([...SYSTEM_LABELS].sort());
      expect(launchAgentLabels(failing)).toEqual([]);
    });

    it("clears a label out of launchd's disabled database BEFORE bootstrapping it", () => {
      // launchd's disabled-services database survives reboots AND plist
      // reinstalls, and bootstrap/kickstart on a disabled label fail. With the
      // old bootstrap -> enable -> kickstart order the run aborted before ever
      // reaching the `enable` that would have cleared it, so every re-run
      // failed identically forever. This script creates that state itself: it
      // runs `launchctl disable system/<label>` on every obsolete label.
      const machine = makeFakeMachine("alphaloop-daemons-c3-", { disabledLabels: ["com.alphaloop.daily-backup"] });
      seedLegacyUserAgents(machine, MIGRATED_AGENTS);

      const stdout = runSystemDaemons(machine);

      expect(loadedSystemLabels(machine)).toEqual([...SYSTEM_LABELS].sort());
      expect(stdout).toContain("com.alphaloop.daily-backup  egress=direct  running");

      // The ordering itself, not just the outcome: enable must precede
      // bootstrap for the label, or the disabled entry is still there when
      // bootstrap runs.
      const calls = readFileSync(machine.launchctlLog, "utf8").split(/\n/u);
      const enableAt = calls.findIndex((line) => line === "enable system/com.alphaloop.daily-backup");
      const bootstrapAt = calls.findIndex((line) => line.startsWith("bootstrap system ") && line.endsWith("com.alphaloop.daily-backup.plist"));
      expect(enableAt).toBeGreaterThan(-1);
      expect(bootstrapAt).toBeGreaterThan(-1);
      expect(enableAt).toBeLessThan(bootstrapAt);
    });

    it("refuses up front when a rendered daemon collides with a label the retire step destroys", () => {
      // The retire step runs `launchctl disable system/<label>` and `rm -f
      // <SYSTEM_DIR>/<label>.plist` on every obsolete label. A future rename
      // onto one of those labels would delete the plist this run just wrote
      // and leave the label disabled - wedged on this run and every re-run.
      // A collision is unreachable through the manifest (the drift check
      // refuses first), so the obsolete list is overridden here the same way
      // SYSTEM_DIR and LAUNCHCTL are; the guard under test is the script's.
      const machine = makeFakeMachine("alphaloop-daemons-c3-collision-");
      const { status, output } = runSystemDaemonsExpectingFailure({
        ...machine,
        env: { ...machine.env, OBSOLETE_SYSTEM_LABELS: "com.alphaloop.market-alerts" }
      });

      expect(status).not.toBe(0);
      expect(output).toMatch(/com\.alphaloop\.market-alerts is BOTH rendered as a daemon above and listed as obsolete/u);
      // Refused BEFORE writing or loading anything.
      expect(launchDaemonLabels(machine)).toEqual([]);
      expect(loadedSystemLabels(machine)).toEqual([]);
    });
  });

  // Round-4 finding M7.
  describe("backup directory hygiene (round-4 finding M7)", () => {
    it("creates no backup directory at all on a machine with nothing to retire", () => {
      const machine = makeFakeMachine("alphaloop-daemons-m7-empty-");
      runSystemDaemons(machine);
      // BACKUP_DIR used to be `mkdir -p`'d unconditionally, before knowing
      // whether anything would be archived - so every run after the migration
      // left one more empty openclaw-system-backup-<ts> behind forever.
      expect(backupDirs(machine)).toEqual([]);
      expect(runSystemDaemons(machine)).toContain("Installed system daemons");
      expect(backupDirs(machine)).toEqual([]);
    });

    it("creates exactly one, non-empty, on the migration run and none on the runs after it", () => {
      const machine = makeFakeMachine("alphaloop-daemons-m7-migrate-");
      seedLegacyUserAgents(machine, ["com.alphaloop.market-alerts", "com.openclaw.trading.broker-executor"]);

      runSystemDaemons(machine);
      const dirs = backupDirs(machine);
      expect(dirs).toHaveLength(1);
      expect(readdirSync(join(machine.home, "Library", "LaunchAgents.disabled", String(dirs[0]))).sort()).toEqual([
        "com.alphaloop.market-alerts.plist",
        "com.openclaw.trading.broker-executor.plist"
      ]);

      runSystemDaemons(machine);
      runSystemDaemons(machine);
      expect(backupDirs(machine)).toEqual(dirs);
    });
  });

  it("refuses to touch LaunchDaemons when the rendered daemons and the manifest disagree", () => {
    const machine = makeFakeMachine("alphaloop-daemons-drift-");
    const driftedManifest = join(machine.home, "ownership.txt");
    writeFileSync(driftedManifest, "system ai.openclaw.system.gateway\nuser com.alphaloop.rsshub\n");

    expect(() =>
      execFileSync("bash", [systemDaemonsScript], {
        env: { ...machine.env, OWNERSHIP_FILE: driftedManifest },
        encoding: "utf8",
        stdio: "pipe"
      })
    ).toThrow(/do not match the 'system' rows/u);
    expect(launchDaemonLabels(machine)).toEqual([]);
  });
});

describe("one owner per launchd label across ALL four installers (Task 9)", () => {
  // The defect this guards is not "installer X writes the wrong path" but
  // "installer X and installer Y both write the same label to different
  // domains". No single installer's suite can see that, so this one runs the
  // real binaries of all four - in both orders, because the dangerous order is
  // the one where a user-level installer runs AFTER the daemons are up.
  // Round-5 D1: the two node installers now exit 1 when they deliberately KEEP
  // a user-level agent whose replacement daemon is down (the "user installers
  // run first" order below is exactly that state). The exit code is the point
  // of that change, so it is recorded rather than allowed to abort the test.
  function runUserSideInstallers(machine: FakeMachine): number[] {
    execFileSync("zsh", [scriptPath], { env: machine.env, encoding: "utf8" });
    return [userSchedulesScript, cronInstallScript].map((script) => {
      try {
        execFileSync(process.execPath, [script], { env: machine.env, encoding: "utf8", stdio: "pipe" });
        return 0;
      } catch (error) {
        const failure = error as { status?: number };
        if (typeof failure.status !== "number") {
          throw error;
        }
        return failure.status;
      }
    });
  }

  function expectSingleOwner(machine: FakeMachine): void {
    const agents = new Set(launchAgentLabels(machine));
    const daemons = new Set(launchDaemonLabels(machine));

    for (const label of SYSTEM_LABELS) {
      expect(daemons.has(label)).toBe(true);
      expect(agents.has(label)).toBe(false);
    }
    for (const label of USER_LABELS) {
      expect(agents.has(label)).toBe(true);
      expect(daemons.has(label)).toBe(false);
    }
    for (const label of RETIRED_LABELS) {
      expect(agents.has(label)).toBe(false);
      expect(daemons.has(label)).toBe(false);
    }
    // Nothing is in both places, for any label at all.
    expect([...agents].filter((label) => daemons.has(label))).toEqual([]);
  }

  it("holds when the user-level installers run first and the daemons last", () => {
    const machine = makeFakeMachine("alphaloop-order-user-first-");
    seedRunningUserAgents(machine, [...SYSTEM_LABELS, ...RETIRED_LABELS]);

    const exits = runUserSideInstallers(machine);

    // Round-5 D1: run in THIS order, no daemon exists yet, so the user-level
    // copies are what the machine is running. Both installers must refuse to
    // remove them - and say so with a non-zero exit - rather than leaving the
    // machine running nothing until step 3 gets its turn.
    expect(exits).toEqual([1, 1]);
    // Every system/retired agent is still there (nothing was destroyed), plus
    // the one label install-launchd.sh legitimately installs in this step.
    expect(new Set(launchAgentLabels(machine))).toEqual(new Set([...SYSTEM_LABELS, ...RETIRED_LABELS, ...USER_LABELS]));

    runSystemDaemons(machine);
    expectSingleOwner(machine);
  });

  it("holds when the daemons go in first and the user-level installers are re-run afterwards", () => {
    const machine = makeFakeMachine("alphaloop-order-daemons-first-");
    seedLegacyUserAgents(machine, [...SYSTEM_LABELS, ...RETIRED_LABELS]);
    runSystemDaemons(machine);
    runUserSideInstallers(machine);
    expectSingleOwner(machine);
  });

  // ---------------------------------------------------------------------
  // Round-5 finding D1, the defect this whole round was restructured around.
  // Everything above runs the four installers on a machine where every daemon
  // bootstraps fine - which is why nothing here noticed that the runbook's
  // step 4 deleted, unrecoverably, the fallback step 3 had just preserved.
  // ---------------------------------------------------------------------
  describe("a fallback that step 3 kept survives steps 4 and 5", () => {
    const DOWN = "com.alphaloop.market-alerts";

    function halfMigratedMachine(prefix: string): FakeMachine {
      const machine = makeFakeMachine(prefix, { failBootstrapLabel: DOWN });
      seedRunningUserAgents(machine, [...SYSTEM_LABELS, ...RETIRED_LABELS]);
      const { status } = runSystemDaemonsExpectingFailure(machine);
      expect(status).not.toBe(0);
      // Precondition: step 3 kept exactly the failed service's agent.
      expect(launchAgentLabels(machine)).toEqual([DOWN]);
      return machine;
    }

    it("pnpm launchd:install-user leaves it alone and exits non-zero", () => {
      const machine = halfMigratedMachine("alphaloop-d1-step4-");

      let status = 0;
      try {
        execFileSync(process.execPath, [userSchedulesScript], { env: machine.env, encoding: "utf8", stdio: "pipe" });
      } catch (error) {
        status = (error as { status?: number }).status ?? -1;
      }

      // This is the assertion that fails against the pre-round-5 installer:
      // it removed the plist with rmSync and exited 0.
      expect(launchAgentLabels(machine)).toEqual([DOWN]);
      expect(status).toBe(1);
    });

    it("pnpm openclaw:cron:install leaves it alone too, and still installs its cron jobs", () => {
      const machine = halfMigratedMachine("alphaloop-d1-step5-");

      let status = 0;
      try {
        execFileSync(process.execPath, [cronInstallScript], { env: machine.env, encoding: "utf8", stdio: "pipe" });
      } catch (error) {
        status = (error as { status?: number }).status ?? -1;
      }

      expect(launchAgentLabels(machine)).toEqual([DOWN]);
      expect(status).toBe(1);
      // The cron half of that installer is unaffected by the retire half.
      expect(readFileSync(machine.openclawLog, "utf8")).toContain("cron add");
    });

    it("retires it normally once the daemon is fixed and step 3 re-run", () => {
      const machine = halfMigratedMachine("alphaloop-d1-converge-");
      writeLaunchctlStub(join(machine.stubBinDir, "launchctl"), machine.launchctlLog, { stateDir: machine.stateDir });

      runSystemDaemons(machine);
      execFileSync(process.execPath, [userSchedulesScript], { env: machine.env, encoding: "utf8" });

      expect(launchAgentLabels(machine)).toEqual([]);
      expect(loadedSystemLabels(machine)).toEqual([...SYSTEM_LABELS].sort());
      // Archived, not deleted - and in the SAME place install-system-daemons.sh
      // uses, so there is one directory to look in.
      expect(archivedLabels(machine)).toContain(DOWN);
    });

    it("puts the stopped user agent back rather than waiting for the next login", () => {
      const machine = makeFakeMachine("alphaloop-d1-restore-", {
        failBootstrapLabel: DOWN,
        failBootstrapDomain: "system"
      });
      seedRunningUserAgents(machine, [...SYSTEM_LABELS, ...RETIRED_LABELS]);

      const { output } = runSystemDaemonsExpectingFailure(machine);

      // Round-5 D4: the old code stopped the agent in phase A and, on failure,
      // told the operator it would come back "at the next login" - which on a
      // headless machine after a reboot is never.
      expect(output).toMatch(/running again from/u);
      expect(loadedUserLabels(machine)).toContain(DOWN);
    });

    it("never deletes a plist it cannot archive", () => {
      const machine = makeFakeMachine("alphaloop-d1-archive-ro-");
      seedRunningUserAgents(machine, SYSTEM_LABELS);
      const archiveParent = join(machine.home, "Library", "LaunchAgents.disabled");
      mkdirSync(archiveParent, { recursive: true });
      chmodSync(archiveParent, 0o500);

      const { status, output } = runSystemDaemonsExpectingFailure(machine);
      let userStatus = 0;
      try {
        execFileSync(process.execPath, [userSchedulesScript], { env: machine.env, encoding: "utf8", stdio: "pipe" });
      } catch (error) {
        userStatus = (error as { status?: number }).status ?? -1;
      }
      chmodSync(archiveParent, 0o700);

      expect(status).toBe(1);
      expect(userStatus).toBe(1);
      expect(output).toMatch(/could not be archived/u);
      // Every daemon is up, but nothing was thrown away to get there.
      expect(loadedSystemLabels(machine)).toEqual([...SYSTEM_LABELS].sort());
      expect(launchAgentLabels(machine).sort()).toEqual([...SYSTEM_LABELS].sort());
    });
  });

  it("still stops and archives a retired label that no daemon replaces", () => {
    // The per-service loop only reaches a user label through the daemon that
    // supersedes it, so a future `retired` row with no replacement could have
    // fallen through it silently. It is handled by its own pass - which needs
    // a manifest to exercise, since today's only retired row does map to a
    // daemon. Same override seam as OBSOLETE_SYSTEM_LABELS / SYSTEM_DIR.
    const machine = makeFakeMachine("alphaloop-orphan-retired-");
    const orphan = "com.openclaw.trading.legacy-orphan";
    const manifest = join(machine.home, "ownership-with-orphan.txt");
    writeFileSync(
      manifest,
      `${readFileSync(fileURLToPath(new URL("./install-launchd-ownership.txt", import.meta.url)), "utf8")}\nretired  ${orphan}\n`
    );
    seedRunningUserAgents(machine, [orphan]);

    execFileSync("bash", [systemDaemonsScript], {
      env: { ...machine.env, OWNERSHIP_FILE: manifest },
      encoding: "utf8"
    });

    expect(launchAgentLabels(machine)).toEqual([]);
    expect(archivedLabels(machine)).toEqual([orphan]);
    expect(loadedUserLabels(machine)).toEqual([]);
  });

  it("agrees with the node installers about which daemon replaces which user label", () => {
    // install-system-daemons.sh archives a plist on the strength of a daemon
    // being up; the node installers refuse to touch that same plist while it is
    // down. If the two disagreed about WHICH daemon that is, one of them would
    // act on the wrong answer - so the shell case statement and the node map
    // are compared directly rather than trusted to stay in sync.
    const shell = readFileSync(systemDaemonsScript, "utf8");
    for (const [userLabel, daemon] of Object.entries(SYSTEM_DAEMON_SUPERSEDING)) {
      expect(shell).toMatch(new RegExp(`${userLabel.replace(/\./gu, "\\.")}\\) printf "%s" "${daemon.replace(/\./gu, "\\.")}"`, "u"));
      // ...and the inverse table the per-service loop iterates.
      expect(shell).toMatch(new RegExp(`${daemon.replace(/\./gu, "\\.")}\\) printf "%s\\\\n%s\\\\n" "\\$1" "${userLabel.replace(/\./gu, "\\.")}"`, "u"));
    }
  });

  it("leaves the operator's unrelated personal OpenClaw agents untouched", () => {
    const machine = makeFakeMachine("alphaloop-foreign-labels-");
    const foreign = [
      "com.qingverse.openclaw.auto-update",
      "com.xhs.openclaw-safe-cleanup",
      "com.kb.xiaohongshu-mcp",
      "pm2.qingchang",
      "homebrew.mxcl.colima"
    ];
    seedLegacyUserAgents(machine, foreign);
    runSystemDaemons(machine);
    runUserSideInstallers(machine);
    for (const label of foreign) {
      expect(existsSync(join(machine.agentsDir, `${label}.plist`))).toBe(true);
    }
    expect(readFileSync(machine.launchctlLog, "utf8")).not.toContain("com.qingverse.");
  });
});

// ===========================================================================
// Round 6 (2026-07-29): FAILURE MUST BECOME A RED LIGHT.
//
// Round 5 confirmed five criticals that were all one shape - something in the
// deploy path failed, said so, exited non-zero, and the acceptance gate still
// answered ok=true / exit 0. The suites below inject each of those failures
// into the REAL scripts and assert on the two things a controller actually
// reads: the installer's exit code, and the gate's verdict computed from what
// that installer left behind.
//
// Nothing here mocks the analyzer. `analyzeOpenClawRuntimeSnapshot` is given a
// snapshot whose `runtimeRoot` is the sandbox machine's own runtime tree, so it
// reads the deploy receipts the real installer really wrote.
// ===========================================================================
describe("round 6: a deploy-path failure cannot end in a green gate", () => {
  /** The gate's answer for a machine, from the receipts the installers left. */
  async function gateVerdict(machine: FakeMachine, extra: Record<string, unknown> = {}) {
    // A baseline where everything OUTSIDE the deploy path is healthy, so that
    // `ok === false` in a scenario below can only be the injected failure.
    // The two listener counts and the persona file are the checks that would
    // otherwise fail on any sandbox; the loopback probes are left to fail,
    // which on a machine holding none of these labels is a warn by design.
    const personaPath = join(machine.home, "control-AGENTS.md");
    if (!existsSync(personaPath)) {
      writeFileSync(personaPath, "# 控制人设（沙箱占位）\n");
    }
    return doctor.analyzeOpenClawRuntimeSnapshot({
      runtimeRoot: join(machine.home, "runtime"),
      gatewayListeners: [{ command: "node", pid: 4001 }],
      cronRunnerListeners: [{ command: "node", pid: 4002 }],
      controlWorkspaceAgentsPath: personaPath,
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1 (sandbox: no such service here)");
      },
      launchdJobs: [],
      launchdPlists: { system: launchDaemonLabels(machine), user: launchAgentLabels(machine) },
      ...extra
    });
  }

  function codesOf(analysis: { findings: Array<{ code: string; severity: string }> }, severity?: string): string[] {
    return analysis.findings.filter((f) => !severity || f.severity === severity).map((f) => f.code);
  }

  it("S3e: a daemon that bootstraps and is DEAD ON ARRIVAL fails the install and keeps its fallback", () => {
    // The exact measured shape: `bootstrap` succeeds, `launchctl print` exits 0
    // (so the pre-round-6 check passed), and the job reports state = not
    // running with a non-zero last exit. Three labels, one resident and one
    // periodic, because the residency contract judges them differently.
    const machine = makeFakeMachine("alphaloop-r6-doa-", {
      deadOnArrivalLabels: [
        "com.alphaloop.platform-app",
        "com.openclaw.system.trading.broker-executor",
        "com.alphaloop.market-alerts"
      ]
    });
    seedRunningUserAgents(machine, ["com.alphaloop.platform-app", "com.alphaloop.market-alerts"]);

    const { status, output } = runSystemDaemonsExpectingFailure(machine);

    expect(status).toBe(1);
    expect(output).toMatch(/FAILED - 3 of 8 daemons did not come up/u);
    expect(output).toMatch(/com\.alphaloop\.platform-app: bootstrapped but NOT RUNNING/u);
    expect(output).toMatch(/com\.alphaloop\.market-alerts: its first run under launchd failed/u);
    expect(output).toMatch(/last exit code = 1/u);
    // The whole point: their fallbacks are NOT archived, and the run does not
    // print them as installed.
    expect(launchAgentLabels(machine)).toEqual(
      expect.arrayContaining(["com.alphaloop.market-alerts", "com.alphaloop.platform-app"])
    );
    expect(output).toMatch(/com\.alphaloop\.platform-app {2}egress=direct {2}NOT RUNNING/u);
    // ...and the five healthy ones still went in: per-label, not all-or-nothing.
    expect(output).toMatch(/com\.alphaloop\.daily-backup {2}egress=direct {2}running/u);
  });

  it("S3f: a user agent that survives bootout stops that service's handover instead of racing it", () => {
    const machine = makeFakeMachine("alphaloop-r6-sticky-", {
      surviveBootoutLabels: ["com.alphaloop.platform-app"]
    });
    seedRunningUserAgents(machine, ["com.alphaloop.platform-app"]);

    const { status, output } = runSystemDaemonsExpectingFailure(machine);

    expect(status).toBe(1);
    // Task 28 put a real deadline on the re-check, so the message now names it:
    // this label was polled for the whole BOOTOUT_SETTLE_SECONDS window (1s in
    // this harness) and never left the job table - a wedge, not a drain.
    expect(output).toMatch(/is STILL loaded \d+s after bootout/u);
    expect(output).toMatch(/refusing to bootstrap the daemon because both copies would then run/u);
    // The daemon was never bootstrapped, so the machine keeps exactly one copy
    // of platform-app running - the old one.
    expect(loadedSystemLabels(machine)).not.toContain("com.alphaloop.platform-app");
    expect(loadedUserLabels(machine)).toContain("com.alphaloop.platform-app");
    expect(existsSync(join(machine.agentsDir, "com.alphaloop.platform-app.plist"))).toBe(true);
  });

  it("task 28: a freshly-started user agent whose bootout DRAINS is waited for - the handover converges on the first try", () => {
    // The live failure (mini, 2026-07-29, reproduced twice): deploy.sh step 2
    // had started gui/501/ai.openclaw.gateway seconds earlier via `openclaw
    // gateway install`; step 3's bootout returned while launchd was still
    // draining the process, the immediate re-check read "STILL loaded", and
    // the whole run exited 1 - platform-app and cron-runner failed the same
    // way in the same run. Fifteen minutes later a resume from step 3 passed,
    // because the drains had finished in the background.
    //
    // The stub's timing is the measured one (see bootoutDrainSeconds): bootout
    // returns 0 immediately, `print` keeps answering for the drain window,
    // and nothing restarts the job - so the ONLY correct installer behaviour
    // is to wait the drain out, and the only wrong ones are the old immediate
    // re-check (fails healthy machines) and waiting forever (never fails
    // wedged ones). S3f above pins the second half; this pins the first.
    const machine = makeFakeMachine("alphaloop-t28-drain-", {
      bootoutDrainSeconds: 1,
      bootoutDrainRecentWindowSeconds: 3600
    });
    machine.env.BOOTOUT_SETTLE_SECONDS = "6";
    seedRunningUserAgents(machine, [
      "ai.openclaw.gateway",
      "com.alphaloop.platform-app",
      "com.openclaw.trading.cron-runner"
    ]);

    const output = runSystemDaemons(machine);

    expect(output).not.toMatch(/STILL loaded/u);
    expect(loadedSystemLabels(machine)).toEqual([...SYSTEM_LABELS].sort());
    expect(loadedUserLabels(machine)).toEqual([]);
    expect(archivedLabels(machine)).toEqual(
      expect.arrayContaining(["ai.openclaw.gateway", "com.alphaloop.platform-app", "com.openclaw.trading.cron-runner"])
    );
  }, 30_000);

  it("S3d: an unwritable archive leaves plists on disk, and the gate now calls that out", async () => {
    const machine = makeFakeMachine("alphaloop-r6-archive-");
    seedRunningUserAgents(machine, ["com.alphaloop.market-alerts", "com.alphaloop.daily-backup"]);
    // The mini's real shape: ~/Library/LaunchAgents.disabled exists but cannot
    // be written by this user (left root-owned by a pre-M7 sudo run). A
    // read-only directory reproduces that without needing root here.
    const disabled = join(machine.home, "Library", "LaunchAgents.disabled");
    mkdirSync(disabled, { recursive: true });
    chmodSync(disabled, 0o555);
    try {
      const { status, output } = runSystemDaemonsExpectingFailure(machine);
      expect(status).toBe(1);
      expect(output).toMatch(/could not be archived/u);
      expect(launchAgentLabels(machine)).toEqual(
        expect.arrayContaining(["com.alphaloop.daily-backup", "com.alphaloop.market-alerts"])
      );

      // Pre-round-6 this is where the gate said "fine": the agents are booted
      // out, so nothing is loaded twice RIGHT NOW - the double ownership only
      // materialises at the next login. The check therefore looks at the disk.
      const analysis = await gateVerdict(machine);
      expect(analysis.ok).toBe(false);
      expect(codesOf(analysis, "error")).toContain("launchd-plists.stray_user_copy");
      expect(analysis.findings.find((f) => f.code === "launchd-plists.stray_user_copy")?.message)
        .toMatch(/下次登录时 launchd 会把它们全部 bootstrap 起来/u);
    } finally {
      chmodSync(disabled, 0o755);
    }
  });

  it("S3g: `openclaw cron add` failing installs zero jobs, says so, and leaves a failed receipt", async () => {
    const machine = makeFakeMachine("alphaloop-r6-cron-");
    // A gateway that is not answering, which is what the real failure looks
    // like: the CLI's own GatewayTransportError on every call.
    writeFileSync(
      join(machine.stubBinDir, "openclaw"),
      `#!/bin/sh\necho "$@" >> "${machine.openclawLog}"\n`
        + 'if [ "$1" = "gateway" ]; then exit 0; fi\n'
        + 'echo "GatewayTransportError: connect ECONNREFUSED 127.0.0.1:18789" >&2\nexit 1\n'
    );
    chmodSync(join(machine.stubBinDir, "openclaw"), 0o755);

    let status = 0;
    let output = "";
    try {
      output = execFileSync(process.execPath, [cronInstallScript], {
        env: { ...machine.env, OPENCLAW_CRON_RETRY_BASE_MS: "1" },
        encoding: "utf8",
        stdio: "pipe"
      });
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      status = failure.status ?? 0;
      output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
    }

    expect(status).toBe(1);
    // Not a raw stack trace: it used to die on the FIRST job with an uncaught
    // exception, so the operator never learned how many of the five existed.
    expect(output).not.toMatch(/at execOpenClaw|node:internal/u);
    expect(output).toMatch(/FAILED —— 5\/5 个报告类 cron 任务没有装上/u);
    expect(output).toMatch(/日报、周报、个股分析在这台机器上【完全不会触发】/u);
    expect(output).toMatch(/GatewayTransportError/u);

    // And the gate can see it minutes later, which is what nothing could before.
    const analysis = await gateVerdict(machine);
    expect(analysis.ok).toBe(false);
    expect(codesOf(analysis, "error")).toContain("deploy-ledger.step_5_failed");
  });

  // Round-7 finding K1, the cron half: this installer called recordDeployStep
  // and ignored its `{written:false, error}` return entirely.
  it("K1: the cron installer says so, and exits 4, when its receipt cannot be written", () => {
    const machine = makeFakeMachine("alphaloop-r7-cron-ledger-");
    const ledgerDir = join(machine.home, "runtime", "deploy");
    mkdirSync(ledgerDir, { recursive: true });
    const ledgerPath = join(ledgerDir, "steps.jsonl");
    writeFileSync(ledgerPath, `${JSON.stringify({ attempt: "yesterday", step: 5, exitCode: 0 })}\n`);
    chmodSync(ledgerPath, 0o444);

    let status = 0;
    let output = "";
    try {
      output = execFileSync(process.execPath, [cronInstallScript], {
        env: { ...machine.env, OPENCLAW_CRON_RETRY_BASE_MS: "1" },
        encoding: "utf8",
        stdio: "pipe"
      });
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      status = failure.status ?? 0;
      output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
    } finally {
      chmodSync(ledgerPath, 0o644);
    }

    // The cron jobs themselves installed fine against the stub gateway - this
    // 4 is only about the receipt, and that is the point of it not being 1.
    expect(status).toBe(4);
    expect(output).toMatch(/这一步的收据没能写进/u);
    expect(output).toMatch(/验收门看到的第 5 步记录还是【上一次部署】那条/u);
  });

  it("S3a: labels installed NOWHERE fail the gate on a machine that has deployed", async () => {
    const machine = makeFakeMachine("alphaloop-r6-nowhere-");
    // The footprint: plists on disk, nothing loaded. That is what a machine
    // looks like right after an installer failed - and it used to be a warn.
    const analysis = await gateVerdict(machine, {
      launchdJobs: SYSTEM_LABELS.map((label) => ({ label, expectedDomain: "system", loadedDomains: [], state: null })),
      launchdPlists: { system: [...SYSTEM_LABELS], user: [] }
    });

    expect(analysis.ok).toBe(false);
    const notLoaded = analysis.findings.filter((f) => f.code.endsWith(".not_loaded"));
    expect(notLoaded.length).toBe(SYSTEM_LABELS.length);
    expect(notLoaded.every((f) => f.severity === "error")).toBe(true);
    expect(notLoaded[0]?.message).toMatch(/这台机器已经部署过/u);
  });

  it("S3a: the same labels on a machine with NO deploy footprint stay a warning", async () => {
    const machine = makeFakeMachine("alphaloop-r6-devbox-");
    const analysis = await gateVerdict(machine, {
      launchdJobs: SYSTEM_LABELS.map((label) => ({ label, expectedDomain: "system", loadedDomains: [], state: null })),
      launchdPlists: { system: [], user: [] }
    });

    const notLoaded = analysis.findings.filter((f) => f.code.endsWith(".not_loaded"));
    expect(notLoaded.length).toBe(SYSTEM_LABELS.length);
    expect(notLoaded.every((f) => f.severity === "warn")).toBe(true);
    // A developer's laptop must still pass: this is the reason the old check
    // was a warn, and it is preserved rather than traded away.
    expect(analysis.ok).toBe(true);
  });

  // Round-7 finding K1, the sudo half. install-system-daemons.sh is the one
  // step an operator legitimately runs by hand, and it is the step most likely
  // to leave the ledger root-owned in the first place; its receipt call had the
  // same `>/dev/null 2>&1 || true` shape as deploy.sh's.
  it("K1: an install whose receipt cannot be written does not get to exit 0", () => {
    const machine = makeFakeMachine("alphaloop-r7-daemon-ledger-");
    const ledgerDir = join(machine.home, "runtime", "deploy");
    mkdirSync(ledgerDir, { recursive: true });
    const ledgerPath = join(ledgerDir, "steps.jsonl");
    // What one earlier sudo run leaves behind: a previous, entirely successful
    // step-3 receipt in a file this user can no longer append to.
    writeFileSync(ledgerPath, `${JSON.stringify({
      attempt: "yesterday",
      step: 3,
      key: "install-system-daemons",
      exitCode: 0,
      head: "14b1202",
      finishedAt: "2026-07-28T01:00:00.000Z"
    })}\n`);
    chmodSync(ledgerPath, 0o444);

    try {
      const { status, output } = runSystemDaemonsExpectingFailure(machine);

      expect(status).toBe(4);
      expect(output).toMatch(/could NOT write this run's deploy receipt/u);
      expect(output).toMatch(/judge this machine on the PREVIOUS/u);
      // Yesterday's green row is untouched, which is exactly why exiting 0 here
      // would have been indistinguishable from a successful install.
      expect(readFileSync(ledgerPath, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      chmodSync(ledgerPath, 0o644);
    }
  });
});

// ===========================================================================
// Round 6, finding S3b: THE RUNBOOK IS NOW A PROGRAM (deploy.sh).
//
// README's steps 0-8 were a plain command sequence - no `&&`, no `set -e`, no
// guard. Measured against the pre-round-6 runbook: making step 0 fail let steps
// 1-8 run to completion against the OLD checkout and finish green. These cases
// run the REAL deploy.sh with a failure injected at one step and assert the two
// properties that were missing: NOTHING after the failed step runs, and the
// gate can still see the failure afterwards.
//
// Every command deploy.sh invokes is stubbed EXCEPT the ledger writer, which is
// the real node running the real deploy-ledger.mjs - the receipts these tests
// read back are the ones production would write.
// ===========================================================================
describe("round 6: deploy.sh stops at the first failed step", () => {
  const deployScript = fileURLToPath(new URL("./deploy.sh", import.meta.url));

  interface Runbook {
    root: string;
    runtimeRoot: string;
    callLog: string;
    env: NodeJS.ProcessEnv;
  }

  function makeRunbook(prefix: string, failures: Record<string, string> = {}): Runbook {
    const root = makeTempDir(prefix);
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const callLog = join(root, "calls.log");
    // Round-7 finding K9: the script now refuses to touch the machine at all
    // when the two variables that decide where a public report card lands are
    // unset, so every case that is NOT about that refusal starts from a
    // configured sandbox. Quoted on purpose - the parser has to strip them, the
    // same way loadLocalEnv does.
    writeFileSync(
      join(root, ".env.local"),
      "# sandbox\nFEISHU_GROUP_CHAT_ID=oc_sandbox_group\nPLATFORM_PUBLIC_BASE_URL=\"https://alphaloop.invalid\"\n"
    );

    // Each stub logs what it was asked to do and honours one injection env
    // var. `$1` is enough to identify the subcommand for all of them.
    //
    // Round 8 adds `block()`: a stub can be made to sit inside a step until the
    // test releases it, which is the only way to deliver a signal while a step
    // is genuinely in flight rather than racing the script's start-up.
    const stub = (name: string, body: string) => {
      writeFileSync(join(binDir, name), [
        "#!/bin/sh",
        `echo "${name} $@" >> "${callLog}"`,
        'block() { touch "$BLOCK_READY"; while [ ! -f "$BLOCK_RELEASE" ]; do sleep 0.05; done; }',
        body,
        "exit 0"
      ].join("\n") + "\n");
      chmodSync(join(binDir, name), 0o755);
    };

    stub("git", [
      'if [ "$1" = "-C" ]; then shift 2; fi',
      'case "$1" in',
      '  status) [ "$FAIL_GIT_DIRTY" = "1" ] && echo " M README.md"; exit 0 ;;',
      '  pull) [ "$BLOCK_ON" = "git pull" ] && block',
      '        if [ "$FAIL_GIT_PULL" = "1" ]; then echo "error: Your local changes would be overwritten" >&2; exit 1; fi; echo "Already up to date." ;;',
      '  rev-parse) echo "cafe123" ;;',
      "esac"
    ].join("\n"));
    stub("pnpm", [
      '[ "$BLOCK_ON" = "pnpm $1" ] && block',
      'if [ "$FAIL_PNPM_SCRIPT" = "$1" ]; then echo "pnpm $1 failed" >&2; exit 1; fi'
    ].join("\n"));
    stub("node", 'if [ "$FAIL_NODE" = "1" ]; then echo "node script failed" >&2; exit 1; fi');
    // `-n` is answered separately from FAIL_SUDO on purpose. The pre-flight
    // (finding L6) asks `sudo -n true` to mean "can I sudo WITHOUT being asked
    // for a password"; FAIL_SUDO means "the installer this sudo runs fails".
    // Conflating them made an injected installer failure look like an
    // authentication gap - so this stub stands in for a NOPASSWD machine whose
    // installer fails, which is the case these tests are actually about.
    // sudo is written by hand rather than through stub(), because the `-n`
    // probe must answer BEFORE anything is appended to the call log. `sudo -n
    // true` asks a question and runs `true`: it changes nothing, so letting it
    // land in the log would read as "the deploy invoked sudo" and break the
    // cases that assert nothing ran.
    //
    // `-n` is also answered independently of FAIL_SUDO on purpose. The
    // pre-flight (finding L6) asks `sudo -n true` to mean "can I sudo without
    // being asked for a password"; FAIL_SUDO means "the installer that sudo
    // runs fails". Conflating the two made an injected installer failure look
    // like an authentication gap. This stub therefore stands in for a NOPASSWD
    // machine whose installer fails, which is what these cases are about.
    writeFileSync(join(binDir, "sudo"), [
      "#!/bin/sh",
      'if [ "$1" = "-n" ]; then exit 0; fi',
      `echo "sudo $@" >> "${callLog}"`,
      'if [ "$FAIL_SUDO" = "1" ]; then echo "install-system-daemons: FAILED - 3 of 8 daemons did not come up" >&2; exit 1; fi',
      "exit 0"
    ].join("\n") + "\n");
    chmodSync(join(binDir, "sudo"), 0o755);
    // Stands in for the login shell of step 7 (`zsh -lc "docker start ..."`).
    stub("loginshell", 'if [ "$FAIL_DOCKER" = "1" ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi');

    return {
      root,
      runtimeRoot: join(root, "runtime"),
      callLog,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        REPO_ROOT: root,
        DEPLOY_RUNTIME_ROOT: join(root, "runtime"),
        DEPLOY_SUDO: join(binDir, "sudo"),
        DEPLOY_LOGIN_SHELL: join(binDir, "loginshell"),
        // The ledger writer is deliberately NOT stubbed.
        DEPLOY_NODE: process.execPath,
        DEPLOY_ACK_GATEWAY_RESTART: "yes",
        ...failures
      }
    };
  }

  // spawnSync, not execFileSync: the latter hands back stdout only on success,
  // and round 7 put operator-facing text on stderr for runs that SUCCEED (the
  // config-gap override warning), so a test that only saw stdout could not read
  // what the operator reads.
  function runDeploy(runbook: Runbook): { status: number; output: string } {
    const result = spawnSync("zsh", [deployScript], { env: runbook.env, encoding: "utf8" });
    if (result.error) {
      throw result.error;
    }
    return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }

  // Round-8 finding L1. Runs the REAL deploy.sh, waits until the injected step
  // is actually inside its stub, then signals it - the deploy's own process
  // group by default, which is what an ssh drop (SIGHUP) and a Ctrl-C (SIGINT)
  // both hit, or the script's pid alone for a plain `kill`.
  //
  // `detached: true` is what makes the group form possible at all: it puts the
  // deploy in its own process group, so `process.kill(-pid, ...)` cannot reach
  // the test runner.
  async function runDeployAndSignal(
    runbook: Runbook,
    options: { blockOn: string; signal: NodeJS.Signals; target?: "group" | "pid" }
  ): Promise<{ status: number | null; killedBy: NodeJS.Signals | null; output: string }> {
    const ready = join(runbook.root, "step-blocked");
    const release = join(runbook.root, "step-release");
    const child = spawn("zsh", [deployScript], {
      env: { ...runbook.env, BLOCK_ON: options.blockOn, BLOCK_READY: ready, BLOCK_RELEASE: release },
      detached: true
    });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });
    const closed = new Promise<{ status: number | null; killedBy: NodeJS.Signals | null }>((resolve) => {
      child.on("close", (code, signal) => resolve({ status: code, killedBy: signal }));
    });
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    try {
      const deadline = Date.now() + 20_000;
      while (!existsSync(ready)) {
        if (Date.now() > deadline) {
          throw new Error(`step never reached ${options.blockOn}; output so far:\n${output}`);
        }
        await wait(25);
      }
      await wait(100);
      const pid = child.pid;
      if (!pid) {
        throw new Error("deploy.sh did not start");
      }
      process.kill(options.target === "pid" ? pid : -pid, options.signal);
      if (options.target === "pid") {
        // A signal aimed at the shell alone is deferred by the shell until the
        // foreground child returns (measured: 10s of `sleep` = 10s of
        // deferral), so the stub has to be let go for the trap to run at all.
        await wait(300);
        writeFileSync(release, "go\n");
      }
      return { ...(await closed), output };
    } finally {
      writeFileSync(release, "go\n");
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }

  function receipts(runbook: Runbook): Array<{ step: number; exitCode: number; detail?: string }> {
    const path = join(runbook.runtimeRoot, "deploy", "steps.jsonl");
    if (!existsSync(path)) {
      return [];
    }
    return readFileSync(path, "utf8").split(/\n/u).filter(Boolean).map((line) => JSON.parse(line));
  }

  function calls(runbook: Runbook): string {
    return existsSync(runbook.callLog) ? readFileSync(runbook.callLog, "utf8") : "";
  }

  async function gateFromLedger(runbook: Runbook, head = "cafe123") {
    return doctor.analyzeOpenClawRuntimeSnapshot({
      runtimeRoot: runbook.runtimeRoot,
      gitHead: head,
      gatewayListeners: [{ command: "node", pid: 1 }],
      cronRunnerListeners: [{ command: "node", pid: 2 }],
      controlWorkspaceAgentsPath: writePersona(runbook.root),
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1 (sandbox)");
      },
      launchdJobs: [],
      launchdPlists: { system: [], user: [] }
    });
  }

  function writePersona(root: string): string {
    const path = join(root, "control-AGENTS.md");
    writeFileSync(path, "# 控制人设（沙箱占位）\n");
    return path;
  }

  it("a failed step 0 stops the deploy - steps 1-8 never run - and the gate goes red", async () => {
    const runbook = makeRunbook("alphaloop-r6-runbook-step0-", { FAIL_GIT_PULL: "1" });

    const { status, output } = runDeploy(runbook);

    expect(status).toBe(1);
    expect(output).toMatch(/部署在第 0 步（拉取新代码）失败，后面的步骤【一步都没有执行】/u);
    // The measured pre-round-6 behaviour, now impossible: pnpm build, the
    // installers and the doctor all ran on the old checkout after this failure.
    expect(calls(runbook)).not.toMatch(/pnpm install|pnpm build|pnpm openclaw:runtime:doctor/u);
    expect(receipts(runbook)).toEqual([expect.objectContaining({ step: 0, exitCode: 1 })]);

    const analysis = await gateFromLedger(runbook);
    expect(analysis.ok).toBe(false);
    expect(analysis.findings.map((f) => f.code)).toContain("deploy-ledger.step_0_failed");
    expect(analysis.findings.find((f) => f.code === "deploy-ledger.step_0_failed")?.message)
      .toMatch(/DEPLOY_FROM_STEP=0/u);
  });

  it("a dirty tracked file is caught BEFORE git is asked to pull, with the file named", () => {
    const runbook = makeRunbook("alphaloop-r6-runbook-dirty-", { FAIL_GIT_DIRTY: "1" });

    const { status, output } = runDeploy(runbook);

    expect(status).toBe(1);
    expect(output).toMatch(/工作区有已跟踪文件的本地改动/u);
    expect(output).toMatch(/README\.md/u);
    expect(calls(runbook)).not.toMatch(/git fetch/u);
  });

  it("a failed step 3 stops steps 4-8, so nothing retires the fallbacks it kept", async () => {
    const runbook = makeRunbook("alphaloop-r6-runbook-step3-", { FAIL_SUDO: "1" });

    const { status, output } = runDeploy(runbook);

    expect(status).toBe(1);
    expect(output).toMatch(/第 3 步（安装系统 daemon）失败/u);
    // Round-5 D1 was exactly this sequence: step 3 kept a fallback, step 4 then
    // removed it. Step 4 does not run at all now.
    expect(calls(runbook)).not.toMatch(/pnpm launchd:install-user/u);
    expect(calls(runbook)).not.toMatch(/pnpm openclaw:cron:install/u);
    expect(receipts(runbook).map((entry) => entry.step)).toEqual([0, 1, 2, 3]);

    const analysis = await gateFromLedger(runbook);
    expect(analysis.ok).toBe(false);
    expect(analysis.findings.map((f) => f.code)).toContain("deploy-ledger.step_3_failed");
  });

  it("a failed step 5 (zero cron jobs) is still a red gate even though the daemons are fine", async () => {
    const runbook = makeRunbook("alphaloop-r6-runbook-step5-", { FAIL_PNPM_SCRIPT: "openclaw:cron:install" });

    const { status } = runDeploy(runbook);

    expect(status).toBe(1);
    expect(receipts(runbook).map((entry) => entry.step)).toEqual([0, 1, 2, 3, 4, 5]);
    const analysis = await gateFromLedger(runbook);
    expect(analysis.ok).toBe(false);
    expect(analysis.findings.map((f) => f.code)).toContain("deploy-ledger.step_5_failed");
  });

  it("a clean run records all nine steps and the gate finds nothing to say about the deploy", async () => {
    const runbook = makeRunbook("alphaloop-r6-runbook-ok-");

    const { status, output } = runDeploy(runbook);

    expect(status).toBe(0);
    expect(output).toMatch(/本次执行的步骤：第 0 1 2 3 4 5 6 7 8 步 —— 全部退出 0/u);
    expect(receipts(runbook).map((entry) => entry.step)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(receipts(runbook).every((entry) => entry.exitCode === 0)).toBe(true);

    const analysis = await gateFromLedger(runbook);
    expect(analysis.findings.filter((f) => f.code.startsWith("deploy-ledger."))).toEqual([]);
  });

  it("refuses to start at all until the gateway-restart warning is acknowledged", () => {
    const runbook = makeRunbook("alphaloop-r6-runbook-ack-");
    delete runbook.env.DEPLOY_ACK_GATEWAY_RESTART;

    const { status, output } = runDeploy(runbook);

    expect(status).toBe(2);
    // The warning itself, and the fact that stopping here costs nothing.
    expect(output).toMatch(/18789/u);
    expect(output).toMatch(/个人的 OpenClaw 全部 agent/u);
    expect(output).toMatch(/codex/u);
    expect(output).toMatch(/什么都还没做/u);
    expect(calls(runbook)).toBe("");
    expect(receipts(runbook)).toEqual([]);
  });

  it("resumes from the step the operator fixed without re-running the ones before it", () => {
    const runbook = makeRunbook("alphaloop-r6-runbook-resume-");
    runbook.env.DEPLOY_FROM_STEP = "4";

    const { status, output } = runDeploy(runbook);

    expect(status).toBe(0);
    expect(output).toMatch(/第 0 步 拉取新代码：按 DEPLOY_FROM_STEP=4 跳过/u);
    expect(calls(runbook)).not.toMatch(/git pull/u);
    expect(receipts(runbook).map((entry) => entry.step)).toEqual([4, 5, 6, 7, 8]);
    // Round-7 finding K3: it used to print the constant 「0-8 全部通过」 here,
    // though steps 0-3 had not run at all in this invocation.
    expect(output).toMatch(/本次执行的步骤：第 4 5 6 7 8 步 —— 全部退出 0/u);
    expect(output).toMatch(/跳过的步骤：第 0 1 2 3 步 —— 这些【本次没有跑】/u);
    expect(output).not.toMatch(/0-8 全部通过/u);
  });

  // =========================================================================
  // ROUND 7. Everything below is a case where the machine was broken and the
  // acceptance gate said nothing - each one measured against these same real
  // scripts before it was fixed.
  // =========================================================================

  // K3. `DEPLOY_FROM_STEP` had no upper bound and no shape check: run_step's
  // skip test was `number < FROM_STEP`, and report_and_exit printed its
  // all-passed line whenever nothing had failed. MEASURED: `=9` and `=99` each
  // skipped all nine steps, called launchctl zero times, never ran the doctor,
  // exited 0 and announced 「0-8 全部通过……上面已经跑过了」.
  it.each([["9"], ["99"], ["abc"], ["-1"], ["3.5"]])(
    "refuses DEPLOY_FROM_STEP=%s instead of skipping every step and calling it a pass",
    (value) => {
      const runbook = makeRunbook(`alphaloop-r7-fromstep-${value || "empty"}-`);
      runbook.env.DEPLOY_FROM_STEP = value;

      const { status, output } = runDeploy(runbook);

      expect(status).toBe(2);
      expect(output).toMatch(/什么都还没做/u);
      expect(output).not.toMatch(/全部通过|全部退出 0/u);
      expect(calls(runbook)).toBe("");
      expect(receipts(runbook)).toEqual([]);
    }
  );

  // K4. `$0` was interpolated inside report_and_exit(), and zsh's
  // FUNCTION_ARGZERO makes that the FUNCTION NAME - so every failing run handed
  // the operator `DEPLOY_ACK_GATEWAY_RESTART=yes DEPLOY_FROM_STEP=3 zsh
  // report_and_exit` at the exact moment they needed something pasteable.
  it("prints a resume command that is a real script path", () => {
    const runbook = makeRunbook("alphaloop-r7-resume-cmd-", { FAIL_SUDO: "1" });

    const { output } = runDeploy(runbook);

    expect(output).not.toMatch(/zsh report_and_exit/u);
    expect(output).toMatch(/DEPLOY_FROM_STEP=3 zsh \/.*\/deploy\.sh/u);
  });

  // K1. THE LEDGER'S OWN WRITE FAILURE. MEASURED: a clean deploy leaves nine
  // `exitCode: 0` receipts; `chmod 444` on the ledger is what one prior sudo
  // run leaves behind; the next deploy fails at step 1, cannot record it, and
  // the gate reads last time's nine green rows and answers ok=true, exit 0 -
  // right after the script promised 「验收门（第 8 步）现在也会因为这条失败记录
  // 而报错」.
  it("stops, and takes the gate down with it, when a receipt cannot be written", async () => {
    const runbook = makeRunbook("alphaloop-r7-ledger-ro-");

    expect(runDeploy(runbook).status).toBe(0);
    const green = receipts(runbook);
    expect(green).toHaveLength(9);
    expect(green.every((entry) => entry.exitCode === 0)).toBe(true);

    const ledgerPath = join(runbook.runtimeRoot, "deploy", "steps.jsonl");
    chmodSync(ledgerPath, 0o444);
    try {
      runbook.env.FAIL_PNPM_SCRIPT = "build";
      const { status, output } = runDeploy(runbook);

      // 4, not 1: "this deploy cannot be recorded" is not "a step failed".
      expect(status).toBe(4);
      expect(output).toMatch(/没能写进部署账本/u);
      expect(output).toMatch(/验收门读到的是【上一次部署】留下的那些收据/u);
      // The promise it can no longer keep is not printed on this path.
      expect(output).not.toMatch(/验收门（第 8 步）现在也会因为这条失败记录而报错/u);
      // Nothing was appended - which is the whole problem, and why the gate
      // cannot be allowed to judge on what IS there.
      expect(receipts(runbook)).toEqual(green);

      const analysis = await gateFromLedger(runbook);
      expect(analysis.ok).toBe(false);
      const unwritable = analysis.findings.find((f) => f.code === "deploy-ledger.unwritable");
      expect(unwritable?.severity).toBe("error");
      expect(unwritable?.message).toMatch(/只能证明【上一次能写进去的那次部署】/u);
    } finally {
      chmodSync(ledgerPath, 0o644);
    }
  });

  // K2. "The checkout is newer than every receipt" was a warn, justified by
  // "the doctor's own git check is what calls a stale checkout an error" - which
  // it does not: that check only errors when the checkout is BEHIND origin, and
  // an operator who pulls by hand is not behind anything. dist and all eight
  // daemons are still running the old commit at that moment.
  it("fails the gate when every receipt was recorded against another commit", async () => {
    const runbook = makeRunbook("alphaloop-r7-stale-");
    expect(runDeploy(runbook).status).toBe(0);

    const analysis = await gateFromLedger(runbook, "beef456");

    expect(analysis.ok).toBe(false);
    const stale = analysis.findings.find((f) => f.code === "deploy-ledger.stale");
    expect(stale?.severity).toBe("error");
    expect(stale?.message).toMatch(/dist 产物和 launchd 里跑着的仍然是旧那份/u);
  });

  // K9. The deploy target has FEISHU_GROUP_CHAT_ID and PLATFORM_PUBLIC_BASE_URL
  // unset (verified read-only) and a heavy deploy footprint, so steps 0-7 can
  // all succeed and step 8 still exit 1 on a configuration gap. That is
  // semantically right and reads to a controller as a deploy regression - so it
  // is now refused BEFORE step 0, with its own exit code and its own words.
  it("refuses up front when the report-routing config is missing, without touching the machine", () => {
    const runbook = makeRunbook("alphaloop-r7-preflight-");
    rmSync(join(runbook.root, ".env.local"));
    delete runbook.env.FEISHU_GROUP_CHAT_ID;
    delete runbook.env.PLATFORM_PUBLIC_BASE_URL;

    const { status, output } = runDeploy(runbook);

    expect(status).toBe(3);
    expect(output).toMatch(/配置未就绪 —— 这【不是部署失败】/u);
    expect(output).toMatch(/FEISHU_GROUP_CHAT_ID/u);
    expect(output).toMatch(/PLATFORM_PUBLIC_BASE_URL/u);
    expect(calls(runbook)).toBe("");
    expect(receipts(runbook)).toEqual([]);
  });

  it("still lets an operator deploy on purpose with the config gap, and says what it will cost", () => {
    const runbook = makeRunbook("alphaloop-r7-preflight-override-");
    rmSync(join(runbook.root, ".env.local"));
    delete runbook.env.FEISHU_GROUP_CHAT_ID;
    delete runbook.env.PLATFORM_PUBLIC_BASE_URL;
    runbook.env.DEPLOY_ALLOW_MISSING_CONFIG = "yes";

    const { status, output } = runDeploy(runbook);

    expect(status).toBe(0);
    expect(output).toMatch(/第 8 步预计会因为上面这些变量报 error/u);
    expect(receipts(runbook).map((entry) => entry.step)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("reads the config out of .env.local exactly the way the daemons do", () => {
    const runbook = makeRunbook("alphaloop-r7-preflight-envfile-");
    // Quoted, commented, and overridden further down - the shapes loadLocalEnv
    // handles, so the pre-flight has to handle them identically or it will
    // refuse a machine that is in fact configured.
    writeFileSync(join(runbook.root, ".env.local"), [
      "# 部署机配置",
      "FEISHU_GROUP_CHAT_ID=''",
      "  PLATFORM_PUBLIC_BASE_URL = ignored, there is a space before the =",
      "PLATFORM_PUBLIC_BASE_URL=\"https://alphaloop.invalid\"",
      "FEISHU_GROUP_CHAT_ID='oc_real_group'"
    ].join("\n"));
    delete runbook.env.FEISHU_GROUP_CHAT_ID;
    delete runbook.env.PLATFORM_PUBLIC_BASE_URL;

    expect(runDeploy(runbook).status).toBe(0);
  });

  // THE MATRIX. One row per step, each one injected into the real script: the
  // deploy must stop there, every later step must not run, and the gate must be
  // able to see it afterwards.
  const injections: Array<[number, string, Record<string, string>, RegExp]> = [
    [0, "拉取新代码", { FAIL_GIT_PULL: "1" }, /pnpm install|pnpm build/u],
    [1, "安装依赖并构建", { FAIL_PNPM_SCRIPT: "build" }, /launchd:install-backup-alerts/u],
    [2, "安装用户级 LaunchAgent", { FAIL_PNPM_SCRIPT: "launchd:install-backup-alerts" }, /sudo/u],
    [3, "安装系统 daemon", { FAIL_SUDO: "1" }, /launchd:install-user/u],
    [4, "退役旧的用户级副本", { FAIL_PNPM_SCRIPT: "launchd:install-user" }, /openclaw:cron:install/u],
    [5, "注册 openclaw cron 任务", { FAIL_PNPM_SCRIPT: "openclaw:cron:install" }, /render-openclaw-config/u],
    [6, "部署 control agent 人设", { FAIL_NODE: "1" }, /loginshell/u],
    [7, "启动 rsshub 容器", { FAIL_DOCKER: "1" }, /openclaw:runtime:doctor/u]
  ];

  it.each(injections)(
    "step %i (%s) failing stops the deploy there and the gate goes red",
    async (step, _name, failure, laterCall) => {
      const runbook = makeRunbook(`alphaloop-r7-matrix-${step}-`, failure);

      const { status, output } = runDeploy(runbook);

      expect(status).toBe(1);
      expect(output).toMatch(new RegExp(`部署在第 ${step} 步`, "u"));
      expect(calls(runbook)).not.toMatch(laterCall);
      const recorded = receipts(runbook);
      expect(recorded.map((entry) => entry.step)).toEqual(
        Array.from({ length: step + 1 }, (_unused, index) => index)
      );
      expect(recorded.at(-1)).toMatchObject({ step, exitCode: 1 });

      const analysis = await gateFromLedger(runbook);
      expect(analysis.ok).toBe(false);
      expect(analysis.findings.map((f) => f.code)).toContain(`deploy-ledger.step_${step}_failed`);
    }
  );

  // Step 8 is the gate itself, so it has no ledger row of its own to fail on
  // (REQUIRED_DEPLOY_STEPS excludes it): a failed acceptance step IS the doctor
  // exiting non-zero, in this run and in every re-run while the cause stands.
  // What has to hold is that the deploy reports it as a failure rather than
  // ending on 「全部退出 0」.
  it("step 8 (验收 doctor) failing is reported as a failed deploy, not a pass", () => {
    const runbook = makeRunbook("alphaloop-r7-matrix-8-", { FAIL_PNPM_SCRIPT: "openclaw:runtime:doctor" });

    const { status, output } = runDeploy(runbook);

    expect(status).toBe(1);
    expect(output).toMatch(/部署在第 8 步（验收 doctor）失败/u);
    expect(output).not.toMatch(/全部退出 0/u);
    expect(receipts(runbook).at(-1)).toMatchObject({ step: 8, exitCode: 1 });
  });

  // =========================================================================
  // ROUND 8, finding L1: AN INTERRUPTED DEPLOY LEFT A GREEN GATE.
  //
  // deploy.sh had no INT/TERM/HUP trap. MEASURED against the version at HEAD,
  // with these same real scripts, the real ledger writer and the real analyzer:
  //
  //   SIGINT during step 0  -> exit 130, receipts []      -> gate ok=TRUE, warn only
  //   SIGHUP during step 1  -> exit 1,   receipts ["0:0"] -> gate ok=TRUE, warn only
  //   SIGTERM during step 1 -> killed,   receipts ["0:0"] -> gate ok=TRUE, warn only
  //
  // The controller drives this deploy over ssh, and a dropped connection is
  // precisely a SIGHUP to the foreground process group - so this was the single
  // most likely way the real deployment could end while still looking fine.
  // =========================================================================
  const interruptions: Array<[NodeJS.Signals, number, string, number]> = [
    ["SIGHUP", 129, "pnpm build", 1],
    ["SIGINT", 130, "git pull", 0],
    ["SIGTERM", 143, "pnpm build", 1]
  ];

  it.each(interruptions)(
    "%s (exit %d) while %s is running: a receipt, a resume command, and a red gate at step %d",
    async (signal, exitCode, blockOn, step) => {
      const runbook = makeRunbook(`alphaloop-r8-signal-${signal}-`);

      const { status, output } = await runDeployAndSignal(runbook, { blockOn, signal });

      // 128 + signal number: the conventional code, and distinct from every
      // other exit this script has, so a controller can tell an interruption
      // from a failed step without reading the text.
      expect(status).toBe(exitCode);
      // The half that survives a terminal that is already gone.
      const recorded = receipts(runbook);
      expect(recorded.at(-1)).toMatchObject({ step, exitCode });
      expect(recorded.at(-1)?.detail).toMatch(new RegExp(`${signal} 中断`, "u"));
      // The half the operator reads when the terminal is still there.
      expect(output).toMatch(new RegExp(`本次部署【被 ${signal} 中断】`, "u"));
      expect(output).toMatch(new RegExp(`部署被 ${signal} 中断在第 ${step} 步`, "u"));
      expect(output).toMatch(new RegExp(`DEPLOY_FROM_STEP=${step} zsh /.*/deploy\\.sh`, "u"));
      expect(output).not.toMatch(/全部退出 0/u);

      const analysis = await gateFromLedger(runbook);
      expect(analysis.ok).toBe(false);
      const finding = analysis.findings.find((f) => f.code === `deploy-ledger.step_${step}_failed`);
      expect(finding?.severity).toBe("error");
      // Without the receipt's own note, 「以退出码 129 失败」 is unreadable.
      expect(finding?.message).toMatch(new RegExp(`收据备注：${signal} 中断`, "u"));
    },
    40_000
  );

  // The measured limit, asserted rather than described: a signal aimed at the
  // script's pid alone cannot be handled while a step's child is running - the
  // shell defers it. The receipt is not lost, it is late.
  it("still records the interruption when the signal was deferred behind a running step", async () => {
    const runbook = makeRunbook("alphaloop-r8-signal-deferred-");

    const { status } = await runDeployAndSignal(runbook, {
      blockOn: "pnpm build",
      signal: "SIGTERM",
      target: "pid"
    });

    expect(status).toBe(143);
    expect(receipts(runbook).at(-1)).toMatchObject({ step: 1, exitCode: 143 });
  }, 40_000);

  // The other side of the rule: the traps are armed only after the pre-flight,
  // so a Ctrl-C while the script is still refusing to start must not invent a
  // failure receipt for a machine nothing has touched.
  it("does not manufacture a failed step out of an interruption before step 0", async () => {
    const runbook = makeRunbook("alphaloop-r8-signal-preflight-");
    delete runbook.env.DEPLOY_ACK_GATEWAY_RESTART;

    const { status } = runDeploy(runbook);

    expect(status).toBe(2);
    expect(receipts(runbook)).toEqual([]);
  });

  // L5. `config_value` stripped the quotes and then tested `[ -z ]`, so a value
  // of only spaces passed the pre-flight - while the doctor's own `configured()`
  // is `String(value).trim().length > 0`. MEASURED: `.env.local` carrying
  // `FEISHU_GROUP_CHAT_ID="   "` ran all nine steps and exited 0, and step 8
  // then errored with notification-routing.no_group_chat. That is exactly the
  // 「配置缺口被读成部署回退」 the pre-flight exists to prevent.
  it("treats a whitespace-only value as unset, the way the daemons do", () => {
    const runbook = makeRunbook("alphaloop-r8-preflight-blank-");
    writeFileSync(
      join(runbook.root, ".env.local"),
      "FEISHU_GROUP_CHAT_ID=\"   \"\nPLATFORM_PUBLIC_BASE_URL=\"https://alphaloop.invalid\"\n"
    );
    delete runbook.env.FEISHU_GROUP_CHAT_ID;
    delete runbook.env.PLATFORM_PUBLIC_BASE_URL;

    const { status, output } = runDeploy(runbook);

    expect(status).toBe(3);
    expect(output).toMatch(/FEISHU_GROUP_CHAT_ID/u);
    expect(calls(runbook)).toBe("");
  });

  // The same rule from the environment's side. The doctor merges
  // `{...loadLocalEnv(), ...process.env}`, so an exported-but-empty variable
  // SHADOWS the file - the pre-flight has to read it that way too, or it
  // approves a machine on a value no daemon will ever see.
  it("lets an exported-but-empty variable shadow the file, exactly as the doctor does", () => {
    const runbook = makeRunbook("alphaloop-r8-preflight-shadow-");
    runbook.env.FEISHU_GROUP_CHAT_ID = "  ";

    const { status, output } = runDeploy(runbook);

    expect(status).toBe(3);
    // The list of what is missing names one variable, not both: the file's
    // PLATFORM_PUBLIC_BASE_URL is real and is read as configured.
    expect(output).toMatch(/· FEISHU_GROUP_CHAT_ID\n/u);
    expect(output).not.toMatch(/· PLATFORM_PUBLIC_BASE_URL\n/u);
  });

  // =========================================================================
  // ROUND 8, finding L6: A PASSWORD-REQUIRING sudo WITH NO tty STRANDED THE
  // DEPLOY EXACTLY WHERE IT HURTS MOST.
  //
  // Measured read-only on the mini (2026-07-29): `sudo -n true` answers
  // 「sudo: a password is required」. Step 3 is `sudo zsh
  // install-system-daemons.sh`, and BOTH recommended ways to drive this deploy
  // hand the script a stdin that is not a terminal - README's own
  // `nohup zsh deploy.sh > log 2>&1 &`, and the controller's
  // `ssh host '<command>'`.
  //
  // MEASURED with the real deploy.sh, the real ledger and a sudo stub shaped
  // like a real one (refuses when stdin is not a tty):
  //   steps 0/1/2 succeed -> step 3 exits 1 with "sudo: no tty present"
  //   -> receipts 0:0,1:0,2:0,3:1, gate red.
  //
  // The gate was honest; the machine was not fine. Step 2 installs the
  // USER-LEVEL ai.openclaw.gateway and the step that boots it back out is the
  // one that just failed - so 18789 is left with two gateways contending, and
  // that port is the only entrance to the operator's 185-agent fleet. The path
  // fails deterministically, and it fails after the gateway has been touched
  // and before it has been handed over.
  //
  // So it is refused up front, where refusing costs nothing.
  // =========================================================================
  function requirePasswordForSudo(runbook: Runbook): void {
    const sudo = join(runbook.root, "bin", "sudo");
    writeFileSync(sudo, [
      "#!/bin/sh",
      // `-n` is what the pre-flight asks with: "could you run without being
      // asked for a password?" - answered before the log line, same as the
      // stock stub, because asking changes nothing.
      'if [ "$1" = "-n" ]; then echo "sudo: a password is required" >&2; exit 1; fi',
      `echo "sudo $@" >> "${runbook.callLog}"`,
      'if [ ! -t 0 ]; then echo "sudo: no tty present and no askpass program specified" >&2; exit 1; fi',
      "exit 0"
    ].join("\n") + "\n");
    chmodSync(sudo, 0o755);
  }

  it("refuses before step 0 when sudo needs a password and there is no tty to ask on", () => {
    const runbook = makeRunbook("alphaloop-r8-sudo-notty-");
    requirePasswordForSudo(runbook);

    // spawnSync gives the child a pipe for stdin - the same thing `nohup ... &`
    // and a non-interactive ssh both produce.
    const { status, output } = runDeploy(runbook);

    expect(status).toBe(3);
    expect(output).toMatch(/sudo 要密码，但这次运行没有终端可以问 —— 什么都还没有动/u);
    // The whole point: the user-level gateway of step 2 is never installed, so
    // nothing ends up contending for 18789.
    expect(calls(runbook)).not.toMatch(/launchd:install-backup-alerts/u);
    expect(receipts(runbook)).toEqual([]);
  });

  it("tells the operator why this is worse than an ordinary failed step, and how to run it instead", () => {
    const runbook = makeRunbook("alphaloop-r8-sudo-advice-");
    requirePasswordForSudo(runbook);

    const { output } = runDeploy(runbook);

    expect(output).toMatch(/用户级 ai\.openclaw\.gateway/u);
    expect(output).toMatch(/18789/u);
    expect(output).toMatch(/tmux new -s deploy/u);
    expect(output).toMatch(/sudo -v &&/u);
    expect(output).toMatch(/DEPLOY_ALLOW_SUDO_PROMPT=yes/u);
  });

  it("does not refuse when step 3 is not part of this run", () => {
    const runbook = makeRunbook("alphaloop-r8-sudo-skipped-");
    requirePasswordForSudo(runbook);
    runbook.env.DEPLOY_FROM_STEP = "4";

    const { status, output } = runDeploy(runbook);

    expect(status).toBe(0);
    expect(output).not.toMatch(/sudo 要密码/u);
  });

  it("does not refuse on a NOPASSWD machine", () => {
    // makeRunbook's stock sudo stub exits 0 for everything, `-n` included -
    // i.e. it stands in for a machine that never prompts.
    const runbook = makeRunbook("alphaloop-r8-sudo-nopasswd-");

    const { status, output } = runDeploy(runbook);

    expect(status).toBe(0);
    expect(output).not.toMatch(/sudo 要密码/u);
  });

  it("proceeds when the operator explicitly overrides the sudo pre-flight", () => {
    const runbook = makeRunbook("alphaloop-r8-sudo-override-");
    requirePasswordForSudo(runbook);
    runbook.env.DEPLOY_ALLOW_SUDO_PROMPT = "yes";

    const { status, output } = runDeploy(runbook);

    expect(output).toMatch(/已按 DEPLOY_ALLOW_SUDO_PROMPT 继续/u);
    // The override is honoured, and the deploy then fails at step 3 exactly as
    // the refusal predicted - which is the evidence that the prediction is real.
    expect(status).toBe(1);
    expect(receipts(runbook).at(-1)).toMatchObject({ step: 3, exitCode: 1 });
  });
});

// ===========================================================================
// TASK 28 (2026-07-30): A FULL deploy.sh RUN COULD NOT PASS STEP 3.
//
// Reproduced twice on the mini: step 2 (`pnpm launchd:install-backup-alerts`
// -> install-launchd.sh -> `openclaw gateway install`) installs AND STARTS the
// user-level gui/501/ai.openclaw.gateway - the ordering the README mandates,
// so that step 3 can boot it out. Step 3's bootout of that seconds-old agent
// then returned while launchd was still draining the process, the immediate
// re-check read STILL loaded, and the run exited 1 (platform-app and
// cron-runner too, first run). A resume from step 3 fifteen minutes later
// passed - the drains had finished in between. So the runbook, followed
// exactly, always failed on the first try and always suggested its own
// workaround.
//
// The suite above stubs pnpm and sudo entirely, so no test in it could see
// this: nothing there ever put a freshly-started agent in front of step 3.
// Here steps 2 and 3 are REAL - the real install-launchd.sh (whose `openclaw
// gateway install` really starts the agent, via the stub CLI's opt-in) and
// the real install-system-daemons.sh, sharing one stub-launchd job table
// whose bootout drains like the measured launchd (see bootoutDrainSeconds).
// Steps 0/1/4-8 stay stubs: they neither touch launchd nor did they fail.
// ===========================================================================
describe("task 28: a full deploy.sh run converges on the first try", () => {
  const deployScript = fileURLToPath(new URL("./deploy.sh", import.meta.url));

  interface FullDeploySandbox {
    machine: FakeMachine;
    root: string;
    callLog: string;
    env: NodeJS.ProcessEnv;
  }

  function makeFullDeploySandbox(prefix: string, stub: Omit<LaunchctlStubOptions, "stateDir"> = {}): FullDeploySandbox {
    const machine = makeFakeMachine(prefix, stub);
    writeOpenClawStub(join(machine.stubBinDir, "openclaw"), machine.openclawLog, {
      gatewayInstallStartsAgent: {
        launchctl: join(machine.stubBinDir, "launchctl"),
        agentsDir: machine.agentsDir,
        uid: process.getuid?.() ?? 0
      }
    });

    const root = makeTempDir(`${prefix}repo-`);
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const callLog = join(root, "calls.log");
    writeFileSync(
      join(root, ".env.local"),
      "FEISHU_GROUP_CHAT_ID=oc_sandbox_group\nPLATFORM_PUBLIC_BASE_URL=\"https://alphaloop.invalid\"\n"
    );

    const stubBin = (name: string, body: string) => {
      writeFileSync(join(binDir, name), ["#!/bin/sh", `echo "${name} $@" >> "${callLog}"`, body, "exit 0"].join("\n") + "\n");
      chmodSync(join(binDir, name), 0o755);
    };

    stubBin("git", [
      'if [ "$1" = "-C" ]; then shift 2; fi',
      'case "$1" in',
      '  status) exit 0 ;;',
      '  pull) echo "Already up to date." ;;',
      '  rev-parse) echo "cafe123" ;;',
      "esac"
    ].join("\n"));
    // Step 2 is the REAL installer chain; every other pnpm subcommand is a
    // no-op stand-in, same as the suite above.
    stubBin("pnpm", [
      'if [ "$1" = "launchd:install-backup-alerts" ]; then',
      `  exec zsh "${scriptPath}"`,
      "fi"
    ].join("\n"));
    stubBin("node", "");
    stubBin("loginshell", "");
    // sudo hands its argv straight through: `sudo zsh install-system-daemons.sh`
    // becomes the REAL installer, inheriting this sandbox's seams
    // (SYSTEM_DIR / LAUNCHCTL / TARGET_* / settle windows) from the
    // environment - the same thing a NOPASSWD sudo -E would do.
    writeFileSync(join(binDir, "sudo"), [
      "#!/bin/sh",
      'if [ "$1" = "-n" ]; then exit 0; fi',
      `echo "sudo $@" >> "${callLog}"`,
      'exec "$@"'
    ].join("\n") + "\n");
    chmodSync(join(binDir, "sudo"), 0o755);

    return {
      machine,
      root,
      callLog,
      env: {
        ...machine.env,
        // The installer derives every runtime path from REPO_ROOT; pointing it
        // at the sandbox root keeps the suite out of the real repo's runtime/.
        REPO_ROOT: root,
        PATH: `${binDir}:${machine.env.PATH ?? ""}`,
        DEPLOY_RUNTIME_ROOT: join(root, "runtime"),
        DEPLOY_SUDO: join(binDir, "sudo"),
        DEPLOY_LOGIN_SHELL: join(binDir, "loginshell"),
        DEPLOY_NODE: process.execPath,
        DEPLOY_ACK_GATEWAY_RESTART: "yes",
        // Production default is 30s; the stub's drain is 1s, so 6s keeps the
        // deadline >> drain (the property under test) without the wait.
        BOOTOUT_SETTLE_SECONDS: "6"
      }
    };
  }

  function runFullDeploy(sandbox: FullDeploySandbox): { status: number; output: string } {
    const result = spawnSync("zsh", [deployScript], { env: sandbox.env, encoding: "utf8" });
    if (result.error) {
      throw result.error;
    }
    return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }

  /**
   * Last receipt per step. Two writers both record step 3 (deploy.sh and
   * install-system-daemons.sh itself), exactly as in production; the gate
   * judges the latest row, so that is what these tests assert on.
   */
  function latestExitPerStep(sandbox: FullDeploySandbox): Map<number, number> {
    const path = join(sandbox.root, "runtime", "deploy", "steps.jsonl");
    const rows = existsSync(path)
      ? readFileSync(path, "utf8").split(/\n/u).filter(Boolean).map((line) => JSON.parse(line) as { step: number; exitCode: number })
      : [];
    const latest = new Map<number, number>();
    for (const row of rows) {
      latest.set(row.step, row.exitCode);
    }
    return latest;
  }

  it("passes first try - step 3 waits out the gateway step 2 just started - and a re-run converges too", () => {
    const sandbox = makeFullDeploySandbox("alphaloop-t28-full-", {
      bootoutDrainSeconds: 1,
      bootoutDrainRecentWindowSeconds: 3600
    });

    const first = runFullDeploy(sandbox);

    expect(first.output).toMatch(/第 0 1 2 3 4 5 6 7 8 步 —— 全部退出 0/u);
    expect(first.status).toBe(0);
    // Step 2 really ran before step 3 and really started the user gateway -
    // the README's mandated ordering, exercised rather than assumed.
    const log = readFileSync(sandbox.callLog, "utf8");
    expect(log.indexOf("pnpm launchd:install-backup-alerts")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("pnpm launchd:install-backup-alerts")).toBeLessThan(log.indexOf("sudo zsh"));
    expect(readFileSync(sandbox.machine.openclawLog, "utf8")).toContain("gateway install");
    expect([...latestExitPerStep(sandbox).entries()].sort((a, b) => a[0] - b[0]))
      .toEqual([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0]]);
    // The handover happened: daemons up, the step-2 gateway taken over and
    // archived, nothing left running in the user domain.
    expect(loadedSystemLabels(sandbox.machine)).toEqual([...SYSTEM_LABELS].sort());
    expect(loadedUserLabels(sandbox.machine)).not.toContain("ai.openclaw.gateway");
    expect(archivedLabels(sandbox.machine)).toContain("ai.openclaw.gateway");

    // Idempotence, and the system-domain half of the fix: run 2 boots out the
    // eight daemons run 1 bootstrapped seconds ago - every one of them
    // freshly-started, every bootout draining - and still converges.
    const second = runFullDeploy(sandbox);

    expect(second.status).toBe(0);
    expect(second.output).toMatch(/第 0 1 2 3 4 5 6 7 8 步 —— 全部退出 0/u);
    expect(loadedSystemLabels(sandbox.machine)).toEqual([...SYSTEM_LABELS].sort());
    expect(loadedUserLabels(sandbox.machine)).not.toContain("ai.openclaw.gateway");
  }, 55_000);

  it("still fails closed, stopping the deploy at step 3, when an agent genuinely will not die", () => {
    const sandbox = makeFullDeploySandbox("alphaloop-t28-wedged-", {
      surviveBootoutLabels: ["ai.openclaw.gateway"]
    });
    // A wedged label is only declared after the full deadline, so keep the
    // deadline short here - the property is the refusal, not the wait.
    sandbox.env.BOOTOUT_SETTLE_SECONDS = "1";

    const { status, output } = runFullDeploy(sandbox);

    expect(status).toBe(1);
    expect(output).toMatch(/is STILL loaded \d+s after bootout/u);
    expect(output).toMatch(/部署在第 3 步（安装系统 daemon）失败/u);
    const latest = latestExitPerStep(sandbox);
    expect(latest.get(3)).toBe(1);
    expect([...latest.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    // The machine keeps the one copy it was running: the wedged user gateway
    // stays, and its daemon is never bootstrapped next to it.
    expect(loadedUserLabels(sandbox.machine)).toContain("ai.openclaw.gateway");
    expect(loadedSystemLabels(sandbox.machine)).not.toContain("ai.openclaw.system.gateway");
  }, 55_000);
});
