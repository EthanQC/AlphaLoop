#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { selectModelDefaults } from "./model-selection.mjs";
import { repoRoot as defaultRepoRoot } from "./repo-root.mjs";

const removedPluginIds = new Set(["memory", "memory-lancedb", "openclaw-honcho", "active-memory", "rule-proposal-review"]);

// Pure config builder. Takes ALL inputs as parameters (no file/env reads, no
// writes) so it is directly testable via `import`. `existing` is the parsed
// current openclaw.json (or {}); the returned object is a NON-DESTRUCTIVE merge
// that preserves every existing top-level key and only ADDs/UPSERTs AlphaLoop's
// pieces.
export function buildNextConfig({ existing = {}, env = {}, processEnv = {}, repoRoot }) {
  const localContextPluginId = "local-context";
  const localContextPluginPath = join(
    repoRoot,
    "apps",
    "openclaw-config",
    "plugins",
    localContextPluginId
  );
  const existingFeishu = existing.channels?.feishu ?? {};

  const gatewayPort = Number(env.OPENCLAW_GATEWAY_PORT ?? processEnv.OPENCLAW_GATEWAY_PORT ?? 18789);
  const gatewayToken =
    env.OPENCLAW_GATEWAY_TOKEN ??
    processEnv.OPENCLAW_GATEWAY_TOKEN ??
    existing.gateway?.auth?.token ??
    crypto.randomUUID().replaceAll("-", "");
  const feishuAppId = env.FEISHU_APP_ID ?? processEnv.FEISHU_APP_ID ?? "";
  const feishuAppSecret = env.FEISHU_APP_SECRET ?? processEnv.FEISHU_APP_SECRET ?? "";
  const feishuEnabled = feishuAppId.trim().length > 0 && feishuAppSecret.trim().length > 0;
  const feishuDomain = env.FEISHU_DOMAIN ?? processEnv.FEISHU_DOMAIN ?? "feishu";
  const feishuBotName = env.FEISHU_BOT_NAME ?? processEnv.FEISHU_BOT_NAME ?? "Trading Copilot";
  const feishuVerificationToken =
    env.FEISHU_VERIFICATION_TOKEN ?? processEnv.FEISHU_VERIFICATION_TOKEN ?? "";
  // FIX 2b: keep the env-provided allow list SEPARATE from what already exists so
  // AlphaLoop only ever ADDS. The GLOBAL allowFrom is the channel-level (plus our
  // own `main` account) allowFrom UNION the env list - never a flatten of every
  // per-group allowFrom (that silently promoted a member allowed in one group
  // into every group and into DMs).
  const envFeishuAllowFrom = parseCsv(env.FEISHU_ALLOW_FROM ?? processEnv.FEISHU_ALLOW_FROM ?? "");
  const feishuAllowFrom = unique([
    ...envFeishuAllowFrom,
    ...collectGlobalFeishuAllowFrom(existingFeishu)
  ]);
  const feishuDmPolicy =
    env.FEISHU_DM_POLICY ??
    processEnv.FEISHU_DM_POLICY ??
    (feishuAllowFrom.length > 0 ? "allowlist" : "pairing");
  const feishuGroupPolicy = "allowlist";
  // Group ids explicitly supplied via env; only THESE receive a fresh AlphaLoop
  // group entry. Existing groups are preserved verbatim (see mergeFeishuGroups).
  const envFeishuGroupIds = parseCsv(env.FEISHU_GROUP_ALLOW_FROM ?? processEnv.FEISHU_GROUP_ALLOW_FROM ?? "");
  const feishuGroupAllowFrom = unique([
    ...envFeishuGroupIds,
    ...collectExistingFeishuGroups(existingFeishu)
  ]);
  const feishuRequireMention = parseOptionalBoolean(
    env.FEISHU_REQUIRE_MENTION ?? processEnv.FEISHU_REQUIRE_MENTION
  ) ?? true;
  const feishuGroups = mergeFeishuGroups({
    existingGroups: existingFeishu.groups ?? {},
    envGroupIds: envFeishuGroupIds,
    envAllowFrom: envFeishuAllowFrom,
    requireMention: feishuRequireMention
  });
  const modelDefaults = selectModelDefaults({
    existingDefaults: existing.agents?.defaults ?? {},
    env: { ...processEnv, ...env }
  });

  const alphaLoopDefaults = {
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
      query: {
        maxResults: 8,
        hybrid: {
          enabled: true,
          vectorWeight: 0,
          textWeight: 1
        }
      }
    }
  };

  // Preserve every existing agent except the old AlphaLoop `control` (which we
  // upsert), then append the current control definition. Re-running never
  // duplicates control and never drops the other agents.
  // FIX 3a: a present-but-non-array agents.list is a corrupt config. Silently
  // rebuilding to just [control] would DROP the user's real agents, so refuse
  // loudly. Missing/null stays fine (fresh install -> only control).
  const rawExistingList = existing.agents?.list;
  if (rawExistingList !== undefined && rawExistingList !== null && !Array.isArray(rawExistingList)) {
    throw new Error(
      `existing agents.list must be an array (found ${typeof rawExistingList}); ` +
        "fix ~/.openclaw/openclaw.json before re-running so real agents are not lost."
    );
  }
  const existingList = Array.isArray(rawExistingList) ? rawExistingList : [];
  const agentsList = [
    ...existingList.filter((agent) => agent?.id !== "control"),
    ...buildAgents(repoRoot)
  ];

  // Plugin ids AlphaLoop needs. Per the installed OpenClaw docs
  // (docs/tools/plugin.md) NONE of these require an allowlist entry to load when
  // no `plugins.allow` exists: acpx/openai (and feishu) auto-activate because the
  // config names their owned surfaces ("Bundled opt-in plugins can auto-activate
  // when config names one of their owned surfaces, such as a provider/model ref,
  // channel config, CLI backend, or agent harness runtime"); memory-core is
  // force-enabled by `plugins.slots.memory` ("Slot selection force-enables the
  // selected plugin for that slot by counting as explicit activation"); and
  // local-context is explicitly enabled via `plugins.entries` + `load.paths`
  // ("explicitly enable or allowlist them"). They only need listing when the user
  // ALREADY runs an exclusive allowlist, in which case we merge into it below.
  const alphaLoopPluginIds = [
    "acpx",
    "openai",
    ...(feishuEnabled ? ["feishu"] : []),
    "memory-core",
    localContextPluginId
  ];

  const nextConfig = {
    // Spread existing FIRST so every top-level key (mcp, skills, tools, wizard,
    // and anything else) survives by default; AlphaLoop's keys below override.
    ...existing,
    meta: {
      // FIX 3b: spread existing.meta so unknown meta subkeys survive; keep the
      // lastTouchedVersion fallback and always stamp a fresh lastTouchedAt.
      ...(existing.meta ?? {}),
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
      },
      // The OpenAI-compatible /v1/chat/completions endpoint is OFF by default
      // (docs/gateway/openai-http-api.md "Enabling the endpoint"). The three
      // real backends (_openclaw-gateway.mjs: narrative / news search /
      // research) depend on it; loopback-only + token auth bounds the exposure.
      http: {
        endpoints: {
          chatCompletions: { enabled: true }
        }
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
      ...existing.agents,
      defaults: {
        ...(existing.agents?.defaults ?? {}),
        ...alphaLoopDefaults
      },
      list: agentsList
    },
    auth: existing.auth ?? {},
    ...(feishuEnabled
      ? {
          channels: {
            ...(existing.channels ?? {}),
            // FIX 2a: spread existingFeishu FIRST so unknown keys, the user's own
            // groups, and their own accounts (e.g. accounts.default with their own
            // appId) all survive. We then override only AlphaLoop-owned channel
            // fields and UPSERT our own `main` account - never rebuild the object.
            feishu: {
              ...existingFeishu,
              enabled: true,
              connectionMode: "websocket",
              domain: feishuDomain,
              defaultAccount: "main",
              dmPolicy: feishuDmPolicy,
              ...(feishuAllowFrom.length > 0 ? { allowFrom: feishuAllowFrom } : {}),
              groupPolicy: feishuGroupPolicy,
              ...(feishuGroupAllowFrom.length > 0 ? { groupAllowFrom: feishuGroupAllowFrom } : {}),
              ...(Object.keys(feishuGroups).length > 0 ? { groups: feishuGroups } : {}),
              requireMention: feishuRequireMention,
              accounts: {
                ...(existingFeishu.accounts ?? {}),
                main: {
                  ...(existingFeishu.accounts?.main ?? {}),
                  appId: feishuAppId,
                  appSecret: feishuAppSecret,
                  domain: feishuDomain,
                  name: feishuBotName,
                  dmPolicy: feishuDmPolicy,
                  ...(feishuAllowFrom.length > 0 ? { allowFrom: feishuAllowFrom } : {}),
                  groupPolicy: feishuGroupPolicy,
                  ...(feishuGroupAllowFrom.length > 0 ? { groupAllowFrom: feishuGroupAllowFrom } : {}),
                  ...(Object.keys(feishuGroups).length > 0 ? { groups: feishuGroups } : {}),
                  requireMention: feishuRequireMention,
                  ...(feishuVerificationToken ? { verificationToken: feishuVerificationToken } : {})
                }
              }
            }
          }
        }
      : {}),
    plugins: {
      ...(existing.plugins ?? {}),
      // FIX 1: `plugins.allow` is an EXCLUSIVE allowlist (docs/tools/plugin.md:
      // "plugins.allow is an exclusive allowlist. Plugin-owned tools outside the
      // allowlist stay unavailable, even when tools.allow includes '*'."). Emitting
      // one where the user had none would silently disable their bundled default-on
      // plugins AND their entries-enabled plugins (the real MacBook config has ONLY
      // entries.memoryd-openclaw and no allow key). So: emit `allow` ONLY when the
      // user already ran an exclusive allowlist, and then MERGE - preserving their
      // explicit allow ids, their installs keys, their entries-enabled ids, plus
      // AlphaLoop's ids. If they had no allow key we omit it entirely, leaving
      // bundled defaults + AlphaLoop's own plugins (see alphaLoopPluginIds) intact.
      ...(Array.isArray(existing.plugins?.allow)
        ? {
            allow: unique([
              ...asStringArray(existing.plugins.allow).filter(keepPluginId),
              ...Object.keys(existing.plugins?.installs ?? {}).filter(keepPluginId),
              ...Object.keys(existing.plugins?.entries ?? {}).filter(keepPluginId),
              ...alphaLoopPluginIds
            ])
          }
        : {}),
      load: {
        ...(existing.plugins?.load ?? {}),
        paths: unique([
          ...asStringArray(existing.plugins?.load?.paths),
          localContextPluginPath
        ])
      },
      slots: {
        ...filterPluginSlots(existing.plugins?.slots ?? {}),
        memory: "memory-core"
      },
      entries: {
        ...filterPluginObject(existing.plugins?.entries ?? {}),
        // OpenClaw 2026.7+ requires EXPLICIT trust for externally-installed
        // channel plugins: a configured channels.feishu alone logs
        // "installed without explicit trust. Add plugins.entries.feishu.enabled=true"
        // and the channel stays down. Emitted only when feishu creds are
        // present (same gate as the channels.feishu block).
        ...(feishuEnabled ? { feishu: { enabled: true } } : {}),
        acpx: {
          enabled: true,
          config: {
            permissionMode: "approve-all",
            nonInteractivePermissions: "fail",
            pluginToolsMcpBridge: true
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

  return nextConfig;
}

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
        mentionPatterns: ["@openclaw", "@OpenClaw", "@Trading Copilot", "@机器人", "@交易机器人", "@炒股机器人", "@control", "@trade-control"]
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

// GLOBAL allowFrom only: the channel-level allowFrom plus AlphaLoop's own managed
// `main` account. Deliberately EXCLUDES per-group allowFrom (flattening those into
// a global union silently widens per-group permissions - the FIX 2b bug) and the
// user's own `default` account (its members belong to that account, not to us).
function collectGlobalFeishuAllowFrom(feishuConfig) {
  return unique([
    ...asStringArray(feishuConfig.allowFrom),
    ...asStringArray(feishuConfig.accounts?.main?.allowFrom)
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

// FIX 2b: preserve each existing group's own config VERBATIM (never rewrite a
// group's allowFrom/requireMention), and only ADD groups explicitly supplied via
// env - with the env allowFrom and env-default requireMention - when they are not
// already present.
function mergeFeishuGroups({ existingGroups, envGroupIds, envAllowFrom, requireMention }) {
  const result = {};

  for (const [groupId, groupConfig] of Object.entries(existingGroups ?? {})) {
    result[groupId] = { ...groupConfig };
  }

  if (Array.isArray(envGroupIds)) {
    for (const groupId of envGroupIds) {
      if (!groupId || Object.prototype.hasOwnProperty.call(result, groupId)) {
        continue;
      }
      result[groupId] = {
        ...(Array.isArray(envAllowFrom) && envAllowFrom.length > 0 ? { allowFrom: envAllowFrom } : {}),
        ...(typeof requireMention === "boolean" ? { requireMention } : {})
      };
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Control-agent persona deployment (the #1 user complaint fix): the control
// agent's workspace used to stay EMPTY forever - `skipBootstrap: true` (see
// alphaLoopDefaults above) means OpenClaw never writes bootstrap files, and
// nothing ever deployed agents/control.md - so the deployed Feishu bot ran
// the embedded codex harness with NO persona at all and answered as vanilla
// Codex. This helper is the deployment seam: it composes the repo-root
// AGENTS.md (Trading Constitution) + agents/control.md (the v2 persona,
// {{REPO_ROOT}}-templated) into <homedir>/.openclaw/workspaces/control/
// AGENTS.md - the standard workspace instructions file the harness reads.
//
// Both source files are resolved relative to THIS module (the checkout the
// script actually runs from), while the `repoRoot` PARAMETER is only used to
// expand {{REPO_ROOT}} placeholders - that split is what lets the test pass
// a fake repoRoot + temp homedir and still read the real templates.
// buildNextConfig stays pure (no fs); all reads/writes live here and are
// only invoked from main() or from a test that calls this export directly.
// The output is derived state - overwriting on every run is intentional
// (idempotent; the sources of truth are the two files in the repo).
// ---------------------------------------------------------------------------

const moduleDir = dirname(fileURLToPath(import.meta.url));
const personaTemplatePath = join(moduleDir, "..", "agents", "control.md");
const constitutionPath = join(moduleDir, "..", "..", "..", "AGENTS.md");

export function installControlPersona({ repoRoot, homedir: homeDirPath }) {
  const personaTemplate = readFileSync(personaTemplatePath, "utf8");
  const constitution = readFileSync(constitutionPath, "utf8");

  const persona = personaTemplate.replaceAll("{{REPO_ROOT}}", repoRoot);
  // Fail loud on a malformed placeholder ({{ REPO_ROOT }}, {{REPO_ROOT},
  // etc.) instead of shipping a persona with a literal template token in a
  // routed command - the agent would then run a broken path at chat time.
  if (persona.includes("{{REPO_ROOT")) {
    throw new Error(
      `agents/control.md still contains an unexpanded {{REPO_ROOT}} placeholder after expansion - ` +
        `check for a malformed token in ${personaTemplatePath}.`
    );
  }

  const composed = [
    "<!-- Generated by apps/openclaw-config/scripts/render-openclaw-config.mjs - DO NOT EDIT BY HAND.",
    "     Sources: repo-root AGENTS.md (Trading Constitution) + apps/openclaw-config/agents/control.md.",
    "     Re-run the render script after editing either source. -->",
    "",
    constitution.trimEnd(),
    "",
    "---",
    "",
    persona.trimEnd(),
    ""
  ].join("\n");

  const workspaceDir = join(homeDirPath, ".openclaw", "workspaces", "control");
  mkdirSync(workspaceDir, { recursive: true });
  const workspacePersonaPath = join(workspaceDir, "AGENTS.md");
  writeFileSync(workspacePersonaPath, composed, "utf8");
  return { workspacePersonaPath };
}

// ---------------------------------------------------------------------------
// CLI entry point. Guarded by isMainModule so importing this module (tests)
// never reads ~/.openclaw or writes/backs up a config as a side effect of
// `import` - mirrors official-paper-monitor.mjs's testable-CLI pattern.
// ---------------------------------------------------------------------------

function main() {
  const env = loadEnv(join(defaultRepoRoot, ".env.local"));
  const openclawRoot = join(homedir(), ".openclaw");
  const configPath = join(openclawRoot, "openclaw.json");
  const existing = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};

  const nextConfig = buildNextConfig({
    existing,
    env,
    processEnv: process.env,
    repoRoot: defaultRepoRoot
  });

  mkdirSync(openclawRoot, { recursive: true });

  // Non-destructive safety net: back up any pre-existing config BEFORE writing.
  let backupPath = null;
  if (existsSync(configPath)) {
    const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
    backupPath = join(dirname(configPath), `openclaw.json.bak-${timestamp}`);
    copyFileSync(configPath, backupPath);
  }

  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

  // Deploy the control agent's persona alongside the config - with
  // skipBootstrap:true nothing else ever populates the workspace, so this
  // render script is the one place the persona reaches the runtime.
  const { workspacePersonaPath } = installControlPersona({
    repoRoot: defaultRepoRoot,
    homedir: homedir()
  });

  console.log(JSON.stringify({
    configPath,
    backupPath,
    workspacePersonaPath,
    gatewayPort: nextConfig.gateway.port,
    primaryModel: nextConfig.agents.defaults.model.primary,
    feishuEnabled: Boolean(nextConfig.channels?.feishu?.enabled)
  }, null, 2));
}

const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  main();
}
