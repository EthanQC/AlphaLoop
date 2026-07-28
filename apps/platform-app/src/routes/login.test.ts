import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiTokenRepository, MemberRepository, migrate, type Member } from "@packages/shared-types";

import type { LoginCodeSender } from "../data/login-code-notifier.js";
import { __resetAccessJwtStateForTests } from "../identity.js";
import { createPlatformServer } from "../server.js";
import { SESSION_COOKIE_NAME, createSessionToken } from "../session.js";

// The flow under test is deliberately end-to-end over a real loopback HTTP
// server (like server.test.ts): the cookie attributes, the 303s, the form
// bodies and the status codes ARE the feature, and a handler-level test would
// assert none of them. Everything else is hermetic - an in-memory sqlite, an
// injected clock, and a fake Feishu sender that captures the code instead of
// sending anything.

const T0 = Date.parse("2026-07-27T10:00:00.000Z");
const MEMBER_EMAIL = "member@example.com";
const MEMBER_OPEN_ID = "ou_member_1";

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    id: "member_1",
    email: MEMBER_EMAIL,
    feishuOpenId: MEMBER_OPEN_ID,
    displayName: "圈内成员",
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

describe("email-code login", () => {
  let server: ReturnType<typeof createPlatformServer>;
  let baseUrl: string;
  let db: DatabaseSync;
  let clock: Date;
  let sent: Array<{ openId: string; code: string; ttlMinutes: number }>;
  let sendResult: { ok: boolean; reason?: string };
  let pending: Array<Promise<void>>;

  const fakeSender: LoginCodeSender = async ({ openId, code, ttlMinutes }) => {
    sent.push({ openId, code, ttlMinutes });
    return sendResult;
  };

  /** Awaits login.ts's out-of-band delivery job(s). */
  async function settle(): Promise<void> {
    await Promise.all(pending);
    pending = [];
  }

  function advance(ms: number): void {
    clock = new Date(clock.getTime() + ms);
  }

  async function requestCode(email: string, headers: Record<string, string> = {}): Promise<Response> {
    const response = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ email }).toString(),
      redirect: "manual"
    });
    await settle();
    return response;
  }

  async function submitCode(email: string, code: string): Promise<Response> {
    return fetch(`${baseUrl}/login/verify`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email, code }).toString(),
      redirect: "manual"
    });
  }

  /** The full happy path, returning the issued session cookie value. */
  async function loginAndGetCookie(): Promise<string> {
    await requestCode(MEMBER_EMAIL);
    const code = sent.at(-1)?.code as string;
    const response = await submitCode(MEMBER_EMAIL, code);
    expect(response.status).toBe(303);
    return response.headers.get("set-cookie") as string;
  }

  beforeEach(async () => {
    db = memoryDb();
    new MemberRepository(db).upsert(makeMember());
    clock = new Date(T0);
    sent = [];
    sendResult = { ok: true };
    pending = [];

    server = createPlatformServer({
      db,
      repoRoot: process.cwd(),
      now: () => clock,
      loginCodeSender: fakeSender,
      onLoginSendSettled: (settled) => pending.push(settled)
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // -------------------------------------------------------------------------
  // The login page itself
  // -------------------------------------------------------------------------

  describe("GET /login", () => {
    it("serves a Chinese, self-contained email form", async () => {
      const response = await fetch(`${baseUrl}/login`);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      // `private` as well as `no-store` since N1: this response's writeHead map
      // overrides the server-wide baseline for this key, so it has to carry the
      // whole value (see security.ts / cache-headers.test.ts).
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(body).toContain("登录 AlphaLoop");
      expect(body).toContain('name="email"');
      expect(body).toContain("发送验证码");
      // Same CSP contract every page in this app honors.
      expect(body).not.toMatch(/https?:\/\//iu);
      expect(body).not.toMatch(/<script/iu);
      expect(body).not.toMatch(/<link[^>]+href=/iu);
    });

    it("sends an already-logged-in browser straight to the home page", async () => {
      const cookie = await loginAndGetCookie();
      const response = await fetch(`${baseUrl}/login`, {
        headers: { cookie: cookie.split(";")[0] as string },
        redirect: "manual"
      });

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/");
    });

    it("refuses methods it does not implement", async () => {
      expect((await fetch(`${baseUrl}/login`, { method: "PUT" })).status).toBe(405);
      expect((await fetch(`${baseUrl}/login/verify`, { method: "GET" })).status).toBe(405);
    });
  });

  // -------------------------------------------------------------------------
  // Requesting a code
  // -------------------------------------------------------------------------

  describe("POST /login", () => {
    it("sends exactly one code, to that member's own Feishu open_id", async () => {
      const response = await requestCode(MEMBER_EMAIL);

      expect(response.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.openId).toBe(MEMBER_OPEN_ID);
      expect(sent[0]?.code).toMatch(/^\d{6}$/u);
      expect(sent[0]?.ttlMinutes).toBe(10);
      expect(await response.text()).toContain("验证码已发送");
    });

    it("never puts the code in the HTML it returns", async () => {
      const response = await requestCode(MEMBER_EMAIL);
      expect(await response.text()).not.toContain(sent[0]?.code as string);
    });

    it("stores only a hash of the code, never the plaintext", async () => {
      await requestCode(MEMBER_EMAIL);
      const rows = db.prepare("SELECT code_hash FROM login_codes").all() as Array<{ code_hash: string }>;

      expect(rows).toHaveLength(1);
      expect(rows[0]?.code_hash).not.toContain(sent[0]?.code as string);
      expect(rows[0]?.code_hash.startsWith("scrypt:")).toBe(true);
    });

    it("answers an unknown address exactly like a known one, and sends nothing", async () => {
      const known = await requestCode(MEMBER_EMAIL);
      const knownBody = await known.text();
      sent = [];

      const unknown = await requestCode("nobody@example.com");
      const unknownBody = await unknown.text();

      expect(sent).toHaveLength(0);
      expect(unknown.status).toBe(known.status);
      // Byte-identical once the two things that legitimately differ per
      // response are normalized away: the echoed address (which the browser
      // typed itself and already knows) and the per-request CSP nonce.
      const normalize = (body: string, email: string): string =>
        body.replace(email, "EMAIL").replace(/name="csp-nonce" content="[^"]*"/u, "NONCE");
      expect(normalize(unknownBody, "nobody@example.com")).toBe(normalize(knownBody, MEMBER_EMAIL));
    });

    it("says the same thing for a revoked member, and sends nothing", async () => {
      new MemberRepository(db).upsert(makeMember({ status: "revoked" }));

      const response = await requestCode(MEMBER_EMAIL);

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("验证码已发送");
      expect(sent).toHaveLength(0);
      expect(db.prepare("SELECT COUNT(*) AS c FROM login_codes").get()).toEqual({ c: 0 });
    });

    it("says the same thing for a member with no feishu_open_id on file, and sends nothing", async () => {
      const { feishuOpenId: _dropped, ...withoutOpenId } = makeMember();
      new MemberRepository(db).upsert(withoutOpenId as Member);
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const response = await requestCode(MEMBER_EMAIL);

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("验证码已发送");
      expect(sent).toHaveLength(0);
    });

    it("rejects a syntactically impossible address without claiming to have sent anything", async () => {
      const response = await requestCode("not-an-email");

      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain("请输入有效的邮箱地址");
      expect(body).not.toContain("验证码已发送");
      expect(sent).toHaveLength(0);
    });

    it("matches the member address case-insensitively", async () => {
      await requestCode("Member@Example.COM");
      expect(sent).toHaveLength(1);
    });

    it("invalidates the previous code when a second one is requested", async () => {
      await requestCode(MEMBER_EMAIL);
      const firstCode = sent[0]?.code as string;
      advance(61_000);
      await requestCode(MEMBER_EMAIL);
      const secondCode = sent[1]?.code as string;

      // Distinct codes in this run would make the assertion below accidental;
      // a collision (1 in a million) is retried by asking for a third.
      if (firstCode !== secondCode) {
        expect((await submitCode(MEMBER_EMAIL, firstCode)).status).toBe(401);
      }
      expect((await submitCode(MEMBER_EMAIL, secondCode)).status).toBe(303);
    });
  });

  // -------------------------------------------------------------------------
  // Throttling
  // -------------------------------------------------------------------------

  describe("send throttling", () => {
    it("enforces a cooldown between two sends to the same address, silently", async () => {
      await requestCode(MEMBER_EMAIL);
      expect(sent).toHaveLength(1);

      advance(30_000);
      const response = await requestCode(MEMBER_EMAIL);

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("验证码已发送");
      expect(sent).toHaveLength(1);
    });

    it("caps an address at 3 codes per 15 minutes, then releases as the window slides", async () => {
      for (let i = 0; i < 3; i += 1) {
        await requestCode(MEMBER_EMAIL);
        advance(61_000);
      }
      expect(sent).toHaveLength(3);

      const throttled = await requestCode(MEMBER_EMAIL);
      expect(throttled.status).toBe(200);
      expect(await throttled.text()).toContain("验证码已发送");
      expect(sent).toHaveLength(3);

      // Past the 15-minute window, the first send has aged out.
      advance(15 * 60 * 1000);
      await requestCode(MEMBER_EMAIL);
      expect(sent).toHaveLength(4);
    });

    it("caps one IP at 10 sends per 15 minutes across different addresses", async () => {
      for (let i = 0; i < 10; i += 1) {
        await requestCode(`probe${i}@example.com`, { "cf-connecting-ip": "203.0.113.7" });
        advance(1000);
      }
      // The member's own address is now blocked from that IP too, silently.
      const response = await requestCode(MEMBER_EMAIL, { "cf-connecting-ip": "203.0.113.7" });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("验证码已发送");
      expect(sent).toHaveLength(0);

      // A different IP is unaffected.
      await requestCode(MEMBER_EMAIL, { "cf-connecting-ip": "203.0.113.8" });
      expect(sent).toHaveLength(1);
    });

    it("counts probes of addresses that are not members against the IP budget", async () => {
      for (let i = 0; i < 10; i += 1) {
        await requestCode(`ghost${i}@example.com`, { "cf-connecting-ip": "198.51.100.4" });
      }
      const rows = db.prepare("SELECT COUNT(*) AS c FROM login_send_log WHERE scope = 'ip'").get() as { c: number };
      expect(Number(rows.c)).toBe(10);
    });
  });

  // -------------------------------------------------------------------------
  // Verifying a code
  // -------------------------------------------------------------------------

  describe("POST /login/verify", () => {
    it("exchanges the right code for a signed session cookie and a redirect home", async () => {
      await requestCode(MEMBER_EMAIL);
      const response = await submitCode(MEMBER_EMAIL, sent[0]?.code as string);

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/");

      const cookie = response.headers.get("set-cookie") as string;
      expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("Max-Age=2592000");
    });

    it("rejects a wrong code", async () => {
      await requestCode(MEMBER_EMAIL);
      const wrong = sent[0]?.code === "000000" ? "111111" : "000000";

      const response = await submitCode(MEMBER_EMAIL, wrong);

      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).toContain("验证码不正确或已失效");
    });

    it("rejects an expired code", async () => {
      await requestCode(MEMBER_EMAIL);
      advance(10 * 60 * 1000 + 1);

      const response = await submitCode(MEMBER_EMAIL, sent[0]?.code as string);

      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("rejects a code that was already used once", async () => {
      await requestCode(MEMBER_EMAIL);
      const code = sent[0]?.code as string;
      expect((await submitCode(MEMBER_EMAIL, code)).status).toBe(303);

      const replay = await submitCode(MEMBER_EMAIL, code);

      expect(replay.status).toBe(401);
      expect(replay.headers.get("set-cookie")).toBeNull();
    });

    it("kills the code after 5 wrong guesses - the 6th attempt fails even with the right code", async () => {
      await requestCode(MEMBER_EMAIL);
      const code = sent[0]?.code as string;
      const wrong = (offset: number): string =>
        String((Number(code) + offset) % 1_000_000).padStart(6, "0");

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        expect((await submitCode(MEMBER_EMAIL, wrong(attempt))).status).toBe(401);
      }

      const sixth = await submitCode(MEMBER_EMAIL, code);
      expect(sixth.status).toBe(401);
      expect(sixth.headers.get("set-cookie")).toBeNull();
    });

    it("will not accept one member's code for another address", async () => {
      new MemberRepository(db).upsert(
        makeMember({ id: "member_2", email: "second@example.com", feishuOpenId: "ou_member_2" })
      );
      await requestCode(MEMBER_EMAIL);

      const response = await submitCode("second@example.com", sent[0]?.code as string);
      expect(response.status).toBe(401);
    });

    it("rejects malformed submissions without touching the code's attempt budget", async () => {
      await requestCode(MEMBER_EMAIL);

      expect((await submitCode(MEMBER_EMAIL, "12345")).status).toBe(401);
      expect((await submitCode(MEMBER_EMAIL, "abcdef")).status).toBe(401);
      expect((await submitCode("not-an-email", "123456")).status).toBe(401);
      expect(
        (db.prepare("SELECT attempts FROM login_codes").get() as { attempts: number }).attempts
      ).toBe(0);

      expect((await submitCode(MEMBER_EMAIL, sent[0]?.code as string)).status).toBe(303);
    });

    it("audits the outcome without ever recording the code", async () => {
      await requestCode(MEMBER_EMAIL);
      const code = sent[0]?.code as string;
      await submitCode(MEMBER_EMAIL, code === "000000" ? "111111" : "000000");
      await submitCode(MEMBER_EMAIL, code);

      const rows = db
        .prepare("SELECT action, payload FROM audit_log WHERE category = 'auth' ORDER BY created_at")
        .all() as Array<{ action: string; payload: string }>;

      expect(rows.map((r) => r.action)).toEqual(["login code rejected", "login success"]);
      for (const row of rows) {
        expect(row.payload).not.toContain(code);
      }
    });
  });

  // -------------------------------------------------------------------------
  // The session the login produces
  // -------------------------------------------------------------------------

  describe("session cookie", () => {
    /** `/research/<unknown>` answers 401 for a stranger and 404 for a member -
     * the cleanest identity probe in the app that needs no seeded data. */
    async function probe(headers: Record<string, string> = {}): Promise<number> {
      const response = await fetch(`${baseUrl}/research/does-not-exist`, { headers, redirect: "manual" });
      return response.status;
    }

    it("authenticates a later request to an identity-gated page", async () => {
      const cookie = await loginAndGetCookie();
      expect(await probe({ cookie: cookie.split(";")[0] as string })).toBe(404);
    });

    it("is required: the same page is 401 without it", async () => {
      expect(await probe()).toBe(401);
    });

    it("rejects a tampered cookie", async () => {
      const cookie = (await loginAndGetCookie()).split(";")[0] as string;
      const [name, token] = cookie.split("=") as [string, string];
      const [version, payload, signature] = token.split(".") as [string, string, string];
      const forgedPayload = Buffer.from(JSON.stringify({ m: "member_1", e: T0 + 10 ** 12 }), "utf8").toString(
        "base64url"
      );

      expect(await probe({ cookie: `${name}=${version}.${forgedPayload}.${signature}` })).toBe(401);
      expect(await probe({ cookie: `${name}=${version}.${payload}.AAAA` })).toBe(401);
      expect(await probe({ cookie: `${name}=nonsense` })).toBe(401);
    });

    it("rejects an expired cookie", async () => {
      const expired = createSessionToken("member_1", Date.now() - 1000) as string;
      expect(await probe({ cookie: `${SESSION_COOKIE_NAME}=${expired}` })).toBe(401);
    });

    it("stops working the moment the member is revoked, cookie still valid or not", async () => {
      const cookie = (await loginAndGetCookie()).split(";")[0] as string;
      expect(await probe({ cookie })).toBe(404);

      new MemberRepository(db).upsert(makeMember({ status: "revoked" }));

      expect(await probe({ cookie })).toBe(401);
    });

    it("never resolves a cookie naming a member that no longer exists", async () => {
      const ghost = createSessionToken("member_ghost", Date.now() + 60_000) as string;
      expect(await probe({ cookie: `${SESSION_COOKIE_NAME}=${ghost}` })).toBe(401);
    });

    it("renders the login form (not a dead end) on the 401 page", async () => {
      const response = await fetch(`${baseUrl}/research/does-not-exist`);
      const body = await response.text();

      expect(response.status).toBe(401);
      expect(body).toContain("未获授权");
      expect(body).toContain('action="/login"');
    });
  });

  describe("/logout", () => {
    it("clears the cookie and returns to the login page", async () => {
      const cookie = (await loginAndGetCookie()).split(";")[0] as string;

      const response = await fetch(`${baseUrl}/logout`, { headers: { cookie }, redirect: "manual" });

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login");
      const cleared = response.headers.get("set-cookie") as string;
      expect(cleared).toContain(`${SESSION_COOKIE_NAME}=;`);
      expect(cleared).toContain("Max-Age=0");
      expect(cleared).toContain("HttpOnly");
    });

    it("is harmless when nobody is logged in", async () => {
      const response = await fetch(`${baseUrl}/logout`, { redirect: "manual" });
      expect(response.status).toBe(303);
    });

    it("the cleared cookie value no longer authenticates", async () => {
      const response = await fetch(`${baseUrl}/research/does-not-exist`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=` }
      });
      expect(response.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // The other two identity paths must be exactly as they were
  // -------------------------------------------------------------------------

  describe("other identity paths are unchanged", () => {
    it("bearer tokens still authenticate", async () => {
      const { token } = new ApiTokenRepository(db).issue("member_1", "cli");
      const response = await fetch(`${baseUrl}/research/does-not-exist`, {
        headers: { authorization: `Bearer ${token}` }
      });
      expect(response.status).toBe(404);
    });

    it("the Cloudflare Access email header still fails closed when the verifier is not configured", async () => {
      const saved = process.env.CF_ACCESS_DISABLED;
      delete process.env.CF_ACCESS_DISABLED;
      __resetAccessJwtStateForTests();
      vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const response = await fetch(`${baseUrl}/research/does-not-exist`, {
          headers: { "cf-access-authenticated-user-email": MEMBER_EMAIL }
        });
        expect(response.status).toBe(401);
      } finally {
        if (saved !== undefined) {
          process.env.CF_ACCESS_DISABLED = saved;
        }
        __resetAccessJwtStateForTests();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Logging hygiene
  // -------------------------------------------------------------------------

  describe("logging", () => {
    it("keeps the code out of every log line, including on a delivery failure", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      sendResult = { ok: false, reason: "Feishu rejected the card" };

      await requestCode(MEMBER_EMAIL);
      const code = sent[0]?.code as string;
      await submitCode(MEMBER_EMAIL, code);

      const everythingLogged = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
        .flat()
        .map((entry) => String(entry))
        .join("\n");

      expect(errorSpy).toHaveBeenCalled();
      expect(everythingLogged).toContain("Feishu rejected the card");
      expect(everythingLogged).not.toContain(code);
    });
  });
});
