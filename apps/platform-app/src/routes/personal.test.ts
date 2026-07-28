// Task 6 (2026-07-28 spec-drift remediation): the owner-only personal page
// routes, `GET /daily/<date>/me` and `GET /weekly/<date>/me`. Exercised
// through the real HTTP server (createPlatformServer), same convention as
// review.test.ts / research.test.ts.
//
// The rows these routes read are written by apps/openclaw-config/scripts/
// personal-page.mjs (Task 5) when a daily/weekly report is generated. That
// generator is plain .mjs in another app with no type declarations, so this
// suite seeds `personal_pages` with SQL directly (the same technique
// home.test.ts uses for snapshots/alerts) rather than importing it - what is
// under test here is the ROUTE (identity, owner isolation, rendering), not
// the generator, which has its own suite.
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
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

/** Markdown shaped exactly like personal-page.mjs's output: an H1 header
 * block, then the four §3.2 sections as `## <n>. <title>` headings, in that
 * fixed order. `A&B.US` is deliberately present so the assertions can prove
 * the stored text is routed through the escaping markdown renderer rather
 * than concatenated into the page. */
function personalMarkdown(opts: { ownerLabel: string; kind: "daily" | "weekly"; date: string; secret: string }): string {
  const kindLabel = opts.kind === "daily" ? "日报" : "周报";
  return [
    `# 我的个人页 · ${kindLabel} ${opts.date}`,
    "",
    `- 成员：${opts.ownerLabel}`,
    "- 可见性：仅本人可见；本页不进入公共日报/周报正文，也不发到群里。",
    "",
    "## 1. 我的持仓速览",
    "",
    `- 持仓：A&B.US 100 股（${opts.secret}）`,
    "",
    "## 2. 我的策略对照",
    "",
    `- 论点：${opts.secret} 距失效线 3.20%`,
    "",
    "## 3. 我的提醒回顾",
    "",
    `- 提醒：${opts.secret} 日内涨跌 5.00%`,
    "",
    "## 4. 我的待办",
    "",
    `- 待审提案：${opts.secret} 买入 10 股`
  ].join("\n");
}

