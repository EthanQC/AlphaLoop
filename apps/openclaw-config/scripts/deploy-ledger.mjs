#!/usr/bin/env node
// Round-6 (2026-07-29): THE DEPLOY LEDGER - the mechanism that makes a
// deploy-time failure undeniable.
//
// THE PROBLEM IT SOLVES
// ---------------------
// Five separate confirmed criticals in round 5 were one shape: something in the
// deploy path failed, said so loudly, exited non-zero - and the acceptance gate
// (runbook step 8, `pnpm openclaw:runtime:doctor`) still answered ok=true,
// exit 0. Measured, with the real installers against a sandboxed root:
//
//   · four labels held in NO launchd domain      -> step 3/4/5 each exit 1  -> gate ok
//   · three daemons dead on arrival              -> step 3 exit 0 (!)       -> gate ok
//   · `git pull --ff-only` aborted on a dirty file -> steps 1-8 ran on the
//     OLD checkout                                                          -> gate ok
//   · `openclaw cron add` failing                -> 0 of 5 jobs installed,
//     uncaught exception, exit 1                                            -> gate ok
//   · the archive directory unwritable           -> step 3 exit 1           -> gate ok
//
// The gate could not see any of it, because the gate only ever looked at the
// machine's CURRENT state through checks that were each individually forgiving,
// and nothing carried "a step of this deploy failed twenty seconds ago" forward
// in time.
//
// WHAT THIS IS
// ------------
// An append-only JSONL file under `<runtime>/deploy/steps.jsonl`, one line per
// runbook step actually executed, carrying the step's exit code and the commit
// it ran against. Written by deploy.sh (which runs the runbook) and by
// install-system-daemons.sh (which an operator may legitimately run by hand);
// read by the doctor, which turns a failed or missing step into an `error`
// finding - the severity that flips `ok` to false and the exit code to 1.
//
// Deliberately NOT a lock or a state machine: it never prevents a step from
// running, it only makes the outcome of every step something the gate has to
// answer for. A machine with no ledger at all is not treated as a failed
// deploy - see `judgeDeployLedger`'s `deployed: false` branch and the
// footprint detection in the doctor - because a dev box has never deployed
// anything and must stay green.

import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";

/**
 * The runbook, as data. README.md's 「部署机安装顺序」 renders these same rows,
 * deploy.sh executes them in this order, and the doctor checks that all of
 * them ran. One list, so a step cannot be added to the runbook and silently
 * left out of the gate.
 *
 * `gate: true` marks the acceptance step itself - the doctor never requires a
 * receipt for the check that is producing the finding.
 */
export const DEPLOY_STEPS = [
  { step: 0, key: "pull", title: "把新代码拉到这台机器（唯一的代码传输步骤）" },
  { step: 1, key: "build", title: "pnpm install + pnpm build（daemon 直接跑 dist 产物）" },
  { step: 2, key: "install-user-agents", title: "安装用户级 LaunchAgent（rsshub）+ openclaw gateway install" },
  { step: 3, key: "install-system-daemons", title: "把 8 个无人值守服务装进 /Library/LaunchDaemons（sudo）" },
  { step: 4, key: "retire-user-agents", title: "退役旧的用户级副本（只移动、不删除）" },
  { step: 5, key: "install-cron", title: "注册 5 个报告类 openclaw cron 任务" },
  { step: 6, key: "render-persona", title: "部署 control agent 人设" },
  { step: 7, key: "rsshub-container", title: "创建/启动 rsshub 容器" },
  { step: 8, key: "acceptance", title: "验收：pnpm openclaw:runtime:doctor", gate: true }
];

export const REQUIRED_DEPLOY_STEPS = DEPLOY_STEPS.filter((entry) => !entry.gate);

export function deployLedgerPath(runtimeRoot) {
  return join(runtimeRoot, "deploy", "steps.jsonl");
}

export function deployStepByNumber(step) {
  return DEPLOY_STEPS.find((entry) => entry.step === Number(step)) ?? null;
}

