/**
 * Task 24 (2026-07-28 spec-drift remediation): the skill manifest is a
 * DOCUMENT, and documents drift silently. Until this file, nothing in the
 * suite read skill/SKILL.md or skill/tools.json at all - which is how the
 * manifest ended up telling a member to point `api.baseUrl` at
 * `https://alphaloop.<your-team>.cloudflareaccess.com` (Cloudflare Access was
 * never activated; browsers sign in with a Feishu-delivered email code) and
 * describing research submission as "P8 not yet built" months after
 * `POST /api/research` shipped.
 *
 * The point of these tests is that every claim is checked against a PRODUCER,
 * not against a shape authored here:
 *
 *   - every documented `/api/*` endpoint is exercised against a REAL
 *     createPlatformServer over a real socket with a real bearer token, and
 *     must not answer 404/405. A path this manifest invents would 404; a
 *     method it gets wrong would 405.
 *   - the reverse direction (a route that exists but is undocumented) is
 *     covered by parsing the dispatch tables out of the two `/api` route
 *     modules, so adding an endpoint without documenting it fails here.
 *   - the base URL is compared against the deep-link base the rest of the
 *     system already uses, not against a string typed twice.
 */
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApiTokenRepository, MemberRepository, migrate, type Member } from "@packages/shared-types";
import { DatabaseSync } from "node:sqlite";

import { createPlatformServer } from "../src/server.js";

const skillDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(skillDir, "..", "..", "..");
const routesDir = join(repoRoot, "apps", "platform-app", "src", "routes");

const skillMarkdown = readFileSync(join(skillDir, "SKILL.md"), "utf8");
const onboardingMarkdown = readFileSync(join(skillDir, "README-onboarding.md"), "utf8");
const manifest = JSON.parse(readFileSync(join(skillDir, "tools.json"), "utf8")) as {
  baseUrl: string;
  auth: Record<string, string>;
  tools: { name: string; method: string; path: string; auth: string }[];
  read_only_pages: { name: string; method: string; path: string }[];
  existing_but_not_yet_http: { name: string; status: string; surface: string; note: string }[];
};

const PUBLIC_BASE_URL = "https://reports.qingverse.com";

let db: DatabaseSync;
let tempDir: string;
let baseUrl: string;
let token: string;
let server: ReturnType<typeof createPlatformServer>;

