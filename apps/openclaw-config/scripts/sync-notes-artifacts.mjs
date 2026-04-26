#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const notesRepo = join(repoRoot, "knowledge", "notes", "private-repo");
const artifactRoot = join(notesRepo, "openclaw-artifacts");

if (!existsSync(notesRepo)) {
  console.error(`Notes repo not found: ${notesRepo}`);
  process.exit(1);
}

rmSync(artifactRoot, { recursive: true, force: true });
mkdirSync(artifactRoot, { recursive: true });

copyDir(join(repoRoot, "reports", "daily"), join(artifactRoot, "reports", "daily"));
copyDir(join(repoRoot, "reports", "weekly"), join(artifactRoot, "reports", "weekly"));
copyDir(join(repoRoot, "reports", "proposals"), join(artifactRoot, "reports", "proposals"));
copyDir(join(repoRoot, "rules", "live"), join(artifactRoot, "rules", "live"));
copyDir(join(repoRoot, "rules", "paper"), join(artifactRoot, "rules", "paper"));

const summary = {
  generatedAt: new Date().toISOString(),
  sourceRepo: repoRoot,
  notesRepo
};
writeFileSync(join(artifactRoot, "manifest.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

const readmePath = join(artifactRoot, "README.md");
const readme = [
  "# OpenClaw Trading Artifacts",
  "",
  "This folder is synced from the local trading stack.",
  "",
  "- `reports/daily`: generated daily summaries",
  "- `reports/weekly`: generated weekly summaries",
  "- `reports/proposals`: local rule proposal snapshots",
  "- `rules/live` and `rules/paper`: active and candidate rule snapshots"
];
writeFileSync(readmePath, `${readme.join("\n")}\n`, "utf8");

console.log(JSON.stringify({ synced: true, artifactRoot }, null, 2));

function copyDir(from, to) {
  if (!existsSync(from)) {
    return;
  }
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
}
