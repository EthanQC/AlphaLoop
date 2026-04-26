#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { repoRoot } from "./repo-root.mjs";

const dbPath = join(repoRoot, "runtime", "trading.sqlite");
const notesRoot = join(repoRoot, "knowledge", "notes", "private-repo");
const reportDir = join(repoRoot, "reports", "daily");
mkdirSync(reportDir, { recursive: true });

const db = new DatabaseSync(dbPath);
const dateLabel = formatDateLabel(new Date(), process.env.TRADING_TIMEZONE ?? "Asia/Shanghai");
const snapshotId = `preference_bootstrap_${dateLabel}`;
const createdAt = new Date().toISOString();

const notesText = readNotes(notesRoot);
const approvals = db
  .prepare(`SELECT summary, diff, created_at FROM approval_edits ORDER BY created_at DESC LIMIT 100`)
  .all();
const latest = db
  .prepare(`SELECT * FROM preference_snapshots ORDER BY created_at DESC LIMIT 1`)
  .get();

const traits = deriveTraits(notesText, approvals);
const summary = traits.length > 0
  ? `Preference baseline suggests: ${traits.join("; ")}.`
  : "Preference baseline is not populated yet; keep collecting notes and approval edits.";

const latestSummary = latest ? String(latest.summary) : "";
const latestTraits = latest ? JSON.stringify(JSON.parse(String(latest.traits))) : "";
const nextTraits = JSON.stringify(traits);
const latestSource = latest ? String(latest.source ?? "") : "";
const latestDateLabel = latest ? formatDateLabel(new Date(String(latest.created_at)), process.env.TRADING_TIMEZONE ?? "Asia/Shanghai") : "";

if (latestSource.startsWith("approval:") && latestDateLabel === dateLabel) {
  console.log(JSON.stringify({ saved: false, reason: "approval-snapshot-newer", summary: latestSummary }, null, 2));
  process.exit(0);
}

if (summary === latestSummary && nextTraits === latestTraits) {
  console.log(JSON.stringify({ saved: false, reason: "unchanged", summary }, null, 2));
  process.exit(0);
}

db.prepare(`
  INSERT OR REPLACE INTO preference_snapshots
  (id, created_at, source, summary, traits)
  VALUES (?, ?, ?, ?, ?)
`).run(snapshotId, createdAt, "bootstrap-notes", summary, nextTraits);

db.prepare(`
  INSERT OR REPLACE INTO execution_reports
  (id, category, title, body, metadata, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(
  `report_${snapshotId}`,
  "daily",
  "Preference bootstrap snapshot",
  summary,
  JSON.stringify({
    traits,
    approvalsConsidered: approvals.length,
    notesPresent: notesText.length > 0
  }),
  createdAt
);

console.log(JSON.stringify({ saved: true, id: snapshotId, summary, traits }, null, 2));

function readNotes(root) {
  if (!existsSync(root)) {
    return "";
  }

  return collectMarkdownFiles(root)
    .sort((left, right) => left.localeCompare(right))
    .map((filePath) => readFileSync(filePath, "utf8"))
    .join("\n\n");
}

function collectMarkdownFiles(root) {
  const entries = readdirSync(root, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (entry.name === ".git") {
      continue;
    }

    if (entry.isDirectory()) {
      results.push(...collectMarkdownFiles(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(entryPath);
    }
  }

  return results;
}

function deriveTraits(notesText, approvals) {
  const source = `${notesText}\n${approvals.map((entry) => `${entry.summary ?? ""} ${entry.diff ?? ""}`).join("\n")}`.toLowerCase();
  const traits = new Set();

  if (containsAny(source, ["30% 现金", "留 30% 现金", "30% cash"])) {
    traits.add("keeps a meaningful cash reserve near 30%");
  }
  if (containsAny(source, ["不超过五个板块", "每个板块不超过两支个股", "不超过两支个股"])) {
    traits.add("limits simultaneous sector and name concentration");
  }
  if (containsAny(source, ["大盘 —— 板块 —— 个股", "大盘走势", "macro", "板块", "个股"])) {
    traits.add("uses a top-down macro to sector to stock workflow");
  }
  if (containsAny(source, ["确定性", "基本面", "护城河", "估值", "target"])) {
    traits.add("prefers high-certainty setups grounded in fundamentals and valuation");
  }
  if (containsAny(source, ["目标价", "分析师", "共识目标价"])) {
    traits.add("uses target-price ranges and analyst consensus for exits");
  }
  if (containsAny(source, ["战争", "政策", "央行", "关税", "经济指标", "发言"])) {
    traits.add("tracks macro, policy, and geopolitical catalysts daily");
  }
  if (containsAny(source, ["减仓", "size down", "reduce size", "仓位"])) {
    traits.add("tunes size actively instead of treating ideas as all-or-nothing");
  }
  if (containsAny(source, ["确认", "等待", "confirm", "wait"])) {
    traits.add("prefers confirmation when event quality is ambiguous");
  }

  return Array.from(traits).slice(0, 8);
}

function containsAny(source, patterns) {
  return patterns.some((pattern) => source.includes(pattern.toLowerCase()));
}

function formatDateLabel(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}
