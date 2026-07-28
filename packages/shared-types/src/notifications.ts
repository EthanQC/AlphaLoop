import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  NotificationTargetRepository,
  openTradingDatabase
} from "./database.js";
import { buildDeepLink, type DeepLinkKind } from "./deep-links.js";
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

/**
 * What the delivery card says up front. Callers that already computed a
 * conclusion box (日报/周报/个股分析) pass it verbatim so the card and the
 * report agree word for word; callers that did not get the report's own
 * actionable bullets extracted instead (buildReportConclusionCard).
 */
export interface ReportConclusion {
  headline: string;
  /** 高 / 中 / 低, as rendered in the report's own conclusion box. */
  confidence?: string;
  bullets: string[];
}

export interface ReportDeliveryPayload {
  title: string;
  markdown: string;
  markdownPath?: string;
  /**
   * Legacy: the PDF attachment is retired (2026-07-12 requirements, §0.4
   * "PDF 已退役"). Only the legacy feishu-user-plugin channel still uploads
   * it when a caller passes one; the app-credential channel never does.
   */
  pdfPath?: string;
  maxSectionChars?: number;
  /**
   * Per-owner Feishu open_id. When set it wins over the global notification
   * target, so an owner-scoped report (个股分析/个人复盘) lands in that
   * member's own DM instead of the shared 报告发布 channel. Callers that own
   * no single member (daily/weekly are 公共通知) leave it unset and get the
   * global target from resolveFeishuAppTarget.
   */
  openId?: string;
  /**
   * Which platform page holds the full report and under which id (the report
   * date for daily/weekly, the batch date for 个股分析, ...). Both are needed
   * to build the card's 查看完整报告 button; with either missing the card
   * ships button-free and says the full text lives on the platform - never a
   * bare path, never a guessed host (see deep-links.ts).
   */
  reportKind?: DeepLinkKind;
  reportDate?: string;
  conclusion?: ReportConclusion;
  /**
   * Which Feishu channel this report belongs in (2026-07-12 requirements §4).
   *
   *   "group" - 公共通知：日报/周报的发布卡 goes to the circle's group chat
   *             (`FEISHU_GROUP_CHAT_ID`). With no group configured the card
   *             still ships, to the global DM/notify target, and the result
   *             says so (`groupFallback`) instead of pretending it reached the
   *             group.
   *   "dm" (default) - 个人通道：个人页摘要、提醒、审批、复盘。Pair it with
   *             `openId` to address one member; an `openId` always wins, so an
   *             owner-scoped payload never leaks into the group.
   *
   * Honored by the app-credential channel, which is the only one production
   * uses. The legacy user-plugin and degraded-webhook channels each post to
   * one fixed chat of their own and cannot address a second target; a report
   * that falls through to them lands wherever that channel points.
   */
  audience?: "group" | "dm";
}

/**
 * An operational alert: a cron job failure notice, a halt escalation, a
 * discovery-gap warning, a state-persistence failure. NOT a report.
 *
 * 2026-07-28 (spec drift A1). openclaw-cron-runner.mjs used to send these
 * through `deliverReportToFeishu`, which was fine while that path pushed the
 * body as post messages. Once it became ONE conclusion card, every alert
 * turned into a card with no content: alert markdown carries no 窗口 line, no
 * conclusion box and none of the headings extractActionableSummaryBullets
 * looks for, so the card fell through to "未提取到可摘要的结论要点" and the
 * error, the exit code and the stderr tail were dropped entirely.
 *
 * The difference is structural, not cosmetic: a report has a platform page
 * holding its full text, so a card plus a deep link loses nothing. An alert
 * has no such page - the body IS the payload, and it ships verbatim.
 */
export interface OperationalAlertPayload {
  title: string;
  /** The alert body. Delivered in full, never summarized or extracted from. */
  markdown: string;
  /**
   * Split threshold for ONE outbound message. A body longer than this is split
   * across several messages rather than truncated - an alert that arrives
   * half-told is worse than one that arrives in two parts.
   */
  maxSectionChars?: number;
}

