import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ExecutionReport,
  Member,
  OfficialPaperOrderLifecycle
} from "./domain.js";
import { createId, nowIso } from "./domain.js";

function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function fromJson<T>(value: string | null): T {
  return value ? (JSON.parse(value) as T) : (null as T);
}

export function openTradingDatabase(filePath: string): DatabaseSync {
  mkdirSync(dirname(filePath), { recursive: true });

  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA busy_timeout = 5000;");
  try {
    db.exec("PRAGMA journal_mode = WAL;");
  } catch (error) {
    const message = (error as Error).message.toLowerCase();
    if (!message.includes("database is locked")) {
      throw error;
    }
  }
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

export const SCHEMA_VERSION = 7;

export function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return Number(row.user_version);
}

// A migration step is normally just a function. Steps that rebuild a table
// (DROP + CREATE + RENAME, needed to add/change a CHECK or FK - SQLite has no
// ALTER TABLE for that) must run with `PRAGMA foreign_keys = OFF` for the
// duration of the rebuild, because SQLite's rebuild-a-table procedure can
// otherwise choke on other tables' now-momentarily-satisfied-differently FK
// references to the table being dropped and recreated (see
// https://www.sqlite.org/lang_altertable.html#otherkindsoftablesc, step 1).
// `needsForeignKeysOff: true` opts a step into that handling; see migrate().
type MigrationStep =
  | ((db: DatabaseSync) => void)
  | { run: (db: DatabaseSync) => void; needsForeignKeysOff: true };

