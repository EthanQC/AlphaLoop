/**
 * Delivers a login code to a member's own Feishu DM (routes/login.ts, the
 * self-hosted email-code login).
 *
 * NO NEW FEISHU PLUMBING: this rides the exact channel that was verified
 * live on 2026-07-18 and is already used for market-alert cards and monthly
 * review confirmations - shared-types' `sendInteractiveCard`, whose default
 * transport sends with the app's OWN tenant token (FEISHU_APP_ID /
 * FEISHU_APP_SECRET via loadLocalEnv) straight to `im/v1/messages` with
 * `receive_id_type=open_id`. Same call shape as
 * data/feishu-review-notifier.ts. Nothing in notifications.ts is modified.
 *
 * THE CODE NEVER REACHES A LOG: on failure this returns a sanitized reason
 * from sendInteractiveCard (which already scrubs its own errors) and the
 * caller logs only that. The code appears in exactly one place - the card
 * body - and in exactly one other form - a salted scrypt hash in
 * `login_codes` (see database.ts's v15 step).
 */
import { sendInteractiveCard, type CardTransport } from "@packages/shared-types";

export interface LoginCodeDeliveryResult {
  ok: boolean;
  /** Sanitized, non-secret explanation for the server log. Never shown to the
   * browser (the login page's response is identical either way - see
   * routes/login.ts's anti-enumeration rule). */
  reason?: string;
}

/**
 * The seam routes/login.ts depends on. Tests inject a fake capturing
 * `{openId, code}`; production uses createFeishuLoginCodeSender().
 */
export type LoginCodeSender = (args: {
  openId: string;
  code: string;
  ttlMinutes: number;
}) => Promise<LoginCodeDeliveryResult>;

/** The card body, exported so a test can pin the Chinese copy without going
 * through a transport. */
export function composeLoginCodeCardLines(code: string, ttlMinutes: number): string[] {
  return [
    `验证码：**${code}**`,
    `有效期 ${ttlMinutes} 分钟，仅可使用一次。`,
    "如果不是你本人登录，请忽略本条消息，不要把验证码转发给任何人。"
  ];
}

export const LOGIN_CODE_CARD_TITLE = "AlphaLoop 登录验证码";

export function createFeishuLoginCodeSender(deps: { transport?: CardTransport } = {}): LoginCodeSender {
  return async function feishuLoginCodeSender({ openId, code, ttlMinutes }): Promise<LoginCodeDeliveryResult> {
    const card = { title: LOGIN_CODE_CARD_TITLE, lines: composeLoginCodeCardLines(code, ttlMinutes) };
    const sent = deps.transport
      ? await sendInteractiveCard(card, { openId }, deps.transport)
      : await sendInteractiveCard(card, { openId });
    if (!sent.ok) {
      return { ok: false, reason: sent.error ?? "飞书卡片发送失败。" };
    }
    return { ok: true };
  };
}
