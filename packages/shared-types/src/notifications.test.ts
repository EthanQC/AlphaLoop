import { afterEach, describe, expect, it } from "vitest";

import {
  allowReportFallbackDelivery,
  buildFeishuCardPayload,
  buildReportSummaryMarkdown,
  isFeishuProseFailure,
  sendInteractiveCard,
  shouldSendFullReportChapters,
  updateInteractiveCard,
  type CardTransport,
  type InteractiveCard
} from "./notifications.js";

describe("report delivery policy", () => {
  const previousMode = process.env.FEISHU_REPORT_DELIVERY_MODE;
  const previousFallback = process.env.FEISHU_REPORT_ALLOW_FALLBACK;
  const previousDegraded = process.env.OPENCLAW_REPORT_ALLOW_DEGRADED_FEISHU;

  afterEach(() => {
    if (previousMode === undefined) {
      delete process.env.FEISHU_REPORT_DELIVERY_MODE;
    } else {
      process.env.FEISHU_REPORT_DELIVERY_MODE = previousMode;
    }
    if (previousFallback === undefined) {
      delete process.env.FEISHU_REPORT_ALLOW_FALLBACK;
    } else {
      process.env.FEISHU_REPORT_ALLOW_FALLBACK = previousFallback;
    }
    if (previousDegraded === undefined) {
      delete process.env.OPENCLAW_REPORT_ALLOW_DEGRADED_FEISHU;
    } else {
      process.env.OPENCLAW_REPORT_ALLOW_DEGRADED_FEISHU = previousDegraded;
    }
  });

  it("keeps Feishu reports to summary card plus PDF even if the legacy full mode is set", () => {
    process.env.FEISHU_REPORT_DELIVERY_MODE = "full";

    expect(shouldSendFullReportChapters()).toBe(false);
  });

  it("disables degraded report fallback because fallback cannot guarantee PDF delivery", () => {
    process.env.FEISHU_REPORT_ALLOW_FALLBACK = "1";
    process.env.OPENCLAW_REPORT_ALLOW_DEGRADED_FEISHU = "1";

    expect(allowReportFallbackDelivery()).toBe(false);
  });

  it("builds actionable Feishu summaries without local paths or delivery boilerplate", () => {
    const summary = buildReportSummaryMarkdown({
      title: "OpenClaw 日报 2026-05-29",
      markdownPath: "/Users/mashu/Documents/codex/reports/daily/2026-05-29.md",
      pdfPath: "/Users/mashu/Documents/codex/reports/daily/2026-05-29.pdf",
      markdown: [
        "# OpenClaw 日报 2026-05-29",
        "",
        "窗口：2026-05-28 20:00 - 2026-05-29 20:00（北京时间）",
        "",
        "## 1. 今日结论",
        "",
        "- 市场信号：QQQ 最新价 738.31，较前收上涨 0.37%；新闻主线偏中性偏多。",
        "- 宏观信号：2026-06-18 美国费城联储制造业指数，关注制造业景气是否拖累科技风险偏好。",
        "- 模拟盘：当前只持有 QQQ.US 1 份，暴露 0.60%，仍低于总仓 10% 上限。",
        "",
        "### 长桥新闻（中文摘要）",
        "",
        "- 2026-05-30 QQQ.US：全球市场和地缘风险预期变化；影响：成长股风险偏好可能改善。",
        "",
        "### 宏观日历",
        "",
        "- 2026-06-18 20:30 美国费城联储制造业指数（预测12）"
      ].join("\n")
    });

    expect(summary).toContain("市场信号");
    expect(summary).toContain("全球市场和地缘风险预期变化");
    expect(summary).toContain("美国费城联储制造业指数");
    expect(summary).not.toContain("/Users/mashu");
    expect(summary).not.toContain("文件上传成功");
    expect(summary).not.toContain("本地报告文件");
  });

  it("uses stock-analysis conclusions instead of generic generated-file text", () => {
    const summary = buildReportSummaryMarkdown({
      title: "OpenClaw 个股分析 2026-05-31",
      markdown: [
        "# OpenClaw 个股分析 2026-05-31",
        "",
        "## 本批次结论",
        "",
        "- AAPL.US：支撑位 276.83；阻力位 312.51；需要按新闻与成交量继续验证。",
        "",
        "### 结论与复盘标签",
        "",
        "- 上行路径：若守住支撑并突破阻力，短线偏上行。"
      ].join("\n")
    });

    expect(summary).toContain("AAPL.US");
    expect(summary).toContain("支撑位 276.83");
    expect(summary).not.toContain("本报告已生成");
  });
});

