#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deliverReportToFeishu, loadLocalEnv } from "../../../packages/shared-types/dist/index.js";
import { buildCronFailureAlertMarkdown, buildCronHaltAlertMarkdown } from "./openclaw-cron-runner-alerts.mjs";
import {
  clearEscalationPending,
  getFailureAlertLevel,
  getPendingEscalationJobs,
  normalizeRunnerState,
  recordFailureAlerted,
  recordRunResult,
  serializeRunnerState,
  shouldAlertFailure,
  shouldAttemptRun
} from "./openclaw-cron-runner-state.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const port = Number(process.env.OPENCLAW_CRON_RUNNER_PORT ?? 18792);
const host = "127.0.0.1";
// Overridable so tests can sandbox the state file / per-run result files in a temp dir instead of
// the real repo's runtime directory.
const runtimeDir = process.env.OPENCLAW_CRON_RUNNER_RUNTIME_DIR ?? join(repoRoot, "runtime", "openclaw-cron-runner");
const processedRunsPath = join(runtimeDir, "processed-runs.json");
const openclawCronDir = process.env.OPENCLAW_CRON_DIR ?? join(homedir(), ".openclaw", "cron");
const pollMs = Number(process.env.OPENCLAW_CRON_RUNNER_POLL_MS ?? 5000);
const pnpmBin = process.env.PNPM_BIN ?? "pnpm";
const retryBaseMs = Number(process.env.OPENCLAW_CRON_RUNNER_RETRY_BASE_MS ?? 60_000);
const retryMaxMs = Number(process.env.OPENCLAW_CRON_RUNNER_RETRY_MAX_MS ?? 30 * 60_000);
mkdirSync(runtimeDir, { recursive: true });
loadLocalEnv(repoRoot);

const allowedJobs = {
  "/run/daily": { name: "daily", command: [pnpmBin, "report:daily:run"], timeoutMs: 15 * 60 * 1000 },
  "/run/weekly": { name: "weekly", command: [pnpmBin, "report:weekly:run"], timeoutMs: 15 * 60 * 1000 },
  "/run/stock-analysis": { name: "stock-analysis", command: [pnpmBin, "stock-analysis:scheduled"], timeoutMs: 20 * 60 * 1000 }
};

const cronJobNames = {
  "openclaw-trading-daily-report": allowedJobs["/run/daily"],
  "openclaw-trading-weekly-report": allowedJobs["/run/weekly"],
  "openclaw-trading-stock-analysis": allowedJobs["/run/stock-analysis"]
};
let runnerState = loadRunnerState();
const inFlightRunKeys = new Set();

if (!existsSync(processedRunsPath)) {
  seedExistingOpenClawRuns();
}

const server = createServer(async (request, response) => {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  const job = allowedJobs[url.pathname];
  if (!job) {
    sendJson(response, 404, { ok: false, error: "unknown_job" });
    return;
  }

  await readRequestBody(request);
  try {
    const result = await runAllowedJob(job, { trigger: "http" });
    sendJson(response, result.ok ? 200 : 500, result);
  } catch (error) {
    sendJson(response, 500, { ok: false, job: job.name, error: String(error?.message ?? error) });
  }
});

// Only actually bind the port / start polling when this file is run directly (`node
// openclaw-cron-runner.mjs`), not when it's imported (e.g. by tests) — importing it should be
// side-effect-free beyond the harmless state load/seed above, which tests sandbox via
// OPENCLAW_CRON_RUNNER_RUNTIME_DIR / OPENCLAW_CRON_DIR.
const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  server.listen(port, host, () => {
    console.log(JSON.stringify({
      ok: true,
      service: "openclaw-cron-runner",
      host,
      port,
      repoRoot,
      openclawCronDir,
      pollMs
    }));
  });

  await pollOpenClawRunLogs();
  setInterval(() => {
    pollOpenClawRunLogs().catch((error) => {
      console.error(JSON.stringify({ ok: false, service: "openclaw-cron-runner", error: String(error?.message ?? error) }));
    });
  }, Math.max(1000, pollMs));
}