const MIGRATIONS: MigrationStep[] = [
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS execution_reports (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notification_targets (
        channel TEXT PRIMARY KEY,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        source TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS official_paper_order_lifecycle (
        id TEXT PRIMARY KEY,
        ticket_id TEXT,
        external_order_id TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        environment TEXT NOT NULL,
        account_mode TEXT NOT NULL,
        symbol TEXT NOT NULL,
        asset_class TEXT NOT NULL,
        side TEXT NOT NULL,
        quantity REAL NOT NULL,
        limit_price REAL,
        broker_status TEXT NOT NULL,
        local_status TEXT NOT NULL,
        lifecycle_stage TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        raw TEXT NOT NULL,
        notes TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS official_paper_order_lifecycle_status_idx
        ON official_paper_order_lifecycle(symbol, lifecycle_stage, last_observed_at);

      CREATE TABLE IF NOT EXISTS official_paper_snapshots (
        id TEXT PRIMARY KEY,
        fetched_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        net_assets REAL,
        total_cash REAL,
        market_value REAL NOT NULL,
        positions TEXT NOT NULL,
        raw TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS official_paper_snapshots_time_idx
        ON official_paper_snapshots(fetched_at);

      CREATE TABLE IF NOT EXISTS paper_strategy_reflections (
        id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS stock_analysis_targets (
        symbol TEXT PRIMARY KEY,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS stock_analysis_runs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        symbols TEXT NOT NULL,
        markdown_path TEXT NOT NULL,
        pdf_path TEXT NOT NULL,
        delivery TEXT NOT NULL
      );
    `);
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS members (
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

      CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL REFERENCES members(id),
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS discipline_rules (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id),
        rule_text TEXT NOT NULL, enforcement TEXT NOT NULL CHECK(enforcement IN ('hard','proposal_check','self')),
        linked_strategy TEXT, enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, disabled_at TEXT);
      CREATE TABLE IF NOT EXISTS theses (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id),
        symbol TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('bull','bear','neutral')),
        target_low REAL, target_high REAL, invalidation_price REAL,
        visibility TEXT NOT NULL DEFAULT 'system' CHECK(visibility IN ('system','public')),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','withdrawn','superseded')),
        memory_slug TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS theses_owner_symbol_idx ON theses(owner_id, symbol, status);
      CREATE TABLE IF NOT EXISTS thesis_history (
        id TEXT PRIMARY KEY, thesis_id TEXT NOT NULL REFERENCES theses(id),
        note TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id),
        symbol TEXT NOT NULL, side TEXT NOT NULL, quantity REAL NOT NULL, order_type TEXT NOT NULL,
        limit_price REAL, reason TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '[]',
        strategy_ref TEXT, discipline_report TEXT NOT NULL DEFAULT '[]',
        invalidation TEXT, stop_loss REAL, budget_impact REAL, confidence TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','approved_half','rejected','expired','executed','failed')),
        approval_token TEXT UNIQUE, consumed_at TEXT, decided_at TEXT, decided_by TEXT,
        ticket_id TEXT, outcome TEXT, card_message_id TEXT,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS proposals_owner_status_idx ON proposals(owner_id, status, created_at);
      CREATE TABLE IF NOT EXISTS alert_rules (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id),
        symbol TEXT NOT NULL, rule_type TEXT NOT NULL CHECK(rule_type IN ('daily_move','unrealized_pnl','spike_5m','exposure')),
        threshold REAL NOT NULL, direction TEXT NOT NULL DEFAULT 'both',
        frequency TEXT NOT NULL CHECK(frequency IN ('once_daily','continuous')),
        hysteresis REAL NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS alert_events (
        id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES alert_rules(id), owner_id TEXT NOT NULL,
        triggered_at TEXT NOT NULL, value REAL NOT NULL, message_id TEXT, feedback TEXT);
      CREATE TABLE IF NOT EXISTS alert_runtime_state (
        rule_id TEXT PRIMARY KEY REFERENCES alert_rules(id),
        armed INTEGER NOT NULL DEFAULT 1, last_value REAL, cooldown_until TEXT,
        last_fired_trading_day TEXT);
      CREATE TABLE IF NOT EXISTS alert_daily_quota (
        owner_id TEXT NOT NULL, trading_day TEXT NOT NULL, fired_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (owner_id, trading_day));
      CREATE TABLE IF NOT EXISTS analysis_predictions (
        id TEXT PRIMARY KEY, symbol TEXT NOT NULL, report_path TEXT NOT NULL,
        conclusion TEXT NOT NULL, confidence TEXT NOT NULL CHECK(confidence IN ('low','medium','high')),
        review_trigger TEXT, review_date TEXT, outcome TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS research_tasks (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id),
        question TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','degraded','failed')),
        steps TEXT NOT NULL DEFAULT '[]', budget_spent INTEGER NOT NULL DEFAULT 0,
        result_path TEXT, visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','public')),
        created_at TEXT NOT NULL, finished_at TEXT);
      CREATE INDEX IF NOT EXISTS research_tasks_owner_day_idx ON research_tasks(owner_id, created_at);
      CREATE TABLE IF NOT EXISTS run_log (
        id TEXT PRIMARY KEY, job TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
        ok INTEGER, inputs TEXT NOT NULL DEFAULT '[]', actions TEXT NOT NULL DEFAULT '[]',
        failed_step TEXT, retries INTEGER NOT NULL DEFAULT 0, call_count INTEGER NOT NULL DEFAULT 0,
        evidence TEXT NOT NULL DEFAULT '[]');
    `);
  },
  (db) => {
    db.exec(`
      ALTER TABLE official_paper_snapshots ADD COLUMN owner_id TEXT;
      ALTER TABLE official_paper_order_lifecycle ADD COLUMN owner_id TEXT;
      ALTER TABLE stock_analysis_targets ADD COLUMN owner_id TEXT;
      ALTER TABLE paper_strategy_reflections ADD COLUMN owner_id TEXT;
      CREATE INDEX IF NOT EXISTS official_paper_snapshots_owner_idx ON official_paper_snapshots(owner_id, fetched_at);
    `);
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS feishu_context_messages (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS feishu_context_messages_time_idx
        ON feishu_context_messages(created_at);
    `);
  },
  (db) => {
    // Closes the gap documented in task P2-4: alert_rules had no column to
    // distinguish a soft-removed rule from a merely-paused one, so `resume`
    // could revive a removed rule. `removed_at` (nullable) is that marker:
    // NULL means "never removed" (active or paused via `enabled`); a
    // timestamp means soft-removed. `enabled` keeps its existing meaning
    // (pause/resume flip it) independent of this column.
    db.exec("ALTER TABLE alert_rules ADD COLUMN removed_at TEXT;");
  },
  {
    needsForeignKeysOff: true,
    // Task H3 (phase2.5 hardening): closes three structural gaps that would
    // silently corrupt data the moment P6 brings a second member online.
    // All four rebuilds below run inside ONE transaction (migrate()'s normal
    // per-step transaction), following SQLite's documented table-rebuild
    // recipe: CREATE new -> INSERT ... SELECT -> DROP old -> RENAME. No
    // secondary indexes existed on any of these four tables pre-v7, so there
    // is nothing to recreate on that front.
    run: (db) => {
      // ----------------------------------------------------------------
      // 1) members: add CHECK(status IN ('active','revoked')). Column set
      //    and UNIQUE constraints (email, feishu_open_id) are unchanged.
      // ----------------------------------------------------------------
      db.exec(`
        CREATE TABLE members_new (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          feishu_open_id TEXT UNIQUE,
          display_name TEXT NOT NULL,
          risk_tags TEXT NOT NULL DEFAULT '[]',
          stock_tags TEXT NOT NULL DEFAULT '[]',
          show_performance INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
          created_at TEXT NOT NULL
        );
      `);
      db.exec(`
        INSERT INTO members_new
          (id, email, feishu_open_id, display_name, risk_tags, stock_tags, show_performance, status, created_at)
        SELECT id, email, feishu_open_id, display_name, risk_tags, stock_tags, show_performance, status, created_at
        FROM members;
      `);
      db.exec("DROP TABLE members;");
      db.exec("ALTER TABLE members_new RENAME TO members;");

      // ----------------------------------------------------------------
      // 2) alert_rules: add CHECK(direction IN ('both','up','down')) so a
      //    typo'd direction can never again be silently treated as 'both'
      //    by the engine. Every other column/constraint (including v6's
      //    removed_at) is preserved verbatim.
      // ----------------------------------------------------------------
      db.exec(`
        CREATE TABLE alert_rules_new (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id),
          symbol TEXT NOT NULL, rule_type TEXT NOT NULL CHECK(rule_type IN ('daily_move','unrealized_pnl','spike_5m','exposure')),
          threshold REAL NOT NULL, direction TEXT NOT NULL DEFAULT 'both' CHECK(direction IN ('both','up','down')),
          frequency TEXT NOT NULL CHECK(frequency IN ('once_daily','continuous')),
          hysteresis REAL NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL, removed_at TEXT
        );
      `);
      db.exec(`
        INSERT INTO alert_rules_new
          (id, owner_id, symbol, rule_type, threshold, direction, frequency, hysteresis, enabled, created_at, removed_at)
        SELECT id, owner_id, symbol, rule_type, threshold, direction, frequency, hysteresis, enabled, created_at, removed_at
        FROM alert_rules;
      `);
      db.exec("DROP TABLE alert_rules;");
      db.exec("ALTER TABLE alert_rules_new RENAME TO alert_rules;");

      // ----------------------------------------------------------------
      // 3) alert_events: owner_id becomes a real FK to members(id) (it was
      //    already NOT NULL, but had no FK). A handful of hardening
      //    scenarios are guarded against zero data loss:
      //    - a row whose owner_id is NULL/empty (never possible through
      //      this app's own write path today, but tolerated defensively -
      //      see task brief) is backfilled from its OWNING RULE's owner_id
      //      via a JOIN.
      //    - if the owning rule is ALSO gone (dangling rule_id, e.g. from
      //      manual DB surgery predating deleteRule's cascade), there is no
      //      rule to join against. Silently dropping the event is not
      //      acceptable, so it is attributed to a dedicated placeholder
      //      member ('__legacy_system__', status 'revoked' so it never
      //      shows up as a real/active member) created on demand, only if
      //      such a row actually exists.
      // ----------------------------------------------------------------
      const legacySystemMemberCreatedAt = nowIso();
      db.prepare(`
        INSERT OR IGNORE INTO members (id, email, display_name, status, created_at)
        SELECT '__legacy_system__', '__legacy_system__@alphaloop.invalid',
               'Legacy System (migration placeholder)', 'revoked', ?
        WHERE EXISTS (
          SELECT 1 FROM alert_events e
          LEFT JOIN alert_rules r ON r.id = e.rule_id
          WHERE COALESCE(NULLIF(e.owner_id, ''), r.owner_id) IS NULL
        );
      `).run(legacySystemMemberCreatedAt);

      db.exec(`
        CREATE TABLE alert_events_new (
          id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES alert_rules(id),
          owner_id TEXT NOT NULL REFERENCES members(id),
          triggered_at TEXT NOT NULL, value REAL NOT NULL, message_id TEXT, feedback TEXT
        );
      `);
      db.exec(`
        INSERT INTO alert_events_new (id, rule_id, owner_id, triggered_at, value, message_id, feedback)
        SELECT
          e.id,
          e.rule_id,
          COALESCE(NULLIF(e.owner_id, ''), r.owner_id, '__legacy_system__'),
          e.triggered_at, e.value, e.message_id, e.feedback
        FROM alert_events e
        LEFT JOIN alert_rules r ON r.id = e.rule_id;
      `);
      db.exec("DROP TABLE alert_events;");
      db.exec("ALTER TABLE alert_events_new RENAME TO alert_events;");

      // ----------------------------------------------------------------
      // 4) stock_analysis_targets: rebuilt for a per-owner watchlist.
      //    `symbol TEXT PRIMARY KEY` structurally cannot express "each
      //    member maintains their own pool" (P6 spec) - it becomes
      //    composite PK (symbol, owner_id). SQLite composite PKs allow
      //    owner_id to be NULL and NULLs don't dedupe against each other,
      //    so owner_id MUST be NOT NULL or the uniqueness guarantee is a
      //    no-op. Existing NULL rows (the single-shared-watchlist era) are
      //    backfilled to sentinel '__legacy_shared__', interpreted at the
      //    code layer as "shared pool, visible to any member" (see
      //    isSymbolWatched in market-alerts-store.mjs). No FK to members:
      //    the sentinel is not a member. The old table's PK was `symbol`
      //    alone, so there is at most one row per symbol already - backfill
      //    can never create a (symbol, owner_id) collision.
      // ----------------------------------------------------------------
      db.exec(`
        CREATE TABLE stock_analysis_targets_new (
          symbol TEXT NOT NULL,
          owner_id TEXT NOT NULL CHECK(owner_id <> ''),
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (symbol, owner_id)
        );
      `);
      db.exec(`
        INSERT INTO stock_analysis_targets_new (symbol, owner_id, active, created_at, updated_at)
        SELECT symbol, COALESCE(NULLIF(owner_id, ''), '__legacy_shared__'), active, created_at, updated_at
        FROM stock_analysis_targets;
      `);
      db.exec("DROP TABLE stock_analysis_targets;");
      db.exec("ALTER TABLE stock_analysis_targets_new RENAME TO stock_analysis_targets;");

      // ----------------------------------------------------------------
      // Post-rebuild integrity gate for the ONE guarantee this step newly
      // declares: alert_events.owner_id -> members(id). The rebuild runs
      // with PRAGMA foreign_keys OFF, so a pre-existing "ghost" owner_id
      // (nonexistent member - unreachable through the app's own write
      // path, but so was NULL, which we defend against above) would be
      // copied straight into a table whose DDL now promises it cannot
      // exist, and SQLite never re-validates existing rows when the
      // pragma comes back on. Fail loud inside the transaction instead:
      // the migration rolls back and the operator sees exactly which
      // rows are bad. Deliberately NOT a blanket foreign_key_check -
      // dangling rule_id rows are pre-existing corruption the task brief
      // requires preserving (orphaned events must not be dropped), so
      // only the newly-declared owner_id edge is enforced here.
      // ----------------------------------------------------------------
      const ghostOwners = db.prepare(`
        SELECT e.id, e.owner_id FROM alert_events e
        LEFT JOIN members m ON m.id = e.owner_id
        WHERE m.id IS NULL
        LIMIT 5
      `).all() as Array<{ id: string; owner_id: string }>;
      if (ghostOwners.length > 0) {
        const detail = ghostOwners.map((r) => `${r.id} -> ${r.owner_id}`).join(", ");
        throw new Error(
          `v7 migration aborted: alert_events rows reference nonexistent members (${detail}); ` +
          `repair the owner_id values (or restore the missing members) and re-run.`
        );
      }
    }
  }
];

export function migrate(db: DatabaseSync): void {
  let version = getSchemaVersion(db);
  while (version < MIGRATIONS.length) {
    const entry = MIGRATIONS[version];
    if (!entry) {
      throw new Error(`Missing migration step for schema version ${version}`);
    }
    const run = typeof entry === "function" ? entry : entry.run;
    const needsForeignKeysOff = typeof entry === "function" ? false : entry.needsForeignKeysOff;

    // PRAGMA foreign_keys is documented to be a no-op once a transaction is
    // open, so a step that needs it toggled (table-rebuild steps: DROP a
    // table other tables hold FK references to) must flip it HERE, outside
    // the BEGIN/COMMIT below - and flip it back after the transaction ends,
    // on both the success and failure paths, so a later step never
    // inherits a disabled pragma.
    if (needsForeignKeysOff) {
      db.exec("PRAGMA foreign_keys = OFF;");
    }
    try {
      db.exec("BEGIN");
      try {
        run(db);
        db.exec(`PRAGMA user_version = ${version + 1}`);
        db.exec("COMMIT");
      } catch (error) {
        // The ROLLBACK itself can fail (e.g. the step already ended the transaction, or the
        // connection is in a bad state) - if it throws here, that secondary failure must never
        // replace `error` (the actual root cause an operator needs to see and act on) in what
        // propagates out of migrate().
        try {
          db.exec("ROLLBACK");
        } catch {
          // Ignore: best-effort only, `error` below is what matters.
        }
        throw error;
      }
    } finally {
      if (needsForeignKeysOff) {
        db.exec("PRAGMA foreign_keys = ON;");
      }
    }
    version += 1;
  }
}

export class AuditLogRepository {
  constructor(private readonly db: DatabaseSync) {}

  write(category: string, action: string, payload: unknown): string {
    const id = createId("audit");
    this.db
      .prepare(`
        INSERT INTO audit_log (id, category, action, payload, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(id, category, action, toJson(payload), Date.now());
    return id;
  }
}

export class ExecutionReportRepository {
  constructor(private readonly db: DatabaseSync) {}

  save(report: ExecutionReport): void {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO execution_reports
        (id, category, title, body, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(report.id, report.category, report.title, report.body, toJson(report.metadata), report.createdAt);
  }

  listRecent(limit = 50, categories?: ExecutionReport["category"][]): ExecutionReport[] {
    const rows = categories && categories.length > 0
      ? (this.db
          .prepare(`
            SELECT * FROM execution_reports
            WHERE category IN (${categories.map(() => "?").join(", ")})
            ORDER BY created_at DESC
            LIMIT ?
          `)
          .all(...categories, limit) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(`SELECT * FROM execution_reports ORDER BY created_at DESC LIMIT ?`)
          .all(limit) as Array<Record<string, unknown>>);

    return rows.map((row) => ({
      id: String(row.id),
      category: String(row.category) as ExecutionReport["category"],
      title: String(row.title),
      body: String(row.body),
      metadata: fromJson<Record<string, unknown>>(String(row.metadata)) as ExecutionReport["metadata"],
      createdAt: String(row.created_at)
    }));
  }
}

export class OfficialPaperOrderLifecycleRepository {
  constructor(private readonly db: DatabaseSync) {}

  save(record: OfficialPaperOrderLifecycle): void {
    this.db
      .prepare(`
        INSERT INTO official_paper_order_lifecycle
        (id, ticket_id, external_order_id, provider, environment, account_mode, symbol, asset_class,
         side, quantity, limit_price, broker_status, local_status, lifecycle_stage, submitted_at,
         last_observed_at, raw, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(external_order_id) DO UPDATE SET
          ticket_id = COALESCE(excluded.ticket_id, official_paper_order_lifecycle.ticket_id),
          provider = excluded.provider,
          environment = excluded.environment,
          account_mode = excluded.account_mode,
          symbol = excluded.symbol,
          asset_class = excluded.asset_class,
          side = excluded.side,
          quantity = excluded.quantity,
          limit_price = COALESCE(excluded.limit_price, official_paper_order_lifecycle.limit_price),
          broker_status = excluded.broker_status,
          local_status = excluded.local_status,
          lifecycle_stage = excluded.lifecycle_stage,
          submitted_at = official_paper_order_lifecycle.submitted_at,
          last_observed_at = excluded.last_observed_at,
          raw = excluded.raw,
          notes = excluded.notes
      `)
      .run(
        record.id,
        record.ticketId ?? null,
        record.externalOrderId,
        record.provider,
        record.environment,
        record.accountMode,
        record.symbol,
        record.assetClass,
        record.side,
        record.quantity,
        record.limitPrice ?? null,
        record.brokerStatus,
        record.localStatus,
        record.lifecycleStage,
        record.submittedAt,
        record.lastObservedAt,
        toJson(record.raw ?? null),
        toJson(record.notes)
      );
  }

  listRecent(limit = 50): OfficialPaperOrderLifecycle[] {
    const rows = this.db
      .prepare(`SELECT * FROM official_paper_order_lifecycle ORDER BY last_observed_at DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map(mapOfficialPaperOrderLifecycle);
  }
}

export interface NotificationTarget {
  channel: string;
  targetType: "open_id" | "chat_id";
  targetId: string;
  source: string;
  updatedAt: number;
}

export class NotificationTargetRepository {
  constructor(private readonly db: DatabaseSync) {}

  save(target: NotificationTarget): void {
    this.db
      .prepare(`
        INSERT INTO notification_targets (channel, target_type, target_id, source, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(channel) DO UPDATE SET
          target_type = excluded.target_type,
          target_id = excluded.target_id,
          source = excluded.source,
          updated_at = excluded.updated_at
      `)
      .run(target.channel, target.targetType, target.targetId, target.source, target.updatedAt);
  }

  get(channel: string): NotificationTarget | null {
    const row = this.db
      .prepare(`SELECT * FROM notification_targets WHERE channel = ? LIMIT 1`)
      .get(channel) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    return {
      channel: String(row.channel),
      targetType: String(row.target_type) as NotificationTarget["targetType"],
      targetId: String(row.target_id),
      source: String(row.source),
      updatedAt: Number(row.updated_at)
    };
  }
}

export class MemberRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsert(m: Member): void {
    this.db
      .prepare(`
        INSERT INTO members
        (id, email, feishu_open_id, display_name, risk_tags, stock_tags, show_performance, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          email = excluded.email,
          feishu_open_id = excluded.feishu_open_id,
          display_name = excluded.display_name,
          risk_tags = excluded.risk_tags,
          stock_tags = excluded.stock_tags,
          show_performance = excluded.show_performance,
          status = excluded.status
      `)
      .run(
        m.id,
        m.email,
        m.feishuOpenId ?? null,
        m.displayName,
        toJson(m.riskTags),
        toJson(m.stockTags),
        m.showPerformance ? 1 : 0,
        m.status,
        m.createdAt
      );
  }

  getByEmail(email: string): Member | null {
    const row = this.db
      .prepare(`SELECT * FROM members WHERE email = ? LIMIT 1`)
      .get(email) as Record<string, unknown> | undefined;

    return row ? mapMember(row) : null;
  }

  getByFeishuOpenId(openId: string): Member | null {
    const row = this.db
      .prepare(`SELECT * FROM members WHERE feishu_open_id = ? LIMIT 1`)
      .get(openId) as Record<string, unknown> | undefined;

    return row ? mapMember(row) : null;
  }

  listActive(): Member[] {
    const rows = this.db
      .prepare(`SELECT * FROM members WHERE status = 'active' ORDER BY created_at ASC`)
      .all() as Array<Record<string, unknown>>;

    return rows.map(mapMember);
  }
}

export class ApiTokenRepository {
  constructor(private readonly db: DatabaseSync) {}

  issue(memberId: string, label: string): { id: string; token: string } {
    const id = createId("token");
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);

    this.db
      .prepare(`
        INSERT INTO api_tokens (id, member_id, token_hash, label, revoked_at, created_at)
        VALUES (?, ?, ?, ?, NULL, ?)
      `)
      .run(id, memberId, tokenHash, label, nowIso());

    return { id, token };
  }

  verify(token: string): Member | null {
    const tokenHash = hashToken(token);
    const row = this.db
      .prepare(`
        SELECT members.*
        FROM api_tokens
        JOIN members ON members.id = api_tokens.member_id
        WHERE api_tokens.token_hash = ?
          AND api_tokens.revoked_at IS NULL
          AND members.status = 'active'
        LIMIT 1
      `)
      .get(tokenHash) as Record<string, unknown> | undefined;

    return row ? mapMember(row) : null;
  }

  revoke(tokenId: string): void {
    this.db
      .prepare(`UPDATE api_tokens SET revoked_at = ? WHERE id = ?`)
      .run(nowIso(), tokenId);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mapMember(row: Record<string, unknown>): Member {
  return {
    id: String(row.id),
    email: String(row.email),
    ...(row.feishu_open_id ? { feishuOpenId: String(row.feishu_open_id) } : {}),
    displayName: String(row.display_name),
    riskTags: fromJson<string[]>(String(row.risk_tags)),
    stockTags: fromJson<string[]>(String(row.stock_tags)),
    showPerformance: Number(row.show_performance) === 1,
    status: String(row.status) as Member["status"],
    createdAt: String(row.created_at)
  };
}

function mapOfficialPaperOrderLifecycle(row: Record<string, unknown>): OfficialPaperOrderLifecycle {
  const limitPrice = row.limit_price === null || row.limit_price === undefined
    ? undefined
    : Number(row.limit_price);

  const lifecycle: OfficialPaperOrderLifecycle = {
    id: String(row.id),
    ...(row.ticket_id ? { ticketId: String(row.ticket_id) } : {}),
    externalOrderId: String(row.external_order_id),
    provider: "longbridge-paper",
    environment: "paper",
    accountMode: "paper",
    symbol: String(row.symbol),
    assetClass: String(row.asset_class) as OfficialPaperOrderLifecycle["assetClass"],
    side: String(row.side) as OfficialPaperOrderLifecycle["side"],
    quantity: Number(row.quantity),
    brokerStatus: String(row.broker_status),
    localStatus: String(row.local_status) as OfficialPaperOrderLifecycle["localStatus"],
    lifecycleStage: String(row.lifecycle_stage) as OfficialPaperOrderLifecycle["lifecycleStage"],
    submittedAt: String(row.submitted_at),
    lastObservedAt: String(row.last_observed_at),
    raw: fromJson(String(row.raw)),
    notes: fromJson<string[]>(String(row.notes))
  };

  if (limitPrice !== undefined && Number.isFinite(limitPrice)) {
    lifecycle.limitPrice = limitPrice;
  }

  return lifecycle;
}
