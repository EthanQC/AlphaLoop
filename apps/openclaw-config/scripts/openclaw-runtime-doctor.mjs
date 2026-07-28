#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRuntimePaths } from "../../../packages/shared-types/dist/index.js";
import { analyzeOpenClawRuntimeSnapshot, readLaunchdJobStates } from "./openclaw-runtime-doctor-core.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const runtimeDir = join(repoRoot, "runtime", "openclaw-cron-runner");
const { runtimeRoot, dbPath } = resolveRuntimePaths(repoRoot);

const snapshot = {
  gatewayListeners: readListeners("18789"),
  cronRunnerListeners: readListeners("18792"),
  gatewayErrorLines: readGatewayErrorLines(),
  recentRunnerResults: readRecentRunnerResults(),
  // Round-3 finding F2: this is the REAL launchd probe, shared verbatim with
  // openclaw-runtime-doctor-core.test.ts (which runs it against this
  // machine's actual launchctl) rather than re-implemented here - a probe
  // whose test drives a lookalike copy proves nothing about what the doctor
  // itself sees.
  launchdJobs: readLaunchdJobStates(),
  runtimeRoot,
  dbPath
};

// `launchdJobs` is already scoped to exactly the labels this repo owns (it is
// built from install-launchd-ownership.txt), so unlike the old whole-machine
// `launchctl list` dump it can be printed verbatim - the state/domain columns
// are the most useful part of the report when something is down.
const printedSnapshot = snapshot;

// task H2 fix round (this task, CRITICAL finding): analyzeOpenClawRuntimeSnapshot
// now isolates each individual check's own throws internally (see that
// module's own doc comment on runChecksFailureIsolated) - this try/catch is
// an outer, last-resort net for the analyzer itself somehow throwing outside
// that per-check loop (e.g. a future bug in the shared pre-check
// computation above it), so this CLI - the doctor's only external observer -
// still prints something actionable instead of dying silently and printing
// NOTHING, which is exactly the failure mode this task exists to close.
let analysis;
try {
  // Phase 3 Task 8: analyzeOpenClawRuntimeSnapshot is now async (its new
  // platform-app-health check makes a real HTTP round-trip) - this file is
  // ESM (top-level await is valid here) and already runs as a plain script,
  // so awaiting in place is enough; the try/catch below still needs the
  // `await` to be INSIDE it to catch a rejection the same way it already
  // catches a synchronous throw.
  analysis = await analyzeOpenClawRuntimeSnapshot(snapshot);
} catch (analysisError) {
  analysis = {
    ok: false,
    findings: [{
      severity: "error",
      code: "doctor.analysis_crashed",
      message: `分析过程自身抛出异常，未能生成完整报告：${analysisError instanceof Error ? analysisError.message : String(analysisError)}`
    }]
  };
}

console.log(JSON.stringify({ ok: analysis.ok, snapshot: printedSnapshot, findings: analysis.findings }, null, 2));
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
