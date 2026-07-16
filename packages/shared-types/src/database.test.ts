import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  migrate,
  getSchemaVersion,
  SCHEMA_VERSION,
  MemberRepository,
  ApiTokenRepository,
  ProposalRepository,
  CircuitBreakerRepository,
  OfficialPaperOrderLifecycleRepository,
  ResearchTaskRepository,
  MonthlyReviewRepository,
  usEasternTradingDayUtcRange
} from "./database.js";
import type { NewProposal } from "./database.js";
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

  it("propagates the original migration error instead of a secondary ROLLBACK failure", () => {
    // A fake DatabaseSync-shaped object: reports user_version=0 (so migrate() attempts the very
    // first step, whose `run(db)` executes a multi-statement CREATE TABLE ... string), fails that
    // CREATE TABLE with an ORIGINAL error, and then ALSO fails the ROLLBACK migrate()'s catch
    // issues in response (a SECONDARY error) - simulating a connection that can no longer roll
    // back (e.g. already out of a transaction). Before this task's fix, the un-wrapped
    // `db.exec("ROLLBACK")` would let the SECONDARY error replace the original one that actually
    // explains what went wrong.
    const fakeDb = {
      prepare(sql: string) {
        if (sql.includes("user_version")) {
          return { get: () => ({ user_version: 0 }) };
        }
        throw new Error(`unexpected prepare() in fake db: ${sql}`);
      },
      exec(sql: string) {
        const trimmed = sql.trim();
        if (trimmed.startsWith("CREATE TABLE")) {
          throw new Error("ORIGINAL_FAILURE: disk full while creating table");
        }
        if (trimmed === "ROLLBACK") {
          throw new Error("SECONDARY_FAILURE: cannot rollback - no transaction is active");
        }
        // BEGIN / PRAGMA user_version=n / COMMIT: no-op.
      }
    } as unknown as DatabaseSync;

    expect(() => migrate(fakeDb)).toThrow(/ORIGINAL_FAILURE/);
    expect(() => migrate(fakeDb)).not.toThrow(/SECONDARY_FAILURE/);
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

  it("getById round-trips a member", () => {
    const db = memoryDb();
    migrate(db);
    const repo = new MemberRepository(db);
    const member = makeMember();
    repo.upsert(member);

    expect(repo.getById(member.id)).toEqual(member);
    expect(repo.getById("does-not-exist")).toBeNull();
  });

  it("listAll returns every member regardless of status", () => {
    const db = memoryDb();
    migrate(db);
    const repo = new MemberRepository(db);
    const active = makeMember({ id: "mem_1", email: "active@example.com", feishuOpenId: "ou_active" });
    const revoked = makeMember({ id: "mem_2", email: "revoked@example.com", feishuOpenId: "ou_revoked", status: "revoked" });
    repo.upsert(active);
    repo.upsert(revoked);

    const result = repo.listAll();

    expect(result).toEqual([active, revoked]);
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

  it("stores token_hash as a 64-char hex digest, never the plaintext token itself", () => {
    // P1's core security claim (issue() never persists the plaintext, verify() only ever compares
    // hashes) had no direct assertion until this task - every other test only exercises the
    // round-trip through issue()/verify(), which would pass identically even if token_hash held
    // the plaintext token.
    const db = memoryDb();
    migrate(db);
    const member = seedMember(db);
    const tokens = new ApiTokenRepository(db);

    const { id, token } = tokens.issue(member.id, "cli");

    const row = db
      .prepare("SELECT token_hash FROM api_tokens WHERE id = ?")
      .get(id) as { token_hash: string };

    expect(row.token_hash).not.toBe(token);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
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

  it("revoke reports changes:0 for an unknown token id, changes:1 for a real one", () => {
    const db = memoryDb();
    migrate(db);
    const member = seedMember(db);
    const tokens = new ApiTokenRepository(db);
    const { id } = tokens.issue(member.id, "cli");

    expect(Number(tokens.revoke("does-not-exist").changes)).toBe(0);
    expect(Number(tokens.revoke(id).changes)).toBe(1);
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
  it("keeps all four rebuilt tables present (SCHEMA_VERSION has since moved on to v8, task P4-2)", () => {
    const db = memoryDb();
    migrate(db);

    // SCHEMA_VERSION has since moved on to v8 (Phase 4 Task 2, news engine) -
    // this test only asserts the v7-rebuilt tables exist, not any particular
    // version number (same convention as the v6 describe block above).
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("members");
    expect(names).toContain("alert_rules");
    expect(names).toContain("alert_events");
    expect(names).toContain("stock_analysis_targets");
  });

  it("is idempotent across repeated calls once at the latest version", () => {
    const db = memoryDb();
    migrate(db);
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
  });

  it("a fresh db lands directly at the latest version with no manual intervention", () => {
    const db = memoryDb();
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
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

// All 22 tables that exist as of v7, keyed by table name -> row count this
// helper seeds. Used both to build the "every pre-existing table has data"
// fixture below and to assert none of those counts move when the v8 step
// runs (it is purely additive: three CREATE TABLEs and two CREATE INDEXes,
// touching nothing else - see database.ts's v8 migration step comment).
const V7_TABLE_NAMES = [
  "audit_log",
  "execution_reports",
  "notification_targets",
  "official_paper_order_lifecycle",
  "official_paper_snapshots",
  "paper_strategy_reflections",
  "stock_analysis_targets",
  "stock_analysis_runs",
  "members",
  "api_tokens",
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
  "run_log",
  "feishu_context_messages"
];

// Strips v13's result_json/confidence/title columns back off research_tasks,
// IF present - a defensive, idempotent (checks table_info first) operation
// every buildSeededVxDatabase() fixture below calls, at every level, for the
// exact same reason each of them already repeats `DROP TABLE IF EXISTS
// strategy_cards`/`circuit_breaker_state` at every level regardless of
// whether an earlier level already did it: each fixture's OWN internal
// migrate(db) call advances the schema all the way to the CODE's current
// latest version (v13, now that Phase 8 Task 1 exists) before that fixture
// rolls its OWN user_version back down - so without this, a LATER fixture
// built on top would have its own migrate(db) call try to re-run v13's ADD
// COLUMN step against a table that already has the columns (from the
// earlier fixture's migrate() call), and SQLite has no "ADD COLUMN IF NOT
// EXISTS" to make that safe on its own - unlike a bare table, which a plain
// `DROP TABLE IF EXISTS` handles. research_tasks itself predates every one
// of these fixtures (created at v3), so - unlike v12's strategy_cards, which
// only needed handling from the v11 fixture onward - this needs calling from
// the EARLIEST (v7) fixture forward.
function stripResearchTasksV13ColumnsIfPresent(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(research_tasks)").all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "result_json")) {
    return;
  }

  db.exec(`
    CREATE TABLE research_tasks_pre_v13 (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id),
      question TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','degraded','failed')),
      steps TEXT NOT NULL DEFAULT '[]', budget_spent INTEGER NOT NULL DEFAULT 0,
      result_path TEXT, visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','public')),
      created_at TEXT NOT NULL, finished_at TEXT);
    INSERT INTO research_tasks_pre_v13
      (id, owner_id, question, status, steps, budget_spent, result_path, visibility, created_at, finished_at)
    SELECT id, owner_id, question, status, steps, budget_spent, result_path, visibility, created_at, finished_at
    FROM research_tasks;
    DROP TABLE research_tasks;
    ALTER TABLE research_tasks_pre_v13 RENAME TO research_tasks;
    CREATE INDEX IF NOT EXISTS research_tasks_owner_day_idx ON research_tasks(owner_id, created_at);
  `);
}

// Builds a REAL v7 database (schema produced by the actual migration steps
// 0..6, not hand-copied DDL that could silently drift out of sync with
// database.ts) with one seeded row in every table that exists as of v7, then
// rolls user_version back to 7 so migrate() has every later step left to run.
// Reuses the production migrate() itself to build the baseline schema/
// constraints - the v8-only AND v9-only tables/indexes it also creates along
// the way are dropped immediately after, before any data is seeded, so they
// start this fixture in exactly the same "doesn't exist yet" state a genuine
// pre-v8 production db would be in.
function buildSeededV7Database(): DatabaseSync {
  const db = memoryDb();
  migrate(db); // builds the full v0..v14 schema using the real migration code
  stripResearchTasksV13ColumnsIfPresent(db);
  db.exec(`
    DROP TABLE IF EXISTS monthly_reviews;
    DROP TABLE IF EXISTS strategy_cards;
    DROP TABLE IF EXISTS circuit_breaker_state;
    DROP INDEX IF EXISTS stock_facts_symbol_day_idx;
    DROP TABLE IF EXISTS stock_facts;
    DROP INDEX IF EXISTS news_event_sources_event_idx;
    DROP TABLE IF EXISTS news_event_sources;
    DROP INDEX IF EXISTS news_events_window_idx;
    DROP TABLE IF EXISTS news_events;
    DROP TABLE IF EXISTS daily_facts;
  `);
  db.exec("PRAGMA user_version = 7");

  const now = nowIso();

  db.prepare(`
    INSERT INTO members (id, email, feishu_open_id, display_name, risk_tags, stock_tags, show_performance, status, created_at)
    VALUES ('mem_v7', 'v7-seed@example.com', 'ou_v7_seed', 'V7 Seed Member', '[]', '[]', 1, 'active', ?)
  `).run(now);

  db.prepare(`
    INSERT INTO api_tokens (id, member_id, token_hash, label, revoked_at, created_at)
    VALUES ('token_v7', 'mem_v7', 'deadbeef', 'seed', NULL, ?)
  `).run(now);

  db.prepare(`
    INSERT INTO discipline_rules (id, owner_id, rule_text, enforcement, linked_strategy, enabled, created_at, disabled_at)
    VALUES ('rule_v7', 'mem_v7', 'no revenge trading', 'hard', NULL, 1, ?, NULL)
  `).run(now);

  db.prepare(`
    INSERT INTO theses (id, owner_id, symbol, direction, target_low, target_high, invalidation_price, visibility, status, memory_slug, created_at, updated_at)
    VALUES ('thesis_v7', 'mem_v7', 'AAPL.US', 'bull', 100, 200, 90, 'system', 'active', NULL, ?, ?)
  `).run(now, now);

  db.prepare(`
    INSERT INTO thesis_history (id, thesis_id, note, source, created_at)
    VALUES ('thesis_hist_v7', 'thesis_v7', 'initial note', 'seed', ?)
  `).run(now);

  db.prepare(`
    INSERT INTO proposals (id, owner_id, symbol, side, quantity, order_type, limit_price, reason, evidence, strategy_ref, discipline_report, invalidation, stop_loss, budget_impact, confidence, status, approval_token, consumed_at, decided_at, decided_by, ticket_id, outcome, card_message_id, created_at, expires_at)
    VALUES ('proposal_v7', 'mem_v7', 'AAPL.US', 'buy', 10, 'market', NULL, 'seed reason', '[]', NULL, '[]', NULL, NULL, NULL, NULL, 'pending', 'approval_token_v7', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
  `).run(now, now);

  db.prepare(`
    INSERT INTO alert_rules (id, owner_id, symbol, rule_type, threshold, direction, frequency, hysteresis, enabled, created_at, removed_at)
    VALUES ('alert_rule_v7', 'mem_v7', 'AAPL.US', 'daily_move', 0.04, 'both', 'once_daily', 0, 1, ?, NULL)
  `).run(now);

  db.prepare(`
    INSERT INTO alert_events (id, rule_id, owner_id, triggered_at, value, message_id, feedback)
    VALUES ('alert_event_v7', 'alert_rule_v7', 'mem_v7', ?, 0.05, NULL, NULL)
  `).run(now);

  db.prepare(`
    INSERT INTO alert_runtime_state (rule_id, armed, last_value, cooldown_until, last_fired_trading_day)
    VALUES ('alert_rule_v7', 1, '{}', NULL, NULL)
  `).run();

  db.prepare(`
    INSERT INTO alert_daily_quota (owner_id, trading_day, fired_count)
    VALUES ('mem_v7', '2026-07-14', 1)
  `).run();

  db.prepare(`
    INSERT INTO stock_analysis_targets (symbol, owner_id, active, created_at, updated_at)
    VALUES ('AAPL.US', 'mem_v7', 1, ?, ?)
  `).run(now, now);

  db.prepare(`
    INSERT INTO stock_analysis_runs (id, created_at, symbols, markdown_path, pdf_path, delivery)
    VALUES ('run_v7', ?, '["AAPL.US"]', '/tmp/report.md', '/tmp/report.pdf', '{}')
  `).run(now);

  db.prepare(`
    INSERT INTO official_paper_order_lifecycle
    (id, ticket_id, external_order_id, provider, environment, account_mode, symbol, asset_class, side, quantity, limit_price, broker_status, local_status, lifecycle_stage, submitted_at, last_observed_at, raw, notes, owner_id)
    VALUES ('order_v7', NULL, 'ext_order_v7', 'longbridge-paper', 'paper', 'paper', 'AAPL.US', 'equity', 'buy', 10, NULL, 'filled', 'filled', 'closed', ?, ?, '{}', '[]', 'mem_v7')
  `).run(now, now);

  db.prepare(`
    INSERT INTO official_paper_snapshots (id, fetched_at, reason, net_assets, total_cash, market_value, positions, raw, owner_id)
    VALUES ('snap_v7', ?, 'scheduled', 1000, 500, 500, '[]', '{}', 'mem_v7')
  `).run(now);

  db.prepare(`
    INSERT INTO paper_strategy_reflections (id, snapshot_id, created_at, summary, payload, owner_id)
    VALUES ('reflection_v7', 'snap_v7', ?, 'seed summary', '{}', 'mem_v7')
  `).run(now);

  db.prepare(`
    INSERT INTO analysis_predictions (id, symbol, report_path, conclusion, confidence, review_trigger, review_date, outcome, created_at)
    VALUES ('prediction_v7', 'AAPL.US', '/tmp/report.md', 'bullish', 'medium', NULL, NULL, NULL, ?)
  `).run(now);

  db.prepare(`
    INSERT INTO research_tasks (id, owner_id, question, status, steps, budget_spent, result_path, visibility, created_at, finished_at)
    VALUES ('research_v7', 'mem_v7', 'why did AAPL move', 'done', '[]', 1, NULL, 'private', ?, NULL)
  `).run(now);

  db.prepare(`
    INSERT INTO run_log (id, job, started_at, finished_at, ok, inputs, actions, failed_step, retries, call_count, evidence)
    VALUES ('run_log_v7', 'daily-report', ?, ?, 1, '[]', '[]', NULL, 0, 1, '[]')
  `).run(now, now);

  db.prepare(`
    INSERT INTO audit_log (id, category, action, payload, created_at)
    VALUES ('audit_v7', 'seed', 'seed', '{}', 1)
  `).run();

  db.prepare(`
    INSERT INTO execution_reports (id, category, title, body, metadata, created_at)
    VALUES ('exec_report_v7', 'daily', 'seed report', 'body', '{}', ?)
  `).run(now);

  db.prepare(`
    INSERT INTO notification_targets (channel, target_type, target_id, source, updated_at)
    VALUES ('feishu', 'chat_id', 'chat_v7', 'seed', 1)
  `).run();

  db.prepare(`
    INSERT INTO feishu_context_messages (id, created_at, channel_id, chat_id, sender_id, sender_name, text)
    VALUES ('feishu_msg_v7', ?, 'feishu', 'chat_v7', 'user_v7', 'Seed User', 'hello')
  `).run(now);

  return db;
}

function countRows(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
}

describe("v8 news engine tables migration (Phase 4 Task 2)", () => {
  // SCHEMA_VERSION has since moved on to v9 (Phase 5 Task 1, per-stock
  // facts) - this block only asserts the v8-specific tables/indexes/
  // constraints exist and behave, not any particular version number (same
  // convention as the v6/v7 describe blocks above).
  it("a fresh db lands directly at the latest version, with all three news tables and both indexes present", () => {
    const db = memoryDb();
    migrate(db);

    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("news_events");
    expect(names).toContain("news_event_sources");
    expect(names).toContain("daily_facts");

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("news_events_window_idx");
    expect(indexNames).toContain("news_event_sources_event_idx");
  });

  it("upgrades a v7 db with data in every pre-existing table to the latest version (through v8 and v9) with zero row loss, and is idempotent", () => {
    const db = buildSeededV7Database();
    expect(getSchemaVersion(db)).toBe(7);

    const countsBefore: Record<string, number> = {};
    for (const table of V7_TABLE_NAMES) {
      countsBefore[table] = countRows(db, table);
      expect(countsBefore[table]).toBeGreaterThan(0);
    }

    migrate(db);

    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    for (const table of V7_TABLE_NAMES) {
      expect(countRows(db, table)).toBe(countsBefore[table]);
    }

    // New tables exist and start empty.
    expect(countRows(db, "news_events")).toBe(0);
    expect(countRows(db, "news_event_sources")).toBe(0);
    expect(countRows(db, "daily_facts")).toBe(0);
    expect(countRows(db, "stock_facts")).toBe(0);

    // Idempotent: calling migrate() again on an already-latest db changes nothing.
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    for (const table of V7_TABLE_NAMES) {
      expect(countRows(db, table)).toBe(countsBefore[table]);
    }
  });

  it("rejects an invalid news_events.impact_direction via CHECK", () => {
    const db = memoryDb();
    migrate(db);
    const now = nowIso();

    expect(() =>
      db
        .prepare(`
          INSERT INTO news_events
          (id, cluster_key, title_zh, summary_zh, impact_direction, impact_affected, impact_reason, source_count, zh_source_count, created_at, updated_at)
          VALUES ('evt_bad', 'cluster_bad', '标题', NULL, 'sideways', '[]', NULL, 0, 0, ?, ?)
        `)
        .run(now, now)
    ).toThrow(/CHECK constraint failed/);
  });

  it("enforces news_events.cluster_key UNIQUE", () => {
    const db = memoryDb();
    migrate(db);
    const now = nowIso();

    db.prepare(`
      INSERT INTO news_events
      (id, cluster_key, title_zh, impact_affected, source_count, zh_source_count, created_at, updated_at)
      VALUES ('evt_1', 'cluster_dup', '标题一', '[]', 0, 0, ?, ?)
    `).run(now, now);

    expect(() =>
      db
        .prepare(`
          INSERT INTO news_events
          (id, cluster_key, title_zh, impact_affected, source_count, zh_source_count, created_at, updated_at)
          VALUES ('evt_2', 'cluster_dup', '标题二', '[]', 0, 0, ?, ?)
        `)
        .run(now, now)
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("enforces daily_facts UNIQUE(trading_day, fact_key)", () => {
    const db = memoryDb();
    migrate(db);
    const now = nowIso();

    db.prepare(`
      INSERT INTO daily_facts (id, trading_day, fact_key, value_num, value_text, unit, source, data_time, created_at)
      VALUES ('fact_1', '2026-07-14', 'qqq_price', 522.31, NULL, 'USD', 'longbridge', ?, ?)
    `).run(now, now);

    expect(() =>
      db
        .prepare(`
          INSERT INTO daily_facts (id, trading_day, fact_key, value_num, value_text, unit, source, data_time, created_at)
          VALUES ('fact_2', '2026-07-14', 'qqq_price', 999.99, NULL, 'USD', 'longbridge', ?, ?)
        `)
        .run(now, now)
    ).toThrow(/UNIQUE constraint failed/);

    // Same trading_day, different fact_key: must succeed - the UNIQUE
    // constraint is compound, not on trading_day alone.
    expect(() =>
      db
        .prepare(`
          INSERT INTO daily_facts (id, trading_day, fact_key, value_num, value_text, unit, source, data_time, created_at)
          VALUES ('fact_3', '2026-07-14', 'net_assets', 100000, NULL, 'USD', 'longbridge', ?, ?)
        `)
        .run(now, now)
    ).not.toThrow();
  });
});

// All tables that exist as of v8 (V7_TABLE_NAMES plus the three news-engine
// tables v8 itself added), keyed the same way V7_TABLE_NAMES is - used by the
// v9 migration test below to assert the v9 step (stock_facts) is purely
// additive and touches none of them.
const V8_TABLE_NAMES = [...V7_TABLE_NAMES, "news_events", "news_event_sources", "daily_facts"];

// Builds a REAL v8 database: starts from buildSeededV7Database() (v0..v7
// tables seeded, v8/v9 tables absent, user_version=7), runs the real
// migrate() (which - now that v9 exists - advances through BOTH the v8 and
// v9 steps in one call), then rolls JUST the v9-only stock_facts
// table/index back off and resets user_version to 8. This mirrors
// buildSeededV7Database's own "build via the real migration code, then peel
// off the newest step" technique one level up, so this fixture stays a
// faithful v8 snapshot no matter how many later schema versions get added on
// top in future phases.
function buildSeededV8Database(): DatabaseSync {
  const db = buildSeededV7Database();
  migrate(db);
  stripResearchTasksV13ColumnsIfPresent(db);
  db.exec(`
    DROP TABLE IF EXISTS monthly_reviews;
    DROP TABLE IF EXISTS strategy_cards;
    DROP TABLE IF EXISTS circuit_breaker_state;
    DROP INDEX IF EXISTS stock_facts_symbol_day_idx;
    DROP TABLE IF EXISTS stock_facts;
  `);
  db.exec("PRAGMA user_version = 8");

  const now = nowIso();

  db.prepare(`
    INSERT INTO news_events
    (id, cluster_key, title_zh, summary_zh, impact_direction, impact_affected, impact_reason,
     first_published_at, last_published_at, source_count, zh_source_count, created_at, updated_at)
    VALUES ('news_event_v8', 'cluster_v8', '标题', NULL, 'neutral', '[]', NULL, ?, ?, 1, 0, ?, ?)
  `).run(now, now, now, now);

  db.prepare(`
    INSERT INTO news_event_sources
    (id, event_id, origin, publisher, url, title_raw, published_at, lang, created_at)
    VALUES ('news_source_v8', 'news_event_v8', 'wallstreetcn', '华尔街见闻', 'https://example.com/a', '标题原文', ?, 'zh', ?)
  `).run(now, now);

  db.prepare(`
    INSERT INTO daily_facts (id, trading_day, fact_key, value_num, value_text, unit, source, data_time, created_at)
    VALUES ('daily_fact_v8', '2026-07-14', 'qqq.price', 522.31, NULL, 'USD', 'longbridge-quote', ?, ?)
  `).run(now, now);

  return db;
}

describe("v9 stock_facts table migration (Phase 5 Task 1)", () => {
  // SCHEMA_VERSION has since moved on to v10 (Phase 6 Task 1, circuit breaker
  // state) - see the "v10 circuit_breaker_state" describe block below for the
  // current-version assertion.
  it("a fresh db lands directly at the latest version, with the stock_facts table and its index present", () => {
    const db = memoryDb();
    migrate(db);

    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("stock_facts");

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("stock_facts_symbol_day_idx");
  });

  it("upgrades a v8 db with data in every pre-existing table to the latest version (through v9 and v10) with zero row loss, and is idempotent", () => {
    const db = buildSeededV8Database();
    expect(getSchemaVersion(db)).toBe(8);

    const countsBefore: Record<string, number> = {};
    for (const table of V8_TABLE_NAMES) {
      countsBefore[table] = countRows(db, table);
      expect(countsBefore[table]).toBeGreaterThan(0);
    }

    migrate(db);

    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    for (const table of V8_TABLE_NAMES) {
      expect(countRows(db, table)).toBe(countsBefore[table]);
    }

    // New tables exist and start empty.
    expect(countRows(db, "stock_facts")).toBe(0);
    expect(countRows(db, "circuit_breaker_state")).toBe(0);

    // Idempotent: calling migrate() again on an already-latest db changes nothing.
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    for (const table of V8_TABLE_NAMES) {
      expect(countRows(db, table)).toBe(countsBefore[table]);
    }
  });

  it("enforces stock_facts UNIQUE(trading_day, symbol, fact_key), while allowing the same fact_key across different symbols on the same day", () => {
    const db = memoryDb();
    migrate(db);
    const now = nowIso();

    db.prepare(`
      INSERT INTO stock_facts (id, trading_day, symbol, fact_key, value_num, value_text, unit, source, data_time, created_at)
      VALUES ('fact_1', '2026-07-14', 'AAPL.US', 'quote.last', 210.5, NULL, 'USD', 'longbridge-quote', ?, ?)
    `).run(now, now);

    // Same (trading_day, symbol, fact_key): rejected as a duplicate.
    expect(() =>
      db
        .prepare(`
          INSERT INTO stock_facts (id, trading_day, symbol, fact_key, value_num, value_text, unit, source, data_time, created_at)
          VALUES ('fact_2', '2026-07-14', 'AAPL.US', 'quote.last', 999.99, NULL, 'USD', 'longbridge-quote', ?, ?)
        `)
        .run(now, now)
    ).toThrow(/UNIQUE constraint failed/);

    // Same trading_day and fact_key, DIFFERENT symbol: must succeed - the
    // whole point of scoping the UNIQUE constraint by symbol (unlike
    // daily_facts' (trading_day, fact_key)-only constraint).
    expect(() =>
      db
        .prepare(`
          INSERT INTO stock_facts (id, trading_day, symbol, fact_key, value_num, value_text, unit, source, data_time, created_at)
          VALUES ('fact_3', '2026-07-14', 'MSFT.US', 'quote.last', 430.1, NULL, 'USD', 'longbridge-quote', ?, ?)
        `)
        .run(now, now)
    ).not.toThrow();

    // Same symbol and fact_key, DIFFERENT trading_day: must also succeed.
    expect(() =>
      db
        .prepare(`
          INSERT INTO stock_facts (id, trading_day, symbol, fact_key, value_num, value_text, unit, source, data_time, created_at)
          VALUES ('fact_4', '2026-07-15', 'AAPL.US', 'quote.last', 212.0, NULL, 'USD', 'longbridge-quote', ?, ?)
        `)
        .run(now, now)
    ).not.toThrow();
  });
});

// All tables that exist as of v9 (V8_TABLE_NAMES plus v9's own stock_facts) -
// used by the v10 migration test below to assert the v10 step
// (circuit_breaker_state) is purely additive and touches none of them.
const V9_TABLE_NAMES = [...V8_TABLE_NAMES, "stock_facts"];

// Builds a REAL v9 database: starts from buildSeededV8Database() (v0..v8
// tables seeded, v9/v10 tables absent, user_version=8), runs the real
// migrate() (which - now that v10 exists - advances through BOTH the v9 and
// v10 steps in one call), then rolls JUST the v10-only circuit_breaker_state
// table back off and resets user_version to 9. Same "build via the real
// migration code, then peel off the newest step" technique buildSeededV7/
// V8Database already use, kept one level up so this fixture stays a faithful
// v9 snapshot no matter how many later schema versions get added on top.
function buildSeededV9Database(): DatabaseSync {
  const db = buildSeededV8Database();
  migrate(db);
  stripResearchTasksV13ColumnsIfPresent(db);
  db.exec(`
    DROP TABLE IF EXISTS monthly_reviews;
    DROP TABLE IF EXISTS strategy_cards;
    DROP TABLE IF EXISTS circuit_breaker_state;
  `);
  db.exec("PRAGMA user_version = 9");

  const now = nowIso();

  db.prepare(`
    INSERT INTO stock_facts (id, trading_day, symbol, fact_key, value_num, value_text, unit, source, data_time, created_at)
    VALUES ('stock_fact_v9', '2026-07-14', 'AAPL.US', 'quote.last', 210.5, NULL, 'USD', 'longbridge-quote', ?, ?)
  `).run(now, now);

  return db;
}

describe("v10 circuit_breaker_state table migration (Phase 6 Task 1)", () => {
  // SCHEMA_VERSION has since moved on to v11 (Phase 6 Task 4, nullable
  // official_paper_order_lifecycle.external_order_id) - see the "v11 ..."
  // describe block below for the current-version assertion.

  it("a fresh db lands at least at v10, with the circuit_breaker_state table present (columns/PK/NOT NULL exactly per the plan's frozen DDL)", () => {
    const db = memoryDb();
    migrate(db);

    expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(10);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("circuit_breaker_state");

    const columns = db.prepare("PRAGMA table_info(circuit_breaker_state)").all() as Array<
      { name: string; notnull: number; pk: number }
    >;
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual(
      ["owner_id", "paused_until", "reason", "weekly_loss_pct", "tripped_at"].sort()
    );
    expect(byName.owner_id.pk).toBe(1);
    expect(byName.paused_until.notnull).toBe(1);
    expect(byName.reason.notnull).toBe(1);
    expect(byName.weekly_loss_pct.notnull).toBe(0);
    expect(byName.tripped_at.notnull).toBe(1);
  });

  it("upgrades a v9 db with data in every pre-existing table to v10 with zero row loss, and is idempotent", () => {
    const db = buildSeededV9Database();
    expect(getSchemaVersion(db)).toBe(9);

    const countsBefore: Record<string, number> = {};
    for (const table of V9_TABLE_NAMES) {
      countsBefore[table] = countRows(db, table);
      expect(countsBefore[table]).toBeGreaterThan(0);
    }

    migrate(db);

    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    for (const table of V9_TABLE_NAMES) {
      expect(countRows(db, table)).toBe(countsBefore[table]);
    }

    // New table exists and starts empty.
    expect(countRows(db, "circuit_breaker_state")).toBe(0);

    // Idempotent: calling migrate() again on an already-latest db changes nothing.
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    for (const table of V9_TABLE_NAMES) {
      expect(countRows(db, table)).toBe(countsBefore[table]);
    }
  });

  it("enforces circuit_breaker_state.owner_id FK to members(id)", () => {
    const db = memoryDb();
    migrate(db);
    const now = nowIso();

    expect(() =>
      db
        .prepare(`
          INSERT INTO circuit_breaker_state (owner_id, paused_until, reason, weekly_loss_pct, tripped_at)
          VALUES ('ghost_member', ?, 'weekly loss > 3%', -0.05, ?)
        `)
        .run(now, now)
    ).toThrow(/FOREIGN KEY constraint failed/);

    db.prepare(`
      INSERT INTO members (id, email, feishu_open_id, display_name, risk_tags, stock_tags, show_performance, status, created_at)
      VALUES ('mem_cb_fk', 'cb-fk@example.com', NULL, 'CB FK Member', '[]', '[]', 1, 'active', ?)
    `).run(now);

    expect(() =>
      db
        .prepare(`
          INSERT INTO circuit_breaker_state (owner_id, paused_until, reason, weekly_loss_pct, tripped_at)
          VALUES ('mem_cb_fk', ?, 'weekly loss > 3%', -0.05, ?)
        `)
        .run(now, now)
    ).not.toThrow();
  });
});

function seedMember(db: DatabaseSync, id: string): void {
  db
    .prepare(`
      INSERT INTO members (id, email, feishu_open_id, display_name, risk_tags, stock_tags, show_performance, status, created_at)
      VALUES (?, ?, ?, ?, '[]', '[]', 1, 'active', ?)
    `)
    .run(id, `${id}@example.com`, `ou_${id}`, id, nowIso());
}

function baseNewProposal(overrides: Partial<NewProposal> = {}): NewProposal {
  return {
    ownerId: "mem_owner",
    symbol: "AAPL.US",
    side: "buy",
    quantity: 10,
    orderType: "market",
    reason: "seed reason",
    expiresAt: "2026-07-16T00:00:00.000Z",
    ...overrides
  };
}

describe("ProposalRepository", () => {
  describe("create", () => {
    it("writes a pending row with a generated id/approval_token and round-trips via getById", () => {
      const db = memoryDb();
      migrate(db);
      seedMember(db, "mem_owner");
      const repo = new ProposalRepository(db);

      const proposal = repo.create(baseNewProposal());

      expect(proposal.status).toBe("pending");
      expect(proposal.id).toMatch(/^proposal_/);
      expect(proposal.approvalToken).toMatch(/^approval_/);
      expect(proposal.consumedAt).toBeUndefined();
      expect(proposal.decidedAt).toBeUndefined();
      expect(proposal.ticketId).toBeUndefined();
      expect(proposal.evidence).toEqual([]);
      expect(proposal.disciplineReport).toEqual([]);

      const reloaded = repo.getById(proposal.id);
      expect(reloaded).toEqual(proposal);
    });

    it("round-trips optional fields (limitPrice/strategyRef/invalidation/stopLoss/budgetImpact/confidence/evidence/disciplineReport) when supplied", () => {
      const db = memoryDb();
      migrate(db);
      seedMember(db, "mem_owner");
      const repo = new ProposalRepository(db);

      const proposal = repo.create(
        baseNewProposal({
          orderType: "limit",
          limitPrice: 123.45,
          strategyRef: "strategy_1",
          invalidation: "breaks below 100",
          stopLoss: 95,
          budgetImpact: 0.02,
          confidence: "high",
          evidence: ["https://example.com/a"],
          disciplineReport: [{ ruleId: "rule_1", pass: true }]
        })
      );

      expect(proposal.limitPrice).toBe(123.45);
      expect(proposal.strategyRef).toBe("strategy_1");
      expect(proposal.invalidation).toBe("breaks below 100");
      expect(proposal.stopLoss).toBe(95);
      expect(proposal.budgetImpact).toBe(0.02);
      expect(proposal.confidence).toBe("high");
      expect(proposal.evidence).toEqual(["https://example.com/a"]);
      expect(proposal.disciplineReport).toEqual([{ ruleId: "rule_1", pass: true }]);

      const reloaded = repo.getById(proposal.id);
      expect(reloaded).toEqual(proposal);
    });

    it("requires expiresAt", () => {
      const db = memoryDb();
      migrate(db);
      seedMember(db, "mem_owner");
      const repo = new ProposalRepository(db);

      expect(() => repo.create(baseNewProposal({ expiresAt: "" }))).toThrow(/expiresAt is required/);
    });

    it("rejects an owner_id that does not reference an existing member (FK)", () => {
      const db = memoryDb();
      migrate(db);
      const repo = new ProposalRepository(db);

      expect(() => repo.create(baseNewProposal({ ownerId: "ghost_member" }))).toThrow(
        /FOREIGN KEY constraint failed/
      );
    });
  });

  describe("getById / getByToken", () => {
    it("return null for an unknown id/token", () => {
      const db = memoryDb();
      migrate(db);
      const repo = new ProposalRepository(db);

      expect(repo.getById("proposal_nope")).toBeNull();
      expect(repo.getByToken("approval_nope")).toBeNull();
    });

    it("getByToken finds the same row getById does", () => {
      const db = memoryDb();
      migrate(db);
      seedMember(db, "mem_owner");
      const repo = new ProposalRepository(db);

      const proposal = repo.create(baseNewProposal());
      expect(repo.getByToken(proposal.approvalToken!)).toEqual(proposal);
    });
  });

  describe("consumeApproval", () => {
    it("atomically transitions pending -> approved, sets consumed_at/decided_at/decided_by, and returns the reloaded proposal", () => {
      const db = memoryDb();
      migrate(db);
      seedMember(db, "mem_owner");
      const repo = new ProposalRepository(db);

      const proposal = repo.create(baseNewProposal());
      const decidedAt = nowIso();

      const result = repo.consumeApproval(proposal.approvalToken!, {
        decision: "approved",
        decidedBy: "mem_owner",
        decidedAt
      });

      expect(result.consumed).toBe(true);
      expect(result.proposal?.status).toBe("approved");
      expect(result.proposal?.consumedAt).toBe(decidedAt);
      expect(result.proposal?.decidedAt).toBe(decidedAt);
      expect(result.proposal?.decidedBy).toBe("mem_owner");
    });

    it.each([
      ["approved", "approved"],
      ["approved_half", "approved_half"],
      ["rejected", "rejected"],
      ["expired", "expired"]
    ] as const)("maps decision %s to status %s", (decision, expectedStatus) => {
      const db = memoryDb();
      migrate(db);
      seedMember(db, "mem_owner");
      const repo = new ProposalRepository(db);

      const proposal = repo.create(baseNewProposal());
      const result = repo.consumeApproval(proposal.approvalToken!, {
        decision,
        decidedBy: "mem_owner",
        decidedAt: nowIso()
      });

      expect(result.consumed).toBe(true);
      expect(result.proposal?.status).toBe(expectedStatus);
    });

    it("returns {consumed:false} for an unknown token", () => {
      const db = memoryDb();
      migrate(db);
      const repo = new ProposalRepository(db);

      const result = repo.consumeApproval("approval_nope", {
        decision: "approved",
        decidedBy: "mem_owner",
        decidedAt: nowIso()
      });

      expect(result).toEqual({ consumed: false });
    });

    // CONCURRENCY (plan Task 1 requirement): two consumeApproval calls
    // against the SAME token. SQLite serializes writes on a single
    // connection, so this exercises the exact guarantee the atomic
    // `WHERE approval_token = ? AND consumed_at IS NULL` UPDATE provides -
    // of any number of racing consumers, exactly one observes changes===1.
    it("of two consumeApproval calls racing on the same token, exactly one succeeds - the second is a rejected duplicate, not an error, and does not overwrite the first decision", () => {
      const db = memoryDb();
      migrate(db);
      seedMember(db, "mem_owner");
      const repo = new ProposalRepository(db);

      const proposal = repo.create(baseNewProposal());

      const first = repo.consumeApproval(proposal.approvalToken!, {
        decision: "approved",
        decidedBy: "mem_owner",
        decidedAt: nowIso()
      });
      const second = repo.consumeApproval(proposal.approvalToken!, {
        decision: "rejected",
        decidedBy: "mem_owner",
        decidedAt: nowIso()
      });

      expect(first.consumed).toBe(true);
      expect(second.consumed).toBe(false);
      expect(second.proposal).toBeUndefined();

      // The second (losing) call's decision never took effect.
      const final = repo.getById(proposal.id);
      expect(final?.status).toBe("approved");
    });
  });

  describe("markExecuted", () => {
    it("sets status executed and ticket_id", () => {
      const db = memoryDb();
      migrate(db);
      seedMember(db, "mem_owner");
      const repo = new ProposalRepository(db);
      const proposal = repo.create(baseNewProposal());

      repo.markExecuted(proposal.id, "ticket_1");

      const reloaded = repo.getById(proposal.id);
      expect(reloaded?.status).toBe("executed");
      expect(reloaded?.ticketId).toBe("ticket_1");
    });

    it("is idempotent: re-calling with the SAME ticketId is a no-op", () => {
      const db = memoryDb();
      migrate(db);
      seedMember(db, "mem_owner");
      const repo = new ProposalRepository(db);
      const proposal = repo.create(baseNewProposal());

      repo.markExecuted(proposal.id, "ticket_1");
      expect(() => repo.markExecuted(proposal.id, "ticket_1")).not.toThrow();

      const reloaded = repo.getById(proposal.id);
      expect(reloaded?.status).toBe("executed");
      expect(reloaded?.ticketId).toBe("ticket_1");
    });

    it("throws when re-called with a DIFFERENT ticketId", () => {
      const db = memoryDb();
      migrate(db);
      seedMember(db, "mem_owner");
      const repo = new ProposalRepository(db);
      const proposal = repo.create(baseNewProposal());

      repo.markExecuted(proposal.id, "ticket_1");
      expect(() => repo.markExecuted(proposal.id, "ticket_2")).toThrow(/already executed with ticket ticket_1/);

      // Original ticket_id is preserved, not overwritten by the refused call.
      const reloaded = repo.getById(proposal.id);
      expect(reloaded?.ticketId).toBe("ticket_1");
    });

    it("throws for an unknown proposal id", () => {
      const db = memoryDb();
      migrate(db);
      const repo = new ProposalRepository(db);

      expect(() => repo.markExecuted("proposal_nope", "ticket_1")).toThrow(/not found/);
    });
  });

  describe("markFailed", () => {
    it("sets status failed and outcome", () => {
      const db = memoryDb();
      migrate(db);
      seedMember(db, "mem_owner");
      const repo = new ProposalRepository(db);
      const proposal = repo.create(baseNewProposal());

      repo.markFailed(proposal.id, "broker executor unreachable");

      const reloaded = repo.getById(proposal.id);
      expect(reloaded?.status).toBe("failed");
      expect(reloaded?.outcome).toBe("broker executor unreachable");
    });

    it("throws for an unknown proposal id", () => {
      const db = memoryDb();
      migrate(db);
      const repo = new ProposalRepository(db);

      expect(() => repo.markFailed("proposal_nope", "x")).toThrow(/not found/);
    });
  });

  describe("listPendingExpired", () => {
    it("returns only pending rows whose expires_at <= the given now, ordered by expires_at ascending", () => {
      const db = memoryDb();
      migrate(db);
      seedMember(db, "mem_owner");
      const repo = new ProposalRepository(db);

      const expired1 = repo.create(baseNewProposal({ symbol: "AAPL.US", expiresAt: "2026-07-14T00:00:00.000Z" }));
      const expired2 = repo.create(baseNewProposal({ symbol: "MSFT.US", expiresAt: "2026-07-13T00:00:00.000Z" }));
      const notYetExpired = repo.create(
        baseNewProposal({ symbol: "TSLA.US", expiresAt: "2026-07-20T00:00:00.000Z" })
      );
      const alreadyDecided = repo.create(
        baseNewProposal({ symbol: "NVDA.US", expiresAt: "2026-07-10T00:00:00.000Z" })
      );
      repo.consumeApproval(alreadyDecided.approvalToken!, {
        decision: "approved",
        decidedBy: "mem_owner",
        decidedAt: nowIso()
      });

      const results = repo.listPendingExpired("2026-07-15T00:00:00.000Z");

      expect(results.map((p) => p.id)).toEqual([expired2.id, expired1.id]);
      expect(results.map((p) => p.id)).not.toContain(notYetExpired.id);
      expect(results.map((p) => p.id)).not.toContain(alreadyDecided.id);
    });
  });

  describe("updateCardMessageId", () => {
    it("updates card_message_id", () => {
      const db = memoryDb();
      migrate(db);
      seedMember(db, "mem_owner");
      const repo = new ProposalRepository(db);
      const proposal = repo.create(baseNewProposal());

      repo.updateCardMessageId(proposal.id, "om_msg_1");

      const reloaded = repo.getById(proposal.id);
      expect(reloaded?.cardMessageId).toBe("om_msg_1");
    });

    it("throws for an unknown proposal id", () => {
      const db = memoryDb();
      migrate(db);
      const repo = new ProposalRepository(db);

      expect(() => repo.updateCardMessageId("proposal_nope", "om_msg_1")).toThrow(/not found/);
    });
  });

  describe("listByOwner", () => {
    it("returns only this owner's proposals (never another owner's), regardless of status filter", () => {
      const db = memoryDb();
      migrate(db);
      seedMember(db, "mem_owner");
      seedMember(db, "mem_other");
      const repo = new ProposalRepository(db);

      const first = repo.create(baseNewProposal({ symbol: "AAPL.US" }));
      const second = repo.create(baseNewProposal({ symbol: "MSFT.US" }));
      repo.create(baseNewProposal({ ownerId: "mem_other", symbol: "TSLA.US" }));

      const results = repo.listByOwner("mem_owner");

      expect(results.map((p) => p.id).sort()).toEqual([first.id, second.id].sort());
      expect(results.every((p) => p.ownerId === "mem_owner")).toBe(true);
    });

    it("filters by status when given", () => {
      const db = memoryDb();
      migrate(db);
      seedMember(db, "mem_owner");
      const repo = new ProposalRepository(db);

      const pending = repo.create(baseNewProposal({ symbol: "AAPL.US" }));
      const toApprove = repo.create(baseNewProposal({ symbol: "MSFT.US" }));
      repo.consumeApproval(toApprove.approvalToken!, {
        decision: "approved",
        decidedBy: "mem_owner",
        decidedAt: nowIso()
      });

      expect(repo.listByOwner("mem_owner", "pending").map((p) => p.id)).toEqual([pending.id]);
      expect(repo.listByOwner("mem_owner", "approved").map((p) => p.id)).toEqual([toApprove.id]);
      expect(repo.listByOwner("mem_owner", "rejected")).toEqual([]);
    });

    it("returns an empty array for an owner with no proposals", () => {
      const db = memoryDb();
      migrate(db);
      seedMember(db, "mem_owner");
      const repo = new ProposalRepository(db);

      expect(repo.listByOwner("mem_owner")).toEqual([]);
    });
  });
});

describe("CircuitBreakerRepository", () => {
  it("getState returns null when no row exists", () => {
    const db = memoryDb();
    migrate(db);
    seedMember(db, "mem_owner");
    const repo = new CircuitBreakerRepository(db);

    expect(repo.getState("mem_owner")).toBeNull();
  });

  it("trip creates a paused row that getState/isPaused observe", () => {
    const db = memoryDb();
    migrate(db);
    seedMember(db, "mem_owner");
    const repo = new CircuitBreakerRepository(db);

    repo.trip("mem_owner", { pausedUntil: "2026-07-21T00:00:00.000Z", reason: "周亏超过 3%", weeklyLossPct: -0.041 });

    const state = repo.getState("mem_owner");
    expect(state?.ownerId).toBe("mem_owner");
    expect(state?.pausedUntil).toBe("2026-07-21T00:00:00.000Z");
    expect(state?.reason).toBe("周亏超过 3%");
    expect(state?.weeklyLossPct).toBe(-0.041);
    expect(state?.trippedAt).toBeTruthy();

    expect(repo.isPaused("mem_owner", "2026-07-15T00:00:00.000Z")).toBe(true);
    expect(repo.isPaused("mem_owner", "2026-07-22T00:00:00.000Z")).toBe(false);
  });

  it("isPaused returns false when no row exists at all", () => {
    const db = memoryDb();
    migrate(db);
    seedMember(db, "mem_owner");
    const repo = new CircuitBreakerRepository(db);

    expect(repo.isPaused("mem_owner", nowIso())).toBe(false);
  });

  it("trip upserts: re-tripping an already-paused owner replaces the prior window/reason, one row per owner", () => {
    const db = memoryDb();
    migrate(db);
    seedMember(db, "mem_owner");
    const repo = new CircuitBreakerRepository(db);

    repo.trip("mem_owner", { pausedUntil: "2026-07-21T00:00:00.000Z", reason: "first trip", weeklyLossPct: -0.031 });
    repo.trip("mem_owner", { pausedUntil: "2026-07-28T00:00:00.000Z", reason: "second trip", weeklyLossPct: -0.05 });

    const state = repo.getState("mem_owner");
    expect(state?.pausedUntil).toBe("2026-07-28T00:00:00.000Z");
    expect(state?.reason).toBe("second trip");
    expect(state?.weeklyLossPct).toBe(-0.05);

    const count = (
      db.prepare(`SELECT COUNT(*) c FROM circuit_breaker_state WHERE owner_id = 'mem_owner'`).get() as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  it("clearIfExpired deletes a stale (already-expired) row and returns true", () => {
    const db = memoryDb();
    migrate(db);
    seedMember(db, "mem_owner");
    const repo = new CircuitBreakerRepository(db);

    repo.trip("mem_owner", { pausedUntil: "2026-07-14T00:00:00.000Z", reason: "old trip" });

    const cleared = repo.clearIfExpired("mem_owner", "2026-07-15T00:00:00.000Z");

    expect(cleared).toBe(true);
    expect(repo.getState("mem_owner")).toBeNull();
  });

  it("clearIfExpired leaves an active (not-yet-expired) pause untouched and returns false", () => {
    const db = memoryDb();
    migrate(db);
    seedMember(db, "mem_owner");
    const repo = new CircuitBreakerRepository(db);

    repo.trip("mem_owner", { pausedUntil: "2026-07-21T00:00:00.000Z", reason: "active trip" });

    const cleared = repo.clearIfExpired("mem_owner", "2026-07-15T00:00:00.000Z");

    expect(cleared).toBe(false);
    expect(repo.getState("mem_owner")).not.toBeNull();
  });

  it("rejects an owner_id that does not reference an existing member (FK)", () => {
    const db = memoryDb();
    migrate(db);
    const repo = new CircuitBreakerRepository(db);

    expect(() => repo.trip("ghost_member", { pausedUntil: "2026-07-21T00:00:00.000Z", reason: "x" })).toThrow(
      /FOREIGN KEY constraint failed/
    );
  });
});

// All tables that exist as of v10 (V9_TABLE_NAMES plus v10's own
// circuit_breaker_state) - used by the v11 migration test below to assert the
// v11 step (nullable official_paper_order_lifecycle.external_order_id) loses
// zero rows anywhere, including in the very table it rebuilds.
const V10_TABLE_NAMES = [...V9_TABLE_NAMES, "circuit_breaker_state"];

describe("v11 official_paper_order_lifecycle.external_order_id nullable migration (Phase 6 Task 4)", () => {
  // Global Constraint ⑤ ("先记录后执行"/record-before-execute) requires
  // broker-executor to INSERT a lifecycle row BEFORE calling the broker, at a
  // point where no external_order_id exists yet. The table's original DDL
  // (predating Phase 6) declared external_order_id `NOT NULL UNIQUE`, which
  // makes that impossible - this migration drops NOT NULL only, and is the
  // one DDL change Task 4 needed beyond what the plan's "此外 DDL 冻结"
  // constraint anticipated when it was written (see database.ts's own
  // migration-step comment for the full rationale).
  //
  // SCHEMA_VERSION has since moved on to v12 (Phase 7 Task 1, strategy
  // memory) - see the "v12 ..." describe block below for the current-version
  // assertion; the two checks below are loosened to "at least" the same way
  // v10's own fresh-db test already was.

  it("a fresh db lands at least at v11, with external_order_id nullable (NOT NULL dropped, UNIQUE kept) and the new owner index present", () => {
    const db = memoryDb();
    migrate(db);

    expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(11);

    const columns = db.prepare("PRAGMA table_info(official_paper_order_lifecycle)").all() as Array<
      { name: string; notnull: number }
    >;
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]));
    expect(byName.external_order_id.notnull).toBe(0);
    // Every other column keeps its NOT NULL exactly as before the rebuild.
    // (`id` itself is excluded here: SQLite does not imply NOT NULL for a
    // TEXT PRIMARY KEY the way the SQL standard does, so `id.notnull` was
    // already 0 pre-rebuild too - not something this migration changes.)
    expect(byName.provider.notnull).toBe(1);
    expect(byName.symbol.notnull).toBe(1);
    expect(byName.quantity.notnull).toBe(1);
    expect(byName.broker_status.notnull).toBe(1);
    expect(byName.local_status.notnull).toBe(1);
    expect(byName.lifecycle_stage.notnull).toBe(1);
    expect(byName.submitted_at.notnull).toBe(1);
    expect(byName.last_observed_at.notnull).toBe(1);
    expect(byName.raw.notnull).toBe(1);
    expect(byName.notes.notnull).toBe(1);

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("official_paper_order_lifecycle_status_idx");
    expect(indexNames).toContain("official_paper_order_lifecycle_owner_idx");
  });

  it("allows multiple rows with a NULL external_order_id (record-before-execute), while still rejecting a duplicate non-null value", () => {
    const db = memoryDb();
    migrate(db);
    const now = nowIso();

    const insertNullExternalId = (id: string, ticketId: string) =>
      db.prepare(`
        INSERT INTO official_paper_order_lifecycle
        (id, ticket_id, external_order_id, provider, environment, account_mode, symbol, asset_class,
         side, quantity, limit_price, broker_status, local_status, lifecycle_stage, submitted_at,
         last_observed_at, raw, notes)
        VALUES (?, ?, NULL, 'longbridge-paper', 'paper', 'paper', 'AAPL.US', 'stock', 'buy', 1, 100,
                'pending_submission', 'pending', 'submitting', ?, ?, 'null', '[]')
      `).run(id, ticketId, now, now);

    expect(() => insertNullExternalId("lc_1", "ticket_prop_1")).not.toThrow();
    expect(() => insertNullExternalId("lc_2", "ticket_prop_2")).not.toThrow();

    const insertRealExternalId = (id: string) =>
      db.prepare(`
        INSERT INTO official_paper_order_lifecycle
        (id, ticket_id, external_order_id, provider, environment, account_mode, symbol, asset_class,
         side, quantity, limit_price, broker_status, local_status, lifecycle_stage, submitted_at,
         last_observed_at, raw, notes)
        VALUES (?, NULL, 'ext_dup', 'longbridge-paper', 'paper', 'paper', 'AAPL.US', 'stock', 'buy', 1, 100,
                'Filled', 'accepted', 'filled', ?, ?, 'null', '[]')
      `).run(id, now, now);

    insertRealExternalId("lc_3");
    expect(() => insertRealExternalId("lc_4")).toThrow(/UNIQUE constraint failed/);
  });

  it("upgrades a v10 db with data in every pre-existing table (through v11) with zero row loss, and is idempotent", () => {
    const db = buildSeededV9Database();
    migrate(db); // fixture-build only: advances the underlying schema through v10, v11, v12 AND v13
    stripResearchTasksV13ColumnsIfPresent(db); // peel off v13's own new columns - see the shared helper's own doc comment
    db.exec(`DROP TABLE IF EXISTS monthly_reviews; DROP TABLE IF EXISTS strategy_cards;`); // peel off v14's/v12's own new tables - see buildSeededV7/V8/V9Database's identical technique
    db.exec("PRAGMA user_version = 10"); // roll the VERSION COUNTER back only, same technique buildSeededV7/V9Database already rely on - table shapes are already latest, and re-running the v11 step against an already-nullable table is itself part of what this test proves is safe
    seedMember(db, "mem_v10");
    db.prepare(`
      INSERT INTO circuit_breaker_state (owner_id, paused_until, reason, weekly_loss_pct, tripped_at)
      VALUES ('mem_v10', ?, 'weekly loss > 3%', -0.05, ?)
    `).run(nowIso(), nowIso());

    const countsBefore: Record<string, number> = {};
    for (const table of V10_TABLE_NAMES) {
      countsBefore[table] = countRows(db, table);
      expect(countsBefore[table]).toBeGreaterThan(0);
    }

    migrate(db);

    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    for (const table of V10_TABLE_NAMES) {
      expect(countRows(db, table)).toBe(countsBefore[table]);
    }

    // Idempotent: calling migrate() again on an already-latest db changes nothing.
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    for (const table of V10_TABLE_NAMES) {
      expect(countRows(db, table)).toBe(countsBefore[table]);
    }
  });
});

// Builds a REAL v11 database: starts from buildSeededV9Database() (v9 shape,
// strategy_cards/circuit_breaker_state absent, user_version=9), runs the real
// migrate() (which now advances through v10, v11 AND v12 in one call), then
// peels v12's OWN two changes back off by hand:
//   - drops strategy_cards outright (mirrors buildSeededV7/V8/V9Database's own
//     "peel off every additive table introduced after the version this
//     fixture represents" technique - required here too, or a later
//     migrate() call in a test would hit v12's `CREATE TABLE strategy_cards`
//     a second time and throw "table already exists").
//   - reverses theses' v12 rebuild BY HAND back to its genuine v3 shape (no
//     bull_points/bear_points columns at all), unlike every other "peel off"
//     helper in this file, which accepts the newest step's COLUMN-level
//     changes staying baked in (e.g. official_paper_order_lifecycle's
//     already-nullable external_order_id in the v11 fixture above) because
//     nothing here yet tests a REAL pre-column-existed migration of THAT
//     column. v12 is different: the whole point of this fixture is to prove
//     the v12 table-rebuild recipe backfills bull_points/bear_points to '[]'
//     for rows that genuinely predate those columns - a shortcut that left
//     them already present would make that assertion vacuous.
function buildSeededV11Database(): DatabaseSync {
  const db = buildSeededV9Database();
  migrate(db); // fixture-build only: advances the underlying schema through v10, v11, v12, v13 AND v14
  stripResearchTasksV13ColumnsIfPresent(db); // peel off v13's own new columns - see the shared helper's own doc comment
  db.exec(`DROP TABLE IF EXISTS monthly_reviews; DROP TABLE IF EXISTS strategy_cards;`); // peel off v14's/v12's own new tables

  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(`
    CREATE TABLE theses_v11 (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id),
      symbol TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('bull','bear','neutral')),
      target_low REAL, target_high REAL, invalidation_price REAL,
      visibility TEXT NOT NULL DEFAULT 'system' CHECK(visibility IN ('system','public')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','withdrawn','superseded')),
      memory_slug TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO theses_v11
      (id, owner_id, symbol, direction, target_low, target_high, invalidation_price,
       visibility, status, memory_slug, created_at, updated_at)
    SELECT id, owner_id, symbol, direction, target_low, target_high, invalidation_price,
           visibility, status, memory_slug, created_at, updated_at
    FROM theses;
    DROP TABLE theses;
    ALTER TABLE theses_v11 RENAME TO theses;
    CREATE INDEX theses_owner_symbol_idx ON theses(owner_id, symbol, status);
  `);
  db.exec("PRAGMA foreign_keys = ON;");

  // buildSeededV9Database() (two levels down) drops circuit_breaker_state
  // before resetting its own user_version - the migrate(db) call above
  // recreates it (v10's step) but empty, so it must be reseeded here or
  // V10_TABLE_NAMES's "every table has data" precondition fails.
  seedMember(db, "mem_v11");
  db.prepare(`
    INSERT INTO circuit_breaker_state (owner_id, paused_until, reason, weekly_loss_pct, tripped_at)
    VALUES ('mem_v11', ?, 'weekly loss > 3%', -0.05, ?)
  `).run(nowIso(), nowIso());

  db.exec("PRAGMA user_version = 11");
  return db;
}

// Builds a REAL v12 database: starts from buildSeededV9Database() (v9 shape,
// research_tasks carrying the 'research_v7' row seeded all the way back in
// buildSeededV7Database), runs the real migrate() (which - now that v13
// exists - advances all the way through v10, v11, v12 AND v13 in one call),
// then peels v13's OWN new columns back off research_tasks via the shared
// stripResearchTasksV13ColumnsIfPresent helper above - the same "reversed-
// fixture" technique buildSeededV11Database above already uses (by hand, for
// theses' bull_points/bear_points), needed here for the identical reason:
// v13 didn't exist when that earlier fixture was written, so it had no
// reason to touch research_tasks. Everything else (strategy_cards present
// and empty, theses with bull_points/bear_points) is left exactly as
// migrate() produced it - only research_tasks needs peeling for the v13 test
// below.
function buildSeededV12Database(): DatabaseSync {
  const db = buildSeededV9Database();
  migrate(db); // fixture-build only: advances the underlying schema through v10, v11, v12, v13 AND v14
  stripResearchTasksV13ColumnsIfPresent(db);
  db.exec(`DROP TABLE IF EXISTS monthly_reviews;`); // peel off v14's own new table - see buildSeededV7/V8/V9Database's identical technique

  // buildSeededV9Database() drops circuit_breaker_state before resetting its
  // own user_version - the migrate(db) call above recreates it (v10's step)
  // but empty, so it must be reseeded here (same technique
  // buildSeededV11Database uses above) for V10_TABLE_NAMES's "every table has
  // data" precondition to hold in the v13 test below.
  seedMember(db, "mem_v12");
  db.prepare(`
    INSERT INTO circuit_breaker_state (owner_id, paused_until, reason, weekly_loss_pct, tripped_at)
    VALUES ('mem_v12', ?, 'weekly loss > 3%', -0.05, ?)
  `).run(nowIso(), nowIso());

  db.exec("PRAGMA user_version = 12");
  return db;
}

// Builds a REAL v13 database: starts from buildSeededV9Database() (v9
// shape), runs the real migrate() (which - now that v14 exists (Phase 9
// Task 1) - advances all the way through v10, v11, v12, v13 AND v14 in one
// call), then peels v14's OWN new table (monthly_reviews) back off - the
// same "reversed-fixture" technique buildSeededV11Database/
// buildSeededV12Database above already use, needed here for the identical
// reason: v14 didn't exist when those earlier fixtures were written, so this
// fixture's own migrate(db) call advances straight past v13 to v14 unless
// peeled back. Unlike v13's own COLUMN-level change (which needs the
// dedicated stripResearchTasksV13ColumnsIfPresent rebuild-and-copy helper),
// v14 is a brand-new TABLE - `DROP TABLE IF EXISTS` alone reverses it
// completely, no column-level peel needed. research_tasks is left WITH its
// v13 result_json/confidence/title columns (this fixture represents v13,
// where those columns already exist) - only stock_facts/circuit_breaker_state
// reseeding (below) is needed, same as buildSeededV12Database.
function buildSeededV13Database(): DatabaseSync {
  const db = buildSeededV9Database();
  migrate(db); // fixture-build only: advances the underlying schema through v10..v14
  db.exec(`DROP TABLE IF EXISTS monthly_reviews;`);

  // buildSeededV9Database() drops circuit_breaker_state before resetting its
  // own user_version - the migrate(db) call above recreates it (v10's step)
  // but empty, so it must be reseeded here (same technique
  // buildSeededV11Database/buildSeededV12Database use above) for
  // V10_TABLE_NAMES's "every table has data" precondition to hold in the
  // v14 test below (this fixture reuses that same table-name list).
  seedMember(db, "mem_v13");
  db.prepare(`
    INSERT INTO circuit_breaker_state (owner_id, paused_until, reason, weekly_loss_pct, tripped_at)
    VALUES ('mem_v13', ?, 'weekly loss > 3%', -0.05, ?)
  `).run(nowIso(), nowIso());

  db.exec("PRAGMA user_version = 13");
  return db;
}

describe("v12 strategy_cards + theses evidence columns migration (Phase 7 Task 1, 2026-07-15 plan)", () => {
  // SCHEMA_VERSION has since moved on to v13 (Phase 8 Task 1, research_tasks
  // result columns) - see the "v13 ..." describe block below for the
  // current-version assertion; loosened to "at least" the same way v10/v11's
  // own fresh-db tests already were when a later phase moved SCHEMA_VERSION
  // past the version each of those blocks was originally written to pin.
  it("SCHEMA_VERSION is at least 12", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(12);
  });

  it("a fresh db lands at v12 with strategy_cards present (columns/CHECK/index per the plan's frozen DDL) and theses carrying bull_points/bear_points (NOT NULL DEFAULT '[]'), every v3 column/index intact", () => {
    const db = memoryDb();
    migrate(db);

    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("strategy_cards");

    const cardColumns = db.prepare("PRAGMA table_info(strategy_cards)").all() as Array<
      { name: string; notnull: number; dflt_value: string | null }
    >;
    const cardByName = Object.fromEntries(cardColumns.map((c) => [c.name, c]));
    expect(Object.keys(cardByName).sort()).toEqual(
      [
        "id", "owner_id", "name", "scene", "entry_condition", "risk_control", "exit_rule",
        "status", "visibility", "memory_slug", "created_at", "updated_at"
      ].sort()
    );
    expect(cardByName.owner_id.notnull).toBe(1);
    expect(cardByName.name.notnull).toBe(1);
    expect(cardByName.status.notnull).toBe(1);
    expect(cardByName.visibility.notnull).toBe(1);
    expect(cardByName.created_at.notnull).toBe(1);
    expect(cardByName.updated_at.notnull).toBe(1);

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("strategy_cards_owner_status_idx");
    expect(indexNames).toContain("theses_owner_symbol_idx");

    const thesesColumns = db.prepare("PRAGMA table_info(theses)").all() as Array<
      { name: string; notnull: number; dflt_value: string | null }
    >;
    const thesesByName = Object.fromEntries(thesesColumns.map((c) => [c.name, c]));
    expect(thesesByName.bull_points.notnull).toBe(1);
    expect(thesesByName.bull_points.dflt_value).toBe("'[]'");
    expect(thesesByName.bear_points.notnull).toBe(1);
    expect(thesesByName.bear_points.dflt_value).toBe("'[]'");
    for (const col of [
      "id", "owner_id", "symbol", "direction", "target_low", "target_high", "invalidation_price",
      "visibility", "status", "memory_slug", "created_at", "updated_at"
    ]) {
      expect(thesesByName[col]).toBeDefined();
    }
  });

  it("new theses row defaults bull_points/bear_points to '[]' when not supplied", () => {
    const db = memoryDb();
    migrate(db);
    const member = makeMember();
    new MemberRepository(db).upsert(member);
    const now = nowIso();

    db.prepare(`
      INSERT INTO theses (id, owner_id, symbol, direction, visibility, status, created_at, updated_at)
      VALUES ('thesis_defaults', ?, 'AAPL.US', 'bull', 'system', 'active', ?, ?)
    `).run(member.id, now, now);

    const row = db.prepare("SELECT bull_points, bear_points FROM theses WHERE id = 'thesis_defaults'").get() as {
      bull_points: string; bear_points: string;
    };
    expect(row.bull_points).toBe("[]");
    expect(row.bear_points).toBe("[]");
  });

  it("enforces strategy_cards CHECK(status) and CHECK(visibility)", () => {
    const db = memoryDb();
    migrate(db);
    const member = makeMember();
    new MemberRepository(db).upsert(member);
    const now = nowIso();

    expect(() =>
      db.prepare(`
        INSERT INTO strategy_cards (id, owner_id, name, status, visibility, created_at, updated_at)
        VALUES ('card_bad_status', ?, 'test card', 'not_a_status', 'system', ?, ?)
      `).run(member.id, now, now)
    ).toThrow(/CHECK constraint failed/);

    expect(() =>
      db.prepare(`
        INSERT INTO strategy_cards (id, owner_id, name, status, visibility, created_at, updated_at)
        VALUES ('card_bad_visibility', ?, 'test card', 'active', 'private', ?, ?)
      `).run(member.id, now, now)
    ).toThrow(/CHECK constraint failed/);

    expect(() =>
      db.prepare(`
        INSERT INTO strategy_cards (id, owner_id, name, status, visibility, created_at, updated_at)
        VALUES ('card_ok', ?, 'test card', 'active', 'system', ?, ?)
      `).run(member.id, now, now)
    ).not.toThrow();
  });

  it("theses CHECK(direction)/CHECK(visibility)/CHECK(status) still enforced after the v12 rebuild", () => {
    const db = memoryDb();
    migrate(db);
    const member = makeMember();
    new MemberRepository(db).upsert(member);
    const now = nowIso();

    expect(() =>
      db.prepare(`
        INSERT INTO theses (id, owner_id, symbol, direction, visibility, status, created_at, updated_at)
        VALUES ('thesis_bad_direction', ?, 'AAPL.US', 'sideways', 'system', 'active', ?, ?)
      `).run(member.id, now, now)
    ).toThrow(/CHECK constraint failed/);

    expect(() =>
      db.prepare(`
        INSERT INTO theses (id, owner_id, symbol, direction, visibility, status, created_at, updated_at)
        VALUES ('thesis_bad_visibility', ?, 'AAPL.US', 'bull', 'private', 'active', ?, ?)
      `).run(member.id, now, now)
    ).toThrow(/CHECK constraint failed/);

    expect(() =>
      db.prepare(`
        INSERT INTO theses (id, owner_id, symbol, direction, visibility, status, created_at, updated_at)
        VALUES ('thesis_bad_status', ?, 'AAPL.US', 'bull', 'system', 'not_a_status', ?, ?)
      `).run(member.id, now, now)
    ).toThrow(/CHECK constraint failed/);
  });

  it("upgrades a genuine pre-v12 (v11-shaped, theses WITHOUT bull_points/bear_points) database to v12 with zero row loss - theses/discipline_rules/proposals/etc all preserved, old theses rows backfill bull_points/bear_points to '[]', theses_owner_symbol_idx survives, and it is idempotent", () => {
    const db = buildSeededV11Database();
    expect(getSchemaVersion(db)).toBe(11);

    const thesesColumnsBefore = db.prepare("PRAGMA table_info(theses)").all() as Array<{ name: string }>;
    expect(thesesColumnsBefore.map((c) => c.name)).not.toContain("bull_points");
    expect(thesesColumnsBefore.map((c) => c.name)).not.toContain("bear_points");

    const countsBefore: Record<string, number> = {};
    for (const table of V10_TABLE_NAMES) {
      countsBefore[table] = countRows(db, table);
      expect(countsBefore[table]).toBeGreaterThan(0);
    }

    migrate(db);

    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    for (const table of V10_TABLE_NAMES) {
      expect(countRows(db, table)).toBe(countsBefore[table]);
    }

    // The pre-existing thesis row (seeded back in buildSeededV7Database as
    // 'thesis_v7', carried genuinely column-less through buildSeededV11Database
    // above) survived the rebuild, with both new columns defaulted.
    const thesis = db.prepare("SELECT * FROM theses WHERE id = 'thesis_v7'").get() as Record<string, unknown>;
    expect(thesis).toBeDefined();
    expect(thesis.symbol).toBe("AAPL.US");
    expect(thesis.direction).toBe("bull");
    expect(thesis.bull_points).toBe("[]");
    expect(thesis.bear_points).toBe("[]");

    // strategy_cards exists and starts empty.
    expect(countRows(db, "strategy_cards")).toBe(0);

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("theses_owner_symbol_idx");

    // Idempotent: calling migrate() again on an already-latest db changes nothing.
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    for (const table of V10_TABLE_NAMES) {
      expect(countRows(db, table)).toBe(countsBefore[table]);
    }
  });

  it("aborts (with rollback) when a theses row references a nonexistent member - defends the pre-existing owner_id FK across the rebuild", () => {
    const db = buildSeededV11Database();
    expect(getSchemaVersion(db)).toBe(11);

    // Ghost owner_id, only reachable via manual DB surgery (theses.owner_id has
    // been a real FK to members(id) since v3, so the app's own write path can
    // never produce this) - same class of defensive corruption v7's own gate
    // guards against for alert_events.owner_id.
    db.exec("PRAGMA foreign_keys = OFF;");
    db.prepare(`UPDATE theses SET owner_id = 'ghost_member' WHERE id = 'thesis_v7'`).run();
    db.exec("PRAGMA foreign_keys = ON;");

    expect(() => migrate(db)).toThrow(/nonexistent members.*thesis_v7 -> ghost_member/);

    // Rolled back: still v11, data untouched.
    expect(getSchemaVersion(db)).toBe(11);
    const row = db.prepare("SELECT owner_id FROM theses WHERE id = 'thesis_v7'").get() as { owner_id: string };
    expect(row.owner_id).toBe("ghost_member");
  });
});

describe("v13 research_tasks result columns migration (Phase 8 Task 1, 2026-07-16 plan)", () => {
  // SCHEMA_VERSION has since moved on to v14 (Phase 9 Task 1, monthly
  // reviews) - see the "v14 ..." describe block below for the current-
  // version assertion; loosened to "at least" the same way the v10/v11/v12
  // blocks above already were when a later phase moved SCHEMA_VERSION past
  // the version each of those blocks was originally written to pin.
  it("SCHEMA_VERSION is at least 13", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(13);
  });

  it("a fresh db lands at v13 with result_json/confidence/title present on research_tasks, all nullable", () => {
    const db = memoryDb();
    migrate(db);

    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    const columns = db.prepare("PRAGMA table_info(research_tasks)").all() as Array<
      { name: string; notnull: number }
    >;
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]));
    expect(byName.result_json).toBeDefined();
    expect(byName.result_json.notnull).toBe(0);
    expect(byName.confidence).toBeDefined();
    expect(byName.confidence.notnull).toBe(0);
    expect(byName.title).toBeDefined();
    expect(byName.title.notnull).toBe(0);

    // Every pre-existing column/index from v3 is still intact.
    for (const col of [
      "id", "owner_id", "question", "status", "steps", "budget_spent",
      "result_path", "visibility", "created_at", "finished_at"
    ]) {
      expect(byName[col]).toBeDefined();
    }
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("research_tasks_owner_day_idx");
  });

  it("is idempotent", () => {
    const db = memoryDb();
    migrate(db);
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
  });

  it("enforces CHECK(confidence IS NULL OR confidence IN ('low','medium','high'))", () => {
    const db = memoryDb();
    migrate(db);
    seedMember(db, "mem_v13_check");
    const now = nowIso();

    expect(() =>
      db.prepare(`
        INSERT INTO research_tasks (id, owner_id, question, created_at, confidence)
        VALUES ('rt_bad_confidence', 'mem_v13_check', 'q', ?, 'bogus')
      `).run(now)
    ).toThrow(/CHECK constraint failed/);

    for (const value of ["low", "medium", "high", null]) {
      expect(() =>
        db.prepare(`
          INSERT INTO research_tasks (id, owner_id, question, created_at, confidence)
          VALUES (?, 'mem_v13_check', 'q', ?, ?)
        `).run(`rt_ok_${String(value)}`, now, value)
      ).not.toThrow();
    }
  });

  it("upgrades a genuine pre-v13 (v12-shaped, research_tasks WITHOUT result_json/confidence/title) database to v13 with zero row loss - the pre-existing row is preserved with its original columns intact, the three new columns are NULL, and it is idempotent", () => {
    const db = buildSeededV12Database();
    expect(getSchemaVersion(db)).toBe(12);

    const columnsBefore = db.prepare("PRAGMA table_info(research_tasks)").all() as Array<{ name: string }>;
    expect(columnsBefore.map((c) => c.name)).not.toContain("result_json");
    expect(columnsBefore.map((c) => c.name)).not.toContain("confidence");
    expect(columnsBefore.map((c) => c.name)).not.toContain("title");

    const countsBefore: Record<string, number> = {};
    for (const table of V10_TABLE_NAMES) {
      countsBefore[table] = countRows(db, table);
      if (table !== "strategy_cards") {
        expect(countsBefore[table]).toBeGreaterThan(0);
      }
    }

    migrate(db);

    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    for (const table of V10_TABLE_NAMES) {
      expect(countRows(db, table)).toBe(countsBefore[table]);
    }

    // The pre-existing research_v7 row (seeded in buildSeededV7Database,
    // carried genuinely column-less-on-the-new-three through
    // buildSeededV12Database above) survived the ADD COLUMN step, with every
    // original field intact and the three new columns NULL.
    const row = db.prepare("SELECT * FROM research_tasks WHERE id = 'research_v7'").get() as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.owner_id).toBe("mem_v7");
    expect(row.question).toBe("why did AAPL move");
    expect(row.status).toBe("done");
    expect(row.steps).toBe("[]");
    expect(row.budget_spent).toBe(1);
    expect(row.result_path).toBeNull();
    expect(row.visibility).toBe("private");
    expect(row.result_json).toBeNull();
    expect(row.confidence).toBeNull();
    expect(row.title).toBeNull();

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("research_tasks_owner_day_idx");

    // Idempotent: calling migrate() again on an already-latest db changes nothing.
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    for (const table of V10_TABLE_NAMES) {
      expect(countRows(db, table)).toBe(countsBefore[table]);
    }
  });
});

describe("usEasternTradingDayUtcRange (Phase 8 Task 1)", () => {
  // Same EDT/EST reference instants trading-schedule.test.ts already pins for
  // currentUsEasternTradingWeek's weekStartUtcIso (00:00 America/New_York ==
  // 04:00Z in July/EDT, == 05:00Z in January/EST) - this function mirrors
  // that same nyMidnightUtcIso math, so it must agree on both.
  it("computes [dayStart, nextDayStart) for an EDT (July, UTC-4) trading day", () => {
    expect(usEasternTradingDayUtcRange("2026-07-13")).toEqual({
      dayStart: "2026-07-13T04:00:00.000Z",
      nextDayStart: "2026-07-14T04:00:00.000Z"
    });
  });

  it("computes [dayStart, nextDayStart) for an EST (January, UTC-5) trading day", () => {
    expect(usEasternTradingDayUtcRange("2026-01-12")).toEqual({
      dayStart: "2026-01-12T05:00:00.000Z",
      nextDayStart: "2026-01-13T05:00:00.000Z"
    });
  });

  it("rolls the calendar month/year over correctly at a month/year boundary", () => {
    expect(usEasternTradingDayUtcRange("2026-01-31")).toEqual({
      dayStart: "2026-01-31T05:00:00.000Z",
      nextDayStart: "2026-02-01T05:00:00.000Z"
    });
    expect(usEasternTradingDayUtcRange("2025-12-31")).toEqual({
      dayStart: "2025-12-31T05:00:00.000Z",
      nextDayStart: "2026-01-01T05:00:00.000Z"
    });
  });

  // FIX 4 (DST off-by-one): nyMidnightUtcIso previously sampled the NY UTC
  // offset at NOON UTC of the target date. On a DST transition day, local
  // 00:00 can be on the OTHER side of the transition than noon:
  //   - 2026-03-08 (spring forward, transition at 2am EST->3am EDT == 07:00Z):
  //     local 00:00 is still EST (-5) = 05:00Z, but noon-UTC sampling is
  //     already EDT (-4) by then, wrongly giving 04:00Z.
  //   - 2026-11-01 (fall back, transition at 2am EDT->1am EST == 06:00Z):
  //     local 00:00 is still EDT (-4) = 04:00Z, but noon-UTC sampling is
  //     already EST (-5) by then, wrongly giving 05:00Z.
  it("computes the correct dayStart on the spring-forward transition date itself (2026-03-08)", () => {
    expect(usEasternTradingDayUtcRange("2026-03-08").dayStart).toBe("2026-03-08T05:00:00.000Z");
  });

  it("computes the correct dayStart on the fall-back transition date itself (2026-11-01)", () => {
    expect(usEasternTradingDayUtcRange("2026-11-01").dayStart).toBe("2026-11-01T04:00:00.000Z");
  });

  it("leaves a normal, non-transition day's dayStart unchanged", () => {
    expect(usEasternTradingDayUtcRange("2026-03-04").dayStart).toBe("2026-03-04T05:00:00.000Z");
    expect(usEasternTradingDayUtcRange("2026-04-01").dayStart).toBe("2026-04-01T04:00:00.000Z");
  });
});

// createIfWithinQuota's INSERT always stamps created_at with the real wall
// clock (nowIso(), same as every other repository's `create` in this file -
// e.g. ProposalRepository.create) - it has no injectable clock. Tests below
// that submit MULTIPLE tasks and assert the quota trips must therefore pass
// a `tradingDay` whose US/Eastern window actually contains "right now" (real
// time, whenever the suite happens to run), or every inserted row would fall
// OUTSIDE the window being counted and the quota would never trip. This
// mirrors trading-schedule.mjs's own currentUsEasternTradingDay (not
// imported for the same package-layering reason database.ts's own
// usEasternTradingDayUtcRange isn't - see that function's doc comment).
function todayUsEasternTradingDay(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

describe("ResearchTaskRepository (Phase 8 Task 1, 2026-07-16 plan)", () => {
  function setup() {
    const db = memoryDb();
    migrate(db);
    seedMember(db, "mem_owner");
    seedMember(db, "mem_other");
    return { db, repo: new ResearchTaskRepository(db) };
  }

  describe("countTodayForOwner", () => {
    it("counts only this owner's rows whose created_at falls inside the tradingDay's US/Eastern [dayStart, nextDayStart) window", () => {
      const { db, repo } = setup();
      const insert = (id: string, ownerId: string, createdAt: string) =>
        db.prepare(`
          INSERT INTO research_tasks (id, owner_id, question, status, steps, budget_spent, visibility, created_at)
          VALUES (?, ?, 'q', 'queued', '[]', 0, 'private', ?)
        `).run(id, ownerId, createdAt);

      // tradingDay '2026-07-13' (EDT) -> [2026-07-13T04:00:00.000Z, 2026-07-14T04:00:00.000Z)
      insert("rt_before", "mem_owner", "2026-07-13T03:59:59.999Z"); // just before -> excluded
      insert("rt_at_start", "mem_owner", "2026-07-13T04:00:00.000Z"); // exactly at start -> included
      insert("rt_mid", "mem_owner", "2026-07-13T18:00:00.000Z"); // included
      insert("rt_just_before_end", "mem_owner", "2026-07-14T03:59:59.999Z"); // included
      insert("rt_at_end", "mem_owner", "2026-07-14T04:00:00.000Z"); // exactly at next start -> excluded
      insert("rt_other_owner", "mem_other", "2026-07-13T18:00:00.000Z"); // included window, wrong owner -> excluded

      expect(repo.countTodayForOwner("mem_owner", "2026-07-13")).toBe(3);
      expect(repo.countTodayForOwner("mem_other", "2026-07-13")).toBe(1);
      expect(repo.countTodayForOwner("mem_owner", "2026-07-14")).toBe(1); // rt_at_end belongs to the NEXT trading day
    });

    it("returns 0 for an owner with no research_tasks rows at all", () => {
      const { repo } = setup();
      expect(repo.countTodayForOwner("mem_owner", "2026-07-13")).toBe(0);
    });
  });

  describe("createIfWithinQuota", () => {
    it("succeeds for the first 10 submissions and blocks the 11th, inserting exactly 10 rows (dailyLimit default 10)", () => {
      const { db, repo } = setup();
      const results = [];
      for (let i = 0; i < 11; i += 1) {
        results.push(repo.createIfWithinQuota({ ownerId: "mem_owner", question: `q${i}`, tradingDay: todayUsEasternTradingDay() }));
      }

      for (let i = 0; i < 10; i += 1) {
        expect(results[i]?.ok).toBe(true);
      }
      const eleventh = results[10];
      expect(eleventh?.ok).toBe(false);
      if (eleventh && !eleventh.ok) {
        expect(eleventh.reason).toBe("quota_exceeded");
        expect(eleventh.used).toBe(10);
        expect(eleventh.limit).toBe(10);
      }

      const count = db.prepare(`SELECT COUNT(*) c FROM research_tasks WHERE owner_id = 'mem_owner'`).get() as { c: number };
      expect(count.c).toBe(10);
    });

    it("does not insert a row when quota is exceeded (rollback, not a partial write)", () => {
      const { db, repo } = setup();
      for (let i = 0; i < 10; i += 1) {
        repo.createIfWithinQuota({ ownerId: "mem_owner", question: `q${i}`, tradingDay: todayUsEasternTradingDay() });
      }
      const before = (db.prepare(`SELECT COUNT(*) c FROM research_tasks`).get() as { c: number }).c;
      const blocked = repo.createIfWithinQuota({ ownerId: "mem_owner", question: "q_blocked", tradingDay: todayUsEasternTradingDay() });
      const after = (db.prepare(`SELECT COUNT(*) c FROM research_tasks`).get() as { c: number }).c;

      expect(blocked.ok).toBe(false);
      expect(after).toBe(before);
    });

    it("respects a custom dailyLimit", () => {
      const { repo } = setup();
      const first = repo.createIfWithinQuota({ ownerId: "mem_owner", question: "q0", tradingDay: todayUsEasternTradingDay(), dailyLimit: 1 });
      const second = repo.createIfWithinQuota({ ownerId: "mem_owner", question: "q1", tradingDay: todayUsEasternTradingDay(), dailyLimit: 1 });
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(false);
    });

    it("tracks quota per owner independently", () => {
      const { repo } = setup();
      for (let i = 0; i < 10; i += 1) {
        repo.createIfWithinQuota({ ownerId: "mem_owner", question: `q${i}`, tradingDay: todayUsEasternTradingDay() });
      }
      const otherResult = repo.createIfWithinQuota({ ownerId: "mem_other", question: "q_other", tradingDay: todayUsEasternTradingDay() });
      expect(otherResult.ok).toBe(true);
    });

    it("on success, returns a queued task with steps=[], budget_spent=0, visibility='private', and it round-trips via getById", () => {
      const { repo } = setup();
      const result = repo.createIfWithinQuota({ ownerId: "mem_owner", question: "why did AAPL move", tradingDay: todayUsEasternTradingDay() });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.task.status).toBe("queued");
        expect(result.task.steps).toEqual([]);
        expect(result.task.budgetSpent).toBe(0);
        expect(result.task.visibility).toBe("private");
        expect(result.task.question).toBe("why did AAPL move");

        const reloaded = repo.getById(result.task.id);
        expect(reloaded).toEqual(result.task);
      }
    });
  });

  describe("claimNextQueued", () => {
    it("claims the oldest queued row and flips it to running", () => {
      const { db, repo } = setup();
      db.prepare(`
        INSERT INTO research_tasks (id, owner_id, question, status, steps, budget_spent, visibility, created_at)
        VALUES ('rt_newer', 'mem_owner', 'q2', 'queued', '[]', 0, 'private', '2026-07-13T10:00:00.000Z')
      `).run();
      db.prepare(`
        INSERT INTO research_tasks (id, owner_id, question, status, steps, budget_spent, visibility, created_at)
        VALUES ('rt_older', 'mem_owner', 'q1', 'queued', '[]', 0, 'private', '2026-07-13T09:00:00.000Z')
      `).run();

      const claimed = repo.claimNextQueued(nowIso());
      expect(claimed?.id).toBe("rt_older");
      expect(claimed?.status).toBe("running");

      const stillQueued = repo.getById("rt_newer");
      expect(stillQueued?.status).toBe("queued");
    });

    it("of two claims racing on ONE queued row, exactly one succeeds - the other gets null", () => {
      const { db, repo } = setup();
      db.prepare(`
        INSERT INTO research_tasks (id, owner_id, question, status, steps, budget_spent, visibility, created_at)
        VALUES ('rt_only', 'mem_owner', 'q', 'queued', '[]', 0, 'private', ?)
      `).run(nowIso());

      const first = repo.claimNextQueued(nowIso());
      const second = repo.claimNextQueued(nowIso());

      expect(first?.id).toBe("rt_only");
      expect(first?.status).toBe("running");
      expect(second).toBeNull();
    });

    it("returns null when there are no queued rows", () => {
      const { repo } = setup();
      expect(repo.claimNextQueued(nowIso())).toBeNull();
    });

    it("never claims a row that is already running/done/degraded/failed", () => {
      const { db, repo } = setup();
      for (const status of ["running", "done", "degraded", "failed"]) {
        db.prepare(`
          INSERT INTO research_tasks (id, owner_id, question, status, steps, budget_spent, visibility, created_at)
          VALUES (?, 'mem_owner', 'q', ?, '[]', 0, 'private', ?)
        `).run(`rt_${status}`, status, nowIso());
      }
      expect(repo.claimNextQueued(nowIso())).toBeNull();
    });
  });

  describe("appendStep", () => {
    it("pushes a step onto the steps JSON array, preserving prior steps", () => {
      const { repo } = setup();
      const result = repo.createIfWithinQuota({ ownerId: "mem_owner", question: "q", tradingDay: todayUsEasternTradingDay() });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      repo.appendStep(result.task.id, { step: "intent", message: "解析问题" });
      repo.appendStep(result.task.id, { step: "quote", message: "跳过：未找到 XXX 行情" });

      const reloaded = repo.getById(result.task.id);
      expect(reloaded?.steps).toEqual([
        { step: "intent", message: "解析问题" },
        { step: "quote", message: "跳过：未找到 XXX 行情" }
      ]);
    });

    it("throws for an unknown task id", () => {
      const { repo } = setup();
      expect(() => repo.appendStep("rt_missing", { step: "x" })).toThrow(/not found/);
    });
  });

  describe("setResult", () => {
    it("writes status/result_json/confidence/title/finished_at, round-tripping via getById", () => {
      const { repo } = setup();
      const result = repo.createIfWithinQuota({ ownerId: "mem_owner", question: "q", tradingDay: todayUsEasternTradingDay() });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const resultJson = {
        conclusion: "AAPL 短期承压",
        confidence: "medium" as const,
        keyPoints: [{ text: "营收不及预期", evidenceRefs: ["ev1"] }],
        dataTable: [{ label: "现价", value: 210.5, source: "stock_facts" }],
        comparison: { theses: [], disciplines: [] },
        evidence: [{ ref: "ev1", title: "财报", publisher: "公司公告" }],
        skipped: []
      };
      const finishedAt = nowIso();
      repo.setResult(result.task.id, {
        status: "done",
        resultJson,
        confidence: "medium",
        title: "AAPL 短期研判",
        finishedAt,
        budgetSpent: 7
      });

      const reloaded = repo.getById(result.task.id);
      expect(reloaded?.status).toBe("done");
      expect(reloaded?.resultJson).toEqual(resultJson);
      expect(reloaded?.confidence).toBe("medium");
      expect(reloaded?.title).toBe("AAPL 短期研判");
      expect(reloaded?.finishedAt).toBe(finishedAt);
      expect(reloaded?.budgetSpent).toBe(7);
    });

    it("leaves budget_spent unchanged when the input omits it (COALESCE, not zeroed)", () => {
      const { repo } = setup();
      const result = repo.createIfWithinQuota({ ownerId: "mem_owner", question: "q", tradingDay: todayUsEasternTradingDay() });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // First write sets a budget, a later terminal write that omits it must NOT reset it to 0.
      repo.setResult(result.task.id, { status: "running", finishedAt: nowIso(), budgetSpent: 5 });
      repo.setResult(result.task.id, { status: "done", finishedAt: nowIso() });
      expect(repo.getById(result.task.id)?.budgetSpent).toBe(5);
    });

    it("writes real SQL NULLs (not the JSON string \"null\") for omitted resultJson/confidence/title on a failed task", () => {
      const { db, repo } = setup();
      const result = repo.createIfWithinQuota({ ownerId: "mem_owner", question: "帮我改规则", tradingDay: todayUsEasternTradingDay() });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      repo.setResult(result.task.id, { status: "failed", finishedAt: nowIso() });

      const row = db.prepare(`SELECT result_json, confidence, title FROM research_tasks WHERE id = ?`).get(result.task.id) as {
        result_json: unknown; confidence: unknown; title: unknown;
      };
      expect(row.result_json).toBeNull();
      expect(row.confidence).toBeNull();
      expect(row.title).toBeNull();

      const reloaded = repo.getById(result.task.id);
      expect(reloaded?.resultJson).toBeUndefined();
      expect(reloaded?.confidence).toBeUndefined();
      expect(reloaded?.title).toBeUndefined();
    });

    it("throws for an unknown task id", () => {
      const { repo } = setup();
      expect(() => repo.setResult("rt_missing", { status: "done", finishedAt: nowIso() })).toThrow(/not found/);
    });
  });

  describe("getById", () => {
    it("returns null for an unknown id", () => {
      const { repo } = setup();
      expect(repo.getById("rt_missing")).toBeNull();
    });
  });

  describe("listForOwner", () => {
    it("returns only this owner's rows, newest first, optionally filtered by status", () => {
      const { repo } = setup();
      const q1 = repo.createIfWithinQuota({ ownerId: "mem_owner", question: "q1", tradingDay: todayUsEasternTradingDay() });
      const q2 = repo.createIfWithinQuota({ ownerId: "mem_owner", question: "q2", tradingDay: todayUsEasternTradingDay() });
      repo.createIfWithinQuota({ ownerId: "mem_other", question: "q_other", tradingDay: todayUsEasternTradingDay() });
      expect(q1.ok).toBe(true);
      expect(q2.ok).toBe(true);
      if (!q1.ok || !q2.ok) return;

      repo.setResult(q1.task.id, { status: "done", finishedAt: nowIso() });

      const all = repo.listForOwner("mem_owner");
      expect(all.map((t) => t.id).sort()).toEqual([q1.task.id, q2.task.id].sort());

      const doneOnly = repo.listForOwner("mem_owner", { status: "done" });
      expect(doneOnly.map((t) => t.id)).toEqual([q1.task.id]);
    });

    it("returns an empty array for an owner with no tasks", () => {
      const { repo } = setup();
      expect(repo.listForOwner("mem_owner")).toEqual([]);
    });
  });

  describe("listRunningOrQueued", () => {
    it("returns queued and running rows (any owner), excludes done/degraded/failed, oldest first", () => {
      const { db, repo } = setup();
      const rows: Array<[string, string, string]> = [
        ["rt_q", "queued", "2026-07-13T09:00:00.000Z"],
        ["rt_r", "running", "2026-07-13T08:00:00.000Z"],
        ["rt_done", "done", "2026-07-13T07:00:00.000Z"],
        ["rt_degraded", "degraded", "2026-07-13T06:00:00.000Z"],
        ["rt_failed", "failed", "2026-07-13T05:00:00.000Z"]
      ];
      for (const [id, status, createdAt] of rows) {
        db.prepare(`
          INSERT INTO research_tasks (id, owner_id, question, status, steps, budget_spent, visibility, created_at)
          VALUES (?, 'mem_owner', 'q', ?, '[]', 0, 'private', ?)
        `).run(id, status, createdAt);
      }

      const result = repo.listRunningOrQueued();
      expect(result.map((t) => t.id)).toEqual(["rt_r", "rt_q"]);
    });

    it("returns an empty array when nothing is queued/running", () => {
      const { repo } = setup();
      expect(repo.listRunningOrQueued()).toEqual([]);
    });
  });

  describe("promoteVisibility", () => {
    it("flips private -> public for the owner", () => {
      const { repo } = setup();
      const result = repo.createIfWithinQuota({ ownerId: "mem_owner", question: "q", tradingDay: todayUsEasternTradingDay() });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const promoted = repo.promoteVisibility(result.task.id, "mem_owner");
      expect(promoted.visibility).toBe("public");
      expect(repo.getById(result.task.id)?.visibility).toBe("public");
    });

    it("is idempotent once already public", () => {
      const { repo } = setup();
      const result = repo.createIfWithinQuota({ ownerId: "mem_owner", question: "q", tradingDay: todayUsEasternTradingDay() });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      repo.promoteVisibility(result.task.id, "mem_owner");
      expect(() => repo.promoteVisibility(result.task.id, "mem_owner")).not.toThrow();
      expect(repo.getById(result.task.id)?.visibility).toBe("public");
    });

    it("rejects a non-owner's promote attempt, leaving visibility private", () => {
      const { repo } = setup();
      const result = repo.createIfWithinQuota({ ownerId: "mem_owner", question: "q", tradingDay: todayUsEasternTradingDay() });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(() => repo.promoteVisibility(result.task.id, "mem_other")).toThrow();
      expect(repo.getById(result.task.id)?.visibility).toBe("private");
    });

    it("throws for an unknown task id", () => {
      const { repo } = setup();
      expect(() => repo.promoteVisibility("rt_missing", "mem_owner")).toThrow(/not found/);
    });
  });
});

describe("OfficialPaperOrderLifecycleRepository record-before-execute additions (Phase 6 Task 4)", () => {
  function setup() {
    const db = memoryDb();
    migrate(db);
    seedMember(db, "mem_owner");
    return { db, repo: new OfficialPaperOrderLifecycleRepository(db) };
  }

  it("insertSubmitting writes a stage='submitting' row with no external_order_id, findable by getByTicketId", () => {
    const { repo } = setup();
    repo.insertSubmitting({
      ticketId: "ticket_prop_1",
      ownerId: "mem_owner",
      symbol: "AAPL.US",
      assetClass: "stock",
      side: "buy",
      quantity: 5,
      limitPrice: 100,
      submittedAt: nowIso()
    });

    const row = repo.getByTicketId("ticket_prop_1");
    expect(row?.lifecycleStage).toBe("submitting");
    expect(row?.externalOrderId).toBeUndefined();
    expect(row?.ownerId).toBe("mem_owner");
    expect(row?.quantity).toBe(5);
    expect(row?.limitPrice).toBe(100);
  });

  it("getByTicketId returns null when no row exists for that ticket", () => {
    const { repo } = setup();
    expect(repo.getByTicketId("ticket_prop_missing")).toBeNull();
  });

  it("markSubmitUnconfirmed flips stage to submit_unconfirmed without ever setting external_order_id", () => {
    const { repo } = setup();
    repo.insertSubmitting({
      ticketId: "ticket_prop_2",
      ownerId: "mem_owner",
      symbol: "AAPL.US",
      assetClass: "stock",
      side: "buy",
      quantity: 1,
      limitPrice: 100,
      submittedAt: nowIso()
    });

    repo.markSubmitUnconfirmed("ticket_prop_2", ["CLI timed out after 45000ms"], nowIso());

    const row = repo.getByTicketId("ticket_prop_2");
    expect(row?.lifecycleStage).toBe("submit_unconfirmed");
    expect(row?.externalOrderId).toBeUndefined();
    expect(row?.notes).toEqual(["CLI timed out after 45000ms"]);
  });

  it("markSubmitUnconfirmed throws when no matching row exists (never silently no-ops on a bad ticket id)", () => {
    const { repo } = setup();
    expect(() => repo.markSubmitUnconfirmed("ticket_prop_missing", [], nowIso())).toThrow(/No lifecycle row/);
  });

  it("finalizeExecution fills in external_order_id/broker fields on the SAME row insertSubmitting created", () => {
    const { repo } = setup();
    repo.insertSubmitting({
      ticketId: "ticket_prop_3",
      ownerId: "mem_owner",
      symbol: "AAPL.US",
      assetClass: "stock",
      side: "buy",
      quantity: 1,
      limitPrice: 100,
      submittedAt: nowIso()
    });

    repo.finalizeExecution("ticket_prop_3", {
      externalOrderId: "ext_123",
      brokerStatus: "Filled",
      localStatus: "accepted",
      lifecycleStage: "filled",
      notes: ["order filled"],
      observedAt: nowIso()
    });

    const row = repo.getByTicketId("ticket_prop_3");
    expect(row?.externalOrderId).toBe("ext_123");
    expect(row?.lifecycleStage).toBe("filled");
    expect(row?.localStatus).toBe("accepted");
    expect(row?.notes).toEqual(["order filled"]);
  });

  it("finalizeExecution throws when no matching row exists", () => {
    const { repo } = setup();
    expect(() =>
      repo.finalizeExecution("ticket_prop_missing", {
        externalOrderId: "ext_x",
        brokerStatus: "Filled",
        localStatus: "accepted",
        lifecycleStage: "filled",
        notes: [],
        observedAt: nowIso()
      })
    ).toThrow(/No lifecycle row/);
  });

  it("sumOpenNotionalForOwner counts every non-terminal broker stage (submitting/submitted/accepted/pending/submit_unconfirmed) for that owner, ignoring other owners and terminal stages", () => {
    const { db, repo } = setup();
    seedMember(db, "mem_other");

    repo.insertSubmitting({
      ticketId: "t_open_1", ownerId: "mem_owner", symbol: "AAPL.US", assetClass: "stock",
      side: "buy", quantity: 10, limitPrice: 100, submittedAt: nowIso()
    }); // 1000, stage 'submitting'
    repo.insertSubmitting({
      ticketId: "t_open_2", ownerId: "mem_owner", symbol: "MSFT.US", assetClass: "stock",
      side: "buy", quantity: 5, limitPrice: 200, submittedAt: nowIso()
    }); // 1000
    repo.insertSubmitting({
      ticketId: "t_other_owner", ownerId: "mem_other", symbol: "AAPL.US", assetClass: "stock",
      side: "buy", quantity: 100, limitPrice: 100, submittedAt: nowIso()
    });

    // Regression (controller live-check finding): a broker-acknowledged
    // resting order lands in stage 'submitted' (New/WaitToNew map to it) - it
    // is NOT yet in the account snapshot's market_value, so if the budget gate
    // fails to count it, two sequential 9.5% orders both read "under budget"
    // (audit finding #3). A 'submit_unconfirmed' order MAY exist at the broker
    // and must be counted conservatively too. Both MUST contribute here.
    repo.insertSubmitting({
      ticketId: "t_submitted", ownerId: "mem_owner", symbol: "TSLA.US", assetClass: "stock",
      side: "buy", quantity: 4, limitPrice: 250, submittedAt: nowIso()
    }); // 1000
    repo.finalizeExecution("t_submitted", {
      externalOrderId: "ext_submitted", brokerStatus: "New", localStatus: "accepted",
      lifecycleStage: "submitted", notes: [], observedAt: nowIso()
    });
    repo.insertSubmitting({
      ticketId: "t_unconfirmed", ownerId: "mem_owner", symbol: "AMD.US", assetClass: "stock",
      side: "buy", quantity: 2, limitPrice: 100, submittedAt: nowIso()
    }); // 200
    repo.markSubmitUnconfirmed("t_unconfirmed", ["timeout"], nowIso());

    // A terminal-stage (filled) row for mem_owner must NOT count against budget.
    repo.insertSubmitting({
      ticketId: "t_terminal", ownerId: "mem_owner", symbol: "NVDA.US", assetClass: "stock",
      side: "buy", quantity: 1, limitPrice: 900, submittedAt: nowIso()
    });
    repo.finalizeExecution("t_terminal", {
      externalOrderId: "ext_terminal", brokerStatus: "Filled", localStatus: "accepted",
      lifecycleStage: "filled", notes: [], observedAt: nowIso()
    });

    // 1000 + 1000 + 1000 (submitted) + 200 (submit_unconfirmed) = 3200
    expect(repo.sumOpenNotionalForOwner("mem_owner")).toBe(3200);
    expect(repo.sumOpenNotionalForOwner("mem_other")).toBe(10_000);
  });

  // FIX 3 (audit #3 class): the broker-status mapper emits
  // 'unknown_broker_status' for an unrecognized live status - a resting order
  // parked in that stage MUST still count against the budget (conservative:
  // an unknown status might be a live resting order), otherwise it is
  // invisible to the 10% budget gate exactly like the pre-fix 'submitted' gap
  // was.
  it("sumOpenNotionalForOwner counts a lifecycle row in stage 'unknown_broker_status' (conservative: unknown status might be a live resting order)", () => {
    const { db, repo } = setup();

    repo.insertSubmitting({
      ticketId: "t_unknown_status", ownerId: "mem_owner", symbol: "IBM.US", assetClass: "stock",
      side: "buy", quantity: 3, limitPrice: 150, submittedAt: nowIso()
    }); // 450
    repo.finalizeExecution("t_unknown_status", {
      externalOrderId: "ext_unknown_status", brokerStatus: "SomeNewLongbridgeStatus", localStatus: "accepted",
      lifecycleStage: "unknown_broker_status", notes: [], observedAt: nowIso()
    });

    expect(repo.sumOpenNotionalForOwner("mem_owner")).toBe(450);
  });

  it("save() upsert protects an already-assigned ticket_id (audit #2 direction): a later same-order write cannot overwrite it, only fill a null one", () => {
    const { db, repo } = setup();
    const base = {
      id: "life_1", externalOrderId: "EXT-1", provider: "longbridge-paper", environment: "paper",
      accountMode: "paper", symbol: "AAPL.US", assetClass: "stock" as const, side: "buy" as const,
      quantity: 1, limitPrice: 100, brokerStatus: "New", localStatus: "accepted",
      lifecycleStage: "submitted" as const, submittedAt: nowIso(), lastObservedAt: nowIso(),
      raw: null, notes: []
    };
    // First write carries the authoritative ticket id.
    repo.save({ ...base, ticketId: "ticket_correct" });
    // A later reconcile-style write of the SAME external order guesses a wrong
    // ticket id - it must NOT overwrite the authoritative one.
    repo.save({ ...base, ticketId: "ticket_WRONG", brokerStatus: "Filled", lifecycleStage: "filled" });
    const row = db.prepare("SELECT ticket_id, broker_status FROM official_paper_order_lifecycle WHERE external_order_id = 'EXT-1'").get() as { ticket_id: string; broker_status: string };
    expect(row.ticket_id).toBe("ticket_correct");
    expect(row.broker_status).toBe("Filled"); // other fields still update

    // But a currently-null ticket_id IS fillable by a later write.
    repo.save({ ...base, id: "life_2", externalOrderId: "EXT-2", ticketId: null });
    repo.save({ ...base, id: "life_2", externalOrderId: "EXT-2", ticketId: "ticket_filled_in" });
    const row2 = db.prepare("SELECT ticket_id FROM official_paper_order_lifecycle WHERE external_order_id = 'EXT-2'").get() as { ticket_id: string };
    expect(row2.ticket_id).toBe("ticket_filled_in");
  });

  it("countSubmittedTodayForOwner counts only rows at/after the given day-start for that owner", () => {
    const { repo } = setup();
    repo.insertSubmitting({
      ticketId: "t_today_1", ownerId: "mem_owner", symbol: "AAPL.US", assetClass: "stock",
      side: "buy", quantity: 1, limitPrice: 100, submittedAt: "2026-07-15T10:00:00.000Z"
    });
    repo.insertSubmitting({
      ticketId: "t_today_2", ownerId: "mem_owner", symbol: "AAPL.US", assetClass: "stock",
      side: "buy", quantity: 1, limitPrice: 100, submittedAt: "2026-07-15T11:00:00.000Z"
    });
    repo.insertSubmitting({
      ticketId: "t_yesterday", ownerId: "mem_owner", symbol: "AAPL.US", assetClass: "stock",
      side: "buy", quantity: 1, limitPrice: 100, submittedAt: "2026-07-14T23:00:00.000Z"
    });

    expect(repo.countSubmittedTodayForOwner("mem_owner", "2026-07-15T00:00:00.000Z")).toBe(2);
  });
});

describe("v14 monthly_reviews migration (Phase 9 Task 1, 2026-07-16 plan)", () => {
  it("SCHEMA_VERSION is 14", () => {
    expect(SCHEMA_VERSION).toBe(14);
  });

  it("a fresh db lands at v14 with monthly_reviews present (columns/CHECK/UNIQUE/index per the plan's frozen DDL)", () => {
    const db = memoryDb();
    migrate(db);

    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("monthly_reviews");

    const columns = db.prepare("PRAGMA table_info(monthly_reviews)").all() as Array<
      { name: string; notnull: number }
    >;
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]));
    expect(byName.id).toBeDefined();
    expect(byName.owner_id).toBeDefined();
    expect(byName.owner_id.notnull).toBe(1);
    expect(byName.period).toBeDefined();
    expect(byName.period.notnull).toBe(1);
    expect(byName.result_json).toBeDefined();
    expect(byName.result_json.notnull).toBe(0);
    expect(byName.status).toBeDefined();
    expect(byName.status.notnull).toBe(1);
    expect(byName.confirmed_at).toBeDefined();
    expect(byName.confirmed_at.notnull).toBe(0);
    expect(byName.created_at).toBeDefined();
    expect(byName.created_at.notnull).toBe(1);
    expect(byName.updated_at).toBeDefined();
    expect(byName.updated_at.notnull).toBe(1);

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("monthly_reviews_owner_period_idx");
  });

  it("is idempotent", () => {
    const db = memoryDb();
    migrate(db);
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
  });

  it("status CHECK rejects any value outside ('draft','confirmed')", () => {
    const db = memoryDb();
    migrate(db);
    seedMember(db, "mem_v14_check");
    const now = nowIso();

    expect(() =>
      db.prepare(`
        INSERT INTO monthly_reviews (id, owner_id, period, status, created_at, updated_at)
        VALUES ('mr_bad_status', 'mem_v14_check', '2026-07', 'bogus', ?, ?)
      `).run(now, now)
    ).toThrow(/CHECK constraint failed/);

    expect(() =>
      db.prepare(`
        INSERT INTO monthly_reviews (id, owner_id, period, status, created_at, updated_at)
        VALUES ('mr_ok_draft', 'mem_v14_check', '2026-01', 'draft', ?, ?)
      `).run(now, now)
    ).not.toThrow();
    expect(() =>
      db.prepare(`
        INSERT INTO monthly_reviews (id, owner_id, period, status, created_at, updated_at)
        VALUES ('mr_ok_confirmed', 'mem_v14_check', '2026-02', 'confirmed', ?, ?)
      `).run(now, now)
    ).not.toThrow();
  });

  it("enforces UNIQUE(owner_id, period)", () => {
    const db = memoryDb();
    migrate(db);
    seedMember(db, "mem_v14_unique");
    seedMember(db, "mem_v14_unique_2");
    const now = nowIso();

    db.prepare(`
      INSERT INTO monthly_reviews (id, owner_id, period, status, created_at, updated_at)
      VALUES ('mr_1', 'mem_v14_unique', '2026-07', 'draft', ?, ?)
    `).run(now, now);

    expect(() =>
      db.prepare(`
        INSERT INTO monthly_reviews (id, owner_id, period, status, created_at, updated_at)
        VALUES ('mr_2', 'mem_v14_unique', '2026-07', 'draft', ?, ?)
      `).run(now, now)
    ).toThrow(/UNIQUE constraint failed/);

    // A DIFFERENT period for the same owner, or the same period for a
    // DIFFERENT owner, is fine - the constraint is on the (owner_id, period)
    // PAIR, not either column alone.
    expect(() =>
      db.prepare(`
        INSERT INTO monthly_reviews (id, owner_id, period, status, created_at, updated_at)
        VALUES ('mr_3', 'mem_v14_unique', '2026-08', 'draft', ?, ?)
      `).run(now, now)
    ).not.toThrow();
    expect(() =>
      db.prepare(`
        INSERT INTO monthly_reviews (id, owner_id, period, status, created_at, updated_at)
        VALUES ('mr_4', 'mem_v14_unique_2', '2026-07', 'draft', ?, ?)
      `).run(now, now)
    ).not.toThrow();
  });

  it("upgrades a genuine pre-v14 (v13-shaped, monthly_reviews absent) database to v14 with zero row loss across every pre-existing table, and the pre-existing member row (the FK target monthly_reviews will reference) is preserved verbatim", () => {
    const db = buildSeededV13Database();
    expect(getSchemaVersion(db)).toBe(13);

    const tablesBefore = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tablesBefore.map((t) => t.name)).not.toContain("monthly_reviews");

    const countsBefore: Record<string, number> = {};
    for (const table of V10_TABLE_NAMES) {
      countsBefore[table] = countRows(db, table);
      if (table !== "strategy_cards") {
        expect(countsBefore[table]).toBeGreaterThan(0);
      }
    }
    const memberBefore = db.prepare("SELECT * FROM members WHERE id = 'mem_v13'").get() as Record<string, unknown>;
    expect(memberBefore).toBeDefined();

    migrate(db);

    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    for (const table of V10_TABLE_NAMES) {
      expect(countRows(db, table)).toBe(countsBefore[table]);
    }
    const memberAfter = db.prepare("SELECT * FROM members WHERE id = 'mem_v13'").get() as Record<string, unknown>;
    expect(memberAfter).toEqual(memberBefore);

    const tablesAfter = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tablesAfter.map((t) => t.name)).toContain("monthly_reviews");
    expect(countRows(db, "monthly_reviews")).toBe(0);

    // Idempotent: calling migrate() again on an already-latest db changes nothing.
    migrate(db);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    for (const table of V10_TABLE_NAMES) {
      expect(countRows(db, table)).toBe(countsBefore[table]);
    }
  });
});

