import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { ApiTokenRepository, MemberRepository, openTradingDatabase } from "../../../packages/shared-types/dist/index.js";
// Full-seam test (per task brief): the CLI writes members/tokens, and
// platform-app's identity layer reads them back through resolveIdentity -
// these two files must be tested AGAINST each other, not just against
// separate mocks of one another.
import { resolveIdentity } from "../../platform-app/src/identity.js";

const cli = await import("./members.mjs");

const tempDirs: string[] = [];

function makeDb(): { db: DatabaseSync; dbPath: string; options: { dbPath: string } } {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-members-cli-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "trading.sqlite");
  const db = openTradingDatabase(dbPath);
  return { db, dbPath, options: { dbPath } };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function auditRows(db: DatabaseSync, action?: string): Array<{ action: string; payload: string }> {
  const rows = action
    ? (db.prepare(`SELECT action, payload FROM audit_log WHERE category = 'platform_members' AND action = ?`).all(action) as Array<{ action: string; payload: string }>)
    : (db.prepare(`SELECT action, payload FROM audit_log WHERE category = 'platform_members'`).all() as Array<{ action: string; payload: string }>);
  return rows;
}

describe("runAdd", () => {
  it("creates an active member with a generated member id and returns it", () => {
    const { options } = makeDb();

    const result = cli.runAdd({ email: "alice@example.com", name: "Alice" }, options);

    expect(result.ok).toBe(true);
    expect(result.member.id).toMatch(/^member_/);
    expect(result.member.email).toBe("alice@example.com");
    expect(result.member.displayName).toBe("Alice");
    expect(result.member.status).toBe("active");
  });

  it("accepts an optional --feishu open id", () => {
    const { options } = makeDb();

    const result = cli.runAdd({ email: "bob@example.com", name: "Bob", feishu: "ou_bob" }, options);

    expect(result.member.feishuOpenId).toBe("ou_bob");
  });

  it("requires --email", () => {
    const { options } = makeDb();
    expect(() => cli.runAdd({ name: "Alice" }, options)).toThrow(/--email/);
  });

  it("requires --name", () => {
    const { options } = makeDb();
    expect(() => cli.runAdd({ email: "alice@example.com" }, options)).toThrow(/--name/);
  });

  it("rejects a duplicate email", () => {
    const { options } = makeDb();
    cli.runAdd({ email: "alice@example.com", name: "Alice" }, options);

    expect(() => cli.runAdd({ email: "alice@example.com", name: "Alice Two" }, options)).toThrow(/邮箱已存在/);
  });

  it("writes an audit_log row on success", () => {
    const { db, options } = makeDb();
    const result = cli.runAdd({ email: "alice@example.com", name: "Alice" }, options);

    const rows = auditRows(db, "add");
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload);
    expect(payload.memberId).toBe(result.member.id);
    expect(payload.email).toBe("alice@example.com");
  });
});

describe("runList", () => {
  it("returns every member, including revoked ones", () => {
    const { options } = makeDb();
    cli.runAdd({ email: "alice@example.com", name: "Alice" }, options);
    const bob = cli.runAdd({ email: "bob@example.com", name: "Bob" }, options).member;
    cli.runRevoke({ member: bob.id }, options);

    const result = cli.runList({}, options);

    expect(result.ok).toBe(true);
    expect(result.members).toHaveLength(2);
    const byId = Object.fromEntries(result.members.map((m: { id: string; status: string }) => [m.id, m.status]));
    expect(byId[bob.id]).toBe("revoked");
  });

  it("does not write an audit_log row (read-only command)", () => {
    const { db, options } = makeDb();
    cli.runAdd({ email: "alice@example.com", name: "Alice" }, options);
    cli.runList({}, options);

    expect(auditRows(db, "list")).toHaveLength(0);
  });
});

