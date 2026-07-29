import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApiTokenRepository, MemberRepository, migrate, type Member } from "@packages/shared-types";

import { IDENTITY_VARY, NO_SHARED_CACHE } from "./security.js";
import { createPlatformServer } from "./server.js";

/**
 * The guard security.ts's caching paragraph promises (defect N1-a, 2026-07-28):
 * `cache-control: private, no-store` + the identity `Vary` are part of the
 * server-wide baseline, and this file proves it ON THE WIRE, against the real
 * `createPlatformServer` over a real socket - not against a hand-built response
 * object, and not by re-reading the constants the implementation exports.
 *
 * Two properties are asserted, and the second is the one that keeps this test
 * honest a year from now:
 *
 *  1. every response carries the exact wire values - on 200, 303, 401, 403,
 *     404 and 405 alike, HTML pages and JSON APIs alike;
 *  2. the route list is DERIVED FROM THE SERVER'S OWN DISPATCH, not kept by
 *     hand here. `server.ts`'s dispatch chain is parsed for the route handlers
 *     it calls, each handler is resolved to its module, and each module is
 *     parsed for the path literals it matches on.
 *
 * What (2) catches, stated so it can be checked against what the code below
 * actually does (defect G4-a, 2026-07-28 - the previous wording promised more
 * than the parser delivered: it only complained when a module produced ZERO
 * literals, so `pathname.startsWith("/y/")` added next to an existing
 * `pathname === "/x"` would have slipped through unprobed):
 *
 *   - a route module dispatch() calls that has no probe -> fails;
 *   - a new path literal inside an existing module -> fails, when the literal
 *     is compared against `url.pathname`, against a `segments[i]`, against a
 *     local assigned straight from a `segments[i]`, or is a key of an object
 *     literal that one of those indexes / `Object.hasOwn`s / `in`s;
 *   - ANY OTHER way of deciding a route from the path -> also fails, not
 *     because the parser understands it but because `assertPathUsesAreParsable`
 *     rejects every `pathname` / `segments[i]` usage that is not one of the
 *     recognised forms. A regex test, a `switch`, `.match()`, a two-hop
 *     variable: all of them stop the file with "teach the parser about it".
 *
 * What it does NOT catch: a route handler that dispatch() reaches through
 * something other than a `./routes/...` import, and a path literal a module
 * never mentions (one supplied by a helper in another file).
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** Sentinel token for `url.pathname === "/"` (home.ts), which has no segment. */
const ROOT_TOKEN = "(root)";
/** Pseudo-module for the branches server.ts dispatches inline (`/health`). */
const SERVER_MODULE = "server.ts";
/** Pseudo-module for the terminal `notFound(res)` fall-through. */
const FALLBACK_MODULE = "(dispatch fallback)";

// ---------------------------------------------------------------------------
// Enumeration: what routes does the server actually serve?
// ---------------------------------------------------------------------------

/**
 * Reads a source file under apps/platform-app/src with its comments removed, so
 * that a `pathname` mentioned in prose is never mistaken for a routing decision.
 *
 * Only LINE-LEADING comments are stripped, deliberately. A general
 * comment-stripping regex eats code: `/^\/z\//u.test(url.pathname)` contains
 * `\//` - two adjacent slashes - and a naive `//`-to-end-of-line rule deletes
 * the rest of that line, silently hiding a route match (observed while testing
 * this very guard). A comment that starts a line cannot be a regex literal or a
 * string, so this direction can only ever leave too much in, and leaving too
 * much in merely trips the "unrecognised usage" check, loudly.
 */
function readSource(relative: string): string {
  return readFileSync(join(HERE, relative), "utf8")
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gmu, "")
    .replace(/^[ \t]*\/\/[^\n]*/gmu, "");
}

/**
 * The route modules `server.ts`'s `dispatch()` actually calls, in dispatch
 * order. Parsed from the source rather than listed here so that adding a
 * `handleWhateverRoute(...)` call to dispatch immediately makes this file fail
 * for lack of a probe.
 */
