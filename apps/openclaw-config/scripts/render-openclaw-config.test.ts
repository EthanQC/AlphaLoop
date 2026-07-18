import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error - .mjs CLI helper without type declarations
import { buildNextConfig, installControlPersona } from "./render-openclaw-config.mjs";

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
    // OpenClaw 2026.7+ needs explicit plugin trust for the external feishu
    // channel plugin - without entries.feishu.enabled=true the gateway logs
    // "installed without explicit trust" and the channel stays down
    // (observed live on the mini, 2026-07-18).
    expect(output.plugins.entries.feishu).toEqual({ enabled: true });
  });

  it("enables the gateway chat-completions endpoint the three real backends depend on", () => {
    const output = buildNextConfig({ existing: {}, env: {}, processEnv: {}, repoRoot: "/repo" });
    expect(output.gateway.http.endpoints.chatCompletions).toEqual({ enabled: true });
  });

  it("does NOT emit a feishu plugin entry when feishu creds are absent", () => {
    const output = buildNextConfig({ existing: {}, env: {}, processEnv: {}, repoRoot: "/repo" });
    expect(output.plugins.entries.feishu).toBeUndefined();
  });
});

describe("FIX 1: plugins.allow exclusive-allowlist safety", () => {
  it("does NOT introduce an allow list when the existing config had none (real MacBook case)", () => {
    // Mirrors the real ~/.openclaw/openclaw.json: ONLY entries-enabled plugins,
    // no plugins.allow key. Introducing an allowlist here would silently disable
    // memoryd-openclaw AND every bundled default-on plugin (exclusive allowlist).
    const existing = {
      plugins: {
        entries: { "memoryd-openclaw": { enabled: true } },
        slots: { memory: "memory-core" }
      }
    };
    const output = buildNextConfig({ existing, env: {}, processEnv: {}, repoRoot: "/repo" });

    // No allow list emitted -> bundled defaults + memoryd-openclaw keep loading.
    expect(output.plugins.allow).toBeUndefined();
    // The user's entries-enabled plugin survives untouched.
    expect(output.plugins.entries["memoryd-openclaw"]).toEqual({ enabled: true });
    // AlphaLoop's own plugins still load without allowlisting: acpx/openai auto-
    // activate as named surfaces, memory-core via slot, local-context via entries
    // + load.paths.
    expect(output.plugins.entries.acpx.enabled).toBe(true);
    expect(output.plugins.entries["memory-core"].enabled).toBe(true);
    expect(output.plugins.entries["local-context"].enabled).toBe(true);
    expect(output.plugins.slots.memory).toBe("memory-core");
    expect(output.plugins.load.paths.some((p: string) => p.includes("local-context"))).toBe(true);
  });

  it("merges into an existing allow list (entries + installs + AlphaLoop ids) without dropping the user's plugins", () => {
    const existing = {
      plugins: {
        allow: ["custom-plugin"],
        entries: { "custom-plugin": { enabled: true }, "another-enabled": { enabled: true } },
        installs: { "installed-x": {} }
      }
    };
    const output = buildNextConfig({ existing, env: {}, processEnv: {}, repoRoot: "/repo" });

    expect(Array.isArray(output.plugins.allow)).toBe(true);
    // User's explicit allow entry, their installs key, and their OTHER
    // entries-enabled plugin must all remain in the exclusive allowlist.
    expect(output.plugins.allow).toContain("custom-plugin");
    expect(output.plugins.allow).toContain("installed-x");
    expect(output.plugins.allow).toContain("another-enabled");
    // AlphaLoop's ids are added.
    expect(output.plugins.allow).toEqual(
      expect.arrayContaining(["acpx", "openai", "memory-core", "local-context"])
    );
  });
});