describe("buildFeishuCardPayload", () => {
  it("builds a schema 2.0 card with title and markdown lines", () => {
    const card: InteractiveCard = {
      title: "盘前提醒",
      lines: ["QQQ 最新价 738.31", "较前收上涨 0.37%"]
    };

    const payload = buildFeishuCardPayload(card) as {
      schema: string;
      header: { title: { tag: string; content: string } };
      body: { elements: Array<{ tag: string; content?: string }> };
    };

    expect(payload.schema).toBe("2.0");
    expect(payload.header.title.content).toBe("盘前提醒");
    expect(payload.body.elements).toEqual([
      { tag: "markdown", content: "QQQ 最新价 738.31" },
      { tag: "markdown", content: "较前收上涨 0.37%" }
    ]);
  });

  it("passes Chinese content through untouched", () => {
    const card: InteractiveCard = {
      title: "中文标题：交易提醒",
      lines: ["中文正文第一行", "中文正文第二行，带标点。"]
    };

    const payload = buildFeishuCardPayload(card) as {
      header: { title: { content: string } };
      body: { elements: Array<{ content?: string }> };
    };

    expect(payload.header.title.content).toBe("中文标题：交易提醒");
    expect(payload.body.elements[0]?.content).toBe("中文正文第一行");
    expect(payload.body.elements[1]?.content).toBe("中文正文第二行，带标点。");
  });

  it("renders buttons as an action element with value passthrough for the OpenClaw callback", () => {
    const card: InteractiveCard = {
      title: "审批",
      lines: ["是否批准这笔交易？"],
      buttons: [
        { text: "批准", value: "approve:12345", style: "primary" },
        { text: "拒绝", value: "reject:12345", style: "danger" },
        { text: "忽略", value: "ignore:12345" }
      ]
    };

    const payload = buildFeishuCardPayload(card) as {
      body: {
        elements: Array<{
          tag: string;
          actions?: Array<{ tag: string; text: { content: string }; type: string; value: { value: string } }>;
        }>;
      };
    };

    const actionElement = payload.body.elements.find((element) => element.tag === "action");
    expect(actionElement).toBeDefined();
    expect(actionElement?.actions).toEqual([
      { tag: "button", text: { tag: "plain_text", content: "批准" }, type: "primary", value: { value: "approve:12345" } },
      { tag: "button", text: { tag: "plain_text", content: "拒绝" }, type: "danger", value: { value: "reject:12345" } },
      { tag: "button", text: { tag: "plain_text", content: "忽略" }, type: "default", value: { value: "ignore:12345" } }
    ]);
  });

  it("adds an optional url button alongside regular buttons", () => {
    const card: InteractiveCard = {
      title: "详情",
      lines: ["点击查看完整报告"],
      buttons: [{ text: "确认", value: "confirm" }],
      url: { text: "查看报告", href: "https://example.com/report/2026-07-12" }
    };

    const payload = buildFeishuCardPayload(card) as {
      body: {
        elements: Array<{
          tag: string;
          actions?: Array<{ tag: string; text: { content: string }; url?: string; value?: { value: string } }>;
        }>;
      };
    };

    const actionElement = payload.body.elements.find((element) => element.tag === "action");
    expect(actionElement?.actions).toContainEqual({
      tag: "button",
      text: { tag: "plain_text", content: "查看报告" },
      type: "default",
      url: "https://example.com/report/2026-07-12"
    });
    expect(actionElement?.actions).toHaveLength(2);
  });

  it("omits the action element entirely when there are no buttons and no url", () => {
    const card: InteractiveCard = {
      title: "纯文本卡片",
      lines: ["没有按钮的卡片"]
    };

    const payload = buildFeishuCardPayload(card) as {
      body: { elements: Array<{ tag: string }> };
    };

    expect(payload.body.elements.some((element) => element.tag === "action")).toBe(false);
  });
});

