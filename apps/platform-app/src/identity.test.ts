import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  ApiTokenRepository,
  MemberRepository,
  migrate,
  nowIso,
  type Member
} from "@packages/shared-types";

import { resolveIdentity, renderUnauthorizedPage, verifyAccessJwt } from "./identity.js";

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

describe("verifyAccessJwt", () => {
  // P10 prerequisite placeholder: real Cloudflare Access JWT validation needs
  // an actual team domain/JWKS, unavailable in local dev. This just pins
  // that the extension point exists and does not throw - it is NOT a
  // security control yet (see the TODO in identity.ts).
  it("exists as a documented no-op extension point", () => {
    expect(typeof verifyAccessJwt).toBe("function");
    expect(() => verifyAccessJwt(req({}) as never)).not.toThrow();
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
