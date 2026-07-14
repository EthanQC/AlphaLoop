import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApiTokenRepository, MemberRepository, createId, migrate, type Member } from "@packages/shared-types";

import { createPlatformServer } from "../server.js";

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    id: "member_1",
    email: "member1@example.com",
    displayName: "Member One",
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

function seedSnapshot(
  db: DatabaseSync,
  opts: { ownerId: string | null; fetchedAt: string; netAssets?: number | null; positions?: unknown[]; degraded?: boolean; degradedReason?: string }
): void {
  const raw = { degraded: opts.degraded ?? false, degradedReason: opts.degradedReason ?? null };
  db.prepare(`
    INSERT INTO official_paper_snapshots (id, fetched_at, reason, net_assets, total_cash, market_value, positions, raw, owner_id)
    VALUES (?, ?, 'manual', ?, NULL, 0, ?, ?, ?)
  `).run(
    createId("snapshot"),
    opts.fetchedAt,
    opts.netAssets === undefined ? null : opts.netAssets,
    JSON.stringify(opts.positions ?? []),
    JSON.stringify(raw),
    opts.ownerId
  );
}

function seedAlertRuleAndEvent(
  db: DatabaseSync,
  opts: { ownerId: string; symbol: string; ruleType: string; triggeredAt: string; value: number }
): void {
  const ruleId = createId("alert_rule");
  db.prepare(`
    INSERT INTO alert_rules (id, owner_id, symbol, rule_type, threshold, direction, frequency, hysteresis, enabled, created_at)
    VALUES (?, ?, ?, ?, 5, 'both', 'continuous', 0, 1, '2026-07-01T00:00:00.000Z')
  `).run(ruleId, opts.ownerId, opts.symbol, opts.ruleType);
  db.prepare(`
    INSERT INTO alert_events (id, rule_id, owner_id, triggered_at, value)
    VALUES (?, ?, ?, ?, ?)
  `).run(createId("alert_event"), ruleId, opts.ownerId, opts.triggeredAt, opts.value);
}

function writeDailyReport(repoRoot: string, filename: string, content: string): void {
  const dir = join(repoRoot, "reports", "daily");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, "utf8");
}

