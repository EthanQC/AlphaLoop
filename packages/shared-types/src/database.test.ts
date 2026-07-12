import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  migrate,
  getSchemaVersion,
  SCHEMA_VERSION,
  MemberRepository,
  ApiTokenRepository
} from "./database.js";
import type { Member } from "./domain.js";

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

describe("versioned migrations", () => {
  it("migrates a fresh db to the latest schema version", () => {
    const db = memoryDb();
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("audit_log");
    expect(names).toContain("official_paper_snapshots");
    expect(names).toContain("members");
    expect(names).toContain("api_tokens");
  });

  it("is idempotent", () => {
    const db = memoryDb();
    migrate(db);
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
  });

  it("adopts a legacy db (tables exist, user_version=0) without data loss", () => {
    const db = memoryDb();
    // simulate legacy: baseline tables created the old way, user_version left at 0
    db.exec(`CREATE TABLE audit_log (id TEXT PRIMARY KEY, category TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);`);
    db.prepare("INSERT INTO audit_log VALUES ('a1','c','act','{}',1)").run();
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    const row = db.prepare("SELECT id FROM audit_log WHERE id='a1'").get() as { id: string };
    expect(row.id).toBe("a1");
  });
});

function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    id: "mem_1",
    email: "test@example.com",
    feishuOpenId: "ou_123",
    displayName: "Test User",
    riskTags: ["aggressive"],
    stockTags: ["AAPL", "TSLA"],
    showPerformance: true,
    status: "active",
    createdAt: "2026-07-12T00:00:00.000Z",
    ...overrides
  };
}

describe("MemberRepository", () => {
  it("upserts a member and round-trips via getByEmail", () => {
    const db = memoryDb();
    migrate(db);
    const repo = new MemberRepository(db);
    const member = makeMember();

    repo.upsert(member);

    expect(repo.getByEmail(member.email)).toEqual(member);
  });

  it("upsert overwrites an existing member by id", () => {
    const db = memoryDb();
    migrate(db);
    const repo = new MemberRepository(db);
    const member = makeMember();
    repo.upsert(member);

    const updated = makeMember({ displayName: "Updated Name", riskTags: [] });
    repo.upsert(updated);

    expect(repo.getByEmail(member.email)).toEqual(updated);
  });

  it("getByEmail returns null when no member matches", () => {
    const db = memoryDb();
    migrate(db);
    const repo = new MemberRepository(db);

    expect(repo.getByEmail("nobody@example.com")).toBeNull();
  });

  it("getByFeishuOpenId round-trips a member", () => {
    const db = memoryDb();
    migrate(db);
    const repo = new MemberRepository(db);
    const member = makeMember();
    repo.upsert(member);

    expect(repo.getByFeishuOpenId("ou_123")).toEqual(member);
    expect(repo.getByFeishuOpenId("ou_missing")).toBeNull();
  });

  it("listActive returns only active members", () => {
    const db = memoryDb();
    migrate(db);
    const repo = new MemberRepository(db);
    const active = makeMember({ id: "mem_1", email: "active@example.com", feishuOpenId: "ou_active" });
    const revoked = makeMember({ id: "mem_2", email: "revoked@example.com", feishuOpenId: "ou_revoked", status: "revoked" });
    repo.upsert(active);
    repo.upsert(revoked);

    const result = repo.listActive();

    expect(result).toEqual([active]);
  });
});

describe("ApiTokenRepository", () => {
  function seedMember(memberDb: DatabaseSync, overrides: Partial<Member> = {}): Member {
    const member = makeMember(overrides);
    new MemberRepository(memberDb).upsert(member);
    return member;
  }

  it("issues a token and verifies it back to the owning member", () => {
    const db = memoryDb();
    migrate(db);
    const member = seedMember(db);
    const tokens = new ApiTokenRepository(db);

    const { id, token } = tokens.issue(member.id, "cli");

    expect(id).toEqual(expect.any(String));
    expect(token).toEqual(expect.any(String));
    expect(tokens.verify(token)).toEqual(member);
  });

  it("verify returns null for an unknown token", () => {
    const db = memoryDb();
    migrate(db);
    const tokens = new ApiTokenRepository(db);

    expect(tokens.verify("not-a-real-token")).toBeNull();
  });

  it("revoke prevents further verification", () => {
    const db = memoryDb();
    migrate(db);
    const member = seedMember(db);
    const tokens = new ApiTokenRepository(db);
    const { id, token } = tokens.issue(member.id, "cli");

    tokens.revoke(id);

    expect(tokens.verify(token)).toBeNull();
  });

  it("verify returns null when the owning member has been revoked", () => {
    const db = memoryDb();
    migrate(db);
    const member = seedMember(db);
    const tokens = new ApiTokenRepository(db);
    const { token } = tokens.issue(member.id, "cli");

    new MemberRepository(db).upsert({ ...member, status: "revoked" });

    expect(tokens.verify(token)).toBeNull();
  });
});
