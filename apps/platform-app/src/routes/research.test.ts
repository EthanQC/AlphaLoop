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

interface SeedResearchOpts {
  id?: string;
  ownerId: string;
  question?: string;
  status?: string;
  steps?: unknown;
  resultPath?: string | null;
  visibility?: "private" | "public";
  createdAt?: string;
  finishedAt?: string | null;
}

function seedResearchTask(db: DatabaseSync, opts: SeedResearchOpts): string {
  const id = opts.id ?? createId("research");
  db.prepare(`
    INSERT INTO research_tasks (id, owner_id, question, status, steps, result_path, visibility, created_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.ownerId,
    opts.question ?? "NVDA财报前要减仓吗",
    opts.status ?? "done",
    JSON.stringify(opts.steps ?? ["拉取财报数据", "对照我的论点"]),
    opts.resultPath ?? null,
    opts.visibility ?? "private",
    opts.createdAt ?? "2026-07-10T00:00:00.000Z",
    opts.finishedAt ?? null
  );
  return id;
}

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

  it("returns 401 without any identity", async () => {
    const response = await fetch(`${baseUrl}/research/does-not-exist`);
    expect(response.status).toBe(401);
  });

  it("returns 404 for an id that doesn't exist", async () => {
    const { token } = seedMemberWithToken();
    const response = await authed("/research/no-such-id", token);
    expect(response.status).toBe(404);
  });

  it("owner sees 200 with question/status/steps timeline/result placeholder", async () => {
    const { member, token } = seedMemberWithToken();
    const id = seedResearchTask(db, {
      ownerId: member.id,
      question: "NVDA财报前要减仓吗",
      status: "done",
      steps: ["拉取财报数据", "对照我的论点"],
      visibility: "private"
    });

    const response = await authed(`/research/${id}`, token);
    expect(response.status).toBe(200);
    const body = await response.text();

    expect(body).toContain("NVDA财报前要减仓吗");
    expect(body).toContain("已完成");
    expect(body).toContain("拉取财报数据");
    expect(body).toContain("对照我的论点");
    expect(body).toContain("研究执行 P8 上线");
  });

  it("private research: non-owner gets 403 (distinct from 404)", async () => {
    const memberA = makeMember({ id: "member_a", email: "a@example.com" });
    new MemberRepository(db).upsert(memberA);
    const id = seedResearchTask(db, { ownerId: "member_a", visibility: "private" });

    const { token: tokenB } = seedMemberWithToken({ id: "member_b", email: "b@example.com" });
    const response = await authed(`/research/${id}`, tokenB);
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toContain("403 无权访问");
  });

  it("public research: non-owner CAN view it (200), unlike private", async () => {
    const memberA = makeMember({ id: "member_a", email: "a@example.com" });
    new MemberRepository(db).upsert(memberA);
    const id = seedResearchTask(db, {
      ownerId: "member_a",
      question: "公开研判问题",
      visibility: "public"
    });

    const { token: tokenB } = seedMemberWithToken({ id: "member_b", email: "b@example.com" });
    const response = await authed(`/research/${id}`, tokenB);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("公开研判问题");
  });

  it("resolves the row BEFORE the ownership check: a non-existent id 404s even for a member who owns nothing", async () => {
    const { token } = seedMemberWithToken();
    const response = await authed("/research/still-does-not-exist", token);
    expect(response.status).toBe(404);
  });

  it("shows 暂无步骤记录 when steps is an empty array", async () => {
    const { member, token } = seedMemberWithToken();
    const id = seedResearchTask(db, { ownerId: member.id, steps: [] });
    const response = await authed(`/research/${id}`, token);
    const body = await response.text();
    expect(body).toContain("暂无步骤记录");
  });

  it("carries the CSP nonce and makes no third-party requests", async () => {
    const { member, token } = seedMemberWithToken();
    const id = seedResearchTask(db, { ownerId: member.id });
    const response = await authed(`/research/${id}`, token);
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonceMatch = /nonce-([^']+)/u.exec(csp);
    expect(nonceMatch).not.toBeNull();
    const body = await response.text();
    expect(body).toContain(`nonce="${nonceMatch?.[1]}"`);
    expect(body).not.toMatch(/https?:\/\//iu);
  });
});