describe("MonthlyReviewRepository (Phase 9 Task 1, 2026-07-16 plan)", () => {
  function setup() {
    const db = memoryDb();
    migrate(db);
    seedMember(db, "mem_owner");
    seedMember(db, "mem_other");
    return { db, repo: new MonthlyReviewRepository(db) };
  }

  describe("upsertDraft", () => {
    it("creates a new draft row and round-trips via getById/getByOwnerPeriod", () => {
      const { repo } = setup();
      const review = repo.upsertDraft({ ownerId: "mem_owner", period: "2026-07", resultJson: { headline: "test" } });

      expect(review.status).toBe("draft");
      expect(review.ownerId).toBe("mem_owner");
      expect(review.period).toBe("2026-07");
      expect(review.resultJson).toEqual({ headline: "test" });
      expect(review.confirmedAt).toBeUndefined();
      expect(review.id).toMatch(/^monthly_review_/);

      expect(repo.getById(review.id)).toEqual(review);
      expect(repo.getByOwnerPeriod("mem_owner", "2026-07")).toEqual(review);
    });

    it("re-calling for the SAME (ownerId, period) overwrites result_json/updated_at in place, keeping the same id/created_at", () => {
      const { repo } = setup();
      const first = repo.upsertDraft({ ownerId: "mem_owner", period: "2026-07", resultJson: { headline: "v1" } });
      const second = repo.upsertDraft({ ownerId: "mem_owner", period: "2026-07", resultJson: { headline: "v2" } });

      expect(second.id).toBe(first.id);
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.resultJson).toEqual({ headline: "v2" });
      expect(repo.listForOwner("mem_owner")).toHaveLength(1);
    });

    it("throws when the existing row for (ownerId, period) is already confirmed, and does not overwrite it", () => {
      const { repo } = setup();
      const review = repo.upsertDraft({ ownerId: "mem_owner", period: "2026-07", resultJson: { headline: "v1" } });
      repo.confirm(review.id, "mem_owner");

      expect(() =>
        repo.upsertDraft({ ownerId: "mem_owner", period: "2026-07", resultJson: { headline: "v2 - should be refused" } })
      ).toThrow(/already confirmed/);

      const reloaded = repo.getById(review.id);
      expect(reloaded?.status).toBe("confirmed");
      expect(reloaded?.resultJson).toEqual({ headline: "v1" });
    });

    it("allows omitting resultJson (writes a real SQL NULL, not the JSON string 'null')", () => {
      const { db, repo } = setup();
      const review = repo.upsertDraft({ ownerId: "mem_owner", period: "2026-07" });
      expect(review.resultJson).toBeUndefined();

      const row = db.prepare("SELECT result_json FROM monthly_reviews WHERE id = ?").get(review.id) as { result_json: unknown };
      expect(row.result_json).toBeNull();
    });

    it("rejects an owner_id that does not reference an existing member (FK)", () => {
      const { repo } = setup();
      expect(() => repo.upsertDraft({ ownerId: "ghost_member", period: "2026-07" })).toThrow(
        /FOREIGN KEY constraint failed/
      );
    });
  });

  describe("confirm", () => {
    it("transitions draft -> confirmed, setting confirmed_at/updated_at", () => {
      const { repo } = setup();
      const review = repo.upsertDraft({ ownerId: "mem_owner", period: "2026-07" });

      const confirmed = repo.confirm(review.id, "mem_owner");

      expect(confirmed.status).toBe("confirmed");
      expect(confirmed.confirmedAt).toBeDefined();
      expect(repo.getById(review.id)?.status).toBe("confirmed");
    });

    it("throws for a non-owner caller, and does not confirm the review", () => {
      const { repo } = setup();
      const review = repo.upsertDraft({ ownerId: "mem_owner", period: "2026-07" });

      expect(() => repo.confirm(review.id, "mem_other")).toThrow(/not owned by mem_other/);
      expect(repo.getById(review.id)?.status).toBe("draft");
    });

    it("throws for an unknown review id", () => {
      const { repo } = setup();
      expect(() => repo.confirm("monthly_review_nope", "mem_owner")).toThrow(/not found/);
    });

    it("is idempotent: re-confirming an already-confirmed review is a no-op, not an error, and confirmed_at does not change", () => {
      const { repo } = setup();
      const review = repo.upsertDraft({ ownerId: "mem_owner", period: "2026-07" });
      const firstConfirm = repo.confirm(review.id, "mem_owner");

      const secondConfirm = repo.confirm(review.id, "mem_owner");

      expect(secondConfirm).toEqual(firstConfirm);
    });
  });

  describe("listForOwner", () => {
    it("returns only this owner's reviews, ordered by period descending", () => {
      const { repo } = setup();
      repo.upsertDraft({ ownerId: "mem_owner", period: "2026-05" });
      repo.upsertDraft({ ownerId: "mem_owner", period: "2026-07" });
      repo.upsertDraft({ ownerId: "mem_owner", period: "2026-06" });
      repo.upsertDraft({ ownerId: "mem_other", period: "2026-07" });

      const reviews = repo.listForOwner("mem_owner");
      expect(reviews.map((r) => r.period)).toEqual(["2026-07", "2026-06", "2026-05"]);
    });

    it("returns an empty array for an owner with no reviews", () => {
      const { repo } = setup();
      expect(repo.listForOwner("mem_owner")).toEqual([]);
    });
  });

  describe("getById / getByOwnerPeriod", () => {
    it("return null for unknown lookups", () => {
      const { repo } = setup();
      expect(repo.getById("monthly_review_nope")).toBeNull();
      expect(repo.getByOwnerPeriod("mem_owner", "2026-07")).toBeNull();
    });
  });
});
