// Task H7 (2026-07-14 legacy audit): round-trip test explicitly required by
// the plan - a realistic .env.local (comments + quoted values + $-values)
// with one key updated must leave everything else identical.
import { describe, expect, it } from "vitest";

import { applyEnvUpdates, formatEnvValue, parseEnvText, parseEnvValue } from "./env-file.mjs";

const REALISTIC_ENV_FILE = `# AlphaLoop local secrets - copied from .env.local.example
# Do not commit this file.

LARK_APP_ID=cli_abc123
LARK_APP_SECRET='shh$ecret'
# Feishu bot webhook token
FEISHU_NOTIFY_CHAT_ID=oc_deadbeef

LARK_COOKIE='session=abc; sl_session=def; other=with space'
OPENCLAW_GATEWAY_TOKEN='abc$def'

# trailing comment
LONGBRIDGE_ACCOUNT_MODE=paper
`;

describe("env-file round trip (task H7)", () => {
  it("updating one key leaves every other line byte-for-byte identical", () => {
    const updated = applyEnvUpdates(REALISTIC_ENV_FILE, { LARK_APP_ID: "cli_xyz999" });
    const originalLines = REALISTIC_ENV_FILE.split("\n");
    const updatedLines = updated.split("\n");

    expect(updatedLines).toHaveLength(originalLines.length);
    for (let i = 0; i < originalLines.length; i += 1) {
      if (originalLines[i].startsWith("LARK_APP_ID=")) {
        expect(updatedLines[i]).toBe("LARK_APP_ID=cli_xyz999");
      } else {
        expect(updatedLines[i]).toBe(originalLines[i]);
      }
    }
  });

  it("preserves comments, blank lines, and pre-existing quoted/$-containing values untouched", () => {
    const updated = applyEnvUpdates(REALISTIC_ENV_FILE, { FEISHU_NOTIFY_CHAT_ID: "oc_newvalue" });

    expect(updated).toContain("# AlphaLoop local secrets - copied from .env.local.example");
    expect(updated).toContain("# Do not commit this file.");
    expect(updated).toContain("# Feishu bot webhook token");
    expect(updated).toContain("# trailing comment");
    // untouched keys keep their EXACT original quoting/content, including $
    expect(updated).toContain("LARK_APP_SECRET='shh$ecret'");
    expect(updated).toContain("LARK_COOKIE='session=abc; sl_session=def; other=with space'");
    expect(updated).toContain("OPENCLAW_GATEWAY_TOKEN='abc$def'");
    expect(updated).toContain("LONGBRIDGE_ACCOUNT_MODE=paper");
  });

  it("quotes a newly-written value containing spaces/$ so it round-trips through shell `source`", () => {
    const updated = applyEnvUpdates(REALISTIC_ENV_FILE, {
      LARK_UAT_SCOPE: "offline_access auth:user.id:read im:message",
      OPENCLAW_GATEWAY_TOKEN: "abc$def"
    });

    // The scope line must not be bare (would `source` as multiple tokens);
    // the $-containing value must not be bare double-quoted (would still
    // shell-expand $def) - both must be safely single-quoted.
    expect(updated).toContain("LARK_UAT_SCOPE='offline_access auth:user.id:read im:message'");
    expect(updated).toContain("OPENCLAW_GATEWAY_TOKEN='abc$def'");
  });

  it("appends a genuinely new key without disturbing anything else", () => {
    const updated = applyEnvUpdates(REALISTIC_ENV_FILE, { LARK_USER_ACCESS_TOKEN: "u-abc123" });

    expect(updated.startsWith(REALISTIC_ENV_FILE.trimEnd())).toBe(true);
    expect(updated).toContain("LARK_USER_ACCESS_TOKEN=u-abc123");
  });

  it("round-trips parseEnvValue(formatEnvValue(x)) === x for values with spaces, quotes, and $", () => {
    for (const value of [
      "simple",
      "with space",
      "abc$def",
      "it's got a quote",
      "k=v; k2=v2; k3=with space",
      ""
    ]) {
      expect(parseEnvValue(formatEnvValue(value))).toBe(value);
    }
  });

  it("parseEnvText decodes every value using the same rules, including legacy double-quoted (JSON.stringify-style) lines", () => {
    const legacyStyle = 'LARK_COOKIE="session=abc; with space"\nPLAIN=value\n';
    const parsed = parseEnvText(legacyStyle);
    expect(parsed.LARK_COOKIE).toBe("session=abc; with space");
    expect(parsed.PLAIN).toBe("value");
  });

  it("a full read -> update -> write -> read cycle is idempotent (no double-escaping on repeated runs)", () => {
    let text = REALISTIC_ENV_FILE;
    for (let i = 0; i < 3; i += 1) {
      text = applyEnvUpdates(text, { OPENCLAW_GATEWAY_TOKEN: "abc$def" });
    }
    expect(parseEnvText(text).OPENCLAW_GATEWAY_TOKEN).toBe("abc$def");
    expect(text).toContain("OPENCLAW_GATEWAY_TOKEN='abc$def'");
    expect(text).not.toContain("\\\\");
  });
});
