#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getNotificationReadiness,
  loadLocalEnv,
  resolveLongbridgeAuthState,
  sendNotification
} from "../../../packages/shared-types/dist/index.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const runtimeDir = join(repoRoot, "runtime");
const statePath = join(runtimeDir, "maintenance-state.json");
const openclawBin = resolveOpenClawBin();
const longbridgeBin = process.env.LONGBRIDGE_CLI_PATH ?? `${homedir()}/.local/bin/longbridge`;
const maintenanceJobLabel = "com.openclaw.trading.maintenance.latest";

const lowRiskAutoActions = [
  "读取 OpenClaw、Longbridge、Feishu、Git 和本地服务健康状态",
  "把主模型切到本地可用的最新非 mini GPT 模型",
  "把 heartbeat 模型切到本地可用的最新 mini GPT 模型",
  "在 OpenClaw patch/minor 更新可用时自动更新，并在更新后运行 health 与 typecheck",
  "写入 runtime/maintenance-state.json 作为本地运行状态"
];

const adviceOnlyActions = [
  "实盘订单、实盘 broker 写入或任何绕过 broker-executor 的交易动作",
  "期权自动化下单或期权策略自动执行",
  "规则激活、候选规则合并后的自动启用",
  "OpenClaw 大版本更新、迁移、降级或未知类型更新",
  "删除凭证、写入凭证明文、重置 OAuth token 或 SSH 私钥",
  "强推 main、自动推送 main 或改写远端历史"
];

mkdirSync(runtimeDir, { recursive: true });
loadLocalEnv(repoRoot);

const changes = [];
const warnings = [];
const needsHuman = [];
const checks = {};

const startedAt = new Date();

checks.boundaries = {
  lowRiskAutoActions,
  adviceOnlyActions
};

checks.openclaw = checkOpenClawVersion();
checks.openclaw.update = checkOpenClawUpdate(checks.openclaw.version);
const modelCheck = await checkAndUpdateModels();
checks.models = modelCheck.summary;
checks.openclaw.auth = checkModelAuth(modelCheck.authStatus);
checks.openclaw.health = checkOpenClawHealth();
checks.longbridge = checkLongbridge();
checks.feishu = {
  readiness: getNotificationReadiness()
};
checks.git = checkGit();
checks.services = await checkServices();
checks.security = checkSecurity();
checks.launchd = checkLaunchd();
checks.policy = checkRuntimePolicy();

if (checks.openclaw.update.autoUpdated) {
  checks.openclaw.update.verification = verifyAfterOpenClawUpdate();
}

const report = buildChineseReport({
  checkedAt: startedAt,
  checks,
  changes,
  warnings,
  needsHuman
});

let notificationResult;
try {
  notificationResult = await withTimeout(
    sendNotification({
      title: "OpenClaw 维护检查",
      body: report,
      format: "post"
    }),
    20_000,
    "飞书通知发送超时"
  );
  if (!notificationResult.sent) {
    warnings.push(notificationResult.reason ?? `维护报告未发送；目标=${notificationResult.target}`);
    needsHuman.push("飞书维护报告未送达，请检查 Feishu app/webhook 配置和通知目标。");
  }
} catch (error) {
  notificationResult = {
    sent: false,
    target: "none",
    reason: error instanceof Error ? error.message : String(error)
  };
  warnings.push(`飞书维护报告发送失败：${notificationResult.reason}`);
  needsHuman.push("飞书维护报告发送异常，需要人工确认 Feishu 凭证、机器人权限和通知目标。");
}

checks.feishu.delivery = notificationResult;

const state = {
  checkedAt: startedAt.toISOString(),
  completedAt: new Date().toISOString(),
  safeMode: {
    highRiskActionsExecuted: false,
    liveOrdersSubmitted: false,
    optionAutomationExecuted: false,
    rulesActivated: false,
    gitPushPerformed: false,
    credentialsDeleted: false
  },
  checks,
  changes,
  warnings,
  needsHuman
};

writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
console.log(JSON.stringify(state, null, 2));

function checkOpenClawVersion() {
  const result = runCommand(openclawBin, ["--version"], { timeoutMs: 10_000 });
  const parsed = parseOpenClawVersion(result.stdout || result.stderr);
  if (!result.ok) {
    warnings.push(`OpenClaw CLI 不可用：${result.message}`);
    needsHuman.push("请确认 OpenClaw CLI 已安装，并设置 OPENCLAW_BIN 或恢复默认路径。");
  }

  return {
    ok: result.ok,
    bin: displayPath(openclawBin),
    version: parsed.version,
    revision: parsed.revision,
    message: result.ok ? null : result.message
  };
}

