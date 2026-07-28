import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  allowReportFallbackDelivery,
  buildFeishuCardPayload,
  buildReportConclusionCard,
  buildReportSummaryMarkdown,
  deliverOperationalAlertToFeishu,
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

  it("keeps Feishu reports to a single conclusion card even if the legacy full mode is set", () => {
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

// 2026-07-28 (spec drift, §1.1 + §0.2): a report is delivered as ONE
// conclusion card whose button opens the platform page. These cover the card
// the delivery path builds; the delivery path itself is covered further down.
describe("buildReportConclusionCard", () => {
  const previousBaseUrl = process.env.PLATFORM_PUBLIC_BASE_URL;

  afterEach(() => {
    if (previousBaseUrl === undefined) {
      delete process.env.PLATFORM_PUBLIC_BASE_URL;
    } else {
      process.env.PLATFORM_PUBLIC_BASE_URL = previousBaseUrl;
    }
  });

  it("renders the caller's conclusion, its confidence tier and a deep-link button", () => {
    process.env.PLATFORM_PUBLIC_BASE_URL = "https://reports.qingverse.com";

    const card = buildReportConclusionCard({
      title: "OpenClaw 日报 2026-07-28",
      markdown: "# OpenClaw 日报 2026-07-28\n\n窗口：2026-07-27 20:00 - 2026-07-28 20:00（北京时间）\n",
      reportKind: "daily",
      reportDate: "2026-07-28",
      conclusion: {
        headline: "科技股情绪回暖，仓位维持不变。",
        confidence: "中",
        bullets: ["QQQ 最新价 738.31，较前收上涨 0.37%。", "新闻主线偏中性偏多。"]
      }
    });

    expect(card.title).toBe("OpenClaw 日报 2026-07-28");
    expect(card.url).toEqual({ text: "查看完整报告", href: "https://reports.qingverse.com/daily/2026-07-28" });
    const text = card.lines.join("\n");
    expect(text).toContain("窗口：2026-07-27 20:00");
    expect(text).toContain("科技股情绪回暖，仓位维持不变。");
    expect(text).toContain("置信度");
    expect(text).toContain("中");
    expect(text).toContain("- QQQ 最新价 738.31，较前收上涨 0.37%。");
  });

  it("falls back to the report's own actionable bullets when the caller supplies no conclusion", () => {
    process.env.PLATFORM_PUBLIC_BASE_URL = "https://reports.qingverse.com";

    const card = buildReportConclusionCard({
      title: "OpenClaw 个股分析 2026-07-28",
      markdown: [
        "# OpenClaw 个股分析 2026-07-28",
        "",
        "## 本批次结论",
        "",
        "- AAPL.US：支撑位 276.83；阻力位 312.51。"
      ].join("\n"),
      reportKind: "stock-analysis",
      reportDate: "2026-07-28"
    });

    expect(card.lines.join("\n")).toContain("AAPL.US：支撑位 276.83；阻力位 312.51。");
    expect(card.url?.href).toBe("https://reports.qingverse.com/stock-analysis/2026-07-28");
  });

  it("ships without a button - and says where the full text lives - when no public base url is configured", () => {
    delete process.env.PLATFORM_PUBLIC_BASE_URL;

    const card = buildReportConclusionCard({
      title: "OpenClaw 日报 2026-07-28",
      markdown: "# OpenClaw 日报 2026-07-28\n\n## 1. 今日结论\n\n- 市场信号：QQQ 走平。",
      reportKind: "daily",
      reportDate: "2026-07-28"
    });

    expect(card.url).toBeUndefined();
    const text = card.lines.join("\n");
    expect(text).toContain("请在平台查看全文");
    // A path with no origin is useless in a Feishu client, and a made-up host
    // would be fabricated data (deep-links.ts, §0.4).
    expect(text).not.toContain("/daily/");
  });

  it("has no button when the caller does not say which page holds the report", () => {
    process.env.PLATFORM_PUBLIC_BASE_URL = "https://reports.qingverse.com";

    const card = buildReportConclusionCard({
      title: "OpenClaw 模拟盘收支变化 2026-07-28",
      markdown: "# OpenClaw 模拟盘收支变化 2026-07-28\n\n## 收支变化表\n\n- 今日净值持平。"
    });

    expect(card.url).toBeUndefined();
    expect(card.lines.join("\n")).toContain("请在平台查看全文");
  });

  it("states the gap honestly when the report yields no summarizable conclusion", () => {
    process.env.PLATFORM_PUBLIC_BASE_URL = "https://reports.qingverse.com";

    const card = buildReportConclusionCard({
      title: "OpenClaw 日报 2026-07-28",
      markdown: "# OpenClaw 日报 2026-07-28\n\n## 1. 今日结论\n\n正文没有任何要点行。",
      reportKind: "daily",
      reportDate: "2026-07-28"
    });

    expect(card.lines.join("\n")).toContain("未提取到");
    expect(card.url?.href).toBe("https://reports.qingverse.com/daily/2026-07-28");
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
    "FEISHU_GROUP_CHAT_ID",
    "FEISHU_WEBHOOK_URL",
    "FEISHU_NOTIFICATION_RETRY_ATTEMPTS",
    "FEISHU_USER_PLUGIN_BOT_CHAT_ID",
    "PLATFORM_PUBLIC_BASE_URL",
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

  interface CardJson {
    header: { title: { content: string } };
    body: {
      elements: Array<{
        tag: string;
        content?: string;
        actions?: Array<{ tag: string; text: { tag: string; content: string }; type?: string; url?: string }>;
      }>;
    };
  }

  function cardFrom(send: { body: { content: string } }): CardJson {
    return JSON.parse(send.body.content) as CardJson;
  }

  // 2026-07-28 (spec drift CRIT-1/2). This path used to push the summary AND
  // every chapter, deliberately bypassing shouldSendFullReportChapters() - a
  // live daily run pushed 10 Feishu messages. One card, one link.
  it("delivers ONE interactive card with a platform deep link, not the summary plus every chapter", async () => {
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_global_member";
    process.env.PLATFORM_PUBLIC_BASE_URL = "https://reports.qingverse.com";
    const calls = stubFetch(okFeishu());

    const result = await deliverReportToFeishu({
      title: "OpenClaw 日报 2026-07-26",
      markdown: REPORT_MARKDOWN,
      reportKind: "daily",
      reportDate: "2026-07-26"
    });

    expect(result.sent).toBe(true);
    expect(result.target).toBe("feishu-app-open-id");

    const sends = messageCalls(calls);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.url).toContain("receive_id_type=open_id");
    expect(sends[0]!.body.receive_id).toBe("ou_global_member");
    expect(sends[0]!.headers.authorization).toBe("Bearer t-token-report");
    expect(sends[0]!.body.msg_type).toBe("interactive");

    const card = cardFrom(sends[0]!);
    expect(card.header.title.content).toBe("OpenClaw 日报 2026-07-26");
    expect(JSON.stringify(card.body.elements)).toContain("QQQ 最新价 738.31");
    const action = card.body.elements.find((element) => element.tag === "action");
    expect(action?.actions).toContainEqual({
      tag: "button",
      text: { tag: "plain_text", content: "查看完整报告" },
      type: "default",
      url: "https://reports.qingverse.com/daily/2026-07-26"
    });
    // The card carries the conclusion, not the body: the 明日跟踪 chapter
    // lives on the platform page the button opens.
    expect(JSON.stringify(card)).not.toContain("先看 730 - 745 区间");

    expect(result.deliveries.map((entry) => entry.kind)).toEqual(["summary"]);
    expect(result.deliveries.every((entry) => entry.sent)).toBe(true);
  });

  it("sends a button-free card that points at the platform in prose when no base url is configured", async () => {
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_global_member";
    delete process.env.PLATFORM_PUBLIC_BASE_URL;
    const calls = stubFetch(okFeishu());

    const result = await deliverReportToFeishu({
      title: "OpenClaw 日报 2026-07-26",
      markdown: REPORT_MARKDOWN,
      reportKind: "daily",
      reportDate: "2026-07-26"
    });

    expect(result.sent).toBe(true);
    const sends = messageCalls(calls);
    expect(sends).toHaveLength(1);
    const card = cardFrom(sends[0]!);
    expect(card.body.elements.some((element) => element.tag === "action")).toBe(false);
    expect(JSON.stringify(card)).toContain("请在平台查看全文");
    expect(JSON.stringify(card)).not.toContain("/daily/");
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
    const sends = messageCalls(calls);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.body.receive_id).toBe("ou_owner_specific");
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
    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]!.sent).toBe(false);
    expect(JSON.stringify(result.deliveries)).not.toContain("secret-token-x");
  });

  // Task 7 (2026-07-28 spec drift). §4: 群 carries 公共报告发布卡, 单聊 carries
  // the personal ones. Everything used to land in the same DM because report
  // delivery had exactly one target notion.
  it("sends a public report card to the configured group chat instead of the DM target", async () => {
    process.env.FEISHU_GROUP_CHAT_ID = "oc_public_group";
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_global_member";
    const calls = stubFetch(okFeishu());

    const result = await deliverReportToFeishu({
      title: "OpenClaw 日报 2026-07-26",
      markdown: REPORT_MARKDOWN,
      audience: "group",
      reportKind: "daily",
      reportDate: "2026-07-26"
    });

    expect(result.sent).toBe(true);
    expect(result.target).toBe("feishu-app-chat-id");
    expect(result.groupFallback).toBeFalsy();

    const sends = messageCalls(calls);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.url).toContain("receive_id_type=chat_id");
    expect(sends[0]!.body.receive_id).toBe("oc_public_group");
  });

  it("falls back to the DM target and says why when no group chat id is configured", async () => {
    delete process.env.FEISHU_GROUP_CHAT_ID;
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_global_member";
    const calls = stubFetch(okFeishu());

    const result = await deliverReportToFeishu({
      title: "OpenClaw 日报 2026-07-26",
      markdown: REPORT_MARKDOWN,
      audience: "group",
      reportKind: "daily",
      reportDate: "2026-07-26"
    });

    expect(result.sent).toBe(true);
    expect(result.target).toBe("feishu-app-open-id");
    expect(result.groupFallback).toBe(true);
    expect(result.groupFallbackReason).toContain("FEISHU_GROUP_CHAT_ID");

    const sends = messageCalls(calls);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.body.receive_id).toBe("ou_global_member");
  });

  it("keeps an owner-scoped report in that owner's DM even when a group chat id is configured", async () => {
    process.env.FEISHU_GROUP_CHAT_ID = "oc_public_group";
    const calls = stubFetch(okFeishu());

    const result = await deliverReportToFeishu({
      title: "我的个人页 · 日报 2026-07-26",
      markdown: REPORT_MARKDOWN,
      openId: "ou_owner_specific",
      audience: "group",
      reportKind: "personal-daily",
      reportDate: "2026-07-26"
    });

    expect(result.sent).toBe(true);
    expect(result.target).toBe("feishu-app-open-id");
    expect(result.groupFallback).toBeFalsy();

    const sends = messageCalls(calls);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.url).toContain("receive_id_type=open_id");
    expect(sends[0]!.body.receive_id).toBe("ou_owner_specific");
  });

  it("stays at one message for a long report - no chapter fan-out to fall back to", async () => {
    process.env.FEISHU_NOTIFY_CHAT_ID = "oc_group_chat";
    const calls = stubFetch(okFeishu());
    const longSection = ["## 1. 今日结论", "", "段落一".repeat(400), "", "段落二".repeat(400)].join("\n");

    const result = await deliverReportToFeishu({
      title: "OpenClaw 日报 2026-07-26",
      markdown: `# OpenClaw 日报 2026-07-26\n\n${longSection}`,
      maxSectionChars: 100
    });

    expect(result.sent).toBe(true);
    expect(result.target).toBe("feishu-app-chat-id");
    expect(result.deliveries.map((entry) => entry.kind)).toEqual(["summary"]);
    const sends = messageCalls(calls);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.url).toContain("receive_id_type=chat_id");
    expect(sends[0]!.body.receive_id).toBe("oc_group_chat");
  });
});

