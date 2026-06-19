#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeOpenClawRuntimeSnapshot } from "./openclaw-runtime-doctor-core.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const runtimeDir = join(repoRoot, "runtime", "openclaw-cron-runner");

const snapshot = {
  gatewayListeners: readListeners("18789"),
  cronRunnerListeners: readListeners("18792"),
  gatewayErrorLines: readGatewayErrorLines(),
  recentRunnerResults: readRecentRunnerResults()
};
const analysis = analyzeOpenClawRuntimeSnapshot(snapshot);

console.log(JSON.stringify({ ok: analysis.ok, snapshot, findings: analysis.findings }, null, 2));
process.exitCode = analysis.ok ? 0 : 1;

function readListeners(port) {
  const output = tryExec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  return output
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/u);
      return {
        command: parts[0],
        pid: Number(parts[1]),
        endpoint: parts.at(-1)
      };
    })
    .filter((entry) => Number.isFinite(entry.pid));
}

function readGatewayErrorLines() {
  const paths = [
    join(homedir(), ".openclaw", "logs", "gateway.system.err.log"),
    join(homedir(), "Library", "Logs", "openclaw", "gateway.log")
  ];
  return paths.flatMap((path) => {
    if (!existsSync(path)) {
      return [];
    }
    return readFileSync(path, "utf8")
      .split(/\r?\n/u)
      .slice(-500)
      .filter((line) => /EADDRINUSE|address already in use|Port 18789|Native hook relay|PreToolUse/iu.test(line));
  }).slice(-40);
}

function readRecentRunnerResults() {
  if (!existsSync(runtimeDir)) {
    return [];
  }
  return readdirSync(runtimeDir)
    .filter((name) => /^\d+-.+\.json$/u.test(name))
    .map((name) => {
      const path = join(runtimeDir, name);
      try {
        return {
          file: path,
          ...JSON.parse(readFileSync(path, "utf8"))
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => String(right.finishedAt ?? "").localeCompare(String(left.finishedAt ?? "")))
    .slice(0, 8)
    .map((entry) => ({
      file: entry.file,
      job: entry.job,
      ok: entry.ok,
      error: entry.error,
      stderrTail: tail(entry.stderrTail)
    }));
}

function tryExec(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    return String(error?.stdout ?? "");
  }
}

function tail(value) {
  return String(value ?? "").split(/\r?\n/u).slice(-8).join("\n").trim();
}
