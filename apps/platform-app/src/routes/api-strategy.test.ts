import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApiTokenRepository,
  MemberRepository,
  STRATEGY_DEMOTION_NOTICE,
  migrate,
  type Member
} from "@packages/shared-types";

import { createPlatformServer } from "../server.js";
import type { MemorydBackend } from "../data/memoryd-mirror.js";

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

const FAKE_MIRROR_OK: MemorydBackend = async () => ({ ok: true, memoryId: "mem_fake_1" });
const FAKE_MIRROR_THROWS: MemorydBackend = async () => {
  throw new Error("memoryd unreachable (test double)");
};

describe("bearer-gated strategy write API (POST /api/*)", () => {
  let repoRoot: string;
  let db: DatabaseSync;
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;
  let memberA: Member;
  let memberB: Member;
  let tokenA: string;
  let tokenB: string;

  function startServer(memorydBackend: MemorydBackend = FAKE_MIRROR_OK): Promise<void> {
    server = createPlatformServer({ db, repoRoot, memorydBackend });
    return new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  }

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "platform-app-api-strategy-route-"));
    db = memoryDb();

    memberA = makeMember();
    memberB = makeMember({ id: "member_b", email: "member-b@example.com", displayName: "Member B" });
    new MemberRepository(db).upsert(memberA);
    new MemberRepository(db).upsert(memberB);
    tokenA = new ApiTokenRepository(db).issue(memberA.id, "a-token").token;
    tokenB = new ApiTokenRepository(db).issue(memberB.id, "b-token").token;

    await startServer();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function post(path: string, body: unknown, token?: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...extraHeaders
      },
      body: JSON.stringify(body)
    });
  }

  async function createThesisAs(token: string, overrides: Record<string, unknown> = {}): Promise<{ id: string; ownerId: string; visibility: string }> {
    const response = await post(
      "/api/theses",
      { symbol: "AAPL.US", direction: "bull", ...overrides },
      token
    );
    expect(response.status).toBe(201);
    const payload = (await response.json()) as { thesis: { id: string; ownerId: string; visibility: string } };
    return payload.thesis;
  }

  // ---------------------------------------------------------------------
  // Authentication: bearer-only
  // ---------------------------------------------------------------------

  it("401s a POST with no Authorization header at all", async () => {
    const response = await post("/api/theses", { symbol: "AAPL.US", direction: "bull" });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("401s a POST carrying ONLY the Access email header (no bearer) - Access never grants write access", async () => {
    const response = await post(
      "/api/theses",
      { symbol: "AAPL.US", direction: "bull" },
      undefined,
      { "cf-access-authenticated-user-email": memberA.email }
    );
    expect(response.status).toBe(401);
  });

  it("401s an invalid/unknown bearer token", async () => {
    const response = await post("/api/theses", { symbol: "AAPL.US", direction: "bull" }, "not-a-real-token");
    expect(response.status).toBe(401);
  });

  // ---------------------------------------------------------------------
  // POST /api/theses
  // ---------------------------------------------------------------------

  describe("POST /api/theses", () => {
    it("creates a thesis owned by the token's member (happy path)", async () => {
      const response = await post(
        "/api/theses",
        {
          symbol: "MSFT.US",
          direction: "bear",
          targetLow: 300,
          targetHigh: 350,
          invalidationPrice: 420,
          bullPoints: ["云业务增速超预期"],
          bearPoints: ["估值过高"],
          visibility: "public"
        },
        tokenA
      );
      expect(response.status).toBe(201);
      const body = (await response.json()) as {
        ok: boolean;
        thesis: Record<string, unknown>;
        mirror: { mirrored: boolean };
      };
      expect(body.ok).toBe(true);
      expect(body.thesis.ownerId).toBe(memberA.id);
      expect(body.thesis.symbol).toBe("MSFT.US");
      expect(body.thesis.direction).toBe("bear");
      expect(body.thesis.visibility).toBe("public");
      expect(body.mirror.mirrored).toBe(true);

      // Verify the row genuinely landed in SQL, not just in the response.
      const row = db.prepare(`SELECT * FROM theses WHERE id = ?`).get(body.thesis.id as string) as Record<string, unknown>;
      expect(row.owner_id).toBe(memberA.id);
      expect(row.symbol).toBe("MSFT.US");
    });

    it("ignores a body ownerId targeting another member - the row is still owned by the TOKEN's member", async () => {
      const response = await post(
        "/api/theses",
        { symbol: "NVDA.US", direction: "bull", ownerId: memberB.id },
        tokenA
      );
      expect(response.status).toBe(201);
      const body = (await response.json()) as { thesis: { id: string; ownerId: string } };
      expect(body.thesis.ownerId).toBe(memberA.id);
      expect(body.thesis.ownerId).not.toBe(memberB.id);

      const row = db.prepare(`SELECT owner_id FROM theses WHERE id = ?`).get(body.thesis.id) as { owner_id: string };
      expect(row.owner_id).toBe(memberA.id);
    });

    it("400s a bad direction with the offending field named", async () => {
      const response = await post("/api/theses", { symbol: "AAPL.US", direction: "sideways" }, tokenA);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { ok: boolean; field: string };
      expect(body.ok).toBe(false);
      expect(body.field).toBe("direction");
    });

    it("400s a missing symbol", async () => {
      const response = await post("/api/theses", { direction: "bull" }, tokenA);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { field: string };
      expect(body.field).toBe("symbol");
    });

    it("400s a bad visibility", async () => {
      const response = await post("/api/theses", { symbol: "AAPL.US", direction: "bull", visibility: "private" }, tokenA);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { field: string };
      expect(body.field).toBe("visibility");
    });

    it("400s a non-array bullPoints", async () => {
      const response = await post("/api/theses", { symbol: "AAPL.US", direction: "bull", bullPoints: "not-an-array" }, tokenA);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { field: string };
      expect(body.field).toBe("bullPoints");
    });

    it("defaults visibility to 'system' and points to [] when omitted", async () => {
      const thesis = await createThesisAs(tokenA);
      expect(thesis.visibility).toBe("system");
    });

    it("405s a GET", async () => {
      const response = await fetch(`${baseUrl}/api/theses`, { headers: { authorization: `Bearer ${tokenA}` } });
      expect(response.status).toBe(405);
    });

    it("mirror degradation (backend throws) does not fail the write - the SQL row is still present", async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await startServer(FAKE_MIRROR_THROWS);

      const response = await post("/api/theses", { symbol: "TSLA.US", direction: "bull" }, tokenA);
      expect(response.status).toBe(201);
      const body = (await response.json()) as { ok: boolean; thesis: { id: string }; mirror: { mirrored: boolean; reason: string } };
      expect(body.ok).toBe(true);
      expect(body.mirror.mirrored).toBe(false);
      expect(body.mirror.reason).toContain("memoryd unreachable");

      const row = db.prepare(`SELECT * FROM theses WHERE id = ?`).get(body.thesis.id) as Record<string, unknown> | undefined;
      expect(row).toBeDefined();
      expect(row?.symbol).toBe("TSLA.US");
    });
  });

  // ---------------------------------------------------------------------
  // POST /api/theses/:id/judgments
  // ---------------------------------------------------------------------

  describe("POST /api/theses/:id/judgments", () => {
    it("appends a judgment for the owner (happy path)", async () => {
      const thesis = await createThesisAs(tokenA);
      const response = await post(`/api/theses/${thesis.id}/judgments`, { note: "跌破年线，观察反弹", source: "daily-review" }, tokenA);
      expect(response.status).toBe(201);
      const body = (await response.json()) as { ok: boolean; judgment: { note: string; source: string; thesisId: string } };
      expect(body.ok).toBe(true);
      expect(body.judgment.note).toBe("跌破年线，观察反弹");
      expect(body.judgment.source).toBe("daily-review");
      expect(body.judgment.thesisId).toBe(thesis.id);

      const rows = db.prepare(`SELECT * FROM thesis_history WHERE thesis_id = ?`).all(thesis.id);
      expect(rows).toHaveLength(1);
    });

    it("defaults source to 'self' when omitted", async () => {
      const thesis = await createThesisAs(tokenA);
      const response = await post(`/api/theses/${thesis.id}/judgments`, { note: "维持看多" }, tokenA);
      const body = (await response.json()) as { judgment: { source: string } };
      expect(body.judgment.source).toBe("self");
    });

    it("403s a non-owner's attempt to add a judgment", async () => {
      const thesis = await createThesisAs(tokenA);
      const response = await post(`/api/theses/${thesis.id}/judgments`, { note: "抢别人的论点" }, tokenB);
      expect(response.status).toBe(403);
    });

    it("404s an unknown thesis id", async () => {
      const response = await post(`/api/theses/does-not-exist/judgments`, { note: "x" }, tokenA);
      expect(response.status).toBe(404);
    });

    it("400s a missing note", async () => {
      const thesis = await createThesisAs(tokenA);
      const response = await post(`/api/theses/${thesis.id}/judgments`, {}, tokenA);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { field: string };
      expect(body.field).toBe("note");
    });
  });

  // ---------------------------------------------------------------------
  // POST /api/theses/:id/promote
  // ---------------------------------------------------------------------

  describe("POST /api/theses/:id/promote", () => {
    it("promotes system -> public for the owner (happy path)", async () => {
      const thesis = await createThesisAs(tokenA);
      expect(thesis.visibility).toBe("system");

      const response = await post(`/api/theses/${thesis.id}/promote`, {}, tokenA);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; thesis: { visibility: string } };
      expect(body.ok).toBe(true);
      expect(body.thesis.visibility).toBe("public");
    });

    it("403s a non-owner's promote attempt", async () => {
      const thesis = await createThesisAs(tokenA);
      const response = await post(`/api/theses/${thesis.id}/promote`, {}, tokenB);
      expect(response.status).toBe(403);

      // Confirm the row was NOT mutated by the rejected attempt.
      const row = db.prepare(`SELECT visibility FROM theses WHERE id = ?`).get(thesis.id) as { visibility: string };
      expect(row.visibility).toBe("system");
    });

    it("404s an unknown thesis id", async () => {
      const response = await post(`/api/theses/does-not-exist/promote`, {}, tokenA);
      expect(response.status).toBe(404);
    });

    it("is idempotent on an already-public thesis", async () => {
      const thesis = await createThesisAs(tokenA, { visibility: "public" });
      const response = await post(`/api/theses/${thesis.id}/promote`, {}, tokenA);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { thesis: { visibility: string } };
      expect(body.thesis.visibility).toBe("public");
    });
  });

  // ---------------------------------------------------------------------
  // POST /api/theses/:id/demote  ·  POST /api/cards/:id/{promote,demote}
  //
  // Task 15 (2026-07-28 spec-drift plan): §2.1's 三档可见性 promises 「一键升档
  // …降档时已生成的历史内容不回收（如实告知）」. This surface could only promote, and
  // only a thesis, so publishing was a one-way door.
  // ---------------------------------------------------------------------

  describe("POST /api/theses/:id/demote and /api/cards/:id/demote", () => {
    async function createCardAs(
      token: string,
      overrides: Record<string, unknown> = {}
    ): Promise<{ id: string; ownerId: string; visibility: string }> {
      const response = await post("/api/cards", { name: "趋势跟随", ...overrides }, token);
      expect(response.status).toBe(201);
      const payload = (await response.json()) as { card: { id: string; ownerId: string; visibility: string } };
      return payload.card;
    }

    it("demotes a public thesis back to system for the owner and says nothing is recalled", async () => {
      const thesis = await createThesisAs(tokenA, { visibility: "public" });

      const response = await post(`/api/theses/${thesis.id}/demote`, {}, tokenA);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; thesis: { visibility: string }; notice: string };
      expect(body.ok).toBe(true);
      expect(body.thesis.visibility).toBe("system");
      expect(body.notice).toBe(STRATEGY_DEMOTION_NOTICE);
      expect(body.notice).toContain("不回收");
    });

    it("writes an audit_log row naming the row and the member who demoted it", async () => {
      const thesis = await createThesisAs(tokenA, { visibility: "public" });
      await post(`/api/theses/${thesis.id}/demote`, {}, tokenA);

      const rows = db
        .prepare(`SELECT payload FROM audit_log WHERE category = 'strategy_memory' AND action = 'thesis demote'`)
        .all() as Array<{ payload: string }>;
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]?.payload ?? "{}")).toEqual({ thesisId: thesis.id, ownerId: memberA.id });
    });

    it("403s a non-owner's demote attempt and leaves the row public", async () => {
      const thesis = await createThesisAs(tokenA, { visibility: "public" });

      const response = await post(`/api/theses/${thesis.id}/demote`, {}, tokenB);
      expect(response.status).toBe(403);

      const row = db.prepare(`SELECT visibility FROM theses WHERE id = ?`).get(thesis.id) as { visibility: string };
      expect(row.visibility).toBe("public");
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'thesis demote'`).get() as { n: number }
      ).toEqual({ n: 0 });
    });

    it("404s an unknown thesis id", async () => {
      const response = await post(`/api/theses/does-not-exist/demote`, {}, tokenA);
      expect(response.status).toBe(404);
    });

    it("is idempotent on an already-system thesis", async () => {
      const thesis = await createThesisAs(tokenA);
      const response = await post(`/api/theses/${thesis.id}/demote`, {}, tokenA);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { thesis: { visibility: string } };
      expect(body.thesis.visibility).toBe("system");
    });

    it("takes a demoted card out of the other member's circle view", async () => {
      const card = await createCardAs(tokenA, { visibility: "public" });

      // Before: member B's circle query (the same SQL data/strategy.ts runs)
      // returns member A's card.
      const visibleBefore = db
        .prepare(`SELECT id FROM strategy_cards WHERE visibility = 'public' AND owner_id != ?`)
        .all(memberB.id) as Array<{ id: string }>;
      expect(visibleBefore.map((row) => row.id)).toContain(card.id);

      const response = await post(`/api/cards/${card.id}/demote`, {}, tokenA);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { card: { visibility: string }; notice: string };
      expect(body.card.visibility).toBe("system");
      expect(body.notice).toBe(STRATEGY_DEMOTION_NOTICE);

      const visibleAfter = db
        .prepare(`SELECT id FROM strategy_cards WHERE visibility = 'public' AND owner_id != ?`)
        .all(memberB.id) as Array<{ id: string }>;
      expect(visibleAfter.map((row) => row.id)).not.toContain(card.id);
    });

    it("403s a non-owner's card demote and 404s an unknown card id", async () => {
      const card = await createCardAs(tokenA, { visibility: "public" });

      expect((await post(`/api/cards/${card.id}/demote`, {}, tokenB)).status).toBe(403);
      expect((await post(`/api/cards/no-such-card/demote`, {}, tokenA)).status).toBe(404);

      const row = db.prepare(`SELECT visibility FROM strategy_cards WHERE id = ?`).get(card.id) as {
        visibility: string;
      };
      expect(row.visibility).toBe("public");
    });

    it("re-publishes a demoted card through /promote, so the ladder climbs again", async () => {
      const card = await createCardAs(tokenA, { visibility: "public" });
      await post(`/api/cards/${card.id}/demote`, {}, tokenA);

      const response = await post(`/api/cards/${card.id}/promote`, {}, tokenA);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { card: { visibility: string }; notice?: string };
      expect(body.card.visibility).toBe("public");
      // Promotion retracts nothing, so it carries no no-recall notice.
      expect(body.notice).toBeUndefined();
    });

    it("405s a GET on a demote path instead of treating it as a write", async () => {
      const thesis = await createThesisAs(tokenA, { visibility: "public" });
      const response = await fetch(`${baseUrl}/api/theses/${thesis.id}/demote`, {
        headers: { Authorization: `Bearer ${tokenA}` }
      });
      expect(response.status).toBe(405);
    });
  });

  // ---------------------------------------------------------------------
  // POST /api/rules
  // ---------------------------------------------------------------------

  describe("POST /api/rules", () => {
    it("creates a rule owned by the token's member (happy path)", async () => {
      const response = await post("/api/rules", { ruleText: "单笔不超过总资金5%", enforcement: "hard" }, tokenA);
      expect(response.status).toBe(201);
      const body = (await response.json()) as { ok: boolean; rule: Record<string, unknown>; mirror: { mirrored: boolean } };
      expect(body.ok).toBe(true);
      expect(body.rule.ownerId).toBe(memberA.id);
      expect(body.rule.enforcement).toBe("hard");
      expect(body.rule.enabled).toBe(true);
      expect(body.mirror.mirrored).toBe(true);

      const row = db.prepare(`SELECT * FROM discipline_rules WHERE id = ?`).get(body.rule.id as string) as Record<string, unknown>;
      expect(row.owner_id).toBe(memberA.id);
    });

    it("ignores a body ownerId targeting another member", async () => {
      const response = await post(
        "/api/rules",
        { ruleText: "禁止追高", enforcement: "self", ownerId: memberB.id },
        tokenA
      );
      const body = (await response.json()) as { rule: { ownerId: string } };
      expect(body.rule.ownerId).toBe(memberA.id);
    });

    it("400s a bad enforcement value", async () => {
      const response = await post("/api/rules", { ruleText: "x", enforcement: "yolo" }, tokenA);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { field: string };
      expect(body.field).toBe("enforcement");
    });

    it("400s a missing ruleText", async () => {
      const response = await post("/api/rules", { enforcement: "hard" }, tokenA);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { field: string };
      expect(body.field).toBe("ruleText");
    });
  });

  // ---------------------------------------------------------------------
  // POST /api/rules/:id/disable
  // ---------------------------------------------------------------------

  describe("POST /api/rules/:id/disable", () => {
    async function createRuleAs(token: string): Promise<{ id: string }> {
      const response = await post("/api/rules", { ruleText: "禁止逆势加仓", enforcement: "proposal_check" }, token);
      const body = (await response.json()) as { rule: { id: string } };
      return body.rule;
    }

    it("disables a rule for its owner (happy path)", async () => {
      const rule = await createRuleAs(tokenA);
      const response = await post(`/api/rules/${rule.id}/disable`, {}, tokenA);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; rule: { enabled: boolean; disabledAt: string | null } };
      expect(body.ok).toBe(true);
      expect(body.rule.enabled).toBe(false);
      expect(body.rule.disabledAt).not.toBeNull();
    });

    it("403s a non-owner's disable attempt", async () => {
      const rule = await createRuleAs(tokenA);
      const response = await post(`/api/rules/${rule.id}/disable`, {}, tokenB);
      expect(response.status).toBe(403);

      const row = db.prepare(`SELECT enabled FROM discipline_rules WHERE id = ?`).get(rule.id) as { enabled: number };
      expect(row.enabled).toBe(1);
    });

    it("404s an unknown rule id", async () => {
      const response = await post(`/api/rules/does-not-exist/disable`, {}, tokenA);
      expect(response.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------
  // POST /api/cards
  // ---------------------------------------------------------------------

  describe("POST /api/cards", () => {
    it("creates a strategy card owned by the token's member (happy path)", async () => {
      const response = await post(
        "/api/cards",
        {
          name: "回踩20日线加仓",
          scene: "多头趋势中的回调",
          entryCondition: "价格回踩20日均线企稳",
          riskControl: "跌破均线止损",
          exitRule: "跌破前低",
          visibility: "public"
        },
        tokenA
      );
      expect(response.status).toBe(201);
      const body = (await response.json()) as { ok: boolean; card: Record<string, unknown>; mirror: { mirrored: boolean } };
      expect(body.ok).toBe(true);
      expect(body.card.ownerId).toBe(memberA.id);
      expect(body.card.name).toBe("回踩20日线加仓");
      expect(body.card.visibility).toBe("public");
      expect(body.mirror.mirrored).toBe(true);

      const row = db.prepare(`SELECT * FROM strategy_cards WHERE id = ?`).get(body.card.id as string) as Record<string, unknown>;
      expect(row.owner_id).toBe(memberA.id);
    });

    it("ignores a body ownerId targeting another member", async () => {
      const response = await post("/api/cards", { name: "抢别人的卡", ownerId: memberB.id }, tokenA);
      const body = (await response.json()) as { card: { ownerId: string } };
      expect(body.card.ownerId).toBe(memberA.id);
    });

    it("400s a missing name", async () => {
      const response = await post("/api/cards", { scene: "x" }, tokenA);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { field: string };
      expect(body.field).toBe("name");
    });

    it("400s a bad visibility", async () => {
      const response = await post("/api/cards", { name: "x", visibility: "hidden" }, tokenA);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { field: string };
      expect(body.field).toBe("visibility");
    });

    it("defaults visibility to 'system' and optional fields to null when omitted", async () => {
      const response = await post("/api/cards", { name: "极简卡片" }, tokenA);
      const body = (await response.json()) as { card: { visibility: string; scene: string | null } };
      expect(body.card.visibility).toBe("system");
      expect(body.card.scene).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // Unknown /api/* path falls through to the platform's own 404
  // ---------------------------------------------------------------------

  it("404s an unrecognized /api/* path", async () => {
    const response = await post("/api/does-not-exist", {}, tokenA);
    expect(response.status).toBe(404);
  });
});