async function pollOpenClawRunLogs() {
  // Disk is authoritative between poll cycles: an operator's `cron-runner-reset.mjs <job>` run
  // while this process is alive writes straight to this file, not to this process's memory.
  // Reloading here means that write is visible within one poll cycle instead of this process's
  // stale in-memory state (still halted) silently overwriting it on the next saveRunnerState().
  runnerState = loadRunnerState();

  // A halted job produces no new run results to piggyback an alert retry on, so a still-pending
  // escalation (send failed, or the process died mid-send) needs its own retry point each cycle.
  await retryPendingEscalationAlerts();

  const managedJobs = readManagedCronJobs();
  for (const entry of managedJobs) {
    const runEntries = readCronRunEntries(entry.id);
    for (const runEntry of runEntries) {
      if (runEntry.action !== "finished" || runEntry.status !== "ok") {
        continue;
      }
      const runKey = buildOpenClawRunKey(runEntry);
      if (!shouldAttemptRun(runnerState, runKey, Date.now(), { jobName: entry.job.name }) || inFlightRunKeys.has(runKey)) {
        continue;
      }
      inFlightRunKeys.add(runKey);
      try {
        const result = await runAllowedJob(entry.job, {
          trigger: "openclaw-cron-run-log",
          openclawJobId: entry.id,
          openclawJobName: entry.name,
          openclawRunId: runEntry.runId ?? null,
          openclawRunAtMs: runEntry.runAtMs ?? null
        });
        runnerState = recordRunResult(runnerState, runKey, result, Date.now(), { retryBaseMs, retryMaxMs });
        saveRunnerState();
        // Same-class failure count reaching 3 halts the job (see openclaw-cron-runner-state.mjs);
        // that halting failure always gets an escalation alert regardless of the per-runKey
        // dedupe below, since a halt can happen on a retry of a runKey already alerted once.
        const alertLevel = getFailureAlertLevel(runnerState, entry.job.name);
        if (!result.ok && shouldAlertFailure(runnerState, runKey) && alertLevel === "notice") {
          await sendCronFailureAlert(result, runnerState.failedRunAttempts[runKey], "notice")
            .then(() => {
              runnerState = recordFailureAlerted(runnerState, runKey);
              saveRunnerState();
            })
            .catch((error) => {
              console.error(JSON.stringify({
                ok: false,
                service: "openclaw-cron-runner",
                action: "failure-alert",
                job: result.job,
                error: String(error?.message ?? error)
              }));
            });
        }
        if (!result.ok && alertLevel === "escalation") {
          await sendCronFailureAlert(result, runnerState.jobFailureState[entry.job.name], "escalation")
            .then(() => {
              runnerState = clearEscalationPending(runnerState, entry.job.name);
              saveRunnerState();
            })
            .catch((error) => {
              // Leave escalationPending set (recordRunResult above already set it true on this
              // halt transition): retryPendingEscalationAlerts() will retry it on the next poll
              // cycle instead of this halt going silently unreported.
              console.error(JSON.stringify({
                ok: false,
                service: "openclaw-cron-runner",
                action: "halt-escalation-alert",
                job: result.job,
                error: String(error?.message ?? error)
              }));
            });
        }
      } finally {
        inFlightRunKeys.delete(runKey);
      }
    }
  }
}

// Retries the escalation alert for every halted job whose escalationPending flag is still set
// (initial send failed, or the process died mid-send) — the existing per-runKey alertedRunKeys
// dedupe never applies here, since a halted job produces no new runKey for that dedupe to gate.
async function retryPendingEscalationAlerts() {
  for (const { jobName, jobFailure } of getPendingEscalationJobs(runnerState)) {
    const result = (jobFailure.lastResultPath ? readJsonFile(jobFailure.lastResultPath, null) : null) ?? { job: jobName };
    try {
      await sendCronFailureAlert(result, jobFailure, "escalation");
      runnerState = clearEscalationPending(runnerState, jobName);
      saveRunnerState();
    } catch (error) {
      console.error(JSON.stringify({
        ok: false,
        service: "openclaw-cron-runner",
        action: "halt-escalation-alert-retry",
        job: jobName,
        error: String(error?.message ?? error)
      }));
    }
  }
}

