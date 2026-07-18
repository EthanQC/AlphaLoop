import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiTokenRepository,
  MemberRepository,
  migrate,
  nowIso,
  type Member
} from "@packages/shared-types";

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

// Access JWT env handling: every test in this file starts from the
// loopback-trust baseline (both CF_ACCESS_* vars unset) regardless of what
// the invoking shell exported - the pre-P10 resolveIdentity tests below
// depend on the email header being trusted without a JWT. Enforce-mode tests
// opt in explicitly via enforceEnv().
const SAVED_TEAM_DOMAIN = process.env.CF_ACCESS_TEAM_DOMAIN;
const SAVED_AUD = process.env.CF_ACCESS_AUD;

beforeEach(() => {
  delete process.env.CF_ACCESS_TEAM_DOMAIN;
  delete process.env.CF_ACCESS_AUD;
  __resetAccessJwtStateForTests();
  __setAccessJwksFetcherForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  delete process.env.CF_ACCESS_TEAM_DOMAIN;
  delete process.env.CF_ACCESS_AUD;
  if (SAVED_TEAM_DOMAIN !== undefined) {
    process.env.CF_ACCESS_TEAM_DOMAIN = SAVED_TEAM_DOMAIN;
  }
  if (SAVED_AUD !== undefined) {
    process.env.CF_ACCESS_AUD = SAVED_AUD;
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

  it("falls back to Cf-Access-Authenticated-User-Email when no bearer token is present", () => {
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
// Cloudflare Access JWT verification (P10)
// ---------------------------------------------------------------------------
// Locally-generated keypairs play the role of Access's signing keys; the
// JWKS "endpoint" is an injected fetcher (no network in tests). The JWKS
// cache reads synchronously and refreshes in the BACKGROUND (access-jwt.ts),
// so tests pre-warm it via primeAccessJwtCache() - exactly what index.ts
// does at startup - or use settle() to let a scheduled refresh land.

const ACCESS_KID = "test-key-1";
const ACCESS_EC_KID = "test-ec-key-1";
const ACCESS_TEAM = "myteam";
const ACCESS_ISSUER = `https://${ACCESS_TEAM}.cloudflareaccess.com`;
const ACCESS_JWKS_URL = `${ACCESS_ISSUER}/cdn-cgi/access/certs`;
const ACCESS_AUD = "aud-tag-0123456789abcdef";
const ACCESS_EMAIL = "member1@example.com";

const accessKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const strangerKeyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ecKeyPair = generateKeyPairSync("ec", { namedCurve: "P-256" });

function jwkFor(key: KeyObject, kid: string): Jwk {
  return { ...key.export({ format: "jwk" }), kid, use: "sig" } as Jwk;
}

function defaultJwks(): Jwk[] {
  return [jwkFor(accessKeyPair.publicKey, ACCESS_KID), jwkFor(ecKeyPair.publicKey, ACCESS_EC_KID)];
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Hand-built JWT mirroring the claims Access mints (RS256 or ES256). */
function buildJwt(
  options: {
    alg?: "RS256" | "ES256";
    header?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    signWith?: KeyObject;
  } = {}
): string {
  const alg = options.alg ?? "RS256";
  const header = {
    alg,
    typ: "JWT",
    kid: alg === "ES256" ? ACCESS_EC_KID : ACCESS_KID,
    ...options.header
  };
  const payload = {
    aud: [ACCESS_AUD],
    iss: ACCESS_ISSUER,
    email: ACCESS_EMAIL,
    exp: nowSeconds() + 600,
    nbf: nowSeconds() - 60,
    iat: nowSeconds() - 1,
    sub: "access-user-sub",
    ...options.payload
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature =
    alg === "ES256"
      ? cryptoSign("sha256", Buffer.from(signingInput, "utf8"), {
          key: options.signWith ?? ecKeyPair.privateKey,
          dsaEncoding: "ieee-p1363"
        })
      : cryptoSign("RSA-SHA256", Buffer.from(signingInput, "utf8"), options.signWith ?? accessKeyPair.privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function enforceEnv(): void {
  process.env.CF_ACCESS_TEAM_DOMAIN = ACCESS_TEAM;
  process.env.CF_ACCESS_AUD = ACCESS_AUD;
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
 * Installs a JWKS fetcher returning the given responses in order (the last
 * repeats). A function response is invoked, so it can throw to simulate a
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

/** installJwksFetcher + the same startup pre-warm index.ts performs. */
async function primed(...responses: Array<Jwk[] | (() => Jwk[])>): Promise<{ calls: string[] }> {
  const handle = installJwksFetcher(...responses);
  await primeAccessJwtCache();
  return handle;
}

/** Lets a background JWKS refresh scheduled by a verification land. */
function settle(): Promise<void> {
  return new Promise((resolvePromise) => setImmediate(() => resolvePromise()));
}

describe("getAccessJwtMode", () => {
  it("is loopback-trust when neither CF_ACCESS_* var is set", () => {
    expect(getAccessJwtMode()).toBe("loopback-trust");
  });

  it("is enforce when both are set", () => {
    enforceEnv();
    expect(getAccessJwtMode()).toBe("enforce");
  });

  it("is misconfigured when exactly one is set", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.CF_ACCESS_TEAM_DOMAIN = ACCESS_TEAM;
    expect(getAccessJwtMode()).toBe("misconfigured");

    delete process.env.CF_ACCESS_TEAM_DOMAIN;
    __resetAccessJwtStateForTests();
    process.env.CF_ACCESS_AUD = ACCESS_AUD;
    expect(getAccessJwtMode()).toBe("misconfigured");
  });

  it("is misconfigured when the team domain normalizes to nothing", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.CF_ACCESS_TEAM_DOMAIN = "https://";
    process.env.CF_ACCESS_AUD = ACCESS_AUD;
    expect(getAccessJwtMode()).toBe("misconfigured");
  });
});

describe("verifyAccessJwt", () => {
  it("returns true with no CF_ACCESS_* env, even for a bare forged header (loopback-trust mode)", () => {
    expect(verifyAccessJwt(req({}))).toBe(true);
    expect(verifyAccessJwt(req({ "cf-access-authenticated-user-email": "anyone@example.com" }))).toBe(true);
  });

  it("fails closed and warns exactly once via console.error when only one env var is set", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.CF_ACCESS_TEAM_DOMAIN = ACCESS_TEAM;
    installJwksFetcher(defaultJwks());

    const jwt = buildJwt();
    expect(verifyAccessJwt(req(accessHeaders(jwt)))).toBe(false);
    expect(verifyAccessJwt(req(accessHeaders(jwt)))).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("CF_ACCESS_TEAM_DOMAIN");
  });

  it("fails closed when only CF_ACCESS_AUD is set", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.CF_ACCESS_AUD = ACCESS_AUD;
    installJwksFetcher(defaultJwks());
    expect(verifyAccessJwt(req(accessHeaders(buildJwt())))).toBe(false);
  });

  it("accepts a valid RS256 token signed by the JWKS key", async () => {
    enforceEnv();
    const { calls } = await primed(defaultJwks());

    expect(verifyAccessJwt(req(accessHeaders(buildJwt())))).toBe(true);
    expect(calls).toEqual([ACCESS_JWKS_URL]);
  });

  it("accepts a valid ES256 token (Cloudflare may rotate to EC keys)", async () => {
    enforceEnv();
    await primed(defaultJwks());

    expect(verifyAccessJwt(req(accessHeaders(buildJwt({ alg: "ES256" }))))).toBe(true);
  });

  it("normalizes a full team-domain form (https://<team>.cloudflareaccess.com)", async () => {
    process.env.CF_ACCESS_TEAM_DOMAIN = `https://${ACCESS_TEAM}.cloudflareaccess.com`;
    process.env.CF_ACCESS_AUD = ACCESS_AUD;
    const { calls } = await primed(defaultJwks());

    expect(verifyAccessJwt(req(accessHeaders(buildJwt())))).toBe(true);
    expect(calls).toEqual([ACCESS_JWKS_URL]);
  });

  it("rejects a request whose Cf-Access-Jwt-Assertion header is missing", async () => {
    enforceEnv();
    await primed(defaultJwks());
    expect(verifyAccessJwt(req(accessHeaders(null)))).toBe(false);
  });

  it("rejects a token signed by the wrong key (signature mismatch)", async () => {
    enforceEnv();
    await primed(defaultJwks());
    const forged = buildJwt({ signWith: strangerKeyPair.privateKey });
    expect(verifyAccessJwt(req(accessHeaders(forged)))).toBe(false);
  });

  it("rejects a tampered payload even with a once-valid signature", async () => {
    enforceEnv();
    await primed(defaultJwks());
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
    await primed(defaultJwks());

    const expired = buildJwt({ payload: { exp: nowSeconds() - 120 } });
    expect(verifyAccessJwt(req(accessHeaders(expired)))).toBe(false);

    const withinSkew = buildJwt({ payload: { exp: nowSeconds() - 30 } });
    expect(verifyAccessJwt(req(accessHeaders(withinSkew)))).toBe(true);
  });

  it("rejects a token with no exp claim", async () => {
    enforceEnv();
    await primed(defaultJwks());
    expect(verifyAccessJwt(req(accessHeaders(buildJwt({ payload: { exp: undefined } }))))).toBe(false);
  });

  it("rejects a token whose aud does not contain CF_ACCESS_AUD", async () => {
    enforceEnv();
    await primed(defaultJwks());
    expect(
      verifyAccessJwt(req(accessHeaders(buildJwt({ payload: { aud: ["some-other-app"] } }))))
    ).toBe(false);
  });

  it("accepts aud as a plain string equal to CF_ACCESS_AUD", async () => {
    enforceEnv();
    await primed(defaultJwks());
    expect(verifyAccessJwt(req(accessHeaders(buildJwt({ payload: { aud: ACCESS_AUD } }))))).toBe(true);
  });

  it("rejects a token from the wrong issuer", async () => {
    enforceEnv();
    await primed(defaultJwks());
    const wrongIssuer = buildJwt({
      payload: { iss: "https://otherteam.cloudflareaccess.com" }
    });
    expect(verifyAccessJwt(req(accessHeaders(wrongIssuer)))).toBe(false);
  });

  it("rejects a valid JWT replayed alongside a different email header", async () => {
    enforceEnv();
    await primed(defaultJwks());
    expect(verifyAccessJwt(req(accessHeaders(buildJwt(), "other@example.com")))).toBe(false);
  });

  it("rejects a token whose email claim is empty", async () => {
    enforceEnv();
    await primed(defaultJwks());
    expect(verifyAccessJwt(req(accessHeaders(buildJwt({ payload: { email: "" } }))))).toBe(false);
  });

  it("matches the email claim against the header case-insensitively", async () => {
    enforceEnv();
    await primed(defaultJwks());
    const jwt = buildJwt({ payload: { email: "Member1@Example.COM" } });
    expect(verifyAccessJwt(req(accessHeaders(jwt, "member1@example.com")))).toBe(true);
  });

  it("rejects when the email header is missing even if the JWT itself is valid", async () => {
    enforceEnv();
    await primed(defaultJwks());
    expect(verifyAccessJwt(req(accessHeaders(buildJwt(), null)))).toBe(false);
  });

  it("rejects malformed tokens and the alg:none downgrade", async () => {
    enforceEnv();
    await primed(defaultJwks());

    expect(verifyAccessJwt(req(accessHeaders("garbage")))).toBe(false);
    expect(verifyAccessJwt(req(accessHeaders("a.b")))).toBe(false);

    const unsignedPayload = b64url(
      JSON.stringify({ aud: [ACCESS_AUD], iss: ACCESS_ISSUER, email: ACCESS_EMAIL, exp: nowSeconds() + 600 })
    );
    const algNoneEmptySig = `${b64url(JSON.stringify({ alg: "none", kid: ACCESS_KID }))}.${unsignedPayload}.`;
    expect(verifyAccessJwt(req(accessHeaders(algNoneEmptySig)))).toBe(false);
    const algNoneJunkSig = `${b64url(JSON.stringify({ alg: "none", kid: ACCESS_KID }))}.${unsignedPayload}.${b64url("junk")}`;
    expect(verifyAccessJwt(req(accessHeaders(algNoneJunkSig)))).toBe(false);
  });

  it("serves repeated verifications from the cached JWKS (single fetch)", async () => {
    enforceEnv();
    const { calls } = await primed(defaultJwks());

    expect(verifyAccessJwt(req(accessHeaders(buildJwt())))).toBe(true);
    expect(verifyAccessJwt(req(accessHeaders(buildJwt())))).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("cold start without priming fails closed once, then succeeds after the background fetch", async () => {
    enforceEnv();
    const { calls } = installJwksFetcher(defaultJwks());

    expect(verifyAccessJwt(req(accessHeaders(buildJwt())))).toBe(false);
    await settle();
    expect(verifyAccessJwt(req(accessHeaders(buildJwt())))).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("recovers from key rotation: unknown kid fails closed now, background refetch admits the next request", async () => {
    enforceEnv();
    const { calls } = installJwksFetcher(
      [jwkFor(strangerKeyPair.publicKey, "retired-key")],
      defaultJwks()
    );
    await primeAccessJwtCache();
    expect(calls).toHaveLength(1);

    expect(verifyAccessJwt(req(accessHeaders(buildJwt())))).toBe(false);
    await settle();
    expect(verifyAccessJwt(req(accessHeaders(buildJwt())))).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("fails closed (not open, no throw) when the JWKS fetch fails", async () => {
    enforceEnv();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await primed(() => {
      throw new Error("network down");
    });

    expect(verifyAccessJwt(req(accessHeaders(buildJwt())))).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("failing closed");
  });

  it("skips malformed JWKS entries but keeps the usable keys", async () => {
    enforceEnv();
    await primed([
      { kid: "broken-key", kty: "RSA", n: "!!!", e: "!!!" } as Jwk,
      jwkFor(accessKeyPair.publicKey, ACCESS_KID)
    ]);

    expect(verifyAccessJwt(req(accessHeaders(buildJwt())))).toBe(true);
  });
});

describe("resolveIdentity under enforce mode", () => {
  it("resolves the member when the email header is backed by a valid Access JWT", async () => {
    enforceEnv();
    await primed(defaultJwks());
    const db = memoryDb();
    const member = makeMember();
    new MemberRepository(db).upsert(member);

    expect(resolveIdentity(req(accessHeaders(buildJwt())), db)).toEqual(member);
  });

  it("no longer trusts a bare email header once enforce mode is on", async () => {
    enforceEnv();
    await primed(defaultJwks());
    const db = memoryDb();
    const member = makeMember();
    new MemberRepository(db).upsert(member);

    expect(
      resolveIdentity(req({ "cf-access-authenticated-user-email": member.email }), db)
    ).toBeNull();
  });

  it("rejects a valid JWT for A presented with a forged email header naming B", async () => {
    enforceEnv();
    await primed(defaultJwks());
    const db = memoryDb();
    const memberB = makeMember({ id: "member_b", email: "member-b@example.com" });
    new MemberRepository(db).upsert(memberB);

    // JWT's email claim is ACCESS_EMAIL (member A); header names member B.
    expect(resolveIdentity(req(accessHeaders(buildJwt(), memberB.email)), db)).toBeNull();
  });

  it("leaves the bearer-token path untouched by enforce mode (JWKS never consulted)", () => {
    enforceEnv();
    const { calls } = installJwksFetcher(() => {
      throw new Error("JWKS must not be consulted for bearer auth");
    });
    const db = memoryDb();
    const member = makeMember();
    new MemberRepository(db).upsert(member);
    const { token } = new ApiTokenRepository(db).issue(member.id, "cli");

    expect(resolveIdentity(req({ authorization: `Bearer ${token}` }), db)).toEqual(member);
    expect(calls).toHaveLength(0);
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
