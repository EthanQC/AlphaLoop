import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  EquityAssetClass,
  ExecutionResultStatus,
  ExecutionReport,
  JsonValue,
  Member,
  OfficialPaperOrderLifecycle,
  OfficialPaperOrderLifecycleStage,
  OrderSide,
  Proposal,
  ProposalConfidence,
  ProposalStatus
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

export const SCHEMA_VERSION = 11;

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
  },
  (db) => {
    // Phase 4 Task 2 (news engine, 2026-07-15 plan): three brand-new tables,
    // no rebuilds of anything pre-existing - a plain step suffices (no
    // needsForeignKeysOff). DDL is spec-frozen verbatim from the plan; do not
    // hand-edit without updating the plan doc first.
    //
    // news_events / news_event_sources hold the clustered, multi-source news
    // events the news engine produces (one row per event, one row per raw
    // source article feeding that event). daily_facts is the per-trading-day
    // fact table used to catch fabricated numbers in generated reports (the
    // facts.numeric_match quality gate, Task 6) - it has no FK to anything
    // and is populated independently at report-generation time.
    //
    // These tables intentionally have no owner_id column: per Global
    // Constraint in the plan, news is a public asset shared across the whole
    // stock pool, not per-member data - unlike stock_analysis_targets (v7),
    // there is no per-owner watchlist semantics to express here.
    db.exec(`
      CREATE TABLE news_events (
        id TEXT PRIMARY KEY, cluster_key TEXT NOT NULL UNIQUE,
        title_zh TEXT NOT NULL, summary_zh TEXT,
        impact_direction TEXT CHECK(impact_direction IN ('bullish','bearish','neutral','unknown')),
        impact_affected TEXT NOT NULL DEFAULT '[]', impact_reason TEXT,
        first_published_at TEXT, last_published_at TEXT,
        source_count INTEGER NOT NULL DEFAULT 0, zh_source_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX news_events_window_idx ON news_events(last_published_at);
      CREATE TABLE news_event_sources (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES news_events(id),
        origin TEXT NOT NULL, publisher TEXT NOT NULL, url TEXT, title_raw TEXT NOT NULL,
        published_at TEXT, lang TEXT NOT NULL DEFAULT 'unknown', created_at TEXT NOT NULL);
      CREATE INDEX news_event_sources_event_idx ON news_event_sources(event_id);
      CREATE TABLE daily_facts (
        id TEXT PRIMARY KEY, trading_day TEXT NOT NULL, fact_key TEXT NOT NULL,
        value_num REAL, value_text TEXT, unit TEXT, source TEXT NOT NULL,
        data_time TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(trading_day, fact_key));
    `);
  },
  (db) => {
    // Phase 5 Task 1 (2026-07-15 plan): stock_facts is the per-stock,
    // per-trading-day analogue of v8's daily_facts (news-store.mjs's
    // replaceDailyFacts/getDailyFacts) - it holds every number a per-symbol
    // stock-analysis report narrative may cite (quote/valuation/history/
    // options/news/institutional-placeholder facts), keyed by (trading_day,
    // symbol, fact_key) rather than daily_facts' (trading_day, fact_key),
    // because these facts are inherently per-symbol, not portfolio-wide. A
    // brand-new table, no rebuild of anything pre-existing - a plain step
    // suffices (no needsForeignKeysOff). DDL is spec-frozen verbatim from the
    // plan; do not hand-edit without updating the plan doc first.
    //
    // Unlike daily_facts (whose store does a full-trading-day DELETE+INSERT),
    // the store for this table (stock-facts-store.mjs's replaceStockFacts)
    // scopes its DELETE to (trading_day, symbol): a batch run analyzing many
    // symbols on the same trading_day must never let one symbol's refresh
    // wipe out its sibling symbols' rows, since they all share that same
    // trading_day.
    //
    // No owner_id: per Global Constraint, stock facts are a public asset (the
    // stock-analysis pool is shared across the whole member base), not
    // per-member data - same reasoning v8's news tables already documented.
    db.exec(`
      CREATE TABLE stock_facts (
        id TEXT PRIMARY KEY, trading_day TEXT NOT NULL, symbol TEXT NOT NULL,
        fact_key TEXT NOT NULL, value_num REAL, value_text TEXT, unit TEXT,
        source TEXT NOT NULL, data_time TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(trading_day, symbol, fact_key));
      CREATE INDEX stock_facts_symbol_day_idx ON stock_facts(symbol, trading_day);
    `);
  },
  (db) => {
    // Phase 6 Task 1 (2026-07-15 plan): circuit_breaker_state is the
    // per-owner circuit-breaker's persisted state - a row's mere EXISTENCE
    // with paused_until in the future means "new proposal generation is
    // paused for this owner" (Task 2's assertProposalAllowed/isPaused reads
    // it that way), so a trip survives process restarts. A brand-new table,
    // no rebuild of anything pre-existing - a plain step suffices (no
    // needsForeignKeysOff). DDL is spec-frozen VERBATIM from the plan's
    // Global Constraints (column list/order/types/constraints unchanged;
    // only whitespace reflowed for readability, matching how v8/v9 already
    // treat their own spec-frozen DDL) - do not hand-edit without updating
    // the plan doc first.
    //
    // owner_id is the PRIMARY KEY (one row per owner, not history) and a
    // real FK to members(id) - unlike news/stock_facts tables, this data is
    // inherently per-member, so there is no shared/sentinel-owner case to
    // consider here.
    db.exec(`
      CREATE TABLE circuit_breaker_state (
        owner_id TEXT PRIMARY KEY REFERENCES members(id),
        paused_until TEXT NOT NULL,
        reason TEXT NOT NULL,
        weekly_loss_pct REAL,
        tripped_at TEXT NOT NULL
      );
    `);
  },
  (db) => {
    // Phase 6 Task 4 (2026-07-15 plan): "先记录后执行" (record-before-execute)
    // requires broker-executor to INSERT a official_paper_order_lifecycle row
    // BEFORE calling the broker (Global Constraint ⑤) - at that moment there
    // is no external_order_id yet (the broker hasn't replied). The original
    // (pre-Phase-6) DDL declared `external_order_id TEXT NOT NULL UNIQUE`,
    // which makes that pre-broker-call row structurally impossible. This step
    // is the one DDL change this phase's "此外 DDL 冻结" constraint did not
    // anticipate when it was written (before Task 4's own record-before-
    // execute requirement was fully scoped out): without it, the money-path
    // invariant the whole task exists to harden cannot be implemented at all.
    // The fix is deliberately narrow - drop NOT NULL, keep everything else
    // (including UNIQUE - SQLite's UNIQUE already permits multiple NULLs, so
    // dropping NOT NULL alone is sufficient; a genuine collision between two
    // REAL external_order_id values is still caught). No other column, no
    // other table, changes. SQLite has no ALTER COLUMN, so this is the
    // standard table-rebuild recipe (CREATE new -> INSERT ... SELECT -> DROP
    // old -> RENAME) already used by the v7 step above. No FK references this
    // table and this table references nothing, so no needsForeignKeysOff.
    //
    // Defensive existence check: a couple of this file's OWN pre-existing
    // migration tests build deliberately partial legacy-shape fixtures (just
    // members/alert_rules/alert_events/stock_analysis_targets) that never
    // created official_paper_order_lifecycle at all, because no migration
    // step before this one ever needed to touch it. Every REAL database does
    // have it (MIGRATIONS[0] creates it), but rather than make this step
    // silently assume that, a missing table is handled by creating it
    // directly in its final (nullable-external_order_id) shape - equivalent
    // to "there is nothing to rebuild", not an error.
    const tableExists = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'official_paper_order_lifecycle'`)
      .get();

    if (!tableExists) {
      db.exec(`
        CREATE TABLE official_paper_order_lifecycle (
          id TEXT PRIMARY KEY,
          ticket_id TEXT,
          external_order_id TEXT UNIQUE,
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
          notes TEXT NOT NULL,
          owner_id TEXT
        );
        CREATE INDEX IF NOT EXISTS official_paper_order_lifecycle_status_idx
          ON official_paper_order_lifecycle(symbol, lifecycle_stage, last_observed_at);
        CREATE INDEX IF NOT EXISTS official_paper_order_lifecycle_owner_idx
          ON official_paper_order_lifecycle(owner_id, lifecycle_stage, submitted_at);
      `);
      return;
    }

    db.exec(`
      CREATE TABLE official_paper_order_lifecycle_new (
        id TEXT PRIMARY KEY,
        ticket_id TEXT,
        external_order_id TEXT UNIQUE,
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
        notes TEXT NOT NULL,
        owner_id TEXT
      );
    `);
    db.exec(`
      INSERT INTO official_paper_order_lifecycle_new
        (id, ticket_id, external_order_id, provider, environment, account_mode, symbol, asset_class,
         side, quantity, limit_price, broker_status, local_status, lifecycle_stage, submitted_at,
         last_observed_at, raw, notes, owner_id)
      SELECT
        id, ticket_id, external_order_id, provider, environment, account_mode, symbol, asset_class,
        side, quantity, limit_price, broker_status, local_status, lifecycle_stage, submitted_at,
        last_observed_at, raw, notes, owner_id
      FROM official_paper_order_lifecycle;
    `);
    db.exec("DROP TABLE official_paper_order_lifecycle;");
    db.exec("ALTER TABLE official_paper_order_lifecycle_new RENAME TO official_paper_order_lifecycle;");
    db.exec(`
      CREATE INDEX IF NOT EXISTS official_paper_order_lifecycle_status_idx
        ON official_paper_order_lifecycle(symbol, lifecycle_stage, last_observed_at);
      CREATE INDEX IF NOT EXISTS official_paper_order_lifecycle_owner_idx
        ON official_paper_order_lifecycle(owner_id, lifecycle_stage, submitted_at);
    `);
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

  // Upsert-by-external_order_id: structurally requires a REAL external order
  // id (that is the ON CONFLICT key below), so - unlike the domain type,
  // which widened externalOrderId to optional for the pre-broker-call
  // "submitting" row (see insertSubmitting below) - this method's own
  // parameter re-narrows it back to required.
  save(record: OfficialPaperOrderLifecycle & { externalOrderId: string }): void {
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

  // ---- Phase 6 Task 4 additions (2026-07-15 plan): record-before-execute ----
  // These five methods are the ENTIRE surface broker-executor's /v1/tickets
  // handler needs for its new sequence; none of them touch `.save()` above
  // (still the finalized-real-order upsert path other callers may use). All
  // are keyed by `ticket_id`, not `external_order_id` - deliberately, since
  // the whole point is that a row can exist (and be looked up) before any
  // external_order_id is known.

  // Idempotency lookup (Global Constraint ③): the executor derives
  // `ticket_prop_<proposalId>` BEFORE touching the proposals table at all, and
  // checks this first - a hit means "already recorded, do not re-execute",
  // regardless of what the proposal's own status column says.
  getByTicketId(ticketId: string): OfficialPaperOrderLifecycle | null {
    const row = this.db
      .prepare(`SELECT * FROM official_paper_order_lifecycle WHERE ticket_id = ? LIMIT 1`)
      .get(ticketId) as Record<string, unknown> | undefined;

    return row ? mapOfficialPaperOrderLifecycle(row) : null;
  }

  // Global Constraint ⑤: INSERT the 'submitting' row BEFORE the broker call.
  // `id` is the ticket id itself (not `lb_order_<externalOrderId>` - that
  // scheme, still used by `.save()`, is unavailable here precisely because no
  // external_order_id exists yet), so it is also naturally the row this
  // method's siblings below re-fetch/update by ticket id.
  insertSubmitting(input: {
    ticketId: string;
    ownerId: string;
    symbol: string;
    assetClass: EquityAssetClass;
    side: OrderSide;
    quantity: number;
    limitPrice?: number;
    submittedAt: string;
  }): void {
    this.db
      .prepare(`
        INSERT INTO official_paper_order_lifecycle
        (id, ticket_id, external_order_id, provider, environment, account_mode, symbol, asset_class,
         side, quantity, limit_price, broker_status, local_status, lifecycle_stage, submitted_at,
         last_observed_at, raw, notes, owner_id)
        VALUES (?, ?, NULL, 'longbridge-paper', 'paper', 'paper', ?, ?, ?, ?, ?, 'pending_submission', 'pending', 'submitting', ?, ?, 'null', '[]', ?)
      `)
      .run(
        input.ticketId,
        input.ticketId,
        input.symbol,
        input.assetClass,
        input.side,
        input.quantity,
        input.limitPrice ?? null,
        input.submittedAt,
        input.submittedAt,
        input.ownerId
      );
  }

  // Global Constraint ⑥ (throw/timeout branch): the CLI call failed but the
  // order MAY have reached the broker - stage becomes 'submit_unconfirmed',
  // deliberately NOT 'rejected'/'failed' (Task 5's reconciliation is what
  // adjudicates it later against the broker's own order list).
  markSubmitUnconfirmed(ticketId: string, notes: string[], observedAt: string): void {
    const result = this.db
      .prepare(`
        UPDATE official_paper_order_lifecycle
        SET lifecycle_stage = 'submit_unconfirmed', local_status = 'pending',
            broker_status = 'unconfirmed', notes = ?, last_observed_at = ?
        WHERE ticket_id = ?
      `)
      .run(toJson(notes), observedAt, ticketId);

    if (Number(result.changes) === 0) {
      throw new Error(`No lifecycle row found for ticket ${ticketId} to mark submit_unconfirmed.`);
    }
  }

  // Global Constraint ⑦ (success branch): fills in what the broker call
  // revealed. Still matched by ticket_id (not external_order_id - that column
  // is exactly what this call is populating for the first time on this row).
  finalizeExecution(ticketId: string, input: {
    externalOrderId: string;
    brokerStatus: string;
    localStatus: ExecutionResultStatus;
    lifecycleStage: OfficialPaperOrderLifecycleStage;
    limitPrice?: number;
    raw?: JsonValue;
    notes: string[];
    observedAt: string;
  }): void {
    const result = this.db
      .prepare(`
        UPDATE official_paper_order_lifecycle
        SET external_order_id = ?, broker_status = ?, local_status = ?, lifecycle_stage = ?,
            limit_price = COALESCE(?, limit_price), raw = ?, notes = ?, last_observed_at = ?
        WHERE ticket_id = ?
      `)
      .run(
        input.externalOrderId,
        input.brokerStatus,
        input.localStatus,
        input.lifecycleStage,
        input.limitPrice ?? null,
        toJson(input.raw ?? null),
        toJson(input.notes),
        input.observedAt,
        ticketId
      );

    if (Number(result.changes) === 0) {
      throw new Error(`No lifecycle row found for ticket ${ticketId} to finalize.`);
    }
  }

  // Global Constraint ④ (budget gate, open-orders extension): the notional of
  // this owner's OWN still-open orders (stage IN submitting/accepted/pending -
  // i.e. not yet filled/cancelled/rejected/unconfirmed-resolved) - added to
  // the owner's current account exposure before the 10% budget check, so two
  // sequential 9.5% orders correctly trip the SECOND one instead of both
  // independently reading "under budget" against a stale account snapshot.
  // COALESCE(limit_price, 0): an order missing a limit price contributes zero
  // (there is no price to size notional from) rather than throwing - the
  // caller-side gate that requires a limit price before recording happens
  // upstream of this being called at all.
  sumOpenNotionalForOwner(ownerId: string): number {
    // "Open" = every non-terminal stage an order can occupy after it has been
    // sent but before it settles. This list MUST cover every stage
    // longbridge-paper.ts's mapBrokerStatusToStage / the reconcile mapper can
    // emit for a live order, or an order sitting in an uncovered stage becomes
    // invisible to the budget gate - which is exactly the double-commit window
    // audit finding #3 flags (a broker-side 'submitted'/'New' resting order is
    // neither in the account snapshot's market_value yet nor counted here).
    //   - submitting        : this executor's own record-before-execute insert
    //   - submitted          : broker acknowledged (New/WaitToNew/NotReported/...)
    //   - pending / accepted : partially filled / reconcile-observed working order
    //   - submit_unconfirmed : broker call errored/timed out - the order MAY
    //                          exist at the broker, so it is counted
    //                          conservatively (over-block beats double-commit).
    // Terminal stages (filled/cancelled/rejected/expired/unknown) are excluded:
    // a filled order transitions into the next account snapshot's market_value,
    // so counting it here too would double-count once the hourly snapshot
    // catches up.
    const row = this.db
      .prepare(`
        SELECT COALESCE(SUM(quantity * COALESCE(limit_price, 0)), 0) AS notional
        FROM official_paper_order_lifecycle
        WHERE owner_id = ?
          AND lifecycle_stage IN ('submitting', 'submitted', 'accepted', 'pending', 'submit_unconfirmed')
      `)
      .get(ownerId) as { notional: number } | undefined;

    return Number(row?.notional ?? 0);
  }

  // Server-side dailyNewRiskPercent/openIdeas inputs (plan: "metadata 风险参数
  // 不再信 body verbatim...服务端算（当日 lifecycle 计数）") - counts today's
  // lifecycle rows for this owner (any stage: a rejected/failed attempt still
  // used up part of today's risk budget) rather than trusting anything the
  // HTTP caller claims about how many ideas are already open today.
  countSubmittedTodayForOwner(ownerId: string, dayStartIso: string): number {
    const row = this.db
      .prepare(`
        SELECT COUNT(*) AS c
        FROM official_paper_order_lifecycle
        WHERE owner_id = ? AND submitted_at >= ?
      `)
      .get(ownerId, dayStartIso) as { c: number } | undefined;

    return Number(row?.c ?? 0);
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

  // Task 3.2 (identity + member management CLI) addition: neither of the
  // above lookups is keyed by id, but the CLI's `revoke` command needs to
  // fetch-then-preserve-other-fields before round-tripping through `upsert`
  // (upsert overwrites every column, so a partial object would silently drop
  // the other fields). Not a schema/DDL change - `members.id` is already the
  // PRIMARY KEY - just a read this repository didn't previously expose.
  getById(id: string): Member | null {
    const row = this.db
      .prepare(`SELECT * FROM members WHERE id = ? LIMIT 1`)
      .get(id) as Record<string, unknown> | undefined;

    return row ? mapMember(row) : null;
  }

  listActive(): Member[] {
    const rows = this.db
      .prepare(`SELECT * FROM members WHERE status = 'active' ORDER BY created_at ASC`)
      .all() as Array<Record<string, unknown>>;

    return rows.map(mapMember);
  }

  // Task 3.2 addition: the member-management CLI's `list` command is an
  // admin-facing view - it must show revoked members too (otherwise
  // confirming a `revoke` actually took effect requires reaching for raw
  // SQL), unlike `listActive`, which is the "who can this resolve to"
  // production-path read used by identity resolution / rule ownership checks.
  listAll(): Member[] {
    const rows = this.db
      .prepare(`SELECT * FROM members ORDER BY created_at ASC`)
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

  // Task 3.2 addition: the return value (previously void) lets callers - the
  // member-management CLI's `token revoke` in particular - tell "revoked a
  // real token" apart from "no row matched this id" (`changes === 0`)
  // without a separate existence-check query. No existing caller inspected
  // the old void return, so this widening is backward compatible.
  revoke(tokenId: string): { changes: number | bigint } {
    const result = this.db
      .prepare(`UPDATE api_tokens SET revoked_at = ? WHERE id = ?`)
      .run(nowIso(), tokenId);
    return { changes: result.changes };
  }
}

// Input to ProposalRepository.create(): every Proposal field EXCEPT the ones
// the repository itself computes (id, approvalToken via createId; status
// always starts 'pending'; consumedAt/decidedAt/decidedBy/ticketId/outcome/
// cardMessageId all start unset - they are only ever written by the later
// state-transition methods below; createdAt via nowIso()). expiresAt is
// deliberately NOT omitted - the plan requires it as a caller-supplied,
// required field ("expires_at required"): Task 1 does not own the +24h
// computation policy (that lands with the CLI in Task 3), it only enforces
// that some expiry is always present. evidence/disciplineReport are widened
// back to optional (defaulting to `[]`) since most callers building a
// proposal from scratch have neither yet.
export type NewProposal = Omit<
  Proposal,
  | "id"
  | "status"
  | "approvalToken"
  | "consumedAt"
  | "decidedAt"
  | "decidedBy"
  | "ticketId"
  | "outcome"
  | "cardMessageId"
  | "createdAt"
  | "evidence"
  | "disciplineReport"
> & {
  evidence?: Proposal["evidence"];
  disciplineReport?: Proposal["disciplineReport"];
};

export type ProposalDecision = "approved" | "approved_half" | "rejected" | "expired";

export interface ConsumeApprovalInput {
  decision: ProposalDecision;
  decidedBy: string;
  decidedAt: string;
}

export interface ConsumeApprovalResult {
  consumed: boolean;
  proposal?: Proposal;
}

// Maps a consumeApproval `decision` to the `proposals.status` value it writes.
// Written as an explicit switch (not treated as an identity function even
// though today decision and status values happen to read the same) so a
// future divergence between the two vocabularies fails to compile instead of
// silently writing the wrong status.
function decisionToStatus(decision: ProposalDecision): ProposalStatus {
  switch (decision) {
    case "approved":
      return "approved";
    case "approved_half":
      return "approved_half";
    case "rejected":
      return "rejected";
    case "expired":
      return "expired";
    default: {
      const exhaustive: never = decision;
      throw new Error(`Unknown proposal decision: ${String(exhaustive)}`);
    }
  }
}

export class ProposalRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(input: NewProposal): Proposal {
    if (!input.expiresAt) {
      throw new Error("Proposal.expiresAt is required.");
    }

    const id = createId("proposal");
    const approvalToken = createId("approval");
    const createdAt = nowIso();
    const evidence = input.evidence ?? [];
    const disciplineReport = input.disciplineReport ?? [];

    this.db
      .prepare(`
        INSERT INTO proposals
        (id, owner_id, symbol, side, quantity, order_type, limit_price, reason, evidence, strategy_ref,
         discipline_report, invalidation, stop_loss, budget_impact, confidence, status, approval_token,
         consumed_at, decided_at, decided_by, ticket_id, outcome, card_message_id, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
      `)
      .run(
        id,
        input.ownerId,
        input.symbol,
        input.side,
        input.quantity,
        input.orderType,
        input.limitPrice ?? null,
        input.reason,
        toJson(evidence),
        input.strategyRef ?? null,
        toJson(disciplineReport),
        input.invalidation ?? null,
        input.stopLoss ?? null,
        input.budgetImpact ?? null,
        input.confidence ?? null,
        approvalToken,
        createdAt,
        input.expiresAt
      );

    return {
      id,
      ownerId: input.ownerId,
      symbol: input.symbol,
      side: input.side,
      quantity: input.quantity,
      orderType: input.orderType,
      ...(input.limitPrice !== undefined ? { limitPrice: input.limitPrice } : {}),
      reason: input.reason,
      evidence,
      ...(input.strategyRef !== undefined ? { strategyRef: input.strategyRef } : {}),
      disciplineReport,
      ...(input.invalidation !== undefined ? { invalidation: input.invalidation } : {}),
      ...(input.stopLoss !== undefined ? { stopLoss: input.stopLoss } : {}),
      ...(input.budgetImpact !== undefined ? { budgetImpact: input.budgetImpact } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      status: "pending",
      approvalToken,
      createdAt,
      expiresAt: input.expiresAt
    };
  }

  getById(id: string): Proposal | null {
    const row = this.db
      .prepare(`SELECT * FROM proposals WHERE id = ? LIMIT 1`)
      .get(id) as Record<string, unknown> | undefined;

    return row ? mapProposal(row) : null;
  }

  getByToken(token: string): Proposal | null {
    const row = this.db
      .prepare(`SELECT * FROM proposals WHERE approval_token = ? LIMIT 1`)
      .get(token) as Record<string, unknown> | undefined;

    return row ? mapProposal(row) : null;
  }

  // THE single atomic status-transition channel (plan Global Constraint:
  // "approval_token 原子消费...唯一的状态跃迁通道") - approval-button clicks, the
  // CLI's approve/approve-half/reject, and the expiry sweep all route through
  // this one method, never write `status`/`consumed_at` directly. The UPDATE's
  // WHERE clause (`approval_token = ? AND consumed_at IS NULL`) is the whole
  // concurrency guarantee: SQLite executes one write at a time, so of any
  // number of callers racing to consume the same token, exactly one UPDATE
  // will find consumed_at still NULL and flip it (changes === 1); every other
  // racing caller's UPDATE matches zero rows (changes === 0) and gets
  // `{consumed:false}` back - a duplicate-consumption attempt, not an error.
  consumeApproval(token: string, input: ConsumeApprovalInput): ConsumeApprovalResult {
    const status = decisionToStatus(input.decision);
    const result = this.db
      .prepare(`
        UPDATE proposals
        SET status = ?, consumed_at = ?, decided_at = ?, decided_by = ?
        WHERE approval_token = ? AND consumed_at IS NULL
      `)
      .run(status, input.decidedAt, input.decidedAt, input.decidedBy, token);

    if (Number(result.changes) !== 1) {
      return { consumed: false };
    }

    const proposal = this.getByToken(token);
    return proposal ? { consumed: true, proposal } : { consumed: true };
  }

  // Idempotent: re-calling with the SAME ticketId after a proposal is already
  // marked executed with that ticketId is a no-op (the UPDATE just rewrites
  // the same values) - this matters because the broker-executor's
  // record-before-execute retry path (Task 4) may call this more than once
  // for the same successful execution. A DIFFERENT ticketId on an
  // already-executed proposal is refused loudly: a proposal is "one ticket at
  // most" (plan: "幂等键=proposal id（一提案至多一单）"), so silently
  // overwriting would hide a double-execution bug rather than surface it.
  markExecuted(id: string, ticketId: string): void {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Proposal ${id} not found.`);
    }
    if (existing.ticketId !== undefined && existing.ticketId !== ticketId) {
      throw new Error(
        `Proposal ${id} already executed with ticket ${existing.ticketId}; refusing to overwrite with ${ticketId}.`
      );
    }

    this.db
      .prepare(`UPDATE proposals SET status = 'executed', ticket_id = ? WHERE id = ?`)
      .run(ticketId, id);
  }

  markFailed(id: string, reason: string): void {
    const result = this.db
      .prepare(`UPDATE proposals SET status = 'failed', outcome = ? WHERE id = ?`)
      .run(reason, id);

    if (Number(result.changes) === 0) {
      throw new Error(`Proposal ${id} not found.`);
    }
  }

  // `nowIso` here is a caller-supplied comparison timestamp (the sweep's
  // "now"), not this module's `nowIso()` clock helper - it shadows that
  // import within this method's body only, which is safe because this
  // method never needs to call the clock itself.
  listPendingExpired(nowIso: string): Proposal[] {
    const rows = this.db
      .prepare(`SELECT * FROM proposals WHERE status = 'pending' AND expires_at <= ? ORDER BY expires_at ASC`)
      .all(nowIso) as Array<Record<string, unknown>>;

    return rows.map(mapProposal);
  }

  updateCardMessageId(id: string, messageId: string): void {
    const result = this.db
      .prepare(`UPDATE proposals SET card_message_id = ? WHERE id = ?`)
      .run(messageId, id);

    if (Number(result.changes) === 0) {
      throw new Error(`Proposal ${id} not found.`);
    }
  }

  // Phase 6 Task 3 (proposals.mjs's `list` command) addition - NOT a DDL
  // change (the plan's "DDL 冻结" only freezes the proposals TABLE shape,
  // already declared complete by Task 1; this is a plain read method on top
  // of it, same category as the pre-existing getById/getByToken/
  // listPendingExpired above). Added here rather than as raw SQL inside
  // proposals.mjs because every other CLI in this codebase (members.mjs's own
  // header comment) keeps SQL out of the CLI layer and routes it through a
  // repository instead.
  listByOwner(ownerId: string, status?: ProposalStatus): Proposal[] {
    const rows = status
      ? (this.db
          .prepare(`SELECT * FROM proposals WHERE owner_id = ? AND status = ? ORDER BY created_at DESC`)
          .all(ownerId, status) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(`SELECT * FROM proposals WHERE owner_id = ? ORDER BY created_at DESC`)
          .all(ownerId) as Array<Record<string, unknown>>);

    return rows.map(mapProposal);
  }
}

