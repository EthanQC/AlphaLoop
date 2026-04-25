#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { openTradingDatabase } from "../../../packages/shared-types/dist/index.js";

const repoRoot = process.cwd();
const dbPath = join(repoRoot, "runtime", "trading.sqlite");
const reportDir = join(repoRoot, "reports", "weekly");
mkdirSync(reportDir, { recursive: true });
const tradingTimezone = process.env.TRADING_TIMEZONE ?? "Asia/Shanghai";

const db = openTradingDatabase(dbPath);
const weekLabel = process.argv[2] ?? isoWeekLabel(new Date(), tradingTimezone);
const todayLabel = formatDateLabel(new Date(), tradingTimezone);

const rows = db
  .prepare(`
    SELECT title, body, created_at
    FROM execution_reports
    WHERE category IN ('trade', 'daily')
    ORDER BY created_at ASC
  `)
  .all()
  .filter((row) => {
    const label = formatDateLabel(new Date(String(row.created_at)), tradingTimezone);
    return label >= weekLabel && label <= todayLabel;
  });

const approvalRows = db
  .prepare(`
    SELECT advice_card_id, editor, summary, created_at
    FROM approval_edits
    ORDER BY created_at ASC
  `)
  .all()
  .filter((row) => {
    const label = formatDateLabel(new Date(String(row.created_at)), tradingTimezone);
    return label >= weekLabel && label <= todayLabel;
  });

const proposalRows = db
  .prepare(`
    SELECT scope, summary, recommendation, current_version, candidate_version, created_at
    FROM rule_proposals
    ORDER BY created_at ASC
  `)
  .all()
  .filter((row) => {
    const label = formatDateLabel(new Date(String(row.created_at)), tradingTimezone);
    return label >= weekLabel && label <= todayLabel;
  });

const latestPreference = db
  .prepare(`SELECT summary, traits, created_at FROM preference_snapshots ORDER BY created_at DESC LIMIT 1`)
  .get();

const liveRules = readFileSync(join(repoRoot, "rules", "live", "active-version.json"), "utf8").trim();
const paperRules = readFileSync(join(repoRoot, "rules", "paper", "active-version.json"), "utf8").trim();

const lines = [
  `# Weekly Evolution Report ${weekLabel}`,
  "",
  "## Active Versions",
  "",
  "### Live",
  "```json",
  liveRules,
  "```",
  "",
  "### Paper",
  "```json",
  paperRules,
  "```",
  "",
  "## Weekly Summary",
  "",
  `- Execution and advice reports: ${rows.length}`,
  `- Approval edits: ${approvalRows.length}`,
  `- Rule proposals: ${proposalRows.length}`,
  "",
  "## Latest Preference Snapshot",
  "",
  latestPreference ? `Updated: ${latestPreference.created_at}\n${String(latestPreference.summary)}` : "No preference snapshot stored yet.",
  "",
  "## Approval Digest",
  ""
];

if (approvalRows.length === 0) {
  lines.push("No approval edits were recorded this week.", "");
} else {
  for (const row of approvalRows) {
    lines.push(`### ${row.editor} -> ${row.advice_card_id}`);
    lines.push(`Created: ${row.created_at}`);
    lines.push("");
    lines.push(String(row.summary));
    lines.push("");
  }
}

lines.push("## Rule Proposals", "");
if (proposalRows.length === 0) {
  lines.push("No rule proposals were generated this week.", "");
} else {
  for (const row of proposalRows) {
    lines.push(`### ${row.scope} (${row.recommendation})`);
    lines.push(`Created: ${row.created_at}`);
    lines.push(`Current: ${row.current_version}`);
    lines.push(`Candidate: ${row.candidate_version}`);
    lines.push("");
    lines.push(String(row.summary));
    lines.push("");
  }
}

lines.push("## Execution Digest", "");

for (const row of rows) {
  lines.push(`### ${row.title}`);
  lines.push(`Created: ${row.created_at}`);
  lines.push("");
  lines.push(String(row.body));
  lines.push("");
}

const outputPath = join(reportDir, `${weekLabel}.md`);
writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
console.log(outputPath);

function getMondayDateLabel(date, timeZone) {
  const currentLabel = formatDateLabel(date, timeZone);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short"
  }).format(date);
  const dayIndex =
    {
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
      Sun: 7
    }[weekday] ?? 7;
  const [year, month, day] = currentLabel.split("-").map(Number);
  const monday = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  monday.setUTCDate(monday.getUTCDate() - dayIndex + 1);
  return monday.toISOString().slice(0, 10);
}

function isoWeekLabel(date, timeZone) {
  return getMondayDateLabel(date, timeZone);
}

function formatDateLabel(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}