function dispatchedModules(): string[] {
  const source = readSource("server.ts");
  const dispatchAt = source.indexOf("function dispatch(");
  expect(dispatchAt, "server.ts must still declare `function dispatch(`").toBeGreaterThan(-1);
  const body = source.slice(dispatchAt);

  const imports = new Map<string, string>();
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(\.\/routes\/[^"]+)"/gu)) {
    const specifier = (match[2] as string).replace(/^\.\//u, "").replace(/\.js$/u, ".ts");
    for (const raw of (match[1] as string).split(",")) {
      const name = raw.trim().replace(/^type\s+/u, "").split(/\s+as\s+/u)[0]?.trim();
      if (name) {
        imports.set(name, specifier);
      }
    }
  }

  // Every function dispatch() calls that came from a ./routes/ import counts,
  // whatever it is named - naming is a convention, and this file must not go
  // blind the day somebody dispatches `serveWhatever(...)`. The handle*Route
  // convention is additionally enforced: one of those that CANNOT be resolved
  // to a routes/ module is a parser failure, not something to skip.
  const modules: string[] = [];
  for (const match of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/gu)) {
    const callee = match[1] as string;
    const specifier = imports.get(callee);
    if (/^handle[A-Za-z]*Route$/u.test(callee)) {
      expect(
        specifier,
        `server.ts dispatches ${callee}(...) but this test cannot resolve it to a routes/ module - teach the parser about it rather than skipping it`
      ).toBeDefined();
    }
    if (specifier && !modules.includes(specifier)) {
      modules.push(specifier);
    }
  }
  expect(modules.length, "no route handlers found in server.ts's dispatch - the parser is broken").toBeGreaterThan(5);
  return modules;
}

/** Resolves `const NAME = "literal";` inside one module's source. */
function stringConst(source: string, name: string): string | undefined {
  const match = new RegExp(`const\\s+${name}\\s*(?::[^=]+)?=\\s*"([^"]*)"`, "u").exec(source);
  return match?.[1];
}

/** Keys of a `const NAME = { ... }` object literal (brace-matched). */
function objectLiteralKeys(source: string, name: string): string[] {
  const declaredAt = new RegExp(`const\\s+${name}\\b`, "u").exec(source)?.index;
  if (declaredAt === undefined) {
    return [];
  }
  const open = source.indexOf("{", declaredAt);
  if (open === -1) {
    return [];
  }
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) {
    return [];
  }
  const keys: string[] = [];
  for (const match of source.slice(open, close).matchAll(/[{,]\s*(?:"([\w-]+)"|([A-Za-z_$][\w-]*))\s*:/gu)) {
    const key = (match[1] ?? match[2]) as string;
    keys.push(key);
  }
  return keys;
}

/**
 * Locals a module assigns STRAIGHT from a path segment, e.g. personal.ts's
 * `const kind = segments[0] as string;` or stock.ts's
 * `const symbol = normalizeStockSymbol(segments[1] as string);`. One hop only:
 * whatever such a local is later compared against is a path literal too, and
 * without this the comparison is invisible (it never mentions `segments`).
 */
function pathDerivedLocals(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$.]*\(\s*)?segments\[\d+\]/gu
  )) {
    names.add(match[1] as string);
  }
  return [...names];
}

/**
 * Every way this parser knows how to read a path decision out of one module.
 * `assertPathUsesAreParsable` below rejects anything that is NOT one of these,
 * which is what makes the file header's promise true: an unrecognised form is
 * an error, never a silent zero contribution.
 *
 * Each entry is anchored at the `pathname` / `segments[i]` occurrence itself;
 * `before` is the text immediately preceding it.
 */