describe("FIX 2: feishu channel is merged, not wholesale-rebuilt", () => {
  function twoGroupExisting() {
    return {
      channels: {
        feishu: {
          enabled: true,
          customFeishuKey: "keep-me",
          groups: {
            groupA: { allowFrom: ["userA"], requireMention: false },
            groupB: { allowFrom: ["userB"], requireMention: true }
          },
          accounts: {
            default: { appId: "users-own-app", appSecret: "users-own-secret", allowFrom: ["defUser"] }
          }
        }
      }
    };
  }

  it("preserves unknown keys, each group verbatim, and the user's own account; upserts only main", () => {
    const existing = twoGroupExisting();
    const before = structuredClone(existing);
    const output = buildNextConfig({
      existing,
      env: { FEISHU_APP_ID: "cli_app_123", FEISHU_APP_SECRET: "secret_456" },
      processEnv: {},
      repoRoot: "/repo"
    });
    const feishu = output.channels.feishu;

    // Unknown key survives.
    expect(feishu.customFeishuKey).toBe("keep-me");
    // Each existing group survives byte-for-byte - NO permission widening.
    expect(feishu.groups.groupA).toEqual({ allowFrom: ["userA"], requireMention: false });
    expect(feishu.groups.groupB).toEqual({ allowFrom: ["userB"], requireMention: true });
    // No new groups were invented (no env groups supplied).
    expect(Object.keys(feishu.groups).sort()).toEqual(["groupA", "groupB"]);
    // User's own account is preserved verbatim; only main is upserted.
    expect(feishu.accounts.default).toEqual(before.channels.feishu.accounts.default);
    expect(feishu.accounts.main.appId).toBe("cli_app_123");
    // No global allowFrom is fabricated from the per-group union (userA/userB
    // must NOT leak into a channel-level allowFrom).
    expect(feishu.allowFrom).toBeUndefined();
    // dmPolicy derives from global allowFrom only -> empty -> pairing.
    expect(feishu.dmPolicy).toBe("pairing");
    // Input object was not mutated.
    expect(existing).toEqual(before);
  });

  it("does not flatten per-group members into other groups or DMs", () => {
    const existing = twoGroupExisting();
    const output = buildNextConfig({
      existing,
      env: { FEISHU_APP_ID: "a", FEISHU_APP_SECRET: "b" },
      processEnv: {},
      repoRoot: "/repo"
    });
    const feishu = output.channels.feishu;
    // userA is allowed ONLY in groupA; must not appear in groupB.
    expect(feishu.groups.groupB.allowFrom).not.toContain("userA");
    // Neither per-group member becomes a global (DM) allow.
    expect(feishu.accounts.main.allowFrom ?? []).not.toContain("userA");
    expect(feishu.accounts.main.allowFrom ?? []).not.toContain("userB");
  });

  it("ADDS an env-supplied group (with env allowFrom) while leaving existing groups intact", () => {
    const existing = twoGroupExisting();
    const output = buildNextConfig({
      existing,
      env: {
        FEISHU_APP_ID: "a",
        FEISHU_APP_SECRET: "b",
        FEISHU_GROUP_ALLOW_FROM: "groupC",
        FEISHU_ALLOW_FROM: "envUser"
      },
      processEnv: {},
      repoRoot: "/repo"
    });
    const feishu = output.channels.feishu;
    // Existing groups untouched.
    expect(feishu.groups.groupA).toEqual({ allowFrom: ["userA"], requireMention: false });
    // New env group added with the env allowFrom + env-default requireMention.
    expect(feishu.groups.groupC.allowFrom).toEqual(["envUser"]);
    expect(feishu.groups.groupC.requireMention).toBe(true);
    // Global allowFrom now reflects the env user (used for DM policy).
    expect(feishu.allowFrom).toContain("envUser");
    expect(feishu.dmPolicy).toBe("allowlist");
  });
});

describe("FIX 3: defensive edges", () => {
  it("throws when existing.agents.list is present but not an array", () => {
    const existing = { agents: { list: { id: "oops-not-an-array" } } };
    expect(() =>
      buildNextConfig({ existing, env: {}, processEnv: {}, repoRoot: "/repo" })
    ).toThrow(/agents\.list must be an array/);
  });

  it("treats a missing agents.list as a fresh install (no throw)", () => {
    const output = buildNextConfig({ existing: { agents: { defaults: {} } }, env: {}, processEnv: {}, repoRoot: "/repo" });
    expect(output.agents.list.map((a: { id: string }) => a.id)).toEqual(["control"]);
  });

  it("preserves unknown meta subkeys while refreshing lastTouchedAt", () => {
    const existing = { meta: { lastTouchedVersion: "9.9.9", customMetaKey: "survive" } };
    const output = buildNextConfig({ existing, env: {}, processEnv: {}, repoRoot: "/repo" });
    expect(output.meta.customMetaKey).toBe("survive");
    expect(output.meta.lastTouchedVersion).toBe("9.9.9");
    expect(typeof output.meta.lastTouchedAt).toBe("string");
  });
});

