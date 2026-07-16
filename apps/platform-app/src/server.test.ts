import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "@packages/shared-types";

import { createPlatformServer } from "./server.js";

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

describe("createPlatformServer", () => {
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    db = memoryDb();
    server = createPlatformServer({ db, repoRoot: process.cwd() });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("binds only to the loopback interface", () => {
    const address = server.address() as AddressInfo;
    expect(address.address).toBe("127.0.0.1");
  });

  it("responds 200 with the health payload on GET /health", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({ ok: true, service: "platform-app" });
  });

  it("attaches every required security header on GET /health", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.headers.get("content-security-policy")).toMatch(
      /^default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-[^']+'$/u
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("uses a fresh nonce per request", async () => {
    const first = await fetch(`${baseUrl}/health`);
    const second = await fetch(`${baseUrl}/health`);
    const firstCsp = first.headers.get("content-security-policy") ?? "";
    const secondCsp = second.headers.get("content-security-policy") ?? "";
    expect(firstCsp).not.toBe("");
    expect(firstCsp).not.toBe(secondCsp);
  });

  it("returns 405 for non-GET requests on /health", async () => {
    const response = await fetch(`${baseUrl}/health`, { method: "POST" });
    expect(response.status).toBe(405);
    const payload = await response.json();
    expect(payload).toEqual({ error: "Method Not Allowed" });
  });

  it("returns a 404 JSON body for unknown routes", async () => {
    const response = await fetch(`${baseUrl}/does-not-exist`);
    expect(response.status).toBe(404);
    const payload = await response.json();
    expect(payload).toEqual({ error: "Not Found" });
  });

  it("converts a route handler's synchronous throw into a controlled 500 instead of crashing", async () => {
    // A corrupt JSON column (only reachable via tampering/a bug - normal
    // writes always round-trip valid JSON) makes mapResearchTask's JSON.parse
    // throw synchronously inside the research render path. The outer error
    // boundary must turn that into a 500, never an uncaught exception that
    // takes down this member-facing process or hangs the socket.
    db.prepare(`INSERT INTO members (id, email, display_name, risk_tags, stock_tags, show_performance, status, created_at) VALUES ('m1','m1@x.com','M1','[]','[]',1,'active','2026-07-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO research_tasks (id, owner_id, question, status, steps, budget_spent, visibility, created_at) VALUES ('rt_bad','m1','q','done','{not valid json',0,'private','2026-07-01T00:00:00.000Z')`).run();
    const response = await fetch(`${baseUrl}/research/rt_bad`, {
      headers: { "Cf-Access-Authenticated-User-Email": "m1@x.com" }
    });
    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload).toEqual({ error: "内部错误，请稍后重试。" });
    // Server still alive: a follow-up request succeeds.
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });
});
