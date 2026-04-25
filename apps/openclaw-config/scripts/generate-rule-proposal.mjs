#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const repoRoot = process.cwd();
const dbPath = join(repoRoot, "runtime", "trading.sqlite");
const proposalDir = join(repoRoot, "reports", "proposals");
mkdirSync(proposalDir, { recursive: true });
const db = new DatabaseSync(dbPath);
const timeZone = process.env.TRADING_TIMEZONE ?? "Asia/Shanghai";
const dateLabel = formatDateLabel(new Date(), timeZone);
const scopes = process.argv.length > 2 ? process.argv.slice(2).filter((scope) => scope === "live" || scope === "paper") : ["live", "paper"];

for (const scope of scopes) {
  const activeVersion = JSON.parse(readFileSync(join(repoRoot, "rules", scope, "active-version.json"), "utf8"));
  const activeRules = JSON.parse(readFileSync(join(repoRoot, "rules", scope, activeVersion.activeVersion, "rule-set.json"), "utf8"));
  const approvals = db
    .prepare(`SELECT summary, diff, created_at FROM approval_edits ORDER BY created_at DESC LIMIT 100`)
    .all();
  const trades = db
    .prepare(`SELECT title, body, created_at FROM execution_reports WHERE category = 'trade' ORDER BY created_at DESC LIMIT 100`)
    .all();
  const latestPreference = db
    .prepare(`SELECT summary, traits, created_at FROM preference_snapshots ORDER BY created_at DESC LIMIT 1`)
    .get();

  const sizeDownSignals = countMatchingApprovals(approvals, ["减仓", "size down", "reduce size", "smaller"]);
  const confirmationSignals = countMatchingApprovals(approvals, ["确认", "wait", "confirm", "breakout"]);

  let recommendation = "hold";
  let candidateVersion = `${activeRules.version}-review-${dateLabel}`;
  const oldVsNew = ["No rule delta recommended yet; continue collecting execution and approval evidence."];
  const evidence = [
    `Recent trade reports reviewed: ${trades.length}.`,
    `Recent approval edits reviewed: ${approvals.length}.`,
    `Current rule version: ${activeRules.version}.`,
    latestPreference ? `Latest preference snapshot: ${String(latestPreference.summary)}` : "No stored preference snapshot yet."
  ];

  if (sizeDownSignals >= 2) {
    recommendation = "promote";
    candidateVersion = bumpPatchVersion(activeRules.version);
    oldVsNew.splice(0, oldVsNew.length, `Reduce maxIdeaExposurePercent from ${activeRules.maxIdeaExposurePercent} to ${Math.max(6, activeRules.maxIdeaExposurePercent - 2)} to reflect repeated sizing-down behavior.`);
    evidence.push(`Detected repeated size-down signals: ${sizeDownSignals}.`);
  } else if (confirmationSignals >= 2 && scope === "live") {
    recommendation = "promote";
    candidateVersion = bumpPatchVersion(activeRules.version);
    oldVsNew.splice(0, oldVsNew.length, "Tighten live entry discipline by requiring stronger confirmation language before surfacing high-conviction ideas.");
    evidence.push(`Detected repeated confirmation signals: ${confirmationSignals}.`);
  } else {
    evidence.push("Signals do not yet justify a rule change; keep the current version active.");
  }

  const summary =
    recommendation === "promote"
      ? `${scope} rules have enough local evidence for a candidate update.`
      : `${scope} rules remain on hold; local evidence still supports the current guardrails.`;

  const proposalId = `proposal_${scope}_${dateLabel}`;
  db.prepare(`
    INSERT OR REPLACE INTO rule_proposals
    (id, created_at, scope, current_version, candidate_version, summary, old_vs_new, evidence, recommendation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    proposalId,
    new Date().toISOString(),
    scope,
    activeRules.version,
    candidateVersion,
    summary,
    JSON.stringify(oldVsNew),
    JSON.stringify(evidence),
    recommendation
  );

  const lines = [
    `# Rule Proposal ${scope} ${dateLabel}`,
    "",
    `Recommendation: ${recommendation}`,
    `Current Version: ${activeRules.version}`,
    `Candidate Version: ${candidateVersion}`,
    "",
    "## Summary",
    "",
    summary,
    "",
    "## Old Vs New",
    ""
  ];

  for (const item of oldVsNew) {
    lines.push(`- ${item}`);
  }

  lines.push("", "## Evidence", "");
  for (const item of evidence) {
    lines.push(`- ${item}`);
  }

  const outputPath = join(proposalDir, `${dateLabel}-${scope}.md`);
  writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
  console.log(outputPath);
}

function formatDateLabel(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function countMatchingApprovals(approvals, patterns) {
  return approvals.filter((entry) => {
    const source = `${entry.summary ?? ""} ${entry.diff ?? ""}`.toLowerCase();
    return patterns.some((pattern) => source.includes(pattern.toLowerCase()));
  }).length;
}

function bumpPatchVersion(version) {
  const match = version.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return `${version}-candidate`;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]) + 1;
  return `v${major}.${minor}.${patch}`;
}