describe("home route (GET /)", () => {
  let repoRoot: string;
  let db: DatabaseSync;
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;

  // Fixed clock: 2026-07-14T12:00:00Z is 2026-07-14 20:00 in Asia/Shanghai.
  const NOW = () => new Date("2026-07-14T12:00:00.000Z");

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "platform-app-home-route-"));
    db = memoryDb();
    server = createPlatformServer({ db, repoRoot, now: NOW });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function seedMemberWithToken(overrides: Partial<Member> = {}): { member: Member; token: string } {
    const member = makeMember(overrides);
    new MemberRepository(db).upsert(member);
    const token = new ApiTokenRepository(db).issue(member.id, "test").token;
    return { member, token };
  }

  function authed(path: string, token: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  }

  it("returns 401 without any identity", async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain("未获授权");
  });

  it("returns 405 for non-GET requests", async () => {
    const { token } = seedMemberWithToken();
    const response = await fetch(`${baseUrl}/`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(405);
  });

  it("returns text/html and carries the response's CSP nonce onto the page's one inline script", async () => {
    const { token } = seedMemberWithToken();
    const response = await authed("/", token);
    expect(response.headers.get("content-type")).toContain("text/html");
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonceMatch = /nonce-([^']+)/u.exec(csp);
    expect(nonceMatch).not.toBeNull();
    const body = await response.text();
    expect(body).toContain(`nonce="${nonceMatch?.[1]}"`);
  });

  it("omits the degradation banner by default (no snapshot at all)", async () => {
    const { token } = seedMemberWithToken();
    const response = await authed("/", token);
    const body = await response.text();
    expect(body).not.toContain("数据降级提示");
  });

  it("renders every block in the required order and every empty-state placeholder text (fully empty db)", async () => {
    const { token } = seedMemberWithToken();

    const response = await authed("/", token);
    expect(response.status).toBe(200);
    const body = await response.text();

    const expectedOrder = [
      "开始研究",
      "站内研究 P8 上线",
      "我的模拟盘概览",
      "暂无快照数据——模拟盘接入后显示",
      "我的待办",
      "提案审批 P6 上线",
      "我的提醒流水",
      "暂无提醒",
      "今日日报卡",
      "暂无日报",
      "纪律速览",
      "策略记忆 P7 上线"
    ];

    let cursor = -1;
    for (const marker of expectedOrder) {
      expect(body).toContain(marker);
      const index = body.indexOf(marker);
      expect(index).toBeGreaterThan(cursor);
      cursor = index;
    }
  });

  it("renders a disabled input/button for the start-research block", async () => {
    const { token } = seedMemberWithToken();
    const response = await authed("/", token);
    const body = await response.text();
    expect(body).toMatch(/<input[^>]*disabled[^>]*>/u);
    expect(body).toMatch(/<button[^>]*disabled[^>]*>开始研究<\/button>/u);
  });

  it("renders real snapshot net assets and today's change when both today's and yesterday's snapshots exist", async () => {
    const { member, token } = seedMemberWithToken();
    seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-13T05:00:00.000Z", netAssets: 1000 });
    seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-14T11:30:00.000Z", netAssets: 1100 });

    const response = await authed("/", token);
    const body = await response.text();

    expect(body).toContain("1,100.00 美元");
    expect(body).toContain("+10.00%");
    expect(body).not.toContain("暂无快照数据");
  });

  it("shows 数据不足 for today's change when there is no previous-day snapshot", async () => {
    const { member, token } = seedMemberWithToken();
    seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-14T11:30:00.000Z", netAssets: 1100 });

    const response = await authed("/", token);
    const body = await response.text();

    expect(body).toContain("1,100.00 美元");
    expect(body).toContain("数据不足");
  });

  it("shows 数据不足 (never a fabricated +0.00%) when the only snapshot is stale and 'today' and 'previous day' resolve to the SAME row", async () => {
    const { member, token } = seedMemberWithToken();
    // Only one snapshot exists at all, and it's several days old - both
    // loadLatestSnapshotForOwner (owner's own newest row, no date bound) and
    // loadPreviousDaySnapshotForOwner (owner's own newest row before today)
    // resolve to this identical row. There is no genuine today-vs-yesterday
    // comparison available, so today's change must be "数据不足", never a
    // same-row-diffed "+0.00%".
    seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-10T05:00:00.000Z", netAssets: 1000 });

    const response = await authed("/", token);
    const body = await response.text();

    expect(body).toContain("1,000.00 美元");
    expect(body).toContain("数据不足");
    expect(body).not.toContain("+0.00%");
  });

  it("renders the degraded valuation note and top banner when the snapshot is degraded", async () => {
    const { member, token } = seedMemberWithToken();
    seedSnapshot(db, {
      ownerId: member.id,
      fetchedAt: "2026-07-14T11:30:00.000Z",
      netAssets: 1100,
      degraded: true,
      degradedReason: "行情读取失败：NVDA.US(按成本估值)"
    });

    const response = await authed("/", token);
    const body = await response.text();

    expect(body).toContain("估值降级：行情读取失败：NVDA.US(按成本估值)");
    expect(body).toContain("数据降级提示"); // top-level degraded banner (render/layout.ts)
  });

  it("marks freshness as 最新 for a snapshot under 90 minutes old, 延迟 for older, 部分缺失 for none", async () => {
    const { member: memberA, token: tokenA } = seedMemberWithToken({ id: "member_a", email: "a@example.com" });
    seedSnapshot(db, { ownerId: memberA.id, fetchedAt: "2026-07-14T11:00:00.000Z", netAssets: 1100 }); // 60min old at NOW
    const freshResponse = await authed("/", tokenA);
    expect(await freshResponse.text()).toContain("最新");

    const dbDelayed = memoryDb();
    const serverDelayed = createPlatformServer({ db: dbDelayed, repoRoot, now: NOW });
    await new Promise<void>((resolve) => serverDelayed.listen(0, "127.0.0.1", () => resolve()));
    const addressDelayed = serverDelayed.address() as AddressInfo;
    const baseUrlDelayed = `http://127.0.0.1:${addressDelayed.port}`;
    const memberB = makeMember({ id: "member_b", email: "b@example.com" });
    new MemberRepository(dbDelayed).upsert(memberB);
    const tokenB = new ApiTokenRepository(dbDelayed).issue(memberB.id, "test").token;
    seedSnapshot(dbDelayed, { ownerId: memberB.id, fetchedAt: "2026-07-14T09:00:00.000Z", netAssets: 1100 }); // 3h old
    const delayedResponse = await fetch(`${baseUrlDelayed}/`, { headers: { authorization: `Bearer ${tokenB}` } });
    expect(await delayedResponse.text()).toContain("延迟");
    await new Promise<void>((resolve) => serverDelayed.close(() => resolve()));

    const { token: tokenC } = seedMemberWithToken({ id: "member_c", email: "c@example.com" });
    const missingResponse = await authed("/", tokenC);
    expect(await missingResponse.text()).toContain("部分缺失");
  });

  it("renders real alert_events rows with symbol/type/value/Beijing time", async () => {
    const { member, token } = seedMemberWithToken();
    seedAlertRuleAndEvent(db, {
      ownerId: member.id,
      symbol: "NVDA.US",
      ruleType: "daily_move",
      triggeredAt: "2026-07-14T10:10:00.000Z", // 18:10 Beijing
      value: -4.3
    });

    const response = await authed("/", token);
    const body = await response.text();

    expect(body).toContain("NVDA.US");
    expect(body).toContain("日内波动");
    expect(body).toContain("-4.3");
    expect(body).toContain("07-14 18:10"); // Beijing time
    expect(body).not.toContain("暂无提醒");
  });

  it("two-member isolation: member A's alert events never appear on member B's home page", async () => {
    const { member: memberA } = seedMemberWithToken({ id: "member_a", email: "a@example.com" });
    seedAlertRuleAndEvent(db, {
      ownerId: memberA.id,
      symbol: "NVDA.US",
      ruleType: "daily_move",
      triggeredAt: "2026-07-14T10:10:00.000Z",
      value: -4.3
    });

    const memberB = makeMember({ id: "member_b", email: "b@example.com" });
    new MemberRepository(db).upsert(memberB);
    const tokenB = new ApiTokenRepository(db).issue(memberB.id, "test").token;

    const response = await authed("/", tokenB);
    const body = await response.text();

    expect(body).not.toContain("NVDA.US");
    expect(body).toContain("暂无提醒");
  });

  it("renders the latest daily report as a link, with a legacy pill (every current report is legacy)", async () => {
    const { token } = seedMemberWithToken();
    writeDailyReport(repoRoot, "2026-07-14.md", "# 今日日报标题\n\n内容。\n");

    const response = await authed("/", token);
    const body = await response.text();

    expect(body).toContain("今日日报标题");
    expect(body).toContain('href="/daily/2026-07-14"');
    expect(body).toContain("历史存档");
    expect(body).not.toContain("暂无日报");
  });
});
