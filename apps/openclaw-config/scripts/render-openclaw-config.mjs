#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const env = loadEnv(join(repoRoot, ".env.local"));
const openclawRoot = join(homedir(), ".openclaw");
const configPath = join(openclawRoot, "openclaw.json");
const existing = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
const existingFeishu = existing.channels?.feishu ?? {};
const ruleProposalReviewPluginId = "rule-proposal-review";
const ruleProposalReviewPluginPath = join(
  repoRoot,
  "apps",
  "openclaw-config",
  "plugins",
  ruleProposalReviewPluginId
);

const gatewayPort = Number(env.OPENCLAW_GATEWAY_PORT ?? process.env.OPENCLAW_GATEWAY_PORT ?? 18789);
const gatewayToken =
  env.OPENCLAW_GATEWAY_TOKEN ??
  process.env.OPENCLAW_GATEWAY_TOKEN ??
  existing.gateway?.auth?.token ??
  crypto.randomUUID().replaceAll("-", "");
const installedPluginIds = Object.keys(existing.plugins?.installs ?? {});
const honchoApiKey = env.HONCHO_API_KEY ?? process.env.HONCHO_API_KEY ?? "";
const honchoEnabled = honchoApiKey.trim().length > 0;
const feishuAppId = env.FEISHU_APP_ID ?? process.env.FEISHU_APP_ID ?? "";
const feishuAppSecret = env.FEISHU_APP_SECRET ?? process.env.FEISHU_APP_SECRET ?? "";
const feishuEnabled = feishuAppId.trim().length > 0 && feishuAppSecret.trim().length > 0;
const feishuDomain = env.FEISHU_DOMAIN ?? process.env.FEISHU_DOMAIN ?? "feishu";
const feishuBotName = env.FEISHU_BOT_NAME ?? process.env.FEISHU_BOT_NAME ?? "Trading Copilot";
const feishuVerificationToken =
  env.FEISHU_VERIFICATION_TOKEN ?? process.env.FEISHU_VERIFICATION_TOKEN ?? "";
const feishuAllowFrom = unique([
  ...parseCsv(env.FEISHU_ALLOW_FROM ?? process.env.FEISHU_ALLOW_FROM ?? ""),
  ...collectExistingFeishuUsers(existingFeishu)
]);
const feishuDmPolicy =
  env.FEISHU_DM_POLICY ??
  process.env.FEISHU_DM_POLICY ??
  (feishuAllowFrom.length > 0 ? "allowlist" : "pairing");
const feishuGroupPolicy = "allowlist";
const feishuGroupAllowFrom = unique([
  ...parseCsv(env.FEISHU_GROUP_ALLOW_FROM ?? process.env.FEISHU_GROUP_ALLOW_FROM ?? ""),
  ...collectExistingFeishuGroups(existingFeishu)
]);
const feishuRequireMention = parseOptionalBoolean(
  env.FEISHU_REQUIRE_MENTION ?? process.env.FEISHU_REQUIRE_MENTION
);
const feishuGroups = buildFeishuGroups({
  groupIds: feishuGroupAllowFrom,
  allowFrom: feishuAllowFrom,
  requireMention: feishuRequireMention
});

const nextConfig = {
  meta: {
    lastTouchedVersion: existing.meta?.lastTouchedVersion ?? "2026.4.2",
    lastTouchedAt: new Date().toISOString()
  },
  gateway: {
    mode: "local",
    port: gatewayPort,
    bind: "loopback",
    auth: {
      mode: "token",
      token: gatewayToken,
      allowTailscale: false
    },
    controlUi: {
      enabled: true
    }
  },
  acp: {
    enabled: true,
    dispatch: { enabled: true },
    backend: "acpx",
    defaultAgent: "codex",
    allowedAgents: ["codex"],
    maxConcurrentSessions: 8,
    stream: {
      coalesceIdleMs: 300,
      maxChunkChars: 1200
    },
    runtime: {
      ttlMinutes: 120
    }
  },
  agents: {
    defaults: {
      userTimezone: "Asia/Shanghai",
      skipBootstrap: true,
      sandbox: { mode: "off" },
      model: { primary: "openai-codex/gpt-5.4" },
      models: {
        "openai-codex/gpt-5.4": { alias: "gpt" },
        "openai-codex/gpt-5.4-mini": { alias: "gpt-mini" }
      },
      heartbeat: {
        every: "30m",
        model: "openai-codex/gpt-5.4-mini",
        isolatedSession: true,
        prompt: "Read HEARTBEAT.md and report auth issues, queue lag, or risk state drift.",
        target: "none"
      }
    },
    list: buildAgents(repoRoot)
  },
  auth: existing.auth ?? {},
  ...(feishuEnabled
    ? {
        channels: {
          ...(existing.channels ?? {}),
          feishu: {
            enabled: true,
            connectionMode: "websocket",
            domain: feishuDomain,
            defaultAccount: "main",
            dmPolicy: feishuDmPolicy,
            ...(feishuAllowFrom.length > 0 ? { allowFrom: feishuAllowFrom } : {}),
            groupPolicy: feishuGroupPolicy,
            ...(feishuGroupAllowFrom.length > 0 ? { groupAllowFrom: feishuGroupAllowFrom } : {}),
            ...(Object.keys(feishuGroups).length > 0 ? { groups: feishuGroups } : {}),
            ...(typeof feishuRequireMention === "boolean" ? { requireMention: feishuRequireMention } : {}),
            accounts: {
              main: {
                appId: feishuAppId,
                appSecret: feishuAppSecret,
                domain: feishuDomain,
                name: feishuBotName,
                dmPolicy: feishuDmPolicy,
                ...(feishuAllowFrom.length > 0 ? { allowFrom: feishuAllowFrom } : {}),
                groupPolicy: feishuGroupPolicy,
                ...(feishuGroupAllowFrom.length > 0 ? { groupAllowFrom: feishuGroupAllowFrom } : {}),
                ...(Object.keys(feishuGroups).length > 0 ? { groups: feishuGroups } : {}),
                ...(typeof feishuRequireMention === "boolean" ? { requireMention: feishuRequireMention } : {}),
                ...(feishuVerificationToken ? { verificationToken: feishuVerificationToken } : {})
              }
            }
          }
        }
      }
    : {}),
  plugins: {
    allow: unique([
      ...asStringArray(existing.plugins?.allow),
      ...installedPluginIds,
      "acpx",
      "openai",
      ...(feishuEnabled ? ["feishu"] : []),
      ruleProposalReviewPluginId,
      ...(honchoEnabled ? ["openclaw-honcho"] : [])
    ]),
    load: {
      ...(existing.plugins?.load ?? {}),
      paths: unique([
        ...asStringArray(existing.plugins?.load?.paths),
        ruleProposalReviewPluginPath
      ])
    },
    slots: honchoEnabled ? { memory: "openclaw-honcho" } : {},
    entries: {
      ...(existing.plugins?.entries ?? {}),
      acpx: {
        enabled: true,
        config: {
          permissionMode: "approve-all",
          nonInteractivePermissions: "fail",
          pluginToolsMcpBridge: true
        }
      },
      "openclaw-honcho": honchoEnabled
        ? {
            enabled: true,
            config: {
              baseUrl: env.HONCHO_ENDPOINT ?? process.env.HONCHO_ENDPOINT ?? "https://api.honcho.dev",
              apiKey: honchoApiKey,
              workspaceId:
                env.HONCHO_NAMESPACE ?? process.env.HONCHO_NAMESPACE ?? "openclaw-trading-stack"
            }
          }
        : {
            enabled: false
          },
      "memory-core": { enabled: false },
      "memory-lancedb": { enabled: false },
      [ruleProposalReviewPluginId]: {
        enabled: true,
        config: {
          repoRoot,
          channel: "feishu",
          notify: false,
          returnText: true
        }
      }
    },
    installs: existing.plugins?.installs ?? {}
  }
};

