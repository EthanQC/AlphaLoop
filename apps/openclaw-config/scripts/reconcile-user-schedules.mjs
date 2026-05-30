#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const runtimeDir = join(repoRoot, "runtime");
const dbPath = process.env.OPENCLAW_CONTEXT_DB ?? join(runtimeDir, "openclaw-context.sqlite");
const reportStatePath = join(runtimeDir, "report-delivery-state.json");
const maintenanceStatePath = join(runtimeDir, "maintenance-state.json");
const timezone = process.env.TRADING_TIMEZONE ?? "Asia/Shanghai";
const nodeBin = process.execPath;

const command = process.argv[2]?.startsWith("--") ? "run" : process.argv[2] ?? "run";
const args = process.argv.slice(command === "run" ? 2 : 3);
const options = parseArgs(args);

try {
  switch (command) {
    case "run":
      {
        const result = reconcile(options);
        printJson(options.verbose ? result : compactRunResult(result));
      }
      break;
    case "status":
      printJson(status());
      break;
    case "help":
    default:
      console.log(`Usage: reconcile-user-schedules.mjs [run|status] [options]

Options:
  --dry-run                 Print catch-up plan without running commands or writing the ledger.
  --backfill                On the first run, catch up missed tasks from the lookback window.
  --lookback-days N         Maximum catch-up lookback window. Defaults to 14.
  --max-attempts N          Retry failed catch-up occurrences up to N times. Defaults to 5.
  --now YYYY-MM-DDTHH:mm:ss Override current time for tests.
  --verbose                 Print full planned/executed/skipped detail.
`);
  }
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
}

function reconcile(runOptions = {}) {
  mkdirSync(runtimeDir, { recursive: true });
  const dryRun = Boolean(runOptions.dryRun || runOptions["dry-run"]);
  const now = runOptions.now ? new Date(String(runOptions.now)) : new Date();
  const lookbackDays = Number(runOptions.lookbackDays ?? runOptions["lookback-days"] ?? 14);
  const maxAttempts = Number(runOptions.maxAttempts ?? runOptions["max-attempts"] ?? 5);
  assertValidDate(now, "now");

  const db = openDb();
  const initializedAt = getState(db, "catchup_initialized_at");
  const firstRun = !initializedAt;
  const shouldBackfill = Boolean(runOptions.backfill);

  if (firstRun && !shouldBackfill) {
    if (!dryRun) {
      setState(db, "catchup_initialized_at", now.toISOString());
      setState(db, "catchup_last_checked_at", now.toISOString());
    }
    return {
      status: dryRun ? "would-initialize" : "initialized",
      initializedAt: now.toISOString(),
      catchupPerformed: false,
      reason: "first run establishes the baseline so old historical tasks are not flooded into Feishu"
    };
  }

  const baseline = initializedAt ? new Date(initializedAt) : new Date(now.getTime() - lookbackDays * 86400000);
  const lookbackStart = new Date(now.getTime() - lookbackDays * 86400000);
  const from = new Date(Math.max(baseline.getTime(), lookbackStart.getTime()));
  const tasks = buildTasks();
  const occurrences = tasks
    .flatMap((task) => task.occurrences(from, now).map((scheduledAt) => ({ task, scheduledAt })))
    .filter(({ task, scheduledAt }) => scheduledAt.getTime() + task.graceMs <= now.getTime())
    .sort((left, right) => {
      const diff = left.scheduledAt.getTime() - right.scheduledAt.getTime();
      return diff === 0 ? left.task.order - right.task.order : diff;
    });

  const planned = [];
  const executed = [];
  const skipped = [];
  const failed = [];

  for (const occurrence of occurrences) {
    const occurrenceId = getOccurrenceId(occurrence.task.id, occurrence.scheduledAt);
    const existing = getRun(db, occurrenceId);
    if (existing && ["success", "skipped"].includes(existing.status)) {
      if (occurrence.task.revalidateCompleted) {
        const done = occurrence.task.done(occurrence.scheduledAt);
        if (done.done) {
          skipped.push(toPlan(occurrence, "ledger-already-complete"));
          continue;
        }
        // Older catch-up ledgers predate report completeness markers. Re-run
        // the occurrence instead of trusting stale success/skipped rows.
      } else {
        skipped.push(toPlan(occurrence, "ledger-already-complete"));
        continue;
      }
    }
    if (existing?.status === "failed" && existing.attempts >= maxAttempts) {
      skipped.push(toPlan(occurrence, "max-attempts-reached"));
      continue;
    }
    const done = occurrence.task.done(occurrence.scheduledAt);
    if (done.done) {
      const plan = toPlan(occurrence, done.reason);
      skipped.push(plan);
      if (!dryRun) {
        upsertRun(db, {
          id: occurrenceId,
          occurrence,
          status: "skipped",
          attempts: existing?.attempts ?? 0,
          reason: done.reason,
          command: "",
          stdout: "",
          stderr: ""
        });
      }
      continue;
    }

    const commandSpec = occurrence.task.command(occurrence.scheduledAt);
    const plan = toPlan(occurrence, "missed", commandSpec);
    planned.push(plan);
    if (dryRun) {
      continue;
    }

    const attempts = (existing?.attempts ?? 0) + 1;
    const startedAt = new Date().toISOString();
    const result = spawnSync(commandSpec.bin, commandSpec.args, {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      timeout: occurrence.task.timeoutMs
    });
    const finishedAt = new Date().toISOString();
    const ok = result.status === 0 && !result.error;
    const row = {
      id: occurrenceId,
      occurrence,
      status: ok ? "success" : "failed",
      attempts,
      reason: ok ? "catchup-ran" : result.error?.message ?? `exit status ${result.status}`,
      command: renderCommand(commandSpec),
      stdout: redactAndTrim(result.stdout),
      stderr: redactAndTrim(result.stderr),
      startedAt,
      finishedAt
    };
    upsertRun(db, row);
    if (ok) {
      executed.push({ ...plan, attempts, startedAt, finishedAt });
    } else {
      failed.push({ ...plan, attempts, error: row.reason, stderr: row.stderr });
    }
  }

  if (!dryRun) {
    setState(db, "catchup_last_checked_at", now.toISOString());
  }

  return {
    status: failed.length > 0 ? "error" : "ok",
    dryRun,
    from: from.toISOString(),
    now: now.toISOString(),
    planned,
    executed,
    skipped,
    failed,
    totals: {
      occurrences: occurrences.length,
      planned: planned.length,
      executed: executed.length,
      skipped: skipped.length,
      failed: failed.length
    }
  };
}

