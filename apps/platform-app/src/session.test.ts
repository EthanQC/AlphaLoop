import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  __resetSessionWarningsForTests,
  assertSessionSecretConfigured,
  buildLogoutCookie,
  buildSessionCookie,
  createSessionToken,
  parseCookies,
  resolveSessionMemberId,
  resolveSessionSecret,
  verifySessionToken
} from "./session.js";

const SAVED_SECRET = process.env.PLATFORM_SESSION_SECRET;
const SECRET = "unit-test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW = Date.parse("2026-07-27T12:00:00.000Z");

beforeEach(() => {
  process.env.PLATFORM_SESSION_SECRET = SECRET;
  __resetSessionWarningsForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (SAVED_SECRET === undefined) {
    delete process.env.PLATFORM_SESSION_SECRET;
  } else {
    process.env.PLATFORM_SESSION_SECRET = SAVED_SECRET;
  }
  __resetSessionWarningsForTests();
});

/** Extracts just the cookie value from a Set-Cookie string. */
function cookieValue(setCookie: string): string {
  return (setCookie.split(";")[0] ?? "").split("=").slice(1).join("=");
}

describe("createSessionToken / verifySessionToken", () => {
  it("round-trips the member id", () => {
    const token = createSessionToken("member_1", NOW + SESSION_TTL_MS) as string;
    expect(token).not.toBeNull();
    expect(verifySessionToken(token, NOW)).toBe("member_1");
  });

  it("never puts the secret in the token", () => {
    const token = createSessionToken("member_1", NOW + 1000) as string;
    expect(token).not.toContain(SECRET);
  });

  it("rejects a token whose payload was tampered with (member id swapped)", () => {
    const token = createSessionToken("member_1", NOW + SESSION_TTL_MS) as string;
    const [version, , signature] = token.split(".") as [string, string, string];
    const forgedPayload = Buffer.from(JSON.stringify({ m: "member_admin", e: NOW + SESSION_TTL_MS }), "utf8").toString(
      "base64url"
    );

    expect(verifySessionToken(`${version}.${forgedPayload}.${signature}`, NOW)).toBeNull();
  });

  it("rejects a token with a mangled signature", () => {
    const token = createSessionToken("member_1", NOW + SESSION_TTL_MS) as string;
    const [version, payload] = token.split(".") as [string, string];
    expect(verifySessionToken(`${version}.${payload}.AAAA`, NOW)).toBeNull();
  });

  it("rejects an unsigned/none-style token", () => {
    const payload = Buffer.from(JSON.stringify({ m: "member_1", e: NOW + 1000 }), "utf8").toString("base64url");
    expect(verifySessionToken(`v1.${payload}.`, NOW)).toBeNull();
    expect(verifySessionToken(`v1.${payload}`, NOW)).toBeNull();
    expect(verifySessionToken("garbage", NOW)).toBeNull();
    expect(verifySessionToken("", NOW)).toBeNull();
  });

  it("rejects an expired token (and accepts one that expires a millisecond later)", () => {
    const expired = createSessionToken("member_1", NOW - 1) as string;
    expect(verifySessionToken(expired, NOW)).toBeNull();

    const live = createSessionToken("member_1", NOW + 1) as string;
    expect(verifySessionToken(live, NOW)).toBe("member_1");
  });

  it("rejects a token signed with a different secret (rotation invalidates every session)", () => {
    const token = createSessionToken("member_1", NOW + SESSION_TTL_MS) as string;
    process.env.PLATFORM_SESSION_SECRET = "a-completely-different-secret-bbbbbbbbbbbbbbbbb";
    expect(verifySessionToken(token, NOW)).toBeNull();
  });

  it("rejects a version this build does not know", () => {
    const token = createSessionToken("member_1", NOW + SESSION_TTL_MS) as string;
    const [, payload, signature] = token.split(".") as [string, string, string];
    expect(verifySessionToken(`v2.${payload}.${signature}`, NOW)).toBeNull();
  });
});

