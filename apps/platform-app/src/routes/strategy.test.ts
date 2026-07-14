import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

function seedDisciplineRule(
  db: DatabaseSync,
  opts: { ownerId: string; ruleText: string; enforcement: "hard" | "proposal_check" | "self"; enabled?: boolean; createdAt?: string }
): void {
  db.prepare(`
    INSERT INTO discipline_rules (id, owner_id, rule_text, enforcement, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    createId("rule"),
    opts.ownerId,
    opts.ruleText,
    opts.enforcement,
    opts.enabled === false ? 0 : 1,
    opts.createdAt ?? "2026-07-01T00:00:00.000Z"
  );
}

function seedThesis(
  db: DatabaseSync,
  opts: {
    ownerId: string;
    symbol: string;
    direction?: "bull" | "bear" | "neutral";
    visibility?: "system" | "public";
    createdAt?: string;
  }
): string {
  const id = createId("thesis");
  db.prepare(`
    INSERT INTO theses (id, owner_id, symbol, direction, visibility, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.ownerId,
    opts.symbol,
    opts.direction ?? "bull",
    opts.visibility ?? "system",
    opts.createdAt ?? "2026-07-01T00:00:00.000Z",
    opts.createdAt ?? "2026-07-01T00:00:00.000Z"
  );
  return id;
}

function seedThesisHistory(db: DatabaseSync, thesisId: string, note: string, source: string, createdAt: string): void {
  db.prepare(`
    INSERT INTO thesis_history (id, thesis_id, note, source, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(createId("thesis_history"), thesisId, note, source, createdAt);
}

describe("strategy route (GET /strategy)", () => {
  let repoRoot: string;
  let db: DatabaseSync;
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;

  const NOW = () => new Date("2026-07-14T12:00:00.000Z");

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "platform-app-strategy-route-"));
    mkdirSync(join(repoRoot, "reports"), { recursive: true });
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
    const response = await fetch(`${baseUrl}/strategy`);
    expect(response.status).toBe(401);
  });

  it("renders all three placeholder empty states when the viewer has no discipline rules or theses and nobody else has published anything", async () => {
    const { token } = seedMemberWithToken();
    const response = await authed("/strategy", token);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("策略记忆 P7 上线"); // discipline + own-thesis placeholders
    expect(body).toContain("圈子暂无公开策略"); // circle section, DIFFERENT wording
  });

  describe("① 我的纪律", () => {
    it("renders enforcement badges mapped correctly for all three enforcement kinds", async () => {
      const { member, token } = seedMemberWithToken();
      seedDisciplineRule(db, { ownerId: member.id, ruleText: "单票仓位不超过20%", enforcement: "hard" });
      seedDisciplineRule(db, { ownerId: member.id, ruleText: "亏损超过5%需复盘", enforcement: "proposal_check" });
      seedDisciplineRule(db, { ownerId: member.id, ruleText: "财报前不加仓", enforcement: "self" });

      const response = await authed("/strategy", token);
      const body = await response.text();

      expect(body).toContain("代码强制");
      expect(body).toContain("提案检查");
      expect(body).toContain("自我约束");
      expect(body).toContain("统计 P7 上线"); // 近30天遵守 placeholder slot
    });

    it("orders enabled rules before disabled ones (enabled first) and still shows disabled rules to their owner", async () => {
      const { member, token } = seedMemberWithToken();
      seedDisciplineRule(db, {
        ownerId: member.id,
        ruleText: "已停用规则",
        enforcement: "self",
        enabled: false,
        createdAt: "2026-06-01T00:00:00.000Z"
      });
      seedDisciplineRule(db, {
        ownerId: member.id,
        ruleText: "启用中规则",
        enforcement: "hard",
        enabled: true,
        createdAt: "2026-05-01T00:00:00.000Z"
      });

      const response = await authed("/strategy", token);
      const body = await response.text();

      expect(body).toContain("已停用规则"); // disabled rules still shown to their own owner
      const enabledIdx = body.indexOf("启用中规则");
      const disabledIdx = body.indexOf("已停用规则");
      expect(enabledIdx).toBeGreaterThan(-1);
      expect(enabledIdx).toBeLessThan(disabledIdx); // enabled-first ordering
    });

    it("B never sees A's discipline rules on B's own strategy page", async () => {
      const memberA = makeMember({ id: "member_a", email: "a@example.com" });
      new MemberRepository(db).upsert(memberA);
      seedDisciplineRule(db, { ownerId: "member_a", ruleText: "A的专属规则", enforcement: "hard" });

      const { token: tokenB } = seedMemberWithToken({ id: "member_b", email: "b@example.com" });
      const response = await authed("/strategy", tokenB);
      const body = await response.text();
      expect(body).not.toContain("A的专属规则");
    });
  });

  describe("② 我的策略卡与论点", () => {
    it("shows the viewer's own thesis regardless of its visibility, with the correct visibility pill and direction label", async () => {
      const { member, token } = seedMemberWithToken();
      seedThesis(db, { ownerId: member.id, symbol: "NVDA.US", direction: "bull", visibility: "system" });

      const response = await authed("/strategy", token);
      const body = await response.text();

      expect(body).toContain("NVDA.US");
      expect(body).toContain("看多");
      expect(body).toContain("系统可用");
    });

    it("shows a public visibility pill for the viewer's own public thesis", async () => {
      const { member, token } = seedMemberWithToken();
      seedThesis(db, { ownerId: member.id, symbol: "TSLA.US", direction: "bear", visibility: "public" });

      const response = await authed("/strategy", token);
      const body = await response.text();

      expect(body).toContain("看空");
      expect(body).toContain("公开");
    });

    it("renders thesis_history as an append-only, oldest-first timeline", async () => {
      const { member, token } = seedMemberWithToken();
      const thesisId = seedThesis(db, { ownerId: member.id, symbol: "AAPL.US" });
      seedThesisHistory(db, thesisId, "第二次判断", "自我批注", "2026-07-05T00:00:00.000Z");
      seedThesisHistory(db, thesisId, "第一次判断", "审批卡采集", "2026-07-01T00:00:00.000Z");

      const response = await authed("/strategy", token);
      const body = await response.text();

      const firstIdx = body.indexOf("第一次判断");
      const secondIdx = body.indexOf("第二次判断");
      expect(firstIdx).toBeGreaterThan(-1);
      expect(secondIdx).toBeGreaterThan(-1);
      expect(firstIdx).toBeLessThan(secondIdx); // oldest first
    });

    it("shows 暂无判断历史 when a thesis has no history rows", async () => {
      const { member, token } = seedMemberWithToken();
      seedThesis(db, { ownerId: member.id, symbol: "QQQ.US" });

      const response = await authed("/strategy", token);
      const body = await response.text();
      expect(body).toContain("暂无判断历史");
    });
  });

  describe("③ 圈子公开区: visibility filtering", () => {
    it("A's 'system' (private) thesis is invisible in B's 圈子公开区", async () => {
      const memberA = makeMember({ id: "member_a", email: "a@example.com", displayName: "甲" });
      new MemberRepository(db).upsert(memberA);
      seedThesis(db, { ownerId: "member_a", symbol: "NVDA.US", visibility: "system", direction: "bear" });

      const { token: tokenB } = seedMemberWithToken({ id: "member_b", email: "b@example.com" });
      const response = await authed("/strategy", tokenB);
      const body = await response.text();

      expect(body).toContain("圈子暂无公开策略"); // A's system thesis must not leak into B's circle section
    });

    it("A's 'public' thesis IS visible in B's 圈子公开区, grouped under A's display name linking to /member/<A>", async () => {
      const memberA = makeMember({ id: "member_a", email: "a@example.com", displayName: "甲" });
      new MemberRepository(db).upsert(memberA);
      seedThesis(db, { ownerId: "member_a", symbol: "NVDA.US", visibility: "public", direction: "bull" });

      const { token: tokenB } = seedMemberWithToken({ id: "member_b", email: "b@example.com" });
      const response = await authed("/strategy", tokenB);
      const body = await response.text();

      expect(body).toContain("甲");
      expect(body).toContain('href="/member/member_a"');
      expect(body).toContain("NVDA.US");
    });

    it("the viewer's OWN public thesis does not appear a second time in their own 圈子公开区 (that section is for OTHER members only)", async () => {
      const { member, token } = seedMemberWithToken();
      seedThesis(db, { ownerId: member.id, symbol: "MSFT.US", visibility: "public" });

      const response = await authed("/strategy", token);
      const body = await response.text();
      // Own public thesis shows once (② section) but circle section (③) is empty.
      expect(body).toContain("圈子暂无公开策略");
    });

    it("does not show a revoked member's public thesis in the circle section", async () => {
      const memberA = makeMember({ id: "member_a", email: "a@example.com", displayName: "甲", status: "revoked" });
      new MemberRepository(db).upsert(memberA);
      seedThesis(db, { ownerId: "member_a", symbol: "NVDA.US", visibility: "public" });

      const { token: tokenB } = seedMemberWithToken({ id: "member_b", email: "b@example.com" });
      const response = await authed("/strategy", tokenB);
      const body = await response.text();
      expect(body).toContain("圈子暂无公开策略");
    });
  });

  it("carries the CSP nonce and makes no third-party requests", async () => {
    const { token } = seedMemberWithToken();
    const response = await authed("/strategy", token);
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonceMatch = /nonce-([^']+)/u.exec(csp);
    expect(nonceMatch).not.toBeNull();
    const body = await response.text();
    expect(body).toContain(`nonce="${nonceMatch?.[1]}"`);
    expect(body).not.toMatch(/https?:\/\//iu);
  });
});
