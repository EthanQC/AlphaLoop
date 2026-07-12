import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  NotificationTargetRepository,
  openTradingDatabase
} from "./database.js";
import { resolveRepoRoot, resolveRuntimePaths } from "./runtime.js";

export interface NotificationPayload {
  title: string;
  body: string;
  format?: "text" | "post";
}

export type NotificationDeliveryTarget =
  | "feishu-user-plugin-bot-text"
  | "feishu-user-plugin-bot-post"
  | "feishu-user-plugin-bot-file"
  | "feishu-webhook"
  | "feishu-app-open-id"
  | "feishu-app-chat-id"
  | "none";

export interface NotificationResult {
  sent: boolean;
  target: NotificationDeliveryTarget;
  reason?: string;
  fallback?: boolean;
  primaryError?: string;
  detail?: string;
}

export interface NotificationReadiness {
  enabled: boolean;
  target: NotificationDeliveryTarget;
  reason?: string;
}

export interface ReportDeliveryPayload {
  title: string;
  markdown: string;
  markdownPath?: string;
  pdfPath?: string;
  maxSectionChars?: number;
}

export interface ReportDeliveryEntry {
  kind: "summary" | "chapter" | "file";
  title: string;
  target: NotificationDeliveryTarget;
  sent: boolean;
  fallback?: boolean;
  detail?: string;
  reason?: string;
  primaryError?: string;
  chapter?: number;
  part?: number;
  parts?: number;
}

export interface ReportDeliveryResult {
  sent: boolean;
  target: NotificationDeliveryTarget;
  fallback?: boolean;
  reason?: string;
  deliveries: ReportDeliveryEntry[];
}

export interface InteractiveCardButton {
  text: string;
  value: string;
  style?: "primary" | "danger" | "default";
}

export interface InteractiveCard {
  title: string;
  lines: string[];
  buttons?: InteractiveCardButton[];
  url?: { text: string; href: string };
}

export interface CardSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export interface CardTransport {
  sendCard(
    target: { chatId?: string; openId?: string },
    cardJson: unknown
  ): Promise<{ ok: boolean; messageId?: string; error?: string }>;
  updateCard(messageId: string, cardJson: unknown): Promise<{ ok: boolean; error?: string }>;
}

interface FeishuAppTarget {
  targetType: "open_id" | "chat_id";
  targetId: string;
  source: string;
}

interface FeishuAppCredentials {
  appId: string;
  appSecret: string;
  domain?: string;
  source: string;
}

let notificationTargetRepository: NotificationTargetRepository | null = null;

export function getNotificationReadiness(): NotificationReadiness {
  const pluginBot = resolveFeishuUserPluginBotReadiness();
  if (pluginBot.enabled) {
    return pluginBot;
  }

  const fallback = getFallbackNotificationReadiness();
  if (!fallback.enabled) {
    return {
      enabled: false,
      target: "none",
      reason: `${pluginBot.reason ?? "Feishu user plugin bot channel is not ready"}; ${fallback.reason ?? "no fallback is ready"}`
    };
  }

  return {
    enabled: true,
    target: fallback.target,
    reason: `${pluginBot.reason ?? "Feishu user plugin bot channel is not ready"}; fallback is available.`
  };
}

export async function sendNotification(payload: NotificationPayload): Promise<NotificationResult> {
  const pluginBotReadiness = resolveFeishuUserPluginBotReadiness();
  if (pluginBotReadiness.enabled) {
    try {
      return await sendFeishuUserPluginBotNotification(payload);
    } catch (error) {
      const primaryError = sanitizeNotificationError(error);
      const fallbackResult = await sendFallbackNotification(buildDegradedFallbackPayload(payload));
      if (fallbackResult.sent) {
        return {
          ...fallbackResult,
          fallback: true,
          primaryError
        };
      }

      return {
        sent: false,
        target: fallbackResult.target,
        fallback: true,
        primaryError,
        reason: fallbackResult.reason ?? "Feishu user plugin failed and fallback was not sent."
      };
    }
  }

  return sendFallbackNotification(payload);
}

export async function deliverReportToFeishu(payload: ReportDeliveryPayload): Promise<ReportDeliveryResult> {
  const pluginBotReadiness = resolveFeishuUserPluginBotReadiness();
  if (!pluginBotReadiness.enabled) {
    if (allowReportFallbackDelivery()) {
      return deliverReportViaFallback(payload, pluginBotReadiness.reason);
    }

    throw new Error([
      `Feishu report delivery requires the user-plugin bot channel: ${pluginBotReadiness.reason ?? "not ready"}.`,
      "Degraded fallback delivery is disabled for reports; set FEISHU_REPORT_ALLOW_FALLBACK=1 only if an operator explicitly accepts degraded report delivery."
    ].join(" "));
  }

  try {
    return await deliverReportViaUserPlugin(payload);
  } catch (error) {
    const primaryError = sanitizeNotificationError(error);
    if (allowReportFallbackDelivery()) {
      return deliverReportViaFallback(payload, primaryError);
    }

    throw new Error([
      `Feishu report user-plugin delivery failed after retries: ${primaryError}`,
      "Degraded fallback delivery is disabled for reports, so this report was not marked delivered."
    ].join(" "));
  }
}