mkdirSync(openclawRoot, { recursive: true });
writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ configPath, gatewayPort, honchoEnabled, feishuEnabled }, null, 2));

function buildAgents(repoRootPath) {
  return [
    {
      id: "control",
      default: true,
      name: "Trading Control",
      workspace: "~/.openclaw/workspaces/control",
      agentDir: "~/.openclaw/agents/control/agent",
      identity: {
        name: "Trading Control",
        theme: "risk-aware operator"
      },
      groupChat: {
        mentionPatterns: ["@control", "@trade-control"]
      },
      subagents: {
        allowAgents: ["*"]
      },
      runtime: buildRuntime(repoRootPath)
    },
    {
      id: "live-advisor",
      name: "Live Advisor",
      workspace: "~/.openclaw/workspaces/live-advisor",
      agentDir: "~/.openclaw/agents/live-advisor/agent",
      identity: {
        name: "Live Advisor",
        theme: "structured decision support"
      },
      subagents: {
        allowAgents: ["*"]
      },
      runtime: buildRuntime(repoRootPath)
    },
    {
      id: "paper-trader",
      name: "Paper Trader",
      workspace: "~/.openclaw/workspaces/paper-trader",
      agentDir: "~/.openclaw/agents/paper-trader/agent",
      identity: {
        name: "Paper Trader",
        theme: "autonomous simulator"
      },
      subagents: {
        allowAgents: ["*"]
      },
      runtime: buildRuntime(repoRootPath)
    },
    {
      id: "evolution",
      name: "Evolution",
      workspace: "~/.openclaw/workspaces/evolution",
      agentDir: "~/.openclaw/agents/evolution/agent",
      identity: {
        name: "Evolution",
        theme: "versioned learning system"
      },
      subagents: {
        allowAgents: ["*"]
      },
      runtime: buildRuntime(repoRootPath)
    }
  ];
}

function buildRuntime(repoRootPath) {
  return {
    type: "acp",
    acp: {
      agent: "codex",
      backend: "acpx",
      mode: "persistent",
      cwd: repoRootPath
    }
  };
}

function loadEnv(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  const values = {};
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match) {
      continue;
    }

    const key = match[1];
    if (!key) {
      continue;
    }

    let value = match[2] ?? "";
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

function parseCsv(value) {
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function collectExistingFeishuUsers(feishuConfig) {
  return unique([
    ...asStringArray(feishuConfig.allowFrom),
    ...asStringArray(feishuConfig.accounts?.default?.allowFrom),
    ...Object.values(feishuConfig.groups ?? {}).flatMap((group) => asStringArray(group?.allowFrom))
  ]);
}

function collectExistingFeishuGroups(feishuConfig) {
  return unique([
    ...asStringArray(feishuConfig.groupAllowFrom),
    ...asStringArray(feishuConfig.accounts?.default?.groupAllowFrom),
    ...Object.keys(feishuConfig.groups ?? {})
  ]);
}

function asStringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
}

function parseOptionalBoolean(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return undefined;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function buildFeishuGroups({ groupIds, allowFrom, requireMention }) {
  if (!Array.isArray(groupIds) || groupIds.length === 0) {
    return {};
  }

  return Object.fromEntries(
    groupIds.map((groupId) => [
      groupId,
      {
        ...(Array.isArray(allowFrom) && allowFrom.length > 0 ? { allowFrom } : {}),
        ...(typeof requireMention === "boolean" ? { requireMention } : {})
      }
    ])
  );
}
