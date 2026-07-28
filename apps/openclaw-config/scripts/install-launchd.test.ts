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
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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
  mkdirSync(loadedDir, { recursive: true });
  mkdirSync(disabledDir, { recursive: true });
  for (const label of options.disabledLabels ?? []) {
    writeFileSync(join(disabledDir, `system_${label}`), "");
  }

  const domainGuard = options.failBootstrapDomain === "system" ? ' && [ "$dom" = "system" ]' : "";
  const failLine = options.failBootstrapLabel
    ? `    if [ "$lbl" = "${options.failBootstrapLabel}" ]${domainGuard}; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi`
    : "    :";

  const contents = [
    "#!/bin/sh",
    `echo "$@" >> "${logPath}"`,
    `S="${options.stateDir}"`,
    'key() { printf "%s" "$1" | tr / _; }',
    'case "$1" in',
    '  print)',
    '    [ -f "$S/loaded/$(key "$2")" ] && exit 0',
    "    exit 113 ;;",
    '  enable) rm -f "$S/disabled/$(key "$2")"; exit 0 ;;',
    '  disable) touch "$S/disabled/$(key "$2")"; exit 0 ;;',
    // Both spellings launchctl(1) accepts, because the installers use both:
    // `bootout <domain>/<label>` (the daemons) and `bootout <domain> <plist>`
    // (the node installers, and the gui restore path).
    "  bootout)",
    '    tgt="$2"',
    '    case "$3" in *.plist) tgt="$2/$(basename "$3" .plist)" ;; esac',
    '    [ -f "$S/loaded/$(key "$tgt")" ] || { echo "Boot-out failed: 113: Could not find specified service" >&2; exit 113; }',
    '    rm -f "$S/loaded/$(key "$tgt")"; exit 0 ;;',
    "  bootstrap)",
    '    lbl="$(basename "$3" .plist)"',
    '    [ -f "$3" ] || { echo "Bootstrap failed: 2: No such file or directory" >&2; exit 2; }',
    // The domain is an argument, not an assumption: `bootstrap gui/<uid> <plist>`
    // (the restore path) must load the job in the USER domain, not the system one.
    '    case "$2" in gui/*) dom="$2" ;; *) dom="system" ;; esac',
    '    if [ -f "$S/disabled/$(key "$dom/$lbl")" ]; then echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; fi',
    failLine,
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
function writeOpenClawStub(path: string, logPath: string): void {
  const contents = [
    "#!/bin/sh",
    `echo "$@" >> "${logPath}"`,
    'if [ "$1" = "cron" ] && [ "$2" = "add" ]; then echo \'{"id":1}\'; exit 0; fi',
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
  writeStub(join(nodeBinDir, "node"), join(home, "node-calls.log"));

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
      BOOTSTRAP_SETTLE_SECONDS: "0"
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
      expect(output).toMatch(/7 of 8 ARE loaded/u);
      // Round-5 D1/D4: the failed service's own fallback is put back, and the
      // operator is told not to reach for the installer that used to delete it.
      expect(output).toMatch(/DO NOT run 'pnpm launchd:install-user' as a workaround/u);
      expect(output).toMatch(/re-run converges rather than repeating/u);
      // The failure summary must not claim the label came up.
      expect(output).toMatch(/com\.alphaloop\.platform-app {2}egress=direct {2}NOT LOADED/u);
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
      expect(stdout).toContain("com.alphaloop.daily-backup  egress=direct  loaded");

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
