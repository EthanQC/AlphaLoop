#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const rawArgs = process.argv.slice(2);

if (rawArgs.length === 0) {
  console.error("Usage: create-source-request.mjs <request text>");
  process.exit(1);
}

const requestText = rawArgs.join(" ").trim();
const timeZone = process.env.TRADING_TIMEZONE ?? "Asia/Shanghai";
const now = new Date();
const dateLabel = new Intl.DateTimeFormat("en-CA", {
  timeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(now);
const timestamp = now.toISOString().replaceAll(":", "-");
const slug = slugify(requestText).slice(0, 48) || "source-request";
const requestDir = join(repoRoot, "knowledge", "source-requests");
const outputPath = join(requestDir, `${dateLabel}-${slug}.md`);

mkdirSync(requestDir, { recursive: true });

const lines = [
  `# Source Request ${dateLabel}`,
  "",
  `Status: pending`,
  `Created At: ${now.toISOString()}`,
  `Source: feishu-or-local-request`,
  "",
  "## Request",
  "",
  requestText,
  "",
  "## Intake Checklist",
  "",
  "- Clarify data type: news / price / calendar / filings / social / macro",
  "- Decide whether credentials or paid subscriptions are required",
  "- Prefer provider adapters that can be added locally without widening live-trading risk",
  "- If code changes are needed, open a local implementation task before enabling automation",
  "",
  "## Next Action",
  "",
  "- Review this request, choose the provider, and decide whether to implement locally or stage as a proposal."
];

writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
console.log(JSON.stringify({ saved: true, path: outputPath, timestamp }, null, 2));

function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}
