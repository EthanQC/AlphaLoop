import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  allowReportFallbackDelivery,
  buildFeishuCardPayload,
  buildReportSummaryMarkdown,
  deliverReportToFeishu,
  isFeishuProseFailure,
  directHttpCardTransport,
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

// Item 6 (task P2.5 Task 6): trySendFeishuUserPluginBotFile's file-send step
// used to check `/^error:/iu.test(detail)` directly instead of routing
// through isFeishuProseFailure (tested standalone above) - the one remaining
// call site among callFeishuUserPluginTool's several that skipped it. A
// feishu-user-plugin response that reports failure as "Send failed: ..."
// prose WITHOUT setting isError (see isFeishuProseFailure's own doc comment -
// this is a real, observed feishu-user-plugin response shape) fell through
// that narrower check and was reported as a successful PDF delivery that
// never actually sent.
//
// Exercised end to end through the exported deliverReportToFeishu (rather
// than importing the unexported trySendFeishuUserPluginBotFile directly) by
// faking the child process callFeishuUserPluginTool spawns - the
// FEISHU_USER_PLUGIN_COMMAND/FEISHU_USER_PLUGIN_ARGS env vars are the
// officially supported override point (see resolveFeishuUserPluginCommand),
// so this fakes the SAME subprocess boundary the run-feishu-user-plugin
// wrapper tests fake, just with a scripted JSON-RPC responder instead of a
// process-signal marker.
describe("trySendFeishuUserPluginBotFile prose-failure detection (item 6, task P2.5 Task 6)", () => {
  // A minimal JSON-RPC-over-stdio responder matching exactly what
  // callFeishuUserPluginTool speaks (see notifications.ts): one line in, one
  // line out. Responds to `initialize`, ignores the `notifications/initialized`
  // notification (no `id`, no response expected), and for `tools/call`
  // reproduces the exact bug scenario: the file-send step's response text
  // starts with "Send failed:" but does NOT set `isError`.
  const FAKE_PLUGIN_SCRIPT = `
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, terminal: false });

function respond(id, result) {
  process.stdout.write(\`\${JSON.stringify({ jsonrpc: "2.0", id, result })}\\n\`);
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message.id === undefined) {
    return;
  }
  if (message.method === "initialize") {
    respond(message.id, {});
    return;
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    if (name === "upload_file") {
      respond(message.id, { content: [{ type: "text", text: "Uploaded: file_fake_abc123" }] });
      return;
    }
    if (name === "send_message_as_bot" && args.msg_type === "file") {
      respond(message.id, { content: [{ type: "text", text: "Send failed: chat not found" }] });
      return;
    }
    respond(message.id, { content: [{ type: "text", text: "Message sent (bot): om_fake_summary" }] });
    return;
  }
  respond(message.id, {});
});
`;

  const envKeys = [
    "LARK_APP_ID",
    "LARK_APP_SECRET",
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_ACCOUNT_ID",
    "FEISHU_USER_PLUGIN_BOT_CHAT_ID",
    "FEISHU_USER_PLUGIN_COMMAND",
    "FEISHU_USER_PLUGIN_ARGS",
    "FEISHU_NOTIFICATION_RETRY_ATTEMPTS",
    "FEISHU_USER_PLUGIN_DISABLED"
  ] as const;
  const savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};
  let tempDir: string | undefined;

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("treats a 'Send failed' prose response (isError unset) on the file-send step as a failure, not a false success", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "notifications-fake-plugin-"));
    const scriptPath = join(tempDir, "fake-plugin.mjs");
    writeFileSync(scriptPath, FAKE_PLUGIN_SCRIPT, "utf8");
    const pdfPath = join(tempDir, "report.pdf");
    writeFileSync(pdfPath, "%PDF-1.4 fake pdf content", "utf8");

    process.env.LARK_APP_ID = "test_app_id";
    process.env.LARK_APP_SECRET = "test_app_secret";
    // The 2026-07-26 fix makes the app-credential path the DEFAULT, so this
    // legacy-path test has to make app credentials genuinely unresolvable:
    // no FEISHU_APP_ID/SECRET in the env AND an account id that cannot exist
    // in ~/.openclaw/openclaw.json (resolveFeishuAppCredentials's second
    // source), otherwise the machine running the suite would decide which
    // channel is exercised here.
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    process.env.FEISHU_ACCOUNT_ID = "__no_such_account__";
    process.env.FEISHU_USER_PLUGIN_BOT_CHAT_ID = "oc_test_chat";
    process.env.FEISHU_USER_PLUGIN_COMMAND = process.execPath;
    process.env.FEISHU_USER_PLUGIN_ARGS = JSON.stringify([scriptPath]);
    process.env.FEISHU_NOTIFICATION_RETRY_ATTEMPTS = "1";
    delete process.env.FEISHU_USER_PLUGIN_DISABLED;

    // Pre-fix: the file-send step's "Send failed: ..." response is not
    // caught (only `/^error:/iu` was checked), so trySendFeishuUserPluginBotFile
    // reports `sent: true` and deliverReportToFeishu resolves as if the PDF
    // had genuinely been delivered.
    //
    // The failure is still detected after the 2026-07-26 fix, but it is now
    // reported as a structured not-delivered RESULT rather than a throw -
    // throwing out of deliverReportToFeishu is exactly what took the cron
    // runner down for every scheduled report.
    const result = await deliverReportToFeishu({
      title: "测试报告",
      markdown: "# 测试报告\n\n内容",
      pdfPath
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/Send failed/);
    // ... and it really did go through the legacy user-plugin channel.
    expect(result.target).toBe("feishu-user-plugin-bot-post");
  });
});

