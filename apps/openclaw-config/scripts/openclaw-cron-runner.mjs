#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const port = Number(process.env.OPENCLAW_CRON_RUNNER_PORT ?? 18792);
const host = "127.0.0.1";
const runtimeDir = join(repoRoot, "runtime", "openclaw-cron-runner");
const processedRunsPath = join(runtimeDir, "processed-runs.json");
const openclawCronDir = process.env.OPENCLAW_CRON_DIR ?? join(homedir(), ".openclaw", "cron");
const pollMs = Number(process.env.OPENCLAW_CRON_RUNNER_POLL_MS ?? 5000);
const pnpmBin = process.env.PNPM_BIN ?? "pnpm";
mkdirSync(runtimeDir, { recursive: true });

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
const processedRunKeys = loadProcessedRunKeys();
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

async function pollOpenClawRunLogs() {
  const managedJobs = readManagedCronJobs();
  for (const entry of managedJobs) {
    const runEntries = readCronRunEntries(entry.id);
    for (const runEntry of runEntries) {
      if (runEntry.action !== "finished" || runEntry.status !== "ok") {
        continue;
      }
      const runKey = buildOpenClawRunKey(runEntry);
      if (processedRunKeys.has(runKey) || inFlightRunKeys.has(runKey)) {
        continue;
      }
      inFlightRunKeys.add(runKey);
      try {
        await runAllowedJob(entry.job, {
          trigger: "openclaw-cron-run-log",
          openclawJobId: entry.id,
          openclawJobName: entry.name,
          openclawRunId: runEntry.runId ?? null,
          openclawRunAtMs: runEntry.runAtMs ?? null
        });
      } finally {
        inFlightRunKeys.delete(runKey);
        processedRunKeys.add(runKey);
        saveProcessedRunKeys();
      }
    }
  }
}

async function runAllowedJob(job, context = {}) {
  const startedAt = new Date().toISOString();
  const [cmd, ...args] = job.command;
  const child = spawn(cmd, args, {
    cwd: repoRoot,
    env: process.env,
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
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr)
  };
  writeFileSync(join(runtimeDir, `${Date.now()}-${job.name}.json`), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

function seedExistingOpenClawRuns() {
  for (const entry of readManagedCronJobs()) {
    for (const runEntry of readCronRunEntries(entry.id)) {
      processedRunKeys.add(buildOpenClawRunKey(runEntry));
    }
  }
  saveProcessedRunKeys();
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

function loadProcessedRunKeys() {
  const data = readJsonFile(processedRunsPath, { processedRunKeys: [] });
  return new Set(Array.isArray(data.processedRunKeys) ? data.processedRunKeys.map(String) : []);
}

function saveProcessedRunKeys() {
  const values = Array.from(processedRunKeys).slice(-1000);
  writeFileSync(processedRunsPath, `${JSON.stringify({ processedRunKeys: values }, null, 2)}\n`, "utf8");
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
