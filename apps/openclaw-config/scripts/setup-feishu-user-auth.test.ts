// Task H7 (2026-07-14 legacy audit): updateEnvFile used to write every
// value unquoted - an oauth run writes LARK_UAT_SCOPE (~20 space-separated
// scopes) and LARK_COOKIE (a `k=v; k=v` string) as bare KEY=value lines,
// which corrupts .env.local for `source` (install-launchd.sh) and silently
// truncates on load. This is the first direct test coverage this module
// has ever had (isMainModule guard added by this task made it importable).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const setupFeishuUserAuth = await import("./setup-feishu-user-auth.mjs");

const tempDirs: string[] = [];

function makeEnvFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-feishu-env-"));
  tempDirs.push(dir);
  const path = join(dir, ".env.local");
  writeFileSync(path, content, "utf8");
  return path;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("setup-feishu-user-auth.mjs env round trip (task H7)", () => {
  it("writes a space-separated scope value quoted so `source` does not choke on it", () => {
    const path = makeEnvFile("LARK_APP_ID=cli_abc\nLARK_APP_SECRET=shhh\n# a comment\n");

    setupFeishuUserAuth.updateEnvFile(path, {
      LARK_USER_ACCESS_TOKEN: "u-abc123",
      LARK_UAT_SCOPE: "offline_access auth:user.id:read im:message"
    });

    const written = readFileSync(path, "utf8");
    expect(written).toContain("LARK_APP_ID=cli_abc");
    expect(written).toContain("LARK_APP_SECRET=shhh");
    expect(written).toContain("# a comment");
    expect(written).toContain("LARK_UAT_SCOPE='offline_access auth:user.id:read im:message'");

    const reloaded = setupFeishuUserAuth.loadEnvFile(path);
    expect(reloaded.LARK_UAT_SCOPE).toBe("offline_access auth:user.id:read im:message");
    expect(reloaded.LARK_USER_ACCESS_TOKEN).toBe("u-abc123");
  });

  it("writes a cookie string (semicolons, spaces) so it reads back byte-identical after a round trip", () => {
    const path = makeEnvFile("LARK_APP_ID=cli_abc\n");
    const cookie = "session=abc123; sl_session=def456; other=with space";

    setupFeishuUserAuth.updateEnvFile(path, { LARK_COOKIE: cookie });
    expect(setupFeishuUserAuth.loadEnvFile(path).LARK_COOKIE).toBe(cookie);

    // A second write (simulating a repeated oauth run) must not double-escape.
    setupFeishuUserAuth.updateEnvFile(path, { LARK_COOKIE: cookie });
    expect(setupFeishuUserAuth.loadEnvFile(path).LARK_COOKIE).toBe(cookie);
    expect(readFileSync(path, "utf8")).not.toContain("\\\\");
  });

  it("does not touch unrelated lines (comments, other keys) when updating one key - the exact H7 bug (whole-file dequoting)", () => {
    const original = [
      "# preserved comment",
      "LARK_APP_ID=cli_abc",
      "LARK_APP_SECRET='shh$ecret'",
      "OPENCLAW_GATEWAY_TOKEN='abc$def'",
      "LONGBRIDGE_ACCOUNT_MODE=paper",
      ""
    ].join("\n");
    const path = makeEnvFile(original);

    setupFeishuUserAuth.updateEnvFile(path, { LARK_USER_ACCESS_TOKEN: "u-new" });

    const written = readFileSync(path, "utf8");
    expect(written).toContain("# preserved comment");
    expect(written).toContain("LARK_APP_ID=cli_abc");
    // Previously these would have been silently DE-QUOTED to
    // LARK_APP_SECRET=shh$ecret / OPENCLAW_GATEWAY_TOKEN=abc$def once the
    // caller spread {...currentEnv, ...updates} into updateEnvFile.
    expect(written).toContain("LARK_APP_SECRET='shh$ecret'");
    expect(written).toContain("OPENCLAW_GATEWAY_TOKEN='abc$def'");
    expect(written).toContain("LONGBRIDGE_ACCOUNT_MODE=paper");
  });

  it("loadEnvFile returns {} for a missing file instead of throwing", () => {
    const path = join(tmpdir(), "openclaw-feishu-env-does-not-exist", ".env.local");
    expect(setupFeishuUserAuth.loadEnvFile(path)).toEqual({});
  });
});