// v2 persona deployment (the #1 user complaint fix): the control agent's
// workspace (~/.openclaw/workspaces/control) used to stay EMPTY forever -
// skipBootstrap:true means OpenClaw never writes bootstrap files, and no
// script ever deployed agents/control.md - so the deployed Feishu bot
// answered as vanilla Codex with no persona at all. installControlPersona is
// the deployment seam: agents/control.md ({{REPO_ROOT}}-templated, the
// single source of persona) + repo-root AGENTS.md (Trading Constitution)
// composed into <homedir>/.openclaw/workspaces/control/AGENTS.md.
describe("installControlPersona", () => {
  const tempDirs: string[] = [];

  function makeTempHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "alphaloop-render-home-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // A deliberately fake repo root: it must differ from the real checkout path
  // so the "no hardcoded developer-machine path" assertions below can tell a
  // legitimately-expanded {{REPO_ROOT}} apart from a path someone hardcoded
  // back into agents/control.md.
  const FAKE_REPO_ROOT = "/srv/fake-alphaloop";

  it("writes the persona into <homedir>/.openclaw/workspaces/control/AGENTS.md with {{REPO_ROOT}} fully expanded", () => {
    const home = makeTempHome();
    const { workspacePersonaPath } = installControlPersona({ repoRoot: FAKE_REPO_ROOT, homedir: home });

    expect(workspacePersonaPath).toBe(join(home, ".openclaw", "workspaces", "control", "AGENTS.md"));
    const content = readFileSync(workspacePersonaPath, "utf8");
    expect(content.trim().length).toBeGreaterThan(0);

    // Placeholder fully expanded - no template token survives...
    expect(content).not.toContain("{{REPO_ROOT}}");
    // ...and expanded to the repoRoot that was passed in (a real routed CLI
    // path proves the routing table went through expansion, not deletion).
    expect(content).toContain(`${FAKE_REPO_ROOT}/apps/openclaw-config/scripts/market-alerts.mjs`);
    expect(content).toContain(`${FAKE_REPO_ROOT}/apps/openclaw-config/scripts/proposals.mjs`);
  });

  it("contains no hardcoded developer-machine paths (the v1-era staleness this fix retires)", () => {
    const home = makeTempHome();
    const { workspacePersonaPath } = installControlPersona({ repoRoot: FAKE_REPO_ROOT, homedir: home });
    const content = readFileSync(workspacePersonaPath, "utf8");

    expect(content).not.toContain("/Users/abble");
    expect(content).not.toContain("/Users/qingchang");
  });

  it("prepends the repo-root AGENTS.md Trading Constitution content", () => {
    const home = makeTempHome();
    const { workspacePersonaPath } = installControlPersona({ repoRoot: FAKE_REPO_ROOT, homedir: home });
    const content = readFileSync(workspacePersonaPath, "utf8");

    // Verbatim constitution lines from the repo-root AGENTS.md.
    expect(content).toContain("# Trading Constitution");
    expect(content).toContain("Never auto-submit real-money orders.");
    // The constitution comes BEFORE the persona body (prepend, not append).
    expect(content.indexOf("# Trading Constitution")).toBeLessThan(content.indexOf("Trading Copilot"));
  });

  it("is idempotent: re-running overwrites the derived file with identical content", () => {
    const home = makeTempHome();
    const first = installControlPersona({ repoRoot: FAKE_REPO_ROOT, homedir: home });
    const firstContent = readFileSync(first.workspacePersonaPath, "utf8");
    const second = installControlPersona({ repoRoot: FAKE_REPO_ROOT, homedir: home });

    expect(second.workspacePersonaPath).toBe(first.workspacePersonaPath);
    expect(readFileSync(second.workspacePersonaPath, "utf8")).toBe(firstContent);
  });
});
