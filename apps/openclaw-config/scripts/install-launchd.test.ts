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
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("./install-launchd.sh", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/u, "");

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeStub(path: string, logPath: string): void {
  // `$@` (not `$0`) so the log records exactly what install-launchd.sh
  // passed - e.g. "load /fake/home/Library/LaunchAgents/com.alphaloop.platform-app.plist".
  const contents = `#!/bin/sh\necho "$@" >> "${logPath}"\nexit 0\n`;
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("install-launchd.sh fake-HOME dry run (Phase 3 Task 8)", () => {
  it("renders and attempts to load com.alphaloop.platform-app.plist from the new .plist.template, without touching the real HOME", () => {
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
    const platformAppPlist = join(destDir, "com.alphaloop.platform-app.plist");

    expect(existsSync(platformAppPlist)).toBe(true);
    const rendered = readFileSync(platformAppPlist, "utf8");
    expect(rendered).toContain("<string>com.alphaloop.platform-app</string>");
    expect(rendered).not.toContain("__REPO_ROOT__");
    expect(rendered).toContain(repoRoot);
    expect(rendered).toContain("pnpm --filter @apps/platform-app start");

    // Sibling H2-era templates still render correctly alongside the new one
    // (regression guard - this task must not have broken the existing glob).
    expect(existsSync(join(destDir, "com.alphaloop.daily-backup.plist"))).toBe(true);
    expect(existsSync(join(destDir, "com.alphaloop.market-alerts.plist"))).toBe(true);

    // com.openclaw.gateway.plist is explicitly skipped by the script itself
    // (unrelated to this task) - confirms the fake-HOME run still exercises
    // that real carve-out rather than silently no-op'ing everything.
    expect(existsSync(join(destDir, "com.openclaw.gateway.plist"))).toBe(false);

    // The rendered file's destination path was actually handed to `launchctl
    // load` (our stub), not just written to disk - proves the install path,
    // not only the render step.
    const loadCalls = readFileSync(launchctlLog, "utf8");
    expect(loadCalls).toContain(`load ${platformAppPlist}`);

    // The script's final `openclaw gateway install` step still ran to
    // completion (i.e. nothing upstream aborted the script early).
    const gatewayCalls = readFileSync(openclawLog, "utf8");
    expect(gatewayCalls).toContain("gateway install");
  });
});
