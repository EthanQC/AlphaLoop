#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { selectModelDefaults } from "./model-selection.mjs";
import { repoRoot } from "./repo-root.mjs";

const env = loadEnv(join(repoRoot, ".env.local"));
const openclawRoot = join(homedir(), ".openclaw");
const configPath = join(openclawRoot, "openclaw.json");
const existing = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
const existingFeishu = existing.channels?.feishu ?? {};
const removedPluginIds = new Set(["memory", "memory-lancedb", "openclaw-honcho"]);
const ruleProposalReviewPluginId = "rule-proposal-review";
const ruleProposalReviewPluginPath = join(
  repoRoot,
  "apps",
  "openclaw-config",
  "plugins",
  ruleProposalReviewPluginId
);
const localContextPluginId = "local-context";
const localContextPluginPath = join(
  repoRoot,
  "apps",
  "openclaw-config",
  "plugins",
  localContextPluginId
);

const gatewayPort = Number(env.OPENCLAW_GATEWAY_PORT ?? process.env.OPENCLAW_GATEWAY_PORT ?? 18789);
const gatewayToken =
  env.OPENCLAW_GATEWAY_TOKEN ??
  process.env.OPENCLAW_GATEWAY_TOKEN ??
  existing.gateway?.auth?.token ??
  crypto.randomUUID().replaceAll("-", "");
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
const modelDefaults = selectModelDefaults({
  existingDefaults: existing.agents?.defaults ?? {},
  env: { ...process.env, ...env }
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
      model: { primary: modelDefaults.primaryModel },
      models: modelDefaults.models,
      memorySearch: {
        enabled: true,
        sources: ["memory"],
        fallback: "none",
        store: {
          driver: "sqlite",
          fts: {
            tokenizer: "unicode61"
          },
          vector: {
            enabled: false
          }
        },
        sync: {
          onSessionStart: true,
          onSearch: true,
          watch: true,
          watchDebounceMs: 1500
        },
        query: {
          maxResults: 8,
          hybrid: {
            enabled: true,
            vectorWeight: 0,
            textWeight: 1
          }
        }
      },
      heartbeat: {
        every: "30m",
        model: modelDefaults.heartbeatModel,
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
      ...asStringArray(existing.plugins?.allow).filter(keepPluginId),
      ...Object.keys(existing.plugins?.installs ?? {}).filter(keepPluginId),
      "acpx",
      "openai",
      ...(feishuEnabled ? ["feishu"] : []),
      "memory-core",
      "active-memory",
      localContextPluginId,
      ruleProposalReviewPluginId
    ]),
    load: {
      ...(existing.plugins?.load ?? {}),
      paths: unique([
        ...asStringArray(existing.plugins?.load?.paths),
        localContextPluginPath,
        ruleProposalReviewPluginPath
      ])
    },
    slots: {
      ...filterPluginSlots(existing.plugins?.slots ?? {}),
      memory: "memory-core"
    },
    entries: {
      ...filterPluginObject(existing.plugins?.entries ?? {}),
      acpx: {
        enabled: true,
        config: {
          permissionMode: "approve-all",
          nonInteractivePermissions: "fail",
          pluginToolsMcpBridge: true
        }
      },
      [ruleProposalReviewPluginId]: {
        enabled: true,
        config: {
          repoRoot,
          channel: "feishu",
          notify: false,
          returnText: true
        }
      },
      "memory-core": {
        enabled: true,
        config: {
          dreaming: {
            enabled: false,
            frequency: "15 3 * * *",
            timezone: "Asia/Shanghai",
            storage: {
              mode: "separate",
              separateReports: true
            },
            phases: {
              light: {
                enabled: true,
                lookbackDays: 7,
                limit: 40,
                dedupeSimilarity: 0.9
              },
              rem: {
                enabled: true,
                lookbackDays: 14,
                limit: 30,
                minPatternStrength: 0.55
              },
              deep: {
                enabled: true,
                limit: 40,
                minScore: 0.65,
                minRecallCount: 2,
                minUniqueQueries: 2,
                recencyHalfLifeDays: 30,
                maxAgeDays: 180
              }
            }
          }
        }
      },
      "active-memory": {
        enabled: true,
        config: {
          enabled: true,
          agents: ["control"],
          allowedChatTypes: ["direct", "group"],
          queryMode: "recent",
          promptStyle: "contextual",
          thinking: "off",
          timeoutMs: 8000,
          maxSummaryChars: 900,
          logging: true,
          persistTranscripts: false,
          qmd: {
            searchMode: "search"
          }
        }
      },
      [localContextPluginId]: {
        enabled: true,
        config: {
          repoRoot,
          agents: ["control"],
          ingestFeishuMessages: true,
          injectPromptContext: true,
          maxPromptChars: 3500,
          timeoutMs: 8000
        }
      }
    },
    installs: filterPluginObject(existing.plugins?.installs ?? {})
  }
};

mkdirSync(openclawRoot, { recursive: true });
writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  configPath,
  gatewayPort,
  primaryModel: modelDefaults.primaryModel,
  heartbeatModel: modelDefaults.heartbeatModel,
  feishuEnabled
}, null, 2));

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

function keepPluginId(id) {
  return typeof id === "string" && id.trim().length > 0 && !removedPluginIds.has(id.trim());
}

function filterPluginObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!keepPluginId(key) || removedPluginIds.has(String(entry))) {
      continue;
    }
    result[key] = entry;
  }
  return result;
}

function filterPluginSlots(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const result = {};
  for (const [slotName, pluginId] of Object.entries(value)) {
    if (removedPluginIds.has(String(pluginId))) {
      continue;
    }
    result[slotName] = pluginId;
  }
  return result;
}

function collectExistingFeishuUsers(feishuConfig) {
  return unique([
    ...asStringArray(feishuConfig.allowFrom),
    ...asStringArray(feishuConfig.accounts?.default?.allowFrom),
    ...asStringArray(feishuConfig.accounts?.main?.allowFrom),
    ...Object.values(feishuConfig.groups ?? {}).flatMap((group) => asStringArray(group?.allowFrom))
  ]);
}

function collectExistingFeishuGroups(feishuConfig) {
  return unique([
    ...asStringArray(feishuConfig.groupAllowFrom),
    ...asStringArray(feishuConfig.accounts?.default?.groupAllowFrom),
    ...asStringArray(feishuConfig.accounts?.main?.groupAllowFrom),
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