function getFallbackNotificationReadiness(): NotificationReadiness {
  const webhookUrl = process.env.FEISHU_WEBHOOK_URL?.trim();
  if (webhookUrl) {
    return {
      enabled: true,
      target: "feishu-webhook"
    };
  }

  const appTarget = resolveFeishuAppTarget();
  if (!appTarget) {
    return {
      enabled: false,
      target: "none",
      reason: "No Feishu notification target is configured yet. DM the bot once to seed the target, or set FEISHU_NOTIFY_OPEN_ID / FEISHU_NOTIFY_CHAT_ID."
    };
  }

  return {
    enabled: true,
    target: appTarget.targetType === "chat_id" ? "feishu-app-chat-id" : "feishu-app-open-id"
  };
}

async function sendFallbackNotification(payload: NotificationPayload): Promise<NotificationResult> {
  const webhookUrl = process.env.FEISHU_WEBHOOK_URL?.trim();
  if (webhookUrl) {
    const message = buildFeishuWebhookMessage(payload);
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(message)
    });

    if (!response.ok) {
      throw new Error(`Feishu webhook rejected notification: ${response.status} ${response.statusText}`);
    }

    return {
      sent: true,
      target: "feishu-webhook"
    };
  }

  const credentials = resolveFeishuAppCredentials();
  if (!credentials) {
    return {
      sent: false,
      target: "none",
      reason: "FEISHU_APP_ID / FEISHU_APP_SECRET are not configured and no OpenClaw Feishu app account was found."
    };
  }

  const appTarget = resolveFeishuAppTarget();
  if (!appTarget) {
    return {
      sent: false,
      target: "none",
      reason: "No Feishu notification target is configured yet. DM the bot once to seed the target, or set FEISHU_NOTIFY_OPEN_ID / FEISHU_NOTIFY_CHAT_ID."
    };
  }

  const message = buildFeishuAppMessage(payload);
  const response = await fetch(
    `${resolveFeishuApiBase(credentials.domain ?? process.env.FEISHU_DOMAIN)}/open-apis/im/v1/messages?receive_id_type=${appTarget.targetType}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${await fetchFeishuTenantAccessToken(credentials)}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        receive_id: appTarget.targetId,
        msg_type: message.msg_type,
        content: JSON.stringify(message.content)
      })
    }
  );

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || (body && Number(body.code ?? 0) !== 0)) {
    const reason = body && typeof body.msg === "string"
      ? body.msg
      : `${response.status} ${response.statusText}`;
    throw new Error(`Feishu app notification rejected: ${reason}`);
  }

  return {
    sent: true,
    target: appTarget.targetType === "chat_id" ? "feishu-app-chat-id" : "feishu-app-open-id"
  };
}

async function deliverReportViaFallback(payload: ReportDeliveryPayload, primaryError?: string): Promise<ReportDeliveryResult> {
  const chunks = splitReportIntoChapterMessages(payload.markdown, payload.maxSectionChars ?? 4800);
  const deliveries: ReportDeliveryEntry[] = [];
  const summaryResult = await sendFallbackNotification(buildDegradedFallbackPayload({
    title: `${payload.title} 摘要`,
    body: buildReportSummaryMarkdown(payload),
    format: "post"
  }));
  deliveries.push({
    kind: "summary",
    title: `${payload.title} 摘要`,
    target: summaryResult.target,
    sent: summaryResult.sent,
    fallback: true,
    ...(summaryResult.reason ? { reason: summaryResult.reason } : {}),
    ...(primaryError ? { primaryError } : {})
  });

  if (summaryResult.sent && shouldSendFullReportChapters()) {
    for (const section of chunks) {
      const result = await sendFallbackNotification(buildDegradedFallbackPayload({
        title: section.title,
        body: section.body,
        format: "post"
      }));
      deliveries.push({
        kind: "chapter",
        title: section.title,
        target: result.target,
        sent: result.sent,
        fallback: true,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(primaryError ? { primaryError } : {}),
        chapter: section.chapter,
        part: section.part,
        parts: section.parts
      });
      if (!result.sent) {
        break;
      }
    }
  }

  const deliveryResult: ReportDeliveryResult = {
    sent: deliveries.some((entry) => entry.sent),
    target: summaryResult.target,
    fallback: true,
    deliveries
  };
  const reason = summaryResult.sent ? undefined : (summaryResult.reason ?? primaryError);
  if (reason) {
    deliveryResult.reason = reason;
  }
  return deliveryResult;
}

async function deliverReportViaUserPlugin(payload: ReportDeliveryPayload): Promise<ReportDeliveryResult> {
  const deliveries: ReportDeliveryEntry[] = [];
  const summaryResult = await sendFeishuUserPluginBotPost({
    title: `${payload.title} 摘要`,
    body: buildReportSummaryMarkdown(payload)
  });
  deliveries.push({
    kind: "summary",
    title: `${payload.title} 摘要`,
    target: summaryResult.target,
    sent: summaryResult.sent,
    ...(summaryResult.detail ? { detail: summaryResult.detail } : {})
  });

  if (shouldSendFullReportChapters()) {
    const sections = splitReportIntoChapterMessages(payload.markdown, payload.maxSectionChars ?? 4800);
    for (const section of sections) {
      const sectionResult = await sendFeishuUserPluginBotPost({
        title: section.title,
        body: section.body
      });
      deliveries.push({
        kind: "chapter",
        title: section.title,
        target: sectionResult.target,
        sent: sectionResult.sent,
        ...(sectionResult.detail ? { detail: sectionResult.detail } : {}),
        chapter: section.chapter,
        part: section.part,
        parts: section.parts
      });
    }
  }

  if (payload.pdfPath) {
    const fileResult = await trySendFeishuUserPluginBotFile(payload.pdfPath, `${payload.title}.pdf`);
    deliveries.push({
      kind: "file",
      title: `${payload.title}.pdf`,
      target: fileResult.target,
      sent: fileResult.sent,
      ...(fileResult.detail ? { detail: fileResult.detail } : {}),
      ...(fileResult.reason ? { reason: fileResult.reason } : {})
    });
    if (!fileResult.sent) {
      throw new Error(`Feishu report PDF delivery failed: ${fileResult.reason ?? fileResult.detail ?? "unknown error"}`);
    }
  }

  return {
    sent: deliveries.some((entry) => entry.kind !== "file" && entry.sent),
    target: "feishu-user-plugin-bot-post",
    deliveries
  };
}

export function allowReportFallbackDelivery(): boolean {
  return false;
}

export function shouldSendFullReportChapters(): boolean {
  return false;
}

async function withNotificationRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
  const { attempts, baseDelayMs } = getNotificationRetryConfig();
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableNotificationError(error)) {
        throw error;
      }
      await sleep(baseDelayMs * attempt);
    }
  }

  throw new Error(`${label} failed after ${attempts} attempts: ${sanitizeNotificationError(lastError)}`);
}

function getNotificationRetryConfig(): { attempts: number; baseDelayMs: number } {
  return {
    attempts: clampInteger(
      process.env.FEISHU_NOTIFICATION_RETRY_ATTEMPTS ?? process.env.FEISHU_USER_PLUGIN_RETRY_ATTEMPTS,
      1,
      6,
      3
    ),
    baseDelayMs: clampInteger(
      process.env.FEISHU_NOTIFICATION_RETRY_DELAY_MS ?? process.env.FEISHU_USER_PLUGIN_RETRY_DELAY_MS,
      250,
      10_000,
      2_000
    )
  };
}

function isRetryableNotificationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNABORTED|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket|TLS|temporar|rate limit|429|5\d\d/iu.test(message);
}

function clampInteger(value: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveFeishuUserPluginBotReadiness(): NotificationReadiness {
  if (process.env.FEISHU_USER_PLUGIN_DISABLED === "1") {
    return {
      enabled: false,
      target: "none",
      reason: "FEISHU_USER_PLUGIN_DISABLED=1"
    };
  }

  const appId = process.env.LARK_APP_ID?.trim() || process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.LARK_APP_SECRET?.trim() || process.env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    return {
      enabled: false,
      target: "none",
      reason: "LARK_APP_ID/LARK_APP_SECRET are not configured."
    };
  }

  try {
    resolveFeishuUserPluginBotChatId();
  } catch (error) {
    return {
      enabled: false,
      target: "none",
      reason: error instanceof Error ? error.message : String(error)
    };
  }

  return {
    enabled: true,
    target: "feishu-user-plugin-bot-post"
  };
}

async function sendFeishuUserPluginBotNotification(payload: NotificationPayload): Promise<NotificationResult> {
  const post = payload.format === "post";
  return post
    ? sendFeishuUserPluginBotPost(payload)
    : sendFeishuUserPluginBotText(payload);
}

async function sendFeishuUserPluginBotText(payload: NotificationPayload): Promise<NotificationResult> {
  return withNotificationRetry(async () => {
    const chatId = resolveFeishuUserPluginBotChatId();
    const result = await callFeishuUserPluginTool("send_message_as_bot", {
      chat_id: chatId,
      msg_type: "text",
      content: {
        text: `${payload.title}\n${payload.body}`
      }
    });

    const detail = extractMcpText(result);
    if (result.isError || /^send failed\b/iu.test(detail) || /^error:/iu.test(detail)) {
      throw new Error(detail || "feishu-user-plugin returned an error response.");
    }

    return {
      sent: true,
      target: "feishu-user-plugin-bot-text",
      ...(detail ? { detail } : {})
    };
  }, "feishu-user-plugin text send");
}

async function sendFeishuUserPluginBotPost(payload: NotificationPayload): Promise<NotificationResult> {
  return withNotificationRetry(async () => {
    const chatId = resolveFeishuUserPluginBotChatId();
    const result = await callFeishuUserPluginTool("send_message_as_bot", {
      chat_id: chatId,
      msg_type: "post",
      content: {
        zh_cn: {
          title: payload.title,
          content: markdownToFeishuPostContent(payload.body)
        }
      }
    });

    const detail = extractMcpText(result);
    if (result.isError || /^send failed\b/iu.test(detail) || /^error:/iu.test(detail)) {
      throw new Error(detail || "feishu-user-plugin bot post returned an error response.");
    }

    return {
      sent: true,
      target: "feishu-user-plugin-bot-post",
      ...(detail ? { detail } : {})
    };
  }, "feishu-user-plugin post send");
}

async function trySendFeishuUserPluginBotFile(filePath: string, fileName: string): Promise<NotificationResult> {
  if (!existsSync(filePath)) {
    return {
      sent: false,
      target: "feishu-user-plugin-bot-file",
      reason: `PDF file was not found: ${filePath}`
    };
  }

  try {
    const upload = await withNotificationRetry(() => callFeishuUserPluginTool("upload_file", {
      file_path: filePath,
      file_type: "pdf",
      file_name: fileName
    }), "feishu-user-plugin file upload");
    const uploadText = extractMcpText(upload);
    const fileKey = uploadText.match(/\bfile_[A-Za-z0-9_-]+\b/u)?.[0];
    if (upload.isError || !fileKey) {
      return {
        sent: false,
        target: "feishu-user-plugin-bot-file",
        reason: uploadText || "PDF upload did not return a file key."
      };
    }

    const sent = await withNotificationRetry(() => callFeishuUserPluginTool("send_message_as_bot", {
      chat_id: resolveFeishuUserPluginBotChatId(),
      msg_type: "file",
      content: {
        file_key: fileKey
      }
    }), "feishu-user-plugin file send");
    const detail = extractMcpText(sent);
    if (sent.isError || /^error:/iu.test(detail)) {
      return {
        sent: false,
        target: "feishu-user-plugin-bot-file",
        reason: detail || "PDF file message failed."
      };
    }

    return {
      sent: true,
      target: "feishu-user-plugin-bot-file",
      detail
    };
  } catch (error) {
    return {
      sent: false,
      target: "feishu-user-plugin-bot-file",
      reason: sanitizeNotificationError(error)
    };
  }
}

export function buildFeishuCardPayload(card: InteractiveCard): unknown {
  const elements: unknown[] = card.lines.map((line) => ({
    tag: "markdown",
    content: line
  }));

  const actions: unknown[] = (card.buttons ?? []).map((button) => ({
    tag: "button",
    text: { tag: "plain_text", content: button.text },
    type: button.style ?? "default",
    value: { value: button.value }
  }));

  if (card.url) {
    actions.push({
      tag: "button",
      text: { tag: "plain_text", content: card.url.text },
      type: "default",
      url: card.url.href
    });
  }

  if (actions.length > 0) {
    elements.push({ tag: "action", actions });
  }

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: { tag: "plain_text", content: card.title },
      template: "blue"
    },
    body: { elements }
  };
}

export async function sendInteractiveCard(
  card: InteractiveCard,
  target: { chatId?: string; openId?: string },
  transport: CardTransport = defaultCardTransport
): Promise<CardSendResult> {
  const payload = buildFeishuCardPayload(card);
  try {
    const result = await transport.sendCard(target, payload);
    if (!result.ok) {
      return { ok: false, error: result.error ?? "Interactive card send failed." };
    }
    return {
      ok: true,
      ...(result.messageId ? { messageId: result.messageId } : {})
    };
  } catch (error) {
    return { ok: false, error: sanitizeNotificationError(error) };
  }
}

export async function updateInteractiveCard(
  messageId: string,
  card: InteractiveCard,
  transport: CardTransport = defaultCardTransport
): Promise<{ ok: boolean; error?: string }> {
  const payload = buildFeishuCardPayload(card);
  try {
    const result = await transport.updateCard(messageId, payload);
    if (!result.ok) {
      return { ok: false, error: result.error ?? "Interactive card update failed." };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: sanitizeNotificationError(error) };
  }
}

// Default transport reuses the feishu-user-plugin MCP subprocess channel
// (see callFeishuUserPluginTool below). Real MCP behaviour is a
// deployment-time concern; this path is intentionally left uncovered by unit
// tests here (see notifications.test.ts) since there is no established
// subprocess-mocking pattern in this suite yet.
const defaultCardTransport: CardTransport = {
  async sendCard(target, cardJson) {
    try {
      const chatId = target.chatId ?? target.openId ?? resolveFeishuUserPluginBotChatId();
      return await withNotificationRetry(async () => {
        const result = await callFeishuUserPluginTool("send_message_as_bot", {
          chat_id: chatId,
          msg_type: "interactive",
          content: cardJson
        });
        const detail = extractMcpText(result);
        if (result.isError) {
          throw new Error(detail || "feishu-user-plugin returned an error response.");
        }
        const messageId = extractMcpMessageId(detail);
        return {
          ok: true,
          ...(messageId ? { messageId } : {})
        };
      }, "feishu-user-plugin card send");
    } catch (error) {
      return { ok: false, error: sanitizeNotificationError(error) };
    }
  },
  async updateCard(messageId, cardJson) {
    try {
      return await withNotificationRetry(async () => {
        const result = await callFeishuUserPluginTool("update_message", {
          message_id: messageId,
          msg_type: "interactive",
          content: cardJson
        });
        const detail = extractMcpText(result);
        if (result.isError) {
          throw new Error(detail || "feishu-user-plugin returned an error response.");
        }
        return { ok: true };
      }, "feishu-user-plugin card update");
    } catch (error) {
      return { ok: false, error: sanitizeNotificationError(error) };
    }
  }
};

function resolveFeishuUserPluginBotChatId(): string {
  const explicitBotChatId = process.env.FEISHU_USER_PLUGIN_BOT_CHAT_ID?.trim();
  if (explicitBotChatId) {
    return explicitBotChatId;
  }

  const notifyChatId = process.env.FEISHU_NOTIFY_CHAT_ID?.trim();
  if (notifyChatId?.startsWith("oc_")) {
    return notifyChatId;
  }

  const groupAllowList = (process.env.FEISHU_GROUP_ALLOW_FROM ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("oc_"));
  if (groupAllowList.length === 1) {
    return groupAllowList[0]!;
  }

  const explicitChatId = process.env.FEISHU_USER_PLUGIN_CHAT_ID?.trim();
  if (explicitChatId) {
    throw new Error("FEISHU_USER_PLUGIN_CHAT_ID is a user-identity numeric chat id; set FEISHU_USER_PLUGIN_BOT_CHAT_ID or FEISHU_NOTIFY_CHAT_ID to an oc_ chat id for bot delivery.");
  }

  throw new Error("No bot chat id is configured. Set FEISHU_USER_PLUGIN_BOT_CHAT_ID or FEISHU_NOTIFY_CHAT_ID to the 炒股这一块 oc_ chat id.");
}

interface McpToolResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

interface McpResponse {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

async function callFeishuUserPluginTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const repoRoot = resolveRepoRoot(process.cwd());
  const { command, commandArgs } = resolveFeishuUserPluginCommand(repoRoot);
  const timeoutMs = Number(process.env.FEISHU_USER_PLUGIN_TIMEOUT_MS ?? 60000);
  const child = spawn(command, commandArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      LARK_APP_ID: process.env.LARK_APP_ID ?? process.env.FEISHU_APP_ID ?? "",
      LARK_APP_SECRET: process.env.LARK_APP_SECRET ?? process.env.FEISHU_APP_SECRET ?? "",
      FEISHU_USER_PLUGIN_GROUP_NAME: process.env.FEISHU_USER_PLUGIN_GROUP_NAME ?? "炒股这一块"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let nextId = 1;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  const pending = new Map<number, {
    resolve: (value: McpResponse) => void;
    reject: (error: Error) => void;
  }>();

  const rejectAll = (error: Error) => {
    for (const entry of pending.values()) {
      entry.reject(error);
    }
    pending.clear();
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    while (true) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const rawLine = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/u, "");
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (!rawLine.trim()) {
        continue;
      }

      let response: McpResponse;
      try {
        response = JSON.parse(rawLine) as McpResponse;
      } catch {
        stderrBuffer += `\n${rawLine}`;
        continue;
      }

      if (typeof response.id !== "number") {
        continue;
      }

      const waiter = pending.get(response.id);
      if (!waiter) {
        continue;
      }
      pending.delete(response.id);
      waiter.resolve(response);
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString("utf8");
    if (stderrBuffer.length > 4000) {
      stderrBuffer = stderrBuffer.slice(-4000);
    }
  });

  child.on("error", (error) => {
    rejectAll(error);
  });

  child.on("exit", (code, signal) => {
    if (pending.size === 0) {
      return;
    }
    rejectAll(new Error(`feishu-user-plugin exited before responding (${signal ?? code ?? "unknown"}). ${stderrBuffer.trim()}`.trim()));
  });

  let childClosed = false;
  const childClosedPromise = new Promise<void>((resolve) => {
    child.on("close", () => {
      childClosed = true;
      resolve();
    });
  });

  const request = async (method: string, params?: Record<string, unknown>): Promise<McpResponse> => {
    const id = nextId;
    nextId += 1;
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params ? { params } : {})
    });

    const response = await new Promise<McpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`feishu-user-plugin timed out on ${method}. ${stderrBuffer.trim()}`.trim()));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      child.stdin.write(`${message}\n`);
    });

    if (response.error) {
      throw new Error(response.error.message ?? `MCP error ${response.error.code ?? "unknown"}`);
    }
    return response;
  };

  try {
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "openclaw-trading-stack",
        version: "0.1.0"
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const response = await request("tools/call", {
      name,
      arguments: args
    });
    return (response.result ?? {}) as McpToolResult;
  } finally {
    if (!child.stdin.destroyed) {
      child.stdin.end();
    }
    if (!childClosed) {
      child.kill("SIGTERM");
    }
    await Promise.race([childClosedPromise, sleep(2_000)]);
    if (!childClosed) {
      child.kill("SIGKILL");
      await Promise.race([childClosedPromise, sleep(1_000)]);
    }
  }
}

function resolveFeishuUserPluginCommand(repoRoot: string): { command: string; commandArgs: string[] } {
  const command = process.env.FEISHU_USER_PLUGIN_COMMAND?.trim();
  if (command) {
    const args = process.env.FEISHU_USER_PLUGIN_ARGS?.trim();
    return {
      command,
      commandArgs: args ? JSON.parse(args) as string[] : []
    };
  }

  return {
    command: "node",
    commandArgs: [join(repoRoot, "apps", "openclaw-config", "scripts", "run-feishu-user-plugin.mjs")]
  };
}

function extractMcpText(result: McpToolResult): string {
  return (result.content ?? [])
    .filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n")
    .trim();
}

// feishu-user-plugin reports message ids inline in its text response, e.g.
// "Message sent (bot): om_xxxxx" or "Message updated: om_xxxxx". Built on top
// of extractMcpText's output rather than forking a divergent parser, so
// existing extractMcpText callers are unaffected.
function extractMcpMessageId(detail: string): string | undefined {
  return detail.match(/\bom_[A-Za-z0-9_-]+\b/u)?.[0];
}

function buildDegradedFallbackPayload(payload: NotificationPayload): NotificationPayload {
  return {
    ...payload,
    title: `已降级为 bot 发送：${payload.title}`,
    body: `【已降级为 bot 发送】\n\n${payload.body}`
  };
}

export function buildReportSummaryMarkdown(payload: ReportDeliveryPayload): string {
  const lines = payload.markdown.replace(/\r\n/gu, "\n").split("\n");
  const reportTitle = lines.find((line) => /^#\s+/u.test(line))?.replace(/^#\s+/u, "").trim() ?? payload.title;
  const windowLine = lines.find((line) => /^窗口：/u.test(line)) ?? "";
  const bullets = extractActionableSummaryBullets(payload.markdown).slice(0, 8);

  return [
    `# ${reportTitle}`,
    "",
    windowLine,
    "",
    "## 摘要",
    "",
    ...(bullets.length > 0 ? bullets : ["- 报告没有提取到可行动摘要，请打开 PDF 查看正文并人工复核。"])
  ].filter((line) => line !== "").join("\n");
}

