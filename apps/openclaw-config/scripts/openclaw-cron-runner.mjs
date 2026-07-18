#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deliverReportToFeishu, loadLocalEnv } from "../../../packages/shared-types/dist/index.js";
import { buildCronFailureAlertMarkdown, buildCronHaltAlertMarkdown } from "./openclaw-cron-runner-alerts.mjs";
import {
  CRON_JOB_DAILY,
  CRON_JOB_MONTHLY_REVIEW,
  CRON_JOB_PROPOSAL_SWEEP,
  CRON_JOB_STOCK_ANALYSIS,
  CRON_JOB_WEEKLY,
  HALT_THRESHOLD,
  KNOWN_CRON_JOB_NAMES,
  clearEscalationPending,
  clearNoticePending,
  getFailureAlertLevel,
  getPendingEscalationJobs,
  getPendingNoticeJobs,
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
// 2026-07-18 CRITICAL fix (silent no-op): OpenClaw 2026.7 migrated cron storage out of the
// ~/.openclaw/cron file store (jobs.json + runs/<id>.jsonl) into its shared sqlite state DB -
// `openclaw cron status` on the deployed mini reports {"storage":"sqlite","sqlitePath":
// "~/.openclaw/state/openclaw.sqlite"}, and the old files exist only as *.migrated husks. This
// runner kept reading the dead file paths, saw zero managed jobs forever, and NONE of the 5
// scheduled pipelines ever executed - while the gateway's own run log showed green 3-12ms
// systemEvent stub runs. Discovery now goes through the documented, gateway-backed OpenClaw CLI
// (`openclaw cron list --json` / `openclaw cron runs --id <jobId>` - see docs/automation/
// cron-jobs.md: "Job definitions, runtime state, and run history persist in OpenClaw's shared
// SQLite state database") instead of any on-disk storage layout that can migrate underneath us
// again. See the discovery guard below for the fail-loud protection against a recurrence.
const openclawBin = process.env.OPENCLAW_BIN ?? "openclaw";
// Per-invocation wall-clock budget for the CLI (it talks to the gateway over a local WebSocket;
// the CLI's own default request timeout is 30s).
const cliTimeoutMs = Number(process.env.OPENCLAW_CRON_RUNNER_CLI_TIMEOUT_MS ?? 30_000);
// How many run-history entries to fetch per job (matches the CLI's own default of 50).
const runsFetchLimit = Math.max(1, Number(process.env.OPENCLAW_CRON_RUNNER_RUNS_FETCH_LIMIT ?? 50));
// Discovery guard threshold: if the gateway reports a managed job fired (lastRunAtMs in `cron
// list`) but the run stays invisible through `cron runs` for longer than this, health goes red
// and an alert fires - the exact silent-no-op class the 2026.7 migration caused.
const discoveryGapMs = Number(process.env.OPENCLAW_CRON_RUNNER_DISCOVERY_GAP_MS ?? 10 * 60_000);
// CLI discovery costs a real subprocess + gateway round-trip per cycle (the old file stat was
// ~free), and every managed job here is hourly or slower - 30s poll latency is irrelevant to
// them, so the default backs off from the file-era 5s.
const pollMs = Number(process.env.OPENCLAW_CRON_RUNNER_POLL_MS ?? 30_000);
const pnpmBin = process.env.PNPM_BIN ?? "pnpm";
const retryBaseMs = Number(process.env.OPENCLAW_CRON_RUNNER_RETRY_BASE_MS ?? 60_000);
const retryMaxMs = Number(process.env.OPENCLAW_CRON_RUNNER_RETRY_MAX_MS ?? 30 * 60_000);
// How long a per-run result JSON file (runtimeDir/<epochMs>-<job>.json) is kept before the sweep
// in pollOpenClawRunLogs() prunes it - these used to grow forever (task 5, item 7).
const resultRetentionMs = Number(process.env.OPENCLAW_CRON_RUNNER_RESULT_RETENTION_MS ?? 14 * 24 * 60 * 60 * 1000);
// Bounded grace period between SIGTERM and a forced SIGKILL for a timed-out job (audit item c): a
// child that ignores SIGTERM used to wedge that runKey forever (the timeout timer only ever sent
// ONE signal), since `child.on("exit")` above would then never fire.
const sigkillGraceMs = Number(process.env.OPENCLAW_CRON_RUNNER_SIGKILL_GRACE_MS ?? 10_000);
mkdirSync(runtimeDir, { recursive: true });
loadLocalEnv(repoRoot);

// `name` fields reference openclaw-cron-runner-state.mjs's CRON_JOB_* constants
// rather than re-typing "daily"/"weekly"/"stock-analysis" literals here - see
// that module's KNOWN_CRON_JOB_NAMES comment for the single-source rationale
// (task H1 fix: this object and KNOWN_CRON_JOB_NAMES used to hardcode the
// same strings independently, free to drift).
const allowedJobs = {
  "/run/daily": { name: CRON_JOB_DAILY, command: [pnpmBin, "report:daily:run"], timeoutMs: 15 * 60 * 1000 },
  "/run/weekly": { name: CRON_JOB_WEEKLY, command: [pnpmBin, "report:weekly:run"], timeoutMs: 15 * 60 * 1000 },
  "/run/stock-analysis": { name: CRON_JOB_STOCK_ANALYSIS, command: [pnpmBin, "stock-analysis:scheduled"], timeoutMs: 20 * 60 * 1000 },
  // 2026-07 audit fix: these two were registered in openclaw-cron-jobs.mjs (proposal-expiry sweep,
  // monthly per-owner review generation) but had no entry in cronJobNames below, so the runner's
  // poll filter silently dropped every run-log hit for them - they never executed.
  "/run/proposal-sweep": { name: CRON_JOB_PROPOSAL_SWEEP, command: [pnpmBin, "proposals:sweep"], timeoutMs: 2 * 60 * 1000 },
  "/run/monthly-review": { name: CRON_JOB_MONTHLY_REVIEW, command: [pnpmBin, "reviews:generate"], timeoutMs: 5 * 60 * 1000 }
};

const cronJobNames = {
  "openclaw-trading-daily-report": allowedJobs["/run/daily"],
  "openclaw-trading-weekly-report": allowedJobs["/run/weekly"],
  "openclaw-trading-stock-analysis": allowedJobs["/run/stock-analysis"],
  "openclaw-trading-proposal-sweep": allowedJobs["/run/proposal-sweep"],
  "openclaw-trading-monthly-review": allowedJobs["/run/monthly-review"]
};
// Set true by loadRunnerState() below when processed-runs.json existed but could not be trusted
// (corrupt/truncated) - in that case the fresh-boot reseed path below must ALSO run, exactly as
// if this were a brand-new install, instead of the (empty, wrong) recovered processedRunKeys list
// standing unseeded.
let recoveredFromCorruptState = false;
// Durable marker that the one-time "mark all CLI-visible history as already-processed" seeding
// pass has completed on THIS discovery interface. It is deliberately separate from
// processed-runs.json existing: on the deployed mini the state file predates the sqlite
// migration, so without this marker the first poll on the new interface would treat every
// historical gateway run (up to runsFetchLimit per job) as brand-new and fire a burst of stale
// reports. Seeding happens on the first successful poll cycle (not at import) so a gateway that
// is down at boot just delays it instead of half-completing it. Declared BEFORE the initial
// loadRunnerState() call because corrupt-state recovery inside it clears both of these.
const seedMarkerPath = join(runtimeDir, "cli-seed-completed.json");
let seedCompleted = false;
let runnerState = loadRunnerState();
const inFlightRunKeys = new Set();

seedCompleted = existsSync(seedMarkerPath) && existsSync(processedRunsPath) && !recoveredFromCorruptState;

// In-memory discovery-guard bookkeeping surfaced through getRunnerHealthSnapshot() / GET
// /health. Restart resets the gap timers - acceptable: a real gap re-accumulates within one
// threshold window.
const discoveryHealth = {
  lastListAt: null,
  lastListOk: null,
  lastListError: null,
  seedError: null,
  jobInterfaceErrors: {},
  // internal job name -> { sinceMs, openclawJobId, lastRunAtMs }
  gapSince: {},
  alertedGapJobs: new Set()
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);

  // Discovery-guard surface: 200 when discovery is healthy, 503 with the error list when the
  // runner cannot see what the gateway says it fired (or the CLI interface is failing) - so a
  // probe/doctor check turns the silent-no-op class into a visible red.
  if (request.method === "GET" && url.pathname === "/health") {
    const snapshot = getRunnerHealthSnapshot();
    sendJson(response, snapshot.ok ? 200 : 503, snapshot);
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

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
// side-effect-free beyond the harmless state load above (seeding runs inside the poll cycle, so
// no CLI subprocess is ever spawned at import), which tests sandbox via
// OPENCLAW_CRON_RUNNER_RUNTIME_DIR / OPENCLAW_BIN.
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
      discoveryInterface: "openclaw-cli",
      openclawBin,
      seedCompleted,
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
  // Same idea for the 1st-same-class-failure "notice" alert: before this task, a failed notice
  // send had no retry mechanism at all (only escalation did) and was lost forever.
  await retryPendingNoticeAlerts();
  // Per-run result JSON files (task 5, item 7): swept once per poll cycle rather than only at
  // startup, so a long-lived process doesn't need a restart to reclaim old files' disk space.
  pruneResultFiles(runtimeDir, resultRetentionMs);

  // Discovery goes through the gateway-backed CLI. A failing `cron list` aborts the cycle
  // LOUDLY (health + stderr) - before the 2026.7 fix the equivalent failure mode (reading files
  // that no longer existed) just looked like "no managed jobs" forever.
  let managedJobs;
  try {
    managedJobs = await readManagedCronJobs();
    discoveryHealth.lastListAt = new Date().toISOString();
    discoveryHealth.lastListOk = true;
    discoveryHealth.lastListError = null;
  } catch (error) {
    discoveryHealth.lastListAt = new Date().toISOString();
    discoveryHealth.lastListOk = false;
    discoveryHealth.lastListError = String(error?.message ?? error);
    console.error(JSON.stringify({
      ok: false,
      service: "openclaw-cron-runner",
      action: "cron-discovery-list-failed",
      openclawBin,
      error: discoveryHealth.lastListError
    }));
    return;
  }

  if (!seedCompleted) {
    try {
      await seedExistingOpenClawRuns(managedJobs);
      discoveryHealth.seedError = null;
    } catch (error) {
      discoveryHealth.seedError = String(error?.message ?? error);
      console.error(JSON.stringify({
        ok: false,
        service: "openclaw-cron-runner",
        action: "cron-discovery-seed-failed",
        error: discoveryHealth.seedError
      }));
    }
    // Never process run entries in the same cycle as (an attempt at) seeding: a half-observed
    // history must not turn into a replay burst. The next cycle runs normally (or retries the
    // seed if it failed).
    return;
  }

  for (const entry of managedJobs) {
    if (runnerState.jobFailureState[entry.job.name]?.halted) {
      // Halted jobs are operator territory (cron-runner-reset.mjs) - skip the per-job runs fetch
      // AND the guard: the runner not executing them is intentional, already escalated state.
      clearDiscoveryGap(entry.job.name);
      continue;
    }

    // Steady-state cost control: `cron list` already tells us the job's most recent run
    // (state.lastRunAtMs). Only pay for the per-job `cron runs` round-trip when that run is not
    // yet accounted for locally, or when a locally-failed run is awaiting its retry window. If a
    // future CLI keys entries differently (e.g. a runId that diverges from runAtMs), this gate
    // fails OPEN - the candidate never looks processed, so we fetch every cycle (wasteful, never
    // wrong). Note a gateway-side errored run also keeps this gate hot until the next successful
    // run replaces lastRunAtMs - matching the old semantics of never marking non-ok gateway runs
    // as processed.
    const candidateKey = entry.lastRunAtMs === null
      ? null
      : buildOpenClawRunKey({ jobId: entry.id, runAtMs: entry.lastRunAtMs, action: "finished" });
    const candidateUnprocessed = candidateKey !== null && !runnerState.processedRunKeys.includes(candidateKey);
    const hasPendingRetry = Object.keys(runnerState.failedRunAttempts).some((key) => key.startsWith(`${entry.id}:`));
    if (!candidateUnprocessed && !hasPendingRetry) {
      clearDiscoveryGap(entry.job.name);
      continue;
    }

    let runEntries;
    try {
      runEntries = await readCronRunEntries(entry.id);
      delete discoveryHealth.jobInterfaceErrors[entry.job.name];
    } catch (error) {
      discoveryHealth.jobInterfaceErrors[entry.job.name] = String(error?.message ?? error);
      console.error(JSON.stringify({
        ok: false,
        service: "openclaw-cron-runner",
        action: "cron-discovery-runs-failed",
        job: entry.job.name,
        openclawJobId: entry.id,
        error: discoveryHealth.jobInterfaceErrors[entry.job.name]
      }));
      // A run the gateway reports as fired that we cannot even LIST is the same blindness class
      // as it being absent - start/keep the gap clock.
      if (candidateUnprocessed) {
        noteDiscoveryGap(entry, Date.now());
      }
      continue;
    }

    // The guard itself: the gateway claims this job ran at lastRunAtMs; is that run visible
    // through the interface we execute from? Visibility is judged on the gateway's own record
    // (action "finished" at that runAtMs, regardless of its ok/error status or of our local
    // execution outcome) - the guard watches the INTERFACE, not job success.
    if (candidateUnprocessed) {
      const candidateVisible = runEntries.some((runEntry) =>
        runEntry.action === "finished" &&
        (Number(runEntry.runAtMs) === entry.lastRunAtMs || buildOpenClawRunKey(runEntry) === candidateKey));
      if (candidateVisible) {
        clearDiscoveryGap(entry.job.name);
      } else {
        noteDiscoveryGap(entry, Date.now());
      }
    } else {
      clearDiscoveryGap(entry.job.name);
    }

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
              runnerState = clearNoticePending(runnerState, entry.job.name);
              saveRunnerState();
            })
            .catch((error) => {
              // Leave noticePending set (recordRunResult above already set it true on this
              // 1st-same-class-failure transition): retryPendingNoticeAlerts() below will retry it
              // on the next poll cycle instead of this notice going silently unreported forever.
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

  await escalateExceededDiscoveryGaps(Date.now());
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

// Notice-level counterpart of retryPendingEscalationAlerts above: retries the 1st-same-class-
// failure "notice" alert for every job whose noticePending flag is still set (initial send
// failed, or the process died mid-send). `result` is reconstructed from the last known
// resultPath, same as the escalation retry - the original per-runKey `attempt` (nextRetryAt/
// attempts) isn't recoverable on a retry pass keyed only by job name, so `{}` is passed instead;
// buildCronFailureAlertMarkdown already degrades gracefully when `attempt.nextRetryAt` is absent.
async function retryPendingNoticeAlerts() {
  for (const { jobName, jobFailure } of getPendingNoticeJobs(runnerState)) {
    const result = (jobFailure.lastResultPath ? readJsonFile(jobFailure.lastResultPath, null) : null) ?? { job: jobName };
    try {
      await sendCronFailureAlert(result, {}, "notice");
      runnerState = clearNoticePending(runnerState, jobName);
      saveRunnerState();
    } catch (error) {
      console.error(JSON.stringify({
        ok: false,
        service: "openclaw-cron-runner",
        action: "notice-alert-retry",
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
  // Audit item c: SIGTERM alone can be ignored by the child (a hung network call in a signal
  // handler, a subprocess of its own swallowing the signal, ...) - without a bounded SIGKILL
  // fallback, that leaves this runKey's `exit` promise (and inFlightRunKeys' membership for it)
  // wedged forever, since `child.on("exit")` below then never fires. killTimer is only armed once
  // the timeout actually fires, and both timers are always cleared once the child truly exits.
  let killTimer;
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, sigkillGraceMs);
  }, job.timeoutMs);

  child.stdout?.on("data", (chunk) => chunks.stdout.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk) => chunks.stderr.push(Buffer.from(chunk)));

  const exit = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ code: null, signal: null, error }));
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  clearTimeout(killTimer);

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
  try {
    writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  } catch (error) {
    // Audit item b: the job already ran - `result` above correctly reflects its REAL exit
    // status - so this write failing (disk full, permission) must not be swallowed silently: it
    // means the retry/escalation machinery's `lastResultPath` lookups for this job will 404 later.
    // Escalate immediately (H1 principle: state that cannot persist = alert now), but still return
    // `result` so the caller's recordRunResult/saveRunnerState proceeds with the correct ok/not-ok
    // classification for this run instead of the whole poll cycle aborting over an artifact write.
    console.error(JSON.stringify({
      ok: false,
      service: "openclaw-cron-runner",
      action: "result-file-write-failed",
      job: job.name,
      resultPath,
      error: String(error?.message ?? error)
    }));
    await escalateStatePersistFailure("result-file-write-failed", error, { job: job.name, resultPath });
  }
  return result;
}

// Deletes per-run result JSON files (runtimeDir/<epochMs>-<jobName>.json, written by
// runAllowedJob above) older than `retentionMs` - these had NO retention policy before this task
// (task 5, item 7) and grew forever. Mirrors backup-trading-data.mjs's applyRetention: best-effort
// per file (one stubborn file doesn't abort the rest of the sweep), silently no-ops if `dir`
// doesn't exist yet.
export function pruneResultFiles(dir, retentionMs, now = Date.now()) {
  const deleted = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return deleted;
  }

  for (const entry of entries) {
    const match = /^(\d+)-.+\.json$/u.exec(entry);
    if (!match) {
      continue;
    }
    const stampMs = Number(match[1]);
    if (!Number.isFinite(stampMs) || now - stampMs <= retentionMs) {
      continue;
    }
    const filePath = join(dir, entry);
    try {
      rmSync(filePath, { force: true });
      deleted.push(filePath);
    } catch {
      // Best-effort: a stubborn file doesn't stop the rest of the sweep.
    }
  }
  return deleted;
}

