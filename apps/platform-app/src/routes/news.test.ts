import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApiTokenRepository, createId, MemberRepository, migrate, type Member } from "@packages/shared-types";

import { createPlatformServer } from "../server.js";

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function insertEvent(
  db: DatabaseSync,
  opts: {
    clusterKey: string;
    titleZh: string;
    summaryZh?: string;
    impactDirection?: string;
    impactAffected?: string[];
    impactReason?: string;
    lastPublishedAt: string | null;
  }
): string {
  const id = createId("news_event");
  const now = "2026-07-14T00:00:00.000Z";
  db.prepare(`
    INSERT INTO news_events
      (id, cluster_key, title_zh, summary_zh, impact_direction, impact_affected, impact_reason,
       first_published_at, last_published_at, source_count, zh_source_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
  `).run(
    id,
    opts.clusterKey,
    opts.titleZh,
    opts.summaryZh ?? null,
    opts.impactDirection ?? "neutral",
    JSON.stringify(opts.impactAffected ?? []),
    opts.impactReason ?? null,
    opts.lastPublishedAt,
    opts.lastPublishedAt,
    now,
    now
  );
  return id;
}

function insertSource(
  db: DatabaseSync,
  opts: { eventId: string; origin: string; publisher: string; url?: string | null; titleRaw: string; publishedAt?: string | null; lang?: string }
): void {
  db.prepare(`
    INSERT INTO news_event_sources
      (id, event_id, origin, publisher, url, title_raw, published_at, lang, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    createId("news_source"),
    opts.eventId,
    opts.origin,
    opts.publisher,
    opts.url ?? null,
    opts.titleRaw,
    opts.publishedAt ?? null,
    opts.lang ?? "zh",
    "2026-07-14T00:00:00.000Z"
  );
}

describe("news route (GET /news)", () => {
  let db: DatabaseSync;
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;
  let token: string;
  const now = () => new Date("2026-07-14T12:00:00Z");

  beforeEach(async () => {
    db = memoryDb();
    const member: Member = {
      id: "member_1",
      email: "member1@example.com",
      displayName: "Member One",
      riskTags: [],
      stockTags: [],
      showPerformance: true,
      status: "active",
      createdAt: "2026-07-01T00:00:00.000Z"
    };
    new MemberRepository(db).upsert(member);
    token = new ApiTokenRepository(db).issue(member.id, "test").token;

    server = createPlatformServer({ db, repoRoot: process.cwd(), now });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns 401 without any identity", async () => {
    const response = await fetch(`${baseUrl}/news`);
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain("未获授权");
  });

  it("returns 200 with the honest empty state when no events cluster within the 7-day window", async () => {
    const response = await fetch(`${baseUrl}/news`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();

    expect(body).toContain("近 7 天暂无聚类事件——新闻引擎随日报生成积累");
    // Filter chips row present (全部/宏观, real links now - not disabled).
    expect(body).toContain("全部");
    expect(body).toContain("宏观");
    expect(body).not.toContain('aria-disabled="true"');
    // Layout chrome (renderPage) present, nav item highlighted.
    expect(body).toContain('class="tab on"');
    // No degradation banner - this page never sets `degraded`.
    expect(body).not.toContain("数据降级提示");
  });

  it("renders one card per clustered event with title, impact badge, affected chips, summary and sources", async () => {
    const eventId = insertEvent(db, {
      clusterKey: "fed-rate-hold",
      titleZh: "美联储维持利率不变",
      summaryZh: "美联储维持利率不变\n市场解读为中性偏鸽。",
      impactDirection: "bullish",
      impactAffected: ["QQQ.US"],
      impactReason: "关注贸易政策变化对科技股估值的影响",
      lastPublishedAt: "2026-07-14T10:00:00.000Z"
    });
    insertSource(db, {
      eventId,
      origin: "rsshub-cls",
      publisher: "财联社",
      url: "https://cls.cn/telegraph/1",
      titleRaw: "美联储维持利率不变",
      publishedAt: "2026-07-14T10:00:00.000Z",
      lang: "zh"
    });
    insertSource(db, {
      eventId,
      origin: "yahoo-finance-rss",
      publisher: "Barchart",
      url: null,
      titleRaw: "Fed holds rates steady",
      publishedAt: null,
      lang: "en"
    });

    const response = await fetch(`${baseUrl}/news`, { headers: { authorization: `Bearer ${token}` } });
    const body = await response.text();

    expect(body).toContain("美联储维持利率不变");
    expect(body).toContain("利好");
    expect(body).toContain("QQQ.US");
    expect(body).toContain("关注贸易政策变化对科技股估值的影响");
    expect(body).toContain("市场解读为中性偏鸽");
    expect(body).toContain("财联社");
    expect(body).toContain('href="https://cls.cn/telegraph/1"');
    expect(body).toContain('rel="noreferrer"');
    expect(body).toContain('target="_blank"');
    expect(body).toContain("2 小时前");
    // Unknown-time source shows the honest label, not a fabricated time.
    expect(body).toContain("时间未知");
    expect(body).toContain("Barchart");
    expect(body).not.toContain("近 7 天暂无聚类事件");
  });

  it("renders a javascript: source URL as plain text, never as a clickable href (2026-07 audit: defense-in-depth against a non-http(s) URL from an external RSS/LLM source)", async () => {
    const eventId = insertEvent(db, {
      clusterKey: "malicious-source",
      titleZh: "可疑来源事件",
      lastPublishedAt: "2026-07-14T10:00:00.000Z"
    });
    insertSource(db, {
      eventId,
      origin: "rsshub-cls",
      publisher: "可疑来源",
      url: "javascript:alert(1)",
      titleRaw: "可疑来源事件",
      publishedAt: "2026-07-14T10:00:00.000Z",
      lang: "zh"
    });

    const response = await fetch(`${baseUrl}/news`, { headers: { authorization: `Bearer ${token}` } });
    const body = await response.text();

    expect(body).not.toContain("javascript:alert(1)");
    expect(body).toContain("原文链接未提供");
    expect(body).not.toMatch(/<a[^>]*href="javascript:/u);
  });

  it("filters by ?symbol= and marks that chip active", async () => {
    db.prepare(`INSERT INTO stock_analysis_targets (symbol, owner_id, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
      .run("AAPL.US", "member_1", "2026-07-14T00:00:00.000Z", "2026-07-14T00:00:00.000Z");
    const aaplEvent = insertEvent(db, {
      clusterKey: "aapl-event",
      titleZh: "苹果公司业绩更新",
      impactAffected: ["AAPL.US"],
      lastPublishedAt: "2026-07-14T09:00:00.000Z"
    });
    insertSource(db, { eventId: aaplEvent, origin: "finnhub", publisher: "Finnhub", url: "https://example.com/aapl", titleRaw: "Apple earnings", publishedAt: "2026-07-14T09:00:00.000Z", lang: "en" });
    const nvdaEvent = insertEvent(db, {
      clusterKey: "nvda-event",
      titleZh: "英伟达芯片需求更新",
      impactAffected: ["NVDA.US"],
      lastPublishedAt: "2026-07-14T09:30:00.000Z"
    });
    insertSource(db, { eventId: nvdaEvent, origin: "finnhub", publisher: "Finnhub", url: "https://example.com/nvda", titleRaw: "Nvidia chip demand", publishedAt: "2026-07-14T09:30:00.000Z", lang: "en" });

    const response = await fetch(`${baseUrl}/news?symbol=AAPL.US`, { headers: { authorization: `Bearer ${token}` } });
    const body = await response.text();

    expect(body).toContain("苹果公司业绩更新");
    expect(body).not.toContain("英伟达芯片需求更新");
    // The AAPL.US filter chip carries the active styling.
    const chipMatch = body.match(/<a href="\/news\?symbol=AAPL\.US"[^>]*>AAPL\.US<\/a>/u);
    expect(chipMatch).not.toBeNull();
    expect(chipMatch?.[0]).toContain("var(--accent)");
  });

  it("filters by ?topic=宏观 to events with no specific affected symbol", async () => {
    const macroEvent = insertEvent(db, {
      clusterKey: "macro-event",
      titleZh: "美联储议息会议纪要",
      impactAffected: [],
      lastPublishedAt: "2026-07-14T08:00:00.000Z"
    });
    insertSource(db, { eventId: macroEvent, origin: "rsshub-cls", publisher: "财联社", url: "https://cls.cn/telegraph/2", titleRaw: "FOMC minutes", publishedAt: "2026-07-14T08:00:00.000Z", lang: "zh" });
    const stockEvent = insertEvent(db, {
      clusterKey: "stock-event",
      titleZh: "微软云业务增长更新",
      impactAffected: ["MSFT.US"],
      lastPublishedAt: "2026-07-14T08:30:00.000Z"
    });
    insertSource(db, { eventId: stockEvent, origin: "finnhub", publisher: "Finnhub", url: "https://example.com/msft", titleRaw: "Microsoft cloud growth", publishedAt: "2026-07-14T08:30:00.000Z", lang: "en" });

    const response = await fetch(`${baseUrl}/news?topic=宏观`, { headers: { authorization: `Bearer ${token}` } });
    const body = await response.text();

    expect(body).toContain("美联储议息会议纪要");
    expect(body).not.toContain("微软云业务增长更新");
  });

  it("carries the response's CSP nonce onto the page's one inline script", async () => {
    const response = await fetch(`${baseUrl}/news`, { headers: { authorization: `Bearer ${token}` } });
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonceMatch = /nonce-([^']+)/u.exec(csp);
    expect(nonceMatch).not.toBeNull();
    const body = await response.text();
    expect(body).toContain(`nonce="${nonceMatch?.[1]}"`);
  });

  it("returns 405 for non-GET requests", async () => {
    const response = await fetch(`${baseUrl}/news`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(response.status).toBe(405);
  });
});
