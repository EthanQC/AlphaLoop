// Phase 6 Task 6 (2026-07-15 plan): direct tests for the multi-account
// credential loader - present/missing/wide-perms-warning/env isolation.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildMemberSubprocessEnv,
  isMemberCredentialTreeEmpty,
  loadMemberCredentials,
  resolveCredentialsRoot
} from "./member-credentials.mjs";

const tempDirs: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-member-credentials-"));
  tempDirs.push(dir);
  return dir;
}

function writeMemberEnv(root: string, memberId: string, contents: string, mode = 0o600): string {
  const memberDir = join(root, memberId);
  mkdirSync(memberDir, { recursive: true, mode: 0o700 });
  chmodSync(memberDir, 0o700);
  const envPath = join(memberDir, "longbridge.env");
  writeFileSync(envPath, contents, "utf8");
  chmodSync(envPath, mode);
  return envPath;
}

afterEach(() => {
  delete process.env.ALPHALOOP_CREDENTIALS_ROOT;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("resolveCredentialsRoot", () => {
  it("uses the explicit rootDir argument when given", () => {
    expect(resolveCredentialsRoot("/tmp/explicit-root")).toBe("/tmp/explicit-root");
  });

  it("falls back to ALPHALOOP_CREDENTIALS_ROOT when no argument is given", () => {
    process.env.ALPHALOOP_CREDENTIALS_ROOT = "/tmp/env-root";
    expect(resolveCredentialsRoot(undefined)).toBe("/tmp/env-root");
  });

  it("falls back to ~/.alphaloop/credentials when neither is given", () => {
    delete process.env.ALPHALOOP_CREDENTIALS_ROOT;
    expect(resolveCredentialsRoot(undefined)).toMatch(/\.alphaloop\/credentials$/u);
  });
});

describe("loadMemberCredentials: missing member has no linked broker account (degrade, not error)", () => {
  it("returns null when the member's directory does not exist at all", () => {
    const root = makeRoot();
    expect(loadMemberCredentials("member_no_account", { rootDir: root })).toBeNull();
  });

  it("returns null when the member's directory exists but longbridge.env is missing", () => {
    const root = makeRoot();
    mkdirSync(join(root, "member_partial"), { recursive: true });
    expect(loadMemberCredentials("member_partial", { rootDir: root })).toBeNull();
  });

  it("does not treat filesystem lookup errors as a missing credential file/shared-account fallback", () => {
    const root = makeRoot();
    const overlongPathComponent = `member_${"x".repeat(300)}`;
    expect(() => loadMemberCredentials(overlongPathComponent, { rootDir: root })).toThrow();
  });
});

describe("isMemberCredentialTreeEmpty: legacy shared-account gate", () => {
  it("is true only for a genuinely empty or missing credential root", () => {
    const root = makeRoot();
    expect(isMemberCredentialTreeEmpty({ rootDir: root })).toBe(true);
    expect(isMemberCredentialTreeEmpty({ rootDir: join(root, "missing") })).toBe(true);
  });

  it("treats an unknown member credential and a suspicious symlink as non-empty", () => {
    const root = makeRoot();
    writeMemberEnv(root, "inactive_or_unknown", "LONGBRIDGE_ACCESS_TOKEN=token");
    expect(isMemberCredentialTreeEmpty({ rootDir: root })).toBe(false);

    const symlinkRoot = makeRoot();
    const target = makeRoot();
    symlinkSync(target, join(symlinkRoot, "suspicious-member"));
    expect(isMemberCredentialTreeEmpty({ rootDir: symlinkRoot })).toBe(false);
  });

  it("treats every unknown root entry, including an empty directory, as non-empty", () => {
    const emptyUnknownDirRoot = makeRoot();
    mkdirSync(join(emptyUnknownDirRoot, "unknown-member"), { mode: 0o700 });
    expect(isMemberCredentialTreeEmpty({ rootDir: emptyUnknownDirRoot })).toBe(false);

    const unknownFileRoot = makeRoot();
    writeFileSync(join(unknownFileRoot, "README.txt"), "not a credential", { mode: 0o600 });
    expect(isMemberCredentialTreeEmpty({ rootDir: unknownFileRoot })).toBe(false);
  });
});

describe("loadMemberCredentials: present credentials", () => {
  it("parses LONGBRIDGE_*/LONGPORT_* keys via parseEnvText and derives isolated cache paths", () => {
    const root = makeRoot();
    writeMemberEnv(
      root,
      "member_1",
      [
        "LONGBRIDGE_APP_KEY=key-1",
        "LONGBRIDGE_APP_SECRET='shh$ecret'",
        "LONGBRIDGE_ACCESS_TOKEN=token-1",
        "# a comment, ignored",
        "SOME_UNRELATED_KEY=should-not-be-forwarded"
      ].join("\n")
    );

    const creds = loadMemberCredentials("member_1", { rootDir: root });

    expect(creds).not.toBeNull();
    expect(creds?.env).toEqual({
      LONGBRIDGE_APP_KEY: "key-1",
      LONGBRIDGE_APP_SECRET: "shh$ecret",
      LONGBRIDGE_ACCESS_TOKEN: "token-1"
    });
    expect(creds?.env.SOME_UNRELATED_KEY).toBeUndefined();
    expect(creds?.cachePaths.home).toBe(join(root, "member_1", ".longbridge-home"));
    expect(creds?.cachePaths.rateLimitDir).toBe(join(root, "member_1", "rate-limit"));
    expect(existsSync(creds!.cachePaths.home)).toBe(true);
    expect(existsSync(creds!.cachePaths.rateLimitDir)).toBe(true);
    expect(statSync(creds!.cachePaths.home).mode & 0o077).toBe(0);
    expect(statSync(creds!.cachePaths.rateLimitDir).mode & 0o077).toBe(0);
  });

  it("returns no warnings for an owner-only (0600) credentials file", () => {
    const root = makeRoot();
    writeMemberEnv(root, "member_1", "LONGBRIDGE_ACCESS_TOKEN=token-1", 0o600);

    const creds = loadMemberCredentials("member_1", { rootDir: root });
    expect(creds).not.toBeNull();
  });

  it("fails closed when the credentials file is readable by group/other", () => {
    const root = makeRoot();
    writeMemberEnv(root, "member_1", "LONGBRIDGE_ACCESS_TOKEN=token-1", 0o644);

    expect(() => loadMemberCredentials("member_1", { rootDir: root })).toThrow(/permission|0600/iu);
  });

  it("rejects symlink credential files instead of following them", () => {
    const root = makeRoot();
    const target = writeMemberEnv(root, "target", "LONGBRIDGE_ACCESS_TOKEN=target-token");
    const memberDir = join(root, "member_symlink");
    mkdirSync(memberDir, { mode: 0o700 });
    chmodSync(memberDir, 0o700);
    symlinkSync(target, join(memberDir, "longbridge.env"));

    expect(() => loadMemberCredentials("member_symlink", { rootDir: root })).toThrow(/regular file|symlink/iu);
  });

  it("rejects a member directory that is not owner-only", () => {
    const root = makeRoot();
    writeMemberEnv(root, "member_open", "LONGBRIDGE_ACCESS_TOKEN=token-open");
    chmodSync(join(root, "member_open"), 0o755);

    expect(() => loadMemberCredentials("member_open", { rootDir: root })).toThrow(/permission|0700/iu);
  });

  it("rejects a credentials root that is not owner-only", () => {
    const root = makeRoot();
    writeMemberEnv(root, "member_open_root", "LONGBRIDGE_ACCESS_TOKEN=token-open");
    chmodSync(root, 0o755);

    expect(() => loadMemberCredentials("member_open_root", { rootDir: root })).toThrow(/permission|0700/iu);
  });

  it("rejects a symlink credentials root instead of traversing it", () => {
    const parent = makeRoot();
    const target = makeRoot();
    writeMemberEnv(target, "member_linked_root", "LONGBRIDGE_ACCESS_TOKEN=token-linked");
    const linkedRoot = join(parent, "credentials-link");
    symlinkSync(target, linkedRoot);

    expect(() => loadMemberCredentials("member_linked_root", { rootDir: linkedRoot })).toThrow(/real directory|symlink/iu);
  });

  it("two members get independently isolated cache paths", () => {
    const root = makeRoot();
    writeMemberEnv(root, "member_a", "LONGBRIDGE_ACCESS_TOKEN=token-a");
    writeMemberEnv(root, "member_b", "LONGBRIDGE_ACCESS_TOKEN=token-b");

    const credsA = loadMemberCredentials("member_a", { rootDir: root });
    const credsB = loadMemberCredentials("member_b", { rootDir: root });

    expect(credsA?.cachePaths.home).not.toBe(credsB?.cachePaths.home);
    expect(credsA?.cachePaths.rateLimitDir).not.toBe(credsB?.cachePaths.rateLimitDir);
    expect(credsA?.env.LONGBRIDGE_ACCESS_TOKEN).toBe("token-a");
    expect(credsB?.env.LONGBRIDGE_ACCESS_TOKEN).toBe("token-b");
  });

  it("rejects a member id that could escape the credentials root", () => {
    const root = makeRoot();
    expect(() => loadMemberCredentials("../outside", { rootDir: root })).toThrow(/member id/i);
  });
});

describe("buildMemberSubprocessEnv: fresh env object, HOME/rate-limit override, global process.env untouched", () => {
  it("never mutates the global process.env object", () => {
    const root = makeRoot();
    writeMemberEnv(root, "member_1", "LONGBRIDGE_ACCESS_TOKEN=member-token");
    const creds = loadMemberCredentials("member_1", { rootDir: root })!;

    const originalHome = process.env.HOME;
    const originalToken = process.env.LONGBRIDGE_ACCESS_TOKEN;
    const originalKeys = new Set(Object.keys(process.env));

    const subprocessEnv = buildMemberSubprocessEnv(creds);

    // The returned object is a DIFFERENT object from process.env.
    expect(subprocessEnv).not.toBe(process.env);
    // process.env itself is completely unaffected by building the subprocess env.
    expect(process.env.HOME).toBe(originalHome);
    expect(process.env.LONGBRIDGE_ACCESS_TOKEN).toBe(originalToken);
    expect(new Set(Object.keys(process.env))).toEqual(originalKeys);
  });

  it("overrides HOME to the member's isolated cache home", () => {
    const root = makeRoot();
    writeMemberEnv(root, "member_1", "LONGBRIDGE_ACCESS_TOKEN=member-token");
    const creds = loadMemberCredentials("member_1", { rootDir: root })!;

    const subprocessEnv = buildMemberSubprocessEnv(creds);

    expect(subprocessEnv.HOME).toBe(creds.cachePaths.home);
    expect(subprocessEnv.HOME).not.toBe(process.env.HOME);
  });

  it("carries the member's own LONGBRIDGE_* credentials and the isolated rate-limit dir", () => {
    const root = makeRoot();
    writeMemberEnv(root, "member_1", "LONGBRIDGE_ACCESS_TOKEN=member-token\nLONGBRIDGE_APP_KEY=member-key");
    const creds = loadMemberCredentials("member_1", { rootDir: root })!;

    const subprocessEnv = buildMemberSubprocessEnv(creds);

    expect(subprocessEnv.LONGBRIDGE_ACCESS_TOKEN).toBe("member-token");
    expect(subprocessEnv.LONGBRIDGE_APP_KEY).toBe("member-key");
    expect(subprocessEnv.LONGBRIDGE_RATE_LIMIT_DIR).toBe(creds.cachePaths.rateLimitDir);
  });

  it("two members' subprocess envs never leak each other's credentials", () => {
    const root = makeRoot();
    writeMemberEnv(root, "member_a", "LONGBRIDGE_ACCESS_TOKEN=token-a");
    writeMemberEnv(root, "member_b", "LONGBRIDGE_ACCESS_TOKEN=token-b");
    const credsA = loadMemberCredentials("member_a", { rootDir: root })!;
    const credsB = loadMemberCredentials("member_b", { rootDir: root })!;

    const envA = buildMemberSubprocessEnv(credsA);
    const envB = buildMemberSubprocessEnv(credsB);

    expect(envA.LONGBRIDGE_ACCESS_TOKEN).toBe("token-a");
    expect(envB.LONGBRIDGE_ACCESS_TOKEN).toBe("token-b");
    expect(envA.HOME).not.toBe(envB.HOME);
  });

  it("strips every ambient Longbridge/Longport credential before applying the member file", () => {
    const root = makeRoot();
    writeMemberEnv(root, "member_1", "LONGBRIDGE_ACCESS_TOKEN=member-token");
    const creds = loadMemberCredentials("member_1", { rootDir: root })!;
    const original = { ...process.env };
    process.env.LONGBRIDGE_ACCESS_TOKEN = "global-token";
    process.env.LONGPORT_ACCESS_TOKEN = "global-longport-token";
    process.env.LONGBRIDGE_OPENAPI_TOKEN_PATH = "/tmp/global-token-file";
    try {
      const subprocessEnv = buildMemberSubprocessEnv(creds);
      expect(subprocessEnv.LONGBRIDGE_ACCESS_TOKEN).toBe("member-token");
      expect(subprocessEnv.LONGPORT_ACCESS_TOKEN).toBeUndefined();
      expect(subprocessEnv.LONGBRIDGE_OPENAPI_TOKEN_PATH).toBeUndefined();
    } finally {
      process.env = original;
    }
  });

  it("fails closed when a member file has no member-specific access token", () => {
    const root = makeRoot();
    writeMemberEnv(root, "member_1", "LONGBRIDGE_APP_KEY=member-key");
    const creds = loadMemberCredentials("member_1", { rootDir: root })!;
    const original = { ...process.env };
    process.env.LONGBRIDGE_ACCESS_TOKEN = "global-token-must-not-fall-through";
    try {
      expect(() => buildMemberSubprocessEnv(creds)).toThrow(/access token/iu);
    } finally {
      process.env = original;
    }
  });
});