function status() {
  const db = openDb();
  const rows = db.prepare(`
    SELECT task_id, scheduled_at, status, attempts, reason, updated_at
    FROM automation_catchup_runs
    ORDER BY scheduled_at DESC
    LIMIT 50
  `).all();
  return {
    initializedAt: getState(db, "catchup_initialized_at"),
    lastCheckedAt: getState(db, "catchup_last_checked_at"),
    recentRuns: rows
  };
}

function compactRunResult(result) {
  const planned = Array.isArray(result.planned) ? result.planned : [];
  const skipped = Array.isArray(result.skipped) ? result.skipped : [];
  return {
    status: result.status,
    dryRun: result.dryRun,
    from: result.from,
    now: result.now,
    totals: result.totals,
    executed: result.executed ?? [],
    failed: result.failed ?? [],
    planned: result.dryRun ? planned : planned.slice(0, 20),
    skippedCount: skipped.length
  };
}

function buildTasks() {
  const marketWeekdays = new Set([1, 2, 3, 4, 5]);
  return [
    reportTask({
      id: "report.daily.prepare",
      label: "OpenClaw daily report prepare",
      kind: "daily",
      action: "prepare",
      hour: 19,
      minute: 0,
      weekdays: marketWeekdays,
      order: 10
    }),
    reportTask({
      id: "report.daily.deliver",
      label: "OpenClaw daily report deliver",
      kind: "daily",
      action: "deliver",
      hour: 20,
      minute: 0,
      weekdays: marketWeekdays,
      order: 20
    }),
    reportTask({
      id: "report.weekly.prepare",
      label: "OpenClaw weekly report prepare",
      kind: "weekly",
      action: "prepare",
      hour: 19,
      minute: 0,
      weekdays: new Set([1]),
      order: 30
    }),
    reportTask({
      id: "report.weekly.deliver",
      label: "OpenClaw weekly report deliver",
      kind: "weekly",
      action: "deliver",
      hour: 20,
      minute: 0,
      weekdays: new Set([1]),
      order: 40
    }),
    {
      id: "maintenance.latest",
      label: "OpenClaw daily maintenance check",
      order: 50,
      graceMs: 10 * 60 * 1000,
      timeoutMs: 180000,
      occurrences: (from, now) => calendarOccurrences({ from, now, hour: 9, minute: 10 }),
      done: (scheduledAt) => {
        const state = readJson(maintenanceStatePath);
        const completedAt = parseOptionalDate(state?.completedAt ?? state?.checkedAt);
        return completedAt && completedAt >= scheduledAt
          ? { done: true, reason: "maintenance-already-completed" }
          : { done: false };
      },
      command: () => ({
        bin: nodeBin,
        args: ["apps/openclaw-config/scripts/maintenance-check.mjs"]
      })
    },
    {
      id: "context.maintenance",
      label: "OpenClaw context and memory maintenance",
      order: 60,
      graceMs: 5 * 60 * 1000,
      timeoutMs: 240000,
      occurrences: (from, now) => hourlyMinuteOccurrences(from, now, 20),
      done: (scheduledAt) => {
        const db = openDb();
        const row = db.prepare(`
          SELECT COUNT(*) AS count
          FROM context_maintenance_runs
          WHERE kind = 'maintenance'
            AND status = 'ok'
            AND started_at >= ?
        `).get(scheduledAt.toISOString());
        return Number(row?.count ?? 0) > 0
          ? { done: true, reason: "context-maintenance-already-completed" }
          : { done: false };
      },
      command: () => ({
        bin: nodeBin,
        args: ["--no-warnings", "apps/openclaw-config/scripts/context-manager.mjs", "maintenance"]
      })
    }
  ];
}

