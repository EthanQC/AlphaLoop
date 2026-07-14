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
  it("adds the removed_at column", () => {
    const db = memoryDb();
    migrate(db);

    // SCHEMA_VERSION has since moved on to v7 (task H3) - this test only
    // asserts the removed_at column exists, not any particular version
    // number.
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    const columns = db.prepare("PRAGMA table_info(alert_rules)").all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toContain("removed_at");
  });

  it("upgrades a legacy db (alert_rules rows present, user_version=5) to v6 without data loss, accepting writes to removed_at", () => {
    const db = memoryDb();
    // Simulate a legacy db that predates removed_at: build members + alert_rules
    // exactly as the v1/v3 migrations leave them (no removed_at column), seed a
    // real row, and leave user_version at 5. migrate() replays v6 AND v7 (task
    // H3) from here - a genuine user_version=5 db already has alert_events and
    // stock_analysis_targets (created back in v1/v3), so this fixture includes
    // them too, in their pre-v7 shape, or the v7 step has nothing to rebuild.
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
      CREATE TABLE alert_events (
        id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES alert_rules(id), owner_id TEXT NOT NULL,
        triggered_at TEXT NOT NULL, value REAL NOT NULL, message_id TEXT, feedback TEXT);
      CREATE TABLE stock_analysis_targets (
        symbol TEXT PRIMARY KEY, owner_id TEXT, active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
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

describe("v7 schema hardening: per-owner watchlist, CHECK constraints, event ownership", () => {
  it("bumps schema version to 7 and keeps all four rebuilt tables present", () => {
    const db = memoryDb();
    migrate(db);

    expect(SCHEMA_VERSION).toBe(7);
    expect(getSchemaVersion(db)).toBe(7);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("members");
    expect(names).toContain("alert_rules");
    expect(names).toContain("alert_events");
    expect(names).toContain("stock_analysis_targets");
  });

  it("is idempotent across repeated calls once at v7", () => {
    const db = memoryDb();
    migrate(db);
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
  });

  it("a fresh db lands directly at v7 with no manual intervention", () => {
    const db = memoryDb();
    migrate(db);
    expect(getSchemaVersion(db)).toBe(7);
  });

  it("rejects an invalid alert_rules.direction via CHECK", () => {
    const db = memoryDb();
    migrate(db);
    const member = makeMember();
    new MemberRepository(db).upsert(member);

    expect(() =>
      db
        .prepare(`
          INSERT INTO alert_rules (id, owner_id, symbol, rule_type, threshold, direction, frequency, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run("rule_bad_dir", member.id, "AAPL.US", "daily_move", 0.04, "sideways", "once_daily", nowIso())
    ).toThrow(/CHECK constraint failed/);
  });

  it("rejects an invalid members.status via CHECK", () => {
    const db = memoryDb();
    migrate(db);

    expect(() =>
      db
        .prepare(`
          INSERT INTO members (id, email, display_name, status, created_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run("mem_bad_status", "bad-status@example.com", "Bad Status", "pending", nowIso())
    ).toThrow(/CHECK constraint failed/);
  });

  it("rejects a NULL alert_events.owner_id", () => {
    const db = memoryDb();
    migrate(db);
    const member = makeMember();
    new MemberRepository(db).upsert(member);
    db.prepare(`
      INSERT INTO alert_rules (id, owner_id, symbol, rule_type, threshold, frequency, created_at)
      VALUES ('rule_1', ?, 'AAPL.US', 'daily_move', 0.04, 'once_daily', ?)
    `).run(member.id, nowIso());

    expect(() =>
      db
        .prepare(`
          INSERT INTO alert_events (id, rule_id, owner_id, triggered_at, value)
          VALUES ('evt_1', 'rule_1', NULL, ?, 1.5)
        `)
        .run(nowIso())
    ).toThrow(/NOT NULL constraint failed/);
  });

  it("rejects an alert_events.owner_id that does not reference an existing member (FK)", () => {
    const db = memoryDb();
    migrate(db);
    const member = makeMember();
    new MemberRepository(db).upsert(member);
    db.prepare(`
      INSERT INTO alert_rules (id, owner_id, symbol, rule_type, threshold, frequency, created_at)
      VALUES ('rule_1', ?, 'AAPL.US', 'daily_move', 0.04, 'once_daily', ?)
    `).run(member.id, nowIso());

    expect(() =>
      db
        .prepare(`
          INSERT INTO alert_events (id, rule_id, owner_id, triggered_at, value)
          VALUES ('evt_1', 'rule_1', 'no_such_member', ?, 1.5)
        `)
        .run(nowIso())
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("enforces (symbol, owner_id) uniqueness in stock_analysis_targets while allowing the same symbol under different owners", () => {
    const db = memoryDb();
    migrate(db);
    const now = nowIso();

    db.prepare(`
      INSERT INTO stock_analysis_targets (symbol, owner_id, active, created_at, updated_at)
      VALUES ('AAPL.US', 'member_1', 1, ?, ?)
    `).run(now, now);

    // Same symbol, different owner: this is the whole point of the v7
    // rebuild (per-owner watchlists) - must succeed.
    expect(() =>
      db
        .prepare(`
          INSERT INTO stock_analysis_targets (symbol, owner_id, active, created_at, updated_at)
          VALUES ('AAPL.US', 'member_2', 1, ?, ?)
        `)
        .run(now, now)
    ).not.toThrow();

    // Same symbol, same owner: must be rejected as a duplicate.
    expect(() =>
      db
        .prepare(`
          INSERT INTO stock_analysis_targets (symbol, owner_id, active, created_at, updated_at)
          VALUES ('AAPL.US', 'member_1', 1, ?, ?)
        `)
        .run(now, now)
    ).toThrow(/UNIQUE constraint failed|PRIMARY KEY/);
  });

  it("rejects an empty-string owner_id in stock_analysis_targets via CHECK", () => {
    const db = memoryDb();
    migrate(db);
    const now = nowIso();

    expect(() =>
      db
        .prepare(`
          INSERT INTO stock_analysis_targets (symbol, owner_id, active, created_at, updated_at)
          VALUES ('AAPL.US', '', 1, ?, ?)
        `)
        .run(now, now)
    ).toThrow(/CHECK constraint failed/);
  });

  it("migrates a populated v6 database to v7 with zero row loss and constraints active afterward", () => {
    const db = memoryDb();

    // Build the exact v6 shape by hand (mirrors the v6 describe block above)
    // and seed one row per rebuilt table, plus the owner_id edge cases task
    // H3 calls out:
    //  - a stock_analysis_targets row with NULL owner_id (the pre-v7
    //    single-shared-watchlist shape) -> must backfill to the sentinel
    //    '__legacy_shared__'.
    //  - an alert_events row with NULL owner_id whose rule is still alive
    //    -> must backfill from the rule's owner_id via JOIN.
    //  - an alert_events row with NULL owner_id whose rule has been deleted
    //    out from under it -> must NOT be silently dropped; attributed to a
    //    placeholder member instead.
    //
    // alert_events.owner_id has been declared NOT NULL since v3 in this
    // codebase's actual migration history, so a real production db could
    // never reach the NULL-owner_id state through the app's own write path
    // - but the task brief requires the migration to be robust against it
    // regardless (see database.ts's v7 step comment), so this test builds a
    // deliberately looser legacy shape (no NOT NULL on owner_id) to exercise
    // that defense.
    db.exec(`
      CREATE TABLE members (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, feishu_open_id TEXT UNIQUE,
        display_name TEXT NOT NULL, risk_tags TEXT NOT NULL DEFAULT '[]', stock_tags TEXT NOT NULL DEFAULT '[]',
        show_performance INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL
      );
      CREATE TABLE alert_rules (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id),
        symbol TEXT NOT NULL, rule_type TEXT NOT NULL CHECK(rule_type IN ('daily_move','unrealized_pnl','spike_5m','exposure')),
        threshold REAL NOT NULL, direction TEXT NOT NULL DEFAULT 'both',
        frequency TEXT NOT NULL CHECK(frequency IN ('once_daily','continuous')),
        hysteresis REAL NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, removed_at TEXT);
      CREATE TABLE alert_events (
        id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES alert_rules(id), owner_id TEXT,
        triggered_at TEXT NOT NULL, value REAL NOT NULL, message_id TEXT, feedback TEXT);
      CREATE TABLE stock_analysis_targets (
        symbol TEXT PRIMARY KEY, owner_id TEXT, active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);

    const now = nowIso();
    db.prepare(`INSERT INTO members (id, email, display_name, status, created_at) VALUES ('mem_1', 'legacy@example.com', 'Legacy', 'active', ?)`).run(now);
    db.prepare(`INSERT INTO alert_rules (id, owner_id, symbol, rule_type, threshold, direction, frequency, created_at) VALUES ('rule_1', 'mem_1', 'AAPL.US', 'daily_move', 0.04, 'up', 'once_daily', ?)`).run(now);
    db.prepare(`INSERT INTO alert_rules (id, owner_id, symbol, rule_type, threshold, direction, frequency, created_at) VALUES ('rule_orphan', 'mem_1', 'MSFT.US', 'daily_move', 0.04, 'both', 'once_daily', ?)`).run(now);

    // Normal event: owner_id already set, must survive untouched.
    db.prepare(`INSERT INTO alert_events (id, rule_id, owner_id, triggered_at, value) VALUES ('evt_normal', 'rule_1', 'mem_1', ?, 1.23)`).run(now);
    // Backfillable event: NULL owner_id, but its rule (rule_1) is alive -> owner_id comes from the rule via JOIN.
    db.prepare(`INSERT INTO alert_events (id, rule_id, owner_id, triggered_at, value) VALUES ('evt_backfill', 'rule_1', NULL, ?, 2.34)`).run(now);
    // Orphaned event: NULL owner_id AND its rule (rule_orphan) is about to be deleted.
    db.prepare(`INSERT INTO alert_events (id, rule_id, owner_id, triggered_at, value) VALUES ('evt_orphan', 'rule_orphan', NULL, ?, 3.45)`).run(now);
    // Delete rule_orphan out from under evt_orphan (bypassing the app's own
    // cascading deleteRule(), simulating either a historical bug or manual
    // DB surgery). FK must be dropped temporarily for SQLite to allow it.
    db.exec("PRAGMA foreign_keys = OFF;");
    db.prepare(`DELETE FROM alert_rules WHERE id = 'rule_orphan'`).run();
    db.exec("PRAGMA foreign_keys = ON;");

    db.prepare(`INSERT INTO stock_analysis_targets (symbol, owner_id, active, created_at, updated_at) VALUES ('AAPL.US', 'mem_1', 1, ?, ?)`).run(now, now);
    // Legacy shared-pool row: NULL owner_id, the pre-v7 single-shared-watchlist shape.
    db.prepare(`INSERT INTO stock_analysis_targets (symbol, owner_id, active, created_at, updated_at) VALUES ('NVDA.US', NULL, 1, ?, ?)`).run(now, now);

    db.exec("PRAGMA user_version = 6");

    migrate(db);

    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    // --- zero row loss ---
    // members: the original 'mem_1' PLUS the '__legacy_system__' placeholder
    // the migration had to create to anchor evt_orphan's backfilled owner_id.
    expect((db.prepare("SELECT COUNT(*) c FROM members").get() as { c: number }).c).toBe(2);
    // alert_rules: rule_orphan was deleted in the test's own setup BEFORE
    // migrate() ran (simulating pre-existing corruption), not by the
    // migration itself - only rule_1 survives to be counted here.
    expect((db.prepare("SELECT COUNT(*) c FROM alert_rules").get() as { c: number }).c).toBe(1);
    // alert_events: all three rows preserved - none silently dropped.
    expect((db.prepare("SELECT COUNT(*) c FROM alert_events").get() as { c: number }).c).toBe(3);
    expect((db.prepare("SELECT COUNT(*) c FROM stock_analysis_targets").get() as { c: number }).c).toBe(2);

    // --- spot values ---
    const rule1 = db.prepare("SELECT direction FROM alert_rules WHERE id = 'rule_1'").get() as { direction: string };
    expect(rule1.direction).toBe("up");

    const evtNormal = db.prepare("SELECT owner_id FROM alert_events WHERE id = 'evt_normal'").get() as { owner_id: string };
    expect(evtNormal.owner_id).toBe("mem_1");

    const evtBackfill = db.prepare("SELECT owner_id FROM alert_events WHERE id = 'evt_backfill'").get() as { owner_id: string };
    expect(evtBackfill.owner_id).toBe("mem_1");

    const evtOrphan = db.prepare("SELECT owner_id FROM alert_events WHERE id = 'evt_orphan'").get() as { owner_id: string };
    expect(evtOrphan.owner_id).toBe("__legacy_system__");

    const legacySystemMember = db.prepare("SELECT status FROM members WHERE id = '__legacy_system__'").get() as { status: string };
    expect(legacySystemMember.status).toBe("revoked");

    const aapl = db.prepare("SELECT owner_id FROM stock_analysis_targets WHERE symbol = 'AAPL.US'").get() as { owner_id: string };
    expect(aapl.owner_id).toBe("mem_1");

    const nvda = db.prepare("SELECT owner_id FROM stock_analysis_targets WHERE symbol = 'NVDA.US'").get() as { owner_id: string };
    expect(nvda.owner_id).toBe("__legacy_shared__");

    // --- constraints active afterward ---
    expect(() =>
      db.prepare(`INSERT INTO alert_rules (id, owner_id, symbol, rule_type, threshold, direction, frequency, created_at) VALUES ('rule_bad', 'mem_1', 'TSLA.US', 'daily_move', 0.04, 'sideways', 'once_daily', ?)`).run(now)
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db.prepare(`UPDATE members SET status = 'pending' WHERE id = 'mem_1'`).run()
    ).toThrow(/CHECK constraint failed/);
    expect(() =>
      db.prepare(`INSERT INTO alert_events (id, rule_id, owner_id, triggered_at, value) VALUES ('evt_bad', 'rule_1', NULL, ?, 1)`).run(now)
    ).toThrow(/NOT NULL constraint failed/);
    expect(() =>
      db.prepare(`INSERT INTO stock_analysis_targets (symbol, owner_id, active, created_at, updated_at) VALUES ('AAPL.US', 'mem_1', 1, ?, ?)`).run(now, now)
    ).toThrow(/UNIQUE constraint failed|PRIMARY KEY/);
  });

  it("aborts (with rollback) when a legacy alert_events row references a nonexistent member - the FK the rebuild newly declares", () => {
    const db = memoryDb();

    // The rebuild runs under PRAGMA foreign_keys=OFF, and SQLite never
    // re-validates existing rows when the pragma comes back on - so without
    // an explicit gate, a "ghost" owner_id would be committed into a table
    // whose DDL promises it cannot exist. The gate must fail the migration
    // loudly and leave the db at v6, untouched.
    db.exec(`
      CREATE TABLE members (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, feishu_open_id TEXT UNIQUE,
        display_name TEXT NOT NULL, risk_tags TEXT NOT NULL DEFAULT '[]', stock_tags TEXT NOT NULL DEFAULT '[]',
        show_performance INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL
      );
      CREATE TABLE alert_rules (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id),
        symbol TEXT NOT NULL, rule_type TEXT NOT NULL CHECK(rule_type IN ('daily_move','unrealized_pnl','spike_5m','exposure')),
        threshold REAL NOT NULL, direction TEXT NOT NULL DEFAULT 'both',
        frequency TEXT NOT NULL CHECK(frequency IN ('once_daily','continuous')),
        hysteresis REAL NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, removed_at TEXT);
      CREATE TABLE alert_events (
        id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES alert_rules(id), owner_id TEXT,
        triggered_at TEXT NOT NULL, value REAL NOT NULL, message_id TEXT, feedback TEXT);
      CREATE TABLE stock_analysis_targets (
        symbol TEXT PRIMARY KEY, owner_id TEXT, active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    const now = nowIso();
    db.prepare(`INSERT INTO members (id, email, display_name, status, created_at) VALUES ('mem_1', 'legacy@example.com', 'Legacy', 'active', ?)`).run(now);
    db.prepare(`INSERT INTO alert_rules (id, owner_id, symbol, rule_type, threshold, frequency, created_at) VALUES ('rule_1', 'mem_1', 'AAPL.US', 'daily_move', 0.04, 'once_daily', ?)`).run(now);
    // Ghost: owner_id set to a member that does not exist (only reachable via
    // manual DB surgery - the same class of corruption the orphan-rule path
    // already defends against).
    db.prepare(`INSERT INTO alert_events (id, rule_id, owner_id, triggered_at, value) VALUES ('evt_ghost', 'rule_1', 'ghost_member', ?, 1.0)`).run(now);
    db.exec("PRAGMA user_version = 6");

    expect(() => migrate(db)).toThrow(/nonexistent members.*evt_ghost -> ghost_member/);

    // Rolled back: still v6, data untouched, db usable.
    expect(getSchemaVersion(db)).toBe(6);
    const evt = db.prepare("SELECT owner_id FROM alert_events WHERE id = 'evt_ghost'").get() as { owner_id: string };
    expect(evt.owner_id).toBe("ghost_member");
  });
});
