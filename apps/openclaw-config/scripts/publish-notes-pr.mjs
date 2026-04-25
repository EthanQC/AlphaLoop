#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const notesRepo = join(repoRoot, "knowledge", "notes", "private-repo");

if (!existsSync(notesRepo)) {
  console.error(`Notes repo not found: ${notesRepo}`);
  process.exit(1);
}

const status = execGit(["status", "--porcelain"], notesRepo).trim();
if (status) {
  console.error("Notes repo is dirty. Commit or clear changes before publishing a PR.");
  process.exit(1);
}

execFileSync(process.execPath, [join(repoRoot, "apps", "openclaw-config", "scripts", "sync-notes-artifacts.mjs")], {
  cwd: repoRoot,
  stdio: "inherit"
});

const date = new Date();
const stamp = [
  date.getFullYear(),
  pad(date.getMonth() + 1),
  pad(date.getDate()),
  pad(date.getHours()),
  pad(date.getMinutes()),
  pad(date.getSeconds())
].join("");
const branch = `codex/trading-artifacts-${stamp}`;

execGit(["checkout", "-B", branch], notesRepo);
execGit(["add", "openclaw-artifacts"], notesRepo);

const diff = execGit(["status", "--porcelain"], notesRepo).trim();
if (!diff) {
  console.log(JSON.stringify({ created: false, reason: "no-changes" }, null, 2));
  process.exit(0);
}

execGit(["commit", "-m", `Update trading artifacts ${stamp}`], notesRepo);
execGit(["push", "-u", "origin", branch], notesRepo);

const title = `Update trading artifacts ${stamp}`;
const body = [
  "## Summary",
  "",
  "- Sync latest daily/weekly reports",
  "- Sync latest local rule proposals",
  "- Sync active rule snapshots"
].join("\n");

const url = execFileSync(
  "gh",
  [
    "pr",
    "create",
    "--repo",
    "EthanQC/stock-trading-notes",
    "--base",
    "main",
    "--head",
    branch,
    "--title",
    title,
    "--body",
    body,
    "--draft"
  ],
  {
    cwd: notesRepo,
    encoding: "utf8"
  }
).trim();

console.log(JSON.stringify({ created: true, branch, url }, null, 2));

function execGit(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8"
  });
}

function pad(value) {
  return String(value).padStart(2, "0");
}