function reportTask({ id, label, kind, action, hour, minute, weekdays, order }) {
  return {
    id,
    label,
    order,
    revalidateCompleted: action === "prepare",
    graceMs: 10 * 60 * 1000,
    timeoutMs: 240000,
    occurrences: (from, now) => calendarOccurrences({ from, now, hour, minute, weekdays }),
    done: (scheduledAt) => {
      const dateLabel = localDateLabel(scheduledAt);
      const reportState = readJson(reportStatePath);
      const entry = reportState?.[`${kind}:${dateLabel}`] ?? {};
      if (entry.archivedAt) {
        return { done: true, reason: "report-archived" };
      }
      const reportPath = join(repoRoot, "reports", kind, `${dateLabel}.md`);
      if (action === "prepare") {
        return isReportStatePrepared(entry) || isReportPrepared(reportPath)
          ? { done: true, reason: "report-already-prepared" }
          : { done: false };
      }
      return entry.deliveredAt
        ? { done: true, reason: "report-already-delivered" }
        : { done: false };
    },
    command: (scheduledAt) => {
      const dateLabel = localDateLabel(scheduledAt);
      const reportPath = join(repoRoot, "reports", kind, `${dateLabel}.md`);
      const commandAction = action === "deliver" && !existsSync(reportPath) ? "run" : action;
      return {
        bin: nodeBin,
        args: ["apps/openclaw-config/scripts/scheduled-report.mjs", kind, commandAction, dateLabel]
      };
    }
  };
}

function isReportStatePrepared(entry) {
  return Boolean(
    entry?.preparedAt
    && entry?.requiredDataSources?.officialPaperSnapshot
    && entry?.requiredDataSources?.marketNews
    && entry?.requiredDataSources?.macroCalendar
    && entry?.requiredDataSources?.qqqQuote
  );
}

function isReportPrepared(reportPath) {
  if (!existsSync(reportPath)) {
    return false;
  }
  try {
    const markdown = readFileSync(reportPath, "utf8");
    return [
      "长桥官方模拟盘",
      "长桥新闻",
      "宏观日历",
      "长桥行情",
      "QQQ 行情"
    ].every((marker) => markdown.includes(marker));
  } catch {
    return false;
  }
}

function calendarOccurrences({ from, now, hour, minute, weekdays = null }) {
  const out = [];
  for (const label of dateLabelsBetween(from, now)) {
    const weekday = weekdayNumber(label);
    if (weekdays && !weekdays.has(weekday)) {
      continue;
    }
    const scheduledAt = localDateTime(label, hour, minute);
    if (scheduledAt > from && scheduledAt <= now) {
      out.push(scheduledAt);
    }
  }
  return out;
}

