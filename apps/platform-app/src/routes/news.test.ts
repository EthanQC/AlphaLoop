import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApiTokenRepository, MemberRepository, migrate, type Member } from "@packages/shared-types";

import { createPlatformServer } from "../server.js";

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

describe("news route (GET /news)", () => {
  let db: DatabaseSync;
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;
  let token: string;

  beforeEach(async () => {
    db = memoryDb();
    const member: Member = {
      id: "member_1",
      email: "member1@example.com",
      displayName: "Member One",
      riskTags: [],
      stockTags: [],
      showPerformance: true,
      status: "active",
      createdAt: "2026-07-01T00:00:00.000Z"
    };
    new MemberRepository(db).upsert(member);
    token = new ApiTokenRepository(db).issue(member.id, "test").token;

    server = createPlatformServer({ db, repoRoot: process.cwd(), now: () => new Date("2026-07-14T12:00:00Z") });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns 401 without any identity", async () => {
    const response = await fetch(`${baseUrl}/news`);
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain("未获授权");
  });

  it("returns 200 with the full-page honest placeholder and the layout skeleton", async () => {
    const response = await fetch(`${baseUrl}/news`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();

    expect(body).toContain("新闻引擎 P4 上线——届时事件聚类一事一卡");
    // Filter chips row present (disabled) - the structure P4 will fill.
    expect(body).toContain("全部");
    expect(body).toContain("持仓相关");
    expect(body).toContain('aria-disabled="true"');
    // Layout chrome (renderPage) present, nav item highlighted.
    expect(body).toContain('class="tab on"');
    // No degradation banner - this placeholder page has no degraded data.
    expect(body).not.toContain("数据降级提示");
  });

  it("carries the response's CSP nonce onto the page's one inline script", async () => {
    const response = await fetch(`${baseUrl}/news`, { headers: { authorization: `Bearer ${token}` } });
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonceMatch = /nonce-([^']+)/u.exec(csp);
    expect(nonceMatch).not.toBeNull();
    const body = await response.text();
    expect(body).toContain(`nonce="${nonceMatch?.[1]}"`);
  });

  it("returns 405 for non-GET requests", async () => {
    const response = await fetch(`${baseUrl}/news`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(response.status).toBe(405);
  });
});