// 2026-07-28 (spec drift A1, CRITICAL regression). openclaw-cron-runner.mjs
// bound its alert transport to deliverReportToFeishu. Once that path collapsed
// a report into ONE conclusion card, every runner alert (job failure, halt
// escalation, discovery gap, state-persist failure) became a card with no
// content: alert markdown has no 窗口 line, no conclusion box and none of the
// headings extractActionableSummaryBullets looks for, so the card degraded to
// the honest-but-useless "未提取到可摘要的结论要点" line and the ENTIRE alert
// body - the error, the exit code, the stderr tail - was dropped on the floor.
//
// An operational alert is not a report: no platform page holds the rest of it
// and there is nothing to summarize, so the body IS the payload and goes out
// verbatim. These tests assert the FEISHU-FACING message, not our own payload
// type, because the abstraction is exactly what hid the regression.
describe("deliverOperationalAlertToFeishu (operational alerts are not reports)", () => {
  const realFetch = globalThis.fetch;
  const envKeys = [
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_ACCOUNT_ID",
    "FEISHU_DOMAIN",
    "FEISHU_NOTIFY_OPEN_ID",
    "FEISHU_NOTIFY_CHAT_ID",
    "FEISHU_GROUP_CHAT_ID",
    "FEISHU_WEBHOOK_URL",
    "FEISHU_NOTIFICATION_RETRY_ATTEMPTS",
    "FEISHU_USER_PLUGIN_BOT_CHAT_ID",
    "FEISHU_USER_PLUGIN_DISABLED",
    "PLATFORM_PUBLIC_BASE_URL",
    "HOME"
  ] as const;
  const savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};
  const savedCwd = process.cwd();
  let tempDir: string | undefined;

  // The real shape openclaw-cron-runner-alerts.mjs produces (buildCronFailure-
  // AlertMarkdown): "## 摘要" / "## 证据" headings, evidence in fenced blocks.
  // Deliberately NOT report-shaped - that mismatch is the whole defect.
  const ALERT_MARKDOWN = [
    "# OpenClaw 自动报告失败告警",
    "",
    "## 摘要",
    "",
    "- 任务：daily",
    "- 命令：pnpm report:daily:run",
    "- 退出：code=1，signal=null",
    "",
    "## 证据",
    "",
    "- 错误：子进程返回非零退出码。",
    "",
    "### stderr 尾部",
    "",
    "```",
    "Longbridge quote lock timed out after 50s",
    "```"
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

  function stubFetch(handler: (url: string) => { status?: number; body: unknown }) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const out = handler(String(url));
      return new Response(JSON.stringify(out.body), { status: out.status ?? 200 });
    }) as typeof fetch;
    return calls;
  }

  function okFeishu(url: string) {
    return url.includes("tenant_access_token")
      ? { body: { code: 0, tenant_access_token: "t-token-alert", expire: 7200 } }
      : { body: { code: 0, msg: "success", data: { message_id: "om_alert" } } };
  }

  function outboundMessages(calls: Array<{ url: string; init: RequestInit }>) {
    return calls
      .filter((call) => call.url.includes("/open-apis/im/v1/messages?"))
      .map((call) => JSON.parse(String(call.init.body)) as {
        receive_id: string;
        msg_type: string;
        content: string;
      });
  }

  it("puts the whole alert body in the outbound Feishu message, verbatim", async () => {
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_operator";
    const calls = stubFetch(okFeishu);

    const result = await deliverOperationalAlertToFeishu({
      title: "OpenClaw 自动报告失败告警：daily",
      markdown: ALERT_MARKDOWN,
      maxSectionChars: 3600
    });

    expect(result.sent).toBe(true);
    expect(result.target).toBe("feishu-app-open-id");

    const sends = outboundMessages(calls);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.receive_id).toBe("ou_operator");
    // A text/post message, NOT an interactive card: a card summarizes, and an
    // alert has nothing to summarize from.
    expect(sends[0]!.msg_type).toBe("post");
    // Every load-bearing line of the alert must be findable in what Feishu
    // actually receives - this is the assertion the card path could not pass.
    for (const needle of [
      "任务：daily",
      "命令：pnpm report:daily:run",
      "退出：code=1，signal=null",
      "错误：子进程返回非零退出码。",
      "Longbridge quote lock timed out after 50s"
    ]) {
      expect(sends[0]!.content).toContain(needle);
    }
  });

  // The regression itself, pinned from the Feishu side: routing an alert
  // through the report path silently throws the body away.
  it("is the reason an alert must NOT go through the report path (which drops the body)", async () => {
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_operator";
    const calls = stubFetch(okFeishu);

    await deliverReportToFeishu({
      title: "OpenClaw 自动报告失败告警：daily",
      markdown: ALERT_MARKDOWN
    });

    const sends = outboundMessages(calls);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.msg_type).toBe("interactive");
    expect(sends[0]!.content).not.toContain("Longbridge quote lock timed out after 50s");
    expect(sends[0]!.content).not.toContain("退出：code=1");
  });

  it("splits a long alert across messages instead of truncating it", async () => {
    process.env.FEISHU_NOTIFY_CHAT_ID = "oc_ops_chat";
    const calls = stubFetch(okFeishu);
    const tail = "堆栈第一段".repeat(80);
    const head = "堆栈第二段".repeat(80);

    const result = await deliverOperationalAlertToFeishu({
      title: "OpenClaw cron-runner 状态持久化失败",
      markdown: `# 状态持久化失败\n\n${head}\n\n${tail}`,
      maxSectionChars: 200
    });

    expect(result.sent).toBe(true);
    const sends = outboundMessages(calls);
    expect(sends.length).toBeGreaterThan(1);
    const combined = sends.map((send) => send.content).join("");
    expect(combined).toContain(head.slice(0, 100));
    expect(combined).toContain(tail.slice(0, 100));
    expect(result.deliveries.every((entry) => entry.sent)).toBe(true);
  });

  it("reports {sent:false, reason} - never throws - when no alert target resolves", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "notifications-alert-no-target-"));
    process.env.HOME = tempDir;
    process.chdir(tempDir);
    const calls = stubFetch(okFeishu);

    const result = await deliverOperationalAlertToFeishu({
      title: "OpenClaw cron-runner 发现盲区：daily",
      markdown: ALERT_MARKDOWN
    });

    expect(result.sent).toBe(false);
    expect(result.target).toBe("none");
    expect(result.reason).toMatch(/FEISHU_NOTIFY_OPEN_ID/);
    expect(calls).toHaveLength(0);
  });

  it("surfaces a rejected alert send without leaking the tenant token", async () => {
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_bad";
    stubFetch((url) => url.includes("tenant_access_token")
      ? { body: { code: 0, tenant_access_token: "secret-token-x", expire: 7200 } }
      : { status: 400, body: { code: 230001, msg: "invalid receive_id" } });

    const result = await deliverOperationalAlertToFeishu({
      title: "OpenClaw 自动报告失败告警：daily",
      markdown: ALERT_MARKDOWN
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toContain("invalid receive_id");
    expect(JSON.stringify(result)).not.toContain("secret-token-x");
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
