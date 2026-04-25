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
  | "feishu-user-plugin-text"
  | "feishu-user-plugin-post"
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
  const userPlugin = resolveFeishuUserPluginReadiness();
  if (userPlugin.enabled) {
    return userPlugin;
  }

  const fallback = getFallbackNotificationReadiness();
  if (!fallback.enabled) {
    return {
      enabled: false,
      target: "none",
      reason: `${userPlugin.reason ?? "Feishu user plugin is not ready"}; ${fallback.reason ?? "no fallback is ready"}`
    };
  }

  return {
    enabled: true,
    target: fallback.target,
    reason: `${userPlugin.reason ?? "Feishu user plugin is not ready"}; fallback is available.`
  };
}

export async function sendNotification(payload: NotificationPayload): Promise<NotificationResult> {
  const userPluginReadiness = resolveFeishuUserPluginReadiness();
  if (userPluginReadiness.enabled) {
    try {
      return await sendFeishuUserPluginNotification(payload);
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

function resolveFeishuUserPluginReadiness(): NotificationReadiness {
  if (process.env.FEISHU_USER_PLUGIN_DISABLED === "1") {
    return {
      enabled: false,
      target: "none",
      reason: "FEISHU_USER_PLUGIN_DISABLED=1"
    };
  }

  const cookie = process.env.LARK_COOKIE?.trim();
  if (!cookie) {
    return {
      enabled: false,
      target: "none",
      reason: "LARK_COOKIE is not configured."
    };
  }

  return {
    enabled: true,
    target: "feishu-user-plugin-post"
  };
}

async function sendFeishuUserPluginNotification(payload: NotificationPayload): Promise<NotificationResult> {
  const chatId = await resolveFeishuUserPluginChatId();
  const post = payload.format === "post";
  const result = post
    ? await callFeishuUserPluginTool("send_post_as_user", {
        chat_id: chatId,
        title: payload.title,
        paragraphs: markdownToFeishuPostContent(payload.body)
      })
    : await callFeishuUserPluginTool("send_as_user", {
        chat_id: chatId,
        text: `${payload.title}\n${payload.body}`
      });

  const detail = extractMcpText(result);
  if (result.isError || /^send failed\b/iu.test(detail) || /^error:/iu.test(detail)) {
    throw new Error(detail || "feishu-user-plugin returned an error response.");
  }

  return {
    sent: true,
    target: post ? "feishu-user-plugin-post" : "feishu-user-plugin-text",
    ...(detail ? { detail } : {})
  };
}

async function resolveFeishuUserPluginChatId(): Promise<string> {
  const explicitChatId = process.env.FEISHU_USER_PLUGIN_CHAT_ID?.trim();
  if (explicitChatId) {
    return explicitChatId;
  }

  const groupName = process.env.FEISHU_USER_PLUGIN_GROUP_NAME?.trim() || "炒股这一块";
  const result = await callFeishuUserPluginTool("search_contacts", { query: groupName });
  const text = extractMcpText(result);
  if (result.isError || /^error:/iu.test(text)) {
    throw new Error(text || `Failed to search Feishu group "${groupName}".`);
  }

  let matches: Array<{ type?: unknown; title?: unknown; id?: unknown }>;
  try {
    matches = JSON.parse(text) as Array<{ type?: unknown; title?: unknown; id?: unknown }>;
  } catch {
    throw new Error(`Feishu group search returned non-JSON output for "${groupName}".`);
  }

  const groups = matches.filter((entry) => entry.type === "group");
  const exact = groups.find((entry) => entry.title === groupName);
  const selected = exact ?? (groups.length === 1 ? groups[0] : undefined);
  const chatId = typeof selected?.id === "string" || typeof selected?.id === "number"
    ? String(selected.id)
    : "";
  if (!chatId) {
    throw new Error(`Feishu group "${groupName}" was not resolved to exactly one chat. Matches=${groups.length}`);
  }

  return chatId;
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
    child.stdin.end();
    if (!child.killed) {
      child.kill("SIGTERM");
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

function buildDegradedFallbackPayload(payload: NotificationPayload): NotificationPayload {
  return {
    ...payload,
    title: `已降级为 bot 发送：${payload.title}`,
    body: `【已降级为 bot 发送】\n\n${payload.body}`
  };
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
