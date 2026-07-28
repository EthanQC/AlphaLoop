#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadLocalEnv, resolveRuntimePaths } from "../../../packages/shared-types/dist/index.js";
import { analyzeOpenClawRuntimeSnapshot, readLaunchdJobStates } from "./openclaw-runtime-doctor-core.mjs";
import {
  describeOpenClawCliFailure,
  judgeReportDeliveryState,
  parseOpenClawCronList
} from "./openclaw-runtime-doctor-probes.mjs";

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
 * Round-7 finding K7: it used to answer that question out of the LOCAL
 * `origin/main` ref, with the note "the doctor observes; refreshing the remote
 * ref would be changing the repository it is reporting on, and a stale ref can
 * only ever make this check quieter, never noisier". The second half is true
 * and is exactly the problem. MEASURED read-only on the deploy target
 * (2026-07-29): HEAD = 14b1202, local origin/main ref = 14b1202, behind = 0,
 * tree clean - while the real origin/main was a4e39c1, five commits ahead. The
 * one check whose job is to answer 「跑的不是你 push 的代码」 answered "fine" on
 * a machine that had never fetched them.
 *
 * So the remote tip is now read with `git ls-remote`, which asks origin
 * directly and writes NOTHING - no ref update, no object fetch, no working-tree
 * change. The observe-don't-mutate rule is kept; the blind spot is not. When
 * the network or credentials say no, `remoteTip` stays null and the analyzer
 * says so rather than treating silence as agreement.
 */
function readGitCheckout() {
  const head = gitOutput(["rev-parse", "--short", "HEAD"]);
  if (!head) {
    return {
      head: null,
      remoteHead: null,
      behind: null,
      ahead: null,
      remoteTip: null,
      remoteTipError: null,
      remoteTipKnownLocally: null,
      dirtyFiles: []
    };
  }
  const remoteHead = gitOutput(["rev-parse", "--short", "origin/main"]);
  const behindText = remoteHead ? gitOutput(["rev-list", "--count", "HEAD..origin/main"]) : null;
  const aheadText = remoteHead ? gitOutput(["rev-list", "--count", "origin/main..HEAD"]) : null;
  const dirty = gitOutput(["status", "--porcelain", "--untracked-files=no"]) ?? "";
  const remote = readRemoteTip();
  return {
    head,
    remoteHead,
    behind: behindText === null ? null : Number(behindText),
    ahead: aheadText === null ? null : Number(aheadText),
    // The true tip of origin/main right now, its short form, and whether this
    // machine even has that commit. "Not known locally" is the strongest
    // possible statement that this checkout is not it: the object is not here,
    // so HEAD cannot contain it.
    remoteTip: remote.tip,
    remoteTipError: remote.error,
    remoteTipKnownLocally: remote.known,
    // Only computable when the commit is here; when it is not, "how far behind"
    // is unanswerable and stays null rather than becoming a made-up number.
    behindRemoteTip: remote.known
      ? Number(gitOutput(["rev-list", "--count", `HEAD..${remote.tip}`]) ?? "0")
      : null,
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

/** For git commands whose ANSWER is the exit code (`cat-file -e`, `merge-base --is-ancestor`). */
function gitSucceeds(args) {
  try {
    execFileSync("git", ["-C", repoRoot, ...args], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5000
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The tip of origin/main as origin reports it RIGHT NOW.
 *
 * `ls-remote` is a read: it prints what the remote has and updates no ref, no
 * object store and no working tree. Bounded by a 15s timeout so an unreachable
 * remote (or an ssh key that wants a passphrase) delays the gate instead of
 * hanging it; a failure is returned as a reason, never as a silent "current".
 */
function readRemoteTip() {
  let output;
  try {
    output = execFileSync("git", ["-C", repoRoot, "ls-remote", "origin", "refs/heads/main"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      // BatchMode so a key with a passphrase, or an unknown host key, FAILS
      // instead of prompting: ssh reads those from the terminal rather than
      // stdin, so `stdio: ignore` alone would leave the gate sitting there
      // until the timeout. An operator who has already set GIT_SSH_COMMAND
      // keeps theirs. Measured on the deploy target (2026-07-29, read-only):
      // `git ls-remote origin refs/heads/main` under BatchMode returns
      // a4e39c1 there in well under a second.
      env: {
        ...process.env,
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=8"
      }
    });
  } catch (error) {
    const stderr = String(error?.stderr ?? "").trim().split(/\r?\n/u).filter(Boolean).at(-1);
    return { tip: null, known: null, error: stderr || String(error?.message ?? error) };
  }
  const sha = String(output).trim().split(/\s+/u)[0] ?? "";
  if (!/^[0-9a-f]{7,40}$/iu.test(sha)) {
    return { tip: null, known: null, error: `git ls-remote origin refs/heads/main 没有给出 sha：${String(output).trim().slice(0, 120)}` };
  }
  const known = gitSucceeds(["cat-file", "-e", `${sha}^{commit}`]);
  return { tip: gitOutput(["rev-parse", "--short", sha]) ?? sha.slice(0, 7), known, error: null };
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
    // Round-7 finding K8. Two flags, both measured against the deploy target's
    // own CLI (openclaw 2026.7.1-2) read-only on 2026-07-29:
    //
    //   --agent control  every managed job is registered on the `control` agent
    //                    (see openclaw-cron-jobs.mjs), and this gateway also
    //                    serves the operator's personal 186-agent fleet. The
    //                    envelope is paged - {total, offset, limit, hasMore,
    //                    nextOffset} - and this CLI version has no --limit or
    //                    --offset, so scoping the QUERY is the only way to keep
    //                    our five rows from being pushed off the page by
    //                    somebody else's jobs.
    //   --all            without it the list omits DISABLED jobs, and a
    //                    disabled job would read here as a missing one. It is
    //                    broken either way, but it is a different repair.
    //
    // Answer today: total=5, limit=5, hasMore=false, all five present, enabled.
    output = execFileSync("openclaw", ["cron", "list", "--json", "--agent", "control", "--all"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000
    });
  } catch (error) {
    return { ok: false, error: describeOpenClawCliFailure(error), names: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(String(output || "[]"));
  } catch (parseError) {
    return { ok: false, error: `openclaw cron list --json 的输出不是 JSON：${parseError.message}`, names: [] };
  }

  // Envelope shapes, paging and the enabled/disabled split all live in
  // openclaw-runtime-doctor-probes.mjs, where they can be tested without
  // running a health check against this machine.
  return parseOpenClawCronList(parsed);
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
    lastDeliveryReason: null,
    lastDeliverySent: null
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
  // Round-7 finding K5: which entry is "the last delivery", and what it says,
  // is judged in openclaw-runtime-doctor-probes.mjs - see its own note on why
  // ranking by `deliveredAt` alone could never see a refused report.
  return { ...routing, ...judgeReportDeliveryState(state) };
}

function tail(value) {
  return String(value ?? "").split(/\r?\n/u).slice(-8).join("\n").trim();
}
