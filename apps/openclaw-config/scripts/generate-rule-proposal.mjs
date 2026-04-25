#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const repoRoot = process.cwd();
const runtimeDir = join(repoRoot, "runtime");
const dbPath = join(runtimeDir, "trading.sqlite");
const proposalDir = join(repoRoot, "reports", "proposals");
const archiveDir = join(proposalDir, "archive");
const timeZone = process.env.TRADING_TIMEZONE ?? "Asia/Shanghai";
const scopeLabels = {
  live: "实盘建议",
  paper: "模拟盘"
};

const args = parseArgs(process.argv.slice(2));
const now = new Date();
const nowIso = now.toISOString();
const dateLabel = formatDateLabel(now, timeZone);
const timestampLabel = formatTimestampLabel(now, timeZone);
const windowStart = new Date(now.getTime() - args.windowDays * 24 * 60 * 60 * 1000);
const windowStartIso = windowStart.toISOString();

mkdirSync(runtimeDir, { recursive: true });
mkdirSync(proposalDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000;");
db.exec("PRAGMA foreign_keys = ON;");
ensureGovernanceSchema(db);

const archivedFileCount = archiveLegacyProposalFiles();
const archivedRowCount = archiveLegacyProposalRows(db, nowIso);
if (archivedFileCount > 0 || archivedRowCount > 0) {
  writeAudit(db, "rule-governance", "proposal.legacy_archived", {
    archivedFileCount,
    archivedRowCount,
    reason: "旧英文/模板化规则提案已归档，避免继续污染中文报告。"
  });
}

for (const scope of args.scopes) {
  const ruleFiles = loadActiveRuleSet(scope);
  const evidence = loadEvidence(db, windowStartIso);
  const proposal = buildProposal({
    scope,
    activeVersionFile: ruleFiles.activeVersionFile,
    activeRules: ruleFiles.activeRules,
    evidence
  });

  const duplicate = args.force ? null : findDuplicatePendingProposal(db, proposal);
  if (duplicate) {
    console.log(`已存在待确认提案，跳过重复生成：${duplicate.proposal_path ?? duplicate.id}`);
    continue;
  }

  const outputPath = uniqueProposalPath(scope);
  proposal.proposalPath = outputPath;
  saveProposal(db, proposal);
  writeAudit(db, "rule-governance", "proposal.generated", {
    proposalId: proposal.id,
    scope: proposal.scope,
    currentVersion: proposal.currentVersion,
    candidateVersion: proposal.candidateVersion,
    recommendation: proposal.recommendation,
    status: proposal.status,
    proposalPath: proposal.proposalPath,
    mode: args.mode
  });

  writeFileSync(outputPath, `${renderProposalMarkdown(proposal)}\n`, "utf8");
  console.log(outputPath);
}

function parseArgs(rawArgs) {
  const scopes = [];
  let mode = "manual";
  let force = false;
  let windowDays = 7;

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "live" || arg === "paper") {
      scopes.push(arg);
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--mode") {
      mode = rawArgs[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--window-days") {
      windowDays = Number(rawArgs[index + 1]);
      index += 1;
      continue;
    }
    printUsageAndExit(`未知参数：${arg}`);
  }

  if (!["manual", "weekly"].includes(mode)) {
    printUsageAndExit("生成模式必须是 manual 或 weekly。");
  }
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 30) {
    printUsageAndExit("证据窗口天数必须是 1 到 30 之间的整数。");
  }

  return {
    scopes: scopes.length > 0 ? [...new Set(scopes)] : ["live", "paper"],
    mode,
    force,
    windowDays
  };
}

function printUsageAndExit(message) {
  console.error(message);
  console.error("用法：node apps/openclaw-config/scripts/generate-rule-proposal.mjs [live|paper] [--mode manual|weekly] [--window-days 7] [--force]");
  process.exit(1);
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

function archiveLegacyProposalFiles() {
  mkdirSync(archiveDir, { recursive: true });
  let archived = 0;

  for (const entry of readdirSync(proposalDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}-(live|paper)\.md$/u.test(entry.name)) {
      continue;
    }

    const sourcePath = join(proposalDir, entry.name);
    const text = readFileSync(sourcePath, "utf8");
    if (!text.startsWith("# Rule Proposal ")) {
      continue;
    }

    renameSync(sourcePath, uniqueArchivePath(entry.name));
    archived += 1;
  }

  return archived;
}

