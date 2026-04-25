#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadLocalEnv, sendNotification } from "../../../packages/shared-types/dist/index.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const runtimeDir = join(repoRoot, "runtime");
const statePath = join(runtimeDir, "maintenance-state.json");
const openclawBin = process.env.OPENCLAW_BIN ?? `${homedir()}/.local/node-v24/bin/openclaw`;

mkdirSync(runtimeDir, { recursive: true });
loadLocalEnv(repoRoot);

const changes = [];
const warnings = [];
const latestModel = findLatestModel(false);
const latestMiniModel = findLatestModel(true);
const currentDefaults = readOpenClawJson(["config", "get", "agents.defaults", "--json"]);
const currentPrimary = currentDefaults?.model?.primary;
const currentHeartbeat = currentDefaults?.heartbeat?.model;

if (latestModel && currentPrimary !== latestModel.fullId) {
  runOpenClaw(["config", "set", "agents.defaults.model.primary", JSON.stringify(latestModel.fullId), "--strict-json"]);
  runOpenClaw(["config", "set", `agents.defaults.models[${JSON.stringify(latestModel.fullId)}]`, JSON.stringify({ alias: "gpt-latest" }), "--strict-json"]);
  changes.push(`主模型切换：${currentPrimary ?? "unknown"} -> ${latestModel.fullId}`);
}

if (latestMiniModel && currentHeartbeat !== latestMiniModel.fullId) {
  runOpenClaw(["config", "set", "agents.defaults.heartbeat.model", JSON.stringify(latestMiniModel.fullId), "--strict-json"]);
  changes.push(`heartbeat 模型切换：${currentHeartbeat ?? "unknown"} -> ${latestMiniModel.fullId}`);
}

const updateStatus = readOpenClawJson(["update", "status", "--json"]);
if (updateStatus?.availability?.available) {
  const applyUpdates = process.env.OPENCLAW_APPLY_UPDATES !== "0";
  if (applyUpdates) {
    const result = readOpenClawJson(["update", "--yes", "--json", "--timeout", "1200"]);
    changes.push(`OpenClaw 已尝试自动更新：${JSON.stringify(result?.result ?? result?.availability ?? result ?? {})}`);
  } else {
    warnings.push("检测到 OpenClaw 可更新，但 OPENCLAW_APPLY_UPDATES=0，已跳过自动更新。");
  }
}

const finalDefaults = readOpenClawJson(["config", "get", "agents.defaults", "--json"]);
const state = {
  checkedAt: new Date().toISOString(),
  latestModel: latestModel?.fullId ?? null,
  latestMiniModel: latestMiniModel?.fullId ?? null,
  primaryModel: finalDefaults?.model?.primary ?? null,
  heartbeatModel: finalDefaults?.heartbeat?.model ?? null,
  updateAvailable: Boolean(updateStatus?.availability?.available),
  changes,
  warnings
};

writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

const notificationResult = await sendNotification({
  title: "OpenClaw 维护检查",
  body: [
    "## 模型与版本",
    "",
    `- 主模型：${state.primaryModel ?? "unknown"}`,
    `- heartbeat 模型：${state.heartbeatModel ?? "unknown"}`,
    `- 本地最新主模型：${state.latestModel ?? "未识别"}`,
    `- 本地最新 mini 模型：${state.latestMiniModel ?? "未识别"}`,
    `- OpenClaw 可更新：${state.updateAvailable ? "是" : "否"}`,
    "",
    "## 本次动作",
    "",
    changes.length > 0 ? changes.map((entry) => `- ${entry}`).join("\n") : "- 没有需要变更的项目。",
    "",
    "## 警告",
    "",
    warnings.length > 0 ? warnings.map((entry) => `- ${entry}`).join("\n") : "- 无。"
  ].join("\n"),
  format: "post"
});
if (!notificationResult.sent) {
  warnings.push(notificationResult.reason ?? `Maintenance notification was not sent; target=${notificationResult.target}`);
}

console.log(JSON.stringify(state, null, 2));

function findLatestModel(miniOnly) {
  const models = readLocalModels();
  const filtered = models
    .filter((model) => /^gpt-\d+(?:\.\d+)*(?:-[a-z0-9]+)?$/iu.test(model.id))
    .filter((model) => miniOnly ? /mini/iu.test(model.id) : !/mini/iu.test(model.id))
    .sort((left, right) => compareModelIds(right.id, left.id));
  const model = filtered[0];
  return model ? { ...model, fullId: `openai-codex/${model.id}` } : null;
}

function readLocalModels() {
  const path = join(homedir(), ".openclaw", "agents", "control", "agent", "models.json");
  if (!existsSync(path)) {
    return [];
  }

  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const providers = parsed.providers ?? {};
  const models = [];
  for (const provider of Object.values(providers)) {
    if (Array.isArray(provider?.models)) {
      for (const model of provider.models) {
        if (typeof model?.id === "string") {
          models.push(model);
        }
      }
    }
  }
  return models;
}

function compareModelIds(left, right) {
  const leftParts = parseModelId(left);
  const rightParts = parseModelId(right);
  for (let index = 0; index < Math.max(leftParts.numbers.length, rightParts.numbers.length); index += 1) {
    const diff = (leftParts.numbers[index] ?? 0) - (rightParts.numbers[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }

  if (leftParts.suffix === rightParts.suffix) {
    return 0;
  }
  if (!leftParts.suffix) {
    return 1;
  }
  if (!rightParts.suffix) {
    return -1;
  }
  return leftParts.suffix.localeCompare(rightParts.suffix);
}

function parseModelId(id) {
  const match = /^gpt-([0-9.]+)(?:-([a-z0-9]+))?$/iu.exec(id);
  return {
    numbers: (match?.[1] ?? "0").split(".").map((value) => Number(value) || 0),
    suffix: match?.[2] ?? ""
  };
}

function readOpenClawJson(args) {
  try {
    return JSON.parse(runOpenClaw(args));
  } catch (error) {
    warnings.push(`openclaw ${args.join(" ")} 失败：${error.message}`);
    return null;
  }
}

function runOpenClaw(args) {
  return execFileSync(openclawBin, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
