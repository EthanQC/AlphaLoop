// Task 7 (2026-07-28 spec-drift remediation plan): who receives what when a
// daily/weekly report ships.
//
// Requirements §4: 「单聊（个人通道）：提醒卡、提案审批卡、个人页摘要、月度复盘、
// 研判完成通知」/「群（公共通道）：公共报告发布卡、系统告警…」. Before this task
// every one of those went to the SAME single DM: the report card had one target
// notion (the global Feishu target), and the per-owner personal pages Task 5
// started generating were written to `personal_pages` and never delivered to
// anybody at all.
//
// The group half is asserted in packages/shared-types/src/notifications.test.ts
// (target resolution + the honest DM fallback). This file covers the DM half:
// each active member gets their OWN page as one card, addressed to their own
// open_id, carrying a /daily/<date>/me deep link - and a member the delivery
// cannot reach is disclosed with a reason rather than silently dropped.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MemberRepository,
  buildReportConclusionCard,
  openTradingDatabase
} from "../../../packages/shared-types/dist/index.js";

const personalPage = await import("./personal-page.mjs");
const scheduledReport = await import("./scheduled-report.mjs");

const helpers = {
  renderOfficialPaperSnapshot: scheduledReport.renderOfficialPaperSnapshot,
  summarizeOfficialAccount: scheduledReport.summarizeOfficialAccount,
  summarizeOfficialPositions: scheduledReport.summarizeOfficialPositions
};

const DATE = "2026-07-28";
const tempDirs: string[] = [];
let savedBaseUrl: string | undefined;

beforeEach(() => {
  savedBaseUrl = process.env.PLATFORM_PUBLIC_BASE_URL;
  process.env.PLATFORM_PUBLIC_BASE_URL = "https://reports.qingverse.com";
});

