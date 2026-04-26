#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { repoRoot } from "./repo-root.mjs";

const openId = process.argv[2]?.trim();

if (!openId || !openId.startsWith("ou_")) {
  console.error("Usage: authorize-feishu-user.mjs <feishu_open_id>");
  process.exit(1);
}

const envPath = join(repoRoot, ".env.local");
const env = loadEnv(envPath);

const allowFrom = mergeCsv(env.FEISHU_ALLOW_FROM, openId);
env.FEISHU_ALLOW_FROM = allowFrom.join(",");

if (!env.FEISHU_DM_POLICY || env.FEISHU_DM_POLICY === "pairing") {
  env.FEISHU_DM_POLICY = "allowlist";
}

writeEnv(envPath, env);
updateOpenClawAllowlist(openId);

execFileSync(process.execPath, [join(repoRoot, "apps", "openclaw-config", "scripts", "render-openclaw-config.mjs")], {
  cwd: repoRoot,
  stdio: "inherit"
});
execFileSync("bash", [join(repoRoot, "apps", "openclaw-config", "scripts", "install-launchd.sh")], {
  cwd: repoRoot,
  stdio: "inherit"
});

console.log(JSON.stringify({ authorized: true, openId, allowFrom }, null, 2));

function updateOpenClawAllowlist(newOpenId) {
  const credentialsDir = join(homedir(), ".openclaw", "credentials");
  mkdirSync(credentialsDir, { recursive: true });
  const allowPath = join(credentialsDir, "feishu-main-allowFrom.json");
  const current = existsSync(allowPath)
    ? JSON.parse(readFileSync(allowPath, "utf8"))
    : { version: 1, allowFrom: [] };

  const allowFrom = Array.isArray(current.allowFrom) ? current.allowFrom.map(String) : [];
  if (!allowFrom.includes(newOpenId)) {
    allowFrom.push(newOpenId);
  }

  writeFileSync(
    allowPath,
    `${JSON.stringify({ version: 1, allowFrom }, null, 2)}\n`,
    "utf8"
  );
}

function loadEnv(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  const values = {};
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match) {
      continue;
    }

    let value = match[2] ?? "";
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[match[1]] = value;
  }

  return values;
}

function writeEnv(filePath, env) {
  const orderedKeys = Object.keys(env).sort();
  const lines = orderedKeys.map((key) => `${key}=${formatEnvValue(env[key] ?? "")}`);
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function formatEnvValue(value) {
  if (/[\s"#'`]/u.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function mergeCsv(existingValue, nextValue) {
  const values = new Set(
    String(existingValue ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
  values.add(nextValue);
  return Array.from(values);
}