function uniqueArchivePath(fileName) {
  let targetPath = join(archiveDir, fileName);
  if (!existsSync(targetPath)) {
    return targetPath;
  }

  const stem = fileName.replace(/\.md$/u, "");
  let index = 2;
  while (existsSync(targetPath)) {
    targetPath = join(archiveDir, `${stem}-${index}.md`);
    index += 1;
  }
  return targetPath;
}

function archiveLegacyProposalRows(database, decidedAt) {
  const rows = database
    .prepare(`
      SELECT id
      FROM rule_proposals
      WHERE COALESCE(status, 'pending_confirmation') != 'archived'
        AND (
          COALESCE(title, '') = ''
          OR summary LIKE 'live rules have enough local evidence%'
          OR summary LIKE 'paper rules remain on hold%'
          OR old_vs_new LIKE '%No rule delta recommended yet%'
          OR old_vs_new LIKE '%Tighten live entry discipline%'
        )
    `)
    .all();

  if (rows.length === 0) {
    return 0;
  }

  const update = database.prepare(`
    UPDATE rule_proposals
    SET status = 'archived',
        decided_at = ?,
        decided_by = 'generate-rule-proposal.mjs',
        decision_reason = '旧英文/模板化提案已归档；后续只使用中文、可审计、待确认提案。'
    WHERE id = ?
  `);
  for (const row of rows) {
    update.run(decidedAt, row.id);
  }
  return rows.length;
}

function loadActiveRuleSet(scope) {
  const activeVersionPath = join(repoRoot, "rules", scope, "active-version.json");
  const activeVersionFile = JSON.parse(readFileSync(activeVersionPath, "utf8"));
  const activeVersion = activeVersionFile.activeVersion;
  const rulePath = join(repoRoot, "rules", scope, activeVersion, "rule-set.json");
  const activeRules = JSON.parse(readFileSync(rulePath, "utf8"));

  if (activeRules.scope !== scope) {
    throw new Error(`规则文件范围不匹配：${rulePath}`);
  }
  if (activeRules.version !== activeVersion) {
    throw new Error(`active-version 与 rule-set 版本不一致：${scope}`);
  }

  return {
    activeVersionFile,
    activeRules,
    rulePath
  };
}

function loadEvidence(database, startIso) {
  const approvalRows = database
    .prepare(`
      SELECT summary, diff, created_at
      FROM approval_edits
      WHERE created_at >= ?
      ORDER BY created_at DESC
      LIMIT 200
    `)
    .all(startIso);

  const executionRows = database
    .prepare(`
      SELECT title, body, metadata, category, created_at
      FROM execution_reports
      WHERE category IN ('trade', 'daily')
        AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT 300
    `)
    .all(startIso);

  const latestPreference = database
    .prepare(`SELECT summary, traits, created_at FROM preference_snapshots ORDER BY created_at DESC LIMIT 1`)
    .get();

  return {
    approvalRows,
    executionRows,
    latestPreference,
    sizeDownSignals: countMatching(approvalRows, ["减仓", "降低仓位", "缩小仓位", "size down", "reduce size", "smaller"]),
    confirmationSignals: countMatching(approvalRows, ["等待确认", "确认", "突破确认", "wait", "confirm", "breakout"]),
    rejectedExecutionRows: countMatching(executionRows, ["rejected", "拒绝", "not allowed", "disabled", "未执行", "不允许", "failed"]),
    optionMentions: countMatching(executionRows, ["option", "期权", "covered_call", "cash_secured_put", "long_call", "long_put"])
  };
}

function countMatching(rows, patterns) {
  return rows.filter((row) => {
    const source = `${row.summary ?? ""} ${row.diff ?? ""} ${row.title ?? ""} ${row.body ?? ""}`.toLowerCase();
    return patterns.some((pattern) => source.includes(pattern.toLowerCase()));
  }).length;
}

