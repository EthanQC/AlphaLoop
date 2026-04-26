import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PRIMARY_MODEL = "openai-codex/gpt-5.5";
export const DEFAULT_HEARTBEAT_MODEL = "openai-codex/gpt-5.4-mini";

export function selectModelDefaults({ existingDefaults = {}, env = process.env, listedModelIds = [] } = {}) {
  const catalog = collectKnownModels({
    existingDefaults,
    listedModelIds,
    extraModelIds: [
      DEFAULT_PRIMARY_MODEL,
      DEFAULT_HEARTBEAT_MODEL
    ]
  });
  const latestPrimary = findLatestModel(false, catalog);
  const latestHeartbeat = findLatestModel(true, catalog);
  const primaryModel = normalizeConfiguredModel(
    env.OPENCLAW_PRIMARY_MODEL ??
      env.OPENCLAW_MODEL_PRIMARY ??
      latestPrimary?.fullId ??
      existingDefaults?.model?.primary ??
      DEFAULT_PRIMARY_MODEL
  );
  const heartbeatModel = normalizeConfiguredModel(
    env.OPENCLAW_HEARTBEAT_MODEL ??
      env.OPENCLAW_MODEL_HEARTBEAT ??
      latestHeartbeat?.fullId ??
      existingDefaults?.heartbeat?.model ??
      DEFAULT_HEARTBEAT_MODEL
  );
  const models = parseBoolean(env.OPENCLAW_PRESERVE_MODEL_ALLOWLIST)
    ? sanitizeModelMap(existingDefaults?.models)
    : {};

  setAlias(models, primaryModel, env.OPENCLAW_PRIMARY_MODEL_ALIAS ?? "gpt");
  setAlias(models, heartbeatModel, env.OPENCLAW_HEARTBEAT_MODEL_ALIAS ?? "gpt-mini");

  return {
    primaryModel,
    heartbeatModel,
    models,
    latestPrimary: latestPrimary?.fullId ?? null,
    latestHeartbeat: latestHeartbeat?.fullId ?? null,
    availableModels: catalog.map((model) => model.fullId).sort()
  };
}

export function collectKnownModels({ existingDefaults = {}, listedModelIds = [], extraModelIds = [] } = {}) {
  const models = new Map();

  for (const fullId of [
    ...listedModelIds,
    ...Object.keys(existingDefaults?.models ?? {}),
    existingDefaults?.model?.primary,
    existingDefaults?.heartbeat?.model,
    ...extraModelIds
  ]) {
    addModel(models, fullId);
  }

  const agentsDir = join(homedir(), ".openclaw", "agents");
  if (existsSync(agentsDir)) {
    for (const agentId of readdirSync(agentsDir)) {
      const path = join(agentsDir, agentId, "agent", "models.json");
      if (!existsSync(path)) {
        continue;
      }
      for (const model of readModelsJson(path)) {
        addModel(models, model.fullId);
      }
    }
  }

  return Array.from(models.values());
}

export function findLatestModel(miniOnly, models) {
  const filtered = models
    .filter((model) => /^gpt-\d+(?:\.\d+)*(?:-[a-z0-9]+)?$/iu.test(model.id))
    .filter((model) => miniOnly ? /mini/iu.test(model.id) : !/mini/iu.test(model.id))
    .sort((left, right) => compareModelIds(right.id, left.id));
  return filtered[0] ?? null;
}

export function listAvailableModelIds(listed) {
  if (!Array.isArray(listed?.models)) {
    return [];
  }
  return listed.models
    .filter((model) => model?.available !== false && !model?.missing)
    .map((model) => model.key)
    .filter((key) => typeof key === "string" && key.length > 0);
}

export function normalizeModelFullId(providerId, id) {
  if (!id) {
    return null;
  }
  if (String(id).includes("/")) {
    return String(id);
  }
  const provider = providerId === "codex" || !providerId ? "openai-codex" : providerId;
  return `${provider}/${id}`;
}

export function modelShortId(fullId) {
  const id = String(fullId ?? "").split("/").at(-1);
  return id && /^gpt-/iu.test(id) ? id : null;
}

export function compareModelIds(left, right) {
  const leftParts = parseModelId(left);
  const rightParts = parseModelId(right);
  for (let index = 0; index < Math.max(leftParts.numbers.length, rightParts.numbers.length); index += 1) {
    const diff = (leftParts.numbers[index] ?? 0) - (rightParts.numbers[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  if (leftParts.mini !== rightParts.mini) {
    return leftParts.mini ? -1 : 1;
  }
  return left.localeCompare(right);
}

function sanitizeModelMap(value) {
  const models = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return models;
  }
  for (const [rawId, config] of Object.entries(value)) {
    const fullId = normalizeConfiguredModel(rawId);
    if (fullId) {
      models[fullId] = config && typeof config === "object" && !Array.isArray(config) ? { ...config } : {};
    }
  }
  return models;
}

function setAlias(models, fullId, alias) {
  if (!fullId) {
    return;
  }
  for (const config of Object.values(models)) {
    if (config?.alias === alias) {
      delete config.alias;
    }
  }
  models[fullId] = {
    ...(models[fullId] ?? {}),
    alias
  };
}

function readModelsJson(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const providers = parsed.providers ?? {};
    const models = [];
    for (const [providerId, provider] of Object.entries(providers)) {
      if (!Array.isArray(provider?.models)) {
        continue;
      }
      for (const model of provider.models) {
        const fullId = normalizeModelFullId(providerId, model?.id);
        const id = modelShortId(fullId);
        if (id && fullId) {
          models.push({ id, fullId });
        }
      }
    }
    return models;
  } catch {
    return [];
  }
}

function addModel(models, rawId) {
  const fullId = normalizeConfiguredModel(rawId);
  const id = modelShortId(fullId);
  if (id && fullId) {
    models.set(fullId, { id, fullId });
  }
}

function normalizeConfiguredModel(rawId) {
  if (!rawId || typeof rawId !== "string") {
    return null;
  }
  return normalizeModelFullId("", rawId.trim());
}

function parseModelId(id) {
  const normalized = String(id).toLowerCase();
  const numbers = normalized.match(/\d+/gu)?.map((entry) => Number(entry)) ?? [];
  return {
    numbers,
    mini: /mini/iu.test(normalized)
  };
}

function parseBoolean(value) {
  if (value === undefined || value === null) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}
