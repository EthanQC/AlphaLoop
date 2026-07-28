import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CLOUDFLARED_CANDIDATE_PATHS,
  SYSTEM_TUNNEL_DAEMON_LABEL,
  SYSTEM_TUNNEL_DAEMON_PLIST,
  TUNNEL_LABEL,
  buildLaunchdPath,
  buildTunnelPlist,
  describeSystemDaemonConflict,
  resolveTunnelToken
} from "./install-cloudflared-tunnel.mjs";

const script = readFileSync(
  join(process.cwd(), "apps/openclaw-config/scripts/install-cloudflared-tunnel.mjs"),
  "utf8"
);

const TOKEN = "eyJhIjoiYWJjMTIzIiwidCI6InR1bm5lbC1pZCIsInMiOiJzZWNyZXQifQ==";

/**
 * H3 (2026-07-28, round-5): this file left the typecheck backlog, and all five
 * of its errors were this one signature.
 *
 * `resolveTunnelToken({ argv = [], env = {}, envFileText = "" } = {})` is plain
 * JS, and TypeScript infers a parameter's type from its destructuring default:
 * `[]` becomes `never[]` and `{}` becomes a bag with no properties, so every
 * real argument read as "string is not assignable to never".
 *
 * This declares the contract the .mjs implements instead of casting to `any`.
 * Be precise about what it buys: it typechecks this file's CALL SITES against
 * the shape below - it cannot verify the .mjs still has that shape, since
 * checkJs is off for the scripts directory. The lasting fix is JSDoc types on
 * install-cloudflared-tunnel.mjs itself, which belongs to the install-script
 * owner, not to this file.
 */
const resolveToken = resolveTunnelToken as (input?: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  envFileText?: string;
  // `null` when no source supplies one - see the "returns null" case below.
}) => string | null;

describe("resolveTunnelToken", () => {
  it("prefers the --token argv flag over env and .env.local", () => {
    expect(
      resolveToken({
        argv: ["--token", "argv-token"],
        env: { CF_TUNNEL_TOKEN: "env-token" },
        envFileText: "CF_TUNNEL_TOKEN=file-token\n"
      })
    ).toBe("argv-token");
  });

  it("falls back to env.CF_TUNNEL_TOKEN, then to the .env.local text", () => {
    expect(
      resolveToken({
        env: { CF_TUNNEL_TOKEN: "env-token" },
        envFileText: "CF_TUNNEL_TOKEN=file-token\n"
      })
    ).toBe("env-token");
    expect(resolveToken({ envFileText: "CF_TUNNEL_TOKEN=file-token\n" })).toBe("file-token");
  });

  it("ignores an empty env value and still reads .env.local", () => {
    expect(
      resolveToken({
        env: { CF_TUNNEL_TOKEN: "  " },
        envFileText: "CF_TUNNEL_TOKEN=file-token\n"
      })
    ).toBe("file-token");
  });

  it("returns null when no source provides a token", () => {
    expect(resolveToken({})).toBeNull();
    expect(resolveToken({ envFileText: "# nothing here\nOTHER=1\n" })).toBeNull();
  });

  it("trims surrounding whitespace from the token", () => {
    expect(resolveToken({ env: { CF_TUNNEL_TOKEN: `  ${TOKEN}\n` } })).toBe(TOKEN);
  });

  it("throws when --token is given without a value", () => {
    expect(() => resolveToken({ argv: ["--token"] })).toThrow(/without a value/u);
    expect(() => resolveToken({ argv: ["--token", "--dry-run"] })).toThrow(/without a value/u);
  });

  it("throws on a token with interior whitespace (mispaste) instead of installing it", () => {
    expect(() =>
      resolveToken({ env: { CF_TUNNEL_TOKEN: "eyJhIjoi YWJjMTIz" } })
    ).toThrow(/malformed/u);
  });
});

describe("buildTunnelPlist", () => {
  const plist = buildTunnelPlist({
    cloudflaredBin: "/opt/homebrew/bin/cloudflared",
    token: TOKEN,
    logDir: "/repo/runtime/launchd",
    pathEnv: buildLaunchdPath(["/opt/homebrew/bin"]),
    workingDirectory: "/repo"
  });

  it("runs exactly `cloudflared tunnel run --token <token>` in order", () => {
    const argumentStrings = [...plist.matchAll(/<string>([^<]*)<\/string>/gu)].map((m) => m[1]);
    const binIndex = argumentStrings.indexOf("/opt/homebrew/bin/cloudflared");
    expect(binIndex).toBeGreaterThan(-1);
    expect(argumentStrings.slice(binIndex, binIndex + 5)).toEqual([
      "/opt/homebrew/bin/cloudflared",
      "tunnel",
      "run",
      "--token",
      TOKEN
    ]);
  });

  it("keeps the connector alive across crashes and login (RunAtLoad + KeepAlive)", () => {
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
  });

  it("logs under runtime/launchd and pins a PATH containing Homebrew", () => {
    expect(plist).toContain(`/repo/runtime/launchd/${TUNNEL_LABEL}.out.log`);
    expect(plist).toContain(`/repo/runtime/launchd/${TUNNEL_LABEL}.err.log`);
    expect(plist).toMatch(/<key>PATH<\/key>\s*<string>[^<]*\/opt\/homebrew\/bin/u);
  });

  it("XML-escapes untrusted values so a hostile token cannot break the plist", () => {
    const hostile = buildTunnelPlist({
      cloudflaredBin: "/opt/homebrew/bin/cloudflared",
      token: 'abc&<>"def',
      logDir: "/repo/runtime/launchd",
      pathEnv: "/usr/bin",
      workingDirectory: "/repo"
    });
    expect(hostile).toContain("abc&amp;&lt;&gt;&quot;def");
    expect(hostile).not.toContain('abc&<>"def');
  });
});