// One-time (per discovery interface) bankruptcy pass: everything the gateway's run history
// already shows is marked processed WITHOUT executing it - those runs happened while this runner
// could not see them (or before it existed), and replaying up to runsFetchLimit stale
// reports/sweeps per job on first boot would be worse than skipping them. Only after ALL managed
// jobs' histories were fetched successfully does the durable marker get written - a partial
// observation must never masquerade as a completed seed.
async function seedExistingOpenClawRuns(managedJobs) {
  const keys = new Set(runnerState.processedRunKeys);
  for (const entry of managedJobs) {
    for (const runEntry of await readCronRunEntries(entry.id)) {
      keys.add(buildOpenClawRunKey(runEntry));
    }
  }
  runnerState = normalizeRunnerState({
    ...runnerState,
    processedRunKeys: Array.from(keys)
  });
  saveRunnerState();
  writeFileSync(
    seedMarkerPath,
    `${JSON.stringify({ seededAt: new Date().toISOString(), discoveryInterface: "openclaw-cli" }, null, 2)}\n`,
    "utf8"
  );
  seedCompleted = true;
  console.log(JSON.stringify({
    ok: true,
    service: "openclaw-cron-runner",
    action: "cron-discovery-seeded",
    jobs: managedJobs.length,
    processedRunKeys: keys.size
  }));
}