async function runAllowedJob(job, context = {}) {
  const startedAt = new Date().toISOString();
  const [cmd, ...args] = job.command;
  const child = spawn(cmd, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...(context.trigger === "openclaw-cron-run-log" ? { OPENCLAW_CRON_TRIGGERED: "1" } : {})
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const chunks = { stdout: [], stderr: [] };
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
  }, job.timeoutMs);

  child.stdout?.on("data", (chunk) => chunks.stdout.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk) => chunks.stderr.push(Buffer.from(chunk)));

  const exit = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ code: null, signal: null, error }));
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);

  const stdout = Buffer.concat(chunks.stdout).toString("utf8");
  const stderr = Buffer.concat(chunks.stderr).toString("utf8");
  const resultPath = join(runtimeDir, `${Date.now()}-${job.name}.json`);
  const result = {
    ok: !exit.error && exit.code === 0,
    job: job.name,
    trigger: context.trigger ?? "unknown",
    openclawJobId: context.openclawJobId ?? null,
    openclawJobName: context.openclawJobName ?? null,
    openclawRunId: context.openclawRunId ?? null,
    openclawRunAtMs: context.openclawRunAtMs ?? null,
    command: job.command.join(" "),
    startedAt,
    finishedAt: new Date().toISOString(),
    code: exit.code,
    signal: exit.signal,
    error: exit.error ? String(exit.error?.message ?? exit.error) : null,
    resultPath,
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr)
  };
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

function seedExistingOpenClawRuns() {
  const keys = new Set(runnerState.processedRunKeys);
  for (const entry of readManagedCronJobs()) {
    for (const runEntry of readCronRunEntries(entry.id)) {
      keys.add(buildOpenClawRunKey(runEntry));
    }
  }
  runnerState = normalizeRunnerState({
    ...runnerState,
    processedRunKeys: Array.from(keys)
  });
  saveRunnerState();
}

function readManagedCronJobs() {
  const jobsPath = join(openclawCronDir, "jobs.json");
  const data = readJsonFile(jobsPath, { jobs: [] });
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  return jobs
    .filter((job) => job?.enabled !== false && cronJobNames[job?.name])
    .map((job) => ({
      id: String(job.id),
      name: String(job.name),
      job: cronJobNames[job.name]
    }));
}

function readCronRunEntries(jobId) {
  const runsDir = join(openclawCronDir, "runs");
  const path = join(runsDir, `${jobId}.jsonl`);
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry && typeof entry === "object");
}

function buildOpenClawRunKey(entry) {
  return [
    String(entry.jobId ?? "unknown-job"),
    String(entry.runId ?? entry.runAtMs ?? entry.ts ?? "unknown-run"),
    String(entry.action ?? "unknown-action")
  ].join(":");
}

function loadRunnerState() {
  return normalizeRunnerState(readJsonFile(processedRunsPath, { processedRunKeys: [] }));
}

function saveRunnerState() {
  writeFileSync(processedRunsPath, `${JSON.stringify(serializeRunnerState(runnerState), null, 2)}\n`, "utf8");
}

async function sendCronFailureAlert(result, attempt, alertLevel = "notice") {
  if (process.env.OPENCLAW_CRON_RUNNER_ALERTS === "0") {
    return;
  }
  const isEscalation = alertLevel === "escalation";
  const markdown = isEscalation
    ? buildCronHaltAlertMarkdown(result, attempt)
    : buildCronFailureAlertMarkdown(result, attempt);
  const delivery = await deliverReportToFeishu({
    title: isEscalation
      ? `OpenClaw 自动报告已停机：${result.job}`
      : `OpenClaw 自动报告失败告警：${result.job}`,
    markdown,
    maxSectionChars: 3600
  });
  if (!delivery.sent) {
    throw new Error(delivery.reason ?? "Failure alert was not sent.");
  }
}

function readJsonFile(path, fallback) {
  try {
    if (!existsSync(path)) {
      return fallback;
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    request.on("data", () => {});
    request.on("end", resolve);
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function tail(value) {
  return String(value ?? "").split(/\r?\n/u).slice(-30).join("\n").trim();
}

// Exported for tests only: importing this module never starts the HTTP server or the poll
// interval (both gated behind isMainModule above), so tests drive a poll cycle directly and
// inspect the in-memory state it produced.
export { pollOpenClawRunLogs };
export function __getRunnerStateForTest() {
  return runnerState;
}