function buildProposal(input) {
  const candidateRules = JSON.parse(JSON.stringify(input.activeRules));
  const currentVersion = input.activeRules.version;
  const currentScopeLabel = scopeLabels[input.scope];
  const baseEvidence = [
    `证据窗口：${formatDateLabel(windowStart, timeZone)} 至 ${dateLabel}，生成模式为 ${args.mode}，不会由单笔 paper-trader 事件触发。`,
    `SQLite.execution_reports：窗口内 ${input.evidence.executionRows.length} 条；其中被拦截、失败或未执行记录 ${input.evidence.rejectedExecutionRows} 条。`,
    `SQLite.approval_edits：窗口内 ${input.evidence.approvalRows.length} 条；减仓倾向 ${input.evidence.sizeDownSignals} 条，等待确认倾向 ${input.evidence.confirmationSignals} 条。`,
    input.evidence.latestPreference
      ? `SQLite.preference_snapshots：存在最新偏好快照，更新时间 ${input.evidence.latestPreference.created_at}；提案只引用偏好方向，不直接展开旧英文原文。`
      : "SQLite.preference_snapshots：暂无偏好快照，提案只使用执行和审批证据。",
    `规则文件：rules/${input.scope}/${currentVersion}/rule-set.json。`,
    input.evidence.optionMentions > 0
      ? `期权相关记录 ${input.evidence.optionMentions} 条仅作为禁用边界证据；本提案不恢复任何期权策略。`
      : "期权自动化保持禁用；本提案不新增任何期权策略。"
  ];

  const commonRisks = [
    "证据来自本地 SQLite 的近期窗口，可能受样本数量和事件分布影响。",
    "如果人工把待确认提案误认为已生效规则，可能造成执行预期偏差；因此状态必须保持待确认直到明确激活。",
    "本提案不能绕过实盘禁令；实盘仍只允许建议卡和人工复核，不允许自动提交真实资金订单。",
    "期权策略保持空列表；不得借规则提案恢复期权自动化。"
  ];

  let candidateVersion = currentVersion;
  let title = `${currentScopeLabel}规则观察提案 ${dateLabel}`;
  let recommendation = "continue_observe";
  let actionLabel = "继续观察";
  let triggerReason = "本窗口证据尚不足以支持修改规则，先保留现有风控边界并继续积累样本。";
  let summary = `${currentScopeLabel}规则本轮保持不变；这是一份待人工确认的策略学习记录，不会自动生效。`;
  let expectedBenefit = "保持规则稳定，避免用弱信号放大策略漂移。";
  const comparisons = [
    comparison("单一想法最大暴露", `${input.activeRules.maxIdeaExposurePercent}%`, `${candidateRules.maxIdeaExposurePercent}%`, "当前窗口没有足够证据要求调整仓位上限。"),
    comparison("高置信度最大暴露", `${input.activeRules.maxHighConvictionExposurePercent}%`, `${candidateRules.maxHighConvictionExposurePercent}%`, "继续沿用现有高置信度仓位护栏。"),
    comparison("期权策略", renderOptionStrategies(input.activeRules.allowedOptionStrategies), renderOptionStrategies(candidateRules.allowedOptionStrategies), "期权自动化保持禁用，规则提案不得恢复期权。")
  ];

  if (input.evidence.sizeDownSignals >= 2) {
    const nextExposure = Math.max(6, input.activeRules.maxIdeaExposurePercent - 2);
    candidateRules.maxIdeaExposurePercent = nextExposure;
    candidateVersion = bumpPatchVersion(currentVersion);
    title = `${currentScopeLabel}仓位上限收紧提案 ${dateLabel}`;
    recommendation = "suggest_activation";
    actionLabel = "建议激活";
    triggerReason = `审批记录中出现 ${input.evidence.sizeDownSignals} 次减仓/缩小仓位倾向，说明当前单一想法上限可能偏松。`;
    summary = `建议将${currentScopeLabel}单一想法最大暴露从 ${input.activeRules.maxIdeaExposurePercent}% 下调到 ${nextExposure}%，但必须人工确认后才可激活。`;
    expectedBenefit = "让规则更贴近人工审批中的实际仓位偏好，降低单一想法对组合波动的影响。";
    comparisons.splice(0, 1, comparison("单一想法最大暴露", `${input.activeRules.maxIdeaExposurePercent}%`, `${nextExposure}%`, "审批中反复出现减仓倾向，候选规则将单笔风险预算前移收紧。"));
  } else if (input.scope === "live" && input.evidence.confirmationSignals >= 2) {
    const confirmationNote = "高置信度实盘建议必须写明触发条件、失效条件和二次确认要求；证据不足时降为继续观察。";
    candidateRules.notes = [...new Set([...candidateRules.notes, confirmationNote])];
    candidateVersion = bumpPatchVersion(currentVersion);
    title = `实盘确认门槛收紧提案 ${dateLabel}`;
    recommendation = "suggest_activation";
    actionLabel = "建议激活";
    triggerReason = `审批记录中出现 ${input.evidence.confirmationSignals} 次等待确认/确认信号，说明高置信度建议需要更明确的触发条件。`;
    summary = "建议收紧实盘高置信度建议的确认门槛；该变化只影响建议卡表达，不允许自动实盘下单。";
    expectedBenefit = "减少模糊事件被包装成高置信度建议的概率，让人工复核能更快看到触发条件和失效条件。";
    comparisons.push(comparison("高置信度实盘建议门槛", "沿用通用入场纪律", "必须明确触发条件、失效条件和二次确认要求", "近期审批偏好反复强调确认后再行动。"));
  }

  return {
    id: uniqueProposalId(input.scope),
    createdAt: nowIso,
    scope: input.scope,
    currentVersion,
    candidateVersion,
    title,
    summary,
    triggerReason,
    oldVsNew: comparisons,
    evidence: baseEvidence,
    expectedBenefit,
    risks: recommendation === "suggest_activation"
      ? [...commonRisks, "规则收紧可能降低交易频率，也可能错过部分早期机会。", "候选规则版本必须先以文件或 PR 形式落地；没有规则文件时激活脚本会拒绝执行。"]
      : commonRisks,
    rollbackPlan: `如果人工激活后发现副作用过大，将 rules/${input.scope}/active-version.json 切回 previousVersion 或 ${currentVersion}，并在 audit_log 记录回滚原因；归档本提案时保留 Markdown 和 SQLite 记录。`,
    recommendation,
    actionLabel,
    status: "pending_confirmation",
    manualStatusText: "待人工确认；未确认不生效。",
    activeRules: input.activeRules,
    candidateRules,
    sourceWindowStart: windowStartIso,
    sourceWindowEnd: nowIso
  };
}

