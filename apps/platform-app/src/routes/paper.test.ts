import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";

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
  opts: {
    ownerId: string | null;
    fetchedAt: string;
    netAssets?: number | null;
    marketValue?: number;
    positions?: unknown[];
    degraded?: boolean;
    degradedReason?: string;
  }
): void {
  const raw = { degraded: opts.degraded ?? false, degradedReason: opts.degradedReason ?? null };
  db.prepare(`
    INSERT INTO official_paper_snapshots
      (id, fetched_at, reason, net_assets, total_cash, market_value, positions, raw, owner_id)
    VALUES (?, ?, 'manual', ?, NULL, ?, ?, ?, ?)
  `).run(
    createId("snapshot"),
    opts.fetchedAt,
    opts.netAssets === undefined ? null : opts.netAssets,
    opts.marketValue ?? 0,
    JSON.stringify(opts.positions ?? []),
    JSON.stringify(raw),
    opts.ownerId
  );
}

/** Wraps `db.prepare` so every bound parameter of every `.all()`/`.get()`
 * call executed through it is recorded - lets tests assert at the SQL layer
 * (not just "not in the rendered HTML") that a given id was NEVER used as a
 * query parameter, proving the hidden-performance gate runs before any
 * query, not just before rendering. */
function spyOnBoundParams(db: DatabaseSync): { params: unknown[]; restore: () => void } {
  const originalPrepare = db.prepare.bind(db);
  const params: unknown[] = [];
  (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
    const stmt = originalPrepare(sql);
    const originalAll = stmt.all.bind(stmt);
    const originalGet = stmt.get.bind(stmt);
    (stmt as unknown as { all: typeof stmt.all }).all = ((...args: unknown[]) => {
      params.push(...args);
      return originalAll(...(args as []));
    }) as typeof stmt.all;
    (stmt as unknown as { get: typeof stmt.get }).get = ((...args: unknown[]) => {
      params.push(...args);
      return originalGet(...(args as []));
    }) as typeof stmt.get;
    return stmt;
  }) as typeof db.prepare;
  return {
    params,
    restore: () => {
      (db as unknown as { prepare: typeof db.prepare }).prepare = originalPrepare;
    }
  };
}

