import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(pluginDir, "..", "..", "..", "..");

const plugin = {
  id: "local-context",
  name: "Local Context",
  description: "SQLite-backed local context ingestion and prompt recall.",
  register(api) {
    api.on("before_dispatch", async (event, ctx) => {
      const config = resolveConfig(api.pluginConfig);
      if (!config.ingestFeishuMessages || !isFeishuContext(event, ctx)) {
        return undefined;
      }
      await runContextManager(api, config, "ingest-feishu-event", [], { event, ctx });
      return undefined;
    }, { priority: -100 });

    api.on("before_agent_reply", async (event, ctx) => {
      const config = resolveConfig(api.pluginConfig);
      if (!config.ingestFeishuMessages || !isFeishuContext(event, ctx)) {
        return undefined;
      }
      await runContextManager(api, config, "ingest-feishu-event", [], { event, ctx });
      return undefined;
    }, { priority: -100 });

    api.on("before_prompt_build", async (event, ctx) => {
      const config = resolveConfig(api.pluginConfig);
      if (!config.injectPromptContext || !isEnabledForAgent(config, ctx)) {
        return undefined;
      }

      const result = await runContextManager(
        api,
        config,
        "build-prompt-context",
        [
          "--json",
          "--stdin",
          "--max-chars",
          String(config.maxPromptChars)
        ],
        { event, ctx }
      );
      if (!result?.text) {
        return undefined;
      }
      return { prependContext: result.text };
    }, { priority: -50 });
  }
};

export default plugin;

function resolveConfig(rawConfig) {
  const config = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  return {
    repoRoot: typeof config.repoRoot === "string" && config.repoRoot.trim()
      ? config.repoRoot.trim()
      : defaultRepoRoot,
    agents: Array.isArray(config.agents)
      ? config.agents.map((agent) => String(agent).trim()).filter(Boolean)
      : ["control"],
    ingestFeishuMessages: typeof config.ingestFeishuMessages === "boolean"
      ? config.ingestFeishuMessages
      : true,
    injectPromptContext: typeof config.injectPromptContext === "boolean"
      ? config.injectPromptContext
      : true,
    maxPromptChars: clampNumber(config.maxPromptChars, 500, 6000, 3500),
    timeoutMs: clampNumber(config.timeoutMs, 250, 30000, 8000)
  };
}

function isEnabledForAgent(config, ctx) {
  if (config.agents.includes("*")) {
    return true;
  }
  const agentId = firstString(ctx?.agentId, inferAgentFromSession(ctx?.sessionKey));
  return agentId ? config.agents.includes(agentId) : false;
}

function isFeishuContext(event, ctx) {
  const channel = firstString(
    event?.channel,
    event?.channelId,
    event?.provider,
    ctx?.channelId,
    ctx?.messageProvider,
    ctx?.toolContext?.currentChannel
  );
  if (!channel) {
    return false;
  }
  return channel.toLowerCase().includes("feishu");
}

function runContextManager(api, config, command, args, input) {
  return new Promise((resolvePromise) => {
    const scriptPath = join(config.repoRoot, "apps", "openclaw-config", "scripts", "context-manager.mjs");
    const child = spawn(process.execPath, [scriptPath, command, ...args], {
      cwd: config.repoRoot,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      api.logger.warn?.(`local-context: ${command} timed out after ${config.timeoutMs}ms`);
      resolvePromise(undefined);
    }, config.timeoutMs);

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      api.logger.warn?.(`local-context: ${command} failed to start: ${error.message}`);
      resolvePromise(undefined);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const reason = [stderr, stdout].filter(Boolean).join("\n").trim();
        api.logger.warn?.(`local-context: ${command} exited ${code}${reason ? `: ${singleLine(reason, 300)}` : ""}`);
        resolvePromise(undefined);
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout.trim() || "{}"));
      } catch (error) {
        api.logger.warn?.(`local-context: ${command} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
        resolvePromise(undefined);
      }
    });
    child.stdin.end(safeStringify(input ?? {}));
  });
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function inferAgentFromSession(sessionKey) {
  const match = String(sessionKey ?? "").match(/^agent:([^:]+)/u);
  return match?.[1];
}

function singleLine(value, maxChars) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function safeStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (key, entry) => {
    if (typeof entry === "function" || typeof entry === "symbol") {
      return undefined;
    }
    if (entry && typeof entry === "object") {
      if (seen.has(entry)) {
        return "[Circular]";
      }
      seen.add(entry);
    }
    return entry;
  });
}
