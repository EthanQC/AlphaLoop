#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";

import { repoRoot } from "./repo-root.mjs";

const openclawRoot = join(homedir(), ".openclaw");
const workspaceRoot = join(openclawRoot, "workspaces");
const dbPath = process.env.OPENCLAW_CONTEXT_DB ?? join(repoRoot, "runtime", "openclaw-context.sqlite");
const automationSnapshotPath = join(repoRoot, "runtime", "automation-inventory.json");
const knownAgents = ["control", "live-advisor", "paper-trader", "evolution"];
const relevantLaunchdPattern = /(openclaw|trading|codex|stock|longbridge|feishu)/iu;

const command = process.argv[2] ?? "help";
const args = process.argv.slice(3);

try {
  switch (command) {
    case "refresh-docs":
      printJson(refreshDocsWithMemoryIndex(parseArgs(args)));
      break;
    case "ingest-feishu-event":
      printJson(await ingestFeishuEvent());
      break;
    case "build-prompt-context":
      printJson(await buildPromptContext(parseArgs(args)));
      break;
    case "refresh-automation-inventory":
      printJson(refreshAutomationInventory());
      break;
    case "automation-summary":
      console.log(renderAutomationSummary(refreshAutomationInventory()));
      break;
    case "cleanup":
      printJson(cleanup(parseArgs(args)));
      break;
    case "maintenance":
      printJson(await maintenance(parseArgs(args)));
      break;
    case "help":
    default:
      console.log(`Usage: context-manager.mjs <command>

Commands:
  refresh-docs                   Refresh SQLite context docs, managed MEMORY.md files, and memory indexes.
  ingest-feishu-event            Read an OpenClaw Feishu event JSON object from stdin and store it.
  build-prompt-context [--json]  Build a compact prompt context from SQLite.
  refresh-automation-inventory   Read OpenClaw cron and relevant launchd jobs into SQLite.
  automation-summary             Print a human-readable automation inventory summary.
  cleanup [--days N]             Prune old volatile context.
  maintenance                    Run docs refresh, memory indexing, automation inventory, and cleanup.
`);
      break;
  }
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
}

