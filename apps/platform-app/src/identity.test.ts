import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiTokenRepository, MemberRepository, migrate, type Member } from "@packages/shared-types";

import type { Jwk } from "./access-jwt.js";
import {
  __resetAccessJwtStateForTests,
  __setAccessJwksFetcherForTests,
  getAccessJwtMode,
  primeAccessJwtCache,
  renderUnauthorizedPage,
  resolveIdentity,
  verifyAccessJwt
} from "./identity.js";
import {
  SESSION_COOKIE_NAME,
  __resetSessionWarningsForTests,
  createSessionToken
} from "./session.js";

// vitest.config.ts pins a fixed PLATFORM_SESSION_SECRET for the whole suite;
// the one test below that removes it restores this value afterwards.
const SAVED_SESSION_SECRET = process.env.PLATFORM_SESSION_SECRET;

// Access-verification env handling. The pre-P10 resolveIdentity tests below
// depend on the email header being trusted without a JWT, which under the P10
// contract requires the explicit CF_ACCESS_DISABLED=true escape (mode
// "disabled"). So the shared baseline sets it; enforce-mode and fail-closed
// tests override via enforceEnv() / failClosedEnv(). (The wider suite gets the
// same default from vitest.config.ts's `env`, so route tests that authenticate
// via the header keep working without touching each file.)
const SAVED_TEAM_DOMAIN = process.env.CF_ACCESS_TEAM_DOMAIN;
const SAVED_AUD = process.env.CF_ACCESS_AUD;
const SAVED_DISABLED = process.env.CF_ACCESS_DISABLED;

function clearAccessEnv(): void {
  delete process.env.CF_ACCESS_TEAM_DOMAIN;
  delete process.env.CF_ACCESS_AUD;
  delete process.env.CF_ACCESS_DISABLED;
}

/** ENFORCE mode: both vars set, escape hatch off. */
function enforceEnv(): void {
  clearAccessEnv();
  process.env.CF_ACCESS_TEAM_DOMAIN = ACCESS_TEAM;
  process.env.CF_ACCESS_AUD = ACCESS_AUD;
}

/** FAIL-CLOSED mode: nothing configured, escape hatch off. */
function failClosedEnv(): void {
  clearAccessEnv();
}

beforeEach(() => {
  // DISABLED baseline (pre-P10 blind header trust) for the plain
  // resolveIdentity tests.
  clearAccessEnv();
  process.env.CF_ACCESS_DISABLED = "true";
  __resetAccessJwtStateForTests();
  __setAccessJwksFetcherForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  clearAccessEnv();
  if (SAVED_TEAM_DOMAIN !== undefined) {
    process.env.CF_ACCESS_TEAM_DOMAIN = SAVED_TEAM_DOMAIN;
  }
  if (SAVED_AUD !== undefined) {
    process.env.CF_ACCESS_AUD = SAVED_AUD;
  }
  if (SAVED_DISABLED !== undefined) {
    process.env.CF_ACCESS_DISABLED = SAVED_DISABLED;
  }
  __resetAccessJwtStateForTests();
  __setAccessJwksFetcherForTests();
});

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

function req(headers: Record<string, string | string[] | undefined>) {
  return { headers };
}