describe("paper route (GET /paper)", () => {
  let db: DatabaseSync;
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;

  const NOW = () => new Date("2026-07-14T12:00:00.000Z"); // 2026-07-14 20:00 Beijing

  beforeEach(async () => {
    db = memoryDb();
    server = createPlatformServer({ db, repoRoot: "/tmp/does-not-matter", now: NOW });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
    const response = await fetch(`${baseUrl}/paper`);
    expect(response.status).toBe(401);
  });

  it("returns 405 for non-GET requests", async () => {
    const { token } = seedMemberWithToken();
    const response = await fetch(`${baseUrl}/paper`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(405);
  });

  it("renders the viewer's own full account by default (KPI/curve/holdings all present)", async () => {
    const { member, token } = seedMemberWithToken();
    seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-14T11:30:00.000Z", netAssets: 1100 });

    const response = await authed("/paper", token);
    expect(response.status).toBe(200);
    const body = await response.text();

    expect(body).toContain("1,100.00 美元");
    expect(body).toContain("净值曲线");
    expect(body).toContain("持仓");
    expect(body).not.toContain("对方未公开战绩");
  });

  it("renders 数据不足 KPIs and an empty-state curve card when the viewer has no snapshots at all", async () => {
    const { token } = seedMemberWithToken();

    const response = await authed("/paper", token);
    const body = await response.text();

    expect(body).toContain("数据不足");
    expect(body).toContain("暂无净值曲线数据——模拟盘接入后显示");
  });

  it("renders an inline SVG net-worth curve when 2+ points exist", async () => {
    const { member, token } = seedMemberWithToken();
    seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-12T00:00:00.000Z", netAssets: 1000 });
    seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-14T11:00:00.000Z", netAssets: 1100 });

    const response = await authed("/paper", token);
    const body = await response.text();

    expect(body).toMatch(/<svg[^>]*aria-label="净值曲线"[\s\S]*?<polyline/u);
  });

  it("renders degraded position badges (.pill.warn) for cost/zero priceSource rows", async () => {
    const { member, token } = seedMemberWithToken();
    seedSnapshot(db, {
      ownerId: member.id,
      fetchedAt: "2026-07-14T11:00:00.000Z",
      netAssets: 1000,
      degraded: true,
      degradedReason: "行情读取失败：NVDA.US(按成本估值)",
      positions: [
        { symbol: "NVDA.US", quantity: 2, costPrice: 800, price: 810, priceSource: "cost" },
        { symbol: "AAPL.US", quantity: 1, costPrice: 200, price: 205, priceSource: "live" }
      ]
    });

    const response = await authed("/paper", token);
    const body = await response.text();

    expect(body).toContain("按成本估值");
    expect(body).toMatch(/<tr class="degraded">[\s\S]*?<span class="pill warn">按成本估值<\/span>/u);
    expect(body).toContain("数据降级提示"); // top-level banner (render/layout.ts), same rule as home
  });

  it("member switcher lists active members and EXCLUDES __legacy_system__ even if forced active", async () => {
    const { token } = seedMemberWithToken({ id: "member_a", email: "a@example.com", displayName: "成员甲" });
    const memberB = makeMember({ id: "member_b", email: "b@example.com", displayName: "成员乙" });
    new MemberRepository(db).upsert(memberB);
    // Force the legacy placeholder to 'active' - defense-in-depth pin, mirrors
    // identity.test.ts's technique for the same guard.
    new MemberRepository(db).upsert(
      makeMember({
        id: "__legacy_system__",
        email: "__legacy_system__@alphaloop.invalid",
        displayName: "Legacy System (migration placeholder)",
        status: "active"
      })
    );

    const response = await authed("/paper", token);
    const body = await response.text();

    expect(body).toContain("成员甲");
    expect(body).toContain("成员乙");
    expect(body).not.toContain("Legacy System (migration placeholder)");
    expect(body).not.toContain("__legacy_system__@alphaloop.invalid");
  });

  it("viewing another member with show_performance=1 shows their real KPI data", async () => {
    const { token: tokenA } = seedMemberWithToken({ id: "member_a", email: "a@example.com", displayName: "甲" });
    const memberB = makeMember({ id: "member_b", email: "b@example.com", displayName: "乙", showPerformance: true });
    new MemberRepository(db).upsert(memberB);
    seedSnapshot(db, { ownerId: "member_b", fetchedAt: "2026-07-14T11:00:00.000Z", netAssets: 5000 });

    const response = await authed("/paper?member=member_b", tokenA);
    const body = await response.text();

    expect(body).toContain("5,000.00 美元");
    expect(body).not.toContain("对方未公开战绩");
  });

  it("viewing another member with show_performance=0 hides KPI/curve/holdings AND never queries their snapshot rows", async () => {
    const { token: tokenA } = seedMemberWithToken({ id: "member_a", email: "a@example.com", displayName: "甲" });
    const memberB = makeMember({ id: "member_b", email: "b@example.com", displayName: "乙", showPerformance: false });
    new MemberRepository(db).upsert(memberB);
    seedSnapshot(db, {
      ownerId: "member_b",
      fetchedAt: "2026-07-14T11:00:00.000Z",
      netAssets: 999999,
      positions: [{ symbol: "SECRET.US", quantity: 1 }]
    });

    const spy = spyOnBoundParams(db);
    const response = await authed("/paper?member=member_b", tokenA);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("对方未公开战绩");
    expect(body).not.toContain("999999");
    expect(body).not.toContain("SECRET.US");
    // The privacy gate must run BEFORE any query, not just before rendering:
    // member_b's id must never appear as a bound SQL parameter anywhere.
    expect(spy.params).not.toContain("member_b");
    spy.restore();
  });

  it("viewing self always shows full data even when the viewer's OWN show_performance is 0", async () => {
    const { member, token } = seedMemberWithToken({ showPerformance: false });
    seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-14T11:00:00.000Z", netAssets: 1234 });

    const response = await authed("/paper", token);
    const body = await response.text();

    expect(body).toContain("1,234.00 美元");
    expect(body).not.toContain("对方未公开战绩");
  });

  it("two-member isolation: viewing an unknown/invalid ?member value falls back to the viewer's own account, never someone else's", async () => {
    const { member, token } = seedMemberWithToken();
    seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-14T11:00:00.000Z", netAssets: 4242 });

    const response = await authed("/paper?member=does-not-exist", token);
    const body = await response.text();

    expect(body).toContain("4,242.00 美元");
  });

  it("compare mode (?compare=1) overlays both curves when the other member allows show_performance", async () => {
    const { token: tokenA } = seedMemberWithToken({ id: "member_a", email: "a@example.com", displayName: "甲" });
    const memberB = makeMember({ id: "member_b", email: "b@example.com", displayName: "乙", showPerformance: true });
    new MemberRepository(db).upsert(memberB);
    seedSnapshot(db, { ownerId: "member_a", fetchedAt: "2026-07-12T00:00:00.000Z", netAssets: 1000 });
    seedSnapshot(db, { ownerId: "member_a", fetchedAt: "2026-07-14T11:00:00.000Z", netAssets: 1100 });
    seedSnapshot(db, { ownerId: "member_b", fetchedAt: "2026-07-12T00:00:00.000Z", netAssets: 5000 });
    seedSnapshot(db, { ownerId: "member_b", fetchedAt: "2026-07-14T11:00:00.000Z", netAssets: 5500 });

    const response = await authed("/paper?member=member_b&compare=1", tokenA);
    const body = await response.text();

    expect(body).toContain("净值曲线对比");
    expect(body).toContain("乙");
    expect(body).toMatch(/<polyline[\s\S]*<polyline/u); // two polylines = two curves
  });

  it("compare mode shows only self + 对方未公开战绩 when the other member hides performance, and never queries their rows", async () => {
    const { member: memberA, token: tokenA } = seedMemberWithToken({ id: "member_a", email: "a@example.com" });
    const memberB = makeMember({ id: "member_b", email: "b@example.com", showPerformance: false });
    new MemberRepository(db).upsert(memberB);
    seedSnapshot(db, { ownerId: memberA.id, fetchedAt: "2026-07-12T00:00:00.000Z", netAssets: 1000 });
    seedSnapshot(db, { ownerId: memberA.id, fetchedAt: "2026-07-14T11:00:00.000Z", netAssets: 1100 });
    seedSnapshot(db, { ownerId: "member_b", fetchedAt: "2026-07-14T11:00:00.000Z", netAssets: 424242 });

    const spy = spyOnBoundParams(db);
    const response = await authed("/paper?member=member_b&compare=1", tokenA);
    const body = await response.text();

    expect(body).toContain("对方未公开战绩");
    expect(body).not.toContain("424242");
    expect(spy.params).not.toContain("member_b");
    spy.restore();
  });

  it("compare mode with no resolvable comparison target shows a hint instead of a silent solo chart", async () => {
    const { member, token } = seedMemberWithToken();
    seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-12T00:00:00.000Z", netAssets: 1000 });
    seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-14T11:00:00.000Z", netAssets: 1100 });

    const response = await authed("/paper?compare=1", token);
    const body = await response.text();

    expect(body).toContain("选择上方成员以对比净值曲线");
  });

  it("carries the response's CSP nonce onto the page and makes no third-party requests", async () => {
    const { token } = seedMemberWithToken();
    const response = await authed("/paper", token);
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonceMatch = /nonce-([^']+)/u.exec(csp);
    expect(nonceMatch).not.toBeNull();
    const body = await response.text();
    expect(body).toContain(`nonce="${nonceMatch?.[1]}"`);
    expect(body).not.toMatch(/https?:\/\//iu);
  });
});
