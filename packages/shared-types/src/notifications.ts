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

export interface NotificationResult {
  sent: boolean;
  target: "feishu-webhook" | "feishu-app-open-id" | "feishu-app-chat-id" | "none";
  reason?: string;
}

export interface NotificationReadiness {
  enabled: boolean;
  target: NotificationResult["target"];
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

export async function sendNotification(payload: NotificationPayload): Promise<NotificationResult> {
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
