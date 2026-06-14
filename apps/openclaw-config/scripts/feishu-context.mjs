#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadLocalEnv,
  openTradingDatabase
} from "../../../packages/shared-types/dist/index.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
loadLocalEnv(repoRoot);

const db = openTradingDatabase(join(repoRoot, "runtime", "trading.sqlite"));
ensureFeishuContextTables(db);

const [command = "build-prompt-context", ...args] = process.argv.slice(2);

if (command === "ingest-feishu-event") {
  const input = await readStdinJson();
  ingestFeishuEvent(input);
  console.log(JSON.stringify({ ok: true }));
} else if (command === "build-prompt-context") {
  const maxChars = readFlagNumber(args, "--max-chars", 3500);
  const input = args.includes("--stdin") ? await readStdinJson() : {};
  console.log(JSON.stringify({ text: buildPromptContext(input, maxChars) }));
} else {
  throw new Error("Usage: feishu-context.mjs <ingest-feishu-event|build-prompt-context> [--stdin] [--max-chars N]");
}

function ingestFeishuEvent(input) {
  const event = input?.event ?? {};
  const ctx = input?.ctx ?? {};
  const text = sanitizeText(firstString(
    event.text,
    event.content,
    event.message?.text,
    event.message?.content,
    event.raw?.text,
    event.raw?.content
  ));
  if (!text) {
    return;
  }

  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO feishu_context_messages
    (id, created_at, channel_id, chat_id, sender_id, sender_name, text)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    firstString(event.messageId, event.message_id, event.id) ?? `feishu_${Date.now()}`,
    now,
    firstString(event.channel, event.channelId, ctx.channelId) ?? "feishu",
    firstString(event.chatId, event.chat_id, event.chat?.id, ctx.chatId) ?? "",
    firstString(event.senderId, event.sender_id, event.sender?.id, ctx.senderId) ?? "",
    firstString(event.senderName, event.sender_name, event.sender?.name, ctx.senderName) ?? "",
    text
  );
}

function buildPromptContext(input, maxChars) {
  const insights = readInsights();
  const recent = db.prepare(`
    SELECT created_at, sender_name, text
    FROM feishu_context_messages
    ORDER BY created_at DESC
    LIMIT 12
  `).all();
  const currentText = sanitizeText(firstString(input?.event?.text, input?.event?.content));
  const lines = [
    "# 飞书炒股群上下文",
    "",
    "## 当前要求",
    "",
    "- 群内回复必须使用中文。",
    "- 功能边界只保留：日报/周报、个股分析、长桥官方模拟盘、被 @ 时答复。",
    "- 实盘订单永远不能自动提交；官方模拟盘最多使用总仓 10%。",
    "",
    "## 历史聊天提炼",
    "",
    insights,
    "",
    "## 最近群消息",
    "",
    ...recent.reverse().map((row) => `- ${formatShanghaiTime(row.created_at)} ${row.sender_name || "成员"}：${singleLine(row.text, 180)}`),
    ...(currentText ? ["", "## 当前消息", "", currentText] : [])
  ];

  return clampText(lines.join("\n"), maxChars);
}

function readInsights() {
  const path = join(repoRoot, "knowledge", "notes", "stock-trading-notes", "feishu-history-insights.md");
  if (!existsSync(path)) {
    return "- 已读取飞书历史，但本地提炼文件暂缺。";
  }
  return readFileSync(path, "utf8").trim();
}

function ensureFeishuContextTables(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS feishu_context_messages (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS feishu_context_messages_time_idx
      ON feishu_context_messages(created_at);
  `);
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

function readFlagNumber(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  if (index < 0) {
    return fallback;
  }
  const value = Number(argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function sanitizeText(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gu, "Bearer [REDACTED]")
    .replace(/(token|secret|password|authorization)=?[^\s，。；]*/giu, "$1=[REDACTED]")
    .replace(/\s+/gu, " ")
    .trim();
}

function singleLine(value, maxChars) {
  const text = sanitizeText(value);
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}...` : text;
}

function clampText(value, maxChars) {
  const text = String(value ?? "");
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function formatShanghaiTime(value) {
  const timestamp = new Date(String(value ?? "")).getTime();
  if (!Number.isFinite(timestamp)) {
    return "时间不可用";
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(timestamp));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`;
}