export interface CircuitBreakerState {
  ownerId: string;
  pausedUntil: string;
  reason: string;
  weeklyLossPct?: number;
  trippedAt: string;
}

export interface TripCircuitBreakerInput {
  pausedUntil: string;
  reason: string;
  weeklyLossPct?: number;
}

export class CircuitBreakerRepository {
  constructor(private readonly db: DatabaseSync) {}

  getState(ownerId: string): CircuitBreakerState | null {
    const row = this.db
      .prepare(`SELECT * FROM circuit_breaker_state WHERE owner_id = ? LIMIT 1`)
      .get(ownerId) as Record<string, unknown> | undefined;

    return row ? mapCircuitBreakerState(row) : null;
  }

  // Upsert: one row per owner (owner_id is the PRIMARY KEY), so re-tripping
  // an already-paused owner (e.g. a later, worse weekly-loss reading) simply
  // replaces the prior pause window/reason/trippedAt rather than erroring.
  trip(ownerId: string, input: TripCircuitBreakerInput): void {
    const trippedAt = nowIso();
    this.db
      .prepare(`
        INSERT INTO circuit_breaker_state (owner_id, paused_until, reason, weekly_loss_pct, tripped_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(owner_id) DO UPDATE SET
          paused_until = excluded.paused_until,
          reason = excluded.reason,
          weekly_loss_pct = excluded.weekly_loss_pct,
          tripped_at = excluded.tripped_at
      `)
      .run(ownerId, input.pausedUntil, input.reason, input.weeklyLossPct ?? null, trippedAt);
  }