const RECOGNISED_PATHNAME_USES: RegExp[] = [
  /^pathname\.split\(/u,
  /^pathname\s*(?:===|!==)\s*"/u,
  /^pathname\.(?:startsWith|endsWith)\(\s*"/u
];
const RECOGNISED_SEGMENT_USES: RegExp[] = [
  /^segments\[\d+\]\s*(?:===|!==)\s*(?:"|[A-Za-z_$])/u,
  /^segments\[\d+\]\s*(?:as\s+string\s*)?[),;\]]/u,
  /^segments\[\d+\]\s*(?:as\s+string\s*)?\s+in\s+[A-Za-z_$]/u
];

/**
 * Fails with file:line for any `pathname` / `segments[i]` usage the extractor
 * does not understand. This is the tripwire the previous version of this file
 * lacked: its only defence was "a module contributed zero literals", so a new
 * matching style beside an existing recognised one contributed nothing and
 * nobody noticed.
 */
function assertPathUsesAreParsable(relative: string, source: string): void {
  const unrecognised: string[] = [];
  const lineOf = (index: number): number => source.slice(0, index).split("\n").length;

  for (const match of source.matchAll(/\bpathname\b|\bsegments\[\d+\]/gu)) {
    const index = match.index ?? 0;
    const here = source.slice(index);
    const before = source.slice(Math.max(0, index - 24), index);
    const isPathname = (match[0] as string) === "pathname";
    const recognised = isPathname
      ? RECOGNISED_PATHNAME_USES.some((pattern) => pattern.test(here))
      : RECOGNISED_SEGMENT_USES.some((pattern) => pattern.test(here)) ||
        // `READING_PATH_SEGMENTS[segments[0] as string]` - the object-index form.
        /[A-Za-z_$][\w$]*\s*\[\s*$/u.test(before);
    // A `switch` on the path is a matching form this parser cannot read, and it
    // ends in `)` like a harmless value use, so it is rejected explicitly.
    const isSwitchSubject = /\bswitch\s*\(\s*(?:url\.)?$/u.test(before);
    if (!recognised || isSwitchSubject) {
      unrecognised.push(`${relative}:${lineOf(index)} -> ${here.split("\n")[0]?.trim() ?? ""}`);
    }
  }

  expect(
    unrecognised,
    "these decide a route from the path in a way this file cannot read, so it cannot tell whether they are probed - teach the parser about them rather than leaving them unprobed"
  ).toEqual([]);
}

/**
 * The path literals one route module matches on: everything compared against
 * `url.pathname`, a `segments[i]`, or a local assigned from one, plus the keys
 * of any object literal the module indexes with a `segments[i]`
 * (reports.ts's READING_PATH_SEGMENTS) or probes with `Object.hasOwn` /  `in`
 * (personal.ts's PERSONAL_KINDS).
 */
function claimedTokens(relative: string): string[] {
  return tokensFromSource(relative, readSource(relative));
}

function tokensFromSource(relative: string, source: string): string[] {
  assertPathUsesAreParsable(relative, source);
  const tokens = new Set<string>();

  const addPath = (value: string): void => {
    const segment = value.split("/").filter(Boolean)[0];
    tokens.add(segment ?? ROOT_TOKEN);
  };

  for (const match of source.matchAll(/pathname\s*(?:===|!==)\s*"([^"]*)"/gu)) {
    addPath(match[1] as string);
  }
  for (const match of source.matchAll(/pathname\.(?:startsWith|endsWith)\(\s*"([^"]*)"/gu)) {
    addPath(match[1] as string);
  }

  const comparedAgainst = ["segments\\[\\d+\\]", ...pathDerivedLocals(source).map((name) => `\\b${name}\\b`)];
  for (const subject of comparedAgainst) {
    for (const match of source.matchAll(
      new RegExp(`${subject}\\s*(?:as\\s+string\\s*)?(?:===|!==)\\s*(?:"([^"]*)"|([A-Za-z_$][\\w$]*))`, "gu")
    )) {
      if (match[1] !== undefined) {
        tokens.add(match[1]);
        continue;
      }
      const identifier = match[2] as string;
      const value = stringConst(source, identifier);
      expect(
        value,
        `${relative} compares a path segment against \`${identifier}\`, which this test cannot resolve to a string - teach the parser about it rather than skipping it`
      ).toBeDefined();
      if (value !== undefined) {
        tokens.add(value);
      }
    }
  }

  for (const match of source.matchAll(/([A-Za-z_$][\w$]*)\s*\[\s*segments\[\d+\][^\]]*\]/gu)) {
    for (const key of objectLiteralKeys(source, match[1] as string)) {
      tokens.add(key);
    }
  }
  for (const match of source.matchAll(/Object\.hasOwn\(\s*([A-Za-z_$][\w$]*)\s*,/gu)) {
    for (const key of objectLiteralKeys(source, match[1] as string)) {
      tokens.add(key);
    }
  }
  for (const match of source.matchAll(/\bin\s+([A-Z][A-Z_0-9]*)\b/gu)) {
    for (const key of objectLiteralKeys(source, match[1] as string)) {
      tokens.add(key);
    }
  }

  return [...tokens];
}

// ---------------------------------------------------------------------------
// Probes: one real request per route the enumeration finds
// ---------------------------------------------------------------------------

const MEMBER_EMAIL = "cache-probe@example.com";
const MEMBER_ID = "member_cache_probe";
const OTHER_MEMBER_ID = "member_other";

interface Probe {
  /** Route module (or pseudo-module) this request is meant to reach. */
  module: string;
  method: string;
  path: string;
  /** Omit to send the request with NO identity (the 401 shells). */
  anonymous?: boolean;
  /** Send a bearer token instead of the Access email header. */
  bearer?: boolean;
  expectStatus: number;
}

const PROBES: Probe[] = [
  // server.ts's own inline branch + the terminal fall-through.
  { module: SERVER_MODULE, method: "GET", path: "/health", expectStatus: 200 },
  { module: SERVER_MODULE, method: "POST", path: "/health", expectStatus: 405 },
  { module: FALLBACK_MODULE, method: "GET", path: "/no-such-route", expectStatus: 404 },

  // routes/login.ts - the only surface that works without an identity.
  { module: "routes/login.ts", method: "GET", path: "/login", anonymous: true, expectStatus: 200 },
  // A verify POST with no valid code: 401 + the generic refusal (login.ts's
  // anti-enumeration rule), still a login-module response.
  { module: "routes/login.ts", method: "POST", path: "/login/verify", anonymous: true, expectStatus: 401 },
  { module: "routes/login.ts", method: "PUT", path: "/login", anonymous: true, expectStatus: 405 },
  { module: "routes/login.ts", method: "GET", path: "/logout", anonymous: true, expectStatus: 303 },

  // routes/api-strategy.ts - bearer-only JSON writes.
  { module: "routes/api-strategy.ts", method: "POST", path: "/api/theses", anonymous: true, expectStatus: 401 },
  { module: "routes/api-strategy.ts", method: "POST", path: "/api/theses/t1/judgments", bearer: true, expectStatus: 404 },
  { module: "routes/api-strategy.ts", method: "POST", path: "/api/theses/t1/promote", bearer: true, expectStatus: 404 },
  { module: "routes/api-strategy.ts", method: "POST", path: "/api/theses/t1/demote", bearer: true, expectStatus: 404 },
  { module: "routes/api-strategy.ts", method: "POST", path: "/api/rules", bearer: true, expectStatus: 400 },
  { module: "routes/api-strategy.ts", method: "POST", path: "/api/rules/r1/disable", bearer: true, expectStatus: 404 },
  { module: "routes/api-strategy.ts", method: "POST", path: "/api/cards", bearer: true, expectStatus: 400 },
  { module: "routes/api-strategy.ts", method: "POST", path: "/api/cards/c1/promote", bearer: true, expectStatus: 404 },
  { module: "routes/api-strategy.ts", method: "POST", path: "/api/cards/c1/demote", bearer: true, expectStatus: 404 },

  // routes/api-research.ts - identity-gated JSON writes.
  { module: "routes/api-research.ts", method: "POST", path: "/api/research", anonymous: true, expectStatus: 401 },
  { module: "routes/api-research.ts", method: "POST", path: "/api/research/rt1/promote", expectStatus: 404 },
  { module: "routes/api-research.ts", method: "POST", path: "/api/research/rt1/thesis", expectStatus: 404 },

  // routes/review.ts - reading page + confirm endpoint.
  { module: "routes/review.ts", method: "GET", path: "/review/rev1", expectStatus: 404 },
  { module: "routes/review.ts", method: "POST", path: "/api/reviews/rev1/confirm", anonymous: true, expectStatus: 401 },

  // routes/personal.ts - owner-only personal pages.
  { module: "routes/personal.ts", method: "GET", path: "/daily/2026-07-01/me", expectStatus: 404 },
  { module: "routes/personal.ts", method: "GET", path: "/weekly/2026-07-01/me", expectStatus: 404 },
  { module: "routes/personal.ts", method: "GET", path: "/daily/2026-07-01/me?owner=member_other", expectStatus: 403 },
  { module: "routes/personal.ts", method: "GET", path: "/daily/2026-07-01/me", anonymous: true, expectStatus: 401 },

  // routes/reports.ts - list page + the four reading paths.
  { module: "routes/reports.ts", method: "GET", path: "/reports", expectStatus: 200 },
  { module: "routes/reports.ts", method: "GET", path: "/reports", anonymous: true, expectStatus: 401 },
  { module: "routes/reports.ts", method: "GET", path: "/daily/2026-07-01", expectStatus: 404 },
  { module: "routes/reports.ts", method: "GET", path: "/weekly/2026-07-01", expectStatus: 404 },
  { module: "routes/reports.ts", method: "GET", path: "/stock-analysis/2026-07-01", expectStatus: 404 },
  // Owner-scoped 模拟盘快照: refused (403) rather than 404 - defect B1's
  // attribution guard. The most cache-sensitive response in the app.
  { module: "routes/reports.ts", method: "GET", path: "/official-paper/2026-07-01", expectStatus: 403 },

  // The remaining HTML pages.
  { module: "routes/home.ts", method: "GET", path: "/", expectStatus: 200 },
  { module: "routes/news.ts", method: "GET", path: "/news", expectStatus: 200 },
  { module: "routes/paper.ts", method: "GET", path: "/paper", expectStatus: 200 },
  { module: "routes/stock.ts", method: "GET", path: "/stock/AAPL.US", expectStatus: 200 },
  { module: "routes/strategy.ts", method: "GET", path: "/strategy", expectStatus: 200 },
  { module: "routes/member-card.ts", method: "GET", path: `/member/${OTHER_MEMBER_ID}`, expectStatus: 404 },
  // The v7 migration sentinel member-card.ts 404s before it even looks the id
  // up. Found by the strengthened enumeration (G4-a): the module special-cases
  // this path and nothing here had ever asked it for one.
  { module: "routes/member-card.ts", method: "GET", path: "/member/__legacy_system__", expectStatus: 404 },
  // routes/feishu-callback.ts - Feishu's own server calls this, so it is the
  // one route besides /login that must answer WITHOUT an identity. With no
  // signing key configured (this suite sets none) it fails closed at 503,
  // which is still a feishu-callback-module response.
  { module: "routes/feishu-callback.ts", method: "POST", path: "/feishu/card-callback", anonymous: true, expectStatus: 503 },
  { module: "routes/feishu-callback.ts", method: "GET", path: "/feishu/card-callback", anonymous: true, expectStatus: 405 },

  { module: "routes/proposal.ts", method: "GET", path: "/proposal/prop1", expectStatus: 404 },
  { module: "routes/research.ts", method: "GET", path: "/research/rt1", expectStatus: 404 }
];

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

describe("cache headers on every route the server dispatches", () => {
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;
  let db: DatabaseSync;
  let bearerToken: string;
  let repoRoot: string;

  interface Observed {
    status: number;
    cacheControl: string | null;
    vary: string | null;
    body: string;
  }
  const observed = new Map<Probe, Observed>();

  beforeAll(async () => {
    db = memoryDb();
    const member: Member = {
      id: MEMBER_ID,
      email: MEMBER_EMAIL,
      displayName: "缓存探针",
      riskTags: [],
      stockTags: [],
      showPerformance: true,
      status: "active",
      createdAt: "2026-07-01T00:00:00.000Z"
    };
    new MemberRepository(db).upsert(member);
    bearerToken = new ApiTokenRepository(db).issue(member.id, "cache-headers-probe").token;

    // An EMPTY temp root, never the repo (defect G4-b, 2026-07-28). With
    // `repoRoot: process.cwd()` the probes below that expect 404 were reading
    // the real reports/ tree, so they turned red the day anyone generated a
    // report for 2026-07-01 - reproduced by creating reports/daily/2026-07-01.md,
    // reports/weekly/2026-07-01.md and reports/stock-analysis/2026-07-01.md,
    // which flipped all three probes to 200. The cache headers this file is
    // about do not depend on whether a report exists, so the probes should not
    // either; /official-paper's 403 is decided before anything is scanned.
    repoRoot = mkdtempSync(join(tmpdir(), "alphaloop-cache-headers-"));
    server = createPlatformServer({ db, repoRoot, now: () => new Date("2026-07-28T12:00:00.000Z") });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    for (const probe of PROBES) {
      const headers: Record<string, string> = {};
      if (probe.bearer) {
        headers.authorization = `Bearer ${bearerToken}`;
      } else if (!probe.anonymous) {
        headers["Cf-Access-Authenticated-User-Email"] = MEMBER_EMAIL;
      }
      if (probe.method !== "GET") {
        headers["content-type"] = "application/json";
      }
      const response = await fetch(`${baseUrl}${probe.path}`, {
        method: probe.method,
        headers,
        ...(probe.method === "GET" ? {} : { body: "{}" }),
        redirect: "manual"
      });
      observed.set(probe, {
        status: response.status,
        cacheControl: response.headers.get("cache-control"),
        vary: response.headers.get("vary"),
        body: await response.text()
      });
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("probes every route module server.ts dispatches to, plus its inline branches and its fall-through", () => {
    const required = new Set([...dispatchedModules(), SERVER_MODULE, FALLBACK_MODULE]);
    const probed = new Set(PROBES.map((probe) => probe.module));
    expect(probed).toEqual(required);
  });

  it("probes every path literal each dispatched module matches on", () => {
    const probedSegments = new Set<string>();
    for (const probe of PROBES) {
      const pathname = probe.path.split("?")[0] as string;
      const segments = pathname.split("/").filter(Boolean);
      if (segments.length === 0) {
        probedSegments.add(ROOT_TOKEN);
      }
      for (const segment of segments) {
        probedSegments.add(segment);
      }
    }

    const uncovered: string[] = [];
    for (const relative of [...dispatchedModules(), SERVER_MODULE]) {
      const tokens = claimedTokens(relative);
      // A module whose matching style this parser does not understand must
      // fail loudly here rather than silently contributing zero routes.
      expect(tokens.length, `${relative}: no path literals extracted - the parser no longer understands this module`).toBeGreaterThan(0);
      for (const token of tokens) {
        if (!probedSegments.has(token)) {
          uncovered.push(`${relative} -> ${token}`);
        }
      }
    }
    expect(uncovered, "these routes exist but no probe exercises their cache headers").toEqual([]);
  });

  it("sends the exact wire cache-control and vary on every probed response", () => {
    const wrong: string[] = [];
    for (const probe of PROBES) {
      const key = `${probe.method} ${probe.path}${probe.anonymous ? " (anon)" : ""}`;
      const seen = observed.get(probe);
      expect(seen, `no response recorded for ${key}`).toBeDefined();
      if (!seen) {
        continue;
      }
      // Hard-coded wire strings on purpose: asserting against the exported
      // constants would pass even if both drifted together.
      if (seen.cacheControl !== "private, no-store") {
        wrong.push(`${key} -> cache-control: ${seen.cacheControl ?? "(absent)"}`);
      }
      if (seen.vary !== "Cookie, Authorization, Cf-Access-Authenticated-User-Email, Cf-Access-Jwt-Assertion") {
        wrong.push(`${key} -> vary: ${seen.vary ?? "(absent)"}`);
      }
    }
    expect(wrong, "responses missing or weakening the no-shared-cache baseline").toEqual([]);
  });

  it("keeps the exported constants and the wire values in sync", () => {
    expect(NO_SHARED_CACHE).toBe("private, no-store");
    expect(IDENTITY_VARY).toBe("Cookie, Authorization, Cf-Access-Authenticated-User-Email, Cf-Access-Jwt-Assertion");
  });

  it("asserts the headers on success, redirect, 401, 403, 404 and 405 alike", () => {
    const mismatched: string[] = [];
    for (const probe of PROBES) {
      const status = observed.get(probe)?.status;
      if (status !== probe.expectStatus) {
        mismatched.push(`${probe.method} ${probe.path} -> ${status ?? "(none)"} (expected ${probe.expectStatus})`);
      }
    }
    expect(mismatched, "probe expectations drifted from what the server answers").toEqual([]);
    const covered = new Set(PROBES.map((probe) => probe.expectStatus));
    for (const status of [200, 303, 401, 403, 404, 405]) {
      expect(covered.has(status), `no probe exercises a ${status} response`).toBe(true);
    }
  });

  it("actually reaches the handler each probe names instead of falling through to the 404 fall-through", () => {
    const fellThrough: string[] = [];
    for (const probe of PROBES) {
      if (probe.module === FALLBACK_MODULE) {
        expect(observed.get(probe)?.body).toContain('"error": "Not Found"');
        continue;
      }
      if ((observed.get(probe)?.body ?? "").includes('"error": "Not Found"')) {
        fellThrough.push(`${probe.method} ${probe.path} (meant for ${probe.module})`);
      }
    }
    expect(fellThrough, "these probes never reached their route module, so they proved nothing").toEqual([]);
  });
});

/**
 * The enumeration's own guard (G4-a). Route source text IS this parser's input
 * domain, so exercising it with source is not the fixture dishonesty this round
 * is about - but the cases below are still kept honest by being verified
 * against the real modules first: each was reproduced by temporarily editing
 * routes/news.ts and routes/personal.ts and watching the file above go red,
 * then reduced to the snippet here so it stays red forever without a
 * production edit.
 *
 * Without these, "the enumeration is strict" is a claim about code that nothing
 * ever runs against a counter-example - which is how the old version came to
 * promise a strictness it did not have.
 */
describe("the route enumeration refuses what it cannot read", () => {
  const RECOGNISED = `const segments = url.pathname.split("/").filter((s) => s.length > 0);
    if (url.pathname === "/news") { return true; }`;

  it("sees a new top-level path added beside an existing recognised one", () => {
    const tokens = tokensFromSource(
      "probe.ts",
      `${RECOGNISED}\n    if (url.pathname.startsWith("/y/")) { return true; }`
    );
    expect(tokens).toContain("y");
    expect(tokens).toContain("news");
  });

  it("sees a literal compared against a local assigned from a segment", () => {
    const tokens = tokensFromSource(
      "probe.ts",
      `${RECOGNISED}\n    const kind = segments[0] as string;\n    if (kind === "zzz") { return true; }`
    );
    expect(tokens).toContain("zzz");
  });

  it("refuses a regex match on the path rather than contributing nothing", () => {
    expect(() =>
      tokensFromSource("probe.ts", `${RECOGNISED}\n    if (/^\\/z\\//u.test(url.pathname)) { return true; }`)
    ).toThrow(/unrecognised usage|cannot read/iu);
  });

  it("refuses a switch on a path segment rather than contributing nothing", () => {
    expect(() =>
      tokensFromSource("probe.ts", `${RECOGNISED}\n    switch (segments[0]) { case "zzz": return true; }`)
    ).toThrow(/unrecognised usage|cannot read/iu);
  });

  it("does not eat a line of routing code while stripping comments", () => {
    // The regex literal ends in `\//`, two adjacent slashes: a naive
    // comment-stripper deletes the rest of the line and the usage vanishes.
    const source = readSource("routes/news.ts");
    expect(source).toContain('url.pathname !== "/news"');
  });
});