function extractActionableSummaryBullets(markdown: string): string[] {
  const bullets: string[] = [];
  const conclusion = extractSection(markdown, [
    /^##\s+\d+\.\s+.*结论/u,
    /^##\s+本批次结论/u,
    /^##\s+收支变化表/u
  ]);
  bullets.push(...extractUsefulBullets(conclusion));

  const news = extractSection(markdown, [/^###\s+长桥新闻/u]);
  bullets.push(...extractUsefulBullets(news).slice(0, 2));

  const macro = extractSection(markdown, [/^###\s+宏观日历/u]);
  bullets.push(...extractUsefulBullets(macro).slice(0, 1));

  const positions = extractSection(markdown, [/^##\s+持仓/u, /^##\s+\d+\.\s+官方模拟盘/u, /^##\s+\d+\.\s+模拟盘/u]);
  bullets.push(...extractUsefulBullets(positions).slice(0, 2));

  const reflection = extractSection(markdown, [/^##\s+策略反思/u, /^###\s+结论与复盘标签/u]);
  bullets.push(...extractUsefulBullets(reflection).slice(0, 2));

  return dedupeBullets(bullets).filter(isActionableSummaryLine);
}

function extractSection(markdown: string, headingPatterns: RegExp[]): string {
  const normalized = markdown.replace(/\r\n/gu, "\n");
  const lines = normalized.split("\n");
  const start = lines.findIndex((line) => headingPatterns.some((pattern) => pattern.test(line.trim())));
  if (start < 0) {
    return "";
  }
  const startLine = lines[start] ?? "";
  const startLevel = countHeadingLevel(startLine);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const level = countHeadingLevel(lines[index] ?? "");
    if (level > 0 && level <= startLevel) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

function countHeadingLevel(line: string): number {
  const match = /^(#{1,6})\s+/u.exec(line.trim());
  return match?.[1] ? match[1].length : 0;
}

function extractUsefulBullets(section: string): string[] {
  return section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^-\s+/u.test(line));
}

function dedupeBullets(lines: string[]): string[] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    const key = line.replace(/\s+/gu, " ");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isActionableSummaryLine(line: string): boolean {
  return ![
    /本地文本文档|本地报告文件|文件上传成功|完整正文|群里默认|交付|投递：|语言：/u,
    /^-\s*数据覆盖：/u,
    /^-\s*记录状态：/u,
    /^-\s*期权自动化：/u,
    /^-\s*实盘：禁止自动提交/u
  ].some((pattern) => pattern.test(line));
}

interface ChapterMessage {
  title: string;
  body: string;
  chapter: number;
  part: number;
  parts: number;
}

function splitReportIntoChapterMessages(markdown: string, maxChars: number): ChapterMessage[] {
  const normalized = markdown.replace(/\r\n/gu, "\n").trim();
  if (!normalized) {
    return [];
  }

  const rawSections = normalized.split(/\n(?=##\s+)/u);
  const sections = rawSections.map((section, index) => ({
    title: extractSectionTitle(section) ?? (index === 0 ? "报告信息" : `章节 ${index + 1}`),
    body: section.trim()
  })).filter((section) => section.body);

  const messages: ChapterMessage[] = [];
  for (const [sectionIndex, section] of sections.entries()) {
    const parts = splitMarkdownText(section.body, maxChars);
    for (const [partIndex, part] of parts.entries()) {
      const multiPart = parts.length > 1 ? `（${partIndex + 1}/${parts.length}）` : "";
      messages.push({
        title: `${section.title}${multiPart}`,
        body: part,
        chapter: sectionIndex + 1,
        part: partIndex + 1,
        parts: parts.length
      });
    }
  }

  return messages.length > 0
    ? messages
    : [{
        title: "报告全文",
        body: normalized,
        chapter: 1,
        part: 1,
        parts: 1
      }];
}

function extractSectionTitle(section: string): string | null {
  const heading = section.match(/^(#{1,6})\s+(.+)$/mu)?.[2]?.trim();
  return heading || null;
}

function splitMarkdownText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }

  const paragraphs = text.split(/\n{2,}/u);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current.trim()) {
      chunks.push(current.trim());
      current = "";
    }

    if (paragraph.length <= maxChars) {
      current = paragraph;
      continue;
    }

    for (let index = 0; index < paragraph.length; index += maxChars) {
      chunks.push(paragraph.slice(index, index + maxChars).trim());
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks.filter(Boolean);
}

function sanitizeNotificationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(LARK_COOKIE=)[^\s]+/giu, "$1<redacted>")
    .replace(/(LARK_APP_SECRET=)[^\s]+/giu, "$1<redacted>")
    .replace(/(LARK_USER_(?:ACCESS|REFRESH)_TOKEN=)[^\s]+/giu, "$1<redacted>")
    .slice(0, 1000);
}

function resolveFeishuApiBase(domain = process.env.FEISHU_DOMAIN ?? "feishu"): string {
  return domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

async function fetchFeishuTenantAccessToken(credentials: FeishuAppCredentials): Promise<string> {
  const response = await fetch(`${resolveFeishuApiBase(credentials.domain ?? process.env.FEISHU_DOMAIN)}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      app_id: credentials.appId,
      app_secret: credentials.appSecret
    })
  });

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !body || Number(body.code ?? 0) !== 0 || typeof body.tenant_access_token !== "string") {
    const reason = body && typeof body.msg === "string"
      ? body.msg
      : `${response.status} ${response.statusText}`;
    throw new Error(`Failed to obtain Feishu tenant access token: ${reason}`);
  }

  return body.tenant_access_token;
}

function resolveFeishuAppCredentials(): FeishuAppCredentials | null {
  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (appId && appSecret) {
    const domain = process.env.FEISHU_DOMAIN?.trim();
    return {
      appId,
      appSecret,
      ...(domain ? { domain } : {}),
      source: "env"
    };
  }

  const configPath = join(homedir(), ".openclaw", "openclaw.json");
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      channels?: {
        feishu?: {
          defaultAccount?: unknown;
          domain?: unknown;
          accounts?: Record<string, {
            appId?: unknown;
            appSecret?: unknown;
            domain?: unknown;
          }>;
        };
      };
      feishu?: {
        defaultAccount?: unknown;
        domain?: unknown;
        accounts?: Record<string, {
          appId?: unknown;
          appSecret?: unknown;
          domain?: unknown;
        }>;
      };
    };
    const feishuConfig = parsed.channels?.feishu ?? parsed.feishu;
    const accountId = process.env.FEISHU_ACCOUNT_ID?.trim()
      || (typeof feishuConfig?.defaultAccount === "string" ? feishuConfig.defaultAccount : "main");
    const account = feishuConfig?.accounts?.[accountId];
    const configAppId = typeof account?.appId === "string" ? account.appId.trim() : "";
    const configAppSecret = typeof account?.appSecret === "string" ? account.appSecret.trim() : "";
    if (!configAppId || !configAppSecret) {
      return null;
    }

    const accountDomain = typeof account?.domain === "string" ? account.domain : undefined;
    const configDomain = typeof feishuConfig?.domain === "string" ? feishuConfig.domain : undefined;
    const domain = accountDomain ?? configDomain;
    return {
      appId: configAppId,
      appSecret: configAppSecret,
      ...(domain ? { domain } : {}),
      source: `openclaw:${accountId}`
    };
  } catch {
    return null;
  }
}

function buildFeishuWebhookMessage(payload: NotificationPayload): {
  msg_type: "text" | "post";
  content: Record<string, unknown>;
} {
  const message = buildFeishuAppMessage(payload);
  if (message.msg_type === "post") {
    return {
      msg_type: "post",
      content: {
        post: message.content
      }
    };
  }

  return {
    msg_type: message.msg_type,
    content: message.content
  };
}

function buildFeishuAppMessage(payload: NotificationPayload): {
  msg_type: "text" | "post";
  content: Record<string, unknown>;
} {
  if (payload.format === "post") {
    return {
      msg_type: "post",
      content: {
        zh_cn: {
          title: payload.title,
          content: markdownToFeishuPostContent(payload.body)
        }
      }
    };
  }

  return {
    msg_type: "text",
    content: {
      text: `${payload.title}\n${payload.body}`
    }
  };
}

function markdownToFeishuPostContent(markdown: string): Array<Array<{ tag: "text"; text: string }>> {
  const lines = markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());

  const paragraphs: Array<Array<{ tag: "text"; text: string }>> = [];
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length === 0) {
      return;
    }
    for (const chunk of splitPostText(buffer.join("\n"))) {
      paragraphs.push([{ tag: "text", text: chunk }]);
    }
    buffer = [];
  };

  for (const line of lines) {
    if (!line.trim()) {
      flush();
      continue;
    }

    const normalized = normalizeMarkdownLine(line);
    if (/^#{1,6}\s/u.test(line)) {
      flush();
      paragraphs.push([{ tag: "text", text: normalized }]);
      continue;
    }

    buffer.push(normalized);
  }
  flush();

  return paragraphs.length > 0 ? paragraphs : [[{ tag: "text", text: markdown.trim() || " " }]];
}

function normalizeMarkdownLine(line: string): string {
  const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
  if (heading) {
    const level = heading[1]?.length ?? 1;
    const marker = level <= 2 ? "【" : "— ";
    const suffix = level <= 2 ? "】" : "";
    return `${marker}${heading[2]}${suffix}`;
  }

  return line
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1");
}

function splitPostText(text: string): string[] {
  const maxChars = 900;
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += maxChars) {
    chunks.push(text.slice(index, index + maxChars));
  }
  return chunks;
}

function resolveFeishuAppTarget(): FeishuAppTarget | null {
  const explicitTarget = resolveExplicitFeishuTarget();
  if (explicitTarget) {
    return explicitTarget;
  }

  const repoTarget = resolveStoredFeishuTarget();
  if (repoTarget) {
    return repoTarget;
  }

  const discoveredTarget = discoverFeishuTargetFromAllowlist();
  if (discoveredTarget) {
    storeFeishuTarget(discoveredTarget);
    return discoveredTarget;
  }

  const pendingPairingTarget = discoverFeishuTargetFromPendingPairing();
  if (!pendingPairingTarget) {
    return null;
  }

  storeFeishuTarget(pendingPairingTarget);
  return pendingPairingTarget;
}

function resolveExplicitFeishuTarget(): FeishuAppTarget | null {
  const chatId = process.env.FEISHU_NOTIFY_CHAT_ID?.trim();
  if (chatId) {
    return {
      targetType: "chat_id",
      targetId: chatId,
      source: "env:FEISHU_NOTIFY_CHAT_ID"
    };
  }

  const openId = process.env.FEISHU_NOTIFY_OPEN_ID?.trim();
  if (openId) {
    return {
      targetType: "open_id",
      targetId: openId,
      source: "env:FEISHU_NOTIFY_OPEN_ID"
    };
  }

  return null;
}

function resolveStoredFeishuTarget(): FeishuAppTarget | null {
  const target = getNotificationTargetRepository().get("feishu");
  if (!target) {
    return null;
  }

  return {
    targetType: target.targetType,
    targetId: target.targetId,
    source: target.source
  };
}

function storeFeishuTarget(target: FeishuAppTarget): void {
  getNotificationTargetRepository().save({
    channel: "feishu",
    targetType: target.targetType,
    targetId: target.targetId,
    source: target.source,
    updatedAt: Date.now()
  });
}

function discoverFeishuTargetFromAllowlist(): FeishuAppTarget | null {
  const credentialsDir = join(homedir(), ".openclaw", "credentials");
  if (!existsSync(credentialsDir)) {
    return null;
  }

  const candidates = new Set<string>();
  for (const entry of readdirSync(credentialsDir)) {
    if (!/^feishu(?:-[a-z0-9_]+)?-allowFrom\.json$/iu.test(entry)) {
      continue;
    }

    for (const allowFromEntry of parseAllowFromEntries(join(credentialsDir, entry))) {
      if (allowFromEntry.startsWith("ou_")) {
        candidates.add(allowFromEntry);
      }
    }
  }

  const openIds = Array.from(candidates);
  if (openIds.length !== 1) {
    return null;
  }

  return {
    targetType: "open_id",
    targetId: openIds[0]!,
    source: "openclaw-allowFrom"
  };
}

function discoverFeishuTargetFromPendingPairing(): FeishuAppTarget | null {
  const filePath = join(homedir(), ".openclaw", "credentials", "feishu-pairing.json");
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      requests?: Array<{ id?: unknown }>;
    };
    const openIds = Array.isArray(parsed.requests)
      ? parsed.requests
          .map((entry) => (typeof entry.id === "string" ? entry.id.trim() : ""))
          .filter((entry) => entry.startsWith("ou_"))
      : [];

    if (openIds.length !== 1) {
      return null;
    }

    return {
      targetType: "open_id",
      targetId: openIds[0]!,
      source: "openclaw-pairing-pending"
    };
  } catch {
    return null;
  }
}

function parseAllowFromEntries(filePath: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { allowFrom?: unknown };
    return Array.isArray(parsed.allowFrom)
      ? parsed.allowFrom
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function getNotificationTargetRepository(): NotificationTargetRepository {
  if (!notificationTargetRepository) {
    const db = openTradingDatabase(resolveRuntimePaths(resolveRepoRoot(process.cwd())).dbPath);
    notificationTargetRepository = new NotificationTargetRepository(db);
  }

  return notificationTargetRepository;
}