// Invokes the OpenClaw CLI (which talks to the running gateway) and parses its stdout as JSON.
// Any failure - spawn error, non-zero exit, timeout, non-JSON output - throws with enough
// context for health/stderr; callers decide whether that aborts the cycle (list) or degrades one
// job (runs).
function execOpenClawCronJson(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(openclawBin, args, {
      cwd: repoRoot,
      timeout: cliTimeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 32 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(new Error(
          `${openclawBin} ${args.join(" ")} failed: ${String(error?.message ?? error)}` +
          (stderr ? ` | stderr: ${tail(stderr)}` : "")
        ));
        return;
      }
      try {
        resolvePromise(JSON.parse(String(stdout)));
      } catch {
        rejectPromise(new Error(
          `${openclawBin} ${args.join(" ")} did not return JSON (CLI output drift?): ${String(stdout).slice(0, 300)}`
        ));
      }
    });
  });
}

// Managed-job discovery via `openclaw cron list --json`. Verified output shape on the deployed
// OpenClaw 2026.7.1-2: { jobs: [{ id, name, enabled, state: { lastRunAtMs, lastRunStatus, ... },
// ... }] }. Shape drift throws (doctor-style fail-loud -> cron-list-failed in health) instead of
// quietly becoming "zero managed jobs" - the exact silence that hid this bug for a month.
async function readManagedCronJobs() {
  const data = await execOpenClawCronJson(["cron", "list", "--json"]);
  if (!data || !Array.isArray(data.jobs)) {
    throw new Error(
      `${openclawBin} cron list --json: expected a top-level \`jobs\` array but got keys ` +
      `[${Object.keys(data ?? {}).join(", ")}] - the CLI output schema changed; update readManagedCronJobs().`
    );
  }
  return data.jobs
    .filter((job) => job?.enabled !== false && typeof job?.name === "string" && cronJobNames[job.name] && job?.id != null)
    .map((job) => {
      const lastRunAtMs = Number(job?.state?.lastRunAtMs ?? job?.lastRunAtMs);
      return {
        id: String(job.id),
        name: String(job.name),
        job: cronJobNames[job.name],
        lastRunAtMs: Number.isFinite(lastRunAtMs) ? lastRunAtMs : null,
        lastRunStatus: job?.state?.lastRunStatus ?? job?.lastRunStatus ?? null
      };
    });
}

