import { describe, expect, it } from "vitest";

// @ts-expect-error - .mjs CLI helper without type declarations
import { buildNextConfig } from "./render-openclaw-config.mjs";

function makeExisting() {
  return {
    mcp: { servers: { foo: {} } },
    skills: { load: { extraDirs: ["/x"] } },
    tools: { exec: {} },
    wizard: { lastRunAt: "2026-06-04T03:32:27.411Z" },
    auth: { some: "token" },
    agents: {
      defaults: { userTimezone: "America/New_York", customKey: "keep-me" },
      list: [
        { id: "main", name: "Main" },
        { id: "security-engineer", name: "security-engineer" },
        { id: "control", name: "OLD control" }
      ]
    },
    channels: { slack: { enabled: true } },
    plugins: {
      allow: ["custom-plugin"],
      entries: { "custom-plugin": { enabled: true } }
    }
  };
}

describe("buildNextConfig non-destructive merge", () => {
  it("preserves existing top-level and nested keys while upserting AlphaLoop's control agent", () => {
    const existing = makeExisting();
    const output = buildNextConfig({ existing, env: {}, processEnv: {}, repoRoot: "/repo" });

    // Top-level keys the old code dropped must survive untouched.
    expect(output.mcp).toEqual(existing.mcp);
    expect(output.skills).toEqual(existing.skills);
    expect(output.tools).toEqual(existing.tools);
    expect(output.wizard).toEqual(existing.wizard);

    // Feishu is disabled (no creds) - existing channels must survive.
    expect(output.channels.slack).toEqual({ enabled: true });
    expect(output.channels.feishu).toBeUndefined();

    // Plugins: custom entry + allow preserved.
    expect(output.plugins.entries["custom-plugin"]).toEqual({ enabled: true });
    expect(output.plugins.allow).toContain("custom-plugin");

    // Agents list: both non-control agents kept, exactly one control (AlphaLoop's).
    const ids = output.agents.list.map((agent: { id: string }) => agent.id);
    expect(ids).toContain("main");
    expect(ids).toContain("security-engineer");
    const controls = output.agents.list.filter((agent: { id: string }) => agent.id === "control");
    expect(controls).toHaveLength(1);
    expect(controls[0].name).toBe("Trading Control");
    expect(controls[0].groupChat.mentionPatterns).toEqual(
      expect.arrayContaining(["@Trading Copilot", "@机器人", "@交易机器人"])
    );

    // Defaults merge: existing extra key preserved, AlphaLoop override wins.
    expect(output.agents.defaults.customKey).toBe("keep-me");
    expect(output.agents.defaults.userTimezone).toBe("Asia/Shanghai");
  });

  it("merges feishu into existing channels without dropping them when creds are provided", () => {
    const existing = makeExisting();
    const output = buildNextConfig({
      existing,
      env: { FEISHU_APP_ID: "cli_app_123", FEISHU_APP_SECRET: "secret_456" },
      processEnv: {},
      repoRoot: "/repo"
    });

    expect(output.channels.feishu.accounts.main.appId).toBe("cli_app_123");
    // Existing channels must still be present alongside feishu.
    expect(output.channels.slack).toEqual({ enabled: true });
  });
});
