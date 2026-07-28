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

/**
 * WHO a report card is allowed to reach - DECLARED by the producer, never
 * inferred by the delivery layer (2026-07-28 spec drift R2).
 *
 * The previous rule was "a payload with an `openId` is owner-private". That is
 * a routing field, not a statement of intent, and the 模拟盘收支变化 report
 * walked straight through it: it is every bit as owner-private as a member's
 * personal page (its platform page 403s anyone but the account's owner), but it
 * carried `audience: "dm"` and NO `openId`, so on the legacy shared-chat
 * channel it was published to the whole circle and recorded `sent: true`. The
 * verifier captured the group message: 「QQQ.US：数量 1，成本 663.88 USD…」.
 *
 * The union is the point: `owner-private` cannot be constructed without naming
 * the owner it is private TO. A producer that knows content belongs to one
 * member but cannot name their Feishu id says `owner-unresolved` WITH the
 * reason, and delivery fails closed - it never degrades into "send it
 * somewhere".
 *
 * A `visibility` OUTSIDE this union fails closed too (2026-07-28 R4, C12):
 * refused on every channel, loudly, never read as public. That matters because
 * these strings are written by hand in .mjs producers that `tsc` never sees -
 * this union constrains nothing at their call sites, so the value is checked
 * where it is consumed (`classifyReportScope`) instead.
 */
export type ReportScope =
  /**
   * 圈子公开: the whole circle may read it (日报/周报 发布卡, 个股分析 -
   * requirements §1.2「个股分析是公共资产，谁都能看」). May go to the group
   * chat, and is the ONLY thing a fixed-shared-chat channel will carry.
   */
  | { visibility: "circle-public" }
  /**
   * 归属单一成员: only this member may read it (个人页摘要、个股/个人复盘、
   * 模拟盘收支变化). `ownerOpenId` is that member's Feishu open_id and is
   * REQUIRED - an owner-private card with no addressable owner is not a
   * routing decision to be made later, it is undeliverable.
   */
  | { visibility: "owner-private"; ownerOpenId: string }
  /**
   * 归属单一成员，但成员无法定位: the content belongs to exactly one owner and
   * the producer could not resolve who / how to reach them. `reason` is shown
   * to the operator verbatim. Always refused, on every channel - guessing a
   * recipient for owner-private content is the failure this type exists to
   * make impossible.
   */
  | { visibility: "owner-unresolved"; reason: string };

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
   * WHO may read this report. REQUIRED in effect, though the type cannot say
   * so: `deliverReportToFeishu` refuses any payload that reaches it without a
   * visibility declaration, on every channel, before a target is chosen.
   *
   * Optional here only because two older signals still count as declarations -
   * `openId` (owner-private to that member) and `audience: "group"`
   * (circle-public), which is how scheduled-report.mjs's two call sites work
   * unchanged. Anything with none of the three is `undeliverable`.
   *
   * Why a runtime refusal and not a required field: every producer is a plain
   * .mjs script under apps/openclaw-config, which has no package.json and no
   * tsconfig and is not part of `pnpm typecheck` (that runs over
   * shared-types + platform-app + broker-executor + longbridge-cli only). A
   * required property there would be a promise nothing checks. This guard is
   * the only thing that actually holds, so it lives at the call boundary and
   * fails closed.
   */
  scope?: ReportScope;
  /**
   * Per-owner Feishu open_id: WHERE the card goes.
   *
   * @deprecated as a privacy signal. Declare `scope` instead. Setting this
   * alone is still honored as `{visibility: "owner-private", ownerOpenId}` so
   * the pre-2026-07-28 personal-page callers keep working unchanged, but a
   * routing field cannot express "there is no one to route to", which is
   * exactly the case that leaked. Setting both `scope` and a CONTRADICTING
   * `openId` is refused rather than silently resolved.
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
   *             (`FEISHU_GROUP_CHAT_ID`). With no group configured the card is
   *             NOT sent: it used to fall back to the global DM/notify target,
   *             which on a deployment like the mini means a 公共资产 landing in
   *             one person's private chat under a `sent: true` result. The
   *             result now carries `sent: false` plus `groupFallback`.
   *   "dm" (default) - 个人通道：个人页摘要、提醒、审批、复盘。
   *
   * NOT a privacy signal. `audience: "dm"` says "this is not the group's
   * publication card"; it does NOT say the content is owner-private, and the
   * 模拟盘 report proved the difference matters - it declared "dm", named no
   * owner, and was published to the group by a channel that has no DM to
   * offer. Declare `scope` for that. `audience: "group"` IS read as
   * `circle-public` when no `scope` is given, since it is an explicit
   * statement about the shared surface.
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
   * has no `FEISHU_GROUP_CHAT_ID`, so the circle did not get the card.
   *
   * The name is older than the behavior: until 2026-07-29 this meant "we sent
   * it somewhere else instead" and rode along on a `sent: true` result. It now
   * always accompanies `sent: false` - the card is not sent at all, because the
   * somewhere-else was one person's DM. The field is kept because it is still
   * the signal both producers record (scheduled-report.mjs and
   * stock-analysis.mjs write it into the state file and the stdout envelope),
   * and it still answers the same question: did the circle get this or not?
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

/**
 * Who a card is addressed to. `chatId`/`openId` name one conversation or one
 * member; `operator: true` asks the transport to resolve the DEPLOYMENT's own
 * operator target instead (see resolveDirectCardTarget). The flag is required
 * rather than inferred from an empty object, so a caller whose member id came
 * back undefined gets a refusal instead of a redirect - see that function's
 * note for why that distinction is load-bearing.
 */
