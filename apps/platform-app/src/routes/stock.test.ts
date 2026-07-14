import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApiTokenRepository, MemberRepository, createId, migrate, type Member } from "@packages/shared-types";

import { createPlatformServer } from "../server.js";
import { normalizeStockSymbol } from "./stock.js";

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

function seedThesis(
  db: DatabaseSync,
  opts: {
    ownerId: string;
    symbol: string;
    direction?: "bull" | "bear" | "neutral";
    visibility?: "system" | "public";
    createdAt?: string;
  }
): void {
  db.prepare(`
    INSERT INTO theses (id, owner_id, symbol, direction, visibility, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    createId("thesis"),
    opts.ownerId,
    opts.symbol,
    opts.direction ?? "bull",
    opts.visibility ?? "system",
    opts.createdAt ?? "2026-07-01T00:00:00.000Z",
    opts.createdAt ?? "2026-07-01T00:00:00.000Z"
  );
}

function seedAlertRuleAndEvent(
  db: DatabaseSync,
  opts: { ownerId: string; symbol: string; ruleType?: string; triggeredAt: string; value: number }
): void {
  const ruleId = createId("alert_rule");
  db.prepare(`
    INSERT INTO alert_rules (id, owner_id, symbol, rule_type, threshold, direction, frequency, hysteresis, enabled, created_at)
    VALUES (?, ?, ?, ?, 5, 'both', 'continuous', 0, 1, '2026-07-01T00:00:00.000Z')
  `).run(ruleId, opts.ownerId, opts.symbol, opts.ruleType ?? "daily_move");
  db.prepare(`
    INSERT INTO alert_events (id, rule_id, owner_id, triggered_at, value)
    VALUES (?, ?, ?, ?, ?)
  `).run(createId("alert_event"), ruleId, opts.ownerId, opts.triggeredAt, opts.value);
}

function writeStockAnalysisReport(repoRoot: string, filename: string, content: string): void {
  const dir = join(repoRoot, "reports", "stock-analysis");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, "utf8");
}

describe("normalizeStockSymbol", () => {
  it("appends .US to a bare 1-6 letter ticker", () => {
    expect(normalizeStockSymbol("aapl")).toBe("AAPL.US");
    expect(normalizeStockSymbol("Q")).toBe("Q.US");
  });

  it("passes through an already-suffixed symbol unchanged (uppercased)", () => {
    expect(normalizeStockSymbol("qqq.us")).toBe("QQQ.US");
    expect(normalizeStockSymbol("0700.hk")).toBe("0700.HK");
  });

  it("passes through a dot-prefixed index symbol unchanged", () => {
    expect(normalizeStockSymbol(".dji")).toBe(".DJI");
  });

  it("rejects a hyphen even though report-data.mjs's own normalizeSymbol regex would allow one (deliberate narrower charset)", () => {
    expect(normalizeStockSymbol("BRK-B")).toBeNull();
  });

  it("rejects empty/whitespace-only input", () => {
    expect(normalizeStockSymbol("")).toBeNull();
    expect(normalizeStockSymbol("   ")).toBeNull();
  });

  it("rejects path-traversal-shaped input (percent-encoded slash surviving as literal text)", () => {
    expect(normalizeStockSymbol("..%2f..%2fetc%2fpasswd")).toBeNull();
    expect(normalizeStockSymbol("../../etc/passwd")).toBeNull();
  });

  it("rejects input containing other disallowed characters", () => {
    expect(normalizeStockSymbol("<script>")).toBeNull();
    expect(normalizeStockSymbol("AAPL US")).toBeNull();
  });
});

describe("stock route (GET /stock/<code>)", () => {
  let repoRoot: string;
  let db: DatabaseSync;
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;

  const NOW = () => new Date("2026-07-14T12:00:00.000Z");

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "platform-app-stock-route-"));
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
    const response = await fetch(`${baseUrl}/stock/QQQ.US`);
    expect(response.status).toBe(401);
  });

  it("returns 404 for an invalid symbol (disallowed characters)", async () => {
    const { token } = seedMemberWithToken();
    const response = await authed("/stock/%3Cscript%3E", token);
    expect(response.status).toBe(404);
  });

  it("returns 404 for a path-traversal probe encoded into the symbol segment", async () => {
    const { token } = seedMemberWithToken();
    const response = await authed("/stock/..%2f..%2fetc%2fpasswd", token);
    expect(response.status).toBe(404);
  });

  it("returns 404 for a plain ../.. traversal (collapsed by URL parsing before routing)", async () => {
    const { token } = seedMemberWithToken();
    // Collapses to '/etc/passwd' at the URL layer - two segments, first isn't 'stock' -> generic 404.
    const response = await authed("/stock/../etc/passwd", token);
    expect(response.status).toBe(404);
  });

  it("renders 200 with the normalized symbol in the header for a valid bare ticker", async () => {
    const { token } = seedMemberWithToken();
    const response = await authed("/stock/aapl", token);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("AAPL.US");
  });

  it("renders 暂无公共分析 when no stock-analysis report mentions the symbol", async () => {
    const { token } = seedMemberWithToken();
    const response = await authed("/stock/QQQ.US", token);
    const body = await response.text();
    expect(body).toContain("暂无公共分析");
  });

  it("freshness pill is 部分缺失 when no report mentions the symbol at all (never a fabricated 最新)", async () => {
    const { token } = seedMemberWithToken();
    const response = await authed("/stock/QQQ.US", token);
    const body = await response.text();
    expect(body).toContain('<span class="pill warn">部分缺失</span>');
  });

  it("freshness pill is 延迟 when the newest matching report is older than today (Beijing)", async () => {
    const { token } = seedMemberWithToken();
    writeStockAnalysisReport(repoRoot, "2026-06-19.md", "# 个股分析\n\n## AAPL.US\n\n- 旧数据\n");

    const response = await authed("/stock/AAPL.US", token);
    const body = await response.text();

    expect(body).toContain('<span class="pill warn">延迟</span>');
  });

  it("freshness pill is 最新 when the newest matching report is dated today (Beijing)", async () => {
    const { token } = seedMemberWithToken();
    // NOW is fixed to 2026-07-14T12:00:00Z (2026-07-14 in Beijing).
    writeStockAnalysisReport(repoRoot, "2026-07-14.md", "# 个股分析\n\n## AAPL.US\n\n- 今日数据\n");

    const response = await authed("/stock/AAPL.US", token);
    const body = await response.text();

    expect(body).toContain('<span class="pill ok">最新</span>');
  });

  it("extracts the newest report's per-symbol section summary when one exists", async () => {
    const { token } = seedMemberWithToken();
    writeStockAnalysisReport(
      repoRoot,
      "2026-06-14.md",
      "# OpenClaw 个股分析 2026-06-14\n\n## AAPL.US\n\n### 标的基本信息\n\n- 最新价格：290.00；旧报告。\n"
    );
    writeStockAnalysisReport(
      repoRoot,
      "2026-06-19.md",
      "# OpenClaw 个股分析 2026-06-19\n\n## AAPL.US\n\n### 标的基本信息\n\n- 最新价格：298.01；涨跌幅：+0.70%；成交量：85962201.00。\n\n### 投资逻辑\n\n- 后续段落不应出现在摘要里。\n"
    );

    const response = await authed("/stock/AAPL.US", token);
    const body = await response.text();

    expect(body).toContain("最新价格：298.01；涨跌幅：+0.70%；成交量：85962201.00。");
    expect(body).not.toContain("290.00");
    expect(body).not.toContain("后续段落不应出现在摘要里");
    expect(body).toContain("2026-06-19"); // newest report's date shown as data time
  });

  it("historical analysis list only includes reports that actually mention this symbol, newest first", async () => {
    const { token } = seedMemberWithToken();
    writeStockAnalysisReport(repoRoot, "2026-06-14.md", "# 个股分析\n\n## AAPL.US\n\n- 内容 A\n");
    writeStockAnalysisReport(repoRoot, "2026-06-19.md", "# 个股分析\n\n## GOOG.US\n\n- 与 AAPL 无关\n");

    const response = await authed("/stock/AAPL.US", token);
    const body = await response.text();

    expect(body).toContain('href="/stock-analysis/2026-06-14"');
    expect(body).not.toContain('href="/stock-analysis/2026-06-19"');
  });

  it("我的论点卡 shows the viewer's own thesis and renders P7 placeholder note when nobody has published one", async () => {
    const { token } = seedMemberWithToken();
    const response = await authed("/stock/NVDA.US", token);
    const body = await response.text();
    expect(body).toContain("策略记忆 P7 上线");
  });

  it("theses visibility: B's private (system) thesis is invisible to A; B's public thesis on the same symbol is visible to A", async () => {
    const { token: tokenA } = seedMemberWithToken({ id: "member_a", email: "a@example.com", displayName: "甲" });
    const memberB = makeMember({ id: "member_b", email: "b@example.com", displayName: "乙" });
    new MemberRepository(db).upsert(memberB);
    seedThesis(db, { ownerId: "member_b", symbol: "NVDA.US", visibility: "system", direction: "bear" });

    const privateResponse = await authed("/stock/NVDA.US", tokenA);
    const privateBody = await privateResponse.text();
    expect(privateBody).toContain("策略记忆 P7 上线"); // B's private thesis must not leak to A
    expect(privateBody).not.toContain("看空");

    seedThesis(db, { ownerId: "member_b", symbol: "NVDA.US", visibility: "public", direction: "bull" });
    const publicResponse = await authed("/stock/NVDA.US", tokenA);
    const publicBody = await publicResponse.text();
    expect(publicBody).toContain("乙");
    expect(publicBody).toContain("看多");
  });

  it("我的论点卡 always shows the viewer's own thesis regardless of its visibility", async () => {
    const { member, token } = seedMemberWithToken();
    seedThesis(db, { ownerId: member.id, symbol: "TSLA.US", visibility: "system", direction: "bear" });

    const response = await authed("/stock/TSLA.US", token);
    const body = await response.text();

    expect(body).toContain("看空");
  });

  it("我的该标的提醒历史 is owner-scoped: B's alert history for the symbol never appears when A views it", async () => {
    const { token: tokenA } = seedMemberWithToken({ id: "member_a", email: "a@example.com" });
    const memberB = makeMember({ id: "member_b", email: "b@example.com" });
    new MemberRepository(db).upsert(memberB);
    seedAlertRuleAndEvent(db, { ownerId: "member_b", symbol: "TSLA.US", triggeredAt: "2026-07-14T01:00:00.000Z", value: -9.9 });

    const response = await authed("/stock/TSLA.US", tokenA);
    const body = await response.text();

    expect(body).toContain("暂无提醒");
    expect(body).not.toContain("-9.9");
  });

  it("我的该标的提醒历史 renders the viewer's own matching alert events", async () => {
    const { member, token } = seedMemberWithToken();
    seedAlertRuleAndEvent(db, { ownerId: member.id, symbol: "TSLA.US", ruleType: "daily_move", triggeredAt: "2026-07-14T01:00:00.000Z", value: -6.2 });
    // A different symbol's alert must not show up under TSLA.US's history.
    seedAlertRuleAndEvent(db, { ownerId: member.id, symbol: "NVDA.US", triggeredAt: "2026-07-14T02:00:00.000Z", value: 1.1 });

    const response = await authed("/stock/TSLA.US", token);
    const body = await response.text();

    expect(body).toContain("-6.2");
    expect(body).not.toContain("1.1");
  });

  it("carries the CSP nonce and makes no third-party requests", async () => {
    const { token } = seedMemberWithToken();
    const response = await authed("/stock/QQQ.US", token);
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonceMatch = /nonce-([^']+)/u.exec(csp);
    expect(nonceMatch).not.toBeNull();
    const body = await response.text();
    expect(body).toContain(`nonce="${nonceMatch?.[1]}"`);
    expect(body).not.toMatch(/https?:\/\//iu);
  });
});