  // Deletes a stale (already-expired) pause row outright, rather than
  // leaving it around with a past paused_until - isPaused's own
  // `paused_until > now` check would already treat an expired row as "not
  // paused", but a stale row left in place would misreport the OWNER's last
  // trip reason/timestamp indefinitely to anything reading getState()
  // directly (e.g. a platform "last circuit trip" history view).
  clearIfExpired(ownerId: string, now: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM circuit_breaker_state WHERE owner_id = ? AND paused_until <= ?`)
      .run(ownerId, now);

    return Number(result.changes) > 0;
  }

  isPaused(ownerId: string, now: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM circuit_breaker_state WHERE owner_id = ? AND paused_until > ? LIMIT 1`)
      .get(ownerId, now);

    return row !== undefined;
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
    // Phase 6 Task 4: external_order_id is now nullable at the DB layer (v11
    // migration) - a bare `String(row.external_order_id)` would previously
    // have stringified SQLite NULL to the literal text "null", silently
    // corrupting a record-before-execute row's externalOrderId instead of
    // leaving it unset.
    ...(row.external_order_id ? { externalOrderId: String(row.external_order_id) } : {}),
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
    notes: fromJson<string[]>(String(row.notes)),
    ...(row.owner_id ? { ownerId: String(row.owner_id) } : {})
  };

  if (limitPrice !== undefined && Number.isFinite(limitPrice)) {
    lifecycle.limitPrice = limitPrice;
  }

  return lifecycle;
}

