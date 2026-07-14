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

  beforeEach(async () => {
    const db = memoryDb();
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

  // TODO remove alongside server.ts's /__preview route when real pages land
  // (Task 5) — this only pins that the temporary route wires renderPage up
  // correctly (layout.test.ts covers renderPage's own behavior in depth).
  describe("GET /__preview (temporary, Task 3 only)", () => {
    it("renders the layout engine's HTML document", async () => {
      const response = await fetch(`${baseUrl}/__preview`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      const body = await response.text();
      expect(body).toMatch(/^<!doctype html>/iu);
      expect(body).toContain('class="sidenav"');
      expect(body).toContain('class="tabs"');
    });

    it("carries the CSP nonce from the response header onto its one inline script", async () => {
      const response = await fetch(`${baseUrl}/__preview`);
      const csp = response.headers.get("content-security-policy") ?? "";
      const nonceMatch = /nonce-([^']+)/u.exec(csp);
      expect(nonceMatch).not.toBeNull();
      const body = await response.text();
      expect(body).toContain(`nonce="${nonceMatch?.[1]}"`);
    });

    it("renders the degradation banner when ?degraded=1", async () => {
      const response = await fetch(`${baseUrl}/__preview?degraded=1`);
      const body = await response.text();
      expect(body).toContain("数据降级提示");
    });

    it("omits the degradation banner by default", async () => {
      const response = await fetch(`${baseUrl}/__preview`);
      const body = await response.text();
      expect(body).not.toContain("数据降级提示");
    });

    it("forces dark theme via the test-only ?theme=dark param", async () => {
      const response = await fetch(`${baseUrl}/__preview?theme=dark`);
      const body = await response.text();
      expect(body).toContain("localStorage.setItem('alphaloop-theme', \"dark\")");
    });

    it("returns 405 for non-GET requests", async () => {
      const response = await fetch(`${baseUrl}/__preview`, { method: "POST" });
      expect(response.status).toBe(405);
    });
  });
});
