// Phase 6 Task 6 (2026-07-15 plan): direct tests for the multi-account
// credential loader - present/missing/wide-perms-warning/env isolation.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildMemberSubprocessEnv,
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
  mkdirSync(memberDir, { recursive: true });
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
  });

  it("returns no warnings for an owner-only (0600) credentials file", () => {
    const root = makeRoot();
    writeMemberEnv(root, "member_1", "LONGBRIDGE_ACCESS_TOKEN=token-1", 0o600);

    const creds = loadMemberCredentials("member_1", { rootDir: root });
    expect(creds?.warnings).toBeUndefined();
  });

  it("warns (but does not block) when the credentials file is readable by group/other", () => {
    const root = makeRoot();
    writeMemberEnv(root, "member_1", "LONGBRIDGE_ACCESS_TOKEN=token-1", 0o644);

    const creds = loadMemberCredentials("member_1", { rootDir: root });

    expect(creds).not.toBeNull();
    expect(creds?.env.LONGBRIDGE_ACCESS_TOKEN).toBe("token-1");
    expect(creds?.warnings?.length).toBeGreaterThan(0);
    expect(creds?.warnings?.[0]).toMatch(/权限过宽/u);
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
});
