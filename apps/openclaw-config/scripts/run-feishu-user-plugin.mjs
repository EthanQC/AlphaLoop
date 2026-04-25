#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const envPath = join(repoRoot, ".env.local");

loadLocalEnv(envPath);
applyFeishuAliases();

const child = spawn("npx", ["-y", "feishu-user-plugin", ...process.argv.slice(2)], {
  cwd: repoRoot,
  env: process.env,
  stdio: ["inherit", "inherit", "inherit"]
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  process.stderr.write(`Failed to start feishu-user-plugin: ${error.message}\n`);
  process.exit(1);
});

function loadLocalEnv(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) {
      continue;
    }

    const key = match[1];
    let value = match[2] ?? "";
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function applyFeishuAliases() {
  copyEnv("FEISHU_APP_ID", "LARK_APP_ID");
  copyEnv("FEISHU_APP_SECRET", "LARK_APP_SECRET");
}

function copyEnv(source, target) {
  if (!process.env[target] && process.env[source]) {
    process.env[target] = process.env[source];
  }
}