describe("resolveIdentity", () => {
  it("resolves a member via a valid Authorization: Bearer token", () => {
    const db = memoryDb();
    const member = makeMember();
    new MemberRepository(db).upsert(member);
    const { token } = new ApiTokenRepository(db).issue(member.id, "cli");

    const resolved = resolveIdentity(req({ authorization: `Bearer ${token}` }), db);

    expect(resolved).toEqual(member);
  });

  it("returns null for a revoked token", () => {
    const db = memoryDb();
    const member = makeMember();
    new MemberRepository(db).upsert(member);
    const tokens = new ApiTokenRepository(db);
    const { id, token } = tokens.issue(member.id, "cli");
    tokens.revoke(id);

    expect(resolveIdentity(req({ authorization: `Bearer ${token}` }), db)).toBeNull();
  });

  it("returns null when the token's owning member has been revoked", () => {
    const db = memoryDb();
    const member = makeMember();
    new MemberRepository(db).upsert(member);
    const { token } = new ApiTokenRepository(db).issue(member.id, "cli");
    new MemberRepository(db).upsert({ ...member, status: "revoked" });

    expect(resolveIdentity(req({ authorization: `Bearer ${token}` }), db)).toBeNull();
  });

  it("never resolves __legacy_system__ via bearer, even if it somehow held an active token", () => {
    // Defense-in-depth pin: in production this row's status is always
    // 'revoked' (see database.ts's v3 migration), which already excludes it
    // from ApiTokenRepository.verify's status='active' filter. This test
    // constructs the row with status FORCED to 'active' - bypassing that
    // safety net entirely - to prove resolveIdentity's own explicit
    // id === '__legacy_system__' guard is what blocks it, not a coincidence
    // of the status filter. Without that guard, this test fails.
    const db = memoryDb();
    const legacy = makeMember({
      id: "__legacy_system__",
      email: "__legacy_system__@alphaloop.invalid",
      displayName: "Legacy System (migration placeholder)",
      status: "active"
    });
    new MemberRepository(db).upsert(legacy);
    const { token } = new ApiTokenRepository(db).issue(legacy.id, "cli");

    expect(resolveIdentity(req({ authorization: `Bearer ${token}` }), db)).toBeNull();
  });

  it("never resolves __legacy_system__ via the Access header, even if it somehow was active", () => {
    const db = memoryDb();
    const legacy = makeMember({
      id: "__legacy_system__",
      email: "__legacy_system__@alphaloop.invalid",
      displayName: "Legacy System (migration placeholder)",
      status: "active"
    });
    new MemberRepository(db).upsert(legacy);

    expect(
      resolveIdentity(req({ "cf-access-authenticated-user-email": legacy.email }), db)
    ).toBeNull();
  });

  it("returns null for an unknown bearer token", () => {
    const db = memoryDb();
    expect(resolveIdentity(req({ authorization: "Bearer not-a-real-token" }), db)).toBeNull();
  });

  it("ignores a malformed Authorization header (no Bearer prefix)", () => {
    const db = memoryDb();
    const member = makeMember();
    new MemberRepository(db).upsert(member);
    const { token } = new ApiTokenRepository(db).issue(member.id, "cli");

    expect(resolveIdentity(req({ authorization: token }), db)).toBeNull();
  });

  it("falls back to Cf-Access-Authenticated-User-Email when no bearer token is present (disabled mode)", () => {
    const db = memoryDb();
    const member = makeMember();
    new MemberRepository(db).upsert(member);

    const resolved = resolveIdentity(
      req({ "cf-access-authenticated-user-email": member.email }),
      db
    );

    expect(resolved).toEqual(member);
  });

  it("header path rejects an inactive member even though getByEmail itself doesn't filter status", () => {
    const db = memoryDb();
    const member = makeMember({ status: "revoked" });
    new MemberRepository(db).upsert(member);

    expect(
      resolveIdentity(req({ "cf-access-authenticated-user-email": member.email }), db)
    ).toBeNull();
  });

  it("header path returns null for an email with no matching member", () => {
    const db = memoryDb();
    expect(
      resolveIdentity(req({ "cf-access-authenticated-user-email": "nobody@example.com" }), db)
    ).toBeNull();
  });

  it("prefers a valid bearer token over the Access header when both are present", () => {
    const db = memoryDb();
    const bearerMember = makeMember({ id: "member_bearer", email: "bearer@example.com" });
    const headerMember = makeMember({ id: "member_header", email: "header@example.com" });
    new MemberRepository(db).upsert(bearerMember);
    new MemberRepository(db).upsert(headerMember);
    const { token } = new ApiTokenRepository(db).issue(bearerMember.id, "cli");

    const resolved = resolveIdentity(
      req({ authorization: `Bearer ${token}`, "cf-access-authenticated-user-email": headerMember.email }),
      db
    );

    expect(resolved).toEqual(bearerMember);
  });

  it("returns null when neither a bearer token nor the Access header is present", () => {
    const db = memoryDb();
    expect(resolveIdentity(req({}), db)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Session cookie path (2026-07-27, the email-code login)
// ---------------------------------------------------------------------------
// The cookie's own crypto is pinned in session.test.ts; these cases pin the
// half that must live HERE - that a valid cookie resolves to the member row,
// that the row is re-read (so revocation bites immediately), and that adding
// this path did not disturb the two that already existed. Wall-clock expiries
// on purpose: resolveIdentity has no injectable clock, by design.

function sessionHeaders(memberId: string, expiresAtMs: number = Date.now() + 60_000) {
  return { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken(memberId, expiresAtMs) ?? ""}` };
}

describe("resolveIdentity via the session cookie", () => {
  it("resolves the member named by a valid signed cookie", () => {
    const db = memoryDb();
    const member = makeMember();
    new MemberRepository(db).upsert(member);

    expect(resolveIdentity(req(sessionHeaders(member.id)), db)).toEqual(member);
  });

  it("re-reads the member row: a revoked member's live cookie stops resolving", () => {
    const db = memoryDb();
    const member = makeMember();
    new MemberRepository(db).upsert(member);
    const headers = sessionHeaders(member.id);
    expect(resolveIdentity(req(headers), db)).toEqual(member);

    new MemberRepository(db).upsert({ ...member, status: "revoked" });

    expect(resolveIdentity(req(headers), db)).toBeNull();
  });

  it("returns null for a cookie naming a member that does not exist", () => {
    const db = memoryDb();
    expect(resolveIdentity(req(sessionHeaders("member_ghost")), db)).toBeNull();
  });

  it("returns null for an expired cookie", () => {
    const db = memoryDb();
    const member = makeMember();
    new MemberRepository(db).upsert(member);

    expect(resolveIdentity(req(sessionHeaders(member.id, Date.now() - 1000)), db)).toBeNull();
  });

  it("returns null for a cookie whose signature does not check out", () => {
    const db = memoryDb();
    const member = makeMember();
    new MemberRepository(db).upsert(member);
    const valid = createSessionToken(member.id, Date.now() + 60_000) as string;
    const [version, payload] = valid.split(".") as [string, string];

    expect(
      resolveIdentity(req({ cookie: `${SESSION_COOKIE_NAME}=${version}.${payload}.AAAA` }), db)
    ).toBeNull();
    expect(resolveIdentity(req({ cookie: `${SESSION_COOKIE_NAME}=garbage` }), db)).toBeNull();
  });

  it("never resolves __legacy_system__ from a cookie, even if the row were active", () => {
    const db = memoryDb();
    const legacy = makeMember({
      id: "__legacy_system__",
      email: "__legacy_system__@alphaloop.invalid",
      displayName: "Legacy System (migration placeholder)",
      status: "active"
    });
    new MemberRepository(db).upsert(legacy);

    expect(resolveIdentity(req(sessionHeaders(legacy.id)), db)).toBeNull();
  });

  it("loses to a valid bearer token when both are present (bearer stays first)", () => {
    const db = memoryDb();
    const bearerMember = makeMember({ id: "member_bearer", email: "bearer@example.com" });
    const cookieMember = makeMember({ id: "member_cookie", email: "cookie@example.com" });
    new MemberRepository(db).upsert(bearerMember);
    new MemberRepository(db).upsert(cookieMember);
    const { token } = new ApiTokenRepository(db).issue(bearerMember.id, "cli");

    const resolved = resolveIdentity(
      req({ authorization: `Bearer ${token}`, ...sessionHeaders(cookieMember.id) }),
      db
    );

    expect(resolved).toEqual(bearerMember);
  });

  it("wins over the Access email header when both are present (cookie before header)", () => {
    const db = memoryDb();
    const cookieMember = makeMember({ id: "member_cookie", email: "cookie@example.com" });
    const headerMember = makeMember({ id: "member_header", email: "header@example.com" });
    new MemberRepository(db).upsert(cookieMember);
    new MemberRepository(db).upsert(headerMember);

    const resolved = resolveIdentity(
      req({
        ...sessionHeaders(cookieMember.id),
        // beforeEach put the Access verifier in "disabled" mode, so this
        // header WOULD otherwise resolve on its own.
        "cf-access-authenticated-user-email": headerMember.email
      }),
      db
    );

    expect(resolved).toEqual(cookieMember);
  });

  it("falls through to the Access header when the cookie is junk (one bad path does not poison the chain)", () => {
    const db = memoryDb();
    const member = makeMember();
    new MemberRepository(db).upsert(member);

    const resolved = resolveIdentity(
      req({
        cookie: `${SESSION_COOKIE_NAME}=not-a-real-token`,
        "cf-access-authenticated-user-email": member.email
      }),
      db
    );

    expect(resolved).toEqual(member);
  });

  it("fails closed when PLATFORM_SESSION_SECRET is unset", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = memoryDb();
    const member = makeMember();
    new MemberRepository(db).upsert(member);
    const headers = sessionHeaders(member.id);
    expect(resolveIdentity(req(headers), db)).toEqual(member);

    delete process.env.PLATFORM_SESSION_SECRET;
    __resetSessionWarningsForTests();
    try {
      expect(resolveIdentity(req(headers), db)).toBeNull();
    } finally {
      process.env.PLATFORM_SESSION_SECRET = SAVED_SESSION_SECRET;
      __resetSessionWarningsForTests();
    }
  });
});

// ---------------------------------------------------------------------------
// Cloudflare Access JWT verification (P10)
// ---------------------------------------------------------------------------
// A locally-generated RSA (and, for one case, EC) keypair plays the role of
// Access's signing key; the JWKS "endpoint" is an injected async fetcher (no
// network in tests). Enforce-mode verifications read from the in-memory JWKS
// cache, so tests await primeAccessJwtCache() (the same warm-up index.ts runs
// at startup) before the synchronous verifyAccessJwt call.

const ACCESS_KID = "test-key-1";
const ACCESS_ES_KID = "test-key-ec-1";
const ACCESS_TEAM = "myteam";
const ACCESS_ISSUER = `https://${ACCESS_TEAM}.cloudflareaccess.com`;
const ACCESS_JWKS_URL = `${ACCESS_ISSUER}/cdn-cgi/access/certs`;
const ACCESS_AUD = "aud-tag-0123456789abcdef";
const ACCESS_EMAIL = "member1@example.com";

const accessKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const strangerKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const accessEcKeyPair = generateKeyPairSync("ec", { namedCurve: "P-256" });

function jwksKeys(
  entries: Array<{ key: KeyObject; kid: string; alg?: string }> = [
    { key: accessKeyPair.publicKey, kid: ACCESS_KID }
  ]
): Jwk[] {
  return entries.map(({ key, kid, alg }) => ({
    ...(key.export({ format: "jwk" }) as Record<string, unknown>),
    kid,
    use: "sig",
    alg: alg ?? "RS256"
  })) as Jwk[];
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Hand-built RS256 JWT mirroring the claims Access mints. */
function buildJwt(
  options: {
    header?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    signWith?: KeyObject;
  } = {}
): string {
  const header = { alg: "RS256", typ: "JWT", kid: ACCESS_KID, ...options.header };
  const payload = {
    aud: [ACCESS_AUD],
    iss: ACCESS_ISSUER,
    email: ACCESS_EMAIL,
    exp: nowSeconds() + 600,
    nbf: nowSeconds() - 60,
    iat: nowSeconds(),
    sub: "access-user-sub",
    ...options.payload
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = cryptoSign(
    "RSA-SHA256",
    Buffer.from(signingInput, "utf8"),
    options.signWith ?? accessKeyPair.privateKey
  );
  return `${signingInput}.${signature.toString("base64url")}`;
}

/** Hand-built ES256 JWT (raw R||S signature, per JWS). */
function buildEsJwt(): string {
  const header = { alg: "ES256", typ: "JWT", kid: ACCESS_ES_KID };
  const payload = {
    aud: [ACCESS_AUD],
    iss: ACCESS_ISSUER,
    email: ACCESS_EMAIL,
    exp: nowSeconds() + 600,
    nbf: nowSeconds() - 60,
    iat: nowSeconds()
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = cryptoSign("sha256", Buffer.from(signingInput, "utf8"), {
    key: accessEcKeyPair.privateKey,
    dsaEncoding: "ieee-p1363"
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

/** `null` omits the corresponding header entirely. */
function accessHeaders(jwt: string | null, email: string | null = ACCESS_EMAIL) {
  const headers: Record<string, string> = {};
  if (jwt !== null) {
    headers["cf-access-jwt-assertion"] = jwt;
  }
  if (email !== null) {
    headers["cf-access-authenticated-user-email"] = email;
  }
  return headers;
}

/**
 * Installs an async JWKS fetcher returning the given key sets in order (the
 * last repeats). A function response is invoked, so it can throw to simulate a
 * network failure. Returns the list of fetched URLs for call-count asserts.
 */
function installJwksFetcher(...responses: Array<Jwk[] | (() => Jwk[])>): { calls: string[] } {
  const calls: string[] = [];
  __setAccessJwksFetcherForTests(async (url) => {
    calls.push(url);
    const response = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (response === undefined) {
      throw new Error("test fetcher has no response configured");
    }
    return typeof response === "function" ? response() : response;
  });
  return { calls };
}

describe("getAccessJwtMode", () => {
  it("is disabled when CF_ACCESS_DISABLED=true", () => {
    expect(getAccessJwtMode()).toBe("disabled");
  });

  it("CF_ACCESS_DISABLED=true wins even when team+aud are also set", () => {
    process.env.CF_ACCESS_TEAM_DOMAIN = ACCESS_TEAM;
    process.env.CF_ACCESS_AUD = ACCESS_AUD;
    process.env.CF_ACCESS_DISABLED = "true";
    expect(getAccessJwtMode()).toBe("disabled");
  });

  it("is enforce when both team+aud are set and the escape is off", () => {
    enforceEnv();
    expect(getAccessJwtMode()).toBe("enforce");
  });

  it("is fail-closed when neither var is set and the escape is off", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    failClosedEnv();
    expect(getAccessJwtMode()).toBe("fail-closed");
  });

  it("is fail-closed when exactly one of team/aud is set", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    clearAccessEnv();
    process.env.CF_ACCESS_TEAM_DOMAIN = ACCESS_TEAM;
    expect(getAccessJwtMode()).toBe("fail-closed");

    clearAccessEnv();
    process.env.CF_ACCESS_AUD = ACCESS_AUD;
    expect(getAccessJwtMode()).toBe("fail-closed");
  });
});

describe("verifyAccessJwt", () => {
  it("disabled mode trusts even a bare forged header (no JWT)", () => {
    // beforeEach set CF_ACCESS_DISABLED=true.
    expect(verifyAccessJwt(req({}))).toBe(true);
    expect(verifyAccessJwt(req({ "cf-access-authenticated-user-email": "anyone@example.com" }))).toBe(true);
  });

  it("fail-closed mode rejects the header path and warns exactly once", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    failClosedEnv();

    expect(verifyAccessJwt(req(accessHeaders(buildJwt())))).toBe(false);
    expect(verifyAccessJwt(req(accessHeaders(buildJwt())))).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("CF_ACCESS_DISABLED");
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("CF_ACCESS_TEAM_DOMAIN");
  });

  it("accepts a valid RS256 token signed by the JWKS key", async () => {
    enforceEnv();
    const { calls } = installJwksFetcher(jwksKeys());
    await primeAccessJwtCache();

    expect(verifyAccessJwt(req(accessHeaders(buildJwt())))).toBe(true);
    expect(calls).toEqual([ACCESS_JWKS_URL]);
  });

  it("accepts a valid ES256 token (raw R||S signature)", async () => {
    enforceEnv();
    installJwksFetcher(jwksKeys([{ key: accessEcKeyPair.publicKey, kid: ACCESS_ES_KID, alg: "ES256" }]));
    await primeAccessJwtCache();

    expect(verifyAccessJwt(req(accessHeaders(buildEsJwt())))).toBe(true);
  });

  it("normalizes a full team-domain form (https://<team>.cloudflareaccess.com)", async () => {
    clearAccessEnv();
    process.env.CF_ACCESS_TEAM_DOMAIN = `https://${ACCESS_TEAM}.cloudflareaccess.com/`;
    process.env.CF_ACCESS_AUD = ACCESS_AUD;
    const { calls } = installJwksFetcher(jwksKeys());
    await primeAccessJwtCache();

    expect(verifyAccessJwt(req(accessHeaders(buildJwt())))).toBe(true);
    expect(calls).toEqual([ACCESS_JWKS_URL]);
  });

  it("rejects a token whose Cf-Access-Jwt-Assertion header is missing", async () => {
    enforceEnv();
    installJwksFetcher(jwksKeys());
    await primeAccessJwtCache();
    expect(verifyAccessJwt(req(accessHeaders(null)))).toBe(false);
  });

  it("rejects a token signed by the wrong key (signature mismatch)", async () => {
    enforceEnv();
    installJwksFetcher(jwksKeys());
    await primeAccessJwtCache();
    const forged = buildJwt({ signWith: strangerKeyPair.privateKey });
    expect(verifyAccessJwt(req(accessHeaders(forged)))).toBe(false);
  });

  it("rejects a tampered payload even with a once-valid signature", async () => {
    enforceEnv();
    installJwksFetcher(jwksKeys());
    await primeAccessJwtCache();
    const valid = buildJwt();
    const [header, , signature] = valid.split(".") as [string, string, string];
    const tamperedPayload = b64url(
      JSON.stringify({
        aud: [ACCESS_AUD],
        iss: ACCESS_ISSUER,
        email: "attacker@example.com",
        exp: nowSeconds() + 600
      })
    );
    expect(verifyAccessJwt(req(accessHeaders(`${header}.${tamperedPayload}.${signature}`)))).toBe(false);
  });

  it("rejects an expired token but tolerates expiry within the clock-skew window", async () => {
    enforceEnv();
    installJwksFetcher(jwksKeys());
    await primeAccessJwtCache();

    const expired = buildJwt({ payload: { exp: nowSeconds() - 120 } });
    expect(verifyAccessJwt(req(accessHeaders(expired)))).toBe(false);

    const withinSkew = buildJwt({ payload: { exp: nowSeconds() - 30 } });
    expect(verifyAccessJwt(req(accessHeaders(withinSkew)))).toBe(true);
  });

  it("rejects a token with no exp claim", async () => {
    enforceEnv();
    installJwksFetcher(jwksKeys());
    await primeAccessJwtCache();
    expect(verifyAccessJwt(req(accessHeaders(buildJwt({ payload: { exp: undefined } }))))).toBe(false);
  });

  it("rejects a token whose aud does not contain CF_ACCESS_AUD", async () => {
    enforceEnv();
    installJwksFetcher(jwksKeys());
    await primeAccessJwtCache();
    expect(
      verifyAccessJwt(req(accessHeaders(buildJwt({ payload: { aud: ["some-other-app"] } }))))
    ).toBe(false);
  });

  it("accepts aud as a plain string equal to CF_ACCESS_AUD", async () => {
    enforceEnv();
    installJwksFetcher(jwksKeys());
    await primeAccessJwtCache();
    expect(verifyAccessJwt(req(accessHeaders(buildJwt({ payload: { aud: ACCESS_AUD } }))))).toBe(true);
  });

  it("rejects a token from the wrong issuer", async () => {
    enforceEnv();
    installJwksFetcher(jwksKeys());
    await primeAccessJwtCache();
    const wrongIssuer = buildJwt({ payload: { iss: "https://otherteam.cloudflareaccess.com" } });
    expect(verifyAccessJwt(req(accessHeaders(wrongIssuer)))).toBe(false);
  });

  it("rejects a valid JWT replayed alongside a different email header", async () => {
    enforceEnv();
    installJwksFetcher(jwksKeys());
    await primeAccessJwtCache();
    expect(verifyAccessJwt(req(accessHeaders(buildJwt(), "other@example.com")))).toBe(false);
  });

  it("matches the email claim against the header case-insensitively", async () => {
    enforceEnv();
    installJwksFetcher(jwksKeys());
    await primeAccessJwtCache();
    const jwt = buildJwt({ payload: { email: "Member1@Example.COM" } });
    expect(verifyAccessJwt(req(accessHeaders(jwt, "member1@example.com")))).toBe(true);
  });

  it("rejects when the email header is missing even if the JWT itself is valid", async () => {
    enforceEnv();
    installJwksFetcher(jwksKeys());
    await primeAccessJwtCache();
    expect(verifyAccessJwt(req(accessHeaders(buildJwt(), null)))).toBe(false);
  });

  it("rejects malformed tokens and non-RS256/ES256 algorithms (incl. alg:none)", async () => {
    enforceEnv();
    installJwksFetcher(jwksKeys());
    await primeAccessJwtCache();

    expect(verifyAccessJwt(req(accessHeaders("garbage")))).toBe(false);
    expect(verifyAccessJwt(req(accessHeaders("a.b")))).toBe(false);

    const algNone = `${b64url(JSON.stringify({ alg: "none", kid: ACCESS_KID }))}.${b64url(
      JSON.stringify({ aud: [ACCESS_AUD], iss: ACCESS_ISSUER, email: ACCESS_EMAIL, exp: nowSeconds() + 600 })
    )}.`;
    expect(verifyAccessJwt(req(accessHeaders(algNone)))).toBe(false);
  });

  it("serves the JWKS from cache across verifications (no refetch while fresh)", async () => {
    enforceEnv();
    const { calls } = installJwksFetcher(jwksKeys());
    await primeAccessJwtCache();

    expect(verifyAccessJwt(req(accessHeaders(buildJwt())))).toBe(true);
    expect(verifyAccessJwt(req(accessHeaders(buildJwt())))).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("fails an unknown kid but recovers after the background refetch (key rotation)", async () => {
    enforceEnv();
    const { calls } = installJwksFetcher(
      jwksKeys([{ key: strangerKeyPair.publicKey, kid: "retired-key" }]),
      jwksKeys()
    );
    await primeAccessJwtCache(); // fetch #1 -> cache holds only "retired-key"
    expect(calls).toHaveLength(1);

    // ACCESS_KID unknown -> this request fails closed and schedules a refetch.
    expect(verifyAccessJwt(req(accessHeaders(buildJwt())))).toBe(false);

    // Await the scheduled (coalesced) refetch, then the new kid verifies.
    await primeAccessJwtCache(); // fetch #2 -> cache now holds ACCESS_KID
    expect(calls).toHaveLength(2);
    expect(verifyAccessJwt(req(accessHeaders(buildJwt())))).toBe(true);
  });

  it("keeps failing (no fetch loop) when the kid stays unknown after a refetch", async () => {
    enforceEnv();
    const { calls } = installJwksFetcher(
      jwksKeys([{ key: strangerKeyPair.publicKey, kid: "retired-key" }])
    );
    await primeAccessJwtCache(); // fetch #1
    expect(verifyAccessJwt(req(accessHeaders(buildJwt())))).toBe(false);
    await primeAccessJwtCache(); // fetch #2 (still only retired-key)
    expect(verifyAccessJwt(req(accessHeaders(buildJwt())))).toBe(false);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.length).toBeLessThanOrEqual(3);
  });

  it("fails closed (not open, no throw) when the JWKS fetch fails", async () => {
    enforceEnv();
    installJwksFetcher(() => {
      throw new Error("network down");
    });
    await primeAccessJwtCache();

    expect(verifyAccessJwt(req(accessHeaders(buildJwt())))).toBe(false);
  });

  it("fails closed when the JWKS returns an unimportable key", async () => {
    enforceEnv();
    installJwksFetcher([{ kid: ACCESS_KID, kty: "RSA", use: "sig", alg: "RS256" }] as Jwk[]);
    await primeAccessJwtCache();
    expect(verifyAccessJwt(req(accessHeaders(buildJwt())))).toBe(false);
  });
});

describe("resolveIdentity under enforce mode", () => {
  it("resolves the member when the email header is backed by a valid Access JWT", async () => {
    enforceEnv();
    installJwksFetcher(jwksKeys());
    await primeAccessJwtCache();
    const db = memoryDb();
    const member = makeMember();
    new MemberRepository(db).upsert(member);

    expect(resolveIdentity(req(accessHeaders(buildJwt())), db)).toEqual(member);
  });

  it("no longer trusts a bare email header once enforce mode is on", async () => {
    enforceEnv();
    installJwksFetcher(jwksKeys());
    await primeAccessJwtCache();
    const db = memoryDb();
    const member = makeMember();
    new MemberRepository(db).upsert(member);

    expect(
      resolveIdentity(req({ "cf-access-authenticated-user-email": member.email }), db)
    ).toBeNull();
  });

  it("rejects a valid JWT for A presented with a forged email header naming B", async () => {
    enforceEnv();
    installJwksFetcher(jwksKeys());
    await primeAccessJwtCache();
    const db = memoryDb();
    const memberB = makeMember({ id: "member_b", email: "member-b@example.com" });
    new MemberRepository(db).upsert(memberB);

    // JWT's email claim is ACCESS_EMAIL (member A); header names member B.
    expect(resolveIdentity(req(accessHeaders(buildJwt(), memberB.email)), db)).toBeNull();
  });

  it("leaves the bearer-token path untouched by enforce mode", () => {
    enforceEnv();
    installJwksFetcher(() => {
      throw new Error("JWKS must not be consulted for bearer auth");
    });
    const db = memoryDb();
    const member = makeMember();
    new MemberRepository(db).upsert(member);
    const { token } = new ApiTokenRepository(db).issue(member.id, "cli");

    expect(resolveIdentity(req({ authorization: `Bearer ${token}` }), db)).toEqual(member);
  });
});

describe("resolveIdentity fail-closed by default (no CF_ACCESS_* env, escape off)", () => {
  it("does NOT trust the bare email header", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    failClosedEnv();
    const db = memoryDb();
    const member = makeMember();
    new MemberRepository(db).upsert(member);

    expect(
      resolveIdentity(req({ "cf-access-authenticated-user-email": member.email }), db)
    ).toBeNull();
  });

  it("does NOT trust the email header even with a JWT present (nothing to verify against)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    failClosedEnv();
    const db = memoryDb();
    const member = makeMember();
    new MemberRepository(db).upsert(member);

    expect(resolveIdentity(req(accessHeaders(buildJwt())), db)).toBeNull();
  });
});

describe("renderUnauthorizedPage", () => {
  it("renders a self-contained Chinese 401 page carrying the given nonce", () => {
    const html = renderUnauthorizedPage("test-nonce-123");

    expect(html).toContain("未获授权：请通过圈内白名单邮箱登录，或联系圈主开通成员");
    expect(html).toContain("test-nonce-123");
    expect(html).toMatch(/^<!doctype html>/iu);
  });

  it("makes no external requests: no http(s) URLs, no <script src>, no <link>", () => {
    const html = renderUnauthorizedPage("another-nonce");

    expect(html).not.toMatch(/https?:\/\//iu);
    expect(html).not.toMatch(/<script[^>]+src=/iu);
    expect(html).not.toMatch(/<link[^>]+href=/iu);
  });

  it("escapes the nonce so it cannot break out of its attribute", () => {
    const html = renderUnauthorizedPage('"><script>alert(1)</script>');

    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
