import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApiTokenRepository,
  CircuitBreakerRepository,
  MemberRepository,
  MonthlyReviewRepository,
  createId,
  migrate,
  type Member
} from "@packages/shared-types";

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
      "我的模拟盘概览",
      "还没有你的模拟盘快照，所以这里不显示净值和今日涨跌。",
      "我的待办",
      "当前没有等你审批的提案。",
      "我的提醒流水",
      // Task 22: the empty state now NAMES the session it is talking about.
      // The clock is 2026-07-14 08:00 EDT (before the open), so the most
      // recent session is Monday 2026-07-13's.
      "最近一个美股交易时段（2026-07-13 美东时段）你没有触发过提醒。",
      "今日日报卡",
      "还没有可读的日报。",
      "纪律速览",
      "你还没有登记任何纪律规则。",
      "复盘速览",
      "还没有你的月度复盘。"
    ];

    let cursor = -1;
    for (const marker of expectedOrder) {
      expect(body).toContain(marker);
      const index = body.indexOf(marker);
      expect(index).toBeGreaterThan(cursor);
      cursor = index;
    }
  });

  it("renders a real question-box form posting to /api/research (Phase 8 Task 4 - no longer disabled)", async () => {
    const { token } = seedMemberWithToken();
    const response = await authed("/", token);
    const body = await response.text();
    expect(body).toMatch(/<form method="post" action="\/api\/research">/u);
    expect(body).toMatch(/<input[^>]*name="question"[^>]*>/u);
    expect(body).not.toMatch(/<input[^>]*disabled[^>]*>/u);
    expect(body).toMatch(/<button[^>]*type="submit"[^>]*>开始研究<\/button>/u);
    expect(body).not.toContain("站内研究 P8 上线");
  });

  it("renders real snapshot net assets and today's change when both today's and yesterday's snapshots exist", async () => {
    const { member, token } = seedMemberWithToken();
    seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-13T05:00:00.000Z", netAssets: 1000 });
    seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-14T11:30:00.000Z", netAssets: 1100 });

    const response = await authed("/", token);
    const body = await response.text();

    expect(body).toContain("1,100.00 美元");
    expect(body).toContain("+10.00%");
    expect(body).not.toContain("还没有你的模拟盘快照");
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
      // Inside the most recent session as of the fixed clock: 2026-07-13
      // 10:10 EDT, i.e. 07-13 22:10 Beijing.
      triggeredAt: "2026-07-13T14:10:00.000Z",
      value: -4.3
    });

    const response = await authed("/", token);
    const body = await response.text();

    expect(body).toContain("NVDA.US");
    expect(body).toContain("日内波动");
    expect(body).toContain("-4.3");
    expect(body).toContain("07-13 22:10"); // Beijing time
    expect(body).not.toContain("你没有触发过提醒。");
  });

  it("two-member isolation: member A's alert events never appear on member B's home page", async () => {
    const { member: memberA } = seedMemberWithToken({ id: "member_a", email: "a@example.com" });
    seedAlertRuleAndEvent(db, {
      ownerId: memberA.id,
      symbol: "NVDA.US",
      ruleType: "daily_move",
      triggeredAt: "2026-07-13T14:10:00.000Z",
      value: -4.3
    });

    const memberB = makeMember({ id: "member_b", email: "b@example.com" });
    new MemberRepository(db).upsert(memberB);
    const tokenB = new ApiTokenRepository(db).issue(memberB.id, "test").token;

    const response = await authed("/", tokenB);
    const body = await response.text();

    expect(body).not.toContain("NVDA.US");
    expect(body).toContain("最近一个美股交易时段（2026-07-13 美东时段）你没有触发过提醒。");
  });

  it("renders the latest daily report as a link, with a legacy pill (every current report is legacy)", async () => {
    const { token } = seedMemberWithToken();
    writeDailyReport(repoRoot, "2026-07-14.md", "# 今日日报标题\n\n内容。\n");

    const response = await authed("/", token);
    const body = await response.text();

    expect(body).toContain("今日日报标题");
    expect(body).toContain('href="/daily/2026-07-14"');
    expect(body).toContain("历史存档");
    expect(body).not.toContain("还没有可读的日报。");
  });

  // Task 6 (2026-07-28): the daily card is the home page's entry point to the
  // viewer's own personal page (owner-only route, no owner id in the URL -
  // it always resolves to whoever is logged in).
  it("puts a 我的个人页 entry on the daily card, linking to /daily/<date>/me with no owner id in the URL", async () => {
    const { token } = seedMemberWithToken();
    writeDailyReport(repoRoot, "2026-07-14.md", "# 今日日报标题\n\n内容。\n");

    const response = await authed("/", token);
    const body = await response.text();

    expect(body).toContain("我的个人页");
    expect(body).toContain('href="/daily/2026-07-14/me"');
    expect(body).not.toContain("/me?owner=");
  });

  it("omits the 我的个人页 entry when there is no daily report to hang it on", async () => {
    const { token } = seedMemberWithToken();
    const response = await authed("/", token);
    const body = await response.text();
    expect(body).toContain("还没有可读的日报。");
    expect(body).not.toContain("我的个人页");
  });

  describe("circuit breaker banner (Phase 6 Task 6)", () => {
    it("omits the banner entirely when the viewer is not paused", async () => {
      const { token } = seedMemberWithToken();
      const response = await authed("/", token);
      const body = await response.text();
      expect(body).not.toContain("熔断暂停中");
    });

    it("shows the amber banner with the recovery time, positioned before block ①开始研究, when the viewer IS paused", async () => {
      const { member, token } = seedMemberWithToken();
      new CircuitBreakerRepository(db).trip(member.id, {
        pausedUntil: "2026-07-21T12:00:00.000Z",
        reason: "本交易周亏损 3.50%，超过熔断阈值 -3%",
        weeklyLossPct: -3.5
      });

      const response = await authed("/", token);
      const body = await response.text();

      expect(body).toContain("⛔ 熔断暂停中");
      expect(body).toContain("熔断暂停中，至");
      expect(body).toContain("2026-07-21T12:00:00.000Z");
      expect(body).toContain("不再生成新提案");

      const bannerIndex = body.indexOf("熔断暂停中，至");
      const startResearchIndex = body.indexOf("开始研究");
      expect(bannerIndex).toBeGreaterThan(-1);
      expect(startResearchIndex).toBeGreaterThan(-1);
      expect(bannerIndex).toBeLessThan(startResearchIndex);
    });

    it("does not show a banner once the pause has expired (now >= pausedUntil)", async () => {
      const { member, token } = seedMemberWithToken();
      new CircuitBreakerRepository(db).trip(member.id, {
        pausedUntil: "2026-07-01T00:00:00.000Z", // well before NOW (2026-07-14T12:00:00.000Z)
        reason: "expired trip",
        weeklyLossPct: -4
      });

      const response = await authed("/", token);
      const body = await response.text();
      expect(body).not.toContain("熔断暂停中");
    });

    it("member isolation: member A's pause never shows on member B's home page", async () => {
      const { member: memberA } = seedMemberWithToken({ id: "member_a", email: "a@example.com" });
      new CircuitBreakerRepository(db).trip(memberA.id, {
        pausedUntil: "2026-07-21T12:00:00.000Z",
        reason: "member A tripped",
        weeklyLossPct: -5
      });

      const memberB = makeMember({ id: "member_b", email: "b@example.com" });
      new MemberRepository(db).upsert(memberB);
      const tokenB = new ApiTokenRepository(db).issue(memberB.id, "test").token;

      const response = await authed("/", tokenB);
      const body = await response.text();
      expect(body).not.toContain("熔断暂停中");
    });
  });

  // Phase 9 Task 4 (2026-07-16 plan): ⑦ 复盘速览 - most recent review,
  // period + status + link, or the auto-generation empty state.
  describe("⑦ 复盘速览", () => {
    function seedMinimalReview(ownerId: string, period: string, opts: { confirm?: boolean } = {}): string {
      const repo = new MonthlyReviewRepository(db);
      const review = repo.upsertDraft({
        ownerId,
        period,
        resultJson: {
          ownerId,
          period,
          generatedAt: "2026-07-14T00:00:00.000Z",
          predictionReview: {
            selfThesisHitRate: { sample: "insufficient", n: 0 },
            systemConfidenceCalibration: [],
            systemConfidenceCalibrationNote: "系统个股分析置信度校准——全平台口径，非本人专属"
          },
          decisionReview: {
            period,
            periodStart: "2026-07-01T00:00:00.000Z",
            periodEnd: "2026-08-01T00:00:00.000Z",
            benchmarkSymbol: "QQQ",
            executed: { sample: "none", n: 0, priced: 0, entries: [] },
            rejected: { sample: "none", n: 0, disclaimer: "未执行，仅口径参考", entries: [] }
          },
          disciplineReview: {
            complianceRate: { sample: "none" },
            complianceValue: { compliant: { sample: "none", n: 0 }, violating: { sample: "none", n: 0 }, deltaPct: null }
          },
          alertQuality: { sample: "none", triggeredCount: 0, misreportCount: 0, misreportRate: null },
          errorCategories: [],
          oneLineLesson: "本月各项指标样本不足或表现正常，暂无可归纳的一句话教训。",
          nextSteps: ["暂无下一步动作建议——数据不足或本月各项指标均在正常范围内。"],
          improvementSuggestions: {
            disclaimer: "以上为规则推导的改进建议，仅供参考；任何策略/纪律变更须本人在飞书或 CLI 中手动确认后生效。",
            items: []
          }
        }
      });
      if (opts.confirm) {
        repo.confirm(review.id, ownerId);
      }
      return review.id;
    }

    it("shows the most recent (highest period) review with its 草稿 status and a working link", async () => {
      const { member, token } = seedMemberWithToken();
      seedMinimalReview(member.id, "2026-05");
      const latestId = seedMinimalReview(member.id, "2026-06");

      const response = await authed("/", token);
      const body = await response.text();

      expect(body).toContain("2026-06");
      expect(body).toContain(`href="/review/${latestId}"`);
    });

    it("shows 已确认 status for a confirmed review", async () => {
      const { member, token } = seedMemberWithToken();
      seedMinimalReview(member.id, "2026-06", { confirm: true });

      const response = await authed("/", token);
      const body = await response.text();

      const reviewBlockIndex = body.indexOf("复盘速览");
      expect(reviewBlockIndex).toBeGreaterThan(-1);
      expect(body.slice(reviewBlockIndex, reviewBlockIndex + 400)).toContain("已确认");
    });

    it("owner isolation: member B's home page never shows member A's review", async () => {
      const { member: memberA } = seedMemberWithToken({ id: "member_a", email: "a@example.com" });
      seedMinimalReview(memberA.id, "2026-06");

      const memberB = makeMember({ id: "member_b", email: "b@example.com" });
      new MemberRepository(db).upsert(memberB);
      const tokenB = new ApiTokenRepository(db).issue(memberB.id, "test").token;

      const response = await authed("/", tokenB);
      const body = await response.text();
      expect(body).not.toContain("2026-06");
      expect(body).toContain("还没有你的月度复盘。");
    });
  });

  // -------------------------------------------------------------------------
  // ⑥ 纪律速览 (req §1.2) - Task 11, 2026-07-30. This block used to list the
  // rule text and nothing else; the compliance half of req §1.2 ("近 30 天
  // 遵守情况" / "已连续遵守 N 天") was the 「策略记忆 P7 上线」 placeholder.
  // -------------------------------------------------------------------------

  describe("⑥ 纪律速览: real compliance, or an honest reason there is none", () => {
    function seedRule(ownerId: string, ruleText: string, enforcement = "proposal_check"): string {
      const id = createId("rule");
      db.prepare(`
        INSERT INTO discipline_rules (id, owner_id, rule_text, enforcement, enabled, created_at)
        VALUES (?, ?, ?, ?, 1, '2026-07-01T00:00:00.000Z')
      `).run(id, ownerId, ruleText, enforcement);
      return id;
    }

    function seedProposalWithChecks(ownerId: string, createdAt: string, report: unknown[]): void {
      db.prepare(`
        INSERT INTO proposals (id, owner_id, symbol, side, quantity, order_type, reason, discipline_report, status, created_at, expires_at)
        VALUES (?, ?, 'NVDA.US', 'buy', 1, 'limit', 'test', ?, 'pending', ?, ?)
      `).run(createId("proposal"), ownerId, JSON.stringify(report), createdAt, createdAt);
    }

    function disciplineBlock(body: string): string {
      const start = body.indexOf("纪律速览");
      return start < 0 ? "" : body.slice(start, start + 1600);
    }

    it("renders each rule's REAL 近30天 tally, never a P7 placeholder", async () => {
      const { member, token } = seedMemberWithToken();
      const ruleId = seedRule(member.id, "财报周不加仓");
      seedProposalWithChecks(member.id, "2026-07-10T00:00:00.000Z", [{ ruleId, pass: true }]);
      seedProposalWithChecks(member.id, "2026-07-11T00:00:00.000Z", [{ ruleId, pass: true }]);
      seedProposalWithChecks(member.id, "2026-07-12T00:00:00.000Z", [{ ruleId, pass: false }]);

      const block = disciplineBlock(await (await authed("/", token)).text());

      expect(block).toContain("财报周不加仓");
      expect(block).toContain("近30天 3 次检查，遵守 2 / 违反 1");
      expect(block).not.toContain("P7 上线");
    });

    it("says a rule has no sample rather than printing 0 次 for it", async () => {
      const { member, token } = seedMemberWithToken();
      seedRule(member.id, "单票不超过 20%");

      const block = disciplineBlock(await (await authed("/", token)).text());

      expect(block).toContain("近30天无相关提案");
      expect(block).not.toContain("近30天 0 次检查");
    });

    it("states 已连续遵守 N 天 counted from the owner's most recent real violation", async () => {
      const { member, token } = seedMemberWithToken();
      const ruleId = seedRule(member.id, "财报周不加仓");
      seedProposalWithChecks(member.id, "2026-07-04T12:00:00.000Z", [{ ruleId, pass: false }]);
      seedProposalWithChecks(member.id, "2026-07-12T00:00:00.000Z", [{ ruleId, pass: true }]);

      const block = disciplineBlock(await (await authed("/", token)).text());

      expect(block).toContain("已连续遵守 10 天");
    });

    it("with no violation on record, states a LOWER BOUND instead of an invented streak", async () => {
      const { member, token } = seedMemberWithToken();
      const ruleId = seedRule(member.id, "财报周不加仓");
      seedProposalWithChecks(member.id, "2026-07-09T12:00:00.000Z", [{ ruleId, pass: true }]);

      const block = disciplineBlock(await (await authed("/", token)).text());

      expect(block).toContain("已连续遵守至少 5 天");
      expect(block).toContain("1 次检查");
    });

    it("with no completed check at all, says so instead of claiming a streak", async () => {
      const { member, token } = seedMemberWithToken();
      seedRule(member.id, "财报周不加仓");

      const block = disciplineBlock(await (await authed("/", token)).text());

      expect(block).toContain("还没有提案触发过纪律检查");
      expect(block).not.toContain("已连续遵守");
    });

    it("another member's violation never shortens this member's streak", async () => {
      const { member, token } = seedMemberWithToken();
      const ruleId = seedRule(member.id, "财报周不加仓");
      seedProposalWithChecks(member.id, "2026-07-09T12:00:00.000Z", [{ ruleId, pass: true }]);

      const other = makeMember({ id: "member_other", email: "other@example.com" });
      new MemberRepository(db).upsert(other);
      seedProposalWithChecks(other.id, "2026-07-13T00:00:00.000Z", [{ ruleId: "rule_x", pass: false }]);

      const block = disciplineBlock(await (await authed("/", token)).text());

      expect(block).toContain("已连续遵守至少 5 天");
    });
  });

  // -------------------------------------------------------------------------
  // Task 22 (req §1.1/§1.2), 2026-07-30: 最近研判入口 / 净值 sparkline /
  // 提醒流水按最近一个交易时段过滤 / 纪律速览情境匹配.
  // -------------------------------------------------------------------------

  describe("Task 22: 最近研判入口", () => {
    function seedResearch(
      ownerId: string,
      opts: { id?: string; question: string; status: string; createdAt: string; title?: string }
    ): string {
      const id = opts.id ?? createId("research");
      db.prepare(`
        INSERT INTO research_tasks (id, owner_id, question, status, steps, budget_spent, title, visibility, created_at)
        VALUES (?, ?, ?, ?, '[]', 0, ?, 'private', ?)
      `).run(id, ownerId, opts.question, opts.status, opts.title ?? null, opts.createdAt);
      return id;
    }

    it("lists the viewer's most recent research tasks with a link to each", async () => {
      const { member, token } = seedMemberWithToken();
      const id = seedResearch(member.id, {
        question: "NVDA 财报前要减仓吗",
        status: "done",
        createdAt: "2026-07-14T09:00:00.000Z"
      });

      const body = await (await authed("/", token)).text();

      expect(body).toContain("最近研判");
      expect(body).toContain(`href="/research/${id}"`);
      expect(body).toContain("NVDA 财报前要减仓吗");
      expect(body).toContain("已完成");
    });

    it("includes a RUNNING task, which the /reports 研判 chip does not list", async () => {
      const { member, token } = seedMemberWithToken();
      seedResearch(member.id, {
        question: "TSLA 的止损位定在哪",
        status: "running",
        createdAt: "2026-07-14T09:30:00.000Z"
      });

      const body = await (await authed("/", token)).text();

      expect(body).toContain("TSLA 的止损位定在哪");
      expect(body).toContain("进行中");
    });

    it("shows no 最近研判 section at all when the viewer has never asked anything", async () => {
      const { token } = seedMemberWithToken();
      const body = await (await authed("/", token)).text();
      expect(body).not.toContain("最近研判");
    });

    it("never shows another member's research", async () => {
      const { member: memberA } = seedMemberWithToken({ id: "member_a", email: "a@example.com" });
      seedResearch(memberA.id, {
        question: "A 的私密问题",
        status: "done",
        createdAt: "2026-07-14T09:00:00.000Z"
      });

      const memberB = makeMember({ id: "member_b", email: "b@example.com" });
      new MemberRepository(db).upsert(memberB);
      const tokenB = new ApiTokenRepository(db).issue(memberB.id, "test").token;

      const body = await (await authed("/", tokenB)).text();

      expect(body).not.toContain("A 的私密问题");
      expect(body).not.toContain("最近研判");
    });
  });

  describe("Task 22: 净值 sparkline", () => {
    it("draws a polyline over the owner's real net-asset points", async () => {
      const { member, token } = seedMemberWithToken();
      seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-12T05:00:00.000Z", netAssets: 1000 });
      seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-13T05:00:00.000Z", netAssets: 1050 });
      seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-14T11:30:00.000Z", netAssets: 1100 });

      const body = await (await authed("/", token)).text();

      expect(body).toContain("<polyline");
      expect(body).toContain('aria-label="最近 3 个快照的净值走势"');
      // Rising series: first point at the bottom of the box, last at the top.
      expect(body).toContain('points="0.00,27.00 50.00,14.00 100.00,1.00"');
    });

    it("says so in words rather than drawing a flat line from a single point", async () => {
      const { member, token } = seedMemberWithToken();
      seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-14T11:30:00.000Z", netAssets: 1100 });

      const body = await (await authed("/", token)).text();

      expect(body).not.toContain("<polyline");
      expect(body).toContain("净值走势图需要至少 2 个有净值的快照，当前只有 1 个。");
    });

    it("skips a null-net-assets snapshot instead of plotting it at zero", async () => {
      const { member, token } = seedMemberWithToken();
      seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-12T05:00:00.000Z", netAssets: 1000 });
      seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-13T05:00:00.000Z", netAssets: null });
      seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-14T11:30:00.000Z", netAssets: 1100 });

      const body = await (await authed("/", token)).text();

      expect(body).toContain('aria-label="最近 2 个快照的净值走势"');
      expect(body).toContain('points="0.00,27.00 100.00,1.00"');
    });

    it("offers the 对比入口 to the paper page", async () => {
      const { token } = seedMemberWithToken();
      const body = await (await authed("/", token)).text();
      expect(body).toContain('href="/paper"');
    });
  });

  describe("Task 22: 提醒流水按最近一个美股交易时段过滤", () => {
    // Fixed clock is 2026-07-14T12:00:00Z = Tuesday 08:00 EDT, BEFORE the
    // open - so the most recent session is Monday 2026-07-13,
    // [13:30Z, 20:00Z).
    it("names the session it is showing in the block header", async () => {
      const { token } = seedMemberWithToken();
      const body = await (await authed("/", token)).text();
      expect(body).toContain("我的提醒流水");
      expect(body).toContain("2026-07-13 美东时段");
    });

    it("EXCLUDES an alert from the session before the most recent one", async () => {
      const { member, token } = seedMemberWithToken();
      seedAlertRuleAndEvent(db, {
        ownerId: member.id,
        symbol: "OLDSESSION.US",
        ruleType: "daily_move",
        triggeredAt: "2026-07-10T15:00:00.000Z", // Friday's session
        value: -0.043
      });

      const body = await (await authed("/", token)).text();

      // The defect this pins: before Task 22 this row rendered under a header
      // claiming it came from the most recent session.
      expect(body).not.toContain("OLDSESSION.US");
      expect(body).toContain("最近一个美股交易时段（2026-07-13 美东时段）你没有触发过提醒。");
    });

    it("EXCLUDES an alert stamped after the session close", async () => {
      const { member, token } = seedMemberWithToken();
      seedAlertRuleAndEvent(db, {
        ownerId: member.id,
        symbol: "AFTERHOURS.US",
        ruleType: "daily_move",
        triggeredAt: "2026-07-13T20:30:00.000Z", // 16:30 EDT, after the close
        value: -0.02
      });

      const body = await (await authed("/", token)).text();

      expect(body).not.toContain("AFTERHOURS.US");
    });

    it("INCLUDES an alert from inside the session window", async () => {
      const { member, token } = seedMemberWithToken();
      seedAlertRuleAndEvent(db, {
        ownerId: member.id,
        symbol: "INSESSION.US",
        ruleType: "daily_move",
        triggeredAt: "2026-07-13T13:30:00.000Z", // exactly at the open - inclusive bound
        value: -0.031
      });

      const body = await (await authed("/", token)).text();

      expect(body).toContain("INSESSION.US");
    });
  });

  describe("Task 22: 纪律速览情境匹配", () => {
    function seedRule(ownerId: string, ruleText: string): string {
      const id = createId("rule");
      db.prepare(`
        INSERT INTO discipline_rules (id, owner_id, rule_text, enforcement, enabled, created_at)
        VALUES (?, ?, ?, 'proposal_check', 1, '2026-07-01T00:00:00.000Z')
      `).run(id, ownerId, ruleText);
      return id;
    }

    it("pins the 熔断-related rule and states the measured weekly loss when the week is near -3%", async () => {
      const { member, token } = seedMemberWithToken();
      seedRule(member.id, "财报周不加仓");
      seedRule(member.id, "周亏超过 2% 就停手");
      // Week starts Monday 2026-07-13 04:00Z. Baseline = the last pre-week
      // snapshot; latest = 2.6% below it.
      seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-10T20:00:00.000Z", netAssets: 100_000 });
      seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-14T11:30:00.000Z", netAssets: 97_400 });

      const body = await (await authed("/", token)).text();
      const block = body.slice(body.indexOf("纪律速览"));

      expect(block).toContain("本交易周净值 -2.60%，正在接近 -3.00% 熔断线。");
      // The matched rule is pinned ABOVE the unrelated one.
      expect(block.indexOf("周亏超过 2% 就停手")).toBeLessThan(block.indexOf("财报周不加仓"));
      expect(block).toContain("当前相关");
    });

    it("says nothing about the weekly loss when the week is comfortably flat", async () => {
      const { member, token } = seedMemberWithToken();
      seedRule(member.id, "周亏超过 2% 就停手");
      seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-10T20:00:00.000Z", netAssets: 100_000 });
      seedSnapshot(db, { ownerId: member.id, fetchedAt: "2026-07-14T11:30:00.000Z", netAssets: 99_900 });

      const body = await (await authed("/", token)).text();

      expect(body).not.toContain("熔断线");
      expect(body).not.toContain("当前相关");
    });

    it("pins the 仓位 rule and states measured exposure when it nears the 10% budget", async () => {
      const { member, token } = seedMemberWithToken();
      seedRule(member.id, "财报周不加仓");
      seedRule(member.id, "单票仓位≤20%");
      db.prepare(`
        INSERT INTO official_paper_snapshots (id, fetched_at, reason, net_assets, total_cash, market_value, positions, raw, owner_id)
        VALUES (?, '2026-07-14T11:30:00.000Z', 'hourly_poll', 100000, NULL, 9000, '[]', '{}', ?)
      `).run(createId("snapshot"), member.id);

      const body = await (await authed("/", token)).text();
      const block = body.slice(body.indexOf("纪律速览"));

      expect(block).toContain("当前持仓敞口 9.00%，接近 10.00% 模拟盘预算上限。");
      expect(block.indexOf("单票仓位≤20%")).toBeLessThan(block.indexOf("财报周不加仓"));
    });

    it("discloses that 临近财报 cannot be evaluated when the member keeps an earnings rule", async () => {
      const { member, token } = seedMemberWithToken();
      seedRule(member.id, "财报周不加仓");

      const body = await (await authed("/", token)).text();

      expect(body).toContain("临近财报暂时无法判定");
      expect(body).toContain("earnings.nextDate");
    });

    it("does not print the 财报 disclosure to a member with no earnings rule", async () => {
      const { member, token } = seedMemberWithToken();
      seedRule(member.id, "单票仓位≤20%");

      const body = await (await authed("/", token)).text();

      expect(body).not.toContain("临近财报暂时无法判定");
    });

    it("keeps the streak line and every rule when no context matches", async () => {
      const { member, token } = seedMemberWithToken();
      seedRule(member.id, "单票仓位≤20%");

      const body = await (await authed("/", token)).text();
      const block = body.slice(body.indexOf("纪律速览"));

      expect(block).toContain("单票仓位≤20%");
      expect(block).not.toContain("当前相关");
      expect(block).toContain("还没有提案触发过纪律检查");
    });
  });
});
