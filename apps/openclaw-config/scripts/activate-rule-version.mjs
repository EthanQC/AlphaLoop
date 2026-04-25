#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const scope = process.argv[2];
const version = process.argv[3];

if (!scope || !version || !["live", "paper"].includes(scope)) {
  console.error("Usage: activate-rule-version.mjs <live|paper> <version>");
  process.exit(1);
}

const activePath = join(repoRoot, "rules", scope, "active-version.json");
const current = JSON.parse(readFileSync(activePath, "utf8"));
const next = {
  activeVersion: version,
  candidateVersion: current.candidateVersion ?? null,
  previousVersion: current.activeVersion
};

writeFileSync(activePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
console.log(`Activated ${scope} rules: ${version}`);