// Run-history discovery via `openclaw cron runs --id <jobId>`. Verified output shape on the
// deployed OpenClaw 2026.7.1-2: { entries: [{ ts, jobId, action, status, runAtMs, ... }] } -
// the same entry fields the pre-migration runs/<id>.jsonl lines carried, so
// buildOpenClawRunKey() and the finished/ok filter are unchanged. Shape drift throws
// (cron-runs-failed[<job>] in health) rather than reading as an empty history.
async function readCronRunEntries(jobId) {
  const data = await execOpenClawCronJson(["cron", "runs", "--id", jobId, "--limit", String(runsFetchLimit)]);
  if (!data || !Array.isArray(data.entries)) {
    throw new Error(
      `${openclawBin} cron runs --id ${jobId}: expected a top-level \`entries\` array but got keys ` +
      `[${Object.keys(data ?? {}).join(", ")}] - the CLI output schema changed; update readCronRunEntries().`
    );
  }
  return data.entries.filter((entry) => entry && typeof entry === "object");
}

function noteDiscoveryGap(entry, nowMs) {
  const existing = discoveryHealth.gapSince[entry.job.name];
  if (existing) {
    existing.lastRunAtMs = entry.lastRunAtMs;
    return;
  }
  discoveryHealth.gapSince[entry.job.name] = {
    sinceMs: nowMs,
    openclawJobId: entry.id,
    lastRunAtMs: entry.lastRunAtMs
  };
}

