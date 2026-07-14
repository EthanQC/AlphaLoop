import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApiTokenRepository, MemberRepository, migrate } from "@packages/shared-types";

import { createPlatformServer } from "../server.js";

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function reportsDir(repoRoot: string, type: string): string {
  return join(repoRoot, "reports", type);
}

function writeReport(repoRoot: string, type: string, filename: string, content: string): void {
  const dir = reportsDir(repoRoot, type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, "utf8");
}

describe("reports routes", () => {
  let repoRoot: string;
  let db: DatabaseSync;
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;
  let token: string;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "platform-app-reports-route-"));
    db = memoryDb();
    const member = {
      id: "member_1",
      email: "member1@example.com",
      displayName: "Member One",
      riskTags: [],
      stockTags: [],
      showPerformance: true,
      status: "active" as const,
      createdAt: "2026-07-01T00:00:00.000Z"
    };
    new MemberRepository(db).upsert(member);
    token = new ApiTokenRepository(db).issue(member.id, "test").token;

    // Fixed clock (rather than the real wall clock) so the freshness
    // assertions below ("最新" for today's date, "延迟" for an older one)
    // are deterministic regardless of what day this suite actually runs on.
    // 2026-07-14T12:00:00Z is 2026-07-14 20:00 in Asia/Shanghai.
    server = createPlatformServer({ db, repoRoot, now: () => new Date("2026-07-14T12:00:00Z") });
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

  function authed(path: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  }

  describe("GET /reports", () => {
    it("returns 401 without any identity", async () => {
      const response = await fetch(`${baseUrl}/reports`);
      expect(response.status).toBe(401);
      const body = await response.text();
      expect(body).toContain("未获授权");
    });

    it("returns 200 with the Cf-Access-Authenticated-User-Email header for an active member", async () => {
      const response = await fetch(`${baseUrl}/reports`, {
        headers: { "cf-access-authenticated-user-email": "member1@example.com" }
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
    });

    it("returns 200 with a valid bearer token and lists a scanned report as a card", async () => {
      writeReport(repoRoot, "daily", "2026-06-19.md", "# OpenClaw 日报 2026-06-19\n\n窗口内容。\n");

      const response = await authed("/reports");
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("2026-06-19");
      expect(body).toContain("OpenClaw 日报 2026-06-19");
      expect(body).toContain("历史存档");
      expect(body).toContain("日报");
    });

    it("renders the disabled 研判/复盘 chips labeled with their future phase", async () => {
      const response = await authed("/reports");
      const body = await response.text();
      expect(body).toContain("研判");
      expect(body).toContain("P8 上线");
      expect(body).toContain("复盘");
      expect(body).toContain("P9 上线");
    });

    it("filters by ?type=", async () => {
      writeReport(repoRoot, "daily", "2026-06-19.md", "# 日报标题\n\n内容。\n");
      writeReport(repoRoot, "weekly", "2026-05-25.md", "# 周报标题\n\n内容。\n");

      const response = await authed("/reports?type=weekly");
      const body = await response.text();
      expect(body).toContain("周报标题");
      expect(body).not.toContain("日报标题");
    });

    it("returns 405 for non-GET requests", async () => {
      const response = await fetch(`${baseUrl}/reports`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` }
      });
      expect(response.status).toBe(405);
    });
  });

  describe("GET /daily/<date> and friends (reading pages)", () => {
    it("returns 401 without identity", async () => {
      const response = await fetch(`${baseUrl}/daily/2026-06-19`);
      expect(response.status).toBe(401);
    });

    it("renders a real fixture report: summary, TOC, body, sources, and freshness", async () => {
      writeReport(
        repoRoot,
        "daily",
        "2026-06-19.md",
        [
          "# OpenClaw 日报 2026-06-19",
          "",
          "窗口内的摘要首段文本。",
          "",
          "## 今日结论",
          "",
          "市场信号见[原文](https://example.com/source)。",
          "",
          "## 风险与异常",
          "",
          "没有风险。"
        ].join("\n")
      );

      const response = await authed("/daily/2026-06-19");
      expect(response.status).toBe(200);
      const body = await response.text();

      expect(body).toContain("窗口内的摘要首段文本。"); // summary card
      expect(body).toContain('href="#今日结论"'); // TOC anchor
      expect(body).toContain('<h2 id="今日结论">今日结论</h2>'); // body heading with matching id
      expect(body).toContain(
        '<a href="https://example.com/source" rel="noreferrer" target="_blank">原文</a>'
      ); // sources list entry
      expect(body).toContain("历史存档"); // legacy archive banner
      expect(body).toContain("旧格式无置信度");
      expect(body).toContain("延迟"); // not today -> delayed freshness
    });

    it("marks a report dated today (Beijing time) as 最新", async () => {
      writeReport(repoRoot, "daily", "2026-07-14.md", "# 今日日报\n\n内容。\n");

      const response = await authed("/daily/2026-07-14");
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain("最新");
    });

    it("returns a Chinese 404 page for a well-formed but missing date", async () => {
      const response = await authed("/daily/2099-01-01");
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).toContain("未找到");
    });

    it("returns 404 (not a crash or 200) for a path-traversal-shaped date param", async () => {
      // `new URL(...)` (both here and inside Node's own `fetch`) applies
      // WHATWG dot-segment removal to a LITERAL `..` in the path before this
      // handler ever sees it - `/daily/../../etc/passwd` collapses to
      // `/etc/passwd` at parse time and never even matches this route. The
      // percent-encoded form below is NOT decoded by `.pathname` (encoded
      // slashes aren't path separators), so it DOES survive as a literal,
      // non-date `segments[1]` - exactly the shape the date regex guard
      // exists to reject before any filesystem lookup happens.
      const response = await authed("/daily/..%2F..%2Fetc%2Fpasswd");
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).toContain("未找到");
    });

    it("respects each type's own directory (weekly/stock-analysis/official-paper)", async () => {
      writeReport(repoRoot, "weekly", "2026-05-25.md", "# 周报 05-25\n\n周报内容。\n");
      writeReport(repoRoot, "stock-analysis", "2026-06-19.md", "# 个股分析 06-19\n\n分析内容。\n");
      writeReport(
        repoRoot,
        "official-paper",
        "2026-06-17-post-open.md",
        "# 模拟盘收支变化 06-17\n\n收支内容。\n"
      );

      const weekly = await authed("/weekly/2026-05-25");
      const stock = await authed("/stock-analysis/2026-06-19");
      const paper = await authed("/official-paper/2026-06-17");

      expect(weekly.status).toBe(200);
      expect(await weekly.text()).toContain("周报内容");
      expect(stock.status).toBe(200);
      expect(await stock.text()).toContain("分析内容");
      expect(paper.status).toBe(200);
      expect(await paper.text()).toContain("收支内容");
    });

    it("returns 405 for non-GET requests", async () => {
      const response = await fetch(`${baseUrl}/daily/2026-06-19`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` }
      });
      expect(response.status).toBe(405);
    });
  });
});
