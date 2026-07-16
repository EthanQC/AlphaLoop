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
    bullPoints?: string[];
    bearPoints?: string[];
    targetLow?: number;
    targetHigh?: number;
    invalidationPrice?: number;
  }
): string {
  const id = createId("thesis");
  db.prepare(`
    INSERT INTO theses
      (id, owner_id, symbol, direction, target_low, target_high, invalidation_price,
       visibility, created_at, updated_at, bull_points, bear_points)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.ownerId,
    opts.symbol,
    opts.direction ?? "bull",
    opts.targetLow ?? null,
    opts.targetHigh ?? null,
    opts.invalidationPrice ?? null,
    opts.visibility ?? "system",
    opts.createdAt ?? "2026-07-01T00:00:00.000Z",
    opts.createdAt ?? "2026-07-01T00:00:00.000Z",
    JSON.stringify(opts.bullPoints ?? []),
    JSON.stringify(opts.bearPoints ?? [])
  );
  return id;
}

function seedThesisHistory(db: DatabaseSync, thesisId: string, note: string, source: string, createdAt: string): void {
  db.prepare(`
    INSERT INTO thesis_history (id, thesis_id, note, source, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(createId("thesis_history"), thesisId, note, source, createdAt);
}

function seedStockFact(db: DatabaseSync, opts: { symbol: string; tradingDay: string; valueNum: number }): void {
  db.prepare(`
    INSERT INTO stock_facts (id, trading_day, symbol, fact_key, value_num, value_text, unit, source, data_time, created_at)
    VALUES (?, ?, ?, 'quote.last', ?, NULL, 'USD', 'test', ?, ?)
  `).run(createId("stock_fact"), opts.tradingDay, opts.symbol, opts.valueNum, opts.tradingDay, opts.tradingDay);
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

  it("accepts a hyphen now that the charset is aligned with report-data.mjs's normalizeSymbol (Phase 5 Task 5)", () => {
    // Bare hyphenated ticker: doesn't match the 1-6-plain-letter bare-ticker
    // shortcut (so no .US gets appended), and isn't already dot-suffixed -
    // passes through unchanged, same as report-data.mjs's own normalizeSymbol
    // would do for this exact input.
    expect(normalizeStockSymbol("BRK-B")).toBe("BRK-B");
    // Already-suffixed hyphenated symbol - unchanged (uppercased).
    expect(normalizeStockSymbol("brk-b.us")).toBe("BRK-B.US");
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

  // Phase 5 Task 5 (2026-07-15 plan): the summary card upgrade. A legacy
  // report (no "### 结论框" in its symbol section) keeps the pre-Task-5
  // first-bullet behavior, plus an explicit note that no structured box was
  // found - never silently indistinguishable from a genuinely terse
  // structured result.
  it("falls back to the first-bullet summary + 旧格式无结论框 note for a legacy report with no 结论框 block", async () => {
    const { token } = seedMemberWithToken();
    writeStockAnalysisReport(
      repoRoot,
      "2026-06-19.md",
      "# OpenClaw 个股分析 2026-06-19\n\n## AAPL.US\n\n### 标的基本信息\n\n- 最新价格：298.01；旧格式。\n"
    );

    const response = await authed("/stock/AAPL.US", token);
    const body = await response.text();

    expect(body).toContain("最新价格：298.01；旧格式。");
    expect(body).toContain("旧格式无结论框");
  });

  // New-format report: a "### 结论框" block in the symbol's own section
  // parses through parseConclusionBox and renders the structured fields
  // instead of the raw first bullet.
  const NEW_FORMAT_AAPL_SECTION = [
    "# OpenClaw 个股分析 2026-07-14",
    "",
    "## AAPL.US",
    "",
    "### 结论与复盘标签",
    "",
    "- 上行路径（约 +45.00%）：既有的三路径叙述文字保留在结论框之前。",
    "",
    "### 结论框",
    "",
    "- 核心结论：短线偏上行：守住支撑位 210.50 美元并放量突破 220.00 美元",
    "- 置信度：高",
    "- 合理价值区间：205.12–230.50 美元（依据：近20日支撑位与卖方一年目标价）",
    "- 当前价格位置：现价 210.50 美元，位于合理区间内",
    "- 复盘触发：若价格跌破支撑位 205.12 美元，需重新评估当前结论（复盘日期：2026-08-15）"
  ].join("\n");

  it("renders 核心结论 + confidence badge + 合理价值区间 + 复盘日期 for a new-format report with a 结论框 block", async () => {
    const { token } = seedMemberWithToken();
    writeStockAnalysisReport(repoRoot, "2026-07-14.md", NEW_FORMAT_AAPL_SECTION);

    const response = await authed("/stock/AAPL.US", token);
    const body = await response.text();

    expect(body).toContain("短线偏上行：守住支撑位 210.50 美元并放量突破 220.00 美元");
    expect(body).toContain('<span class="pill ok">高</span>');
    expect(body).toContain("205.12");
    expect(body).toContain("230.50");
    expect(body).toContain("2026-08-15");
    expect(body).not.toContain("旧格式无结论框");
  });

  it("renders the 中 (amber warn) and 低 (sub-muted) confidence badges for their own tiers", async () => {
    const { token: tokenMedium } = seedMemberWithToken({ id: "m_medium", email: "medium@example.com" });
    writeStockAnalysisReport(repoRoot, "2026-07-14.md", NEW_FORMAT_AAPL_SECTION.replace("- 置信度：高", "- 置信度：中"));
    const mediumBody = await (await authed("/stock/AAPL.US", tokenMedium)).text();
    expect(mediumBody).toContain('<span class="pill warn">中</span>');

    const { token: tokenLow } = seedMemberWithToken({ id: "m_low", email: "low@example.com" });
    writeStockAnalysisReport(repoRoot, "2026-07-14.md", NEW_FORMAT_AAPL_SECTION.replace("- 置信度：高", "- 置信度：低"));
    const lowBody = await (await authed("/stock/AAPL.US", tokenLow)).text();
    expect(lowBody).toContain('<span class="pill" style="background:var(--card2);color:var(--sub)">低</span>');
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

  it("我的论点卡 shows the viewer's own thesis and renders 暂无论点 when nobody has published one", async () => {
    const { token } = seedMemberWithToken();
    const response = await authed("/stock/NVDA.US", token);
    const body = await response.text();
    expect(body).toContain("暂无论点");
  });

  it("theses visibility: B's private (system) thesis is invisible to A; B's public thesis on the same symbol is visible to A", async () => {
    const { token: tokenA } = seedMemberWithToken({ id: "member_a", email: "a@example.com", displayName: "甲" });
    const memberB = makeMember({ id: "member_b", email: "b@example.com", displayName: "乙" });
    new MemberRepository(db).upsert(memberB);
    seedThesis(db, { ownerId: "member_b", symbol: "NVDA.US", visibility: "system", direction: "bear" });

    const privateResponse = await authed("/stock/NVDA.US", tokenA);
    const privateBody = await privateResponse.text();
    expect(privateBody).toContain("暂无论点"); // B's private thesis must not leak to A
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

  it("我的论点卡 renders bull_points/bear_points evidence and a judgment-history outcome annotation", async () => {
    const { member, token } = seedMemberWithToken();
    const thesisId = seedThesis(db, {
      ownerId: member.id,
      symbol: "NVDA.US",
      direction: "bull",
      targetHigh: 200,
      invalidationPrice: 100,
      bullPoints: ["算力需求旺盛"],
      bearPoints: ["估值偏高"]
    });
    seedThesisHistory(db, thesisId, "第一次判断", "self", "2026-07-05T00:00:00.000Z");
    seedStockFact(db, { symbol: "NVDA.US", tradingDay: "2026-07-13", valueNum: 180 });

    const response = await authed("/stock/NVDA.US", token);
    const body = await response.text();

    expect(body).toContain("算力需求旺盛");
    expect(body).toContain("估值偏高");
    expect(body).toContain("第一次判断");
    expect(body).toContain("样本不足"); // n=1 < 10
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
