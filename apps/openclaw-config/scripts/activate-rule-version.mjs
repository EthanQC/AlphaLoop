#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const repoRoot = process.cwd();
const runtimeDir = join(repoRoot, "runtime");
const dbPath = join(runtimeDir, "trading.sqlite");
const validScopes = new Set(["live", "paper"]);
const args = process.argv.slice(2);
const command = args[0] === "activate" || args[0] === "reject" || args[0] === "archive"
  ? args.shift()
  : "activate";

mkdirSync(runtimeDir, { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000;");
db.exec("PRAGMA foreign_keys = ON;");
ensureGovernanceSchema(db);

if (command === "activate") {
  activateRuleVersion(args);
} else if (command === "reject") {
  updateProposalDecision(args, {
    status: "rejected",
    confirmation: "HUMAN_REJECTED",
    action: "proposal.rejected"
  });
} else if (command === "archive") {
  updateProposalDecision(args, {
    status: "archived",
    confirmation: "HUMAN_ARCHIVED",
    action: "proposal.archived"
  });
}

function activateRuleVersion(commandArgs) {
  const scope = commandArgs.shift();
  const version = commandArgs.shift();
  const flags = parseFlags(commandArgs);
  const actor = flags.actor ?? "human-operator";
  const proposalId = flags["proposal-id"];
  const reason = flags.reason ?? "人工明确确认激活候选规则版本。";

  if (!scope || !validScopes.has(scope) || !version) {
    printUsageAndExit("激活规则必须显式提供范围和版本。");
  }
  if (flags.confirm !== "HUMAN_APPROVED") {
    printUsageAndExit("激活规则必须提供 --confirm HUMAN_APPROVED。");
  }
  if (!proposalId) {
    printUsageAndExit("激活规则必须提供 --proposal-id，确保可追溯到具体提案。");
  }

  const activePath = join(repoRoot, "rules", scope, "active-version.json");
  const candidateRulePath = join(repoRoot, "rules", scope, version, "rule-set.json");
  if (!existsSync(candidateRulePath)) {
    throw new Error(`候选规则文件不存在：${candidateRulePath}。请先通过人工 PR 或文件落地候选版本，再激活。`);
  }

  const current = JSON.parse(readFileSync(activePath, "utf8"));
  if (current.activeVersion === version) {
    throw new Error(`${scope} 规则版本 ${version} 已经处于激活状态，无需重复激活。`);
  }

  const candidateRules = JSON.parse(readFileSync(candidateRulePath, "utf8"));
  validateCandidateRuleSet(scope, version, candidateRules, candidateRulePath);

  const proposal = db
    .prepare(`SELECT * FROM rule_proposals WHERE id = ? LIMIT 1`)
    .get(proposalId);
  if (!proposal) {
    throw new Error(`找不到规则提案：${proposalId}`);
  }
  if (proposal.scope !== scope || proposal.candidate_version !== version) {
    throw new Error("提案范围或候选版本与激活参数不一致，拒绝激活。");
  }
  if (!["pending_confirmation", "activation_requested"].includes(proposal.status)) {
    throw new Error(`提案状态不是可激活状态：${proposal.status}`);
  }
  if (!["suggest_activation", "promote"].includes(proposal.recommendation)) {
    throw new Error(`提案推荐动作不是建议激活：${proposal.recommendation}`);
  }

  const nowIso = new Date().toISOString();
  const next = {
    activeVersion: version,
    candidateVersion: null,
    previousVersion: current.activeVersion,
    activatedAt: nowIso,
    activatedBy: actor,
    proposalId
  };

  writeFileSync(activePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  db
    .prepare(`
      INSERT INTO rule_versions (scope, active_version, candidate_version, updated_at)
      VALUES (?, ?, NULL, ?)
      ON CONFLICT(scope) DO UPDATE SET
        active_version = excluded.active_version,
        candidate_version = NULL,
        updated_at = excluded.updated_at
    `)
    .run(scope, version, Date.now());

  db
    .prepare(`
      UPDATE rule_proposals
      SET status = 'activated',
          decided_at = ?,
          decided_by = ?,
          decision_reason = ?
      WHERE id = ?
    `)
    .run(nowIso, actor, reason, proposalId);

  writeAudit("rule-governance", "rule_version.activated", {
    scope,
    previousVersion: current.activeVersion,
    activeVersion: version,
    proposalId,
    actor,
    confirmation: flags.confirm,
    reason
  });

  console.log(JSON.stringify({
    activated: true,
    scope,
    previousVersion: current.activeVersion,
    activeVersion: version,
    proposalId,
    audit: "rule_version.activated"
  }, null, 2));
}

function updateProposalDecision(commandArgs, decision) {
  const proposalId = commandArgs.shift();
  const flags = parseFlags(commandArgs);
  const actor = flags.actor ?? "human-operator";
  const reason = flags.reason;

  if (!proposalId) {
    printUsageAndExit("拒绝或归档提案必须显式提供 proposal-id。");
  }
  if (flags.confirm !== decision.confirmation) {
    printUsageAndExit(`该操作必须提供 --confirm ${decision.confirmation}。`);
  }
  if (!reason) {
    printUsageAndExit("拒绝或归档提案必须提供 --reason。");
  }

  const proposal = db
    .prepare(`SELECT id, status FROM rule_proposals WHERE id = ? LIMIT 1`)
    .get(proposalId);
  if (!proposal) {
    throw new Error(`找不到规则提案：${proposalId}`);
  }
  if (proposal.status === "activated" && decision.status === "archived") {
    throw new Error("已激活提案不能直接归档；请先通过新的人工确认流程回滚或替代。");
  }

  const nowIso = new Date().toISOString();
  db
    .prepare(`
      UPDATE rule_proposals
      SET status = ?,
          decided_at = ?,
          decided_by = ?,
          decision_reason = ?
      WHERE id = ?
    `)
    .run(decision.status, nowIso, actor, reason, proposalId);

  writeAudit("rule-governance", decision.action, {
    proposalId,
    previousStatus: proposal.status,
    status: decision.status,
    actor,
    confirmation: flags.confirm,
    reason
  });

  console.log(JSON.stringify({
    proposalId,
    status: decision.status,
    audit: decision.action
  }, null, 2));
}

function validateCandidateRuleSet(scope, version, ruleSet, rulePath) {
  if (ruleSet.scope !== scope) {
    throw new Error(`候选规则范围不匹配：${rulePath}`);
  }
  if (ruleSet.version !== version) {
    throw new Error(`候选规则版本不匹配：${rulePath}`);
  }
  if (Array.isArray(ruleSet.allowedOptionStrategies) && ruleSet.allowedOptionStrategies.length > 0) {
    throw new Error("候选规则包含期权策略，违反 v1 禁用期权自动化约束。");
  }
  if (!Array.isArray(ruleSet.notes)) {
    throw new Error("候选规则 notes 必须是数组，便于审计人工边界。");
  }
}

function parseFlags(flagArgs) {
  const flags = {};
  for (let index = 0; index < flagArgs.length; index += 1) {
    const arg = flagArgs[index];
    if (!arg.startsWith("--")) {
      printUsageAndExit(`未知参数：${arg}`);
    }

    const inline = arg.match(/^--([^=]+)=(.*)$/u);
    if (inline) {
      flags[inline[1]] = inline[2];
      continue;
    }

    const key = arg.slice(2);
    const value = flagArgs[index + 1];
    if (!value || value.startsWith("--")) {
      printUsageAndExit(`参数 ${arg} 缺少值。`);
    }
    flags[key] = value;
    index += 1;
  }
  return flags;
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

    CREATE TABLE IF NOT EXISTS rule_versions (
      scope TEXT PRIMARY KEY,
      active_version TEXT NOT NULL,
      candidate_version TEXT,
      updated_at INTEGER NOT NULL
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
    "  node apps/openclaw-config/scripts/activate-rule-version.mjs activate <live|paper> <version> --proposal-id <id> --confirm HUMAN_APPROVED [--actor name] [--reason text]",
    "  # 飞书群内审核建议优先走 review-rule-proposal.mjs；建议激活只进入一审状态，确认激活必须包含 HUMAN_APPROVED。",
    "  node apps/openclaw-config/scripts/activate-rule-version.mjs reject <proposal-id> --confirm HUMAN_REJECTED --reason text [--actor name]",
    "  node apps/openclaw-config/scripts/activate-rule-version.mjs archive <proposal-id> --confirm HUMAN_ARCHIVED --reason text [--actor name]"
  ].join("\n"));
  process.exit(1);
}