function clearDiscoveryGap(jobName) {
  delete discoveryHealth.gapSince[jobName];
  discoveryHealth.alertedGapJobs.delete(jobName);
}

// The fail-loud guard's output surface (also served as GET /health): ok=false whenever the
// runner is in ANY state where gateway-fired managed jobs might silently not execute - the
// pre-fix runner sat in exactly such a state for a month reporting nothing.
export function getRunnerHealthSnapshot(nowMs = Date.now()) {
  const gaps = Object.entries(discoveryHealth.gapSince).map(([jobName, gap]) => ({
    jobName,
    openclawJobId: gap.openclawJobId,
    lastRunAtMs: gap.lastRunAtMs,
    missingForMs: nowMs - gap.sinceMs,
    exceededThreshold: nowMs - gap.sinceMs >= discoveryGapMs
  }));
  const errors = [];
  if (!seedCompleted) {
    errors.push(discoveryHealth.seedError ? `discovery-seed-pending: ${discoveryHealth.seedError}` : "discovery-seed-pending");
  }
  if (discoveryHealth.lastListOk === false) {
    errors.push(`cron-list-failed: ${discoveryHealth.lastListError}`);
  }
  for (const [jobName, message] of Object.entries(discoveryHealth.jobInterfaceErrors)) {
    errors.push(`cron-runs-failed[${jobName}]: ${message}`);
  }
  for (const gap of gaps) {
    if (gap.exceededThreshold) {
      errors.push(
        `cron-discovery-gap[${gap.jobName}]: gateway reports a run at ${gap.lastRunAtMs} for OpenClaw job ` +
        `${gap.openclawJobId}, but no matching entry has been visible via \`openclaw cron runs\` for ` +
        `${gap.missingForMs}ms - scheduled work is NOT executing.`
      );
    }
  }
  return {
    ok: errors.length === 0,
    service: "openclaw-cron-runner",
    discoveryInterface: "openclaw-cli",
    openclawBin,
    seedCompleted,
    lastListAt: discoveryHealth.lastListAt,
    lastListOk: discoveryHealth.lastListOk,
    gapThresholdMs: discoveryGapMs,
    gaps,
    errors
  };
}

