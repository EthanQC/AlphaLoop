import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApiTokenRepository, MemberRepository, ResearchTaskRepository, createId, migrate, type Member } from "@packages/shared-types";

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
  opts: { ownerId: string; fetchedAt: string; netAssets: number; marketValue?: number }
): void {
  db.prepare(`
    INSERT INTO official_paper_snapshots (id, fetched_at, reason, net_assets, total_cash, market_value, positions, raw, owner_id)
    VALUES (?, ?, 'manual', ?, NULL, ?, '[]', '{}', ?)
  `).run(createId("snapshot"), opts.fetchedAt, opts.netAssets, opts.marketValue ?? opts.netAssets, opts.ownerId);
}

/** Wraps `db.prepare` so every executed query's SQL text + bound parameters
 * are recorded - lets tests assert at the SQL layer (not just "not in the
 * rendered HTML") that `official_paper_snapshots` was NEVER queried at all
 * for a hidden subject. Same technique as paper.test.ts's own
 * spyOnBoundParams (Task 6), extended to also capture the SQL text: the
 * member-card page ALWAYS binds the subject's id for its theses/research
 * queries (those aren't privacy-gated), so asserting "the id never appears
 * as a bound param anywhere" would be too broad here - the precise claim is
 * "no query against official_paper_snapshots ever ran". */
function spyOnPreparedQueries(db: DatabaseSync): {
  calls: Array<{ sql: string; params: unknown[] }>;
  restore: () => void;
} {
  const originalPrepare = db.prepare.bind(db);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
    const stmt = originalPrepare(sql);
    const originalAll = stmt.all.bind(stmt);
    const originalGet = stmt.get.bind(stmt);
    (stmt as unknown as { all: typeof stmt.all }).all = ((...args: unknown[]) => {
      calls.push({ sql, params: args });
      return originalAll(...(args as []));
    }) as typeof stmt.all;
    (stmt as unknown as { get: typeof stmt.get }).get = ((...args: unknown[]) => {
      calls.push({ sql, params: args });
      return originalGet(...(args as []));
    }) as typeof stmt.get;
    return stmt;
  }) as typeof db.prepare;
  return {
    calls,
    restore: () => {
      (db as unknown as { prepare: typeof db.prepare }).prepare = originalPrepare;
    }
  };
}

function seedThesis(
  db: DatabaseSync,
  opts: { ownerId: string; symbol: string; visibility?: "system" | "public"; direction?: "bull" | "bear" | "neutral" }
): void {
  db.prepare(`
    INSERT INTO theses (id, owner_id, symbol, direction, visibility, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
  `).run(createId("thesis"), opts.ownerId, opts.symbol, opts.direction ?? "bull", opts.visibility ?? "system");
}