function comparison(field, oldValue, newValue, reason) {
  return { field, oldValue, newValue, reason };
}

function findDuplicatePendingProposal(database, proposal) {
  return database
    .prepare(`
      SELECT id, proposal_path
      FROM rule_proposals
      WHERE scope = ?
        AND current_version = ?
        AND candidate_version = ?
        AND recommendation = ?
        AND COALESCE(status, 'pending_confirmation') = 'pending_confirmation'
        AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT 1
    `)
    .get(
      proposal.scope,
      proposal.currentVersion,
      proposal.candidateVersion,
      proposal.recommendation,
      new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
    );
}

function saveProposal(database, proposal) {
  database
    .prepare(`
      INSERT INTO rule_proposals
      (id, created_at, scope, current_version, candidate_version, title, summary, trigger_reason,
       old_vs_new, evidence, expected_benefit, risks, rollback_plan, recommendation, status, proposal_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      proposal.id,
      proposal.createdAt,
      proposal.scope,
      proposal.currentVersion,
      proposal.candidateVersion,
      proposal.title,
      proposal.summary,
      proposal.triggerReason,
      JSON.stringify(proposal.oldVsNew),
      JSON.stringify(proposal.evidence),
      proposal.expectedBenefit,
      JSON.stringify(proposal.risks),
      proposal.rollbackPlan,
      proposal.recommendation,
      proposal.status,
      proposal.proposalPath
    );
}

function renderProposalMarkdown(proposal) {
  const lines = [
    `# ${proposal.title}`,
    "",
    `- 提案编号：${proposal.id}`,
    `- 提案日期：${dateLabel}`,
    `- 适用范围：${proposal.scope}（${scopeLabels[proposal.scope]}）`,
    `- 当前规则版本：${proposal.currentVersion}`,
    `- 候选规则版本：${proposal.candidateVersion}`,
    `- 生命周期状态：${proposal.manualStatusText}`,
    `- 推荐动作：${proposal.actionLabel}`,
    "",
    "## 触发原因",
    "",
    proposal.triggerReason,
    "",
    "## 证据来源",
    ""
  ];

  for (const item of proposal.evidence) {
    lines.push(`- ${item}`);
  }

  lines.push(
    "",
    "## 旧规则",
    "",
    renderRuleSummary(proposal.scope, proposal.activeRules),
    "",
    "## 新规则（候选）",
    "",
    renderRuleSummary(proposal.scope, proposal.candidateRules),
    "",
    "## 旧新对比表",
    "",
    "| 规则项 | 旧规则 | 新规则 | 原因 |",
    "| --- | --- | --- | --- |"
  );

  for (const row of proposal.oldVsNew) {
    lines.push(`| ${escapeTable(row.field)} | ${escapeTable(row.oldValue)} | ${escapeTable(row.newValue)} | ${escapeTable(row.reason)} |`);
  }

  lines.push(
    "",
    "## 预期收益",
    "",
    proposal.expectedBenefit,
    "",
    "## 风险与副作用",
    ""
  );

  for (const risk of proposal.risks) {
    lines.push(`- ${risk}`);
  }

  lines.push(
    "",
    "## 回滚方式",
    "",
    proposal.rollbackPlan,
    "",
    "## 人工确认状态",
    "",
    "- 当前状态：待确认。",
    "- 未确认前不修改 active-version，不改变实盘或模拟盘行为。",
    "- 如需激活，必须由人工运行带确认参数的激活脚本，并写入 audit_log。",
    "- 如需拒绝或归档，也必须由人工给出确认参数和原因。",
    "",
    "## 安全边界",
    "",
    "- 不自动提交真实资金订单。",
    "- 不恢复任何期权策略。",
    "- 不允许通过规则提案绕过实盘禁令。",
    "- 高风险实盘建议仍需要第二次人工确认。"
  );

  return lines.join("\n");
}