// Escalates every discovery gap that has outlasted discoveryGapMs: loud stderr always, plus a
// Feishu alert (once per gap - cleared when the gap clears) unless alerts are disabled. A gap
// here means the gateway fired a managed job and the runner cannot see the run through its
// execution interface - left alone, that is a 100% silent no-op of a scheduled pipeline.
async function escalateExceededDiscoveryGaps(nowMs) {
  for (const [jobName, gap] of Object.entries(discoveryHealth.gapSince)) {
    if (nowMs - gap.sinceMs < discoveryGapMs || discoveryHealth.alertedGapJobs.has(jobName)) {
      continue;
    }
    console.error(JSON.stringify({
      ok: false,
      service: "openclaw-cron-runner",
      action: "cron-discovery-gap",
      job: jobName,
      openclawJobId: gap.openclawJobId,
      lastRunAtMs: gap.lastRunAtMs,
      missingForMs: nowMs - gap.sinceMs,
      note: "Gateway fired this managed job but the runner cannot see the run via `openclaw cron runs` - " +
        "the silent-no-op class this runner's discovery guard exists to catch."
    }));
    if (process.env.OPENCLAW_CRON_RUNNER_ALERTS === "0") {
      discoveryHealth.alertedGapJobs.add(jobName);
      continue;
    }
    try {
      const delivery = await deliverReportToFeishu({
        title: `OpenClaw cron-runner 发现盲区：${jobName}`,
        markdown: [
          "# OpenClaw cron-runner 发现盲区",
          "",
          `- 任务：${jobName}（OpenClaw job ${gap.openclawJobId}）`,
          `- 现象：gateway 显示该任务已在 ${new Date(gap.lastRunAtMs ?? nowMs).toISOString()} 触发，但 runner 通过 \`openclaw cron runs\` 持续 ${Math.round((nowMs - gap.sinceMs) / 60000)} 分钟看不到对应记录。`,
          "- 后果：该定时管线当前处于静默不执行状态（与 2026-07 sqlite 迁移导致的静默故障同类）。",
          "- 请检查：mini 上 OpenClaw 版本/存储是否又迁移、gateway 是否健康、runner 的 OPENCLAW_BIN 是否指向正确的 CLI。"
        ].join("\n"),
        maxSectionChars: 3600
      });
      if (delivery.sent) {
        discoveryHealth.alertedGapJobs.add(jobName);
      } else {
        console.error(JSON.stringify({
          ok: false,
          service: "openclaw-cron-runner",
          action: "cron-discovery-gap-alert-not-sent",
          job: jobName,
          reason: delivery.reason ?? null
        }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        ok: false,
        service: "openclaw-cron-runner",
        action: "cron-discovery-gap-alert-error",
        job: jobName,
        error: String(error?.message ?? error)
      }));
    }
  }
}