/**
 * Appends one step receipt. Never throws for an ordinary I/O problem - but the
 * result is not optional reading, and round 7 is why.
 *
 * The old contract said an unwritable ledger was harmless because "the doctor's
 * 'this step left no receipt' finding covers the gap honestly". That reasoning
 * only holds when the receipts are ABSENT. MEASURED (2026-07-29, real scripts,
 * real doctor): a clean deploy, then `chmod 444 runtime/deploy/steps.jsonl`
 * (exactly what one earlier sudo run leaves behind), then a deploy whose step 1
 * fails - the failure receipt could not be appended, LAST deploy's nine
 * `exitCode: 0` rows were still on disk, and the gate answered ok=true, exit 0
 * on a machine that had just failed to deploy. The gap was not a blank; it was
 * a row of green.
 *
 * So: the writer still never throws (a deploy must not die of bookkeeping), and
 * EVERY caller now checks `written` and stops - see deploy.sh's record_step,
 * install-system-daemons.sh's record_install_result and install-openclaw-cron.mjs.
 * The doctor closes the same hole from the other side with
 * `deploy-ledger.unwritable`, which needs no cooperation from the failed writer.
 *
 * @returns {{written: boolean, path: string, error?: string}}
 */
export function recordDeployStep({
  runtimeRoot,
  attempt,
  step,
  exitCode,
  head = null,
  startedAt = null,
  finishedAt = new Date().toISOString(),
  detail = null
}) {
  const path = deployLedgerPath(runtimeRoot);
  const known = deployStepByNumber(step);
  const line = JSON.stringify({
    attempt: String(attempt),
    step: Number(step),
    key: known?.key ?? `step-${step}`,
    exitCode: Number(exitCode),
    head: head ? String(head) : null,
    startedAt,
    finishedAt,
    host: safeHostname(),
    user: safeUsername(),
    ...(detail ? { detail: String(detail) } : {})
  });
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${line}\n`, "utf8");
    return { written: true, path };
  } catch (error) {
    return { written: false, path, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Round-7 finding K1, the half that does not depend on a failed writer having
 * been able to report anything: CAN a receipt be appended here at all?
 *
 * Read-only by construction - `access(W_OK)` asks the kernel, it does not
 * create or touch anything, so this is safe to call from the doctor (which must
 * never write under runtime/) and from a test suite.
 *
 * Judged against the deepest path that already exists, because that is what the
 * next `mkdir -p` + append will actually hit: the ledger file itself if it is
 * there, else the directory that would hold it, else the runtime root, else its
 * parent. When none of them exists this machine has no runtime tree yet and
 * there is nothing to judge - `writable: null`, and the doctor says nothing.
 *
 * @returns {{writable: boolean|null, path: string, checked: string|null, error?: string}}
 */
export function probeDeployLedgerWritable(runtimeRoot) {
  const path = deployLedgerPath(runtimeRoot);
  const candidates = [path, dirname(path), String(runtimeRoot ?? ""), dirname(String(runtimeRoot ?? ""))];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) {
      continue;
    }
    try {
      accessSync(candidate, constants.W_OK);
      return { writable: true, path, checked: candidate };
    } catch (error) {
      return {
        writable: false,
        path,
        checked: candidate,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
  return { writable: null, path, checked: null };
}

/**
 * Round-8 finding L3, the READ half of K1 (which only closed the write half).
 *
 * `readDeployLedger` answers `[]` for three completely different machines, and
 * `judgeDeployLedger` short-circuits `[]` to `deployed: false`, which is at most
 * a warn. MEASURED, both starting from a real deploy whose step 3 had failed
 * (receipt `3:1` sitting on disk):
 *
 *   · `chmod 0222 steps.jsonl` -> gate ok=TRUE with ZERO deploy-ledger findings,
 *     not even `absent` - because the old `deployFootprint`'s first signal was
 *     also "readLedgerEntries().length > 0", so an unreadable ledger unmade the
 *     footprint that would have raised the severity;
 *   · `rm steps.jsonl` -> gate ok=TRUE, one warn.
 *
 * A failed deploy erased by deleting one file. So the reader now reports WHICH
 * of the three it is, and the doctor keeps them apart:
 *
 *   fileExists=false, dirExists=false  no ledger was ever written here
 *   fileExists=false, dirExists=true   there WAS one - `runtime/deploy/` exists
 *                                      only because a receipt was appended into
 *                                      it (recordDeployStep's mkdirSync is the
 *                                      only thing in this repo that creates it)
 *   readable=false                     it is there and this process cannot read
 *                                      it; nothing below is evidence
 *
 * @returns {{entries: Array<Record<string, unknown>>, path: string,
 *            dir: string, fileExists: boolean, dirExists: boolean,
 *            readable: boolean|null, error: string|null}}
 */
export function readDeployLedgerResult(runtimeRoot) {
  const path = deployLedgerPath(runtimeRoot);
  const dir = dirname(path);
  const base = { entries: [], path, dir, dirExists: existsSync(dir), fileExists: existsSync(path) };
  if (!base.fileExists) {
    return { ...base, readable: null, error: null };
  }
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { ...base, readable: false, error: error instanceof Error ? error.message : String(error) };
  }
  const entries = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { ...base, entries, readable: true, error: null };
}

/** Every receipt on this machine, oldest first. Malformed lines are dropped. */
export function readDeployLedger(runtimeRoot) {
  return readDeployLedgerResult(runtimeRoot).entries;
}

/** The newest receipt for each step, keyed by step number. */
export function latestReceiptPerStep(entries) {
  const byStep = new Map();
  for (const entry of entries) {
    byStep.set(Number(entry.step), entry);
  }
  return byStep;
}

/**
 * Judges the ledger PER STEP, not per attempt.
 *
 * Per-step is what makes the honest answer possible for the way this runbook is
 * really used. deploy.sh runs all nine steps under one attempt id, but an
 * operator legitimately re-runs one step by hand after fixing what it reported
 * (install-system-daemons.sh writes its own receipt for exactly that reason) -
 * and if judging were scoped to "the newest attempt", that one hand-run would
 * make the gate claim the other eight steps had never happened.
 *
 * Severity split, and the reasoning for it:
 *
 *   a receipt with a non-zero exit  -> ERROR. This is the round-5 shape and it
 *                                     is not ambiguous: a step of this deploy
 *                                     failed and nothing since has said
 *                                     otherwise.
 *   a step with no receipt at all   -> a gap this module REPORTS but does not
 *                                     call a failure. Someone may have run the
 *                                     step by hand before this file existed;
 *                                     "we have no evidence" is not "it failed".
 *   a receipt from another commit   -> ERROR, as of round 7 (finding K2). The
 *                                     step did succeed - against code that is
 *                                     no longer what is checked out here, which
 *                                     is the definition of "the running system
 *                                     is not the code you pushed". This used to
 *                                     be a warn, justified by "the doctor's own
 *                                     git check is what calls a stale checkout
 *                                     an error"; that justification was false.
 *                                     checkDeployCheckout only errors when the
 *                                     checkout is BEHIND origin, and MEASURED
 *                                     with a real local origin and two real
 *                                     commits: deploy at A -> origin advances to
 *                                     B -> the operator runs `git pull` by hand
 *                                     and never re-runs deploy.sh -> behind = 0,
 *                                     one warn, gate green - while dist and all
 *                                     eight daemons were still running A.
 *                                     A full deploy re-stamps every step at the
 *                                     current head, so a green machine never
 *                                     carries stale receipts.
 *
 * @param {Array<Record<string, unknown>>} entries
 * @param {{head?: string|null}} [options]
 * @returns {{
 *   deployed: boolean, attempt: string|null,
 *   failedSteps: Array<Record<string, any>>,
 *   missingSteps: Array<Record<string, any>>,
 *   staleSteps: Array<Record<string, any>>
 * }}
 */
export function judgeDeployLedger(entries, { head = null } = {}) {
  if (entries.length === 0) {
    return { deployed: false, attempt: null, failedSteps: [], missingSteps: [], staleSteps: [] };
  }

  const byStep = latestReceiptPerStep(entries);
  const failedSteps = [];
  const missingSteps = [];
  const staleSteps = [];

  for (const required of REQUIRED_DEPLOY_STEPS) {
    const entry = byStep.get(required.step);
    if (!entry) {
      missingSteps.push(required);
      continue;
    }
    if (Number(entry.exitCode) !== 0) {
      failedSteps.push({ ...required, ...entry });
      continue;
    }
    if (head && entry.head && entry.head !== head) {
      staleSteps.push({ ...required, ...entry });
    }
  }

  return {
    deployed: true,
    attempt: entries.at(-1)?.attempt ?? null,
    failedSteps,
    missingSteps,
    staleSteps
  };
}

/**
 * When did the installer last reset every resident daemon's `runs` counter?
 *
 * Runbook step 3 (install-system-daemons.sh) boots every system label out and
 * back in on every run, which is what makes `runs` scoped to "since the last
 * install" (measured - see launchd-health.mjs's RESIDENT_CRASH_LOOP_RUNS). Its
 * newest SUCCESSFUL receipt is therefore the start of the window a restart
 * count is counted over, and without it a count has no window at all.
 *
 * @param {Array<Record<string, unknown>>} entries
 * @returns {string|null} the receipt's finishedAt, or null when unknown.
 */
export function lastSuccessfulInstallAt(entries) {
  const receipts = (Array.isArray(entries) ? entries : [])
    .filter((entry) => Number(entry?.step) === 3 && Number(entry?.exitCode) === 0 && entry?.finishedAt);
  return receipts.length === 0 ? null : String(receipts.at(-1).finishedAt);
}

/** `20260729-014233-7f3a` - sortable, and unique enough for one machine. */
export function newDeployAttemptId(now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${Math.random().toString(16).slice(2, 6)}`;
}