describe("no PLATFORM_SESSION_SECRET configured", () => {
  it("mints nothing and verifies nothing, and warns exactly once", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const token = createSessionToken("member_1", NOW + SESSION_TTL_MS) as string;
    delete process.env.PLATFORM_SESSION_SECRET;
    __resetSessionWarningsForTests();

    expect(resolveSessionSecret()).toBeNull();
    expect(createSessionToken("member_1", NOW + SESSION_TTL_MS)).toBeNull();
    expect(buildSessionCookie("member_1", NOW)).toBeNull();
    expect(verifySessionToken(token, NOW)).toBeNull();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("PLATFORM_SESSION_SECRET");
  });

  it("treats a blank/whitespace secret as unset (no accidental empty-key signing)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.PLATFORM_SESSION_SECRET = "   ";
    expect(resolveSessionSecret()).toBeNull();
    expect(createSessionToken("member_1", NOW + SESSION_TTL_MS)).toBeNull();
  });
});

describe("assertSessionSecretConfigured", () => {
  it("throws a fix-it error when the secret is missing", () => {
    delete process.env.PLATFORM_SESSION_SECRET;
    expect(() => assertSessionSecretConfigured()).toThrow(/PLATFORM_SESSION_SECRET is required/u);
    expect(() => assertSessionSecretConfigured()).toThrow(/openssl rand/u);
  });

  it("passes silently for a long secret", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => assertSessionSecretConfigured()).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("boots but warns for a too-short secret", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.PLATFORM_SESSION_SECRET = "short";
    expect(() => assertSessionSecretConfigured()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe("buildSessionCookie / buildLogoutCookie", () => {
  it("carries every required attribute", () => {
    const cookie = buildSessionCookie("member_1", NOW) as string;
    expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    expect(cookie).toContain("; Path=/");
    expect(cookie).toContain("; HttpOnly");
    expect(cookie).toContain("; Secure");
    expect(cookie).toContain("; SameSite=Lax");
    expect(cookie).toContain(`; Max-Age=${SESSION_TTL_MS / 1000}`);
  });

  it("issues a cookie whose token verifies for 30 days and not a moment past", () => {
    const cookie = buildSessionCookie("member_1", NOW) as string;
    const token = cookieValue(cookie);

    expect(verifySessionToken(token, NOW + SESSION_TTL_MS - 1000)).toBe("member_1");
    expect(verifySessionToken(token, NOW + SESSION_TTL_MS + 1000)).toBeNull();
  });

  it("logout clears the value with the same attributes and Max-Age=0", () => {
    const cookie = buildLogoutCookie();
    expect(cookie).toBe(`${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  });
});

describe("parseCookies / resolveSessionMemberId", () => {
  it("parses a multi-cookie header and ignores junk segments", () => {
    expect(parseCookies("a=1; b=2;; =3; c=")).toEqual({ a: "1", b: "2", c: "" });
  });

  it("returns an empty map for a missing header", () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  it("keeps the first occurrence of a duplicated name", () => {
    expect(parseCookies("x=first; x=second")).toEqual({ x: "first" });
  });

  it("resolves the member id from a real Cookie header alongside other cookies", () => {
    const token = createSessionToken("member_1", NOW + SESSION_TTL_MS) as string;
    const req = { headers: { cookie: `alphaloop-theme=dark; ${SESSION_COOKIE_NAME}=${token}; other=1` } };

    expect(resolveSessionMemberId(req, NOW)).toBe("member_1");
  });

  it("returns null when the session cookie is absent or unparsable", () => {
    expect(resolveSessionMemberId({ headers: {} }, NOW)).toBeNull();
    expect(resolveSessionMemberId({ headers: { cookie: "alphaloop-theme=dark" } }, NOW)).toBeNull();
    expect(resolveSessionMemberId({ headers: { cookie: `${SESSION_COOKIE_NAME}=nonsense` } }, NOW)).toBeNull();
  });
});
