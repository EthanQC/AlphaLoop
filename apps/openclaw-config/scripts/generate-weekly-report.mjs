#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const scheduledReport = "apps/openclaw-config/scripts/scheduled-report.mjs";

execFileSync(process.execPath, [scheduledReport, "weekly", "prepare", ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: "inherit"
});