describe("buildLaunchdPath", () => {
  it("puts extra dirs first, dedupes, and always includes the standard fallbacks", () => {
    const path = buildLaunchdPath(["/x/bin", "/opt/homebrew/bin"], "/x/bin:/usr/bin");
    const parts = path.split(":");
    expect(parts[0]).toBe("/x/bin");
    expect(parts.filter((p) => p === "/x/bin")).toHaveLength(1);
    expect(parts).toContain("/opt/homebrew/bin");
    expect(parts).toContain("/usr/local/bin");
    expect(parts).toContain("/usr/bin");
  });
});

describe("cloudflared tunnel installer script contract", () => {
  it("installs a user LaunchAgent under ~/Library/LaunchAgents with the launchctl cycle", () => {
    expect(script).toContain('"Library", "LaunchAgents"');
    expect(script).toContain('"bootout"');
    expect(script).toContain('"bootstrap"');
    expect(script).toContain('"enable"');
  });

  it("locks the plist down to owner-only permissions (the token lives inside it)", () => {
    expect(script).toContain("mode: 0o600");
    expect(script).toContain("chmodSync(plistPath, 0o600)");
  });

  it("checks Homebrew's Apple Silicon path for cloudflared and can brew-install it", () => {
    expect(CLOUDFLARED_CANDIDATE_PATHS).toContain("/opt/homebrew/bin/cloudflared");
    expect(script).toContain('["install", "cloudflared"]');
  });

  it("never prints the token: the success JSON payload carries no token field", () => {
    const successPayload = script.slice(
      script.indexOf("installed: true"),
      script.indexOf("}, null, 2))", script.indexOf("installed: true"))
    );
    expect(successPayload).toContain("plistPath");
    expect(successPayload).not.toMatch(/token/iu);
  });

  it("supports --dry-run readiness reporting and only runs effects as a main module", () => {
    expect(script).toContain('"--dry-run"');
    expect(script).toContain("isMainModule");
  });

  // The refusal must be decided before ensureCloudflaredInstalled(), which
  // shells out to `brew install`: aborting the install is not allowed to
  // leave a package behind on a machine we then refused to touch.
  it("checks for the system daemon before any brew install or plist write", () => {
    const conflictIndex = script.indexOf("const conflict = describeSystemDaemonConflict");
    expect(conflictIndex).toBeGreaterThan(-1);
    expect(conflictIndex).toBeLessThan(script.indexOf("ensureCloudflaredInstalled()", conflictIndex));
    expect(conflictIndex).toBeLessThan(script.indexOf("writeFileSync(plistPath"));
  });
});

// The mini runs the OTHER connector shape: a root-owned system LaunchDaemon
// com.cloudflare.cloudflared (named tunnel, /etc/cloudflared/config.yml)
// serving the public reports host. Its label differs from this installer's,
// so launchd would run both side by side rather than one replacing the
// other - hence a refusal rather than an overwrite.
describe("describeSystemDaemonConflict", () => {
  it("refuses when the system cloudflared daemon is already installed", () => {
    const message = describeSystemDaemonConflict({ systemDaemonPresent: true });
    expect(message).toContain(SYSTEM_TUNNEL_DAEMON_LABEL);
    expect(message).toContain(SYSTEM_TUNNEL_DAEMON_PLIST);
    expect(message).toContain("--force");
  });

  it("allows the install when no system daemon is present", () => {
    expect(describeSystemDaemonConflict({ systemDaemonPresent: false })).toBeNull();
  });

  it("lets --force override the refusal for a deliberate second connector", () => {
    expect(describeSystemDaemonConflict({ systemDaemonPresent: true, force: true })).toBeNull();
  });

  it("defaults to allowing, so the guard can never fire on a missing argument", () => {
    expect(describeSystemDaemonConflict()).toBeNull();
  });

  it("names the two labels distinctly, which is why both can run at once", () => {
    expect(SYSTEM_TUNNEL_DAEMON_LABEL).not.toBe(TUNNEL_LABEL);
    expect(SYSTEM_TUNNEL_DAEMON_PLIST).toBe("/Library/LaunchDaemons/com.cloudflare.cloudflared.plist");
  });
});