describe("member card route (GET /member/<who>)", () => {
  let repoRoot: string;
  let db: DatabaseSync;
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;

  const NOW = () => new Date("2026-07-14T12:00:00.000Z");

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "platform-app-member-card-route-"));
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
    const response = await fetch(`${baseUrl}/member/member_1`);
    expect(response.status).toBe(401);
  });

  it("404s for __legacy_system__ - it must never render as a person", async () => {
    // Force the sentinel row to look 'active' to prove the id check itself
    // (not the status filter) is what stops it - same technique identity.test.ts uses.
    db.prepare(`
      INSERT INTO members (id, email, display_name, risk_tags, stock_tags, show_performance, status, created_at)
      VALUES ('__legacy_system__', 'legacy@example.com', 'Legacy System', '[]', '[]', 0, 'active', '2026-01-01T00:00:00.000Z')
    `).run();
    const { token } = seedMemberWithToken();

    const response = await authed("/member/__legacy_system__", token);
    expect(response.status).toBe(404);
  });

  it("404s for an unknown member id", async () => {
    const { token } = seedMemberWithToken();
    const response = await authed("/member/member_does_not_exist", token);
    expect(response.status).toBe(404);
  });

  it("404s for a revoked member", async () => {
    const revoked = makeMember({ id: "member_revoked", email: "revoked@example.com", status: "revoked" });
    new MemberRepository(db).upsert(revoked);
    const { token } = seedMemberWithToken();

    const response = await authed("/member/member_revoked", token);
    expect(response.status).toBe(404);
  });

  it("renders risk_tags/stock_tags as real chips from the members row", async () => {
    const subject = makeMember({
      id: "member_subject",
      email: "subject@example.com",
      displayName: "标的成员",
      riskTags: ["稳健"],
      stockTags: ["半导体", "AI"]
    });
    new MemberRepository(db).upsert(subject);
    const { token } = seedMemberWithToken();

    const response = await authed("/member/member_subject", token);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("标的成员");
    expect(body).toContain("稳健");
    expect(body).toContain("半导体");
    expect(body).toContain("AI");
  });

  describe("show_performance short-circuit", () => {
    it("shows 未公开 and issues NO snapshot query when show_performance=0 and viewer is not the subject", async () => {
      const subject = makeMember({
        id: "member_hidden",
        email: "hidden@example.com",
        showPerformance: false
      });
      new MemberRepository(db).upsert(subject);
      seedSnapshot(db, { ownerId: "member_hidden", fetchedAt: "2026-07-14T10:00:00.000Z", netAssets: 50000 });

      const { token } = seedMemberWithToken();

      const spy = spyOnPreparedQueries(db);
      const response = await authed("/member/member_hidden", token);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain("未公开");
      expect(body).not.toContain("50,000.00");
      // The privacy gate must run BEFORE any query, not just before
      // rendering: no query against official_paper_snapshots may run at all
      // for a hidden subject (the theses/research queries still legitimately
      // bind member_hidden's id - only the snapshot table is gated).
      const snapshotQueries = spy.calls.filter((call) => call.sql.includes("official_paper_snapshots"));
      expect(snapshotQueries.length).toBe(0);
      spy.restore();
    });

    it("shows real KPIs when show_performance=1", async () => {
      const subject = makeMember({ id: "member_open", email: "open@example.com", showPerformance: true });
      new MemberRepository(db).upsert(subject);
      seedSnapshot(db, { ownerId: "member_open", fetchedAt: "2026-07-14T10:00:00.000Z", netAssets: 50000 });

      const { token } = seedMemberWithToken();
      const response = await authed("/member/member_open", token);
      const body = await response.text();

      expect(body).toContain("50,000.00");
      expect(body).not.toContain("未公开");
    });

    it("shows 暂无快照数据 when show_performance=1 but no snapshot exists", async () => {
      const subject = makeMember({ id: "member_open_empty", email: "openempty@example.com", showPerformance: true });
      new MemberRepository(db).upsert(subject);

      const { token } = seedMemberWithToken();
      const response = await authed("/member/member_open_empty", token);
      const body = await response.text();

      expect(body).toContain("暂无快照数据");
    });

    it("a member viewing their OWN card sees their KPIs even if show_performance=0", async () => {
      const { member, token } = seedMemberWithToken({ showPerformance: false });
      seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-14T10:00:00.000Z", netAssets: 12345 });

      const response = await authed(`/member/${member.id}`, token);
      const body = await response.text();
      expect(body).toContain("12,345.00");
      expect(body).not.toContain("未公开");
    });
  });

  describe("公开论点清单", () => {
    it("shows only the subject's PUBLIC theses to a non-self viewer", async () => {
      const subject = makeMember({ id: "member_subject2", email: "subject2@example.com" });
      new MemberRepository(db).upsert(subject);
      seedThesis(db, { ownerId: "member_subject2", symbol: "NVDA.US", visibility: "public" });
      seedThesis(db, { ownerId: "member_subject2", symbol: "TSLA.US", visibility: "system" });

      const { token } = seedMemberWithToken();
      const response = await authed("/member/member_subject2", token);
      const body = await response.text();

      expect(body).toContain("NVDA.US");
      expect(body).not.toContain("TSLA.US");
    });

    it("the subject viewing their own card sees ALL their theses (every visibility) with visibility pills", async () => {
      const { member, token } = seedMemberWithToken();
      seedThesis(db, { ownerId: member.id, symbol: "NVDA.US", visibility: "public" });
      seedThesis(db, { ownerId: member.id, symbol: "TSLA.US", visibility: "system" });

      const response = await authed(`/member/${member.id}`, token);
      const body = await response.text();

      expect(body).toContain("NVDA.US");
      expect(body).toContain("TSLA.US");
      expect(body).toContain("公开");
      expect(body).toContain("系统可用");
    });

    it("shows 暂无公开论点 when the subject has no public theses", async () => {
      const subject = makeMember({ id: "member_subject3", email: "subject3@example.com" });
      new MemberRepository(db).upsert(subject);

      const { token } = seedMemberWithToken();
      const response = await authed("/member/member_subject3", token);
      const body = await response.text();
      expect(body).toContain("暂无公开论点");
      expect(body).toContain("公开即接受检验");
    });

    it("renders bull_points/bear_points evidence and a judgment-history outcome backtest ('公开即接受检验')", async () => {
      const subject = makeMember({ id: "member_subject_evidence", email: "evidence@example.com" });
      new MemberRepository(db).upsert(subject);
      const thesisId = createId("thesis");
      db.prepare(`
        INSERT INTO theses
          (id, owner_id, symbol, direction, target_high, invalidation_price, visibility, created_at, updated_at, bull_points, bear_points)
        VALUES (?, ?, 'NVDA.US', 'bull', 200, 100, 'public', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', ?, ?)
      `).run(thesisId, subject.id, JSON.stringify(["算力需求旺盛"]), JSON.stringify(["估值偏高"]));
      db.prepare(`INSERT INTO thesis_history (id, thesis_id, note, source, created_at) VALUES (?, ?, ?, ?, ?)`).run(
        createId("thesis_hist"),
        thesisId,
        "第一次判断",
        "self",
        "2026-07-05T00:00:00.000Z"
      );
      db.prepare(`
        INSERT INTO stock_facts (id, trading_day, symbol, fact_key, value_num, unit, source, data_time, created_at)
        VALUES (?, '2026-07-13', 'NVDA.US', 'quote.last', 180, 'USD', 'test', '2026-07-13', '2026-07-13')
      `).run(createId("stock_fact"));

      const { token } = seedMemberWithToken();
      const response = await authed("/member/member_subject_evidence", token);
      const body = await response.text();

      expect(body).toContain("算力需求旺盛");
      expect(body).toContain("估值偏高");
      expect(body).toContain("第一次判断");
      expect(body).toContain("样本不足"); // n=1 < 10
      expect(body).toContain("公开即接受检验");
    });
  });

  describe("公开策略清单", () => {
    it("shows only the subject's PUBLIC strategy cards to a non-self viewer, with status badges", async () => {
      const subject = makeMember({ id: "member_subject_cards", email: "cards@example.com" });
      new MemberRepository(db).upsert(subject);
      db.prepare(`
        INSERT INTO strategy_cards (id, owner_id, name, status, visibility, created_at, updated_at)
        VALUES (?, ?, '公开策略卡', 'paused', 'public', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
      `).run(createId("strategy_card"), subject.id);
      db.prepare(`
        INSERT INTO strategy_cards (id, owner_id, name, status, visibility, created_at, updated_at)
        VALUES (?, ?, '系统策略卡', 'active', 'system', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
      `).run(createId("strategy_card"), subject.id);

      const { token } = seedMemberWithToken();
      const response = await authed("/member/member_subject_cards", token);
      const body = await response.text();

      expect(body).toContain("公开策略卡");
      expect(body).toContain("暂停");
      expect(body).not.toContain("系统策略卡");
    });

    it("shows 暂无公开策略卡 when the subject has no public strategy cards", async () => {
      const subject = makeMember({ id: "member_subject_no_cards", email: "nocards@example.com" });
      new MemberRepository(db).upsert(subject);

      const { token } = seedMemberWithToken();
      const response = await authed("/member/member_subject_no_cards", token);
      const body = await response.text();
      expect(body).toContain("暂无公开策略卡");
    });
  });

  it("shows 暂无公开研判 (research_tasks table exists but is empty today)", async () => {
    const subject = makeMember({ id: "member_subject4", email: "subject4@example.com" });
    new MemberRepository(db).upsert(subject);

    const { token } = seedMemberWithToken();
    const response = await authed("/member/member_subject4", token);
    const body = await response.text();
    expect(body).toContain("暂无公开研判");
  });

  // Phase 8 Task 4 (2026-07-16 plan): 公开研判区 real rendering (conclusion +
  // confidence + /research/<id>), replacing the pre-P8 status-only placeholder.
  describe("公开研判 (real rendering)", () => {
    function finishTask(
      ownerId: string,
      question: string,
      opts: { visibility?: "private" | "public"; status?: "done" | "degraded" | "queued"; confidence?: "low" | "medium" | "high" } = {}
    ): string {
      const repo = new ResearchTaskRepository(db);
      const created = repo.createIfWithinQuota({ ownerId, question, tradingDay: "2026-07-14" });
      if (!created.ok) throw new Error("test setup: quota unexpectedly exceeded");
      if (opts.status && opts.status !== "queued") {
        repo.setResult(created.task.id, {
          status: opts.status,
          confidence: opts.confidence ?? "high",
          title: question,
          finishedAt: "2026-07-14T09:00:00.000Z",
          resultJson: {
            conclusion: "该标的短期看多，估值合理。",
            confidence: opts.confidence ?? "high",
            keyPoints: [],
            dataTable: [],
            comparison: { theses: [], disciplines: [] },
            evidence: [],
            skipped: []
          }
        });
      }
      if ((opts.visibility ?? "public") === "public") {
        repo.promoteVisibility(created.task.id, ownerId);
      }
      return created.task.id;
    }

    it("shows the subject's PUBLIC done research as conclusion + confidence + a /research/<id> link", async () => {
      const subject = makeMember({ id: "member_subject_research", email: "research-subject@example.com" });
      new MemberRepository(db).upsert(subject);
      const id = finishTask(subject.id, "NVDA财报前要减仓吗", { status: "done", confidence: "high" });

      const { token } = seedMemberWithToken();
      const response = await authed("/member/member_subject_research", token);
      const body = await response.text();

      expect(body).toContain("NVDA财报前要减仓吗");
      expect(body).toContain("该标的短期看多，估值合理。");
      expect(body).toContain("高"); // CONFIDENCE_LABELS.high
      expect(body).toContain(`href="/research/${id}"`);
    });

    it("never shows the subject's PRIVATE research, even if done", async () => {
      const subject = makeMember({ id: "member_subject_private_research", email: "private-research@example.com" });
      new MemberRepository(db).upsert(subject);
      finishTask(subject.id, "私有研判问题", { status: "done", visibility: "private" });

      const { token } = seedMemberWithToken();
      const response = await authed("/member/member_subject_private_research", token);
      const body = await response.text();
      expect(body).not.toContain("私有研判问题");
      expect(body).toContain("暂无公开研判");
    });

    it("never shows a public but still-queued task (no conclusion to show yet)", async () => {
      const subject = makeMember({ id: "member_subject_queued_research", email: "queued-research@example.com" });
      new MemberRepository(db).upsert(subject);
      finishTask(subject.id, "还在排队的公开问题", { status: "queued", visibility: "public" });

      const { token } = seedMemberWithToken();
      const response = await authed("/member/member_subject_queued_research", token);
      const body = await response.text();
      expect(body).not.toContain("还在排队的公开问题");
      expect(body).toContain("暂无公开研判");
    });
  });

  it("never renders follow/comment/like/DM affordances", async () => {
    const subject = makeMember({ id: "member_subject5", email: "subject5@example.com" });
    new MemberRepository(db).upsert(subject);

    const { token } = seedMemberWithToken();
    const response = await authed("/member/member_subject5", token);
    const body = await response.text();
    expect(body).not.toContain("关注");
    expect(body).not.toContain("评论");
    expect(body).not.toContain("点赞");
    expect(body).not.toContain("私信");
  });

  it("carries the CSP nonce and makes no third-party requests", async () => {
    const subject = makeMember({ id: "member_subject6", email: "subject6@example.com" });
    new MemberRepository(db).upsert(subject);
    const { token } = seedMemberWithToken();

    const response = await authed("/member/member_subject6", token);
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonceMatch = /nonce-([^']+)/u.exec(csp);
    expect(nonceMatch).not.toBeNull();
    const body = await response.text();
    expect(body).toContain(`nonce="${nonceMatch?.[1]}"`);
    expect(body).not.toMatch(/https?:\/\//iu);
  });
});