function mapProposal(row: Record<string, unknown>): Proposal {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    symbol: String(row.symbol),
    side: String(row.side) as Proposal["side"],
    quantity: Number(row.quantity),
    orderType: String(row.order_type),
    ...(row.limit_price !== null && row.limit_price !== undefined ? { limitPrice: Number(row.limit_price) } : {}),
    reason: String(row.reason),
    evidence: fromJson<Proposal["evidence"]>(String(row.evidence)) ?? [],
    ...(row.strategy_ref ? { strategyRef: String(row.strategy_ref) } : {}),
    disciplineReport: fromJson<Proposal["disciplineReport"]>(String(row.discipline_report)) ?? [],
    ...(row.invalidation ? { invalidation: String(row.invalidation) } : {}),
    ...(row.stop_loss !== null && row.stop_loss !== undefined ? { stopLoss: Number(row.stop_loss) } : {}),
    ...(row.budget_impact !== null && row.budget_impact !== undefined ? { budgetImpact: Number(row.budget_impact) } : {}),
    ...(row.confidence ? { confidence: String(row.confidence) as ProposalConfidence } : {}),
    status: String(row.status) as Proposal["status"],
    ...(row.approval_token ? { approvalToken: String(row.approval_token) } : {}),
    ...(row.consumed_at ? { consumedAt: String(row.consumed_at) } : {}),
    ...(row.decided_at ? { decidedAt: String(row.decided_at) } : {}),
    ...(row.decided_by ? { decidedBy: String(row.decided_by) } : {}),
    ...(row.ticket_id ? { ticketId: String(row.ticket_id) } : {}),
    ...(row.outcome ? { outcome: String(row.outcome) } : {}),
    ...(row.card_message_id ? { cardMessageId: String(row.card_message_id) } : {}),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at)
  };
}

function mapCircuitBreakerState(row: Record<string, unknown>): CircuitBreakerState {
  return {
    ownerId: String(row.owner_id),
    pausedUntil: String(row.paused_until),
    reason: String(row.reason),
    ...(row.weekly_loss_pct !== null && row.weekly_loss_pct !== undefined
      ? { weeklyLossPct: Number(row.weekly_loss_pct) }
      : {}),
    trippedAt: String(row.tripped_at)
  };
}