function resolveOpenClawBin() {
  if (process.env.OPENCLAW_BIN) {
    return process.env.OPENCLAW_BIN;
  }

  const candidates = [
    `${homedir()}/.local/node-v24/bin/openclaw`,
    `${homedir()}/.local/node-v24/bin/openclaw.unproxied`
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function checkOpenClawUpdate(currentVersion) {
  const status = readOpenClawJson(["update", "status", "--json"], { timeoutMs: 45_000 });
  const availability = status?.availability ?? {};
  const latestVersion = availability.latestVersion
    ?? status?.update?.registry?.latestVersion
    ?? status?.update?.latestVersion
    ?? null;
  const updateKind = classifyVersionBump(currentVersion, latestVersion);
  const update = {
    ok: Boolean(status),
    available: Boolean(availability.available),
    channel: status?.channel?.value ?? status?.updateChannel ?? null,
    installKind: status?.update?.installKind ?? null,
    currentVersion,
    latestVersion,
    updateKind,
    hasGitUpdate: Boolean(availability.hasGitUpdate),
    hasRegistryUpdate: Boolean(availability.hasRegistryUpdate),
    autoUpdated: false,
    action: "none"
  };

  if (!status) {
    needsHuman.push("OpenClaw 更新状态读取失败，需要人工运行 openclaw update status。");
    return update;
  }

  if (!update.available) {
    return update;
  }

  if (update.hasGitUpdate && !latestVersion) {
    warnings.push("检测到 OpenClaw 源码更新，但无法判断版本级别；已按高风险更新处理，仅生成建议。");
    needsHuman.push("人工 review OpenClaw git 更新后再决定是否执行 openclaw update。");
    update.action = "suggested";
    return update;
  }

  if (!["patch", "minor"].includes(updateKind)) {
    warnings.push(`检测到 OpenClaw ${updateKind} 更新：${currentVersion ?? "unknown"} -> ${latestVersion ?? "unknown"}；不会自动执行。`);
    needsHuman.push("OpenClaw 大版本、迁移、降级或未知类型更新需要人工确认。");
    update.action = "suggested";
    return update;
  }

  if (process.env.OPENCLAW_APPLY_UPDATES === "0") {
    warnings.push("检测到 OpenClaw 可更新，但 OPENCLAW_APPLY_UPDATES=0，已跳过自动更新。");
    needsHuman.push("如需自动更新 OpenClaw patch/minor，请移除 OPENCLAW_APPLY_UPDATES=0 后重跑维护检查。");
    update.action = "skipped";
    return update;
  }

  const result = readOpenClawJson(["update", "--yes", "--json", "--timeout", "1200"], { timeoutMs: 1_260_000 });
  update.autoUpdated = Boolean(result);
  update.action = result ? "updated" : "failed";
  update.result = summarizeUpdateResult(result);
  if (result) {
    changes.push(`OpenClaw 已自动执行 ${updateKind} 更新：${currentVersion ?? "unknown"} -> ${latestVersion ?? "unknown"}`);
  } else {
    warnings.push("OpenClaw patch/minor 自动更新执行失败。");
    needsHuman.push("请人工运行 openclaw update --dry-run 和 openclaw update，确认失败原因。");
  }

  return update;
}

async function checkAndUpdateModels() {
  const currentDefaults = readOpenClawJson(["config", "get", "agents.defaults", "--json"], { timeoutMs: 15_000 });
  const status = readOpenClawJson(["models", "status", "--agent", "control", "--json"], { timeoutMs: 30_000 });
  const listed = readOpenClawJson(["models", "list", "--agent", "control", "--json"], { timeoutMs: 30_000 });
  const localModels = readLocalModels(listed);
  const latestModel = findLatestModel(false, localModels);
  const latestMiniModel = findLatestModel(true, localModels);
  const currentPrimary = currentDefaults?.model?.primary ?? status?.resolvedDefault ?? status?.defaultModel ?? null;
  const currentHeartbeat = currentDefaults?.heartbeat?.model ?? null;

  const summary = {
    currentPrimary,
    currentHeartbeat,
    latestPrimary: latestModel?.fullId ?? null,
    latestHeartbeat: latestMiniModel?.fullId ?? null,
    availableModels: localModels.map((model) => model.fullId).sort(),
    status: summarizeModelStatus(status)
  };

  if (!latestModel) {
    warnings.push("未能识别本地可用的最新非 mini GPT 模型，主模型保持不变。");
    needsHuman.push("请检查 OpenClaw models list 或本地 models.json 是否包含可用模型。");
  } else if (currentPrimary !== latestModel.fullId) {
    const setPrimary = readOpenClawJson([
      "config",
      "set",
      "agents.defaults.model.primary",
      JSON.stringify(latestModel.fullId),
      "--strict-json"
    ], { timeoutMs: 15_000 });
    const setAlias = readOpenClawJson([
      "config",
      "set",
      `agents.defaults.models[${JSON.stringify(latestModel.fullId)}]`,
      JSON.stringify({ alias: "gpt-latest" }),
      "--strict-json"
    ], { timeoutMs: 15_000 });
    if (setPrimary && setAlias) {
      changes.push(`主模型切换：${currentPrimary ?? "unknown"} -> ${latestModel.fullId}`);
      summary.currentPrimary = latestModel.fullId;
    }
  }

  if (!latestMiniModel) {
    warnings.push("未能识别本地可用的最新 mini GPT 模型，heartbeat 模型保持不变。");
    needsHuman.push("请检查 OpenClaw models list 或本地 models.json 是否包含 mini 模型。");
  } else if (currentHeartbeat !== latestMiniModel.fullId) {
    const setHeartbeat = readOpenClawJson([
      "config",
      "set",
      "agents.defaults.heartbeat.model",
      JSON.stringify(latestMiniModel.fullId),
      "--strict-json"
    ], { timeoutMs: 15_000 });
    const setAlias = readOpenClawJson([
      "config",
      "set",
      `agents.defaults.models[${JSON.stringify(latestMiniModel.fullId)}]`,
      JSON.stringify({ alias: "gpt-mini" }),
      "--strict-json"
    ], { timeoutMs: 15_000 });
    if (setHeartbeat && setAlias) {
      changes.push(`heartbeat 模型切换：${currentHeartbeat ?? "unknown"} -> ${latestMiniModel.fullId}`);
      summary.currentHeartbeat = latestMiniModel.fullId;
    }
  }

  const finalDefaults = readOpenClawJson(["config", "get", "agents.defaults", "--json"], { timeoutMs: 15_000 });
  summary.finalPrimary = finalDefaults?.model?.primary ?? summary.currentPrimary;
  summary.finalHeartbeat = finalDefaults?.heartbeat?.model ?? summary.currentHeartbeat;

  return {
    summary,
    authStatus: status?.auth ?? {}
  };
}

function checkModelAuth(authStatus) {
  const auth = authStatus ?? {};
  const oauthProviders = Array.isArray(auth.oauth?.providers) ? auth.oauth.providers : [];
  const expired = oauthProviders.filter((entry) => entry?.status === "expired");
  const warningProviders = oauthProviders.filter((entry) => entry?.status && entry.status !== "valid" && entry.status !== "ok");
  const missingProviders = Array.isArray(auth.missingProvidersInUse) ? auth.missingProvidersInUse : [];
  const unusableProfiles = Array.isArray(auth.unusableProfiles) ? auth.unusableProfiles : [];

  if (expired.length > 0) {
    warnings.push(`OpenClaw 模型 OAuth 已过期：${expired.map((entry) => entry.provider ?? "unknown").join(", ")}。`);
    needsHuman.push("请人工重新登录 OpenClaw 模型提供方 OAuth；维护脚本不会重置或删除凭证。");
  }
  if (missingProviders.length > 0) {
    warnings.push(`OpenClaw 缺少正在使用的模型提供方认证：${missingProviders.join(", ")}。`);
    needsHuman.push("请人工恢复 OpenClaw 模型认证；维护脚本不会写入、重置或删除模型凭证。");
  }
  if (unusableProfiles.length > 0) {
    warnings.push(`OpenClaw 存在不可用 auth profile：${unusableProfiles.length} 个。`);
    needsHuman.push("请人工检查 OpenClaw auth profile 状态；维护脚本只报告，不改动凭证。");
  }

  return {
    ok: expired.length === 0 && missingProviders.length === 0 && unusableProfiles.length === 0,
    providersWithOAuth: auth.providersWithOAuth ?? [],
    oauthProviders: oauthProviders.map((entry) => ({
      provider: entry.provider ?? "unknown",
      status: entry.status ?? "unknown",
      expiresAt: entry.expiresAt ?? null,
      remainingMs: entry.remainingMs ?? null
    })),
    missingProvidersInUse: missingProviders,
    unusableProfilesCount: unusableProfiles.length
  };
}

function checkOpenClawHealth() {
  const health = readOpenClawJson(["health", "--json", "--timeout", "5000"], { timeoutMs: 10_000 });
  if (!health) {
    warnings.push("OpenClaw health 读取失败或 Gateway 不可达。");
    needsHuman.push("请人工运行 openclaw health --json 检查 Gateway、通道和心跳状态。");
    return {
      ok: false,
      reachable: false
    };
  }

  const feishu = health.channels?.feishu;
  if (feishu?.configured && feishu?.probe?.ok === false) {
    warnings.push(`OpenClaw Feishu 探测失败：${feishu.lastError ?? "unknown"}`);
  }

  return {
    ok: Boolean(health.ok),
    reachable: true,
    defaultAgentId: health.defaultAgentId ?? null,
    heartbeatSeconds: health.heartbeatSeconds ?? null,
    channelOrder: health.channelOrder ?? [],
    feishu: feishu
      ? {
          configured: Boolean(feishu.configured),
          running: Boolean(feishu.running),
          probeOk: feishu.probe?.ok ?? null,
          lastError: feishu.lastError ?? null,
          accountId: feishu.accountId ?? null
        }
      : null,
    agentCount: Array.isArray(health.agents) ? health.agents.length : null
  };
}

function checkLongbridge() {
  const auth = resolveLongbridgeAuthState();
  const versionResult = runCommand(longbridgeBin, ["--version"], { timeoutMs: 10_000 });
  const currentVersion = parseVersionFromText(versionResult.stdout || versionResult.stderr);
  const checkResult = runCommand(longbridgeBin, ["check", "--format", "json"], { timeoutMs: 45_000 });
  const output = `${checkResult.stdout}\n${checkResult.stderr}`.trim();
  const checkJson = parseJsonLoose(checkResult.stdout) ?? parseJsonLoose(output);
  const latestVersion = parseLongbridgeUpdateVersion(output);
  const tokenStatus = checkJson?.session?.token ?? null;
  const connectivity = checkJson?.connectivity ?? {};
  const activeRegion = String(checkJson?.region?.active ?? "").toLowerCase();
  const failedActiveRegions = Object.entries(connectivity)
    .filter(([key, value]) => value && value.ok === false && key.toLowerCase() === activeRegion)
    .map(([key]) => key);

  if (!versionResult.ok) {
    warnings.push(`Longbridge CLI 不可用：${versionResult.message}`);
    needsHuman.push("请确认 Longbridge CLI 已安装，并设置 LONGBRIDGE_CLI_PATH 或恢复默认路径。");
  }
  if (!auth.configured) {
    warnings.push("未检测到 Longbridge token。");
    needsHuman.push("请人工运行 longbridge login；维护脚本不会写入或删除 broker 凭证。");
  }
  if (!checkResult.ok || tokenStatus !== "valid") {
    warnings.push(`Longbridge token 检查异常：${tokenStatus ?? checkResult.message ?? "unknown"}`);
    needsHuman.push("请人工确认 Longbridge token 是否过期，以及 token 是否属于预期账户。");
  }
  if (latestVersion && currentVersion && latestVersion !== currentVersion) {
    warnings.push(`Longbridge CLI 发现新版本：${currentVersion} -> ${latestVersion}。`);
    needsHuman.push("Longbridge CLI 更新只生成建议，请人工运行 longbridge update 后复查 token。");
  }
  if (failedActiveRegions.length > 0) {
    warnings.push(`Longbridge 当前 active API 区域连通性异常：${failedActiveRegions.join(", ")}。`);
    needsHuman.push("请人工确认 Longbridge active region、网络和 token 状态。");
  }

  return {
    ok: versionResult.ok && checkResult.ok && auth.configured && tokenStatus === "valid",
    bin: displayPath(longbridgeBin),
    version: currentVersion,
    latestVersion,
    updateAvailable: Boolean(latestVersion && currentVersion && latestVersion !== currentVersion),
    auth: {
      configured: auth.configured,
      source: auth.source
    },
    tokenStatus,
    activeRegion: checkJson?.region?.active ?? null,
    connectivity: Object.fromEntries(
      Object.entries(connectivity).map(([key, value]) => [
        key,
        {
          ok: value?.ok ?? null,
          ms: value?.ms ?? null,
          active: key.toLowerCase() === activeRegion
        }
      ])
    ),
    message: checkResult.ok ? null : checkResult.message
  };
}

function checkGit() {
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim() || null;
  const status = runGit(["status", "--short"]).stdout
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const upstream = runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const aheadBehind = upstream.ok ? runGit(["rev-list", "--left-right", "--count", "HEAD...@{u}"]) : null;
  const [aheadRaw, behindRaw] = aheadBehind?.stdout.trim().split(/\s+/u) ?? [];
  const ahead = Number(aheadRaw ?? 0) || 0;
  const behind = Number(behindRaw ?? 0) || 0;

  if (branch === "main" || branch === "master") {
    warnings.push(`当前 Git 分支是 ${branch}；维护脚本不会推送或强推主分支。`);
    needsHuman.push("如需提交维护代码，请先切到 codex/ 前缀分支。");
  }
  if (status.length > 0) {
    warnings.push(`Git 工作区有 ${status.length} 个未提交变更；维护脚本不会自动提交或推送。`);
  }

  return {
    branch,
    upstream: upstream.ok ? upstream.stdout.trim() : null,
    dirty: status.length > 0,
    dirtyCount: status.length,
    status,
    ahead,
    behind
  };
}

async function checkServices() {
  const services = [
    { name: "event-bus", env: "EVENT_BUS_PORT", port: 4310 },
    { name: "event-ingestor", env: "EVENT_INGESTOR_PORT", port: 4311 },
    { name: "broker-executor", env: "BROKER_EXECUTOR_PORT", port: 4312 },
    { name: "live-advisor", env: "LIVE_ADVISOR_PORT", port: 4314 },
    { name: "paper-trader", env: "PAPER_TRADER_PORT", port: 4315 }
  ];

  const results = {};
  for (const service of services) {
    const port = Number(process.env[service.env] ?? service.port);
    const health = await fetchHealth(`http://127.0.0.1:${port}/health`);
    results[service.name] = {
      port,
      ...health
    };
  }

  const down = Object.entries(results)
    .filter(([, value]) => !value.ok)
    .map(([name]) => name);
  if (down.length > 0) {
    warnings.push(`本地服务健康检查未全部通过：${down.join(", ")}。`);
    needsHuman.push("请人工确认 launchd/system daemon 或开发进程是否需要启动；维护脚本只做健康检查。");
  }

  return results;
}

function checkSecurity() {
  const openclawAudit = readOpenClawJson(["security", "audit", "--json"], { timeoutMs: 45_000 });
  const pnpmAudit = readCommandJson("pnpm", ["audit", "--prod", "--json"], { timeoutMs: 120_000, allowNonZero: true });
  const openclawFindings = Array.isArray(openclawAudit?.findings) ? openclawAudit.findings : [];
  const normalizedOpenClawFindings = openclawFindings.map(normalizeOpenClawSecurityFinding);
  const actionableOpenClawWarnCount = normalizedOpenClawFindings.filter((finding) => finding.severity === "warn").length;
  const actionableOpenClawCriticalCount = normalizedOpenClawFindings.filter((finding) => finding.severity === "critical").length;
  const vulnerabilitySummary = pnpmAudit?.metadata?.vulnerabilities ?? null;
  const highDependencyWarnings = Number(vulnerabilitySummary?.high ?? 0) + Number(vulnerabilitySummary?.critical ?? 0);

  if (!openclawAudit) {
    warnings.push("OpenClaw security audit 读取失败。");
  }
  if (actionableOpenClawWarnCount > 0 || actionableOpenClawCriticalCount > 0) {
    warnings.push(`OpenClaw security audit 发现 ${actionableOpenClawCriticalCount} 个 critical、${actionableOpenClawWarnCount} 个需处理 warning。`);
  }
  if (highDependencyWarnings > 0) {
    warnings.push(`pnpm audit 发现 high/critical 依赖安全告警：${highDependencyWarnings} 个。`);
    needsHuman.push("依赖安全告警需要人工 review 后决定升级范围。");
  }

  return {
    openclaw: {
      ok: Boolean(openclawAudit),
      rawSummary: openclawAudit?.summary ?? null,
      summary: {
        critical: actionableOpenClawCriticalCount,
        warn: actionableOpenClawWarnCount,
        info: normalizedOpenClawFindings.filter((finding) => finding.severity === "info").length
      },
      findings: normalizedOpenClawFindings
    },
    dependencies: {
      ok: Boolean(pnpmAudit),
      vulnerabilities: vulnerabilitySummary,
      advisoryCount: pnpmAudit?.advisories ? Object.keys(pnpmAudit.advisories).length : 0
    }
  };
}

function normalizeOpenClawSecurityFinding(finding) {
  const checkId = finding.checkId ?? null;
  const rawSeverity = finding.severity ?? "unknown";
  const detail = typeof finding.detail === "string" ? finding.detail : "";
  let severity = rawSeverity;
  let status = rawSeverity === "warn" || rawSeverity === "critical" ? "actionable" : "observed";
  let note = null;

  if (checkId === "security.trust_model.multi_user_heuristic") {
    note = "本机可信用户模式保留 agents.defaults.sandbox.mode=off；缓解条件是 loopback 网关、Feishu 群 allowlist、实盘执行关闭、期权自动化关闭。";
    status = "accepted";
    if (
      detail.includes("No unguarded runtime/process tools were detected")
      && detail.includes("No unguarded runtime/filesystem contexts detected")
    ) {
      severity = "info";
      status = "mitigated";
    }
  }

  if (checkId === "plugins.allow_phantom_entries") {
    note = "可修复项：plugins.allow 只应保留已安装外部插件；bundled runtime/channel 插件通过 entries 或 channel config 启用。";
  }

  return {
    checkId,
    severity,
    rawSeverity,
    status,
    title: finding.title ?? "unknown",
    remediation: finding.remediation ?? null,
    note
  };
}

function checkLaunchd() {
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${maintenanceJobLabel}.plist`);
  const result = platform() === "darwin"
    ? runCommand("launchctl", ["print", `gui/${process.getuid?.()}/${maintenanceJobLabel}`], { timeoutMs: 10_000 })
    : { ok: false, stdout: "", stderr: "", message: "launchd only runs on macOS" };
  const installed = existsSync(plistPath);
  const loaded = result.ok;

  if (!installed || !loaded) {
    warnings.push(`每日维护 launchd 任务未完全就绪：installed=${installed ? "yes" : "no"}, loaded=${loaded ? "yes" : "no"}。`);
    needsHuman.push("请运行 pnpm launchd:install-user，确认 com.openclaw.trading.maintenance.latest 每天 09:10 执行。");
  }

  return {
    label: maintenanceJobLabel,
    schedule: "每天 09:10",
    installed,
    loaded,
    plistPath: displayPath(plistPath)
  };
}

function checkRuntimePolicy() {
  const liveExecutionEnabled = process.env.ALLOW_LIVE_EXECUTION === "true";
  const officialPaperExecutionEnabled = process.env.LONGBRIDGE_OFFICIAL_PAPER_ENABLED === "true"
    && process.env.LONGBRIDGE_ACCOUNT_MODE === "paper";

  if (liveExecutionEnabled) {
    warnings.push("检测到 ALLOW_LIVE_EXECUTION=true；维护脚本不会提交实盘订单，但运行环境存在实盘开关。");
    needsHuman.push("请人工确认实盘执行开关是否仍需保持开启，并执行第二确认流程。");
  }

  return {
    liveExecutionEnabled,
    officialPaperExecutionEnabled,
    highRiskActionsBlocked: true
  };
}

function verifyAfterOpenClawUpdate() {
  const health = readOpenClawJson(["health", "--json", "--timeout", "10000"], { timeoutMs: 20_000 });
  const typecheck = runCommand("pnpm", ["-r", "run", "typecheck"], { timeoutMs: 180_000 });
  if (!health?.ok) {
    warnings.push("OpenClaw 更新后 health 未通过。");
    needsHuman.push("请人工检查 OpenClaw Gateway 和 channel 状态。");
  }
  if (!typecheck.ok) {
    warnings.push(`OpenClaw 更新后 typecheck 失败：${typecheck.message}`);
    needsHuman.push("请人工修复 typecheck，再继续维护变更。");
  }
  if (health?.ok && typecheck.ok) {
    changes.push("OpenClaw 更新后 health 与 typecheck 已通过。");
  }

  return {
    healthOk: Boolean(health?.ok),
    typecheckOk: typecheck.ok,
    typecheckMessage: typecheck.ok ? null : typecheck.message
  };
}

function buildChineseReport({ checkedAt, checks, changes, warnings, needsHuman }) {
  const serviceSummary = Object.entries(checks.services)
    .map(([name, value]) => `${name}:${value.ok ? "正常" : "异常"}`)
    .join("，");
  const securitySummary = checks.security.openclaw.summary
    ? `critical ${checks.security.openclaw.summary.critical ?? 0} / warn ${checks.security.openclaw.summary.warn ?? 0}`
    : "未获取";
  const dependencyVulnerabilities = checks.security.dependencies.vulnerabilities;
  const dependencySummary = dependencyVulnerabilities
    ? `critical ${dependencyVulnerabilities.critical ?? 0} / high ${dependencyVulnerabilities.high ?? 0} / moderate ${dependencyVulnerabilities.moderate ?? 0}`
    : "未获取";

  const lines = [
    "## 当前状态",
    "",
    `- 检查时间：${checkedAt.toLocaleString("zh-CN", { timeZone: process.env.TZ || "Asia/Shanghai" })}`,
    `- OpenClaw：${checks.openclaw.version ?? "unknown"}；更新状态：${checks.openclaw.update.available ? `可更新（${checks.openclaw.update.updateKind}，最新 ${checks.openclaw.update.latestVersion ?? "unknown"}）` : "无可用更新"}`,
    `- 主模型：${checks.models.finalPrimary ?? checks.models.currentPrimary ?? "unknown"}；本地最新非 mini：${checks.models.latestPrimary ?? "未识别"}`,
    `- heartbeat 模型：${checks.models.finalHeartbeat ?? checks.models.currentHeartbeat ?? "unknown"}；本地最新 mini：${checks.models.latestHeartbeat ?? "未识别"}`,
    `- OpenClaw auth：${checks.openclaw.auth.ok ? "正常" : "异常"}${formatAuthProviders(checks.openclaw.auth)}`,
    `- Longbridge CLI：${checks.longbridge.version ?? "unknown"}${checks.longbridge.updateAvailable ? `（发现新版本 ${checks.longbridge.latestVersion}）` : ""}；token：${checks.longbridge.tokenStatus ?? (checks.longbridge.auth.configured ? "已配置" : "未配置")}`,
    `- Feishu：通知目标 ${checks.feishu.readiness.enabled ? "已配置" : "未配置"}；报告发送 ${checks.feishu.delivery ? (checks.feishu.delivery.sent ? "成功" : "失败") : "发送中（以本消息为验证）"}`,
    `- Git：${checks.git.branch ?? "unknown"}；工作区 ${checks.git.dirty ? `${checks.git.dirtyCount} 项未提交` : "干净"}；ahead=${checks.git.ahead} behind=${checks.git.behind}`,
    `- 本地服务：${serviceSummary || "未检查"}`,
    `- OpenClaw security audit：${securitySummary}`,
    `- pnpm audit：${dependencySummary}`,
    `- 每日维护任务：${checks.launchd.installed && checks.launchd.loaded ? "已安装并加载" : "需要确认"}（每天 09:10）`,
    "",
    "## OpenClaw Security Audit 说明",
    "",
    ...formatSecurityFindings(checks.security.openclaw.findings),
    "",
    "## 本次自动动作",
    "",
    ...listOrNone(changes, "没有执行自动变更。"),
    "",
    "## 风险警告",
    "",
    ...listOrNone(warnings, "无。"),
    "",
    "## 需要人工处理",
    "",
    ...listOrNone(unique(needsHuman), "暂无。"),
    "",
    "## 自我迭代边界",
    "",
    "- 允许自动执行：低风险检查、模型默认值切换、patch/minor 更新、更新后 health/typecheck、本地 runtime 状态写入。",
    "- 只生成建议不执行：实盘交易、期权自动化、规则激活、大版本/迁移更新、凭证删除、强推 main。",
    "- 本次高风险动作执行：否。"
  ];

  return lines.join("\n");
}

function formatSecurityFindings(findings) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return ["- 无。"];
  }

  return findings.map((finding) => {
    const status = finding.status ?? "observed";
    const severity = finding.severity ?? finding.rawSeverity ?? "unknown";
    const note = finding.note ? `；说明：${finding.note}` : "";
    return `- ${finding.checkId ?? "unknown"}：${severity}/${status}${note}`;
  });
}

function formatAuthProviders(auth) {
  if (!Array.isArray(auth.oauthProviders) || auth.oauthProviders.length === 0) {
    return "";
  }
  const summary = auth.oauthProviders
    .map((entry) => `${entry.provider}:${entry.status}`)
    .join("，");
  return `（${summary}）`;
}

function listOrNone(values, fallback) {
  const filtered = unique(values.map((entry) => String(entry).trim()).filter(Boolean));
  return filtered.length > 0 ? filtered.map((entry) => `- ${entry}`) : [`- ${fallback}`];
}

function findLatestModel(miniOnly, models) {
  const filtered = models
    .filter((model) => /^gpt-\d+(?:\.\d+)*(?:-[a-z0-9]+)?$/iu.test(model.id))
    .filter((model) => miniOnly ? /mini/iu.test(model.id) : !/mini/iu.test(model.id))
    .sort((left, right) => compareModelIds(right.id, left.id));
  return filtered[0] ?? null;
}

function readLocalModels(listed) {
  const models = new Map();
  for (const fullId of listAvailableModelIds(listed)) {
    const id = modelShortId(fullId);
    if (id) {
      models.set(fullId, { id, fullId });
    }
  }

  const agentsDir = join(homedir(), ".openclaw", "agents");
  if (existsSync(agentsDir)) {
    for (const agentId of readdirSync(agentsDir)) {
      const path = join(agentsDir, agentId, "agent", "models.json");
      if (!existsSync(path)) {
        continue;
      }
      for (const model of readModelsJson(path)) {
        models.set(model.fullId, model);
      }
    }
  }

  return Array.from(models.values());
}

function listAvailableModelIds(listed) {
  if (!Array.isArray(listed?.models)) {
    return [];
  }
  return listed.models
    .filter((model) => model?.available !== false && !model?.missing)
    .map((model) => model.key)
    .filter((key) => typeof key === "string" && key.length > 0);
}

function summarizeModelStatus(status) {
  if (!status || typeof status !== "object") {
    return null;
  }

  return {
    configPath: status.configPath ? displayPath(status.configPath) : null,
    agentId: status.agentId ?? null,
    defaultModel: status.defaultModel ?? null,
    resolvedDefault: status.resolvedDefault ?? null,
    aliases: status.aliases ?? {},
    allowed: Array.isArray(status.allowed) ? status.allowed : [],
    fallbackCount: Array.isArray(status.fallbacks) ? status.fallbacks.length : null,
    imageModel: status.imageModel ?? null
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
        if (typeof model?.id !== "string") {
          continue;
        }
        const fullId = normalizeModelFullId(providerId, model.id);
        const id = modelShortId(fullId);
        if (id) {
          models.push({ id, fullId });
        }
      }
    }
    return models;
  } catch (error) {
    warnings.push(`读取模型文件失败：${displayPath(path)}；${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function normalizeModelFullId(providerId, id) {
  if (id.includes("/")) {
    return id;
  }
  const provider = providerId === "codex" ? "openai-codex" : providerId;
  return `${provider}/${id}`;
}

function modelShortId(fullId) {
  const id = String(fullId).split("/").at(-1);
  return id && /^gpt-/iu.test(id) ? id : null;
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

function readOpenClawJson(args, options = {}) {
  return readCommandJson(openclawBin, args, options, `openclaw ${args.join(" ")}`);
}

async function withTimeout(promise, timeoutMs, label) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(label)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function readCommandJson(command, args, options = {}, label = `${basename(command)} ${args.join(" ")}`) {
  const result = runCommand(command, args, options);
  const parsed = parseJsonLoose(result.stdout);
  if (!result.ok && !(options.allowNonZero && parsed)) {
    warnings.push(`${label} 失败：${result.message}`);
    return parsed;
  }
  if (!parsed) {
    warnings.push(`${label} 未返回可解析 JSON。`);
  }
  return parsed;
}

function runGit(args) {
  return runCommand("git", args, { timeoutMs: 20_000 });
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30_000,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const timedOut = result.error?.code === "ETIMEDOUT";
  const ok = !timedOut && !result.error && result.status === 0;
  return {
    ok,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    message: result.error?.message
      ?? (timedOut ? "command timed out" : (result.stderr || result.stdout || `exit ${result.status}`).trim())
  };
}

async function fetchHealth(url) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(3_000)
    });
    const body = await response.json().catch(() => null);
    return {
      ok: response.ok && body?.ok !== false,
      reachable: true,
      status: response.status,
      service: body?.service ?? null,
      details: summarizeServiceHealth(body)
    };
  } catch (error) {
    return {
      ok: false,
      reachable: false,
      status: null,
      service: null,
      details: null,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function summarizeServiceHealth(body) {
  if (!body || typeof body !== "object") {
    return null;
  }

  return {
    notificationEnabled: body.notificationEnabled ?? null,
    notificationTarget: body.notificationTarget ?? null,
    deadLetters: body.deadLetters ?? null,
    openPositions: body.openPositions ?? body.paperOpenPositions ?? null,
    liveExecutionEnabled: body.liveExecutionEnabled ?? null,
    officialPaperExecutionEnabled: body.officialPaperExecutionEnabled ?? null,
    longbridgeAuth: body.longbridgeAuth
      ? {
          configured: Boolean(body.longbridgeAuth.configured),
          source: body.longbridgeAuth.source ?? "unknown"
        }
      : null
  };
}

function parseOpenClawVersion(text) {
  const match = /OpenClaw\s+([0-9][\w.-]*)(?:\s+\(([^)]+)\))?/u.exec(text);
  return {
    version: match?.[1] ?? parseVersionFromText(text),
    revision: match?.[2] ?? null
  };
}

function parseVersionFromText(text) {
  return /([0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?)/u.exec(text)?.[1] ?? null;
}

function parseLongbridgeUpdateVersion(text) {
  return /New version\s+([0-9]+(?:\.[0-9]+){1,3})\s+is available/iu.exec(text)?.[1] ?? null;
}

function parseJsonLoose(text) {
  const raw = String(text ?? "").trim();
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    // Some CLIs append human update notices around machine JSON.
  }

  const candidates = ["{", "["]
    .map((char) => ({ char, index: raw.indexOf(char) }))
    .filter((entry) => entry.index >= 0)
    .sort((left, right) => left.index - right.index);
  const start = candidates[0]?.index;
  if (start === undefined) {
    return null;
  }

  const end = findJsonEnd(raw, start);
  if (end < start) {
    return null;
  }

  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function findJsonEnd(text, start) {
  const opener = text[start];
  const closer = opener === "{" ? "}" : "]";
  const stack = [closer];
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }
    if (char === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) {
        return index;
      }
    }
  }

  return -1;
}

function classifyVersionBump(currentVersion, latestVersion) {
  const current = parseNumericVersion(currentVersion);
  const latest = parseNumericVersion(latestVersion);
  if (!current || !latest) {
    return "unknown";
  }
  if (compareNumericVersion(latest, current) <= 0) {
    return "none";
  }
  if ((latest[0] ?? 0) !== (current[0] ?? 0)) {
    return "major";
  }
  if ((latest[1] ?? 0) !== (current[1] ?? 0)) {
    return "minor";
  }
  return "patch";
}

function parseNumericVersion(version) {
  if (typeof version !== "string") {
    return null;
  }
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?/u.exec(version);
  if (!match) {
    return null;
  }
  return match.slice(1).map((part) => Number(part ?? 0));
}

function compareNumericVersion(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function summarizeUpdateResult(result) {
  if (!result || typeof result !== "object") {
    return result ?? null;
  }
  return {
    result: result.result ?? null,
    availability: result.availability ?? null,
    version: result.version ?? null
  };
}

function unique(values) {
  return Array.from(new Set(values));
}

function displayPath(path) {
  const home = homedir();
  return String(path).startsWith(home) ? `~${String(path).slice(home.length)}` : path;
}
