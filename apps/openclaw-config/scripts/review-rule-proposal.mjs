#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadLocalEnv, sendNotification } from "../../../packages/shared-types/dist/index.js";

const repoRoot = process.cwd();
loadLocalEnv(repoRoot);

const runtimeDir = join(repoRoot, "runtime");
const dbPath = join(runtimeDir, "trading.sqlite");
const mutableStatuses = new Set(["pending_confirmation", "activation_requested", "continued_observation"]);
const statusLabels = {
  pending_confirmation: "待人工确认",
  activation_requested: "已一审建议激活，等待二次确认",
  continued_observation: "继续观察",
  activated: "已激活",
  rejected: "已拒绝",
  archived: "已归档"
};
const actionLabels = {
  observe: "继续观察",
  reject: "拒绝",
  archive: "归档",
  "request-activation": "一审建议激活",
  "confirm-activation": "二次确认激活"
};

const request = parseArgs(process.argv.slice(2));
if (request.dryRun) {
  console.log(JSON.stringify({ dryRun: true, parsed: request }, null, 2));
  process.exit(0);
}

mkdirSync(runtimeDir, { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000;");
db.exec("PRAGMA foreign_keys = ON;");
ensureGovernanceSchema(db);

const result = await dispatchReview(request);
console.log(JSON.stringify(result, null, 2));

async function dispatchReview(review) {
  const proposal = loadProposal(review.proposalId);
  if (review.command === "observe") {
    return updateProposalStatus(proposal, {
      nextStatus: "continued_observation",
      action: "proposal.continued_observation",
      actor: review.actor,
      reason: review.reason || "飞书群人工回复继续观察，暂不激活。"
    });
  }

  if (review.command === "reject") {
    if (!review.reason) {
      printUsageAndExit("拒绝提案必须提供原因。");
    }
    return updateProposalStatus(proposal, {
      nextStatus: "rejected",
      action: "proposal.rejected",
      actor: review.actor,
      reason: review.reason
    });
  }

  if (review.command === "archive") {
    if (!review.reason) {
      printUsageAndExit("归档提案必须提供原因。");
    }
    return updateProposalStatus(proposal, {
      nextStatus: "archived",
      action: "proposal.archived",
      actor: review.actor,
      reason: review.reason
    });
  }

  if (review.command === "request-activation") {
    assertActivationCandidate(proposal);
    return updateProposalStatus(proposal, {
      nextStatus: "activation_requested",
      action: "proposal.activation_requested",
      actor: review.actor,
      reason: review.reason || "飞书群一审建议激活；尚未生效，等待二次确认。"
    });
  }

  if (review.command === "confirm-activation") {
    return confirmActivation(proposal, review);
  }

  printUsageAndExit(`未知审核动作：${review.command}`);
}

async function updateProposalStatus(proposal, decision) {
  const previousStatus = normalizeStatus(proposal.status);
  assertStatusCanMove(proposal, decision.nextStatus);
  const nowIso = new Date().toISOString();

  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    db
      .prepare(`
        UPDATE rule_proposals
        SET status = ?,
            decided_at = ?,
            decided_by = ?,
            decision_reason = ?
        WHERE id = ?
      `)
      .run(decision.nextStatus, nowIso, decision.actor, decision.reason, proposal.id);

    writeAudit("rule-governance", decision.action, {
      proposalId: proposal.id,
      previousStatus,
      status: decision.nextStatus,
      actor: decision.actor,
      reason: decision.reason,
      source: "rule-proposal-review"
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const updated = loadProposal(proposal.id);
  await notifyReviewResult(updated, {
    action: decision.action,
    actionLabel: actionLabelFromStatus(decision.nextStatus),
    actor: decision.actor,
    reason: decision.reason,
    previousStatus
  }).catch((error) => {
    const reason = error instanceof Error ? error.message : String(error);
    writeAudit("rule-governance", "proposal.review_notification_failed", {
      proposalId: proposal.id,
      action: decision.action,
      reason
    });
    console.error(`飞书审核结果通知失败：${reason}`);
  });

  return {
    proposalId: proposal.id,
    previousStatus,
    status: decision.nextStatus,
    action: decision.action,
    actor: decision.actor,
    effective: decision.nextStatus === "activated" ? "规则已激活" : "规则未激活，active-version 未改变"
  };
}

async function confirmActivation(proposal, review) {
  if (review.confirm !== "HUMAN_APPROVED") {
    printUsageAndExit("二次确认激活必须包含 HUMAN_APPROVED。");
  }
  if (normalizeStatus(proposal.status) !== "activation_requested") {
    throw new Error(`提案尚未进入一审建议激活状态，当前状态为：${normalizeStatus(proposal.status)}。请先回复“建议激活 ${proposal.id} 原因”。`);
  }
  assertActivationCandidate(proposal);

  const reason = review.reason || "飞书群二次确认激活，包含 HUMAN_APPROVED。";
  const scriptPath = join(repoRoot, "apps", "openclaw-config", "scripts", "activate-rule-version.mjs");
  const child = spawnSync(process.execPath, [
    scriptPath,
    "activate",
    String(proposal.scope),
    String(proposal.candidate_version),
    "--proposal-id",
    String(proposal.id),
    "--confirm",
    "HUMAN_APPROVED",
    "--actor",
    review.actor,
    "--reason",
    reason
  ], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  if (child.status !== 0) {
    const detail = [child.stderr, child.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`激活脚本拒绝执行，退出码 ${child.status ?? "unknown"}。${detail ? `\n${detail}` : ""}`);
  }

  const updated = loadProposal(proposal.id);
  await notifyReviewResult(updated, {
    action: "rule_version.activated",
    actionLabel: actionLabels["confirm-activation"],
    actor: review.actor,
    reason,
    previousStatus: "activation_requested"
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    writeAudit("rule-governance", "proposal.review_notification_failed", {
      proposalId: proposal.id,
      action: "rule_version.activated",
      reason: message
    });
    console.error(`飞书激活结果通知失败：${message}`);
  });

  return {
    proposalId: proposal.id,
    previousStatus: "activation_requested",
    status: normalizeStatus(updated.status),
    action: "rule_version.activated",
    actor: review.actor,
    effective: "规则已激活",
    activationResult: parseJsonObject(child.stdout)
  };
}

function assertActivationCandidate(proposal) {
  const recommendation = String(proposal.recommendation ?? "");
  if (!["suggest_activation", "promote"].includes(recommendation)) {
    throw new Error(`提案推荐动作不是建议激活，当前 recommendation=${recommendation}。`);
  }
  if (String(proposal.current_version) === String(proposal.candidate_version)) {
    throw new Error("候选版本与当前版本相同，不能进入激活流程。");
  }
}

function assertStatusCanMove(proposal, nextStatus) {
  const previousStatus = normalizeStatus(proposal.status);
  if (previousStatus === nextStatus) {
    return;
  }
  if (previousStatus === "activated") {
    throw new Error("已激活提案不能通过飞书低风险回复改成其他状态；如需回滚必须走新的人工规则版本流程。");
  }
  if (nextStatus === "archived" && previousStatus === "rejected") {
    return;
  }
  if (!mutableStatuses.has(previousStatus)) {
    throw new Error(`提案状态 ${previousStatus} 不能继续变更为 ${nextStatus}。`);
  }
}

async function notifyReviewResult(proposal, review) {
  if (!request.notify) {
    return;
  }

  const result = await sendNotification({
    title: `OpenClaw 规则提案审核结果：${review.actionLabel}`,
    body: renderReviewNotification(proposal, review),
    format: "post"
  });

  writeAudit("rule-governance", result.sent ? "proposal.review_result_notification_sent" : "proposal.review_result_notification_skipped", {
    proposalId: proposal.id,
    action: review.action,
    sent: result.sent,
    target: result.target,
    reason: result.reason ?? null,
    fallback: result.fallback ?? false
  });

  if (!result.sent) {
    console.error(`飞书审核结果通知未发送：${result.reason ?? result.target}`);
  }
}

function renderReviewNotification(proposal, review) {
  const status = normalizeStatus(proposal.status);
  const lines = [
    "# OpenClaw 规则提案审核结果",
    "",
    `- 提案编号：${proposal.id}`,
    `- 标题：${proposal.title || "未命名规则提案"}`,
    `- 适用范围：${proposal.scope}`,
    `- 版本：${proposal.current_version} -> ${proposal.candidate_version}`,
    `- 动作：${review.actionLabel}`,
    `- 状态：${statusLabels[status] ?? status}`,
    `- 操作人：${review.actor}`,
    `- 原因：${review.reason}`,
    `- 旧状态：${statusLabels[review.previousStatus] ?? review.previousStatus}`,
    ""
  ];

  if (status === "activation_requested") {
    lines.push(
      "## 下一步",
      "",
      `- 该提案尚未生效。如需真正激活，请在群里二次回复：确认激活 ${proposal.id} HUMAN_APPROVED 原因`,
      "- 候选规则文件必须已人工落地，激活脚本会再次校验。"
    );
  } else if (status === "activated") {
    lines.push(
      "## 生效说明",
      "",
      "- 规则版本已由激活脚本更新，并写入 audit_log。",
      "- 实盘仍只允许建议卡和人工复核，不允许自动提交真实资金订单。"
    );
  } else {
    lines.push(
      "## 生效说明",
      "",
      "- 本次状态变更没有修改 active-version。",
      "- 未激活的规则提案不会改变 live 或 paper 行为。"
    );
  }

  lines.push(
    "",
    "## 安全边界",
    "",
    "- 不自动提交真实资金订单。",
    "- 不恢复任何期权策略。",
    "- 不允许通过规则提案绕过实盘禁令。"
  );

  return lines.join("\n");
}

function actionLabelFromStatus(status) {
  if (status === "continued_observation") {
    return actionLabels.observe;
  }
  if (status === "activation_requested") {
    return actionLabels["request-activation"];
  }
  if (status === "rejected") {
    return actionLabels.reject;
  }
  if (status === "archived") {
    return actionLabels.archive;
  }
  return statusLabels[status] ?? status;
}

function loadProposal(proposalId) {
  const proposal = db.prepare(`SELECT * FROM rule_proposals WHERE id = ? LIMIT 1`).get(proposalId);
  if (!proposal) {
    throw new Error(`找不到规则提案：${proposalId}`);
  }
  return proposal;
}

function parseArgs(rawArgs) {
  const { positional, flags } = splitFlags(rawArgs);
  const command = normalizeCommand(positional.shift());
  if (!command) {
    printUsageAndExit("缺少审核动作。");
  }

  const actor = flags.actor ?? "feishu-operator";
  const base = {
    command,
    actor,
    reason: normalizeReason(flags.reason ?? positional.slice(1).join(" ")),
    confirm: flags.confirm,
    dryRun: Boolean(flags["dry-run"]),
    notify: !flags["no-notify"]
  };

  if (command === "from-feishu") {
    const message = positional.join(" ").trim();
    if (!message) {
      printUsageAndExit("from-feishu 需要提供群消息文本。");
    }
    return {
      ...base,
      ...parseFeishuMessage(message),
      actor,
      dryRun: base.dryRun,
      notify: base.notify
    };
  }

  const proposalId = positional.shift();
  if (!proposalId) {
    printUsageAndExit("缺少 proposal-id。");
  }

  return {
    ...base,
    proposalId,
    reason: normalizeReason(flags.reason ?? positional.join(" "))
  };
}

function splitFlags(rawArgs) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    if (arg === "--dry-run" || arg === "--no-notify") {
      flags[arg.slice(2)] = true;
      continue;
    }

    const inline = arg.match(/^--([^=]+)=(.*)$/u);
    if (inline) {
      flags[inline[1]] = inline[2];
      continue;
    }

    const key = arg.slice(2);
    const value = rawArgs[index + 1];
    if (!value || value.startsWith("--")) {
      printUsageAndExit(`参数 ${arg} 缺少值。`);
    }
    flags[key] = value;
    index += 1;
  }
  return { positional, flags };
}

function parseFeishuMessage(message) {
  const text = message
    .replace(/[ \t\r\n]+/gu, " ")
    .trim()
    .replace(/^(?:@\S+|<at[^>]*>.*?<\/at>)\s*/u, "")
    .trim();
  const proposalPattern = "(proposal_[A-Za-z0-9_:-]+)";
  const patterns = [
    {
      command: "confirm-activation",
      regex: new RegExp(`^(?:确认激活|二次确认激活|人工确认激活)\\s+${proposalPattern}\\s+HUMAN_APPROVED(?:\\s+(.+))?$`, "u"),
      confirm: "HUMAN_APPROVED",
      defaultReason: "飞书群二次确认激活，包含 HUMAN_APPROVED。"
    },
    {
      command: "request-activation",
      regex: new RegExp(`^(?:建议激活|申请激活|一审建议激活)\\s+${proposalPattern}(?:\\s+(.+))?$`, "u"),
      defaultReason: "飞书群一审建议激活；尚未生效，等待二次确认。"
    },
    {
      command: "observe",
      regex: new RegExp(`^(?:继续观察|观察|暂不激活)\\s+${proposalPattern}(?:\\s+(.+))?$`, "u"),
      defaultReason: "飞书群人工回复继续观察，暂不激活。"
    },
    {
      command: "reject",
      regex: new RegExp(`^拒绝\\s+${proposalPattern}(?:\\s+(.+))?$`, "u")
    },
    {
      command: "archive",
      regex: new RegExp(`^归档\\s+${proposalPattern}(?:\\s+(.+))?$`, "u")
    }
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (!match) {
      continue;
    }
    return {
      command: pattern.command,
      proposalId: match[1],
      reason: normalizeReason(match[2]) || pattern.defaultReason || "",
      confirm: pattern.confirm
    };
  }

  printUsageAndExit(`无法解析飞书审核消息：${message}`);
}

function normalizeCommand(command) {
  const aliases = {
    observe: "observe",
    "continue-observe": "observe",
    "continued-observation": "observe",
    reject: "reject",
    archive: "archive",
    "request-activation": "request-activation",
    "suggest-activation": "request-activation",
    "confirm-activation": "confirm-activation",
    activate: "confirm-activation",
    "from-feishu": "from-feishu"
  };
  return aliases[String(command ?? "")] ?? null;
}

function normalizeReason(value) {
  return String(value ?? "")
    .trim()
    .replace(/^(?:因为|原因[:：]?|[:：,，。；;\s]+)/u, "")
    .trim();
}

function normalizeStatus(value) {
  return String(value ?? "pending_confirmation") || "pending_confirmation";
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value ?? "").trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function ensureGovernanceSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      action TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rule_proposals (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      scope TEXT NOT NULL,
      current_version TEXT NOT NULL,
      candidate_version TEXT NOT NULL,
      summary TEXT NOT NULL,
      old_vs_new TEXT NOT NULL,
      evidence TEXT NOT NULL,
      recommendation TEXT NOT NULL
    );
  `);

  ensureColumn(database, "rule_proposals", "title", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "rule_proposals", "trigger_reason", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "rule_proposals", "expected_benefit", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "rule_proposals", "risks", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(database, "rule_proposals", "rollback_plan", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, "rule_proposals", "status", "TEXT NOT NULL DEFAULT 'pending_confirmation'");
  ensureColumn(database, "rule_proposals", "proposal_path", "TEXT");
  ensureColumn(database, "rule_proposals", "decided_at", "TEXT");
  ensureColumn(database, "rule_proposals", "decided_by", "TEXT");
  ensureColumn(database, "rule_proposals", "decision_reason", "TEXT");
}

function ensureColumn(database, table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((entry) => entry.name === column)) {
    return;
  }
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

function writeAudit(category, action, payload) {
  db
    .prepare(`
      INSERT INTO audit_log (id, category, action, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(`audit_${randomUUID()}`, category, action, JSON.stringify(payload), Date.now());
}

function printUsageAndExit(message) {
  console.error(message);
  console.error([
    "用法：",
    "  node apps/openclaw-config/scripts/review-rule-proposal.mjs from-feishu \"继续观察 <proposal-id> 原因\" --actor <feishu-open-id>",
    "  node apps/openclaw-config/scripts/review-rule-proposal.mjs from-feishu \"拒绝 <proposal-id> 原因\" --actor <feishu-open-id>",
    "  node apps/openclaw-config/scripts/review-rule-proposal.mjs from-feishu \"归档 <proposal-id> 原因\" --actor <feishu-open-id>",
    "  node apps/openclaw-config/scripts/review-rule-proposal.mjs from-feishu \"建议激活 <proposal-id> 原因\" --actor <feishu-open-id>",
    "  node apps/openclaw-config/scripts/review-rule-proposal.mjs from-feishu \"确认激活 <proposal-id> HUMAN_APPROVED 原因\" --actor <feishu-open-id>",
    "  node apps/openclaw-config/scripts/review-rule-proposal.mjs observe <proposal-id> --reason \"...\" --actor <name>",
    "  node apps/openclaw-config/scripts/review-rule-proposal.mjs reject <proposal-id> --reason \"...\" --actor <name>",
    "  node apps/openclaw-config/scripts/review-rule-proposal.mjs archive <proposal-id> --reason \"...\" --actor <name>",
    "  node apps/openclaw-config/scripts/review-rule-proposal.mjs request-activation <proposal-id> --reason \"...\" --actor <name>",
    "  node apps/openclaw-config/scripts/review-rule-proposal.mjs confirm-activation <proposal-id> --confirm HUMAN_APPROVED --reason \"...\" --actor <name>"
  ].join("\n"));
  process.exit(1);
}