function buildOpenClawRunKey(entry) {
  return [
    String(entry.jobId ?? "unknown-job"),
    String(entry.runId ?? entry.runAtMs ?? entry.ts ?? "unknown-run"),
    String(entry.action ?? "unknown-action")
  ].join(":");
}

function loadRunnerState() {
  const { state, recovered } = loadRunnerStateFromFile(processedRunsPath, {
    onCorrupt: (error, backupPath) => {
      escalateStatePersistFailure("corrupt-state-file", error, {
        path: processedRunsPath,
        backupPath
      }).catch(() => {});
    }
  });
  if (recovered) {
    recoveredFromCorruptState = true;
    // Corrupt recovery invalidates the seed marker: the recovered processedRunKeys are empty, so
    // without a fresh seeding pass the next poll would treat every CLI-visible historical run as
    // new (the replay license the recovery exists to deny). Dropping the marker forces the
    // bankruptcy pass to run again - crash-safe, since the marker is only rewritten after a
    // FULLY successful seed.
    seedCompleted = false;
    rmSync(seedMarkerPath, { force: true });
    // Persist the recovered conservative state immediately (best-effort): otherwise every
    // subsequent loadRunnerState() re-reads the same corrupt bytes and repeats the whole
    // recovery (another backup file, another escalation) once per poll cycle. A failed write
    // here just means exactly that repeat happens - which is loud, not silent.
    try {
      writeRunnerStateAtomic(processedRunsPath, `${JSON.stringify(serializeRunnerState(state), null, 2)}\n`);
    } catch (persistError) {
      console.error(JSON.stringify({
        ok: false,
        service: "openclaw-cron-runner",
        action: "recovered-state-persist-failed",
        path: processedRunsPath,
        error: String(persistError?.message ?? persistError)
      }));
    }
  }
  return state;
}

// Audit item a: reads and normalizes processed-runs.json, but treats "the file exists and is
// unreadable/unparseable" as a FUNDAMENTALLY DIFFERENT situation from "the file has never
// existed". Before this task, both cases fell through readJsonFile's catch to the exact same
// `{ processedRunKeys: [] }` fallback - a truncated/corrupt file (a crash mid-write, before the
// atomic-write fix below existed) was silently treated as "nothing has ever run", which both (1)
// makes EVERY historical OpenClaw run look new again (full replay/re-delivery) and (2) resets
// jobFailureState to empty, silently un-halting any job that had been halted (exactly the
// auto-revival the task brief calls out).
//
// The conservative choice made here: state is UNKNOWN, so do NOT guess "nothing happened" (that
// license to replay is precisely the bug). Concretely:
//   - The corrupt file is preserved alongside (never deleted) so an operator can inspect what was
//     lost, and the failure is logged loudly + escalated through the alert channel.
//   - processedRunKeys comes back empty here, but `recovered: true` tells the caller to run the
//     SAME reseed path used for a brand-new install (seedExistingOpenClawRuns) - which treats
//     every run currently visible in OpenClaw's OWN run-log files (independent, unaffected by our
//     corruption) as already-accounted-for, rather than blindly replaying them.
//   - Every KNOWN job is forced into a halted state (a synthetic `__state_file_corrupt__` failure
//     class) instead of defaulting to "not halted" - if any job actually was halted before the
//     corruption, silently un-halting it would let it resume auto-retrying (and re-failing,
//     re-alerting) unsupervised. An operator must explicitly run cron-runner-reset.mjs per job
//     once they've verified it's safe, exactly like a real 3-strikes halt.
// Exported so this can be unit-tested directly against a real corrupt file on disk, independent of
// this module's own env-var-derived paths and ES module caching.
export function loadRunnerStateFromFile(path, { onCorrupt } = {}) {
  if (!existsSync(path)) {
    return { state: normalizeRunnerState({ processedRunKeys: [] }), recovered: false };
  }

  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return recoverCorruptRunnerStateFile(path, error, undefined, onCorrupt);
  }

  try {
    return { state: normalizeRunnerState(JSON.parse(raw)), recovered: false };
  } catch (error) {
    return recoverCorruptRunnerStateFile(path, error, raw, onCorrupt);
  }
}