afterEach(() => {
  if (savedBaseUrl === undefined) {
    delete process.env.PLATFORM_PUBLIC_BASE_URL;
  } else {
    process.env.PLATFORM_PUBLIC_BASE_URL = savedBaseUrl;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-report-delivery-"));
  tempDirs.push(dir);
  return openTradingDatabase(join(dir, "trading.sqlite"));
}

function seedMember(
  db: DatabaseSync,
  input: { id: string; displayName: string; feishuOpenId?: string; status?: "active" | "revoked" }
): void {
  new MemberRepository(db).upsert({
    id: input.id,
    email: `${input.id}@example.com`,
    ...(input.feishuOpenId ? { feishuOpenId: input.feishuOpenId } : {}),
    displayName: input.displayName,
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: input.status ?? "active",
    createdAt: "2026-07-01T00:00:00.000Z"
  });
}

function seedThesis(db: DatabaseSync, input: { ownerId: string; symbol: string }): void {
  db.prepare(`
    INSERT INTO theses
      (id, owner_id, symbol, direction, target_low, target_high, invalidation_price, visibility, status, created_at, updated_at)
    VALUES (?, ?, ?, 'bull', NULL, 800, 500, 'system', 'active', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z')
  `).run(`thesis_${input.ownerId}`, input.ownerId, input.symbol);
  db.prepare(`
    INSERT INTO stock_facts (id, trading_day, symbol, fact_key, value_num, value_text, unit, source, data_time, created_at)
    VALUES (?, ?, ?, 'quote.last', 600, NULL, 'USD', 'longbridge', ?, ?)
  `).run(
    `fact_${input.symbol}`,
    DATE,
    input.symbol,
    `${DATE}T20:00:00.000Z`,
    `${DATE}T20:00:00.000Z`
  );
}

interface CapturedPayload {
  title: string;
  markdown: string;
  openId?: string;
  reportKind?: string;
  reportDate?: string;
  conclusion?: { headline: string; bullets: string[] };
}

function capturingDeliver(overrides: Record<string, { sent: boolean; reason?: string }> = {}) {
  const payloads: CapturedPayload[] = [];
  const deliver = async (payload: CapturedPayload) => {
    payloads.push(payload);
    const override = payload.openId ? overrides[payload.openId] : undefined;
    if (override && !override.sent) {
      return { sent: false, target: "none", reason: override.reason ?? "rejected", deliveries: [] };
    }
    return {
      sent: true,
      target: "feishu-app-open-id",
      deliveries: [{ kind: "summary", title: payload.title, target: "feishu-app-open-id", sent: true, detail: `om_${payload.openId}` }]
    };
  };
  return { payloads, deliver };
}

// Two members with disjoint data, so "each member got their own page" is
// provable from the card contents rather than from the call count alone.
function seedTwoOwners(db: DatabaseSync): void {
  seedMember(db, { id: "member_a", displayName: "阿尔法", feishuOpenId: "ou_alpha" });
  seedMember(db, { id: "member_b", displayName: "贝塔", feishuOpenId: "ou_beta" });
  seedThesis(db, { ownerId: "member_a", symbol: "NVDA.US" });
  seedThesis(db, { ownerId: "member_b", symbol: "TSLA.US" });
  personalPage.generatePersonalPages({ db, kind: "daily", date: DATE, now: "2026-07-28T12:00:00.000Z", helpers });
}

describe("deliverPersonalPageCards", () => {
  it("sends every active member their OWN personal page as one DM card", async () => {
    const db = makeDb();
    seedTwoOwners(db);
    const { payloads, deliver } = capturingDeliver();

    const result = await scheduledReport.deliverPersonalPageCards({
      db,
      reportKind: "daily",
      date: DATE,
      deliver
    });

    expect(result.delivered.map((entry: { ownerId: string }) => entry.ownerId).sort()).toEqual(["member_a", "member_b"]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);

    expect(payloads).toHaveLength(2);
    expect(payloads.map((payload) => payload.openId).sort()).toEqual(["ou_alpha", "ou_beta"]);

    const alpha = payloads.find((payload) => payload.openId === "ou_alpha");
    const beta = payloads.find((payload) => payload.openId === "ou_beta");
    expect(alpha?.markdown).not.toBe(beta?.markdown);
    // Owner isolation survives the delivery hop: neither card carries the
    // other member's name, id or thesis symbol.
    expect(alpha?.markdown).toContain("NVDA.US");
    expect(JSON.stringify(alpha)).not.toContain("TSLA.US");
    expect(JSON.stringify(alpha)).not.toContain("贝塔");
    expect(JSON.stringify(beta)).not.toContain("阿尔法");
  });

  it("gives each card a /daily/<date>/me deep link back to the owner-only page", async () => {
    const db = makeDb();
    seedTwoOwners(db);
    const { payloads, deliver } = capturingDeliver();

    await scheduledReport.deliverPersonalPageCards({ db, reportKind: "daily", date: DATE, deliver });

    for (const payload of payloads) {
      expect(payload.reportKind).toBe("personal-daily");
      expect(payload.reportDate).toBe(DATE);
      // The card the delivery layer will build out of this payload is what the
      // member actually sees - assert the real button, not just the inputs.
      const card = buildReportConclusionCard(payload as never);
      expect(card.url).toEqual({
        text: "查看完整报告",
        href: "https://reports.qingverse.com/daily/2026-07-28/me"
      });
      expect(card.lines.length).toBeGreaterThan(0);
    }
  });

  it("uses the weekly personal deep link for a weekly report", async () => {
    const db = makeDb();
    seedMember(db, { id: "member_a", displayName: "阿尔法", feishuOpenId: "ou_alpha" });
    personalPage.generatePersonalPages({ db, kind: "weekly", date: DATE, now: "2026-07-28T12:00:00.000Z", helpers });
    const { payloads, deliver } = capturingDeliver();

    await scheduledReport.deliverPersonalPageCards({ db, reportKind: "weekly", date: DATE, deliver });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.reportKind).toBe("personal-weekly");
    expect(buildReportConclusionCard(payloads[0]! as never).url?.href)
      .toBe("https://reports.qingverse.com/weekly/2026-07-28/me");
  });

  it("discloses a member with no bound Feishu account instead of silently skipping them", async () => {
    const db = makeDb();
    seedMember(db, { id: "member_a", displayName: "阿尔法", feishuOpenId: "ou_alpha" });
    seedMember(db, { id: "member_c", displayName: "伽马" });
    personalPage.generatePersonalPages({ db, kind: "daily", date: DATE, now: "2026-07-28T12:00:00.000Z", helpers });
    const { payloads, deliver } = capturingDeliver();

    const result = await scheduledReport.deliverPersonalPageCards({ db, reportKind: "daily", date: DATE, deliver });

    expect(payloads.map((payload) => payload.openId)).toEqual(["ou_alpha"]);
    expect(result.delivered.map((entry: { ownerId: string }) => entry.ownerId)).toEqual(["member_a"]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.ownerId).toBe("member_c");
    expect(result.skipped[0]!.reason).toContain("飞书");
  });

  it("records a per-member failure without costing the other members their card", async () => {
    const db = makeDb();
    seedTwoOwners(db);
    const { payloads, deliver } = capturingDeliver({ ou_alpha: { sent: false, reason: "invalid receive_id" } });

    const result = await scheduledReport.deliverPersonalPageCards({ db, reportKind: "daily", date: DATE, deliver });

    expect(payloads).toHaveLength(2);
    expect(result.delivered.map((entry: { ownerId: string }) => entry.ownerId)).toEqual(["member_b"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.ownerId).toBe("member_a");
    expect(result.failed[0]!.reason).toContain("invalid receive_id");
  });

  it("reports a member whose personal page was never generated rather than inventing one", async () => {
    const db = makeDb();
    seedMember(db, { id: "member_a", displayName: "阿尔法", feishuOpenId: "ou_alpha" });
    const { payloads, deliver } = capturingDeliver();

    const result = await scheduledReport.deliverPersonalPageCards({ db, reportKind: "daily", date: DATE, deliver });

    expect(payloads).toEqual([]);
    expect(result.delivered).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.ownerId).toBe("member_a");
    expect(result.failed[0]!.reason).toContain("个人页");
  });

  it("does not deliver anything to a revoked member", async () => {
    const db = makeDb();
    seedMember(db, { id: "member_a", displayName: "阿尔法", feishuOpenId: "ou_alpha" });
    seedMember(db, { id: "member_z", displayName: "已撤销", feishuOpenId: "ou_zeta", status: "revoked" });
    personalPage.savePersonalPage({
      db,
      ownerId: "member_z",
      kind: "daily",
      date: DATE,
      markdown: "# 我的个人页 · 日报 2026-07-28\n\n## 1. 我的持仓速览\n\n- 速览：旧成员\n"
    });
    personalPage.generatePersonalPages({ db, kind: "daily", date: DATE, now: "2026-07-28T12:00:00.000Z", helpers });
    const { payloads, deliver } = capturingDeliver();

    const result = await scheduledReport.deliverPersonalPageCards({ db, reportKind: "daily", date: DATE, deliver });

    expect(payloads.map((payload) => payload.openId)).toEqual(["ou_alpha"]);
    expect(JSON.stringify(result)).not.toContain("member_z");
  });
});

describe("summarizePersonalPage", () => {
  it("summarizes the four sections into a card-sized conclusion", () => {
    const db = makeDb();
    seedTwoOwners(db);
    const markdown = String(
      (db
        .prepare(`SELECT markdown FROM personal_pages WHERE owner_id = ? AND kind = 'daily' AND date = ?`)
        .get("member_a", DATE) as { markdown: string }).markdown
    );

    const conclusion = scheduledReport.summarizePersonalPage(markdown);

    expect(conclusion.headline.length).toBeGreaterThan(0);
    expect(conclusion.bullets.length).toBeGreaterThan(0);
    expect(conclusion.bullets.length).toBeLessThanOrEqual(4);
    // Every bullet names the section it came from, and none is an empty stub.
    for (const bullet of conclusion.bullets) {
      expect(bullet.trim().length).toBeGreaterThan(3);
    }
    expect(conclusion.bullets.join("\n")).toContain("策略");
  });

  it("returns an empty conclusion for markdown with no sections rather than guessing", () => {
    const conclusion = scheduledReport.summarizePersonalPage("# 我的个人页 · 日报 2026-07-28\n");

    expect(conclusion).toEqual({ headline: "", bullets: [] });
  });
});
