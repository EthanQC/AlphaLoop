// Phase 8 Task 4 (2026-07-16 plan): research.ts's full rebuild - 进行中
// polling page, the 7-section 研判页 rendered from result_json, the failed
// failure-reason card, and the private-visibility label fix. Exercised
// through the real HTTP server (createPlatformServer), same convention as
// every other routes/*.test.ts file.
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApiTokenRepository,
  MemberRepository,
  ResearchTaskRepository,
  migrate,
  type Member,
  type ResearchResult
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

const FULL_RESULT_JSON: ResearchResult = {
  conclusion: "NVDA 短期承压，财报前建议观望。",
  confidence: "medium",
  keyPoints: [{ text: "算力需求依旧旺盛，但估值已充分反映", evidenceRefs: ["E1"] }],
  dataTable: [{ label: "NVDA.US 最新价", value: 180.5, source: "quote.last" }],
  comparison: {
    theses: [{ symbol: "NVDA.US", direction: "bull", ref: "thesis_1", verdict: "冲突", note: "最新价已跌破止损位 190" }],
    disciplines: [{ ruleId: "rule_1", ruleText: "单一标的仓位不超过 20%", verdict: "一致", note: "近 30 天全部遵守" }]
  },
  suggestedAction: "研判与已有论点存在冲突，建议先复核后再决策。",
  evidence: [{ ref: "E1", title: "NVDA 财报前瞻", url: "https://example.com/nvda-preview", publisher: "示例财经" }],
  skipped: [{ step: "拉取行情", reason: "跳过：未找到 TSLA.US 行情" }]
};