function recoverCorruptRunnerStateFile(path, error, raw, onCorrupt) {
  const backupPath = `${path}.corrupt-${Date.now()}`;
  try {
    if (raw !== undefined) {
      writeFileSync(backupPath, raw, "utf8");
    } else {
      copyFileSyncBestEffort(path, backupPath);
    }
  } catch (backupError) {
    console.error(JSON.stringify({
      ok: false,
      service: "openclaw-cron-runner",
      action: "corrupt-state-backup-failed",
      path,
      error: String(backupError?.message ?? backupError)
    }));
  }

  console.error(JSON.stringify({
    ok: false,
    service: "openclaw-cron-runner",
    action: "corrupt-state-file",
    path,
    backupPath,
    error: String(error?.message ?? error),
    note: "processed-runs.json was unreadable/corrupt. Treating state as UNKNOWN: NOT replaying " +
      "history (existing OpenClaw run-log entries will be reseeded as already-processed, same as " +
      "a fresh install) and NOT auto-reviving any job - every known job is forced into a halted " +
      "state pending operator verification via cron-runner-reset.mjs."
  }));
  onCorrupt?.(error, backupPath);

  const forcedHaltedJobFailureState = Object.fromEntries(
    KNOWN_CRON_JOB_NAMES.map((jobName) => [jobName, {
      failureClass: "__state_file_corrupt__",
      consecutiveCount: HALT_THRESHOLD,
      halted: true,
      escalationPending: false,
      noticePending: false,
      lastResultPath: undefined
    }])
  );

  return {
    state: normalizeRunnerState({ processedRunKeys: [], jobFailureState: forcedHaltedJobFailureState }),
    recovered: true
  };
}

function copyFileSyncBestEffort(from, to) {
  writeFileSync(to, readFileSync(from));
}

function saveRunnerState() {
  const data = `${JSON.stringify(serializeRunnerState(runnerState), null, 2)}\n`;
  try {
    writeRunnerStateAtomic(processedRunsPath, data);
  } catch (error) {
    // Audit item b (H1 principle applied to the runner's own bookkeeping): a write failure here
    // (ENOSPC/EACCES) used to just throw out of saveRunnerState() uncaught, which - depending on
    // the call site - could crash an entire poll cycle. Worse, if it DIDN'T throw all the way out
    // (a caller swallowing it), the runner would carry on believing this cycle's
    // processed/failure/halt bookkeeping was durably saved when it wasn't - the exact "state that
    // cannot persist" scenario that must alert immediately instead of being silently swallowed.
    console.error(JSON.stringify({
      ok: false,
      service: "openclaw-cron-runner",
      action: "state-write-failed",
      path: processedRunsPath,
      error: String(error?.message ?? error)
    }));
    escalateStatePersistFailure("state-write-failed", error, { path: processedRunsPath }).catch(() => {});
  }
}

// Atomic tmp+rename write for processed-runs.json (audit item a): a crash mid-write used to be
// able to leave a half-written/truncated file - a rename is atomic at the filesystem level, so a
// crash can only ever leave the OLD file fully intact or the NEW one fully written, never a
// half-written one. Exported so the throwing behavior itself (the input saveRunnerState's
// try/catch above reacts to) has a direct, real unit test independent of this module's own
// env-var-derived paths.
export function writeRunnerStateAtomic(path, data) {
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, data, "utf8");
  renameSync(tmpPath, path);
}

// Shared escalation path for audit item b: any failure to persist the runner's OWN bookkeeping
// (state file or a per-run result file) is reported through the SAME Feishu alert channel job
// failures already use, instead of only ever reaching a stderr line no one is watching. Best
// effort in both directions (console.error always fires first; the Feishu send is additionally
// attempted and any failure of THAT is itself only logged, never thrown) - a persistence problem
// escalating must never itself crash the runner.
async function escalateStatePersistFailure(action, error, context = {}) {
  if (process.env.OPENCLAW_CRON_RUNNER_ALERTS === "0") {
    return;
  }
  try {
    const contextLines = Object.entries(context).map(([key, value]) => `- ${key}：${String(value)}`);
    const delivery = await deliverReportToFeishu({
      title: "OpenClaw cron-runner 状态持久化失败",
      markdown: [
        "# OpenClaw cron-runner 状态持久化失败",
        "",
        `- 动作：${action}`,
        `- 错误：${String(error?.message ?? error)}`,
        ...contextLines,
        "",
        "- 风险：runner 的去重/停机状态可能未落盘，重启后存在重复执行或漏记的风险，请尽快检查磁盘空间/文件权限。"
      ].join("\n"),
      maxSectionChars: 3600
    });
    if (!delivery.sent) {
      console.error(JSON.stringify({
        ok: false,
        service: "openclaw-cron-runner",
        action: "state-persist-failure-alert-not-sent",
        reason: delivery.reason ?? null
      }));
    }
  } catch (alertError) {
    console.error(JSON.stringify({
      ok: false,
      service: "openclaw-cron-runner",
      action: "state-persist-failure-alert-error",
      error: String(alertError?.message ?? alertError)
    }));
  }
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
export { pollOpenClawRunLogs, runAllowedJob };
export function __getRunnerStateForTest() {
  return runnerState;
}