// 2026-07-26 scheduled-report delivery fix. deliverReportToFeishu used to
// require the feishu-user-plugin MCP bot channel (a DIFFERENT Feishu app -
// the operator's personal one) and THREW when it was not configured, so
// every daily/weekly/stock-analysis/monthly-review run on the mini died with
// "Feishu report delivery requires the user-plugin bot channel: No bot chat
// id is configured" and never produced a single run_log row. Cards were
// migrated to the app's own tenant token earlier this month
// (directHttpCardTransport, above); reports never were. These tests fake the
// same HTTP boundary those card tests fake.
describe("deliverReportToFeishu app-credential path (2026-07-26 fix)", () => {
  const realFetch = globalThis.fetch;
  const envKeys = [
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_ACCOUNT_ID",
    "FEISHU_DOMAIN",
    "FEISHU_NOTIFY_OPEN_ID",
    "FEISHU_NOTIFY_CHAT_ID",
    "FEISHU_WEBHOOK_URL",
    "FEISHU_NOTIFICATION_RETRY_ATTEMPTS",
    "FEISHU_USER_PLUGIN_BOT_CHAT_ID",
    "HOME"
  ] as const;
  const savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};
  const savedCwd = process.cwd();
  let tempDir: string | undefined;

  const REPORT_MARKDOWN = [
    "# OpenClaw 日报 2026-07-26",
    "",
    "窗口：2026-07-25 20:00 - 2026-07-26 20:00（北京时间）",
    "",
    "## 1. 今日结论",
    "",
    "- 市场信号：QQQ 最新价 738.31，较前收上涨 0.37%。",
    "",
    "## 2. 明日跟踪",
    "",
    "- QQQ：先看 730 - 745 区间是否被放量突破。"
  ].join("\n");

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      if (key !== "HOME") {
        delete process.env[key];
      }
    }
    process.env.FEISHU_APP_ID = "cli_trading_copilot";
    process.env.FEISHU_APP_SECRET = "app-secret-x";
    process.env.FEISHU_NOTIFICATION_RETRY_ATTEMPTS = "1";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (process.cwd() !== savedCwd) {
      process.chdir(savedCwd);
    }
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  function stubFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const out = handler(String(url), init ?? {});
      return new Response(JSON.stringify(out.body), { status: out.status ?? 200 });
    }) as typeof fetch;
    return calls;
  }

  function okFeishu(token = "t-token-report") {
    return (url: string) => url.includes("tenant_access_token")
      ? { body: { code: 0, tenant_access_token: token, expire: 7200 } }
      : { body: { code: 0, msg: "success", data: { message_id: "om_report" } } };
  }

  function messageCalls(calls: Array<{ url: string; init: RequestInit }>) {
    return calls
      .filter((call) => call.url.includes("/open-apis/im/v1/messages?"))
      .map((call) => ({
        url: call.url,
        headers: call.init.headers as Record<string, string>,
        body: JSON.parse(String(call.init.body)) as {
          receive_id: string;
          msg_type: string;
          content: string;
        }
      }));
  }

  it("posts the summary and every chapter to the global target with the app tenant token", async () => {
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_global_member";
    const calls = stubFetch(okFeishu());

    const result = await deliverReportToFeishu({
      title: "OpenClaw 日报 2026-07-26",
      markdown: REPORT_MARKDOWN
    });

    expect(result.sent).toBe(true);
    expect(result.target).toBe("feishu-app-open-id");

    const sends = messageCalls(calls);
    // 1 summary + 3 chapters (the pre-`##` header block, 今日结论, 明日跟踪).
    expect(sends).toHaveLength(4);
    for (const send of sends) {
      expect(send.url).toContain("receive_id_type=open_id");
      expect(send.body.receive_id).toBe("ou_global_member");
      expect(send.headers.authorization).toBe("Bearer t-token-report");
      // "post" (rich text), not "text": the report body is markdown-ish and
      // markdownToFeishuPostContent already renders headings/bullets for the
      // webhook + app notification paths.
      expect(send.body.msg_type).toBe("post");
    }

    const summary = JSON.parse(sends[0]!.body.content) as { zh_cn: { title: string; content: unknown[] } };
    expect(summary.zh_cn.title).toBe("OpenClaw 日报 2026-07-26 摘要");
    expect(JSON.stringify(summary.zh_cn.content)).toContain("QQQ 最新价 738.31");

    expect(result.deliveries.map((entry) => entry.kind)).toEqual(["summary", "chapter", "chapter", "chapter"]);
    expect(result.deliveries.every((entry) => entry.sent)).toBe(true);
  });

  it("prefers a per-owner openId on the payload over the global notify target", async () => {
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_global_member";
    const calls = stubFetch(okFeishu());

    const result = await deliverReportToFeishu({
      title: "OpenClaw 个股分析 2026-07-26",
      markdown: REPORT_MARKDOWN,
      openId: "ou_owner_specific"
    });

    expect(result.sent).toBe(true);
    const receivers = new Set(messageCalls(calls).map((send) => send.body.receive_id));
    expect(receivers).toEqual(new Set(["ou_owner_specific"]));
  });

  it("returns a structured not-delivered result - never throws - when no target resolves", async () => {
    // Isolate BOTH target sources resolveFeishuAppTarget can still reach with
    // no FEISHU_NOTIFY_* set: the repo's sqlite notification_targets row
    // (derived from cwd) and ~/.openclaw/credentials (derived from $HOME).
    tempDir = mkdtempSync(join(tmpdir(), "notifications-no-target-"));
    process.env.HOME = tempDir;
    process.chdir(tempDir);
    const calls = stubFetch(okFeishu());

    const result = await deliverReportToFeishu({
      title: "OpenClaw 日报 2026-07-26",
      markdown: REPORT_MARKDOWN
    });

    expect(result.sent).toBe(false);
    expect(result.target).toBe("none");
    expect(result.reason).toMatch(/FEISHU_NOTIFY_OPEN_ID/);
    expect(result.deliveries).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("surfaces the Feishu error message on a non-zero code without leaking the tenant token", async () => {
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_bad";
    stubFetch((url) => url.includes("tenant_access_token")
      ? { body: { code: 0, tenant_access_token: "secret-token-x", expire: 7200 } }
      : { status: 400, body: { code: 230001, msg: "invalid receive_id" } });

    const result = await deliverReportToFeishu({
      title: "OpenClaw 日报 2026-07-26",
      markdown: REPORT_MARKDOWN
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toContain("invalid receive_id");
    expect(result.reason).not.toContain("secret-token-x");
    expect(JSON.stringify(result.deliveries)).not.toContain("secret-token-x");
  });

  it("keeps splitting oversized chapters with maxSectionChars", async () => {
    process.env.FEISHU_NOTIFY_CHAT_ID = "oc_group_chat";
    const calls = stubFetch(okFeishu());
    const longSection = ["## 1. 今日结论", "", "段落一".repeat(40), "", "段落二".repeat(40)].join("\n");

    const result = await deliverReportToFeishu({
      title: "OpenClaw 日报 2026-07-26",
      markdown: `# OpenClaw 日报 2026-07-26\n\n${longSection}`,
      maxSectionChars: 100
    });

    expect(result.sent).toBe(true);
    expect(result.target).toBe("feishu-app-chat-id");
    const chapters = result.deliveries.filter((entry) => entry.kind === "chapter");
    const multiPart = chapters.filter((entry) => (entry.parts ?? 1) > 1);
    expect(multiPart.length).toBeGreaterThan(0);
    expect(multiPart[0]!.title).toContain("（1/");
    for (const send of messageCalls(calls)) {
      expect(send.url).toContain("receive_id_type=chat_id");
      expect(send.body.receive_id).toBe("oc_group_chat");
    }
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

describe("directHttpCardTransport (2026-07-18 live-send fix)", () => {
  // The legacy default routed cards through the feishu-user-plugin MCP - a
  // DIFFERENT app - and passed open_id where chat_id was expected; live probe
  // failed HTTP 400 code=230001 while a direct im/v1/messages send succeeded.
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
  });

  function stubFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const out = handler(String(url), init ?? {});
      return new Response(JSON.stringify(out.body), { status: out.status ?? 200 });
    }) as typeof fetch;
    return calls;
  }

  it("sends interactive cards to open_id via im/v1/messages with the app tenant token", async () => {
    process.env.FEISHU_APP_ID = "cli_test_app";
    process.env.FEISHU_APP_SECRET = "test_secret";
    const calls = stubFetch((url) => {
      if (url.includes("tenant_access_token")) {
        return { body: { code: 0, tenant_access_token: "t-token-1", expire: 7200 } };
      }
      return { body: { code: 0, msg: "success", data: { message_id: "om_direct_1" } } };
    });

    const result = await directHttpCardTransport.sendCard({ openId: "ou_user_1" }, { schema: "2.0" });

    expect(result).toEqual({ ok: true, messageId: "om_direct_1" });
    const sendCall = calls.find((c) => c.url.includes("/im/v1/messages?"));
    expect(sendCall).toBeDefined();
    expect(sendCall!.url).toContain("receive_id_type=open_id");
    const body = JSON.parse(String(sendCall!.init.body));
    expect(body.receive_id).toBe("ou_user_1");
    expect(body.msg_type).toBe("interactive");
    expect(typeof body.content).toBe("string");
    expect((sendCall!.init.headers as Record<string, string>).authorization).toBe("Bearer t-token-1");
  });

  it("prefers chat_id over open_id when both are given", async () => {
    process.env.FEISHU_APP_ID = "cli_test_app";
    process.env.FEISHU_APP_SECRET = "test_secret";
    const calls = stubFetch((url) =>
      url.includes("tenant_access_token")
        ? { body: { code: 0, tenant_access_token: "t", expire: 7200 } }
        : { body: { code: 0, data: {} } }
    );

    await directHttpCardTransport.sendCard({ chatId: "oc_chat_9", openId: "ou_user_1" }, {});

    const sendCall = calls.find((c) => c.url.includes("/im/v1/messages?"))!;
    expect(sendCall.url).toContain("receive_id_type=chat_id");
    expect(JSON.parse(String(sendCall.init.body)).receive_id).toBe("oc_chat_9");
  });

  it("surfaces the Feishu error message on a non-zero code without leaking the token", async () => {
    process.env.FEISHU_APP_ID = "cli_test_app";
    process.env.FEISHU_APP_SECRET = "test_secret";
    stubFetch((url) =>
      url.includes("tenant_access_token")
        ? { body: { code: 0, tenant_access_token: "secret-token-x", expire: 7200 } }
        : { status: 400, body: { code: 230001, msg: "invalid receive_id" } }
    );

    const result = await directHttpCardTransport.sendCard({ openId: "ou_bad" }, {});

    expect(result.ok).toBe(false);
    expect(result.error).toContain("invalid receive_id");
    expect(result.error).not.toContain("secret-token-x");
  });

  it("fails cleanly when app credentials are absent", async () => {
    const result = await directHttpCardTransport.sendCard({ openId: "ou_user_1" }, {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not configured");
  });

  it("updates a card via PATCH im/v1/messages/:id", async () => {
    process.env.FEISHU_APP_ID = "cli_test_app";
    process.env.FEISHU_APP_SECRET = "test_secret";
    const calls = stubFetch((url) =>
      url.includes("tenant_access_token")
        ? { body: { code: 0, tenant_access_token: "t", expire: 7200 } }
        : { body: { code: 0 } }
    );

    const result = await directHttpCardTransport.updateCard("om_77", { schema: "2.0" });

    expect(result).toEqual({ ok: true });
    const patchCall = calls.find((c) => c.url.includes("/im/v1/messages/om_77"))!;
    expect(patchCall.init.method).toBe("PATCH");
  });
});