describe("isFeishuProseFailure", () => {
  it("flags a 'Send failed' prose response as a failure", () => {
    expect(isFeishuProseFailure("Send failed: chat not found")).toBe(true);
  });

  it("flags an 'Error:' prose response as a failure", () => {
    expect(isFeishuProseFailure("Error: invalid message id")).toBe(true);
  });

  it("does not flag a normal success response", () => {
    expect(isFeishuProseFailure("Message sent (bot): om_123456")).toBe(false);
  });
});

describe("sendInteractiveCard", () => {
  const card: InteractiveCard = {
    title: "测试卡片",
    lines: ["一行内容"]
  };

  it("returns the messageId reported by the injected transport", async () => {
    let receivedTarget: unknown;
    let receivedPayload: unknown;
    const fakeTransport: CardTransport = {
      sendCard: async (target, cardJson) => {
        receivedTarget = target;
        receivedPayload = cardJson;
        return { ok: true, messageId: "om_fake_123" };
      },
      updateCard: async () => ({ ok: true })
    };

    const result = await sendInteractiveCard(card, { chatId: "oc_abc" }, fakeTransport);

    expect(result).toEqual({ ok: true, messageId: "om_fake_123" });
    expect(receivedTarget).toEqual({ chatId: "oc_abc" });
    expect(receivedPayload).toMatchObject({ schema: "2.0" });
  });

  it("propagates ok:false and the error message from the transport", async () => {
    const fakeTransport: CardTransport = {
      sendCard: async () => ({ ok: false, error: "chat not found" }),
      updateCard: async () => ({ ok: true })
    };

    const result = await sendInteractiveCard(card, { openId: "ou_xyz" }, fakeTransport);

    expect(result).toEqual({ ok: false, error: "chat not found" });
  });

  it("converts a thrown transport error into ok:false", async () => {
    const fakeTransport: CardTransport = {
      sendCard: async () => {
        throw new Error("boom");
      },
      updateCard: async () => ({ ok: true })
    };

    const result = await sendInteractiveCard(card, {}, fakeTransport);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
  });
});

describe("updateInteractiveCard", () => {
  const card: InteractiveCard = {
    title: "更新后的卡片",
    lines: ["已批准"]
  };

  it("returns ok:true on the happy path", async () => {
    let receivedMessageId: string | undefined;
    let receivedPayload: unknown;
    const fakeTransport: CardTransport = {
      sendCard: async () => ({ ok: true }),
      updateCard: async (messageId, cardJson) => {
        receivedMessageId = messageId;
        receivedPayload = cardJson;
        return { ok: true };
      }
    };

    const result = await updateInteractiveCard("om_123", card, fakeTransport);

    expect(result).toEqual({ ok: true });
    expect(receivedMessageId).toBe("om_123");
    expect(receivedPayload).toMatchObject({ schema: "2.0" });
  });

  it("propagates ok:false and the error message from the transport", async () => {
    const fakeTransport: CardTransport = {
      sendCard: async () => ({ ok: true }),
      updateCard: async () => ({ ok: false, error: "message not editable" })
    };

    const result = await updateInteractiveCard("om_456", card, fakeTransport);

    expect(result).toEqual({ ok: false, error: "message not editable" });
  });
});