function seedPersonalPage(
  db: DatabaseSync,
  opts: { ownerId: string; kind: "daily" | "weekly"; date: string; markdown: string; createdAt?: string }
): void {
  db.prepare(
    `INSERT INTO personal_pages (id, owner_id, kind, date, markdown, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    createId("personal_page"),
    opts.ownerId,
    opts.kind,
    opts.date,
    opts.markdown,
    opts.createdAt ?? "2026-07-14T12:05:00.000Z"
  );
}

describe("personal page routes (GET /daily/<date>/me, GET /weekly/<date>/me)", () => {
  let repoRoot: string;
  let db: DatabaseSync;
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;
  let memberA: Member;
  let memberB: Member;
  let tokenA: string;
  let tokenB: string;

  // Fixed clock: 2026-07-14T12:00:00Z is 2026-07-14 20:00 in Asia/Shanghai.
  const NOW = () => new Date("2026-07-14T12:00:00.000Z");
  const TODAY = "2026-07-14";

  const SECRET_A = "A的私有策略口令";
  const SECRET_B = "B的私有策略口令";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "platform-app-personal-route-"));
    db = memoryDb();

    memberA = makeMember();
    memberB = makeMember({ id: "member_b", email: "member-b@example.com", displayName: "Member B" });
    const members = new MemberRepository(db);
    members.upsert(memberA);
    members.upsert(memberB);
    const tokens = new ApiTokenRepository(db);
    tokenA = tokens.issue(memberA.id, "a-token").token;
    tokenB = tokens.issue(memberB.id, "b-token").token;

    server = createPlatformServer({ db, repoRoot, now: NOW });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function withBearer(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }

  function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers });
  }

  function seedA(kind: "daily" | "weekly" = "daily", date: string = TODAY): void {
    seedPersonalPage(db, {
      ownerId: memberA.id,
      kind,
      date,
      markdown: personalMarkdown({ ownerLabel: "Member A（member_a）", kind, date, secret: SECRET_A })
    });
  }

  function seedB(kind: "daily" | "weekly" = "daily", date: string = TODAY): void {
    seedPersonalPage(db, {
      ownerId: memberB.id,
      kind,
      date,
      markdown: personalMarkdown({ ownerLabel: "Member B（member_b）", kind, date, secret: SECRET_B })
    });
  }

  // -------------------------------------------------------------------------
  // Identity gate
  // -------------------------------------------------------------------------

  it("returns 401 without any identity", async () => {
    seedA();
    const response = await get(`/daily/${TODAY}/me`);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(SECRET_A);
  });

  it("returns 405 for non-GET requests", async () => {
    seedA();
    const response = await fetch(`${baseUrl}/daily/${TODAY}/me`, { method: "POST", headers: withBearer(tokenA) });
    expect(response.status).toBe(405);
  });

  // -------------------------------------------------------------------------
  // The owner's own page
  // -------------------------------------------------------------------------

  it("renders the viewer's own four sections, in §3.2 order, from the stored markdown", async () => {
    seedA();
    const response = await get(`/daily/${TODAY}/me`, withBearer(tokenA));
    expect(response.status).toBe(200);
    const body = await response.text();

    expect(body).toContain("我的持仓速览");
    expect(body).toContain("我的策略对照");
    expect(body).toContain("我的提醒回顾");
    expect(body).toContain("我的待办");
    expect(body).toContain(SECRET_A);
    expect(body).toContain("仅本人可见");

    const order = ["我的持仓速览", "我的策略对照", "我的提醒回顾", "我的待办"].map((title) => body.indexOf(title));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((index) => index > 0)).toBe(true);

    // Stored text goes through the escaping markdown renderer, never raw.
    expect(body).toContain("A&amp;B.US");
    expect(body).not.toContain("A&B.US");
  });

  it("serves the weekly page from the same route family, reading the weekly row (not the daily one)", async () => {
    seedA("daily");
    seedPersonalPage(db, {
      ownerId: memberA.id,
      kind: "weekly",
      date: TODAY,
      markdown: personalMarkdown({ ownerLabel: "Member A（member_a）", kind: "weekly", date: TODAY, secret: "周报专属口令" })
    });

    const weekly = await get(`/weekly/${TODAY}/me`, withBearer(tokenA));
    expect(weekly.status).toBe(200);
    const body = await weekly.text();
    expect(body).toContain("周报专属口令");
    expect(body).not.toContain(SECRET_A);
  });

  it("404s with an honest reason when this owner has no page for that date, without inventing content", async () => {
    const response = await get(`/daily/2026-07-13/me`, withBearer(tokenA));
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toContain("尚未生成");
    expect(body).not.toContain("我的持仓速览");
  });

  it("404s on a malformed date before touching the database (path-traversal guard)", async () => {
    const response = await get(`/daily/..%2F..%2Fetc/me`, withBearer(tokenA));
    expect(response.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Owner isolation - the whole point of this route
  // -------------------------------------------------------------------------

  it("owner isolation: B opening the same URL sees B's own page, never a byte of A's", async () => {
    seedA();
    seedB();

    const asB = await get(`/daily/${TODAY}/me`, withBearer(tokenB));
    expect(asB.status).toBe(200);
    const bodyB = await asB.text();
    expect(bodyB).toContain(SECRET_B);
    expect(bodyB).not.toContain(SECRET_A);

    const asA = await get(`/daily/${TODAY}/me`, withBearer(tokenA));
    const bodyA = await asA.text();
    expect(bodyA).toContain(SECRET_A);
    expect(bodyA).not.toContain(SECRET_B);
  });

  it("owner isolation: B gets the honest 404, NOT A's page, when only A has a page that day", async () => {
    seedA();
    const response = await get(`/daily/${TODAY}/me`, withBearer(tokenB));
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(SECRET_A);
  });

  it("never accepts ?owner=: B naming A's id is refused with 403, and A's content is not leaked", async () => {
    seedA();
    seedB();
    const response = await get(`/daily/${TODAY}/me?owner=${memberA.id}`, withBearer(tokenB));
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toContain("403 无权访问");
    expect(body).not.toContain(SECRET_A);
    expect(body).not.toContain(SECRET_B);
  });

  it("never accepts ?owner=: even naming YOUR OWN id is refused, proving the parameter is rejected rather than resolved", async () => {
    seedA();
    const response = await get(`/daily/${TODAY}/me?owner=${memberA.id}`, withBearer(tokenA));
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(SECRET_A);
  });

  it("never accepts ?owner=: an empty or unknown value is refused too (no silent fallthrough to the viewer's page)", async () => {
    seedA();
    const empty = await get(`/daily/${TODAY}/me?owner=`, withBearer(tokenA));
    expect(empty.status).toBe(403);
    const unknown = await get(`/weekly/${TODAY}/me?owner=nobody`, withBearer(tokenA));
    expect(unknown.status).toBe(403);
  });

  it("leaves the public reading page untouched: /daily/<date> is still the report route's 404, not a personal page", async () => {
    seedA();
    const response = await get(`/daily/${TODAY}`, withBearer(tokenA));
    // No report file exists on disk in this suite's temp repoRoot.
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(SECRET_A);
  });
});
