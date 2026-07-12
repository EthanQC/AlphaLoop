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
import { nowIso } from "./domain.js";

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

    const updated = makeMember({
      displayName: "Updated Name",
      riskTags: [],
      createdAt: "2030-01-01T00:00:00.000Z"
    });
    repo.upsert(updated);

    // Updated fields persist, but created_at stays the original row's value.
    expect(repo.getByEmail(member.email)).toEqual({ ...updated, createdAt: member.createdAt });
  });

  it("upsert throws instead of silently replacing a different member on email collision", () => {
    const db = memoryDb();
    migrate(db);
    const repo = new MemberRepository(db);
    const original = makeMember();
    repo.upsert(original);

    const conflicting = makeMember({ id: "mem_2", feishuOpenId: "ou_456" });

    expect(() => repo.upsert(conflicting)).toThrow(/UNIQUE constraint failed/);
    // The original member must still exist untouched.
    expect(repo.getByEmail(original.email)).toEqual(original);
  });

  it("upsert throws instead of silently replacing a different member on feishu_open_id collision", () => {
    const db = memoryDb();
    migrate(db);
    const repo = new MemberRepository(db);
    const original = makeMember();
    repo.upsert(original);

    const conflicting = makeMember({ id: "mem_2", email: "other@example.com" });

    expect(() => repo.upsert(conflicting)).toThrow(/UNIQUE constraint failed/);
    // The original member must still exist untouched.
    expect(repo.getByFeishuOpenId(original.feishuOpenId!)).toEqual(original);
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

describe("v3 business tables migration", () => {
  it("creates all new business tables", () => {
    const db = memoryDb();
    migrate(db);

    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    for (const table of [
      "discipline_rules",
      "theses",
      "thesis_history",
      "proposals",
      "alert_rules",
      "alert_events",
      "alert_runtime_state",
      "alert_daily_quota",
      "analysis_predictions",
      "research_tasks",
      "run_log"
    ]) {
      expect(names).toContain(table);
    }
  });

  it("rejects an invalid discipline_rules.enforcement value via CHECK constraint", () => {
    const db = memoryDb();
    migrate(db);
    const member = makeMember();
    new MemberRepository(db).upsert(member);

    expect(() =>
      db
        .prepare(`
          INSERT INTO discipline_rules (id, owner_id, rule_text, enforcement, created_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run("rule_1", member.id, "no revenge trading", "not_a_real_enforcement", nowIso())
    ).toThrow(/CHECK constraint failed/);
  });
});

describe("v4 owner_id columns on legacy tables", () => {
  it("upgrades a v1 legacy db to v4, keeping old rows and accepting writes to the new owner_id columns", () => {
    const db = memoryDb();
    // Simulate a legacy db that predates owner_id: create official_paper_snapshots the old way
    // (no owner_id column), user_version left at 0 so migrate() replays v1..v4 from scratch.
    db.exec(`
      CREATE TABLE official_paper_snapshots (
        id TEXT PRIMARY KEY,
        fetched_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        net_assets REAL,
        total_cash REAL,
        market_value REAL NOT NULL,
        positions TEXT NOT NULL,
        raw TEXT NOT NULL
      );
    `);
    db.prepare(`
      INSERT INTO official_paper_snapshots (id, fetched_at, reason, market_value, positions, raw)
      VALUES ('snap_1', '2026-01-01T00:00:00.000Z', 'scheduled', 1000, '[]', '{}')
    `).run();

    migrate(db);

    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    // Old row survived the migration untouched.
    const oldRow = db
      .prepare("SELECT id, reason FROM official_paper_snapshots WHERE id = 'snap_1'")
      .get() as { id: string; reason: string };
    expect(oldRow).toEqual({ id: "snap_1", reason: "scheduled" });

    // New owner_id column exists on the legacy row and accepts writes.
    const member = makeMember();
    new MemberRepository(db).upsert(member);
    db.prepare("UPDATE official_paper_snapshots SET owner_id = ? WHERE id = 'snap_1'").run(member.id);
    const updatedRow = db
      .prepare("SELECT owner_id FROM official_paper_snapshots WHERE id = 'snap_1'")
      .get() as { owner_id: string };
    expect(updatedRow.owner_id).toBe(member.id);

    // A brand-new row can also populate owner_id directly.
    db.prepare(`
      INSERT INTO official_paper_snapshots (id, fetched_at, reason, market_value, positions, raw, owner_id)
      VALUES ('snap_2', '2026-01-02T00:00:00.000Z', 'scheduled', 2000, '[]', '{}', ?)
    `).run(member.id);
    const newRow = db
      .prepare("SELECT owner_id FROM official_paper_snapshots WHERE id = 'snap_2'")
      .get() as { owner_id: string };
    expect(newRow.owner_id).toBe(member.id);
  });
});

describe("v5 feishu_context_messages migration", () => {
  it("creates feishu_context_messages table and index", () => {
    const db = memoryDb();
    migrate(db);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("feishu_context_messages");

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("feishu_context_messages_time_idx");
  });

  it("round-trips a message insert/read", () => {
    const db = memoryDb();
    migrate(db);

    db.prepare(`
      INSERT OR IGNORE INTO feishu_context_messages
      (id, created_at, channel_id, chat_id, sender_id, sender_name, text)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("msg_1", "2026-07-12T00:00:00.000Z", "feishu", "chat_1", "user_1", "Alice", "hello");

    const row = db
      .prepare("SELECT text, sender_name FROM feishu_context_messages WHERE id = 'msg_1'")
      .get() as { text: string; sender_name: string };
    expect(row).toEqual({ text: "hello", sender_name: "Alice" });
  });
});

describe("v6 alert_rules.removed_at migration", () => {
  it("adds the removed_at column and bumps schema version to 6", () => {
    const db = memoryDb();
    migrate(db);

    expect(SCHEMA_VERSION).toBe(6);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    const columns = db.prepare("PRAGMA table_info(alert_rules)").all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toContain("removed_at");
  });

  it("upgrades a legacy db (alert_rules rows present, user_version=5) to v6 without data loss, accepting writes to removed_at", () => {
    const db = memoryDb();
    // Simulate a legacy db that predates removed_at: build members + alert_rules
    // exactly as the v1/v3 migrations leave them (no removed_at column), seed a
    // real row, and leave user_version at 5 so migrate() only has to replay the
    // new v6 step - not the whole history from scratch.
    db.exec(`
      CREATE TABLE members (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        feishu_open_id TEXT UNIQUE,
        display_name TEXT NOT NULL,
        risk_tags TEXT NOT NULL DEFAULT '[]',
        stock_tags TEXT NOT NULL DEFAULT '[]',
        show_performance INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL
      );
      CREATE TABLE alert_rules (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id),
        symbol TEXT NOT NULL, rule_type TEXT NOT NULL CHECK(rule_type IN ('daily_move','unrealized_pnl','spike_5m','exposure')),
        threshold REAL NOT NULL, direction TEXT NOT NULL DEFAULT 'both',
        frequency TEXT NOT NULL CHECK(frequency IN ('once_daily','continuous')),
        hysteresis REAL NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL);
    `);
    db.prepare(`
      INSERT INTO members (id, email, display_name, created_at)
      VALUES ('mem_1', 'legacy@example.com', 'Legacy', ?)
    `).run(nowIso());
    db.prepare(`
      INSERT INTO alert_rules (id, owner_id, symbol, rule_type, threshold, frequency, created_at)
      VALUES ('rule_1', 'mem_1', 'AAPL.US', 'daily_move', 0.04, 'once_daily', ?)
    `).run(nowIso());
    db.exec("PRAGMA user_version = 5");

    migrate(db);

    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    // Old row survived the migration untouched.
    const oldRow = db
      .prepare("SELECT id, symbol FROM alert_rules WHERE id = 'rule_1'")
      .get() as { id: string; symbol: string };
    expect(oldRow).toEqual({ id: "rule_1", symbol: "AAPL.US" });

    // New removed_at column exists on the legacy row and accepts writes.
    db.prepare("UPDATE alert_rules SET removed_at = ? WHERE id = 'rule_1'").run(nowIso());
    const updatedRow = db
      .prepare("SELECT removed_at FROM alert_rules WHERE id = 'rule_1'")
      .get() as { removed_at: string };
    expect(typeof updatedRow.removed_at).toBe("string");
  });
});
