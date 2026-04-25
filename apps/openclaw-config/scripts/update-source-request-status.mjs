#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const filePath = process.argv[2];
const nextStatus = process.argv[3];
const note = process.argv.slice(4).join(" ").trim();
const allowed = new Set(["pending", "approved", "implemented", "blocked"]);

if (!filePath || !nextStatus || !allowed.has(nextStatus)) {
  console.error("Usage: update-source-request-status.mjs <file> <pending|approved|implemented|blocked> [note]");
  process.exit(1);
}

if (!existsSync(filePath)) {
  console.error(`File not found: ${filePath}`);
  process.exit(1);
}

const lines = readFileSync(filePath, "utf8").split(/\r?\n/u);
let updated = false;
const nextLines = lines.map((line) => {
  if (line.startsWith("Status: ")) {
    updated = true;
    return `Status: ${nextStatus}`;
  }
  return line;
});

if (!updated) {
  nextLines.splice(1, 0, `Status: ${nextStatus}`);
}

if (note) {
  nextLines.push("", "## Status Update", "", `- ${new Date().toISOString()}: ${note}`);
}

writeFileSync(filePath, `${nextLines.join("\n")}\n`, "utf8");
console.log(JSON.stringify({ updated: true, filePath, status: nextStatus }, null, 2));