export interface OperationalAlertResult {
  sent: boolean;
  target: NotificationDeliveryTarget;
  reason?: string;
  deliveries: ReportDeliveryEntry[];
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
  /**
   * The payload asked for the group (`audience: "group"`) but this deployment
   * has no `FEISHU_GROUP_CHAT_ID`, so the card went to the DM/global target.
   * Set alongside `groupFallbackReason` so the run log records WHY the public
   * card was not public rather than showing a clean delivery.
   */
  groupFallback?: boolean;
  groupFallbackReason?: string;
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

/**
 * Deliver a report to Feishu. NEVER throws: an undeliverable report comes
 * back as `{sent: false, reason}` so the caller can log it and keep going.
 *
 * 2026-07-26 fix. This used to demand the feishu-user-plugin MCP bot channel
 * and THROW when it was not configured. That channel is a DIFFERENT Feishu
 * app (the operator's personal one), and FEISHU_USER_PLUGIN_BOT_CHAT_ID is
 * unset on the mini, so every scheduled report (daily/weekly/stock-analysis/
 * monthly-review) died with "No bot chat id is configured" and never reached
 * Feishu or the run log. Interactive cards hit the same wall earlier this
 * month and were migrated to the app's own tenant token
 * (directHttpCardTransport); reports never were.
 *
 * Precedence mirrors defaultCardTransport exactly, and is decided per call
 * (not at module load) so env changes are honored:
 *   1. FEISHU_APP_ID/FEISHU_APP_SECRET (or ~/.openclaw/openclaw.json) resolve
 *      -> direct im/v1/messages send with the app's own tenant token.
 *   2. no app credentials -> the legacy feishu-user-plugin MCP channel.
 *   3. neither is usable -> `{sent: false, reason}`.
 * FEISHU_REPORT_ALLOW_FALLBACK still gates the degraded webhook/app fallback
 * (allowReportFallbackDelivery) exactly as before, but it is no longer needed
 * for basic delivery.
 */
export async function deliverReportToFeishu(payload: ReportDeliveryPayload): Promise<ReportDeliveryResult> {
  const credentials = resolveFeishuAppCredentials();
  if (credentials) {
    try {
      return await deliverReportViaAppCredentials(payload);
    } catch (error) {
      return {
        sent: false,
        target: "none",
        reason: `Feishu report app-credential delivery failed: ${sanitizeNotificationError(error)}`,
        deliveries: []
      };
    }
  }

  const pluginBotReadiness = resolveFeishuUserPluginBotReadiness();
  if (!pluginBotReadiness.enabled) {
    if (allowReportFallbackDelivery()) {
      return tryDeliverReportViaFallback(payload, pluginBotReadiness.reason);
    }

    return {
      sent: false,
      target: "none",
      reason: [
        "Feishu report delivery has no usable channel:",
        "FEISHU_APP_ID/FEISHU_APP_SECRET are not configured and no OpenClaw Feishu app account was found,",
        `and the legacy user-plugin bot channel is not ready either (${pluginBotReadiness.reason ?? "not ready"}).`
      ].join(" "),
      deliveries: []
    };
  }

  try {
    return await deliverReportViaUserPlugin(payload);
  } catch (error) {
    const primaryError = sanitizeNotificationError(error);
    if (allowReportFallbackDelivery()) {
      return tryDeliverReportViaFallback(payload, primaryError);
    }

    return {
      sent: false,
      target: "feishu-user-plugin-bot-post",
      reason: `Feishu report user-plugin delivery failed after retries: ${primaryError}`,
      deliveries: []
    };
  }
}

/**
 * Deliver an operational alert to Feishu with its body intact. NEVER throws.
 *
 * Channel precedence mirrors deliverReportToFeishu exactly (app credentials,
 * then the legacy user-plugin MCP channel, then nothing) so an alert reaches
 * the same operator through the same account a report would - only the
 * MESSAGE shape differs: post messages carrying the whole body instead of a
 * conclusion card, because there is no platform page to link to for the rest.
 *
 * Alerts always go to the deployment's global/ops target. They are never
 * owner-scoped, so there is no `openId` on the payload and no group/DM split
 * to make: FEISHU_GROUP_CHAT_ID belongs to public report cards (§4), an alert
 * belongs to whoever operates the runner.
 */
export async function deliverOperationalAlertToFeishu(
  payload: OperationalAlertPayload
): Promise<OperationalAlertResult> {
  try {
    return await deliverOperationalAlertParts(payload);
  } catch (error) {
    return {
      sent: false,
      target: "none",
      reason: `Feishu operational alert delivery failed: ${sanitizeNotificationError(error)}`,
      deliveries: []
    };
  }
}

async function deliverOperationalAlertParts(
  payload: OperationalAlertPayload
): Promise<OperationalAlertResult> {
  const parts = splitOperationalAlertBody(payload);
  const credentials = resolveFeishuAppCredentials();
  if (credentials) {
    const target = tryResolveGlobalFeishuTarget();
    if (!target) {
      return {
        sent: false,
        target: "none",
        reason: "No Feishu alert target could be resolved. Set FEISHU_NOTIFY_OPEN_ID / FEISHU_NOTIFY_CHAT_ID, or DM the bot once to seed the stored target.",
        deliveries: []
      };
    }
    const entryTarget: NotificationDeliveryTarget = target.targetType === "chat_id"
      ? "feishu-app-chat-id"
      : "feishu-app-open-id";
    return sendOperationalAlertParts(parts, payload.title, entryTarget, (part) =>
      trySendFeishuAppTextMessage(credentials, target, { title: part.title, body: part.body, format: "post" }));
  }

  const pluginBotReadiness = resolveFeishuUserPluginBotReadiness();
  if (!pluginBotReadiness.enabled) {
    return {
      sent: false,
      target: "none",
      reason: [
        "Feishu operational alert delivery has no usable channel:",
        "FEISHU_APP_ID/FEISHU_APP_SECRET are not configured and no OpenClaw Feishu app account was found,",
        `and the legacy user-plugin bot channel is not ready either (${pluginBotReadiness.reason ?? "not ready"}).`
      ].join(" "),
      deliveries: []
    };
  }

  return sendOperationalAlertParts(parts, payload.title, "feishu-user-plugin-bot-post", async (part) => {
    try {
      const result = await sendFeishuUserPluginBotPost({ title: part.title, body: part.body });
      return { sent: result.sent, ...(result.reason ? { reason: result.reason } : {}) };
    } catch (error) {
      return { sent: false, reason: sanitizeNotificationError(error) };
    }
  });
}

interface OperationalAlertPart {
  title: string;
  body: string;
  index: number;
  parts: number;
}

/**
 * The whole body, in as few messages as the size limit allows. A body that is
 * empty after trimming is DISCLOSED as empty rather than sent as a blank
 * message - "no body" is a real (if degenerate) alert state, and a silent
 * blank message reads as a delivery problem instead of the caller's bug.
 */
function splitOperationalAlertBody(payload: OperationalAlertPayload): OperationalAlertPart[] {
  const body = payload.markdown.replace(/\r\n/gu, "\n").trim();
  const chunks = body
    ? splitMarkdownText(body, clampInteger(String(payload.maxSectionChars ?? ""), 200, 20_000, 3_600))
    : ["（本次告警没有正文，请查看 runner 日志。）"];
  return chunks.map((chunk, index) => ({
    title: chunks.length > 1 ? `${payload.title}（${index + 1}/${chunks.length}）` : payload.title,
    body: chunk,
    index,
    parts: chunks.length
  }));
}

// Stops at the first undelivered part and says which one: half an alert plus a
// reason naming the missing part is honest; reporting `sent: true` because the
// first message got through would hide the rest.
async function sendOperationalAlertParts(
  parts: OperationalAlertPart[],
  title: string,
  entryTarget: NotificationDeliveryTarget,
  send: (part: OperationalAlertPart) => Promise<{ sent: boolean; reason?: string }>
): Promise<OperationalAlertResult> {
  const deliveries: ReportDeliveryEntry[] = [];
  for (const part of parts) {
    const result = await send(part);
    deliveries.push({
      kind: part.index === 0 ? "summary" : "chapter",
      title: part.title,
      target: entryTarget,
      sent: result.sent,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(part.parts > 1 ? { chapter: 1, part: part.index + 1, parts: part.parts } : {})
    });
    if (!result.sent) {
      return {
        sent: false,
        target: entryTarget,
        reason: `运维告警未完整送达（第 ${part.index + 1}/${part.parts} 段「${title}」）：${result.reason ?? "unknown error"}`,
        deliveries
      };
    }
  }

  return { sent: true, target: entryTarget, deliveries };
}

// Retry policy matches every other app-credential send in this module
// (withNotificationRetry: transient network/5xx/429 only, never a 4xx).
async function trySendFeishuAppTextMessage(
  credentials: FeishuAppCredentials,
  target: FeishuAppTarget,
  payload: NotificationPayload
): Promise<{ sent: boolean; reason?: string }> {
  try {
    await withNotificationRetry(
      () => postFeishuAppMessage(credentials, target, payload),
      "feishu operational alert send"
    );
    return { sent: true };
  } catch (error) {
    return { sent: false, reason: sanitizeNotificationError(error) };
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

  await postFeishuAppMessage(credentials, appTarget, payload);

  return {
    sent: true,
    target: appTarget.targetType === "chat_id" ? "feishu-app-chat-id" : "feishu-app-open-id"
  };
}

// The one place that speaks im/v1/messages for a plain text/post message with
// the app's OWN tenant token. Shared by the degraded notification fallback
// (above) and the report delivery path (below) so both keep the same request
// shape, the same non-zero-code handling and the same error text. Throws on
// rejection; retry/sanitization policy is the caller's choice.
async function postFeishuAppMessage(
  credentials: FeishuAppCredentials,
  target: FeishuAppTarget,
  payload: NotificationPayload
): Promise<void> {
  const message = buildFeishuAppMessage(payload);
  const response = await fetch(
    `${resolveFeishuApiBase(credentials.domain ?? process.env.FEISHU_DOMAIN)}/open-apis/im/v1/messages?receive_id_type=${target.targetType}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${await fetchFeishuTenantAccessToken(credentials)}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        receive_id: target.targetId,
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

// Report delivery over the app's OWN tenant token (2026-07-26 fix; see
// deliverReportToFeishu's doc comment for the production failure this
// replaces). Same API surface directHttpCardTransport uses for cards.
//
// ONE interactive card per report (2026-07-28, spec drift CRIT-1/2; §0.2 飞书
// 只投递结论卡 + §1.1 深链). This path used to send the summary AND every
// chapter as "post" messages, with a comment declaring it deliberately
// bypassed the `shouldSendFullReportChapters()` policy because the retired
// PDF left the full text no other way to arrive. That reasoning was already
// obsolete when it was written - the platform app IS where the full text
// lives - and the cost was real: one live daily run pushed 10 Feishu
// messages, burying the conclusion the reader actually needed.
//
// So: the conclusion goes in the card, the body stays on the platform, and
// the button opens it. The policy is no longer bypassed anywhere - it now
// reads the same on all three channels (app credentials, legacy user-plugin,
// degraded fallback). splitReportIntoChapterMessages still serves those other
// two, which have no card transport of their own.
async function deliverReportViaAppCredentials(payload: ReportDeliveryPayload): Promise<ReportDeliveryResult> {
  const resolved = resolveReportDeliveryTarget(payload);
  if (!resolved) {
    return {
      sent: false,
      target: "none",
      reason: "No Feishu report target could be resolved. Pass `openId` on the report payload, set FEISHU_GROUP_CHAT_ID (public reports) / FEISHU_NOTIFY_OPEN_ID / FEISHU_NOTIFY_CHAT_ID, or DM the bot once to seed the stored target.",
      deliveries: []
    };
  }

  const target = resolved.target;
  const entryTarget: NotificationDeliveryTarget = target.targetType === "chat_id"
    ? "feishu-app-chat-id"
    : "feishu-app-open-id";
  const send = await sendInteractiveCard(
    buildReportConclusionCard(payload),
    target.targetType === "chat_id" ? { chatId: target.targetId } : { openId: target.targetId }
  );

  const result: ReportDeliveryResult = {
    sent: send.ok,
    // `target` names the channel that was USED (attempted), matching the
    // user-plugin branch above, so a failure still tells the caller where it
    // tried; `sent` is the only success signal.
    target: entryTarget,
    ...(resolved.groupFallback
      ? { groupFallback: true, groupFallbackReason: resolved.groupFallbackReason }
      : {}),
    deliveries: [{
      kind: "summary",
      title: payload.title,
      target: entryTarget,
      sent: send.ok,
      ...(send.messageId ? { detail: send.messageId } : {}),
      ...(send.error ? { reason: send.error } : {})
    }]
  };
  if (!send.ok) {
    result.reason = `结论卡未送达：${send.error ?? "unknown error"}`;
  }
  return result;
}

// How many bullets a conclusion card carries. A Feishu card is a glance
// surface: past a handful of lines the reader scrolls a card instead of
// opening the report, which is the failure this whole change is undoing.
const MAX_CARD_BULLETS = 5;

/**
 * The single card a report is delivered as: title, the window it covers, the
 * conclusion (with its confidence tier when the caller computed one), a few
 * bullets, and a button to the full text on the platform.
 *
 * Exported so the delivery orchestration and its tests build the exact same
 * card, and so nothing has to reach for a second, drifting copy of this shape.
 */
export function buildReportConclusionCard(payload: ReportDeliveryPayload): InteractiveCard {
  const markdown = payload.markdown.replace(/\r\n/gu, "\n");
  const lines: string[] = [];

  const windowLine = markdown.split("\n").map((line) => line.trim()).find((line) => /^窗口：/u.test(line));
  if (windowLine) {
    lines.push(windowLine);
  }

  const headline = payload.conclusion?.headline.trim();
  if (headline) {
    lines.push(`**结论**：${headline}`);
  }
  const confidence = payload.conclusion?.confidence?.trim();
  if (confidence) {
    lines.push(`**置信度**：${confidence}`);
  }

  const sourceBullets = payload.conclusion?.bullets.length
    ? payload.conclusion.bullets
    : extractActionableSummaryBullets(markdown);
  lines.push(...sourceBullets
    .map((bullet) => bullet.trim())
    .filter(Boolean)
    .slice(0, MAX_CARD_BULLETS)
    .map((bullet) => (bullet.startsWith("-") ? bullet : `- ${bullet}`)));

  const href = resolveReportDeepLink(payload);
  if (lines.length === 0) {
    // Honest empty state (§0.4): say the card has nothing rather than pad it.
    lines.push("本次报告未提取到可摘要的结论要点，请在平台查看全文。");
  } else if (!href) {
    lines.push("（本部署未配置平台公开地址，请在平台查看全文）");
  }

  return {
    title: payload.title,
    lines,
    ...(href ? { url: { text: "查看完整报告", href } } : {})
  };
}

// A link only when the caller named BOTH the page kind and the id. Anything
// else - a missing field, an id buildDeepLink rejects, an unconfigured base
// url - degrades to a button-free card, because a link that looks right and
// opens the wrong page is worse than no link at all.
function resolveReportDeepLink(payload: ReportDeliveryPayload): string | null {
  const kind = payload.reportKind;
  const id = payload.reportDate?.trim();
  if (!kind || !id) {
    return null;
  }

  try {
    return buildDeepLink(kind, id);
  } catch {
    return null;
  }
}

interface ResolvedReportTarget {
  target: FeishuAppTarget;
  groupFallback?: boolean;
  groupFallbackReason?: string;
}

/**
 * Who gets this report card (§4 群/单聊分工):
 *
 *   1. `openId` on the payload - an owner-scoped report (个人页/个股分析/个人
 *      复盘). Wins over everything, including `audience: "group"`, so private
 *      content can never be routed into the shared group by a caller that set
 *      both.
 *   2. `audience: "group"` + `FEISHU_GROUP_CHAT_ID` - the public report card
 *      lands in the circle's group chat.
 *   3. `audience: "group"` with no group configured - the card still ships, to
 *      whatever the global target is, and the caller is told (groupFallback)
 *      so the run log shows a public report that did not reach the group.
 *   4. otherwise - the global target, exactly as before.
 *
 * Wrapped in try/catch because resolveFeishuAppTarget touches sqlite and the
 * filesystem, and report delivery must degrade rather than throw.
 */
function resolveReportDeliveryTarget(payload: ReportDeliveryPayload): ResolvedReportTarget | null {
  const openId = payload.openId?.trim();
  if (openId) {
    return {
      target: {
        targetType: "open_id",
        targetId: openId,
        source: "report-payload:openId"
      }
    };
  }

  if (payload.audience === "group") {
    const groupChatId = process.env.FEISHU_GROUP_CHAT_ID?.trim();
    if (groupChatId) {
      return {
        target: {
          targetType: "chat_id",
          targetId: groupChatId,
          source: "env:FEISHU_GROUP_CHAT_ID"
        }
      };
    }

    const fallback = tryResolveGlobalFeishuTarget();
    if (!fallback) {
      return null;
    }

    return {
      target: fallback,
      groupFallback: true,
      groupFallbackReason: `未配置 FEISHU_GROUP_CHAT_ID，公共报告卡改发默认目标（${fallback.targetType === "chat_id" ? "会话" : "单聊"}，来源 ${fallback.source}），群里本次没有收到发布卡。`
    };
  }

  const target = tryResolveGlobalFeishuTarget();
  return target ? { target } : null;
}

function tryResolveGlobalFeishuTarget(): FeishuAppTarget | null {
  try {
    return resolveFeishuAppTarget();
  } catch {
    return null;
  }
}

// deliverReportViaFallback can throw (sendFallbackNotification rejects a
// non-2xx webhook), and deliverReportToFeishu must not.
async function tryDeliverReportViaFallback(
  payload: ReportDeliveryPayload,
  primaryError?: string
): Promise<ReportDeliveryResult> {
  try {
    return await deliverReportViaFallback(payload, primaryError);
  } catch (error) {
    return {
      sent: false,
      target: "none",
      reason: `Degraded Feishu report fallback failed: ${sanitizeNotificationError(error)}${primaryError ? ` (primary error: ${primaryError})` : ""}`,
      deliveries: []
    };
  }
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

/**
 * Feishu never carries a report body. The reader gets one conclusion card
 * (buildReportConclusionCard) and reads the full text on the platform.
 *
 * Constant `false` on purpose: FEISHU_REPORT_DELIVERY_MODE=full used to turn
 * chapter fan-out back on, and the app-credential path used to skip this
 * check outright. Both are gone (2026-07-28) - there is no supported way to
 * push a report body into a chat any more, so this is the whole policy.
 */
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
    if (result.isError || isFeishuProseFailure(detail)) {
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
    if (result.isError || isFeishuProseFailure(detail)) {
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
    // Item 6 (task P2.5 Task 6): this was the one remaining call site that
    // checked a narrower `/^error:/iu` directly instead of routing through
    // isFeishuProseFailure - a "Send failed: ..." prose response (a real
    // feishu-user-plugin shape, see that helper's own doc comment) fell
    // through undetected and was reported as a successful PDF delivery.
    if (sent.isError || isFeishuProseFailure(detail)) {
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

// Direct tenant-token HTTP transport (2026-07-18 live-send fix): the legacy
// default routed cards through the feishu-user-plugin MCP subprocess - a
// DIFFERENT Feishu app with its own credentials - and passed an open_id where
// that tool expects a chat_id. Cards therefore could never deliver from the
// production app (live probe: HTTP 400 code=230001 invalid receive_id, while
// a direct im/v1/messages send with FEISHU_APP_ID/SECRET succeeded). This
// transport sends with the app's OWN tenant token via the same API surface
// the text-notification path above already uses.
export const directHttpCardTransport: CardTransport = {
  async sendCard(target, cardJson) {
    const credentials = resolveFeishuAppCredentials();
    if (!credentials) {
      return { ok: false, error: "FEISHU_APP_ID / FEISHU_APP_SECRET are not configured for direct card send." };
    }
    const targetType: "open_id" | "chat_id" = target.chatId ? "chat_id" : "open_id";
    const targetId = target.chatId ?? target.openId;
    if (!targetId) {
      return { ok: false, error: "Interactive card target needs a chatId or openId." };
    }
    try {
      return await withNotificationRetry(async () => {
        const response = await fetch(
          `${resolveFeishuApiBase(credentials.domain ?? process.env.FEISHU_DOMAIN)}/open-apis/im/v1/messages?receive_id_type=${targetType}`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${await fetchFeishuTenantAccessToken(credentials)}`,
              "content-type": "application/json; charset=utf-8"
            },
            body: JSON.stringify({
              receive_id: targetId,
              msg_type: "interactive",
              content: JSON.stringify(cardJson)
            })
          }
        );
        const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        if (!response.ok || !body || Number(body.code ?? 0) !== 0) {
          const reason = body && typeof body.msg === "string" ? body.msg : `${response.status} ${response.statusText}`;
          throw new Error(`Feishu card send rejected: ${reason}`);
        }
        const data = body.data as { message_id?: unknown } | undefined;
        const messageId = typeof data?.message_id === "string" ? data.message_id : undefined;
        return { ok: true, ...(messageId ? { messageId } : {}) };
      }, "feishu direct card send");
    } catch (error) {
      return { ok: false, error: sanitizeNotificationError(error) };
    }
  },
  async updateCard(messageId, cardJson) {
    const credentials = resolveFeishuAppCredentials();
    if (!credentials) {
      return { ok: false, error: "FEISHU_APP_ID / FEISHU_APP_SECRET are not configured for direct card update." };
    }
    try {
      return await withNotificationRetry(async () => {
        const response = await fetch(
          `${resolveFeishuApiBase(credentials.domain ?? process.env.FEISHU_DOMAIN)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
          {
            method: "PATCH",
            headers: {
              authorization: `Bearer ${await fetchFeishuTenantAccessToken(credentials)}`,
              "content-type": "application/json; charset=utf-8"
            },
            body: JSON.stringify({ content: JSON.stringify(cardJson) })
          }
        );
        const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
        if (!response.ok || !body || Number(body.code ?? 0) !== 0) {
          const reason = body && typeof body.msg === "string" ? body.msg : `${response.status} ${response.statusText}`;
          throw new Error(`Feishu card update rejected: ${reason}`);
        }
        return { ok: true };
      }, "feishu direct card update");
    } catch (error) {
      return { ok: false, error: sanitizeNotificationError(error) };
    }
  }
};

// Legacy transport reuses the feishu-user-plugin MCP subprocess channel
// (see callFeishuUserPluginTool below) - a different Feishu app entirely.
// Kept ONLY as the no-credentials fallback so pre-P10 dev setups keep their
// old behavior; production (FEISHU_APP_ID/SECRET configured) must never use
// it for cards.
const legacyMcpCardTransport: CardTransport = {
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
        if (result.isError || isFeishuProseFailure(detail)) {
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
        // update_message has no distinct prose-failure convention of its own in
        // this codebase (it's the only update_message call site); the same
        // send_message_as_bot prose checks are applied here for consistency.
        if (result.isError || isFeishuProseFailure(detail)) {
          throw new Error(detail || "feishu-user-plugin returned an error response.");
        }
        return { ok: true };
      }, "feishu-user-plugin card update");
    } catch (error) {
      return { ok: false, error: sanitizeNotificationError(error) };
    }
  }
};

// Default: the direct app-credential transport whenever the app credentials
// resolve (env or openclaw.json); the legacy MCP subprocess only when they
// don't. Chosen per call (not at module load) so env changes in tests and
// long-lived processes are honored.
const defaultCardTransport: CardTransport = {
  sendCard(target, cardJson) {
    const transport = resolveFeishuAppCredentials() ? directHttpCardTransport : legacyMcpCardTransport;
    return transport.sendCard(target, cardJson);
  },
  updateCard(messageId, cardJson) {
    const transport = resolveFeishuAppCredentials() ? directHttpCardTransport : legacyMcpCardTransport;
    return transport.updateCard(messageId, cardJson);
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

// feishu-user-plugin can report failure as prose in its text response without
// setting isError (e.g. "Send failed: ..." or "Error: ..."), so every tool
// call site that inspects extractMcpText's output must also check this.
export function isFeishuProseFailure(detail: string): boolean {
  return /^send failed\b/iu.test(detail) || /^error:/iu.test(detail);
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
    // Neither the retired PDF (§0.4) nor a chapter message follows this
    // summary on any channel any more, so the honest pointer is the platform.
    ...(bullets.length > 0 ? bullets : ["- 报告没有提取到可行动摘要，请在平台查看全文并人工复核。"])
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