async function maintenance(options) {
  const db = openDb();
  const id = `maintenance_${new Date().toISOString()}_${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  db.prepare(
    "INSERT INTO context_maintenance_runs (id, kind, started_at, status, details) VALUES (?, ?, ?, ?, ?)"
  ).run(id, "maintenance", startedAt, "running", "{}");

  try {
    const automations = refreshAutomationInventory({ db });
    const docs = refreshDocs({ db });
    const clean = cleanup({ ...options, db });
    const memoryIndex = reindexMemory(options);
    const details = { docs, automations, cleanup: clean, memoryIndex };
    db.prepare(
      "UPDATE context_maintenance_runs SET finished_at = ?, status = ?, details = ? WHERE id = ?"
    ).run(new Date().toISOString(), "ok", JSON.stringify(details), id);
    return { status: "ok", ...details };
  } catch (error) {
    db.prepare(
      "UPDATE context_maintenance_runs SET finished_at = ?, status = ?, details = ? WHERE id = ?"
    ).run(
      new Date().toISOString(),
      "error",
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      id
    );
    throw error;
  }
}

function refreshDocsWithMemoryIndex(options = {}) {
  const docs = refreshDocs();
  return { ...docs, memoryIndex: reindexMemory(options) };
}

function refreshDocs({ db = openDb() } = {}) {
  const now = new Date().toISOString();
  const docs = collectContextDocs();
  const upsert = db.prepare(`
    INSERT INTO context_documents
      (id, kind, agent_id, path, title, summary, content_hash, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      agent_id = excluded.agent_id,
      path = excluded.path,
      title = excluded.title,
      summary = excluded.summary,
      content_hash = excluded.content_hash,
      updated_at = excluded.updated_at
  `);

  for (const doc of docs) {
    upsert.run(
      doc.id,
      doc.kind,
      doc.agentId,
      doc.path,
      doc.title,
      doc.summary,
      doc.hash,
      now
    );
  }

  writeManagedMemoryFiles(db, now);
  return { status: "ok", documents: docs.length, dbPath };
}

function reindexMemory(options = {}) {
  if (options.skipMemoryIndex || options["skip-memory-index"] || process.env.OPENCLAW_CONTEXT_SKIP_MEMORY_INDEX === "1") {
    return { status: "skipped" };
  }

  const outputs = [];
  const agents = knownAgents.filter((agentId) => existsSync(join(workspaceRoot, agentId)));
  const attempts = [];
  let pendingAgents = agents;

  for (let attempt = 1; attempt <= 3 && pendingAgents.length > 0; attempt += 1) {
    sleepMs(attempt === 1 ? 500 : 1000);
    for (const agentId of pendingAgents) {
      const stdout = execFileSync("openclaw", ["memory", "index", "--agent", agentId, "--force"], {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120000
      });
      outputs.push(stdout);
    }

    const status = readMemoryStatus();
    pendingAgents = status
      .filter((entry) => agents.includes(entry.agentId) && entry.status?.dirty)
      .map((entry) => entry.agentId);
    attempts.push({ attempt, dirtyAfter: pendingAgents });
  }

  if (pendingAgents.length > 0) {
    throw new Error(`Memory index remained dirty for agent(s): ${pendingAgents.join(", ")}`);
  }

  return {
    status: "ok",
    command: "openclaw memory index --agent <id> --force",
    summary: outputs
      .join("\n")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("Memory index updated")),
    attempts
  };
}

function readMemoryStatus() {
  const stdout = execFileSync("openclaw", ["memory", "status", "--json"], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000
  });
  return JSON.parse(stdout);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function ingestFeishuEvent({ db = openDb() } = {}) {
  const input = await readStdinJson();
  const event = input.event ?? input;
  const ctx = input.ctx ?? {};
  const now = new Date().toISOString();
  const text = redactSensitive(cleanFeishuTextForStorage(extractMessageText(event, ctx)));
  const chatId = normalizeChatId(firstString(
    event.chatId,
    event.chat_id,
    event.conversationId,
    event.conversation_id,
    event.message?.chat_id,
    ctx.conversationId,
    ctx.conversation_id,
    ctx.chatId,
    ctx.chat_id,
    ctx.currentChannelId,
    ctx.toolContext?.currentChannelId,
    event.channelId,
    event.channel_id,
    event.target,
    ctx.channelId
  ));
  const sessionKey = firstString(ctx.sessionKey, event.sessionKey, event.session_key) ??
    (chatId ? `agent:control:feishu:group:${chatId}` : null);
  const senderId = firstString(
    event.senderId,
    event.sender_id,
    event.sender?.id,
    event.sender?.open_id,
    event.operatorId,
    ctx.senderId,
    ctx.from
  );
  const senderName = firstString(
    event.senderName,
    event.sender_name,
    event.sender?.name,
    ctx.senderName,
    ctx.fromName
  );
  const messageId = firstString(
    event.messageId,
    event.message_id,
    event.id,
    event.message?.message_id,
    ctx.messageId,
    ctx.message_id,
    extractMessageId(text),
    extractMessageId(event.body),
    extractMessageId(event.cleanedBody),
    extractMessageId(ctx.BodyForAgent),
    extractMessageId(ctx.Body),
    extractMessageId(extractMessageText(event, ctx))
  ) ?? `local_${sha256([sessionKey, senderId, text, now].filter(Boolean).join("|")).slice(0, 24)}`;
  const createdAt = normalizeTimestamp(
    firstString(event.createdAt, event.createTime, event.create_time, event.timestamp, event.message?.create_time)
  ) ?? now;
  const rawJson = truncate(redactSensitive(JSON.stringify({ event, ctx })), 12000);

  db.prepare(`
    INSERT INTO feishu_messages
      (message_id, chat_id, chat_type, session_key, sender_id, sender_name, text, created_at, received_at, raw_json)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET
      chat_id = COALESCE(excluded.chat_id, feishu_messages.chat_id),
      chat_type = COALESCE(excluded.chat_type, feishu_messages.chat_type),
      session_key = COALESCE(excluded.session_key, feishu_messages.session_key),
      sender_id = COALESCE(excluded.sender_id, feishu_messages.sender_id),
      sender_name = COALESCE(excluded.sender_name, feishu_messages.sender_name),
      text = CASE WHEN excluded.text != '' THEN excluded.text ELSE feishu_messages.text END,
      created_at = COALESCE(excluded.created_at, feishu_messages.created_at),
      received_at = excluded.received_at,
      raw_json = excluded.raw_json
  `).run(
    messageId,
    chatId,
    inferChatType(chatId, ctx, event),
    sessionKey,
    senderId,
    senderName,
    truncate(text, 4000),
    createdAt,
    now,
    rawJson
  );

  return { status: "ok", messageId, chatId, sessionKey, storedText: text.length > 0 };
}

async function buildPromptContext(options, { db = openDb() } = {}) {
  const input = options.stdin ? await readStdinJson({ optional: true }) : {};
  const event = input.event ?? {};
  const ctx = input.ctx ?? input.context ?? {};
  const agentId = firstString(options.agent, ctx.agentId, ctx.agent_id, inferAgentFromSession(ctx.sessionKey)) ?? "control";
  const sessionKey = firstString(options.sessionKey, options["session-key"], ctx.sessionKey, event.sessionKey);
  const chatId = firstString(
    options.chatId,
    options["chat-id"],
    ctx.chatId,
    ctx.channelId,
    ctx.currentChannelId,
    ctx.toolContext?.currentChannelId,
    event.chatId,
    event.channelId
  );
  const maxChars = Number(options.maxChars ?? options["max-chars"] ?? 3500);
  const docs = loadDocSummaries(db, agentId);
  const messages = loadRecentMessages(db, { chatId, sessionKey, limit: 12 });
  const automations = loadAutomationRows(db, 8);
  const text = truncate(renderPromptContext({
    agentId,
    sessionKey,
    chatId,
    docs,
    messages,
    automations
  }), maxChars);

  return options.json ? { status: "ok", text, stats: { docs: docs.length, messages: messages.length, automations: automations.length } } : { text };
}

function refreshAutomationInventory({ db = openDb() } = {}) {
  const now = new Date().toISOString();
  const rows = [
    ...readOpenClawCronRows(now),
    ...readLaunchdRows(now)
  ];
  const seen = new Set();
  const upsert = db.prepare(`
    INSERT INTO automation_inventory
      (id, source, label, enabled, schedule, command, state, last_run, details_json, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source = excluded.source,
      label = excluded.label,
      enabled = excluded.enabled,
      schedule = excluded.schedule,
      command = excluded.command,
      state = excluded.state,
      last_run = excluded.last_run,
      details_json = excluded.details_json,
      updated_at = excluded.updated_at
  `);

  for (const row of rows) {
    seen.add(row.id);
    upsert.run(
      row.id,
      row.source,
      row.label,
      row.enabled ? 1 : 0,
      row.schedule ?? "",
      row.command ?? "",
      row.state ?? "",
      row.lastRun ?? "",
      JSON.stringify(row.details ?? {}),
      now
    );
  }

  db.prepare("DELETE FROM automation_inventory WHERE source IN ('openclaw-cron', 'launchd') AND updated_at != ?").run(now);
  mkdirSync(dirname(automationSnapshotPath), { recursive: true });
  writeFileSync(automationSnapshotPath, `${JSON.stringify({ updatedAt: now, rows }, null, 2)}\n`, "utf8");
  writeManagedMemoryFiles(db, now);
  return { status: "ok", updatedAt: now, count: rows.length, rows, snapshotPath: automationSnapshotPath };
}

function cleanup(options = {}) {
  const db = options.db ?? openDb();
  const repaired = repairFeishuMessages(db);
  const volatileDays = Number(options.days ?? 45);
  const maintenanceDays = Number(options.maintenanceDays ?? 120);
  const volatileCutoff = new Date(Date.now() - volatileDays * 24 * 60 * 60 * 1000).toISOString();
  const maintenanceCutoff = new Date(Date.now() - maintenanceDays * 24 * 60 * 60 * 1000).toISOString();
  const messages = db.prepare("DELETE FROM feishu_messages WHERE received_at < ?").run(volatileCutoff).changes;
  const runs = db.prepare("DELETE FROM context_maintenance_runs WHERE started_at < ?").run(maintenanceCutoff).changes;
  const staleDocs = db.prepare("SELECT id, path FROM context_documents").all()
    .filter((row) => row.path && !existsSync(row.path));
  for (const row of staleDocs) {
    db.prepare("DELETE FROM context_documents WHERE id = ?").run(row.id);
  }
  db.exec("PRAGMA optimize");
  writeManagedMemoryFiles(db, new Date().toISOString());
  return { status: "ok", repairedMessages: repaired, prunedMessages: messages, prunedRuns: runs, prunedDocs: staleDocs.length };
}

function openDb() {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS context_documents (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      agent_id TEXT,
      path TEXT NOT NULL,
      title TEXT,
      summary TEXT,
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_context_documents_agent ON context_documents(agent_id, kind);
    CREATE TABLE IF NOT EXISTS feishu_messages (
      message_id TEXT PRIMARY KEY,
      chat_id TEXT,
      chat_type TEXT,
      session_key TEXT,
      sender_id TEXT,
      sender_name TEXT,
      text TEXT,
      created_at TEXT,
      received_at TEXT NOT NULL,
      raw_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_feishu_messages_chat ON feishu_messages(chat_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_feishu_messages_session ON feishu_messages(session_key, created_at);
    CREATE TABLE IF NOT EXISTS automation_inventory (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      label TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      schedule TEXT,
      command TEXT,
      state TEXT,
      last_run TEXT,
      details_json TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_automation_inventory_source ON automation_inventory(source, label);
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

function collectContextDocs() {
  const candidates = [];
  const sharedDir = join(repoRoot, "apps", "openclaw-config", "context", "shared");
  if (existsSync(sharedDir)) {
    for (const file of listMarkdownFiles(sharedDir)) {
      candidates.push({ path: file, kind: "shared", agentId: null });
    }
  }
  for (const agentId of knownAgents) {
    const agentContextDir = join(repoRoot, "apps", "openclaw-config", "context", agentId);
    if (existsSync(agentContextDir)) {
      for (const file of listMarkdownFiles(agentContextDir)) {
        candidates.push({ path: file, kind: "agent-context", agentId });
      }
    }
    const promptPath = join(repoRoot, "apps", "openclaw-config", "agents", `${agentId}.md`);
    if (existsSync(promptPath)) {
      candidates.push({ path: promptPath, kind: "agent-prompt", agentId });
    }
  }

  return candidates.map((entry) => {
    const content = redactSensitive(readFileSync(entry.path, "utf8"));
    const title = extractTitle(content) ?? basename(entry.path);
    return {
      ...entry,
      id: sha256(`${entry.kind}:${entry.agentId ?? "shared"}:${entry.path}`),
      title,
      summary: summarizeMarkdown(content),
      hash: sha256(content)
    };
  });
}

function writeManagedMemoryFiles(db, now) {
  const automations = loadAutomationRows(db, 10);
  for (const agentId of knownAgents) {
    const workspaceDir = join(workspaceRoot, agentId);
    if (!existsSync(workspaceDir)) {
      continue;
    }
    const docs = loadDocSummaries(db, agentId);
    const messages = agentId === "control" ? loadRecentMessages(db, { limit: 10 }) : [];
    const content = renderManagedMemory({ agentId, now, docs, messages, automations });
    writeFileSync(join(workspaceDir, "MEMORY.md"), renderManagedMemoryPointer(agentId, now), "utf8");
    const memoryDir = join(workspaceDir, "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "MEMORY.md"), content, "utf8");
  }
}

function renderManagedMemoryPointer(agentId, now) {
  return `# Managed Memory

This file is generated by \`apps/openclaw-config/scripts/context-manager.mjs\`.
The indexed long-term memory snapshot is \`memory/MEMORY.md\`.

Last updated: ${now}
Agent: ${agentId}
`;
}

function renderManagedMemory({ agentId, now, docs, messages, automations }) {
  const docLines = docs.slice(0, 10).map((doc) => `- ${doc.title}: ${singleLine(doc.summary, 260)}`);
  const messageLines = messages.map((message) => {
    const speaker = message.sender_name || message.sender_id || "Feishu";
    return `- ${formatDateish(message.created_at)} ${speaker}: ${singleLine(message.text, 220)}`;
  });
  const automationLines = automations.map((row) => {
    const state = row.enabled ? "enabled" : "disabled";
    return `- ${row.source} ${row.label}: ${state}; ${row.schedule || row.state || "no schedule"}`;
  });

  return `# Managed Memory

This file is generated by \`apps/openclaw-config/scripts/context-manager.mjs\`.
Do not write credentials, OAuth tokens, cookies, SSH private keys, or broker secrets here.

Last updated: ${now}
Agent: ${agentId}

## Long-Term Context

${docLines.length > 0 ? docLines.join("\n") : "- No local context documents indexed yet."}

## Recent Feishu Context

${messageLines.length > 0 ? messageLines.join("\n") : "- No recent Feishu messages stored in SQLite yet."}

## Automation Inventory

${automationLines.length > 0 ? automationLines.join("\n") : "- No OpenClaw cron or relevant launchd jobs indexed yet."}
`;
}

function renderPromptContext({ agentId, sessionKey, chatId, docs, messages, automations }) {
  const lines = [
    "## Local Context Memory",
    "Use this SQLite-backed context as recall aid only; it is not a trading ledger and may be incomplete.",
    `Agent: ${agentId}`,
    sessionKey ? `Session: ${sessionKey}` : null,
    chatId ? `Feishu chat: ${chatId}` : null,
    "",
    "### Identity And Operating Context",
    ...docs.slice(0, 8).map((doc) => `- ${doc.title}: ${singleLine(doc.summary, 220)}`),
    "",
    "### Recent Feishu Group Context",
    ...(messages.length > 0
      ? messages.map((message) => {
          const speaker = message.sender_name || message.sender_id || "Feishu";
          return `- ${formatDateish(message.created_at)} ${speaker}: ${singleLine(message.text, 240)}`;
        })
      : ["- No prior Feishu messages are stored for this chat/session yet."]),
    "",
    "### Automation Inventory",
    ...(automations.length > 0
      ? automations.map((row) => `- ${row.source} ${row.label}: ${row.enabled ? "enabled" : "disabled"}; ${row.schedule || row.state || "no schedule"}`)
      : ["- No OpenClaw cron or relevant launchd jobs are indexed yet."]),
    "",
    "### Safety",
    "- Never persist secrets into memory or reports.",
    "- Never submit live orders or activate rules without the explicit constitution-level confirmation."
  ].filter((line) => line !== null && line !== undefined);
  return `${lines.join("\n")}\n`;
}

function renderAutomationSummary(inventory) {
  const rows = inventory.rows ?? [];
  const openclawRows = rows.filter((row) => row.source === "openclaw-cron");
  const launchdRows = rows.filter((row) => row.source === "launchd");
  const lines = [
    `Automation inventory updated at ${inventory.updatedAt ?? new Date().toISOString()}`,
    `OpenClaw cron jobs: ${openclawRows.length}`,
    `Relevant launchd jobs: ${launchdRows.length}`,
    ""
  ];

  if (openclawRows.length > 0) {
    lines.push("OpenClaw cron:");
    for (const row of openclawRows) {
      lines.push(`- ${row.label}: ${row.enabled ? "enabled" : "disabled"}; ${row.schedule || row.state || "no schedule"}`);
    }
    lines.push("");
  }

  if (launchdRows.length > 0) {
    lines.push("launchd:");
    for (const row of launchdRows) {
      lines.push(`- ${row.label}: ${row.enabled ? "enabled" : "disabled"}; ${row.schedule || row.state || "no schedule"}; ${row.state || "unknown"}`);
    }
  }

  return lines.join("\n").trim();
}

function loadDocSummaries(db, agentId) {
  return db.prepare(`
    SELECT title, summary, kind, agent_id
    FROM context_documents
    WHERE agent_id IS NULL OR agent_id = ?
    ORDER BY
      CASE kind
        WHEN 'shared' THEN 0
        WHEN 'agent-context' THEN 1
        WHEN 'agent-prompt' THEN 2
        ELSE 9
      END,
      title
  `).all(agentId);
}

function loadRecentMessages(db, { chatId, sessionKey, limit = 12 } = {}) {
  const rows = chatId || sessionKey
    ? db.prepare(`
        SELECT *
        FROM feishu_messages
        WHERE (? IS NOT NULL AND chat_id = ?)
           OR (? IS NOT NULL AND session_key = ?)
        ORDER BY COALESCE(created_at, received_at) DESC
        LIMIT ?
      `).all(chatId ?? null, chatId ?? null, sessionKey ?? null, sessionKey ?? null, limit)
    : db.prepare(`
        SELECT *
        FROM feishu_messages
        ORDER BY COALESCE(created_at, received_at) DESC
        LIMIT ?
      `).all(limit);
  return rows.reverse();
}

function loadAutomationRows(db, limit = 10) {
  return db.prepare(`
    SELECT source, label, enabled, schedule, command, state, last_run, updated_at
    FROM automation_inventory
    ORDER BY source, label
    LIMIT ?
  `).all(limit).map((row) => ({ ...row, enabled: Boolean(row.enabled) }));
}

function readOpenClawCronRows(now) {
  const cronJobsPath = join(openclawRoot, "cron", "jobs.json");
  if (existsSync(cronJobsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(cronJobsPath, "utf8"));
      const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
      return jobs.map((job) => renderOpenClawCronRow(job, now));
    } catch {
      // Fall through to the CLI. The gateway can normalize legacy storage if needed.
    }
  }

  try {
    const stdout = execFileSync("openclaw", ["cron", "list", "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30000
    });
    const parsed = JSON.parse(stdout);
    const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : Array.isArray(parsed) ? parsed : [];
    return jobs.map((job) => renderOpenClawCronRow(job, now));
  } catch (error) {
    return [{
      id: "openclaw-cron:inventory-error",
      source: "openclaw-cron",
      label: "inventory-error",
      enabled: false,
      schedule: "",
      command: "openclaw cron list --json",
      state: "error",
      lastRun: "",
      details: { error: error instanceof Error ? error.message : String(error), observedAt: now }
    }];
  }
}

function renderOpenClawCronRow(job, now) {
  const label = String(job.name ?? job.id ?? "unnamed-openclaw-cron");
  const enabled = job.enabled !== false && job.status !== "disabled";
  return {
    id: `openclaw-cron:${label}`,
    source: "openclaw-cron",
    label,
    enabled,
    schedule: renderOpenClawSchedule(job),
    command: String(job.command ?? job.prompt ?? job.task ?? job.payload?.message ?? ""),
    state: String(job.status ?? job.lastStatus ?? ""),
    lastRun: String(job.lastRunAt ?? job.last_run_at ?? job.lastRun ?? ""),
    details: { ...job, observedAt: now }
  };
}

function renderOpenClawSchedule(job) {
  if (typeof job.schedule === "string") {
    return job.schedule;
  }
  if (job.schedule && typeof job.schedule === "object") {
    return [job.schedule.kind, job.schedule.expr, job.schedule.tz].filter(Boolean).join(" ");
  }
  return String(job.cron ?? job.frequency ?? "");
}

function readLaunchdRows(now) {
  const rows = [];
  const uid = process.getuid?.();
  const locations = [
    { domain: uid === undefined ? null : `gui/${uid}`, dir: join(homedir(), "Library", "LaunchAgents") },
    { domain: uid === undefined ? null : `gui/${uid}`, dir: "/Library/LaunchAgents" },
    { domain: "system", dir: "/Library/LaunchDaemons" }
  ];

  for (const location of locations) {
    if (!existsSync(location.dir)) {
      continue;
    }
    for (const fileName of readdirSync(location.dir)) {
      if (!fileName.endsWith(".plist")) {
        continue;
      }
      const filePath = join(location.dir, fileName);
      const plist = readPlistJson(filePath);
      if (!plist) {
        continue;
      }
      const label = String(plist.Label ?? basename(fileName, ".plist"));
      const command = renderProgramCommand(plist);
      const haystack = `${label}\n${command}\n${filePath}`;
      if (!relevantLaunchdPattern.test(haystack)) {
        continue;
      }
      const service = location.domain ? readLaunchdService(location.domain, label) : {};
      rows.push({
        id: `launchd:${label}`,
        source: "launchd",
        label,
        enabled: service.disabled === true ? false : true,
        schedule: renderLaunchdSchedule(plist),
        command,
        state: service.state ?? (service.loaded === false ? "unloaded" : "unknown"),
        lastRun: service.lastRun ?? "",
        details: {
          path: filePath,
          domain: location.domain,
          observedAt: now,
          runs: service.runs,
          lastExitCode: service.lastExitCode
        }
      });
    }
  }

  return rows;
}

function readPlistJson(filePath) {
  try {
    const stdout = execFileSync("plutil", ["-convert", "json", "-o", "-", filePath], {
      encoding: "utf8",
      timeout: 10000
    });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function readLaunchdService(domain, label) {
  const result = { loaded: true };
  try {
    const stdout = execFileSync("launchctl", ["print", `${domain}/${label}`], {
      encoding: "utf8",
      timeout: 10000
    });
    result.state = firstMatch(stdout, /^\s*state = (.+)$/mu);
    const runs = firstMatch(stdout, /^\s*runs = (\d+)$/mu);
    result.runs = runs ? Number(runs) : undefined;
    result.lastExitCode = firstMatch(stdout, /^\s*last exit code = (.+)$/mu);
    result.lastRun = firstMatch(stdout, /^\s*last spawn time = (.+)$/mu) ?? "";
  } catch {
    result.loaded = false;
    result.state = "unloaded";
  }

  try {
    const disabled = execFileSync("launchctl", ["print-disabled", domain], {
      encoding: "utf8",
      timeout: 10000
    });
    const match = disabled.match(new RegExp(`"${escapeRegExp(label)}"\\s*=>\\s*(true|false)`, "u"));
    if (match) {
      result.disabled = match[1] === "true";
    }
  } catch {
    // Some domains do not support print-disabled for the current user.
  }

  return result;
}

function renderProgramCommand(plist) {
  if (Array.isArray(plist.ProgramArguments)) {
    return plist.ProgramArguments.map((part) => String(part)).join(" ");
  }
  return String(plist.Program ?? "");
}

function renderLaunchdSchedule(plist) {
  if (plist.StartInterval) {
    return `every ${plist.StartInterval}s`;
  }
  if (plist.StartCalendarInterval) {
    const items = Array.isArray(plist.StartCalendarInterval)
      ? plist.StartCalendarInterval
      : [plist.StartCalendarInterval];
    return items.map((item) => {
      const parts = [];
      if (item.Weekday !== undefined) parts.push(`weekday=${item.Weekday}`);
      if (item.Hour !== undefined) parts.push(`hour=${item.Hour}`);
      if (item.Minute !== undefined) parts.push(`minute=${item.Minute}`);
      return parts.join(" ");
    }).join("; ");
  }
  if (plist.KeepAlive) {
    return "KeepAlive";
  }
  return "";
}

function extractMessageText(event, ctx) {
  const values = [
    event.content,
    event.text,
    event.message?.text,
    event.message?.content,
    event.cleanedBody,
    event.body,
    ctx.BodyForAgent,
    ctx.Body,
    ctx.CommandBody,
    ctx.RawBody
  ];
  for (const value of values) {
    const text = parsePossibleFeishuContent(value);
    if (text) {
      return text;
    }
  }
  return "";
}

function cleanFeishuTextForStorage(value) {
  const lines = String(value ?? "")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => !/^\[System:/u.test(line))
    .filter((line) => !/^\[message_id:\s*[^\]]+\]\s*$/iu.test(line));
  const first = lines[0] ?? "";
  if (/^ou_[A-Za-z0-9_:-]+:\s*/u.test(first)) {
    lines[0] = first.replace(/^ou_[A-Za-z0-9_:-]+:\s*/u, "");
  }
  return lines.join("\n").trim();
}

function extractMessageId(value) {
  const match = String(value ?? "").match(/\[message_id:\s*([^\]\s]+)\s*\]/iu);
  return match?.[1]?.trim() ?? null;
}

function normalizeChatId(value) {
  const text = String(value ?? "").trim();
  if (!text || text === "feishu") {
    return null;
  }
  return text;
}

function chatIdFromSessionKey(sessionKey) {
  const match = String(sessionKey ?? "").match(/^agent:[^:]+:feishu:group:([^:]+)(?::|$)/u);
  return match?.[1] ?? null;
}

function repairFeishuMessages(db) {
  let repaired = 0;
  const rows = db.prepare("SELECT message_id, chat_id, session_key, text FROM feishu_messages").all();
  for (const row of rows) {
    const nextMessageId = row.message_id.startsWith("local_") ? extractMessageId(row.text) : null;
    const nextChatId = normalizeChatId(row.chat_id) ?? chatIdFromSessionKey(row.session_key);
    const nextText = cleanFeishuTextForStorage(row.text);
    if (nextMessageId && nextMessageId !== row.message_id) {
      const existing = db.prepare("SELECT message_id FROM feishu_messages WHERE message_id = ?").get(nextMessageId);
      if (existing) {
        db.prepare("DELETE FROM feishu_messages WHERE message_id = ?").run(row.message_id);
        repaired += 1;
        continue;
      }
      db.prepare("UPDATE feishu_messages SET message_id = ? WHERE message_id = ?").run(nextMessageId, row.message_id);
      repaired += 1;
    }
    const currentId = nextMessageId && nextMessageId !== row.message_id ? nextMessageId : row.message_id;
    if ((nextChatId && nextChatId !== row.chat_id) || nextText !== row.text) {
      db.prepare("UPDATE feishu_messages SET chat_id = COALESCE(?, chat_id), text = ? WHERE message_id = ?")
        .run(nextChatId, nextText, currentId);
      repaired += 1;
    }
  }
  return repaired;
}

function parsePossibleFeishuContent(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    return flattenText(value).trim();
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return flattenText(JSON.parse(trimmed)).trim();
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function flattenText(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(flattenText).filter(Boolean).join(" ");
  }
  if (typeof value === "object") {
    const preferred = ["text", "content", "title", "name", "message"];
    const parts = [];
    for (const key of preferred) {
      if (value[key] !== undefined) {
        parts.push(flattenText(value[key]));
      }
    }
    if (parts.length === 0) {
      for (const entry of Object.values(value)) {
        const text = flattenText(entry);
        if (text) {
          parts.push(text);
        }
      }
    }
    return parts.filter(Boolean).join(" ");
  }
  return "";
}

function inferChatType(chatId, ctx, event) {
  const raw = firstString(ctx.chatType, ctx.chat_type, event.chatType, event.chat_type);
  if (raw) {
    return raw;
  }
  if (String(chatId ?? "").startsWith("oc_")) {
    return "group";
  }
  return null;
}

function inferAgentFromSession(sessionKey) {
  const match = String(sessionKey ?? "").match(/^agent:([^:]+)/u);
  return match?.[1];
}

function normalizeTimestamp(value) {
  if (!value) {
    return null;
  }
  const raw = String(value);
  if (/^\d+$/u.test(raw)) {
    const numeric = Number(raw);
    const millis = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    return new Date(millis).toISOString();
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function listMarkdownFiles(dir) {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => join(dir, file))
    .filter((file) => statSync(file).isFile());
}

function extractTitle(content) {
  const match = content.match(/^#\s+(.+)$/mu);
  return match?.[1]?.trim();
}

function summarizeMarkdown(content) {
  const cleaned = content
    .replace(/```[\s\S]*?```/gu, " ")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  return truncate(cleaned || content.replace(/\s+/gu, " ").trim(), 900);
}

function redactSensitive(value) {
  return String(value ?? "")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu, "[REDACTED_PRIVATE_KEY]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED_OPENAI_KEY]")
    .replace(/\bxox[abpr]-[A-Za-z0-9-]{16,}\b/gu, "[REDACTED_SLACK_TOKEN]")
    .replace(/\b(?:FEISHU|LARK|LONG_BRIDGE|LONGBRIDGE|OPENAI|ANTHROPIC|BROKER|OAUTH|ACCESS|REFRESH|SESSION|COOKIE|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|APP_SECRET)[A-Z0-9_ -]{0,32}(["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/giu, (match, sep) => {
      const key = match.slice(0, Math.max(0, match.indexOf(sep)));
      return `${key}${sep}[REDACTED]`;
    });
}

function parseArgs(values) {
  const out = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      continue;
    }
    const key = value.slice(2);
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

async function readStdinJson({ optional = false } = {}) {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    if (optional) {
      return {};
    }
    throw new Error("Expected JSON on stdin.");
  }
  return JSON.parse(raw);
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }
  return null;
}

function firstMatch(value, pattern) {
  const match = String(value ?? "").match(pattern);
  return match?.[1]?.trim();
}

function truncate(value, maxChars) {
  const text = String(value ?? "");
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text;
}

function singleLine(value, maxChars) {
  return truncate(String(value ?? "").replace(/\s+/gu, " ").trim(), maxChars);
}

function formatDateish(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toISOString().slice(0, 16).replace("T", " ");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
