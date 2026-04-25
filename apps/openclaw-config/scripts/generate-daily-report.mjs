#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { openTradingDatabase } from "../../../packages/shared-types/dist/index.js";

const repoRoot = process.cwd();
const dbPath = join(repoRoot, "runtime", "trading.sqlite");
const reportDir = join(repoRoot, "reports", "daily");
mkdirSync(reportDir, { recursive: true });
const tradingTimezone = process.env.TRADING_TIMEZONE ?? "Asia/Shanghai";

const targetDate = process.argv[2] ?? formatDateLabel(new Date(), tradingTimezone);
const db = openTradingDatabase(dbPath);

const tradeRows = db
  .prepare(`
    SELECT id, title, body, created_at
    FROM execution_reports
    WHERE category = 'trade'
    ORDER BY created_at ASC
  `)
  .all()
  .filter((row) => formatDateLabel(new Date(String(row.created_at)), tradingTimezone) === targetDate);

const dailyRows = db
  .prepare(`
    SELECT id, title, body, created_at
    FROM execution_reports
    WHERE category = 'daily'
    ORDER BY created_at ASC
  `)
  .all()
  .filter((row) => formatDateLabel(new Date(String(row.created_at)), tradingTimezone) === targetDate);

const approvalRows = db
  .prepare(`
    SELECT advice_card_id, editor, summary, created_at
    FROM approval_edits
    ORDER BY created_at ASC
  `)
  .all()
  .filter((row) => formatDateLabel(new Date(String(row.created_at)), tradingTimezone) === targetDate);

const paperPositions = db
  .prepare(`SELECT symbol, asset_class, quantity, avg_price, realized_pnl FROM paper_positions WHERE status = 'open' ORDER BY created_at ASC`)
  .all();

const shadowPositions = db
  .prepare(`SELECT symbol, strategy, quantity, avg_price, realized_pnl FROM shadow_positions WHERE status = 'open' ORDER BY created_at ASC`)
  .all();

const proposalRows = db
  .prepare(`
    SELECT scope, summary, recommendation, created_at
    FROM rule_proposals
    ORDER BY created_at ASC
  `)
  .all()
  .filter((row) => formatDateLabel(new Date(String(row.created_at)), tradingTimezone) === targetDate);

const latestPreference = db
  .prepare(`SELECT summary, traits, created_at FROM preference_snapshots ORDER BY created_at DESC LIMIT 1`)
  .get();

const lines = [
  `# Daily Report ${targetDate}`,
  "",
  "## Summary",
  "",
  `- Trade reports: ${tradeRows.length}`,
  `- Advice and preference reports: ${dailyRows.length}`,
  `- Approval edits: ${approvalRows.length}`,
  `- Open paper positions: ${paperPositions.length}`,
  `- Open shadow positions: ${shadowPositions.length}`,
  `- Rule proposals: ${proposalRows.length}`,
  ""
];

if (latestPreference) {
  lines.push("## Latest Preference Snapshot", "");
  lines.push(`Updated: ${latestPreference.created_at}`);
  lines.push(String(latestPreference.summary));
  lines.push("");
}

if (paperPositions.length > 0) {
  lines.push("## Open Paper Positions", "");
  for (const row of paperPositions) {
    lines.push(`- ${row.symbol}: ${row.quantity} ${row.asset_class} @ ${Number(row.avg_price).toFixed(2)} | Realized PnL ${Number(row.realized_pnl).toFixed(2)}`);
  }
  lines.push("");
}

if (shadowPositions.length > 0) {
  lines.push("## Open Shadow Positions", "");
  for (const row of shadowPositions) {
    lines.push(`- ${row.symbol}: ${row.quantity} ${row.strategy} @ ${Number(row.avg_price).toFixed(2)} | Realized PnL ${Number(row.realized_pnl).toFixed(2)}`);
  }
  lines.push("");
}

if (approvalRows.length > 0) {
  lines.push("## Approval Edits", "");
  for (const row of approvalRows) {
    lines.push(`### ${row.editor} -> ${row.advice_card_id}`);
    lines.push(`Created: ${row.created_at}`);
    lines.push("");
    lines.push(String(row.summary));
    lines.push("");
  }
}

if (proposalRows.length > 0) {
  lines.push("## Rule Proposals", "");
  for (const row of proposalRows) {
    lines.push(`### ${row.scope} (${row.recommendation})`);
    lines.push(`Created: ${row.created_at}`);
    lines.push("");
    lines.push(String(row.summary));
    lines.push("");
  }
}

lines.push("## Trade Reports", "");
for (const row of tradeRows) {
  lines.push(`## ${row.title}`);
  lines.push(`Created: ${row.created_at}`);
  lines.push("");
  lines.push(String(row.body));
  lines.push("");
}

if (dailyRows.length > 0) {
  lines.push("## Advice And Preference Reports", "");
  for (const row of dailyRows) {
    lines.push(`### ${row.title}`);
    lines.push(`Created: ${row.created_at}`);
    lines.push("");
    lines.push(String(row.body));
    lines.push("");
  }
}

const outputPath = join(reportDir, `${targetDate}.md`);
writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
console.log(outputPath);

function formatDateLabel(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}