describe("research route (GET /research/<id>)", () => {
  let repoRoot: string;
  let db: DatabaseSync;
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;

  const NOW = () => new Date("2026-07-14T12:00:00.000Z");

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "platform-app-research-route-"));
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

  function createQueuedTask(ownerId: string, question = "NVDA财报前要减仓吗"): string {
    const repo = new ResearchTaskRepository(db);
    const result = repo.createIfWithinQuota({ ownerId, question, tradingDay: "2026-07-14" });
    if (!result.ok) throw new Error("test setup: quota unexpectedly exceeded");
    return result.task.id;
  }

  function finishTask(
    id: string,
    status: "done" | "degraded" | "failed",
    overrides: { resultJson?: ResearchResult; confidence?: ResearchResult["confidence"]; title?: string } = {}
  ): void {
    const repo = new ResearchTaskRepository(db);
    repo.setResult(id, {
      status,
      finishedAt: "2026-07-14T10:00:00.000Z",
      ...(overrides.resultJson !== undefined ? { resultJson: overrides.resultJson } : {}),
      ...(overrides.confidence !== undefined ? { confidence: overrides.confidence } : {}),
      ...(overrides.title !== undefined ? { title: overrides.title } : {})
    });
  }

  it("returns 401 without any identity", async () => {
    const response = await fetch(`${baseUrl}/research/does-not-exist`);
    expect(response.status).toBe(401);
  });

  it("returns 404 for an id that doesn't exist", async () => {
    const { token } = seedMemberWithToken();
    const response = await authed("/research/no-such-id", token);
    expect(response.status).toBe(404);
  });

  it("resolves the row BEFORE the ownership check: a non-existent id 404s even for a member who owns nothing", async () => {
    const { token } = seedMemberWithToken();
    const response = await authed("/research/still-does-not-exist", token);
    expect(response.status).toBe(404);
  });

  describe("进行中 (queued/running)", () => {
    it("owner sees the step stream, the reload notice, and a nonce'd polling script - for queued", async () => {
      const { member, token } = seedMemberWithToken();
      const id = createQueuedTask(member.id);
      new ResearchTaskRepository(db).appendStep(id, { name: "意图解析", status: "done", detail: "识别标的：NVDA.US；主题：财报前减仓", at: "2026-07-14T09:00:00.000Z" });
      new ResearchTaskRepository(db).appendStep(id, { name: "拉取行情", status: "skipped", detail: "跳过：未找到 TSLA.US 行情", at: "2026-07-14T09:00:01.000Z" });

      const response = await authed(`/research/${id}`, token);
      expect(response.status).toBe(200);
      const body = await response.text();

      expect(body).toContain("排队中");
      expect(body).toContain("意图解析");
      expect(body).toContain("识别标的：NVDA.US；主题：财报前减仓");
      expect(body).toContain("跳过：未找到 TSLA.US 行情");
      expect(body).toContain("调研进行中，本页每 3 秒自动刷新（可关闭页面，完成后飞书通知）");

      const csp = response.headers.get("content-security-policy") ?? "";
      const nonceMatch = /nonce-([^']+)/u.exec(csp);
      expect(nonceMatch).not.toBeNull();
      const nonce = nonceMatch?.[1] ?? "";
      // Two nonce'd scripts on this page (theme init + polling), BOTH must
      // carry the SAME per-response nonce.
      const scriptTagCount = (body.match(new RegExp(`<script nonce="${nonce}">`, "gu")) ?? []).length;
      expect(scriptTagCount).toBe(2);
      expect(body).toContain(`setTimeout(function(){location.reload();},3000);`);
    });

    it("shows 暂无步骤记录 when no steps have been recorded yet", async () => {
      const { member, token } = seedMemberWithToken();
      const id = createQueuedTask(member.id);
      const response = await authed(`/research/${id}`, token);
      const body = await response.text();
      expect(body).toContain("暂无步骤记录");
    });

    it("running status renders 进行中 label and still polls", async () => {
      const { member, token } = seedMemberWithToken();
      const id = createQueuedTask(member.id);
      db.prepare(`UPDATE research_tasks SET status = 'running' WHERE id = ?`).run(id);

      const response = await authed(`/research/${id}`, token);
      const body = await response.text();
      expect(body).toContain("进行中");
      expect(body).toContain("location.reload()");
    });
  });

  describe("研判页 (done/degraded, from result_json)", () => {
    it("renders all 7 sections for a done task", async () => {
      const { member, token } = seedMemberWithToken();
      const id = createQueuedTask(member.id, "NVDA财报前要减仓吗");
      finishTask(id, "done", { resultJson: FULL_RESULT_JSON, confidence: "medium", title: "NVDA财报前要减仓吗" });

      const response = await authed(`/research/${id}`, token);
      expect(response.status).toBe(200);
      const body = await response.text();

      // ① 核心结论卡
      expect(body).toContain("NVDA 短期承压，财报前建议观望。");
      expect(body).toContain("中"); // CONFIDENCE_LABELS.medium
      expect(body).toContain("截至");
      expect(body).toContain("2026-07-14 18:00"); // finishedAt in Beijing time

      // ② 关键要点 (with evidence 角标)
      expect(body).toContain("算力需求依旧旺盛，但估值已充分反映");
      expect(body).toContain("E1");

      // ③ 数据表
      expect(body).toContain("NVDA.US 最新价");
      expect(body).toContain("180.5");
      expect(body).toContain("quote.last");

      // ④ 与我的论点/纪律对照 (一致/冲突 explicit)
      expect(body).toContain("冲突");
      expect(body).toContain("最新价已跌破止损位 190");
      expect(body).toContain("单一标的仓位不超过 20%");
      expect(body).toContain("一致");

      // ⑤ 建议动作 + 模拟盘语境 disclaimer
      expect(body).toContain("研判与已有论点存在冲突，建议先复核后再决策。");
      expect(body).toContain("不构成投资建议，模拟盘语境");

      // ⑥ 证据链 (clickable, rel=noreferrer)
      expect(body).toContain('<a href="https://example.com/nvda-preview" rel="noreferrer" target="_blank"');
      expect(body).toContain("示例财经");

      // ⑦ 调研过程 (<details> + skipped items)
      expect(body).toContain("<details>");
      expect(body).toContain("跳过：未找到 TSLA.US 行情");

      expect(body).not.toContain("研究执行 P8 上线"); // old placeholder must be gone
    });

    it("degraded shows the amber banner in addition to the (still real) verdict", async () => {
      const { member, token } = seedMemberWithToken();
      const id = createQueuedTask(member.id);
      finishTask(id, "degraded", { resultJson: FULL_RESULT_JSON, confidence: "medium" });

      const response = await authed(`/research/${id}`, token);
      const body = await response.text();

      expect(body).toContain("降级：已收集材料，研判未完成");
      expect(body).toContain("NVDA 短期承压，财报前建议观望。"); // verdict still rendered
    });

    it("a done task with no evidence/comparison renders honest empty states, never fabricated content", async () => {
      const { member, token } = seedMemberWithToken();
      const id = createQueuedTask(member.id);
      const emptyResult: ResearchResult = {
        conclusion: "问题未提及可识别的标的，本次研判仅能给出方向性参考。",
        confidence: "low",
        keyPoints: [],
        dataTable: [],
        comparison: { theses: [], disciplines: [] },
        suggestedAction: "现有证据不足，建议补充自选标的或等待更多数据后再次研究。",
        evidence: [],
        skipped: []
      };
      finishTask(id, "done", { resultJson: emptyResult, confidence: "low" });

      const response = await authed(`/research/${id}`, token);
      const body = await response.text();
      expect(body).toContain("低");
      expect(body).toContain("暂无关键要点");
      expect(body).toContain("暂无数据");
      expect(body).toContain("暂无可对照的论点或纪律");
      expect(body).toContain("暂无证据");
      expect(body).toContain("无跳过项");
    });
  });

  describe("失败 (failed)", () => {
    it("renders a failure-reason card derived from the last recorded step (result_json is null)", async () => {
      const { member, token } = seedMemberWithToken();
      const id = createQueuedTask(member.id, "帮我把这条规则改一下");
      new ResearchTaskRepository(db).appendStep(id, {
        name: "意图解析",
        status: "done",
        detail: "识别为操作类意图（命中关键词「改规则」），不进入研究管线",
        at: "2026-07-14T09:00:00.000Z"
      });
      finishTask(id, "failed");

      const response = await authed(`/research/${id}`, token);
      expect(response.status).toBe(200);
      const body = await response.text();

      expect(body).toContain("失败原因");
      expect(body).toContain("识别为操作类意图（命中关键词「改规则」），不进入研究管线");
      expect(body).not.toContain("核心结论");
      // Failed pages are static - no polling script.
      expect(body).not.toContain("location.reload()");
    });

    it("falls back to a generic reason when no steps were recorded at all", async () => {
      const { member, token } = seedMemberWithToken();
      const id = createQueuedTask(member.id);
      finishTask(id, "failed");

      const response = await authed(`/research/${id}`, token);
      const body = await response.text();
      expect(body).toContain("失败原因");
      expect(body).toContain("未记录具体原因");
    });
  });

  describe("visibility label (private-label bug fix)", () => {
    it("private task (owner view): shows 仅本人可见, never the old 系统可用 bug", async () => {
      const { member, token } = seedMemberWithToken();
      const id = createQueuedTask(member.id);
      const response = await authed(`/research/${id}`, token);
      const body = await response.text();
      expect(body).toContain("仅本人可见");
      expect(body).not.toContain("系统可用");
    });

    it("public task: shows 公开", async () => {
      const { member, token } = seedMemberWithToken();
      const id = createQueuedTask(member.id);
      new ResearchTaskRepository(db).promoteVisibility(id, member.id);

      const response = await authed(`/research/${id}`, token);
      const body = await response.text();
      expect(body).toContain("公开");
    });
  });

  describe("ownership/visibility gate", () => {
    it("private research: non-owner gets 403 (distinct from 404)", async () => {
      const memberA = makeMember({ id: "member_a", email: "a@example.com" });
      new MemberRepository(db).upsert(memberA);
      const id = createQueuedTask("member_a");

      const { token: tokenB } = seedMemberWithToken({ id: "member_b", email: "b@example.com" });
      const response = await authed(`/research/${id}`, tokenB);
      expect(response.status).toBe(403);
      const body = await response.text();
      expect(body).toContain("403 无权访问");
    });

    it("public research: non-owner CAN view it (200), unlike private", async () => {
      const memberA = makeMember({ id: "member_a", email: "a@example.com" });
      new MemberRepository(db).upsert(memberA);
      const id = createQueuedTask("member_a", "公开研判问题");
      new ResearchTaskRepository(db).promoteVisibility(id, "member_a");

      const { token: tokenB } = seedMemberWithToken({ id: "member_b", email: "b@example.com" });
      const response = await authed(`/research/${id}`, tokenB);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("公开研判问题");
    });
  });

  it("carries the CSP nonce and makes no third-party requests", async () => {
    const { member, token } = seedMemberWithToken();
    const id = createQueuedTask(member.id);
    const response = await authed(`/research/${id}`, token);
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonceMatch = /nonce-([^']+)/u.exec(csp);
    expect(nonceMatch).not.toBeNull();
    const body = await response.text();
    expect(body).toContain(`nonce="${nonceMatch?.[1]}"`);
    expect(body).not.toMatch(/https?:\/\//iu);
  });
});
