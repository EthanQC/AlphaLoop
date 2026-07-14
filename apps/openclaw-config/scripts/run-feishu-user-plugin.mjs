#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const envPath = join(repoRoot, ".env.local");

loadLocalEnv(envPath);
applyFeishuAliases();

// Task H7 (2026-07-14 legacy audit): `npx -y feishu-user-plugin` (no
// version specifier) resolves whatever the npm registry serves as `latest`
// at EVERY cold start, with every Feishu secret in its environment
// (LARK_APP_SECRET, LARK_COOKIE, user access/refresh tokens - see
// secrets-inventory.md). A broken or compromised publish would run
// silently under this repo's own credentials; version drift has already
// happened silently on this machine (the npx cache holds multiple distinct
// cached versions). Pinned to the version verified against this repo's
// Feishu integration at audit time - both `npm view feishu-user-plugin
// version` (registry `latest`) and the most recently-used npx cache entry
// agreed on this version.
//
// To bump: verify the candidate version manually first (e.g.
// `npx feishu-user-plugin@<new-version> status`), then update the constant
// below - do not remove the pin.
const FEISHU_USER_PLUGIN_VERSION = String(process.env.FEISHU_USER_PLUGIN_VERSION ?? "").trim() || "1.4.1";

const child = spawn("npx", ["-y", `feishu-user-plugin@${FEISHU_USER_PLUGIN_VERSION}`, ...process.argv.slice(2)], {
  cwd: repoRoot,
  env: process.env,
  stdio: ["inherit", "inherit", "inherit"]
});

let forwardingSignal = false;

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    forwardingSignal = true;
    if (!child.killed) {
      child.kill(signal);
    }
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(signalExitCode(signal));
  }
  if (forwardingSignal) {
    process.exit(code ?? 0);
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

function signalExitCode(signal) {
  const numbers = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGTERM: 15
  };
  return 128 + (numbers[signal] ?? 0);
}