describe("runRevoke", () => {
  it("sets status to revoked while preserving other fields", () => {
    const { options } = makeDb();
    const added = cli.runAdd({ email: "alice@example.com", name: "Alice", feishu: "ou_alice" }, options).member;

    const result = cli.runRevoke({ member: added.id }, options);

    expect(result.ok).toBe(true);
    expect(result.status).toBe("revoked");

    const listed = cli.runList({}, options).members.find((m: { id: string }) => m.id === added.id);
    expect(listed).toEqual({ ...added, status: "revoked" });
  });

  it("refuses to revoke __legacy_system__", () => {
    const { options } = makeDb();
    expect(() => cli.runRevoke({ member: "__legacy_system__" }, options)).toThrow(/__legacy_system__/);
  });

  it("refuses an unknown member id", () => {
    const { options } = makeDb();
    expect(() => cli.runRevoke({ member: "member_does_not_exist" }, options)).toThrow(/不存在/);
  });

  it("requires --member", () => {
    const { options } = makeDb();
    expect(() => cli.runRevoke({}, options)).toThrow(/--member/);
  });

  it("writes an audit_log row on success", () => {
    const { db, options } = makeDb();
    const added = cli.runAdd({ email: "alice@example.com", name: "Alice" }, options).member;
    cli.runRevoke({ member: added.id }, options);

    const rows = auditRows(db, "revoke");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload)).toEqual({ memberId: added.id });
  });

  // Full seam test: the CLI's write (revoke) must be observable through
  // platform-app's OWN read path (resolveIdentity), not just through the
  // CLI's own list output.
  it("full seam: after revoke, resolveIdentity via bearer no longer resolves the member", () => {
    const { db, options } = makeDb();
    const added = cli.runAdd({ email: "alice@example.com", name: "Alice" }, options).member;
    const issued = cli.runTokenIssue({ member: added.id, label: "cli" }, options);

    const beforeRevoke = resolveIdentity({ headers: { authorization: `Bearer ${issued.token}` } }, db);
    expect(beforeRevoke?.id).toBe(added.id);

    cli.runRevoke({ member: added.id }, options);

    const afterRevoke = resolveIdentity({ headers: { authorization: `Bearer ${issued.token}` } }, db);
    expect(afterRevoke).toBeNull();
  });
});

describe("runTokenIssue", () => {
  it("issues a token, printing the plaintext exactly once with a Chinese one-time warning", () => {
    const { options } = makeDb();
    const member = cli.runAdd({ email: "alice@example.com", name: "Alice" }, options).member;

    const result = cli.runTokenIssue({ member: member.id, label: "cli-test" }, options);

    expect(result.ok).toBe(true);
    expect(result.tokenId).toMatch(/^token_/);
    expect(typeof result.token).toBe("string");
    expect(result.token.length).toBeGreaterThan(20);
    expect(result.warning).toMatch(/只会显示这一次|仅显示一次|只显示一次/);
  });

  it("rejects an unknown member id", () => {
    const { options } = makeDb();
    expect(() => cli.runTokenIssue({ member: "member_does_not_exist", label: "cli" }, options)).toThrow(/不存在/);
  });

  it("rejects a revoked member", () => {
    const { options } = makeDb();
    const member = cli.runAdd({ email: "alice@example.com", name: "Alice" }, options).member;
    cli.runRevoke({ member: member.id }, options);

    expect(() => cli.runTokenIssue({ member: member.id, label: "cli" }, options)).toThrow(/吊销/);
  });

  it("requires --member and --label", () => {
    const { options } = makeDb();
    const member = cli.runAdd({ email: "alice@example.com", name: "Alice" }, options).member;

    expect(() => cli.runTokenIssue({ label: "cli" }, options)).toThrow(/--member/);
    expect(() => cli.runTokenIssue({ member: member.id }, options)).toThrow(/--label/);
  });

  it("writes an audit_log row referencing only the token id, never the plaintext token", () => {
    const { db, options } = makeDb();
    const member = cli.runAdd({ email: "alice@example.com", name: "Alice" }, options).member;

    const issued = cli.runTokenIssue({ member: member.id, label: "cli-test" }, options);

    const rows = auditRows(db, "token issue");
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload);
    expect(payload.tokenId).toBe(issued.tokenId);
    expect(payload).not.toHaveProperty("token");
    expect(rows[0].payload).not.toContain(issued.token);

    // Belt-and-braces: scan every audit row ever written in this test's db
    // for the plaintext token substring, not just the row we expect it to
    // be absent from.
    const allRows = db.prepare(`SELECT payload FROM audit_log`).all() as Array<{ payload: string }>;
    for (const row of allRows) {
      expect(row.payload).not.toContain(issued.token);
    }
  });

  // Full seam test: the CLI's write (issue) must be observable through
  // platform-app's own read path.
  it("full seam: add -> token issue -> resolveIdentity via bearer resolves the same member", () => {
    const { db, options } = makeDb();
    const added = cli.runAdd({ email: "alice@example.com", name: "Alice" }, options).member;
    const issued = cli.runTokenIssue({ member: added.id, label: "cli" }, options);

    const resolved = resolveIdentity({ headers: { authorization: `Bearer ${issued.token}` } }, db);

    expect(resolved).toEqual(added);
  });
});