function renderRuleSummary(scope, ruleSet) {
  const boundary = scope === "live"
    ? "只生成建议卡；真实资金订单必须人工复核，系统不得自动提交。"
    : "仅限模拟盘或本地纸面执行；不代表真实资金下单。";

  return [
    `- 单一想法最大暴露：${ruleSet.maxIdeaExposurePercent}%`,
    `- 高置信度最大暴露：${ruleSet.maxHighConvictionExposurePercent}%`,
    `- 最大并行想法数：${ruleSet.maxConcurrentIdeas}`,
    `- 高置信度并行上限：${ruleSet.maxHighConvictionIdeas}`,
    `- 每日新增风险上限：${ruleSet.maxDailyNewRiskPercent}%`,
    `- 期权策略：${renderOptionStrategies(ruleSet.allowedOptionStrategies)}`,
    `- 执行边界：${boundary}`,
    `- 规则说明：${renderRuleNotes(scope, ruleSet.notes)}`
  ].join("\n");
}

function renderRuleNotes(scope, notes) {
  const normalized = [];
  if (scope === "live") {
    normalized.push("实盘通道是建议通道，不允许自动提交真实资金订单。");
    normalized.push("高风险或高置信度建议必须保留人工二次确认。");
  } else {
    normalized.push("模拟盘可以在本地风控通过后执行，但不能升级为实盘自动执行。");
  }
  if (notes.some((note) => String(note).includes("触发条件") || String(note).includes("二次确认"))) {
    normalized.push("高置信度建议必须写明触发条件、失效条件和二次确认要求。");
  }
  normalized.push("期权自动化保持禁用。");
  return [...new Set(normalized)].join(" ");
}

function renderOptionStrategies(value) {
  return Array.isArray(value) && value.length > 0 ? value.join(", ") : "禁用（空列表）";
}

function escapeTable(value) {
  return String(value).replace(/\|/gu, "\\|").replace(/\n/gu, "<br>");
}

function uniqueProposalId(scope) {
  return `proposal_${scope}_${timestampLabel}_${randomUUID().slice(0, 8)}`;
}

function uniqueProposalPath(scope) {
  const baseName = `${dateLabel}-${scope}-${timestampLabel}.md`;
  let targetPath = join(proposalDir, baseName);
  if (!existsSync(targetPath)) {
    return targetPath;
  }

  const stem = baseName.replace(/\.md$/u, "");
  let index = 2;
  while (existsSync(targetPath)) {
    targetPath = join(proposalDir, `${stem}-${index}.md`);
    index += 1;
  }
  return targetPath;
}

function writeAudit(database, category, action, payload) {
  database
    .prepare(`
      INSERT INTO audit_log (id, category, action, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(`audit_${randomUUID()}`, category, action, JSON.stringify(payload), Date.now());
}

function formatDateLabel(date, targetTimeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: targetTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function formatTimestampLabel(date, targetTimeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: targetTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}${get("month")}${get("day")}T${get("hour")}${get("minute")}${get("second")}`;
}

function bumpPatchVersion(version) {
  const match = version.match(/^v(\d+)\.(\d+)\.(\d+)$/u);
  if (!match) {
    return `${version}-candidate`;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]) + 1;
  return `v${major}.${minor}.${patch}`;
}
