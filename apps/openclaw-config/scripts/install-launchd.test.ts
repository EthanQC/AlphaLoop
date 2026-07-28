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

// install-system-daemons.sh polls `launchctl print system/<label>` after a
// bootout and only proceeds once the label is GONE. A stub that reported
// success for `print` would claim the job is still loaded forever; exiting 1
// is the honest simulation of "not loaded", which is the post-bootout state.
function writeLaunchctlStub(path: string, logPath: string): void {
  const contents = [
    "#!/bin/sh",
    `echo "$@" >> "${logPath}"`,
    'if [ "$1" = "print" ]; then exit 1; fi',
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
  env: NodeJS.ProcessEnv;
}

function makeFakeMachine(prefix: string): FakeMachine {
  const home = makeTempDir(prefix);
  const systemDir = join(makeTempDir(`${prefix}sys-`), "LaunchDaemons");
  const stubBinDir = join(home, ".local", "bin");
  const nodeBinDir = join(home, ".local", "node-v24", "bin");
  mkdirSync(stubBinDir, { recursive: true });
  mkdirSync(nodeBinDir, { recursive: true });
  mkdirSync(systemDir, { recursive: true });

  const launchctlLog = join(home, "launchctl-calls.log");
  const openclawLog = join(home, "openclaw-calls.log");
  writeLaunchctlStub(join(stubBinDir, "launchctl"), launchctlLog);
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
  function runUserSideInstallers(machine: FakeMachine): void {
    execFileSync("zsh", [scriptPath], { env: machine.env, encoding: "utf8" });
    execFileSync(process.execPath, [userSchedulesScript], { env: machine.env, encoding: "utf8" });
    execFileSync(process.execPath, [cronInstallScript], { env: machine.env, encoding: "utf8" });
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
    seedLegacyUserAgents(machine, [...SYSTEM_LABELS, ...RETIRED_LABELS]);
    runUserSideInstallers(machine);
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
