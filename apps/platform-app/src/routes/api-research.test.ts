// Phase 8 Task 3 (2026-07-16 plan): the submission/promotion JSON API
// (POST /api/research, POST /api/research/:id/promote). Exercised through
// the real HTTP server (createPlatformServer), same convention as
// api-strategy.test.ts/research.test.ts.
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiTokenRepository, MemberRepository, ResearchTaskRepository, migrate, type Member } from "@packages/shared-types";

import { createPlatformServer } from "../server.js";
import type { ResearchWorkerLike } from "./api-research.js";

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    id: "member_a",
    email: "member-a@example.com",
    displayName: "Member A",
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

describe("research submission/promotion API (POST /api/research*)", () => {
  let repoRoot: string;
  let db: DatabaseSync;
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;
  let memberA: Member;
  let memberB: Member;
  let tokenA: string;

  function startServer(researchWorker?: ResearchWorkerLike): Promise<void> {
    server = createPlatformServer({
      db,
      repoRoot,
      ...(researchWorker ? { researchWorker } : {})
    });
    return new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  }

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "platform-app-api-research-route-"));
    db = memoryDb();

    memberA = makeMember();
    memberB = makeMember({ id: "member_b", email: "member-b@example.com", displayName: "Member B" });
    new MemberRepository(db).upsert(memberA);
    new MemberRepository(db).upsert(memberB);
    tokenA = new ApiTokenRepository(db).issue(memberA.id, "a-token").token;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body)
    });
  }

  function withBearer(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }

  function withAccessEmail(email: string): Record<string, string> {
    return { "cf-access-authenticated-user-email": email };
  }

  /** Mirrors exactly what a real `<form method="post" action="/api/research">`
   * (home.ts's question box, Phase 8 Task 4) submits: an
   * `application/x-www-form-urlencoded` body, no `Accept` override - a
   * `fetch` with `redirect: 'manual'` so the 303 itself can be asserted
   * rather than transparently followed. */
  function postForm(path: string, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString()
    });
  }

  describe("POST /api/research via a form submission (Phase 8 Task 4 home.ts question box)", () => {
    it("303-redirects to /research/<id> instead of returning JSON", async () => {
      await startServer();
      const response = await postForm("/api/research", { question: "AAPL 最近怎么样" }, withBearer(tokenA));
      expect(response.status).toBe(303);
      const taskId = new ResearchTaskRepository(db).listForOwner(memberA.id)[0]?.id;
      expect(taskId).toBeDefined();
      expect(response.headers.get("location")).toBe(`/research/${taskId}`);
    });

    it("works via the Access-email identity chain too (the real home.ts caller)", async () => {
      await startServer();
      const response = await postForm("/api/research", { question: "AAPL 最近怎么样" }, withAccessEmail(memberA.email));
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toMatch(/^\/research\/.+/u);
    });

    it("a plain JSON caller (skill/bearer) still gets the original {ok, taskId, redirect} JSON shape, unaffected", async () => {
      await startServer();
      const response = await post("/api/research", { question: "AAPL 最近怎么样" }, withBearer(tokenA));
      expect(response.status).toBe(201);
      expect(response.headers.get("content-type")).toContain("application/json");
    });
  });

  describe("POST /api/research", () => {
    it("401s with neither a bearer token nor an Access email header", async () => {
      await startServer();
      const response = await post("/api/research", { question: "AAPL 最近怎么样" });
      expect(response.status).toBe(401);
    });

    it("400s on an empty/missing question", async () => {
      await startServer();
      const response = await post("/api/research", { question: "   " }, withBearer(tokenA));
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { ok: boolean; field?: string };
      expect(payload.ok).toBe(false);
      expect(payload.field).toBe("question");
    });

    it("enqueues via bearer identity and returns {ok, taskId, redirect}", async () => {
      await startServer();
      const response = await post("/api/research", { question: "AAPL 最近怎么样" }, withBearer(tokenA));
      expect(response.status).toBe(201);
      const payload = (await response.json()) as { ok: boolean; taskId: string; redirect: string };
      expect(payload.ok).toBe(true);
      expect(payload.redirect).toBe(`/research/${payload.taskId}`);

      const task = new ResearchTaskRepository(db).getById(payload.taskId);
      expect(task?.ownerId).toBe(memberA.id);
      expect(task?.status).toBe("queued");
      expect(task?.question).toBe("AAPL 最近怎么样");
    });

    it("enqueues via the Access-email header (browser identity chain)", async () => {
      await startServer();
      const response = await post("/api/research", { question: "AAPL 最近怎么样" }, withAccessEmail(memberA.email));
      expect(response.status).toBe(201);
      const payload = (await response.json()) as { taskId: string };
      expect(new ResearchTaskRepository(db).getById(payload.taskId)?.ownerId).toBe(memberA.id);
    });

    it("IGNORES a body ownerId - the task is always owned by the resolved identity", async () => {
      await startServer();
      const response = await post(
        "/api/research",
        { question: "AAPL 最近怎么样", ownerId: memberB.id },
        withBearer(tokenA)
      );
      expect(response.status).toBe(201);
      const payload = (await response.json()) as { taskId: string };
      const task = new ResearchTaskRepository(db).getById(payload.taskId);
      expect(task?.ownerId).toBe(memberA.id);
      expect(task?.ownerId).not.toBe(memberB.id);
    });

    it("429s with the exact quota-exhausted message after the 10th task today", async () => {
      await startServer();
      for (let i = 0; i < 10; i += 1) {
        const response = await post("/api/research", { question: `问题 ${i}` }, withBearer(tokenA));
        expect(response.status).toBe(201);
      }
      const eleventh = await post("/api/research", { question: "第11个问题" }, withBearer(tokenA));
      expect(eleventh.status).toBe(429);
      const payload = (await eleventh.json()) as { ok: boolean; error: string; used: number; limit: number };
      expect(payload.ok).toBe(false);
      expect(payload.error).toBe("今日研究配额已用完（10/10），美东交易日切界后重置");
      expect(payload.used).toBe(10);
      expect(payload.limit).toBe(10);
    });

    it("kicks the injected researchWorker.tick() once, fire-and-forget, without blocking the response", async () => {
      const tick = vi.fn(async () => true);
      await startServer({ tick });
      const response = await post("/api/research", { question: "AAPL 最近怎么样" }, withBearer(tokenA));
      expect(response.status).toBe(201);
      // Give the fire-and-forget microtask a chance to run.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(tick).toHaveBeenCalledTimes(1);
    });

    it("still enqueues (and responds 201) even when the kicked tick() rejects", async () => {
      const tick = vi.fn(async () => {
        throw new Error("boom (test double)");
      });
      await startServer({ tick });
      const response = await post("/api/research", { question: "AAPL 最近怎么样" }, withBearer(tokenA));
      expect(response.status).toBe(201);
    });
  });

  describe("POST /api/research/:id/promote", () => {
    function seedTask(ownerId: string, question = "AAPL 最近怎么样"): string {
      const result = new ResearchTaskRepository(db).createIfWithinQuota({ ownerId, question, tradingDay: "2026-07-16" });
      if (!result.ok) throw new Error("test setup: quota unexpectedly exceeded");
      return result.task.id;
    }

    it("401s without identity", async () => {
      await startServer();
      const taskId = seedTask(memberA.id);
      const response = await post(`/api/research/${taskId}/promote`, {});
      expect(response.status).toBe(401);
    });

    it("404s for a nonexistent task id", async () => {
      await startServer();
      const response = await post("/api/research/rt_missing/promote", {}, withBearer(tokenA));
      expect(response.status).toBe(404);
    });

    it("403s when a non-owner tries to promote", async () => {
      await startServer();
      const taskId = seedTask(memberB.id);
      const response = await post(`/api/research/${taskId}/promote`, {}, withBearer(tokenA));
      expect(response.status).toBe(403);
      expect(new ResearchTaskRepository(db).getById(taskId)?.visibility).toBe("private");
    });

    it("promotes private -> public for the owner and records an audit entry", async () => {
      await startServer();
      const taskId = seedTask(memberA.id);
      const response = await post(`/api/research/${taskId}/promote`, {}, withBearer(tokenA));
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { ok: boolean; task: { visibility: string } };
      expect(payload.ok).toBe(true);
      expect(payload.task.visibility).toBe("public");

      const auditRows = db.prepare(`SELECT category, action FROM audit_log WHERE category = 'research'`).all() as Array<{
        category: string;
        action: string;
      }>;
      expect(auditRows).toEqual([{ category: "research", action: "research promote" }]);
    });

    it("does not append a second audit entry when promoting an already-public task (no-op)", async () => {
      await startServer();
      const taskId = seedTask(memberA.id);

      const first = await post(`/api/research/${taskId}/promote`, {}, withBearer(tokenA));
      expect(first.status).toBe(200);
      // Retried/duplicate promote on the now-public task: still 200, still
      // public, but must NOT log a second (misleading) promote event.
      const second = await post(`/api/research/${taskId}/promote`, {}, withBearer(tokenA));
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { ok: boolean; task: { visibility: string } };
      expect(secondBody.task.visibility).toBe("public");

      const auditCount = db
        .prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE category = 'research' AND action = 'research promote'`)
        .get() as { c: number };
      expect(auditCount.c).toBe(1);
    });
  });

  describe("method handling", () => {
    it("405s a GET on /api/research", async () => {
      await startServer();
      const response = await fetch(`${baseUrl}/api/research`);
      expect(response.status).toBe(405);
    });
  });
});
