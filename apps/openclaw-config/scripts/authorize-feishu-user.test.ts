// Task H7 (2026-07-14 legacy audit): the old writeEnv fully rewrote
// .env.local from a parsed key/value map on every `pnpm feishu:authorize-user`
// run - destroying every comment, reordering every key, DE-QUOTING every
// pre-quoted value (loadEnv stripped quotes without reversing any
// escaping), and double-escaping quoted values on repeated runs. This is
// the first direct test coverage this module has ever had (isMainModule
// guard added by this task made it importable without running the real
// allowlist write / render-openclaw-config.mjs / install-launchd.sh).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const authorizeFeishuUser = await import("./authorize-feishu-user.mjs");

const tempDirs: string[] = [];

function makeEnvFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-authorize-env-"));
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

describe("computeAuthorizeEnvUpdates: pure logic", () => {
  it("appends the new open id to an empty allowlist and flips the default pairing policy to allowlist", () => {
    const { allowFrom, updates } = authorizeFeishuUser.computeAuthorizeEnvUpdates({}, "ou_new123");
    expect(allowFrom).toEqual(["ou_new123"]);
    expect(updates).toEqual({ FEISHU_ALLOW_FROM: "ou_new123", FEISHU_DM_POLICY: "allowlist" });
  });

  it("keeps existing allowlist entries and does not touch an already-explicit non-pairing policy", () => {
    const { allowFrom, updates } = authorizeFeishuUser.computeAuthorizeEnvUpdates(
      { FEISHU_ALLOW_FROM: "ou_existing", FEISHU_DM_POLICY: "open" },
      "ou_new123"
    );
    expect(allowFrom).toEqual(["ou_existing", "ou_new123"]);
    expect(updates).toEqual({ FEISHU_ALLOW_FROM: "ou_existing,ou_new123" });
  });
});

describe("applyAuthorizeEnvUpdate: minimal-edit env round trip (task H7)", () => {
  it("only touches FEISHU_ALLOW_FROM/FEISHU_DM_POLICY - every other line survives byte-for-byte, including quotes/comments/$-values", () => {
    const original = [
      "# AlphaLoop local secrets",
      "LARK_APP_SECRET='shh$ecret'",
      "OPENCLAW_GATEWAY_TOKEN='abc$def'",
      "LARK_COOKIE='session=abc; sl_session=def'",
      "LONGBRIDGE_ACCOUNT_MODE=paper",
      "FEISHU_ALLOW_FROM=ou_member1",
      ""
    ].join("\n");
    const path = makeEnvFile(original);

    const { allowFrom } = authorizeFeishuUser.applyAuthorizeEnvUpdate(path, "ou_member2");

    expect(allowFrom).toEqual(["ou_member1", "ou_member2"]);
    const written = readFileSync(path, "utf8");
    expect(written).toContain("# AlphaLoop local secrets");
    expect(written).toContain("LARK_APP_SECRET='shh$ecret'");
    expect(written).toContain("OPENCLAW_GATEWAY_TOKEN='abc$def'");
    expect(written).toContain("LARK_COOKIE='session=abc; sl_session=def'");
    expect(written).toContain("LONGBRIDGE_ACCOUNT_MODE=paper");
    expect(written).toContain("FEISHU_ALLOW_FROM=ou_member1,ou_member2");
  });

  it("does not double-escape a $-containing value across repeated authorize runs", () => {
    const path = makeEnvFile("OPENCLAW_GATEWAY_TOKEN='abc$def'\n");

    authorizeFeishuUser.applyAuthorizeEnvUpdate(path, "ou_member1");
    authorizeFeishuUser.applyAuthorizeEnvUpdate(path, "ou_member2");
    authorizeFeishuUser.applyAuthorizeEnvUpdate(path, "ou_member3");

    const written = readFileSync(path, "utf8");
    expect(written).toContain("OPENCLAW_GATEWAY_TOKEN='abc$def'");
    expect(written).not.toContain("\\\\");
    expect(written).toContain("FEISHU_ALLOW_FROM=ou_member1,ou_member2,ou_member3");
  });

  it("appends FEISHU_ALLOW_FROM/FEISHU_DM_POLICY when the file has neither yet", () => {
    const path = makeEnvFile("LARK_APP_ID=cli_abc\n");

    authorizeFeishuUser.applyAuthorizeEnvUpdate(path, "ou_member1");

    const written = readFileSync(path, "utf8");
    expect(written).toContain("LARK_APP_ID=cli_abc");
    expect(written).toContain("FEISHU_ALLOW_FROM=ou_member1");
    expect(written).toContain("FEISHU_DM_POLICY=allowlist");
  });
});
