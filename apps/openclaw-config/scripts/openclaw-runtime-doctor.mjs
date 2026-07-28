#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadLocalEnv, resolveRuntimePaths } from "../../../packages/shared-types/dist/index.js";
import { analyzeOpenClawRuntimeSnapshot, readLaunchdJobStates } from "./openclaw-runtime-doctor-core.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const runtimeDir = join(repoRoot, "runtime", "openclaw-cron-runner");
const { runtimeRoot, dbPath } = resolveRuntimePaths(repoRoot);
// The daemons read .env.local through this exact function (loadLocalEnv is
// memoised per file, so this call also mirrors their view of it); process.env
// wins where both are set, matching how a launchd EnvironmentVariables entry
// would beat the file.
const localEnv = { ...loadLocalEnv(repoRoot), ...process.env };
const gitCheckout = readGitCheckout();

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
  dbPath,
  // Round-4 finding I5: official-paper-health checks that the pnl job's
  // markdown report actually landed under `<repo>/reports/official-paper/`,
  // which is outside runtimeRoot - so the analyzer needs the repo root too.
  repoRoot,
  // Round 6 -----------------------------------------------------------------
  // Which plists EXIST, as opposed to which labels are loaded. A stray
  // user-level plist for a system-owned label is invisible to the job table
  // (nothing is loaded twice yet) and decides what happens at the next login.
  launchdPlists: {
    system: plistLabelsIn("/Library/LaunchDaemons"),
    user: plistLabelsIn(join(homedir(), "Library", "LaunchAgents"))
  },
  git: gitCheckout,
  gitHead: gitCheckout.head,
  openclawCron: readOpenClawCronJobs(),
  notificationRouting: readNotificationRouting()
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

/** Labels of the `<label>.plist` files in one directory; [] when unreadable. */
function plistLabelsIn(dir) {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".plist"))
      .map((name) => name.replace(/\.plist$/u, ""))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Round-6 finding S3b. Is this checkout the code that was pushed?
 *
 * `origin/main` is read from the local ref only - no fetch, no network. The
 * doctor observes; refreshing the remote ref would be changing the repository
 * it is reporting on, and a stale ref can only ever make this check quieter,
 * never noisier.
 */
function readGitCheckout() {
  const head = gitOutput(["rev-parse", "--short", "HEAD"]);
  if (!head) {
    return { head: null, remoteHead: null, behind: null, ahead: null, dirtyFiles: [] };
  }
  const remoteHead = gitOutput(["rev-parse", "--short", "origin/main"]);
  const behindText = remoteHead ? gitOutput(["rev-list", "--count", "HEAD..origin/main"]) : null;
  const aheadText = remoteHead ? gitOutput(["rev-list", "--count", "origin/main..HEAD"]) : null;
  const dirty = gitOutput(["status", "--porcelain", "--untracked-files=no"]) ?? "";
  return {
    head,
    remoteHead,
    behind: behindText === null ? null : Number(behindText),
    ahead: aheadText === null ? null : Number(aheadText),
    // Everything after the status code, NOT `slice(3)`: gitOutput trims the
    // whole payload, which eats the leading space of `git status --porcelain`'s
    // first line only - so a fixed offset dropped one character from exactly
    // one filename. Caught by running this CLI for real: it reported
    // "EADME.md".
    dirtyFiles: dirty
      .split(/\r?\n/u)
      .map((line) => line.trim().split(/\s+/u).slice(1).join(" "))
      .filter(Boolean)
  };
}

function gitOutput(args) {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Round-6 finding S3g. The five report pipelines live in the openclaw cron
 * channel, so the only honest way to ask whether they exist is to ask that
 * channel. `--json` is the CLI's own machine-readable mode; the shape varies
 * between versions, so every plausible envelope is unwrapped rather than
 * assuming one.
 *
 * Bounded: a `timeout` so a wedged gateway cannot hang the acceptance gate, and
 * a read-only subcommand so this never changes what it is reporting on.
 */
function readOpenClawCronJobs() {
  let output;
  try {
    output = execFileSync("openclaw", ["cron", "list", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000
    });
  } catch (error) {
    const stderr = String(error?.stderr ?? "").trim();
    return { ok: false, error: stderr.split(/\r?\n/u)[0] || String(error?.message ?? error), names: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(String(output || "[]"));
  } catch (parseError) {
    return { ok: false, error: `openclaw cron list --json 的输出不是 JSON：${parseError.message}`, names: [] };
  }

  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.jobs)
      ? parsed.jobs
      : Array.isArray(parsed?.data)
        ? parsed.data
        : [];
  return { ok: true, names: list.map((job) => String(job?.name ?? job?.id ?? "")).filter(Boolean) };
}

/**
 * Round-6 finding S3h. Where does a public report card actually land?
 *
 * BOOLEANS ONLY. This snapshot is printed verbatim as JSON, and a Feishu chat
 * id is a credential-adjacent identifier; the check needs to know whether the
 * routing is configured, never what it is configured to.
 *
 * The env names mirror packages/shared-types/src/notifications.ts's own
 * resolveReportDeliveryTarget (FEISHU_GROUP_CHAT_ID first, then the global
 * fallback) and the deep-link base url the report cards use.
 * `report-delivery-state.json` is scheduled-report.mjs's own delivery record -
 * read as a plain file rather than by importing that module, which touches the
 * runtime tree at import time.
 */
function readNotificationRouting() {
  const configured = (name) => String(localEnv[name] ?? "").trim().length > 0;
  const routing = {
    groupChatIdConfigured: configured("FEISHU_GROUP_CHAT_ID"),
    publicBaseUrlConfigured: configured("PLATFORM_PUBLIC_BASE_URL"),
    fallbackTargetConfigured: configured("FEISHU_NOTIFY_CHAT_ID") || configured("FEISHU_NOTIFY_OPEN_ID"),
    lastDeliveryGroupFallback: false,
    lastDeliveryLabel: null,
    lastDeliveryAt: null,
    lastDeliveryReason: null
  };

  const statePath = join(runtimeRoot, "report-delivery-state.json");
  if (!existsSync(statePath)) {
    return routing;
  }
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return routing;
  }
  const newest = Object.entries(state && typeof state === "object" ? state : {})
    .filter(([, entry]) => entry && typeof entry === "object" && entry.deliveredAt)
    .sort(([, left], [, right]) => String(right.deliveredAt).localeCompare(String(left.deliveredAt)))
    .at(0);
  if (!newest) {
    return routing;
  }
  const [key, entry] = newest;
  routing.lastDeliveryGroupFallback = entry.groupFallback === true;
  routing.lastDeliveryLabel = key;
  routing.lastDeliveryAt = String(entry.deliveredAt);
  routing.lastDeliveryReason = entry.groupFallbackReason ? String(entry.groupFallbackReason) : null;
  return routing;
}

function tail(value) {
  return String(value ?? "").split(/\r?\n/u).slice(-8).join("\n").trim();
}