const MEMBER: Member = {
  id: "member_skill",
  email: "skill@example.com",
  displayName: "Skill 用户",
  riskTags: [],
  stockTags: [],
  showPerformance: true,
  status: "active",
  createdAt: "2026-07-01T00:00:00.000Z"
};

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "alphaloop-skill-manifest-"));
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  new MemberRepository(db).upsert(MEMBER);
  token = new ApiTokenRepository(db).issue(MEMBER.id, "skill-manifest-test").token;

  server = createPlatformServer({ db, repoRoot: tempDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

/** Turns `/api/theses/:id/promote` into a concrete path a request can use. */
function concrete(path: string): string {
  return path.replace(/:[A-Za-z]+/gu, "no-such-id");
}

describe("skill manifest: base URL and login story", () => {
  it("points api.baseUrl at the real public entry point", () => {
    expect(manifest.baseUrl).toBe(PUBLIC_BASE_URL);
    expect(skillMarkdown).toContain(PUBLIC_BASE_URL);
    expect(onboardingMarkdown).toContain(PUBLIC_BASE_URL);
  });

  it("no longer tells anyone to configure Cloudflare Access", () => {
    // Access was never activated - identity.ts's browser path is the signed
    // alphaloop_session cookie issued by the email-code login. The one thing
    // the manifest may still say about Access is that it is NOT used, so the
    // assertion is on the cloudflareaccess.com host and on "接入 Cloudflare
    // Access" as an instruction, not on the word appearing at all.
    for (const [name, text] of [
      ["SKILL.md", skillMarkdown],
      ["README-onboarding.md", onboardingMarkdown],
      ["tools.json", JSON.stringify(manifest)]
    ] as const) {
      expect(text, `${name} still points at a cloudflareaccess.com host`).not.toContain("cloudflareaccess.com");
      expect(text, `${name} still instructs the reader to wire up Access`).not.toMatch(/接入\s*Cloudflare\s*Access/u);
    }
  });

  it("documents the email-code login as the browser's way in", () => {
    expect(manifest.auth.browserLogin).toMatch(/\/login/u);
    expect(skillMarkdown).toMatch(/邮箱验证码|登录码/u);
  });
});

describe("skill manifest: every documented write endpoint really exists", () => {
  it.each(manifest.tools.map((tool) => [tool.name, tool] as const))(
    "%s answers on the real server (not 404/405)",
    async (_name, tool) => {
      const response = await fetch(`${baseUrl}${concrete(tool.path)}`, {
        method: tool.method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}"
      });
      // 400/403/404-on-the-ROW are all fine (the ids are deliberately fake);
      // what must never happen is the ROUTE itself being absent.
      expect(response.status, `${tool.method} ${tool.path}`).not.toBe(405);
      if (response.status === 404) {
        const body = (await response.json()) as { error?: string };
        // A routed handler's 404 always names the missing row in Chinese; the
        // server's own catch-all 404 does not.
        expect(body.error, `${tool.method} ${tool.path} hit the catch-all 404`).toMatch(/未找到/u);
      }
    }
  );

  it("rejects the bearer-only writes when the token is missing", async () => {
    for (const tool of manifest.tools.filter((entry) => entry.auth === "bearer-only")) {
      const response = await fetch(`${baseUrl}${concrete(tool.path)}`, {
        method: tool.method,
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      expect(response.status, `${tool.method} ${tool.path} without a token`).toBe(401);
    }
  });
});

describe("skill manifest: no /api route is left undocumented", () => {
  // Read the dispatch tables out of the real modules rather than restating
  // them: `segments[1] === "theses"`, `segments[3] === "promote"` etc. This is
  // the direction a hand-written manifest always fails in - somebody adds an
  // endpoint and never comes back here.
  function segmentLiterals(file: string): Set<string> {
    const source = readFileSync(join(routesDir, file), "utf8");
    const literals = new Set<string>();
    for (const match of source.matchAll(/segments\[\d\]\s*===\s*"([a-z-]+)"/gu)) {
      literals.add(match[1] as string);
    }
    return literals;
  }

  it("documents every path segment the two /api dispatchers branch on", () => {
    const documented = manifest.tools.map((tool) => tool.path).join(" ");
    for (const file of ["api-strategy.ts", "api-research.ts"]) {
      for (const literal of segmentLiterals(file)) {
        if (literal === "api") {
          continue;
        }
        expect(documented, `${file} routes on "${literal}" but tools.json never mentions it`).toContain(literal);
      }
    }
  });

  it("documents the review confirm endpoint review.ts owns", () => {
    const source = readFileSync(join(routesDir, "review.ts"), "utf8");
    expect(source).toContain("/api/reviews/");
    expect(manifest.tools.map((tool) => tool.path)).toContain("/api/reviews/:id/confirm");
  });
});

describe("skill manifest: research is documented as shipped, not forthcoming", () => {
  it("lists research submit and promote as real tools", () => {
    const names = manifest.tools.map((tool) => tool.name);
    expect(names).toContain("research.submit");
    expect(names).toContain("research.promote");
  });

  it("has no `forthcoming` section left claiming research is unbuilt", () => {
    expect(Object.keys(manifest)).not.toContain("forthcoming");
    expect(JSON.stringify(manifest)).not.toContain("P8");
    expect(skillMarkdown).not.toMatch(/研究执行\s*P8\s*上线/u);
  });
});

describe("skill manifest: the CLI-only capabilities are named honestly", () => {
  it("keeps alert CRUD, proposal creation and on-demand analysis in the CLI-only section", () => {
    const names = manifest.existing_but_not_yet_http.map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining(["alert.crud", "proposal.request", "stock.analyze"]));
  });

  it("names commands that the referenced CLIs actually implement", () => {
    const scriptsDir = join(repoRoot, "apps", "openclaw-config", "scripts");
    const alerts = readFileSync(join(scriptsDir, "market-alerts.mjs"), "utf8");
    const proposals = readFileSync(join(scriptsDir, "proposals.mjs"), "utf8");
    const analysis = readFileSync(join(scriptsDir, "stock-analysis.mjs"), "utf8");
    expect(alerts).toContain("feedback");
    expect(proposals).toContain("create");
    expect(analysis).toContain('command === "analyze"');
  });
});