describe("runTokenRevoke", () => {
  it("revokes a token so it can no longer verify", () => {
    const { options } = makeDb();
    const member = cli.runAdd({ email: "alice@example.com", name: "Alice" }, options).member;
    const issued = cli.runTokenIssue({ member: member.id, label: "cli" }, options);

    const result = cli.runTokenRevoke({ "token-id": issued.tokenId }, options);

    expect(result.ok).toBe(true);
    expect(result.status).toBe("revoked");
  });

  it("rejects an unknown token id", () => {
    const { options } = makeDb();
    expect(() => cli.runTokenRevoke({ "token-id": "token_does_not_exist" }, options)).toThrow(/不存在/);
  });

  it("requires --token-id", () => {
    const { options } = makeDb();
    expect(() => cli.runTokenRevoke({}, options)).toThrow(/--token-id/);
  });

  it("writes an audit_log row on success", () => {
    const { db, options } = makeDb();
    const member = cli.runAdd({ email: "alice@example.com", name: "Alice" }, options).member;
    const issued = cli.runTokenIssue({ member: member.id, label: "cli" }, options);

    cli.runTokenRevoke({ "token-id": issued.tokenId }, options);

    const rows = auditRows(db, "token revoke");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload)).toEqual({ tokenId: issued.tokenId });
  });

  // Full seam test: after CLI-side token revoke, platform-app's own
  // resolveIdentity must stop resolving via that token.
  it("full seam: after token revoke, resolveIdentity via bearer no longer resolves", () => {
    const { db, options } = makeDb();
    const member = cli.runAdd({ email: "alice@example.com", name: "Alice" }, options).member;
    const issued = cli.runTokenIssue({ member: member.id, label: "cli" }, options);

    const before = resolveIdentity({ headers: { authorization: `Bearer ${issued.token}` } }, db);
    expect(before?.id).toBe(member.id);

    cli.runTokenRevoke({ "token-id": issued.tokenId }, options);

    const after = resolveIdentity({ headers: { authorization: `Bearer ${issued.token}` } }, db);
    expect(after).toBeNull();
  });
});

describe("per-command flag allowlist (H6 pattern: cross-command flags rejected)", () => {
  it("rejects a revoke-only flag (--member) on add", () => {
    expect(() => cli.parseFlags(["--email", "a@example.com", "--name", "A", "--member", "x"], "add")).toThrow(
      /未知参数：--member/
    );
  });

  it("rejects an add-only flag (--email) on revoke", () => {
    expect(() => cli.parseFlags(["--member", "x", "--email", "a@example.com"], "revoke")).toThrow(
      /未知参数：--email/
    );
  });

  it("rejects any flag at all on list", () => {
    expect(() => cli.parseFlags(["--all"], "list")).toThrow(/未知参数：--all/);
  });

  it("rejects a token-revoke-only flag (--token-id) on token issue", () => {
    expect(() =>
      cli.parseFlags(["--member", "x", "--label", "l", "--token-id", "t"], "token issue")
    ).toThrow(/未知参数：--token-id/);
  });

  it("rejects a token-issue-only flag (--label) on token revoke", () => {
    expect(() => cli.parseFlags(["--token-id", "t", "--label", "l"], "token revoke")).toThrow(
      /未知参数：--label/
    );
  });
});

describe("dispatch: 'token' is a two-word command", () => {
  it("routes 'token issue' to the token-issue handler via buildCliResult", () => {
    const { options } = makeDb();
    cli.runAdd({ email: "alice@example.com", name: "Alice" }, options);
    const memberId = cli.runList({}, options).members[0].id;

    const result = cli.buildCliResult(["token", "issue", "--member", memberId, "--label", "cli"], options);

    expect(result.ok).toBe(true);
    expect(result.tokenId).toMatch(/^token_/);
  });

  it("routes 'token revoke' to the token-revoke handler via buildCliResult", () => {
    const { options } = makeDb();
    const member = cli.runAdd({ email: "alice@example.com", name: "Alice" }, options).member;
    const issued = cli.runTokenIssue({ member: member.id, label: "cli" }, options);

    const result = cli.buildCliResult(["token", "revoke", "--token-id", issued.tokenId], options);

    expect(result).toEqual({ ok: true, tokenId: issued.tokenId, status: "revoked" });
  });

  it("rejects 'token' with an unrecognized subcommand", () => {
    const { options } = makeDb();
    const result = cli.buildCliResult(["token", "bogus"], options);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/未知子命令/);
  });

  it("rejects a bare 'token' with no subcommand", () => {
    const { options } = makeDb();
    const result = cli.buildCliResult(["token"], options);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/未知子命令/);
  });
});

describe("buildCliResult: JSON envelope for the whole pre-dispatch + dispatch path", () => {
  it("converts an unknown-flag parseFlags throw into {ok:false, error}", () => {
    const { options } = makeDb();
    const result = cli.buildCliResult(["add", "--email", "a@example.com", "--name", "A", "--bogus", "1"], options);
    expect(result).toEqual({ ok: false, error: "未知参数：--bogus。" });
  });

  it("rejects an unknown top-level command", () => {
    const { options } = makeDb();
    const result = cli.buildCliResult(["frobnicate"], options);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/未知子命令/);
  });

  it("a successful add command round-trips through the envelope", () => {
    const { options } = makeDb();
    const result = cli.buildCliResult(["add", "--email", "a@example.com", "--name", "A"], options);
    expect(result.ok).toBe(true);
    expect(result.member.email).toBe("a@example.com");
  });
});
