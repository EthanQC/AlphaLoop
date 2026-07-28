import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NotificationTargetRepository, openTradingDatabase } from "./database.js";
import {
  allowReportFallbackDelivery,
  buildFeishuCardPayload,
  buildReportConclusionCard,
  buildReportSummaryMarkdown,
  deliverOperationalAlertToFeishu,
  deliverReportToFeishu,
  isFeishuProseFailure,
  isUnconfiguredCardTargetError,
  directHttpCardTransport,
  sendInteractiveCard,
  shouldSendFullReportChapters,
  updateInteractiveCard,
  type CardTarget,
  type CardTransport,
  type InteractiveCard,
  type ReportScope
} from "./notifications.js";
import { resolveRuntimePaths } from "./runtime.js";

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

  // 2026-07-28 (spec drift A2, sibling defect). A missing link had three
  // different causes and one hard-coded line blaming the deployment's config
  // for all of them, so a caller that simply forgot reportKind read as "this
  // deployment has no public address". Each cause now names itself.
  it("names the missing base url as the reason when the deployment has no public address", () => {
    delete process.env.PLATFORM_PUBLIC_BASE_URL;

    const card = buildReportConclusionCard({
      title: "OpenClaw 日报 2026-07-28",
      markdown: "# OpenClaw 日报 2026-07-28\n\n## 1. 今日结论\n\n- 市场信号：QQQ 走平。",
      reportKind: "daily",
      reportDate: "2026-07-28"
    });

    expect(card.url).toBeUndefined();
    const text = card.lines.join("\n");
    expect(text).toContain("PLATFORM_PUBLIC_BASE_URL");
    expect(text).toContain("请在平台查看全文");
    expect(text).not.toContain("未指定平台页面");
    // A path with no origin is useless in a Feishu client, and a made-up host
    // would be fabricated data (deep-links.ts, §0.4).
    expect(text).not.toContain("/daily/");
  });

  it("says the caller named no page - not that the deployment lacks an address - when reportKind is missing", () => {
    process.env.PLATFORM_PUBLIC_BASE_URL = "https://reports.qingverse.com";

    const card = buildReportConclusionCard({
      title: "OpenClaw 模拟盘收支变化 2026-07-28",
      markdown: "# OpenClaw 模拟盘收支变化 2026-07-28\n\n## 收支变化表\n\n- 今日净值持平。"
    });

    expect(card.url).toBeUndefined();
    const text = card.lines.join("\n");
    expect(text).toContain("未指定平台页面");
    expect(text).toContain("请在平台查看全文");
    // The base url IS configured here - blaming it would be a lie.
    expect(text).not.toContain("PLATFORM_PUBLIC_BASE_URL");
  });

  it("reports a rejected deep-link target instead of pretending the deployment is unconfigured", () => {
    process.env.PLATFORM_PUBLIC_BASE_URL = "https://reports.qingverse.com";

    const card = buildReportConclusionCard({
      title: "OpenClaw 个股分析 2026-07-28",
      markdown: "# OpenClaw 个股分析 2026-07-28\n\n## 本批次结论\n\n- AAPL.US：支撑位 276.83。",
      // The .mjs report callers are plain JS: a typo'd kind reaches this at
      // runtime with no compiler in the way.
      reportKind: "stock-analysis-typo" as never,
      reportDate: "2026-07-28"
    });

    expect(card.url).toBeUndefined();
    const text = card.lines.join("\n");
    expect(text).toContain("无法生成报告链接");
    expect(text).toContain("stock-analysis-typo");
    expect(text).not.toContain("PLATFORM_PUBLIC_BASE_URL");
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

  // 2026-07-28 (spec drift A2). These assert the JSON FEISHU parses, not our
  // InteractiveCard type, because that abstraction is what let card 1.0 button
  // syntax live inside a `schema: "2.0"` payload unnoticed: the button carried
  // a top-level `url`, and the buttons sat in a `{tag:"action"}` module.
  //
  // Card JSON 2.0 (open.feishu.cn/document/feishu-cards/card-json-v2-components
  // /interactive-components/button): the button's field table lists `behaviors`
  // as 必填 and lists NEITHER `url` NOR `value`; navigation is
  // `behaviors:[{type:"open_url", default_url, pc_url, ios_url, android_url}]`
  // and callbacks are `behaviors:[{type:"callback", value:{...}}]`. `url` /
  // `multi_url` are 1.0 历史属性. The 2.0 breaking-change notes
  // (.../card-json-v2-breaking-changes-release-notes) remove the 备注/交互
  // (action) modules and, critically, say unsupported properties are now
  // REJECTED with an error instead of silently ignored - so the old payload was
  // not merely a dead button, it risked every card being refused outright.
  // 2026-07-28 (R4). That check used to be a substring scan for
  // ['"tag":"action"', '"url":', '"multi_url"', '"value":']. Three of those are
  // real 1.0 markers; `"value":` is not. In card JSON 2.0 `value` is LEGAL and
  // required inside a callback behavior - behaviors:[{type:"callback",
  // value:{...}}] - which is exactly what the approval button must emit, so the
  // guard would have rejected correct 2.0 syntax and blocked that work. A
  // substring scan cannot tell the two apart because it never sees where in the
  // document the key sits.
  //
  // This walks the payload instead and judges each key BY POSITION:
  //   - `action` / `note` modules: removed in 2.0 outright.
  //   - `url` / `multi_url` / `value` on a COMPONENT (any node with a `tag`):
  //     1.0 历史属性; 2.0 moves all three into `behaviors`.
  //   - inside `behaviors`: `value` is legal on a `callback` behavior and only
  //     there; navigation is `default_url`/`pc_url`/`ios_url`/`android_url`,
  //     never a bare `url`/`multi_url`.
  const REMOVED_IN_CARD_2_0_MODULES = new Set(["action", "note"]);
  const CARD_1_0_COMPONENT_FIELDS = ["url", "multi_url", "value"] as const;

  function findCard1_0Constructs(node: unknown, path = "$", insideBehaviors = false): string[] {
    if (Array.isArray(node)) {
      return node.flatMap((item, index) => findCard1_0Constructs(item, `${path}[${index}]`, insideBehaviors));
    }
    if (node === null || typeof node !== "object") {
      return [];
    }

    const object = node as Record<string, unknown>;
    const found: string[] = [];

    if (insideBehaviors) {
      if ("url" in object) {
        found.push(`${path}.url — card 1.0 link field; 2.0 navigation uses default_url`);
      }
      if ("multi_url" in object) {
        found.push(`${path}.multi_url — card 1.0 only`);
      }
      if ("value" in object && object.type !== "callback") {
        found.push(`${path}.value on a "${String(object.type)}" behavior — 2.0 carries value only on a callback behavior`);
      }
    } else if (typeof object.tag === "string") {
      if (REMOVED_IN_CARD_2_0_MODULES.has(object.tag)) {
        found.push(`${path}.tag="${object.tag}" — module removed in card JSON 2.0`);
      }
      for (const field of CARD_1_0_COMPONENT_FIELDS) {
        if (field in object) {
          found.push(`${path}.${field} — card 1.0 component field; 2.0 puts it in behaviors`);
        }
      }
    }

    for (const [key, child] of Object.entries(object)) {
      found.push(...findCard1_0Constructs(child, `${path}.${key}`, key === "behaviors"));
    }
    return found;
  }

  // The guard has to be shown to still BITE, or narrowing it is indistinguishable
  // from deleting it. This is a genuine card 1.0 approval card, hand-written from
  // the 1.0 docs rather than produced by anything in this repo.
  const GENUINE_CARD_1_0_PAYLOAD = {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: "审批" }, template: "blue" },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: "是否批准这笔交易？" } },
      {
        tag: "action",
        actions: [
          { tag: "button", text: { tag: "plain_text", content: "批准" }, type: "primary", value: { key: "approve:12345" } },
          { tag: "button", text: { tag: "plain_text", content: "查看报告" }, type: "default", url: "https://example.com/r" },
          { tag: "button", text: { tag: "plain_text", content: "多端" }, type: "default", multi_url: { url: "https://example.com/r" } }
        ]
      }
    ]
  };

  it("flags every genuine card 1.0 construct - the guard still bites after being narrowed", () => {
    const found = findCard1_0Constructs(GENUINE_CARD_1_0_PAYLOAD);

    expect(found.some((entry) => entry.includes('tag="action"'))).toBe(true);
    expect(found.some((entry) => entry.includes(".value —"))).toBe(true);
    expect(found.some((entry) => entry.includes(".url —"))).toBe(true);
    expect(found.some((entry) => entry.includes(".multi_url —"))).toBe(true);
  });

  // The shape the next task (the Feishu approval-button callback) must emit,
  // written out here independently of buildFeishuCardPayload so the guard is
  // proven against the DOCUMENTED 2.0 syntax and not merely against whatever
  // this repo happens to produce.
  it("passes a valid card 2.0 callback behavior - `value` inside behaviors is 2.0, not 1.0", () => {
    const validCard2_0Callback = {
      schema: "2.0",
      config: { update_multi: true },
      header: { title: { tag: "plain_text", content: "审批" }, template: "blue" },
      body: {
        elements: [
          { tag: "markdown", content: "是否批准这笔交易？" },
          {
            tag: "button",
            text: { tag: "plain_text", content: "批准" },
            type: "primary",
            behaviors: [{ type: "callback", value: { action: "approve", proposalId: "prop_12345" } }]
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "查看报告" },
            type: "default",
            behaviors: [{ type: "open_url", default_url: "https://example.com/r", pc_url: "https://example.com/r" }]
          }
        ]
      }
    };

    expect(findCard1_0Constructs(validCard2_0Callback)).toEqual([]);
    // ... and the substring scan this replaced would have rejected it.
    expect(JSON.stringify(validCard2_0Callback)).toContain('"value":');
  });

  it("expresses a link as a card 2.0 open_url behavior, never the 1.0 url field", () => {
    const card: InteractiveCard = {
      title: "详情",
      lines: ["点击查看完整报告"],
      url: { text: "查看报告", href: "https://example.com/report/2026-07-12" }
    };

    const payload = buildFeishuCardPayload(card);
    const elements = (payload as { body: { elements: Array<Record<string, unknown>> } }).body.elements;
    const button = elements.find((element) => element.tag === "button");

    expect(button).toEqual({
      tag: "button",
      text: { tag: "plain_text", content: "查看报告" },
      type: "default",
      behaviors: [{
        type: "open_url",
        default_url: "https://example.com/report/2026-07-12",
        pc_url: "https://example.com/report/2026-07-12",
        ios_url: "https://example.com/report/2026-07-12",
        android_url: "https://example.com/report/2026-07-12"
      }]
    });
    // The button is a body element in its own right: 2.0 has no action module
    // to wrap it in.
    expect(elements.some((element) => element.tag === "action")).toBe(false);
    expect(findCard1_0Constructs(payload)).toEqual([]);
  });

  it("expresses a callback button as a card 2.0 callback behavior carrying the OpenClaw value", () => {
    const card: InteractiveCard = {
      title: "审批",
      lines: ["是否批准这笔交易？"],
      buttons: [
        { text: "批准", value: "approve:12345", style: "primary" },
        { text: "拒绝", value: "reject:12345", style: "danger" },
        { text: "忽略", value: "ignore:12345" }
      ]
    };

    const payload = buildFeishuCardPayload(card);
    const elements = (payload as { body: { elements: Array<Record<string, unknown>> } }).body.elements;

    expect(elements.filter((element) => element.tag === "button")).toEqual([
      {
        tag: "button",
        text: { tag: "plain_text", content: "批准" },
        type: "primary",
        behaviors: [{ type: "callback", value: { value: "approve:12345" } }]
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "拒绝" },
        type: "danger",
        behaviors: [{ type: "callback", value: { value: "reject:12345" } }]
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "忽略" },
        type: "default",
        behaviors: [{ type: "callback", value: { value: "ignore:12345" } }]
      }
    ]);
    // The callback payload the approval handler reads is unchanged - it just
    // travels inside the behavior now instead of a top-level `value`.
    expect(JSON.stringify(payload)).toContain('"value":{"value":"approve:12345"}');
    expect(elements.some((element) => element.tag === "action")).toBe(false);
    // This card is the one the old substring guard would have rejected: it
    // contains `"value":` and is nonetheless valid 2.0.
    expect(findCard1_0Constructs(payload)).toEqual([]);
  });

  it("keeps a link button alongside callback buttons, both in 2.0 syntax", () => {
    const card: InteractiveCard = {
      title: "详情",
      lines: ["点击查看完整报告"],
      buttons: [{ text: "确认", value: "confirm" }],
      url: { text: "查看报告", href: "https://example.com/report/2026-07-12" }
    };

    const payload = buildFeishuCardPayload(card);
    const buttons = (payload as { body: { elements: Array<Record<string, unknown>> } }).body.elements
      .filter((element) => element.tag === "button");

    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => Array.isArray(button.behaviors))).toBe(true);
    expect(JSON.stringify(payload)).not.toContain('"tag":"action"');
    expect(JSON.stringify(payload)).not.toContain('"url":"https');
  });

  it("emits no button element at all when there are no buttons and no url", () => {
    const card: InteractiveCard = {
      title: "纯文本卡片",
      lines: ["没有按钮的卡片"]
    };

    const payload = buildFeishuCardPayload(card) as {
      body: { elements: Array<{ tag: string }> };
    };

    expect(payload.body.elements.some((element) => element.tag === "button")).toBe(false);
    expect(payload.body.elements.some((element) => element.tag === "action")).toBe(false);
  });

  it("declares only card 2.0 top-level fields (schema, config.update_multi=true, header, body)", () => {
    const payload = buildFeishuCardPayload({ title: "标题", lines: ["一行"] }) as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual(["body", "config", "header", "schema"]);
    expect(payload.schema).toBe("2.0");
    // JSON 2.0 只支持 update_multi=true (v2 structure doc).
    expect(payload.config).toEqual({ update_multi: true });
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
      // Declared public, because this channel's one chat IS the group and an
      // UNDECLARED payload is now refused before it gets here (R2). The subject
      // of this test is the PDF step's prose failure, not the scope rule.
      scope: { visibility: "circle-public" },
      title: "测试报告",
      markdown: "# 测试报告\n\n内容",
      pdfPath
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/Send failed/);
    // ... and it really did go through the legacy user-plugin channel.
    expect(result.target).toBe("feishu-user-plugin-bot-post");
  });

  // 2026-07-28 (spec drift A4). This channel posts to ONE fixed chat -
  // resolveFeishuUserPluginBotChatId(), the shared 炒股这一块 group - and cannot
  // address a second target. It ignored payload.openId entirely, so with app
  // credentials absent every member's PERSONAL page card went to that shared
  // group and came back recorded as delivered. Silent misdelivery reported as
  // success is the one outcome that must be impossible: owner-scoped content
  // never reaches a shared chat, and if it cannot be addressed the caller is
  // told so.
  it("refuses an owner-scoped report on the shared-chat channel instead of leaking it there", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "notifications-owner-scoped-"));
    const scriptPath = join(tempDir, "fake-plugin.mjs");
    const spawnMarkerPath = join(tempDir, "plugin-was-spawned.log");
    // Any spawn at all is a failure here: the refusal must happen before the
    // channel is touched, so the marker file must never come into existence.
    writeFileSync(
      scriptPath,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(spawnMarkerPath)}, "spawned", "utf8");\n${FAKE_PLUGIN_SCRIPT}`,
      "utf8"
    );

    process.env.LARK_APP_ID = "test_app_id";
    process.env.LARK_APP_SECRET = "test_app_secret";
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    process.env.FEISHU_ACCOUNT_ID = "__no_such_account__";
    process.env.FEISHU_USER_PLUGIN_BOT_CHAT_ID = "oc_shared_group_chat";
    process.env.FEISHU_USER_PLUGIN_COMMAND = process.execPath;
    process.env.FEISHU_USER_PLUGIN_ARGS = JSON.stringify([scriptPath]);
    process.env.FEISHU_NOTIFICATION_RETRY_ATTEMPTS = "1";
    delete process.env.FEISHU_USER_PLUGIN_DISABLED;

    const result = await deliverReportToFeishu({
      title: "我的个人页 · 日报 2026-07-28",
      markdown: "# 我的个人页 · 日报 2026-07-28\n\n## 1. 今日结论\n\n- 我的持仓：QQQ 1 份。",
      openId: "ou_owner_specific",
      reportKind: "personal-daily",
      reportDate: "2026-07-28"
    });

    expect(result.sent).toBe(false);
    expect(existsSync(spawnMarkerPath)).toBe(false);
    expect(result.target).toBe("feishu-user-plugin-bot-post");
    // The reason has to name the real problem - the channel cannot address one
    // member - so an operator fixes the credentials instead of hunting a
    // transport error that never happened.
    expect(result.reason).toMatch(/ou_owner_specific/);
    expect(result.reason).toMatch(/FEISHU_APP_ID/);
    expect(result.deliveries.every((entry) => !entry.sent)).toBe(true);
  });

  // 2026-07-28 (R2, then R3). The openId-shaped guard above catches only
  // payloads that happen to carry an openId. The 模拟盘收支变化 report is just
  // as owner-private and carried NONE - `audience: "dm"` and nothing else - so
  // it walked through and was published here. An UNDECLARED payload is refused
  // for the same reason a declared-private one is: nothing about it proves it
  // may be shown to everyone in a shared chat. R3 moved that refusal upstream
  // of channel selection (see "refuses an undeclared payload before choosing a
  // channel"), so this now pins the outcome from the channel's side - the
  // plugin is never spawned no matter which channel would have been picked.
  it("refuses a payload that declares no scope at all, rather than assuming it is publishable", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "notifications-undeclared-"));
    const scriptPath = join(tempDir, "fake-plugin.mjs");
    const spawnMarkerPath = join(tempDir, "plugin-was-spawned.log");
    writeFileSync(
      scriptPath,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(spawnMarkerPath)}, "spawned", "utf8");\n${FAKE_PLUGIN_SCRIPT}`,
      "utf8"
    );

    process.env.LARK_APP_ID = "test_app_id";
    process.env.LARK_APP_SECRET = "test_app_secret";
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    process.env.FEISHU_ACCOUNT_ID = "__no_such_account__";
    process.env.FEISHU_USER_PLUGIN_BOT_CHAT_ID = "oc_shared_group_chat";
    process.env.FEISHU_USER_PLUGIN_COMMAND = process.execPath;
    process.env.FEISHU_USER_PLUGIN_ARGS = JSON.stringify([scriptPath]);
    process.env.FEISHU_NOTIFICATION_RETRY_ATTEMPTS = "1";
    delete process.env.FEISHU_USER_PLUGIN_DISABLED;

    const result = await deliverReportToFeishu({
      title: "OpenClaw 模拟盘收支变化 2026-07-28",
      markdown: "# OpenClaw 模拟盘收支变化 2026-07-28\n\n- QQQ.US：数量 1，成本 663.88 USD。",
      audience: "dm"
    });

    expect(result.sent).toBe(false);
    expect(existsSync(spawnMarkerPath)).toBe(false);
    expect(result.reason).toMatch(/scope/);
    expect(result.deliveries).toEqual([]);
  });

  // The declared form of the same refusal: an owner-private payload is refused
  // whether it named its owner through `scope` or the legacy `openId`.
  it("refuses a scope-declared owner-private report and names the owner it belongs to", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "notifications-declared-private-"));
    const scriptPath = join(tempDir, "fake-plugin.mjs");
    const spawnMarkerPath = join(tempDir, "plugin-was-spawned.log");
    writeFileSync(
      scriptPath,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(spawnMarkerPath)}, "spawned", "utf8");\n${FAKE_PLUGIN_SCRIPT}`,
      "utf8"
    );

    process.env.LARK_APP_ID = "test_app_id";
    process.env.LARK_APP_SECRET = "test_app_secret";
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    process.env.FEISHU_ACCOUNT_ID = "__no_such_account__";
    process.env.FEISHU_USER_PLUGIN_BOT_CHAT_ID = "oc_shared_group_chat";
    process.env.FEISHU_USER_PLUGIN_COMMAND = process.execPath;
    process.env.FEISHU_USER_PLUGIN_ARGS = JSON.stringify([scriptPath]);
    process.env.FEISHU_NOTIFICATION_RETRY_ATTEMPTS = "1";
    delete process.env.FEISHU_USER_PLUGIN_DISABLED;

    const result = await deliverReportToFeishu({
      title: "OpenClaw 模拟盘收支变化 2026-07-28",
      markdown: "# OpenClaw 模拟盘收支变化 2026-07-28\n\n- QQQ.US：数量 1，成本 663.88 USD。",
      scope: { visibility: "owner-private", ownerOpenId: "ou_paper_owner" },
      audience: "dm"
    });

    expect(result.sent).toBe(false);
    expect(existsSync(spawnMarkerPath)).toBe(false);
    expect(result.reason).toMatch(/ou_paper_owner/);
    expect(result.reason).toMatch(/FEISHU_APP_ID/);
  });

  // A public report is what this channel's one chat is FOR, so it still ships.
  it("still delivers a group-audience report on that channel, which is the group", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "notifications-group-audience-"));
    const scriptPath = join(tempDir, "fake-plugin.mjs");
    writeFileSync(scriptPath, FAKE_PLUGIN_SCRIPT, "utf8");

    process.env.LARK_APP_ID = "test_app_id";
    process.env.LARK_APP_SECRET = "test_app_secret";
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    process.env.FEISHU_ACCOUNT_ID = "__no_such_account__";
    process.env.FEISHU_USER_PLUGIN_BOT_CHAT_ID = "oc_shared_group_chat";
    process.env.FEISHU_USER_PLUGIN_COMMAND = process.execPath;
    process.env.FEISHU_USER_PLUGIN_ARGS = JSON.stringify([scriptPath]);
    process.env.FEISHU_NOTIFICATION_RETRY_ATTEMPTS = "1";
    delete process.env.FEISHU_USER_PLUGIN_DISABLED;

    const result = await deliverReportToFeishu({
      title: "OpenClaw 日报 2026-07-28",
      markdown: "# OpenClaw 日报 2026-07-28\n\n## 1. 今日结论\n\n- 市场信号：QQQ 走平。",
      audience: "group",
      reportKind: "daily",
      reportDate: "2026-07-28"
    });

    expect(result.sent).toBe(true);
    expect(result.target).toBe("feishu-user-plugin-bot-post");

    // ... and identically when the same report says so with the explicit
    // marker instead of relying on `audience: "group"` being read as one.
    const declared = await deliverReportToFeishu({
      title: "OpenClaw 日报 2026-07-28",
      markdown: "# OpenClaw 日报 2026-07-28\n\n## 1. 今日结论\n\n- 市场信号：QQQ 走平。",
      scope: { visibility: "circle-public" },
      reportKind: "daily",
      reportDate: "2026-07-28"
    });

    expect(declared.sent).toBe(true);
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
        text?: { tag: string; content: string };
        type?: string;
        behaviors?: Array<Record<string, unknown>>;
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
      scope: { visibility: "circle-public" },
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
    // Card JSON 2.0 button: navigation via an open_url behavior, never the 1.0
    // `url` field (spec drift A2).
    expect(card.body.elements).toContainEqual({
      tag: "button",
      text: { tag: "plain_text", content: "查看完整报告" },
      type: "default",
      behaviors: [{
        type: "open_url",
        default_url: "https://reports.qingverse.com/daily/2026-07-26",
        pc_url: "https://reports.qingverse.com/daily/2026-07-26",
        ios_url: "https://reports.qingverse.com/daily/2026-07-26",
        android_url: "https://reports.qingverse.com/daily/2026-07-26"
      }]
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
      scope: { visibility: "circle-public" },
      reportKind: "daily",
      reportDate: "2026-07-26"
    });

    expect(result.sent).toBe(true);
    const sends = messageCalls(calls);
    expect(sends).toHaveLength(1);
    const card = cardFrom(sends[0]!);
    expect(card.body.elements.some((element) => element.tag === "button")).toBe(false);
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
      markdown: REPORT_MARKDOWN,
      scope: { visibility: "circle-public" }
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
      markdown: REPORT_MARKDOWN,
      scope: { visibility: "circle-public" }
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

  // 2026-07-28 (R2). The declared marker, on the channel production actually
  // uses. `scope` decides routing outright - it is not a hint the group
  // configuration can override.
  it("routes a scope-declared owner-private report to that owner's DM even with a group chat configured", async () => {
    process.env.FEISHU_GROUP_CHAT_ID = "oc_public_group";
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_global_member";
    const calls = stubFetch(okFeishu());

    const result = await deliverReportToFeishu({
      title: "OpenClaw 模拟盘收支变化 2026-07-28",
      markdown: REPORT_MARKDOWN,
      scope: { visibility: "owner-private", ownerOpenId: "ou_paper_owner" },
      audience: "dm",
      reportKind: "official-paper",
      reportDate: "2026-07-28"
    });

    expect(result.sent).toBe(true);
    expect(result.target).toBe("feishu-app-open-id");
    const sends = messageCalls(calls);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.url).toContain("receive_id_type=open_id");
    expect(sends[0]!.body.receive_id).toBe("ou_paper_owner");
  });

  // "We know this belongs to one person and we do not know who" must never
  // degrade into "send it to the default target". Refused on the app-credential
  // channel too, which is the one that HAS a DM to offer - the refusal is about
  // the content, not about the channel's capabilities.
  it("refuses an owner-unresolved report on every channel and repeats the producer's reason", async () => {
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_global_member";
    process.env.FEISHU_GROUP_CHAT_ID = "oc_public_group";
    const calls = stubFetch(okFeishu());

    const result = await deliverReportToFeishu({
      title: "OpenClaw 模拟盘收支变化 2026-07-28",
      markdown: REPORT_MARKDOWN,
      scope: {
        visibility: "owner-unresolved",
        reason: "本次快照的归属是 __shared__（当前不是恰好 1 位活跃成员）"
      },
      audience: "dm"
    });

    expect(result.sent).toBe(false);
    expect(result.target).toBe("none");
    expect(result.reason).toContain("__shared__");
    expect(result.deliveries).toEqual([]);
    // Not a single HTTP call: nothing was attempted, so nothing can be
    // half-delivered or logged as delivered.
    expect(calls).toHaveLength(0);
  });

  // 2026-07-28 (R3). Until now "undeclared" meant two different things
  // depending on which channel picked it up: the shared-chat channels refused
  // it, while THIS one - the only one production uses - fell through to
  // tryResolveGlobalFeishuTarget() and DM'd it to the operator. That gap is
  // where 个股分析 lived: a 公共资产 delivered to one person's DM with
  // FEISHU_GROUP_CHAT_ID sitting configured and unused, reported as sent.
  // A producer that declares nothing now gets one answer everywhere.
  it("refuses an undeclared payload before choosing a channel, even with every target configured", async () => {
    process.env.FEISHU_GROUP_CHAT_ID = "oc_public_group";
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_global_member";
    process.env.FEISHU_NOTIFY_CHAT_ID = "oc_ops_chat";
    const calls = stubFetch(okFeishu());

    const result = await deliverReportToFeishu({
      title: "OpenClaw 个股分析 2026-07-28",
      markdown: REPORT_MARKDOWN,
      reportKind: "stock-analysis",
      reportDate: "2026-07-28"
    });

    expect(result.sent).toBe(false);
    expect(result.target).toBe("none");
    expect(result.deliveries).toEqual([]);
    // Not even a tenant-token fetch: the refusal is upstream of every channel,
    // so there is nothing to half-deliver and nothing to record as delivered.
    expect(calls).toHaveLength(0);
    // The reason names the payload and the three declarations that fix it, so
    // an operator reading the run log knows which producer to change.
    expect(result.reason).toContain("OpenClaw 个股分析 2026-07-28");
    expect(result.reason).toContain("circle-public");
    expect(result.reason).toContain("owner-private");
    expect(result.reason).toContain("owner-unresolved");
  });

  it("refuses a payload whose scope and openId name different owners instead of picking one", async () => {
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_global_member";
    const calls = stubFetch(okFeishu());

    const result = await deliverReportToFeishu({
      title: "我的个人页 · 日报 2026-07-28",
      markdown: REPORT_MARKDOWN,
      scope: { visibility: "owner-private", ownerOpenId: "ou_alice" },
      openId: "ou_bob"
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toContain("ou_alice");
    expect(result.reason).toContain("ou_bob");
    expect(calls).toHaveLength(0);
  });

  it("refuses a payload that declares itself public while addressing one member", async () => {
    process.env.FEISHU_GROUP_CHAT_ID = "oc_public_group";
    const calls = stubFetch(okFeishu());

    const result = await deliverReportToFeishu({
      title: "OpenClaw 日报 2026-07-28",
      markdown: REPORT_MARKDOWN,
      scope: { visibility: "circle-public" },
      openId: "ou_bob"
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toContain("ou_bob");
    expect(calls).toHaveLength(0);
  });

  it("refuses an owner-private declaration that names a blank owner", async () => {
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_global_member";
    const calls = stubFetch(okFeishu());

    const result = await deliverReportToFeishu({
      title: "我的个人页 · 日报 2026-07-28",
      markdown: REPORT_MARKDOWN,
      scope: { visibility: "owner-private", ownerOpenId: "   " }
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/owner-unresolved/);
    expect(calls).toHaveLength(0);
  });

  // 2026-07-28 R5 (E2). The owner field was never shape-checked: any string
  // went out as a receive_id with receive_id_type=open_id. Measured before the
  // fix, against the built dist with app credentials set - both of these came
  // back `sent: true` after a real im/v1/messages POST carrying
  // `receive_id=oc_public_group`. The value is a CHAT id, so what got recorded
  // as a delivered private report was a card addressed to a group as if the
  // group were a person. Whether Feishu then rejects it was never measured
  // (see refuseMalformedOwnerOpenId's note); these two cases exist so the
  // answer no longer matters - nothing is sent at all.
  it("refuses an owner-private declaration whose ownerOpenId is a chat id, not an open_id", async () => {
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_global_member";
    const calls = stubFetch(okFeishu());

    const result = await deliverReportToFeishu({
      title: "我的个人页 · 日报 2026-07-28",
      markdown: REPORT_MARKDOWN,
      scope: { visibility: "owner-private", ownerOpenId: "oc_public_group" }
    });

    expect(result.sent).toBe(false);
    expect(result.target).toBe("none");
    expect(result.reason).toContain("oc_public_group");
    expect(result.reason).toContain("scope.ownerOpenId");
    expect(messageCalls(calls)).toHaveLength(0);
  });

  it("refuses the legacy payload.openId routing field when it is not an open_id either", async () => {
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_global_member";
    const calls = stubFetch(okFeishu());

    const result = await deliverReportToFeishu({
      title: "我的个人页 · 日报 2026-07-28",
      markdown: REPORT_MARKDOWN,
      openId: "oc_public_group"
    });

    expect(result.sent).toBe(false);
    expect(result.target).toBe("none");
    expect(result.reason).toContain("payload.openId");
    expect(messageCalls(calls)).toHaveLength(0);
  });

  it("still delivers to a well-formed ou_ owner id", async () => {
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_global_member";
    const calls = stubFetch(okFeishu());

    const result = await deliverReportToFeishu({
      title: "我的个人页 · 日报 2026-07-28",
      markdown: REPORT_MARKDOWN,
      scope: { visibility: "owner-private", ownerOpenId: "ou_real_member" }
    });

    expect(result.sent).toBe(true);
    expect(messageCalls(calls).map((send) => send.body.receive_id)).toEqual(["ou_real_member"]);
  });

  // 2026-07-28 (R4, C12 CRITICAL). The privacy guard's default used to be
  // fail-OPEN: `visibility` was matched against two members and everything else
  // fell out of the bottom as circle-public - the MOST permissive verdict - and
  // was published to FEISHU_GROUP_CHAT_ID with `sent: true`. One underscore for
  // one hyphen was enough, and the producers that write these strings by hand
  // (official-paper-monitor.mjs) are .mjs that `tsc` never checks.
  //
  // The body here is the 模拟盘收支变化 shape from the R2 leak capture, holding
  // line included, so a regression re-publishes exactly the content that leak
  // was about.
  const PAPER_PNL_MARKDOWN = [
    "# OpenClaw 模拟盘收支变化 2026-07-28",
    "",
    "窗口：2026-07-27 20:00 - 2026-07-28 20:00（北京时间）",
    "",
    "## 1. 今日结论",
    "",
    "- 持仓：QQQ.US：数量 1，成本 663.88 USD。"
  ].join("\n");

  it("refuses an unrecognized scope.visibility instead of publishing it to the group", async () => {
    process.env.FEISHU_GROUP_CHAT_ID = "oc_public_group";
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_global_member";
    const calls = stubFetch(okFeishu());
    const errors: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    let result;
    try {
      result = await deliverReportToFeishu({
        title: "OpenClaw 模拟盘收支变化 2026-07-28",
        markdown: PAPER_PNL_MARKDOWN,
        // One underscore instead of one hyphen - the typo a .mjs producer can
        // make today with nothing to stop it.
        scope: { visibility: "owner_private", ownerOpenId: "ou_paper_owner" } as unknown as ReportScope,
        audience: "dm",
        reportKind: "official-paper",
        reportDate: "2026-07-28"
      });
    } finally {
      console.error = realError;
    }

    expect(result.sent).toBe(false);
    expect(result.target).toBe("none");
    expect(result.deliveries).toEqual([]);
    // Nothing was attempted at all - not even a tenant token - so the holdings
    // line cannot have reached the group chat or anywhere else.
    expect(calls).toHaveLength(0);
    // Loud, not silent: an operator sees it even if the producer drops the
    // result, which is the difference between this and a legitimate
    // undeliverable. It names the rejected value and every accepted form.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("owner_private");
    expect(errors[0]).toContain("circle-public");
    expect(errors[0]).toContain("owner-unresolved");
    expect(result.reason).toContain("owner_private");
    expect(result.reason).toContain("ownerOpenId");
    // The refusal never echoes the body it refused.
    expect(result.reason).not.toContain("663.88");
    expect(errors[0]).not.toContain("663.88");
  });

  it("refuses a scope object that carries no visibility at all rather than defaulting it", async () => {
    process.env.FEISHU_GROUP_CHAT_ID = "oc_public_group";
    const calls = stubFetch(okFeishu());
    const realError = console.error;
    console.error = () => {};

    let result;
    try {
      result = await deliverReportToFeishu({
        title: "OpenClaw 模拟盘收支变化 2026-07-28",
        markdown: PAPER_PNL_MARKDOWN,
        scope: {} as unknown as ReportScope
      });
    } finally {
      console.error = realError;
    }

    expect(result.sent).toBe(false);
    expect(calls).toHaveLength(0);
    expect(result.reason).toContain("visibility");
  });

  it("stays at one message for a long report - no chapter fan-out to fall back to", async () => {
    process.env.FEISHU_NOTIFY_CHAT_ID = "oc_group_chat";
    const calls = stubFetch(okFeishu());
    const longSection = ["## 1. 今日结论", "", "段落一".repeat(400), "", "段落二".repeat(400)].join("\n");

    const result = await deliverReportToFeishu({
      title: "OpenClaw 日报 2026-07-26",
      markdown: `# OpenClaw 日报 2026-07-26\n\n${longSection}`,
      scope: { visibility: "circle-public" },
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
  //
  // Two failures now, in the order an alert would hit them. An alert payload
  // carries no visibility declaration (alerts are addressed to the operator,
  // not to a member), so since 2026-07-28 R3 the report path refuses it before
  // any channel is chosen - the first assertion. Force a declaration on and the
  // ORIGINAL damage is still there: the body is summarized into a card and
  // every load-bearing line disappears.
  it("is the reason an alert must NOT go through the report path (which drops the body)", async () => {
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_operator";
    const calls = stubFetch(okFeishu);

    const undeclared = await deliverReportToFeishu({
      title: "OpenClaw 自动报告失败告警：daily",
      markdown: ALERT_MARKDOWN
    });

    expect(undeclared.sent).toBe(false);
    expect(undeclared.reason).toContain("没有声明可见范围");
    expect(outboundMessages(calls)).toHaveLength(0);

    await deliverReportToFeishu({
      title: "OpenClaw 自动报告失败告警：daily",
      markdown: ALERT_MARKDOWN,
      scope: { visibility: "circle-public" }
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

// 2026-07-28 R5 (E1). `{operator: true}` means "send this to whoever operates
// the deployment" - the form market-alerts-poll.mjs uses for its "the alert
// poller is dead" escalation when no member has a linked Feishu account. That
// form used to be spelled `{}`, and only legacyMcpCardTransport honored it;
// THIS transport - the one defaultCardTransport picks whenever app credentials
// resolve, which is the deploy target's shape - refused it. Measured against
// the built dist with FEISHU_APP_ID/FEISHU_APP_SECRET set, before the fix (the
// literal call and the literal return, `{}` and all):
//   sendInteractiveCard(card, {}) -> {"ok":false,"error":"Interactive card
//   target needs a chatId or openId."}, and zero HTTP requests attempted.
// So the one message that reports the alerter itself as broken was the one
// message that could not be sent.
//
// These cases drive the REAL transport, not an injected fake: a fake answering
// ok:true for the operator form is precisely the fixture that let this survive
// four rounds (see market-alerts-poll.test.ts's operator-card cases, which are
// deliberately about the poller's decisions and now say so).
describe("directHttpCardTransport operator target (2026-07-28 R5)", () => {
  const realFetch = globalThis.fetch;
  const envKeys = [
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_NOTIFY_OPEN_ID",
    "FEISHU_NOTIFY_CHAT_ID",
    "FEISHU_NOTIFICATION_RETRY_ATTEMPTS",
    "HOME"
  ] as const;
  const savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};
  const savedCwd = process.cwd();
  let tempDir: string;

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      if (key !== "HOME") {
        delete process.env[key];
      }
    }
    // Isolate BOTH remaining sources resolveFeishuAppTarget can reach with no
    // FEISHU_NOTIFY_* set - the repo's sqlite notification_targets row (from
    // cwd) and ~/.openclaw/credentials (from $HOME) - so nothing under the real
    // runtime/ directory is opened, read or written by these tests.
    tempDir = mkdtempSync(join(tmpdir(), "notifications-operator-target-"));
    process.env.HOME = tempDir;
    process.chdir(tempDir);
    process.env.FEISHU_APP_ID = "cli_test_app";
    process.env.FEISHU_APP_SECRET = "test_secret";
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
    rmSync(tempDir, { recursive: true, force: true });
  });

  function stubFetch() {
    const calls: Array<{ url: string; body: { receive_id: string; msg_type: string } }> = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("tenant_access_token")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-op", expire: 7200 }));
      }
      calls.push({ url: href, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ code: 0, data: { message_id: "om_op_1" } }));
    }) as typeof fetch;
    return calls;
  }

  const card: InteractiveCard = { title: "⚠ 提醒器连续失败", lines: ["已连续失败 3 次。"] };

  it("delivers to the stored notification target - the deploy target's own shape - when the caller gives no chatId/openId", async () => {
    // The mini has FEISHU_APP_ID/FEISHU_APP_SECRET and NO FEISHU_NOTIFY_* at
    // all, plus exactly one notification_targets row: channel feishu, type
    // open_id, source openclaw-allowFrom (read-only check on the deploy
    // target; only the channel/type/source and the id's `ou_` prefix were
    // read, never an id value). That row is what this reconstructs.
    const db = openTradingDatabase(resolveRuntimePaths(tempDir).dbPath);
    try {
      new NotificationTargetRepository(db).save({
        channel: "feishu",
        targetType: "open_id",
        targetId: "ou_operator_stub",
        source: "openclaw-allowFrom",
        updatedAt: Date.now()
      });
    } finally {
      db.close();
    }
    const calls = stubFetch();

    // notifications.ts memoizes its NotificationTargetRepository against the
    // FIRST db it ever resolves, and earlier cases in this file already bound
    // that singleton to their own (since deleted) temp dirs. A fresh module
    // instance is the only way to exercise the stored-target lookup for real;
    // stubbing it would be a fixture asserting itself.
    vi.resetModules();
    const fresh = await import("./notifications.js");

    const result = await fresh.sendInteractiveCard(card, { operator: true });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("receive_id_type=open_id");
    expect(calls[0]!.body.receive_id).toBe("ou_operator_stub");
    expect(calls[0]!.body.msg_type).toBe("interactive");
  });

  it("delivers to FEISHU_NOTIFY_CHAT_ID when that is how the operator target is configured", async () => {
    process.env.FEISHU_NOTIFY_CHAT_ID = "oc_ops_chat";
    const calls = stubFetch();

    const result = await sendInteractiveCard(card, { operator: true });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("receive_id_type=chat_id");
    expect(calls[0]!.body.receive_id).toBe("oc_ops_chat");
  });

  it("refuses by name - and flags itself as a CONFIG gap, not a rejected send - when no operator target is configured at all", async () => {
    const calls = stubFetch();

    const result = await sendInteractiveCard(card, { operator: true });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("FEISHU_NOTIFY_OPEN_ID");
    expect(isUnconfiguredCardTargetError(result.error)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("does not mistake a REJECTED send for an unconfigured deployment", async () => {
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_operator";
    globalThis.fetch = (async (url: string | URL) =>
      String(url).includes("tenant_access_token")
        ? new Response(JSON.stringify({ code: 0, tenant_access_token: "t-op", expire: 7200 }))
        : new Response(JSON.stringify({ code: 230001, msg: "invalid receive_id" }), { status: 400 })) as typeof fetch;

    const result = await sendInteractiveCard(card, { operator: true });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("invalid receive_id");
    expect(isUnconfiguredCardTargetError(result.error)).toBe(false);
  });

  it("still prefers an explicitly addressed member over the operator target", async () => {
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_operator";
    const calls = stubFetch();

    await sendInteractiveCard(card, { openId: "ou_member_1" });

    expect(calls[0]!.body.receive_id).toBe("ou_member_1");
  });

  // The reason `operator` is an explicit flag and not "whatever an empty object
  // means". Every other caller in this repo addresses ONE member - login codes,
  // review confirmations, research results, alert cards - via
  // `{openId: member.feishuOpenId}`. If that id is ever undefined, redirecting
  // to the operator would put one member's card in someone else's chat and
  // report it sent. It must stay a refusal.
  //
  // The `{openId: undefined}` row is cast because exactOptionalPropertyTypes
  // rejects it at the type level - which protects the .ts call sites and only
  // those. The producers that can actually emit it are the ~76 unchecked .mjs
  // scripts under apps/openclaw-config/scripts that call this same dist export,
  // so the guard has to exist at runtime, and this row is what covers it.
  it.each([
    ["an empty object", {}],
    ["a member whose openId came back undefined", { openId: undefined } as unknown as CardTarget],
    ["a member whose openId came back blank", { openId: "  " }]
  ])("refuses %s rather than redirecting the card to the operator", async (_label, target) => {
    process.env.FEISHU_NOTIFY_OPEN_ID = "ou_operator";
    const calls = stubFetch();

    const result = await sendInteractiveCard(card, target);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("needs a chatId or openId");
    expect(isUnconfiguredCardTargetError(result.error)).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