export interface CardTarget {
  chatId?: string;
  openId?: string;
  operator?: boolean;
}

export interface CardTransport {
  sendCard(
    target: CardTarget,
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
  // Before any channel is chosen: a payload that declares owner-private
  // content with no reachable owner - or declares NOTHING AT ALL (2026-07-28
  // R3) - is undeliverable on ALL of them, and the honest answer is a refusal
  // with the producer's own reason, not a card sent to whoever the
  // deployment's default target happens to be. `scope` is narrowed to
  // DeliverableReportScope from here down, so the channels below cannot
  // reintroduce a per-channel opinion about an undeclared report.
  const scope = classifyReportScope(payload);
  if (scope.kind === "undeliverable") {
    return { sent: false, target: "none", reason: scope.reason, deliveries: [] };
  }

  const credentials = resolveFeishuAppCredentials();
  if (credentials) {
    try {
      return await deliverReportViaAppCredentials(payload, scope);
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
      return tryDeliverReportViaFallback(payload, scope, pluginBotReadiness.reason);
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
    return await deliverReportViaUserPlugin(payload, scope);
  } catch (error) {
    const primaryError = sanitizeNotificationError(error);
    if (allowReportFallbackDelivery()) {
      return tryDeliverReportViaFallback(payload, scope, primaryError);
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
 * Alerts always go to the deployment's global/ops target, which is why
 * `OperationalAlertPayload` has no `ReportScope` and no `openId`: an alert is
 * addressed to whoever OPERATES the runner, not to a member who owns content.
 * The 2026-07-28 R2 audit walked every call site of this function and of
 * deliverReportToFeishu; the only producer here is openclaw-cron-runner.mjs
 * (cron failures, halt escalations, discovery gaps, state-persistence
 * failures), none of which carry one member's private data. If an alert ever
 * needs to, it must become a report with a declared scope rather than growing
 * a second, weaker privacy story on this side.
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

/**
 * The deployment's global Feishu target, or null if nothing is configured.
 *
 * Wrapped in try/catch because resolveFeishuAppTarget touches sqlite and the
 * filesystem, and alert delivery must degrade rather than throw.
 *
 * Callers: operational ALERTS only. Report delivery deliberately does not use
 * this - see resolveReportDeliveryTarget. An alert is addressed to whoever runs
 * the deployment, so "the global target" is the right answer for it; a
 * circle-public report is addressed to the circle, and answering that with the
 * operator's DM is how 日报/周报/个股分析 all ended up in one person's private
 * chat while reporting success.
 */
function tryResolveGlobalFeishuTarget(): FeishuAppTarget | null {
  try {
    return resolveFeishuAppTarget();
  } catch {
    return null;
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

// Unreachable today: allowReportFallbackDelivery() is a constant `false`, so
// nothing calls this. It posts to FEISHU_WEBHOOK_URL or the global app target
// and, like the legacy user-plugin channel, cannot address one member's DM - so
// it enforces the SAME rule, through the same
// refuseNonPublicOnSharedChatChannel the user-plugin tests exercise. Sharing
// the decision rather than re-implementing it here is deliberate: only the call
// site is unreachable, the behavior itself is covered.
async function deliverReportViaFallback(
  payload: ReportDeliveryPayload,
  scope: DeliverableReportScope,
  primaryError?: string
): Promise<ReportDeliveryResult> {
  const refusal = refuseNonPublicOnSharedChatChannel(
    scope,
    "feishu-webhook",
    "degraded FEISHU_WEBHOOK_URL / global app target"
  );
  if (refusal) {
    return refusal;
  }

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
async function deliverReportViaAppCredentials(
  payload: ReportDeliveryPayload,
  scope: DeliverableReportScope
): Promise<ReportDeliveryResult> {
  const resolved = resolveReportDeliveryTarget(scope);
  if (!resolved.ok) {
    // An owner-private report always resolves (its own ownerOpenId), so the
    // ONLY way to land here is a circle-public report on a deployment with no
    // FEISHU_GROUP_CHAT_ID - which IS the deploy target's shape today (the
    // mini has no such variable and one stored open_id target), and used to be
    // the branch that quietly DM'd the operator instead of refusing.
    //
    // Logged as well as returned: this is a configuration gap, not a transient
    // send failure, and making it visible must not depend on the caller
    // choosing to print `reason`. `groupFallback` is still set so the two
    // producers that record it (scheduled-report.mjs, stock-analysis.mjs) keep
    // naming the circle in their state file and stdout envelope - it now sits
    // beside `sent: false` rather than dissenting from `sent: true`.
    console.error(`notifications: ${resolved.reason} (report: ${payload.title})`);
    return {
      sent: false,
      target: "none",
      reason: resolved.reason,
      groupFallback: true,
      groupFallbackReason: resolved.groupFallbackReason,
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

  const link = resolveReportDeepLink(payload);
  if (lines.length === 0) {
    // Honest empty state (§0.4): say the card has nothing rather than pad it.
    lines.push("本次报告未提取到可摘要的结论要点，请在平台查看全文。");
  }
  if (link.href === null) {
    lines.push(link.disclosure);
  }

  return {
    title: payload.title,
    lines,
    ...(link.href ? { url: { text: "查看完整报告", href: link.href } } : {})
  };
}

/**
 * Either an absolute platform link, or `null` plus the reason THIS card has no
 * button. A link only when the caller named BOTH the page kind and the id;
 * anything else degrades to a button-free card, because a link that looks
 * right and opens the wrong page is worse than no link at all.
 *
 * 2026-07-28 (spec drift A2, sibling defect). Three unrelated causes used to
 * collapse into one hard-coded line, 「（本部署未配置平台公开地址，请在平台查看
 * 全文）」, so a caller that simply forgot reportKind (which is exactly what
 * stock-analysis.mjs and official-paper-monitor.mjs had done) produced a card
 * blaming the deployment's configuration - pointing whoever read it at the
 * wrong fix entirely. Each cause now names itself.
 */
type ReportDeepLink =
  | { href: string; disclosure?: undefined }
  | { href: null; disclosure: string };

function resolveReportDeepLink(payload: ReportDeliveryPayload): ReportDeepLink {
  const kind = payload.reportKind;
  const id = payload.reportDate?.trim();
  if (!kind || !id) {
    return { href: null, disclosure: "（本次报告未指定平台页面，无法生成链接；请在平台查看全文）" };
  }

  let href: string | null;
  try {
    href = buildDeepLink(kind, id);
  } catch (error) {
    // A kind buildDeepLink does not know, or an id it rejects. Reaches here at
    // runtime because the report callers are plain .mjs with no compiler in the
    // way, so the actual message is the only thing that identifies the typo.
    return {
      href: null,
      disclosure: `（无法生成报告链接：${sanitizeNotificationError(error).slice(0, 120)}；请在平台查看全文）`
    };
  }

  return href === null
    ? { href: null, disclosure: "（本部署未配置平台公开地址 PLATFORM_PUBLIC_BASE_URL，请在平台查看全文）" }
    : { href };
}

/**
 * What `classifyReportScope` decided.
 *
 * There is no `undeclared` member any more (2026-07-28 R3). It used to be a
 * state of its own that each channel then had to have an opinion about, and the
 * two channels disagreed: the shared-chat ones refused it, the app-credential
 * one delivered it to whatever the global target was. 个股分析 fell exactly into
 * that gap - it declared nothing, so it was DM'd to the operator on one channel
 * and dropped on the other, and neither outcome was anybody's intent. "The
 * producer did not say" is now simply `undeliverable`: one answer, identical on
 * every channel, with a reason that names what to declare.
 */
type ReportScopeDecision =
  | { kind: "circle-public" }
  | { kind: "owner-private"; ownerOpenId: string }
  | { kind: "undeliverable"; reason: string };

/**
 * A scope a channel is allowed to see. `deliverReportToFeishu` returns on
 * `undeliverable` BEFORE picking a channel, so every function below it takes
 * this narrowed type - which makes "an undeclared or undeliverable report
 * reached a transport" a compile error inside this package rather than a rule
 * each channel has to remember.
 */
type DeliverableReportScope = Exclude<ReportScopeDecision, { kind: "undeliverable" }>;

/**
 * Every visibility a producer may declare, mapped to the text an operator is
 * shown when a payload declares something else.
 *
 * `Record<ReportScope["visibility"], string>` is the whole point: adding a
 * member to `ReportScope` without adding it here is a COMPILE ERROR, so the
 * accepted-values list an operator reads can never drift from the values
 * delivery actually accepts. Together with the exhaustive `switch` in
 * `classifyReportScope` (whose default branch takes `never`), a new
 * `ReportScope` member cannot be added without deciding, in both places, how
 * it routes and how it is described.
 */
const REPORT_SCOPE_VISIBILITY_HELP: Record<ReportScope["visibility"], string> = {
  "circle-public": '{visibility:"circle-public"}（圈子公开，可进群发布卡）',
  "owner-private": '{visibility:"owner-private", ownerOpenId}（归属某位成员，只发 TA 的单聊）',
  "owner-unresolved": '{visibility:"owner-unresolved", reason}（归属某位成员但无法定位收件人，不投递）'
};

/**
 * A `scope` whose `visibility` is not one of `ReportScope`'s members - a typo,
 * a value from a newer producer than this build, or a `scope` that is not even
 * an object. UNDELIVERABLE, and loudly (2026-07-28 R4, C12).
 *
 * This branch used to fall out of the bottom of `classifyReportScope` as
 * `{kind: "circle-public"}` - the MOST permissive verdict of the three. Measured
 * against a built dist with real `deliverReportToFeishu`, a stubbed fetch and
 * FEISHU_GROUP_CHAT_ID set, a 模拟盘收支变化 body declaring
 * `{visibility: "owner_private", ownerOpenId}` (one underscore for one hyphen)
 * published 「QQQ.US：数量 1，成本 663.88 USD」 to the circle's group chat and
 * returned `sent: true`. An unrecognized value is precisely the case where the
 * delivery layer knows LEAST about who may read the body, so it must be the most
 * conservative outcome, not the least.
 *
 * `scope: never` is the compile-time half: it only typechecks while every
 * `ReportScope` member has its own `case` above, so a new member added to the
 * union breaks the build here instead of silently inheriting this refusal.
 *
 * The `console.error` is deliberate, and it is the only one in this module.
 * Every other `undeliverable` is a legitimate state of the DATA that the
 * producer is expected to report (official-paper-monitor prints its
 * owner-unresolved reason, stock-analysis exits non-zero). This one is a DEFECT
 * IN THE PRODUCER that no compiler will ever catch - every report producer is a
 * plain .mjs outside `pnpm typecheck`, and official-paper-monitor.mjs writes
 * these visibility strings by hand - so it must reach the runner's stderr even
 * if the caller drops the result on the floor.
 *
 * Only the `visibility` value is echoed back, never the rest of the scope or
 * the body: this refusal is read by whoever operates the run, and the payload
 * it is refusing may be exactly the owner-private content that must not spread.
 */
function refuseUnrecognizedVisibility(
  payload: ReportDeliveryPayload,
  scope: never
): ReportScopeDecision {
  const raw = (scope as { visibility?: unknown } | null | undefined)?.visibility;
  const declared = raw === undefined
    ? "（scope 上没有 visibility 字段）"
    : JSON.stringify(raw)?.slice(0, 80) ?? String(raw).slice(0, 80);
  const reason = [
    `报告「${payload.title}」的 scope.visibility 是 ${declared}，不是可识别的可见范围，因此不投递。`,
    "无法识别的声明恰恰是最不该猜的情况——按公开处理会把可能归属某位成员的内容发进群，",
    "所以一律拒绝。请在生产方改成以下之一：",
    Object.values(REPORT_SCOPE_VISIBILITY_HELP).join("；"),
    "。"
  ].join("");

  console.error(
    `[notifications] REFUSED report delivery: unrecognized scope.visibility ${declared} on 「${payload.title}」. ${reason}`
  );

  return { kind: "undeliverable", reason };
}

/**
 * Read the producer's declaration off the payload (see `ReportScope`).
 *
 * Precedence, and why:
 *   1. `scope` - the declaration. Nothing overrides it; a `scope` that
 *      disagrees with `openId` is a contradiction the delivery layer refuses
 *      instead of picking a winner, because either choice could be the leak.
 *      A `scope` whose `visibility` is not a member of `ReportScope` is
 *      refused too (`refuseUnrecognizedVisibility`) - never read as public.
 *   2. `openId` with no `scope` - the legacy signal, read as owner-private to
 *      that member. Every pre-2026-07-28 owner-scoped caller (personal-page
 *      cards) works unchanged.
 *   3. `audience: "group"` with no `scope` - an explicit statement about the
 *      shared surface, read as circle-public.
 *   4. anything else - UNDELIVERABLE, on every channel (2026-07-28 R3). Not
 *      "assume private", not "send it to the default target": a producer that
 *      said nothing has not been read, so there is no honest recipient to pick,
 *      and picking one silently is precisely how 个股分析 spent two rounds being
 *      DM'd to the operator instead of published to the circle.
 */
function classifyReportScope(payload: ReportDeliveryPayload): ReportScopeDecision {
  const routingOpenId = payload.openId?.trim() ?? "";
  const scope = payload.scope;

  if (scope) {
    // A switch, not an if-chain, and every member has its own `case`: the
    // default branch below narrows `scope` to `never` only while that stays
    // true, which is what forces a future ReportScope member to be routed here
    // rather than inheriting whichever branch happens to be last (2026-07-28
    // R4, C12 - "whichever branch happens to be last" was circle-public).
    switch (scope.visibility) {
      case "owner-unresolved":
        return {
          kind: "undeliverable",
          reason: [
            `报告「${payload.title}」声明为单一成员私有，但生产方无法确定归属成员，因此不投递：${scope.reason}`,
            "（内容仍在平台上按归属做了访问控制；把它发给默认目标会把某个成员的账户内容给错人。）"
          ].join("")
        };

      case "owner-private": {
        const ownerOpenId = scope.ownerOpenId?.trim() ?? "";
        if (ownerOpenId === "") {
          return {
            kind: "undeliverable",
            reason: `报告「${payload.title}」声明为单一成员私有（scope.visibility="owner-private"），但 ownerOpenId 为空，没有可投递的对象。请改用 {visibility:"owner-unresolved", reason} 说明原因，或补上该成员的飞书 open_id。`
          };
        }
        if (routingOpenId !== "" && routingOpenId !== ownerOpenId) {
          return {
            kind: "undeliverable",
            reason: `报告「${payload.title}」自相矛盾：scope 声明归属 ${ownerOpenId}，payload.openId 却指向 ${routingOpenId}。两者都可能是正确的收件人，投递任何一方都可能把私有内容发错人，因此拒绝。`
          };
        }
        return refuseMalformedOwnerOpenId(payload, ownerOpenId, "scope.ownerOpenId")
          ?? { kind: "owner-private", ownerOpenId };
      }

      case "circle-public":
        if (routingOpenId !== "") {
          return {
            kind: "undeliverable",
            reason: `报告「${payload.title}」自相矛盾：scope 声明为圈子公开（circle-public），却又用 payload.openId 指定了单个成员 ${routingOpenId}。公开卡不该定向发给一个人，定向卡也不该按公开处理，因此拒绝。`
          };
        }
        return { kind: "circle-public" };

      default:
        return refuseUnrecognizedVisibility(payload, scope);
    }
  }

  if (routingOpenId !== "") {
    return refuseMalformedOwnerOpenId(payload, routingOpenId, "payload.openId")
      ?? { kind: "owner-private", ownerOpenId: routingOpenId };
  }
  if (payload.audience === "group") {
    return { kind: "circle-public" };
  }
  return {
    kind: "undeliverable",
    reason: [
      `报告「${payload.title}」没有声明可见范围，因此不投递：payload 上既没有 scope，`,
      '也没有 openId 或 audience:"group" 这两个旧信号，无法判断这份内容可以给谁看。',
      "请在生产方补上 scope：公共报告用 {visibility:\"circle-public\"}，",
      "归属某位成员用 {visibility:\"owner-private\", ownerOpenId}，",
      "知道归属但找不到收件人用 {visibility:\"owner-unresolved\", reason}。"
    ].join("")
  };
}

/**
 * The one shape check on an owner id, applied to BOTH the declared
 * `scope.ownerOpenId` and the legacy `payload.openId` routing field. A Feishu
 * open_id is `ou_` followed by the account's opaque suffix; an `oc_` chat id,
 * an `on_` union id, an internal member id or an email in this field is a
 * producer bug, and such a report must not be handed to a transport as though
 * the string named a person.
 *
 * MEASURED (2026-07-28 R5, against the built dist, FEISHU_APP_ID/SECRET set):
 * before this guard, `scope: {visibility: "owner-private", ownerOpenId:
 * "oc_public_group"}` returned `sent: true` after POSTing im/v1/messages with
 * `receive_id_type=open_id receive_id=oc_public_group`; the legacy
 * `openId: "oc_public_group"` form behaved identically. So a chat id really did
 * go out on the wire addressed as a person, and the run log recorded it as
 * delivered.
 *
 * INFERRED, NOT MEASURED: that Feishu rejects such a send rather than
 * delivering it into that chat. The only supporting evidence in this repo is
 * the 2026-07-18 live probe recorded on directHttpCardTransport below - HTTP
 * 400 code=230001 invalid receive_id - and that was a DIFFERENT mismatched id
 * on the same endpoint, not this one. Nobody has sent an `oc_` id as an
 * open_id at Feishu and watched what came back. This guard exists so the
 * outcome stops depending on that inference: the refusal is local, named, and
 * happens before any send.
 *
 * The `ou_` rule is Feishu's documented open_id format. Corroboration on the
 * deploy target: its single linked member's stored id has the `ou_` prefix
 * (read-only check, prefix only - no id values were read or printed).
 */
function refuseMalformedOwnerOpenId(
  payload: ReportDeliveryPayload,
  ownerOpenId: string,
  field: "scope.ownerOpenId" | "payload.openId"
): ReportScopeDecision | null {
  if (/^ou_.+/u.test(ownerOpenId)) {
    return null;
  }

  return {
    kind: "undeliverable",
    reason: [
      `报告「${payload.title}」声明归属某位成员，但 ${field} 的值「${ownerOpenId}」不是飞书 open_id`,
      "（open_id 形如 ou_xxx；oc_ 是会话 id，on_ 是 union_id）。",
      "把它当作 open_id 发出去会把该成员的私有内容投给一个身份不明的收件人，因此在本地直接拒绝、不做任何发送。",
      "请在生产方改用该成员真实的飞书 open_id，或改用 {visibility:\"owner-unresolved\", reason} 说明找不到收件人。"
    ].join("")
  };
}

/**
 * The refusal a channel with ONE fixed shared chat owes a payload it cannot
 * safely carry. `null` means "this is declared circle-public, ship it" - the
 * only case such a channel may deliver.
 *
 * Shared by the legacy user-plugin channel and the degraded webhook/app
 * fallback. The fallback's call site is unreachable today
 * (`allowReportFallbackDelivery()` is a constant `false`), which is why the
 * rule lives HERE rather than being re-implemented there: the behavior is
 * covered by the user-plugin tests, and the fallback gets the identical,
 * already-exercised decision rather than a fresh untested guess.
 */
function refuseNonPublicOnSharedChatChannel(
  scope: DeliverableReportScope,
  target: NotificationDeliveryTarget,
  chatDescription: string
): ReportDeliveryResult | null {
  if (scope.kind === "circle-public") {
    return null;
  }

  return {
    sent: false,
    target,
    reason: [
      `Refused on the shared-chat channel (${chatDescription}): it can only post to that one chat and cannot address a single member.`,
      `这份报告归属成员 ${scope.ownerOpenId}，投递出去等于把 TA 的私有内容公开给该会话里的所有人。`,
      "Configure FEISHU_APP_ID/FEISHU_APP_SECRET (or an OpenClaw Feishu app account) so per-owner DMs can be addressed."
    ].join(" "),
    deliveries: []
  };
}

type ReportTargetResolution =
  | { ok: true; target: FeishuAppTarget }
  | { ok: false; reason: string; groupFallbackReason: string };

/**
 * Who gets this report card (§4 群/单聊分工), decided from the DECLARED scope
 * (`classifyReportScope`) rather than from whichever routing field happens to
 * be set:
 *
 *   1. `owner-private` - that member's own DM. Nothing can override it, so
 *      private content can never be routed into the shared group. Always
 *      resolves; `scope.ownerOpenId` is the target.
 *   2. `circle-public` + `FEISHU_GROUP_CHAT_ID` - the circle's group chat.
 *   3. `circle-public` with no group configured - REFUSED. Nothing is sent.
 *
 * There is no fourth case. Until 2026-07-28 R3 an undeclared payload fell
 * through to the global notify/ops target here, and that branch is what sent
 * 个股分析 - a 公共资产 - to the operator's DM while FEISHU_GROUP_CHAT_ID sat
 * configured and unused, reporting a clean delivery. Undeclared is now refused
 * upstream, so the only two things that reach this function are the two the
 * type admits.
 *
 * WHY (3) IS A REFUSAL AND NOT A FALLBACK (2026-07-29, J2)
 * -------------------------------------------------------
 * It used to ship the card to whatever `resolveFeishuAppTarget()` returned and
 * report `sent: true` with a `groupFallback` flag attached. Measured against
 * the deploy target's real shape that is not a degraded delivery, it is a
 * delivery to the wrong audience that looks like a success: the mini has no
 * FEISHU_GROUP_CHAT_ID and exactly one stored target -
 * `notification_targets` row `feishu | open_id | ou_77f84d19d… |
 * openclaw-allowFrom`, seeded from the single ou_ entry in
 * `~/.openclaw/credentials/feishu-main-allowFrom.json` - so 日报, 周报 and
 * 个股分析 all took this branch and all landed in one person's DM while the
 * run log recorded a clean send. `groupFallback` was the only dissent, and a
 * flag on a `sent: true` result is exactly the shape of a warning that can
 * never fail a gate.
 *
 * A circle-public report therefore goes to the circle's group or nowhere. Any
 * other destination is a guess about who the circle is, and both ways of
 * guessing wrong are silent: publish to the wrong room, or "publish" to one
 * person and call it done.
 *
 * Rejected alternative: keep the fallback when the resolved global target is a
 * `chat_id` (group-shaped) and refuse only for an `open_id` (a DM). Feishu p2p
 * conversations have chat_ids too, so `chat_id` does not actually mean "a
 * room the circle is in" - it would have narrowed the bug without closing it.
 *
 * The refusal costs a deployment nothing it cannot fix with the one-line
 * remedy the message names, and `resolveFeishuAppTarget()` is no longer called
 * from this path at all - which also drops a side effect, since its
 * allowlist-discovery branch WRITES the discovered target back to sqlite.
 */
function resolveReportDeliveryTarget(scope: DeliverableReportScope): ReportTargetResolution {
  if (scope.kind === "owner-private") {
    return {
      ok: true,
      target: {
        targetType: "open_id",
        targetId: scope.ownerOpenId,
        source: "report-payload:scope.ownerOpenId"
      }
    };
  }

  const groupChatId = process.env.FEISHU_GROUP_CHAT_ID?.trim();
  if (groupChatId) {
    return {
      ok: true,
      target: {
        targetType: "chat_id",
        targetId: groupChatId,
        source: "env:FEISHU_GROUP_CHAT_ID"
      }
    };
  }

  return {
    ok: false,
    reason:
      "Refused: this is a circle-public report (§4 公共通知) and FEISHU_GROUP_CHAT_ID is not set, so there " +
      "is no circle to publish to. Nothing was sent - delivering it to the global notify/stored target " +
      "would put a 公共资产 in one person's DM and report success. Set FEISHU_GROUP_CHAT_ID to the 圈子群 " +
      "chat id (oc_…) and re-run.",
    groupFallbackReason:
      "未配置 FEISHU_GROUP_CHAT_ID，公共报告卡没有发出（本次不再改发默认单聊，以免公共内容只进了某一个人的私聊却记成投递成功）。请把圈子群的 chat id 配到 FEISHU_GROUP_CHAT_ID 后重跑。"
  };
}

// deliverReportViaFallback can throw (sendFallbackNotification rejects a
// non-2xx webhook), and deliverReportToFeishu must not.
async function tryDeliverReportViaFallback(
  payload: ReportDeliveryPayload,
  scope: DeliverableReportScope,
  primaryError?: string
): Promise<ReportDeliveryResult> {
  try {
    return await deliverReportViaFallback(payload, scope, primaryError);
  } catch (error) {
    return {
      sent: false,
      target: "none",
      reason: `Degraded Feishu report fallback failed: ${sanitizeNotificationError(error)}${primaryError ? ` (primary error: ${primaryError})` : ""}`,
      deliveries: []
    };
  }
}

/**
 * The legacy feishu-user-plugin MCP channel. It posts to ONE fixed chat -
 * resolveFeishuUserPluginBotChatId(), the shared 炒股这一块 group - and has no
 * way to address a second target. Only a report DECLARED circle-public ships
 * here; everything else is refused (refuseNonPublicOnSharedChatChannel).
 *
 * 2026-07-28 (spec drift A4, then R2). The first version of this guard keyed on
 * `payload.openId`, which caught the personal-page cards and missed the 模拟盘
 * 收支变化 report entirely: equally owner-private, but it carried `audience:
 * "dm"` and no `openId`, so it was published to the shared group and recorded
 * `sent: true`. Inferring privacy from a routing field can only ever catch the
 * payloads that happen to carry that field, which is why the question is now
 * answered by the producer's own `scope` declaration.
 *
 * An undeclared payload never reaches this function at all any more (R3):
 * `deliverReportToFeishu` refuses it before choosing a channel, so this guard
 * is left with exactly one job - keeping owner-private content out of the one
 * shared chat this channel can post to.
 */
async function deliverReportViaUserPlugin(
  payload: ReportDeliveryPayload,
  scope: DeliverableReportScope
): Promise<ReportDeliveryResult> {
  const refusal = refuseNonPublicOnSharedChatChannel(
    scope,
    "feishu-user-plugin-bot-post",
    `legacy feishu-user-plugin, chat ${resolveFeishuUserPluginBotChatIdForDiagnostics()}`
  );
  if (refusal) {
    return refusal;
  }

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

/**
 * Serialize an InteractiveCard into the card JSON this repo's ONE card
 * transport posts to im/v1/messages. The payload declares `schema: "2.0"`, so
 * every construct in it has to be a card JSON 2.0 construct.
 *
 * 2026-07-28 (spec drift A2). It was not. The payload declared 2.0 while its
 * buttons used card 1.0 syntax: a top-level `url` for navigation, wrapped in a
 * `{tag: "action"}` module. Per the 2.0 docs
 * (open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-
 * components/button) the button's field table lists `behaviors` as 必填 and
 * lists neither `url` nor `value`; navigation is an `open_url` behavior and
 * callbacks are a `callback` behavior. `url`/`multi_url` are 1.0 历史属性. The
 * 2.0 breaking-change notes (.../card-json-v2-breaking-changes-release-notes)
 * additionally removed the 备注/交互(action) modules AND changed unsupported
 * properties from silently ignored to REJECTED with an error - so this was not
 * merely a dead button, it put every card at risk of being refused. That
 * covered all five card types this batch produces (report conclusion, alert,
 * approval, research, review), and no test caught it because they all asserted
 * the InteractiveCard type instead of the JSON Feishu parses.
 *
 * Buttons are body elements in their own right now (2.0 has no action module to
 * group them); they stack vertically instead of sitting in a row, which is the
 * cosmetic price of emitting a payload the declared schema actually accepts.
 */
export function buildFeishuCardPayload(card: InteractiveCard): unknown {
  const elements: unknown[] = card.lines.map((line) => ({
    tag: "markdown",
    content: line
  }));

  for (const button of card.buttons ?? []) {
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: button.text },
      type: button.style ?? "default",
      // The callback data the OpenClaw approval handler reads is unchanged
      // (`action.value` stays `{value: "<token>"}`); in 2.0 it travels inside
      // the behavior rather than as a top-level `value` field.
      behaviors: [{ type: "callback", value: { value: button.value } }]
    });
  }

  if (card.url) {
    elements.push({
      tag: "button",
      text: { tag: "plain_text", content: card.url.text },
      type: "default",
      // default_url is the only required url; the per-platform ones are
      // optional overrides. All four are set to the same absolute link so no
      // client can fall through to a platform field we left blank - these
      // links come from buildDeepLink, which is platform-agnostic by design.
      behaviors: [{
        type: "open_url",
        default_url: card.url.href,
        pc_url: card.url.href,
        ios_url: card.url.href,
        android_url: card.url.href
      }]
    });
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
  target: CardTarget,
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
    const resolvedTarget = resolveDirectCardTarget(target);
    if (!resolvedTarget.ok) {
      return { ok: false, error: resolvedTarget.error };
    }
    const { targetType, targetId } = resolvedTarget;
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

type ResolvedCardTarget =
  | { ok: true; targetType: "open_id" | "chat_id"; targetId: string }
  | { ok: false; error: string };

/**
 * `{operator: true}` means "send this to whoever OPERATES this deployment" -
 * how market-alerts-poll.mjs's escalation reaches a human when no member has a
 * linked Feishu account, i.e. when the message being sent is "the alert poller
 * itself is dead". Each transport resolves it its own way and neither consults
 * the members table (the point - that table is what just came up empty): this
 * one through resolveFeishuAppTarget() (the same FEISHU_NOTIFY_CHAT_ID /
 * FEISHU_NOTIFY_OPEN_ID / stored-target / paired-chat chain the text and
 * operational-alert paths above already use), the legacy MCP transport below
 * through resolveFeishuUserPluginBotChatId().
 *
 * It has to be REQUESTED, never inferred from an absence. Every other caller in
 * this repo addresses one member (`{openId: member.feishuOpenId}`), and if that
 * id is ever undefined the card must be refused, NOT redirected: a login code
 * or a review card quietly arriving in the operator's DM (or, on the legacy
 * transport, the shared group chat) is precisely the owner-scoped-content-on-a-
 * shared-surface failure this codebase keeps closing. So an empty target is
 * still a refusal, and only the explicit flag opts in.
 *
 * 2026-07-28 R5. Before this, the operator form was spelled `{}` and THIS
 * transport rejected it - while defaultCardTransport selects this transport
 * whenever app credentials resolve, which is the deploy target's confirmed
 * shape. Measured against the built dist with FEISHU_APP_ID/FEISHU_APP_SECRET
 * set:
 *   sendInteractiveCard(card, {}) -> {"ok":false,"error":"Interactive card
 *   target needs a chatId or openId."}, zero HTTP requests attempted.
 * The `{}` -> shared-chat behaviour that two comments in market-alerts-poll.mjs
 * attributed to "defaultCardTransport" only ever existed in
 * legacyMcpCardTransport, which a credentialed deployment never selects. So the
 * one message whose job is to report the alerter as broken was the one message
 * that could not be sent.
 *
 * On the deploy target this resolves through the STORED target rather than an
 * env var: its .env.local sets FEISHU_APP_ID/FEISHU_APP_SECRET and no
 * FEISHU_NOTIFY_* at all, and its notification_targets table already holds one
 * `feishu` row of type open_id, source `openclaw-allowFrom` (read-only check;
 * only the channel/type/source and the id's `ou_` prefix were read).
 *
 * Every failure here is NAMED and also logged, and the failures are kept apart:
 * no target requested at all, versus nothing configured to be the operator
 * (set an env var / DM the bot), versus the lookup itself throwing (the runtime
 * is broken). The caller of the operator form reads a false return as "the
 * whole Feishu channel is dead" and has no other channel left to explain
 * itself on.
 */
function resolveDirectCardTarget(target: CardTarget): ResolvedCardTarget {
  const chatId = target.chatId?.trim();
  if (chatId) {
    return { ok: true, targetType: "chat_id", targetId: chatId };
  }

  const openId = target.openId?.trim();
  if (openId) {
    return { ok: true, targetType: "open_id", targetId: openId };
  }

  if (!target.operator) {
    return { ok: false, error: "Interactive card target needs a chatId or openId (or `operator: true` to address the deployment's operator)." };
  }

  // Deliberately NOT tryResolveGlobalFeishuTarget(): that helper maps a THROW
  // and a clean "nothing is configured" onto the same `null`, and here they
  // are different operator instructions. The lookup reads sqlite and $HOME, so
  // it throws on exactly the broken-runtime scenario the loudest caller of the
  // operator form (market-alerts-poll's db-open-failure escalation) is
  // reporting - calling that "not configured" would send the operator to edit
  // an env var over a corrupt database.
  let operatorTarget: FeishuAppTarget | null = null;
  try {
    operatorTarget = resolveFeishuAppTarget();
  } catch (lookupError) {
    const error = `Interactive card operator-target lookup failed (no chatId/openId was given, so the deployment target had to be resolved): ${sanitizeNotificationError(lookupError)}`;
    console.error(`notifications: ${error}`);
    return { ok: false, error };
  }

  if (operatorTarget) {
    return { ok: true, targetType: operatorTarget.targetType, targetId: operatorTarget.targetId };
  }

  const error = [
    `[${UNCONFIGURED_CARD_TARGET_MARKER}] Interactive card has no target:`,
    "the caller asked for the operator target (no chatId/openId given) and none is configured",
    "for this deployment. Set FEISHU_NOTIFY_CHAT_ID or FEISHU_NOTIFY_OPEN_ID,",
    "or DM the bot once so a target can be stored."
  ].join(" ");
  console.error(`notifications: ${error}`);
  return { ok: false, error };
}

/**
 * Embedded in the refusal above so a caller can tell "this deployment has no
 * operator target configured" (fix the config) apart from "a target IS
 * configured and the send was rejected" (fix auth/network) without
 * pattern-matching prose that is free to change.
 */
export const UNCONFIGURED_CARD_TARGET_MARKER = "no_operator_target_configured";

export function isUnconfiguredCardTargetError(error: string | undefined): boolean {
  return typeof error === "string" && error.includes(UNCONFIGURED_CARD_TARGET_MARKER);
}

// Legacy transport reuses the feishu-user-plugin MCP subprocess channel
// (see callFeishuUserPluginTool below) - a different Feishu app entirely.
// Kept ONLY as the no-credentials fallback so pre-P10 dev setups keep their
// old behavior; production (FEISHU_APP_ID/SECRET configured) must never use
// it for cards.
const legacyMcpCardTransport: CardTransport = {
  async sendCard(target, cardJson) {
    try {
      // 2026-07-28 R5: the fall-through used to be
      // `target.chatId ?? target.openId ?? resolveFeishuUserPluginBotChatId()`,
      // so a caller whose `member.feishuOpenId` came back undefined posted that
      // member's card into the ONE SHARED GROUP CHAT this transport can reach,
      // and reported ok. Reaching the shared chat now requires asking for the
      // operator explicitly, exactly as in directHttpCardTransport.
      const explicitTarget = target.chatId?.trim() || target.openId?.trim();
      if (!explicitTarget && !target.operator) {
        return { ok: false, error: "Interactive card target needs a chatId or openId (or `operator: true` to address the deployment's operator)." };
      }
      const chatId = explicitTarget || resolveFeishuUserPluginBotChatId();
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

// The chat id for an error message only: resolveFeishuUserPluginBotChatId
// throws when nothing is configured, and a refusal explaining WHERE the report
// would have leaked must not itself blow up over a missing chat id.
function resolveFeishuUserPluginBotChatIdForDiagnostics(): string {
  try {
    return resolveFeishuUserPluginBotChatId();
  } catch {
    return "unknown shared chat";
  }
}

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
