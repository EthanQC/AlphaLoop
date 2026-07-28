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
// deploy - see `judgeDeployAttempt`'s `deployed: false` branch and the
// footprint detection in the doctor - because a dev box has never deployed
// anything and must stay green.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
 * Appends one step receipt. Never throws for an ordinary I/O problem: a deploy
 * must not fail BECAUSE its bookkeeping failed, and the doctor's "this step
 * left no receipt" finding covers the resulting gap honestly.
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

/** Every receipt on this machine, oldest first. Malformed lines are dropped. */
export function readDeployLedger(runtimeRoot) {
  const path = deployLedgerPath(runtimeRoot);
  if (!existsSync(path)) {
    return [];
  }
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return text
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
 *   a receipt from another commit   -> also a reported gap, not a failure: the
 *                                     step did succeed, just against code that
 *                                     is no longer checked out. The doctor's
 *                                     own git check is what calls a stale
 *                                     checkout an error.
 *
 * @returns {{
 *   deployed: boolean, attempt: string|null,
 *   failedSteps: object[], missingSteps: object[], staleSteps: object[]
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
// `record` always exits 0, including when the write failed (it prints the
// reason): the caller's own exit code is the deploy result, and must not be
// overwritten by bookkeeping.
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
