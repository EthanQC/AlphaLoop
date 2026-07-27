import { describe, expect, it } from "vitest";

import type { CardTransport } from "@packages/shared-types";

import {
  LOGIN_CODE_CARD_TITLE,
  composeLoginCodeCardLines,
  createFeishuLoginCodeSender
} from "./login-code-notifier.js";

function fakeTransport(result: { ok: boolean; error?: string } = { ok: true, messageId: "om_1" }): {
  transport: CardTransport;
  calls: Array<{ target: { chatId?: string; openId?: string }; cardJson: unknown }>;
} {
  const calls: Array<{ target: { chatId?: string; openId?: string }; cardJson: unknown }> = [];
  const transport: CardTransport = {
    async sendCard(target, cardJson) {
      calls.push({ target, cardJson });
      return result;
    },
    async updateCard() {
      throw new Error("updateCard must not be called for a login code");
    }
  };
  return { transport, calls };
}

describe("composeLoginCodeCardLines", () => {
  it("states the code, its validity window, and the ignore-this warning, in Chinese", () => {
    const lines = composeLoginCodeCardLines("424242", 10);

    expect(lines[0]).toContain("424242");
    expect(lines[1]).toContain("10 分钟");
    expect(lines[1]).toContain("仅可使用一次");
    expect(lines[2]).toContain("如果不是你本人登录，请忽略");
  });
});

describe("createFeishuLoginCodeSender", () => {
  it("delivers to the member's open_id over the shared interactive-card channel", async () => {
    const { transport, calls } = fakeTransport();

    const result = await createFeishuLoginCodeSender({ transport })({
      openId: "ou_member_1",
      code: "424242",
      ttlMinutes: 10
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.target).toEqual({ openId: "ou_member_1" });

    // The payload is whatever shared-types' buildFeishuCardPayload produces -
    // this module composes content, it does not reinvent the envelope.
    const payload = calls[0]?.cardJson as { header: { title: { content: string } }; body: { elements: unknown[] } };
    expect(payload.header.title.content).toBe(LOGIN_CODE_CARD_TITLE);
    expect(JSON.stringify(payload.body.elements)).toContain("424242");
  });

  it("reports a transport failure as a reason instead of throwing", async () => {
    const { transport } = fakeTransport({ ok: false, error: "Feishu card send rejected: bad receive_id" });

    const result = await createFeishuLoginCodeSender({ transport })({
      openId: "ou_member_1",
      code: "424242",
      ttlMinutes: 10
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("bad receive_id");
  });
});
