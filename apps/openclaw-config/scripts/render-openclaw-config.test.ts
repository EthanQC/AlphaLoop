import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(join(process.cwd(), "apps/openclaw-config/scripts/render-openclaw-config.mjs"), "utf8");

describe("OpenClaw Feishu mention config", () => {
  it("keeps mention required but accepts Chinese bot aliases in allowlisted groups", () => {
    expect(script).toContain("mentionPatterns");
    expect(script).toContain("\"@Trading Copilot\"");
    expect(script).toContain("\"@机器人\"");
    expect(script).toContain("\"@交易机器人\"");
  });
});