function hourlyMinuteOccurrences(from, now, minute) {
  const out = [];
  const cursor = new Date(from);
  cursor.setUTCMinutes(minute, 0, 0);
  if (cursor <= from) {
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }
  while (cursor <= now) {
    out.push(new Date(cursor));
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }
  return out;
}

function dateLabelsBetween(from, now) {
  const labels = [];
  const cursor = parseDateLabel(localDateLabel(from));
  const end = parseDateLabel(localDateLabel(now));
  while (cursor <= end) {
    labels.push(formatUtcDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return labels;
}

function localDateLabel(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function localDateTime(label, hour, minute) {
  return new Date(`${label}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`);
}

function weekdayNumber(label) {
  const day = parseDateLabel(label).getUTCDay();
  return day === 0 ? 7 : day;
}

function parseDateLabel(label) {
  const [year, month, day] = label.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatUtcDate(date) {
  return date.toISOString().slice(0, 10);
}

function openDb() {
  mkdirSync(runtimeDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_catchup_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS automation_catchup_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      label TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      command TEXT,
      stdout TEXT,
      stderr TEXT,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_automation_catchup_runs_task
      ON automation_catchup_runs(task_id, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_automation_catchup_runs_status
      ON automation_catchup_runs(status, scheduled_at);
    CREATE TABLE IF NOT EXISTS context_maintenance_runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      details TEXT
    );
  `);
  return db;
}

function getState(db, key) {
  return db.prepare("SELECT value FROM automation_catchup_state WHERE key = ?").get(key)?.value ?? null;
}

function setState(db, key, value) {
  db.prepare(`
    INSERT INTO automation_catchup_state (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, value, new Date().toISOString());
}

function getRun(db, id) {
  return db.prepare("SELECT status, attempts FROM automation_catchup_runs WHERE id = ?").get(id) ?? null;
}

function upsertRun(db, row) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO automation_catchup_runs
      (id, task_id, label, scheduled_at, status, attempts, reason, command, stdout, stderr, started_at, finished_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      attempts = excluded.attempts,
      reason = excluded.reason,
      command = excluded.command,
      stdout = excluded.stdout,
      stderr = excluded.stderr,
      started_at = excluded.started_at,
      finished_at = excluded.finished_at,
      updated_at = excluded.updated_at
  `).run(
    row.id,
    row.occurrence.task.id,
    row.occurrence.task.label,
    row.occurrence.scheduledAt.toISOString(),
    row.status,
    row.attempts,
    row.reason,
    row.command,
    row.stdout,
    row.stderr,
    row.startedAt ?? null,
    row.finishedAt ?? null,
    now
  );
}

function toPlan(occurrence, reason, commandSpec = null) {
  return {
    taskId: occurrence.task.id,
    label: occurrence.task.label,
    scheduledAt: occurrence.scheduledAt.toISOString(),
    localDate: localDateLabel(occurrence.scheduledAt),
    reason,
    command: commandSpec ? renderCommand(commandSpec) : undefined
  };
}

function getOccurrenceId(taskId, scheduledAt) {
  return createHash("sha256").update(`${taskId}|${scheduledAt.toISOString()}`).digest("hex");
}

function renderCommand(commandSpec) {
  return [commandSpec.bin, ...commandSpec.args].map((part) => shellQuote(part)).join(" ");
}

function shellQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:=@+-]+$/u.test(text) ? text : `'${text.replace(/'/gu, "'\\''")}'`;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function parseOptionalDate(value) {
  if (!value) {
    return null;
  }
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}

function redactAndTrim(value) {
  return String(value ?? "")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu, "[REDACTED_PRIVATE_KEY]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED_OPENAI_KEY]")
    .replace(/\b(?:FEISHU|LARK|LONG_BRIDGE|LONGBRIDGE|OPENAI|ANTHROPIC|BROKER|OAUTH|ACCESS|REFRESH|SESSION|COOKIE|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|APP_SECRET)[A-Z0-9_ -]{0,32}(["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/giu, (match, sep) => {
      const key = match.slice(0, Math.max(0, match.indexOf(sep)));
      return `${key}${sep}[REDACTED]`;
    })
    .slice(0, 12000);
}

function assertValidDate(date, name) {
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${name} is not a valid date`);
  }
}

function parseArgs(values) {
  const out = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      continue;
    }
    const key = value.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    const next = values[index + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      index += 1;
    }
  }
  return out;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