function safeHostname() {
  try {
    return hostname();
  } catch {
    return "unknown";
  }
}

function safeUsername() {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// CLI seam, so the shell half of the deploy path can write receipts too:
//
//   node deploy-ledger.mjs record --runtime-root <dir> --attempt <id> \
//        --step 3 --exit 1 [--head <sha>] [--started-at <iso>] [--detail <text>]
//   node deploy-ledger.mjs show --runtime-root <dir>
//
// `record` exits 0 when the receipt landed and 3 when it could not be written
// (with the reason on stderr). Round 7, finding K1: it used to always exit 0,
// reasoning that "the caller's own exit code is the deploy result and must not
// be overwritten by bookkeeping". The exit code it must not overwrite is the
// STEP's, and it does not - deploy.sh has already captured that before it calls
// this. What the old contract actually did was make a deploy that could not
// record anything indistinguishable from one that recorded success, while last
// deploy's green receipts stayed on disk for the gate to read.
//
// 3 rather than 1, so a shell caller can tell "the ledger is broken" from "the
// step failed" without parsing text; 2 stays "you called this wrong".
// ---------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const command = args.shift();
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = String(args[index] ?? "").replace(/^--/u, "");
    flags[key] = args[index + 1];
  }
  const runtimeRoot = flags["runtime-root"];
  if (!runtimeRoot) {
    console.error("deploy-ledger: --runtime-root is required");
    process.exit(2);
  }

  if (command === "record") {
    const result = recordDeployStep({
      runtimeRoot,
      attempt: flags.attempt ?? newDeployAttemptId(),
      step: flags.step,
      exitCode: flags.exit ?? 0,
      head: flags.head ?? null,
      startedAt: flags["started-at"] ?? null,
      detail: flags.detail ?? null
    });
    if (!result.written) {
      console.error(`deploy-ledger: could not write ${result.path}: ${result.error}`);
      process.exit(3);
    }
    process.exit(0);
  }

  if (command === "show") {
    const entries = readDeployLedger(runtimeRoot);
    console.log(JSON.stringify(judgeDeployLedger(entries, { head: flags.head ?? null }), null, 2));
    process.exit(0);
  }

  console.error("usage: deploy-ledger.mjs <record|show> --runtime-root <dir> [...]");
  process.exit(2);
}
