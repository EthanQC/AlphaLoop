import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AdviceCard,
  ApprovalEdit,
  Event,
  ExecutionReport,
  OfficialPaperOrderLifecycle,
  OptionContract,
  PaperPosition,
  PreferenceSnapshot,
  QueueRecord,
  QueueStatus,
  RuleProposalComparison,
  RuleProposal,
  RuleSet,
  ShadowPosition
} from "./domain.js";
import { createId } from "./domain.js";
import { resolveRepoRoot } from "./runtime.js";

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

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      symbols TEXT NOT NULL,
      ts TEXT NOT NULL,
      payload TEXT NOT NULL,
      importance REAL NOT NULL,
      dedupe_key TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS queue_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      payload TEXT NOT NULL,
      dedupe_key TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      consumer TEXT,
      lease_until INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS queue_messages_topic_dedupe
      ON queue_messages(topic, dedupe_key)
      WHERE dedupe_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS queue_messages_available_idx
      ON queue_messages(topic, status, available_at, lease_until);

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      action TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS advice_cards (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      asset_class TEXT NOT NULL,
      thesis TEXT NOT NULL,
      entry_condition TEXT NOT NULL,
      suggested_size_percent REAL NOT NULL,
      invalidation TEXT NOT NULL,
      exit_plan TEXT NOT NULL,
      risk_notes TEXT NOT NULL,
      preference_alignment TEXT NOT NULL,
      rule_delta TEXT
    );

    CREATE TABLE IF NOT EXISTS approval_edits (
      id TEXT PRIMARY KEY,
      advice_card_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      editor TEXT NOT NULL,
      summary TEXT NOT NULL,
      diff TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS preference_snapshots (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      source TEXT NOT NULL,
      summary TEXT NOT NULL,
      traits TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rule_versions (
      scope TEXT PRIMARY KEY,
      active_version TEXT NOT NULL,
      candidate_version TEXT,
      updated_at INTEGER NOT NULL
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

    CREATE TABLE IF NOT EXISTS rule_proposals (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      scope TEXT NOT NULL,
      current_version TEXT NOT NULL,
      candidate_version TEXT NOT NULL,
      summary TEXT NOT NULL,
      old_vs_new TEXT NOT NULL,
      evidence TEXT NOT NULL,
      recommendation TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shadow_positions (
      id TEXT PRIMARY KEY,
      strategy TEXT NOT NULL,
      symbol TEXT NOT NULL,
      contract TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      avg_price REAL NOT NULL,
      status TEXT NOT NULL,
      realized_pnl REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shadow_orders (
      id TEXT PRIMARY KEY,
      position_id TEXT,
      ticket_id TEXT NOT NULL,
      strategy TEXT NOT NULL,
      symbol TEXT NOT NULL,
      contract TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      side TEXT NOT NULL,
      fill_price REAL NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS paper_positions (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      asset_class TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      avg_price REAL NOT NULL,
      status TEXT NOT NULL,
      realized_pnl REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS paper_positions_symbol_status_idx
      ON paper_positions(symbol, status, created_at);

    CREATE TABLE IF NOT EXISTS paper_orders (
      id TEXT PRIMARY KEY,
      position_id TEXT,
      ticket_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      asset_class TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      side TEXT NOT NULL,
      fill_price REAL NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
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
  `);

  ensureColumn(db, "rule_proposals", "title", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "rule_proposals", "trigger_reason", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "rule_proposals", "expected_benefit", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "rule_proposals", "risks", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "rule_proposals", "rollback_plan", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "rule_proposals", "status", "TEXT NOT NULL DEFAULT 'pending_confirmation'");
  ensureColumn(db, "rule_proposals", "proposal_path", "TEXT");
  ensureColumn(db, "rule_proposals", "decided_at", "TEXT");
  ensureColumn(db, "rule_proposals", "decided_by", "TEXT");
  ensureColumn(db, "rule_proposals", "decision_reason", "TEXT");
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((entry) => entry.name === column)) {
    return;
  }

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

export class EventStoreRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsert(event: Event): void {
    this.db
      .prepare(`
        INSERT INTO events (id, type, source, symbols, ts, payload, importance, dedupe_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          payload = excluded.payload,
          importance = excluded.importance,
          created_at = excluded.created_at
      `)
      .run(
        event.id,
        event.type,
        event.source,
        toJson(event.symbols),
        event.ts,
        toJson(event.payload),
        event.importance,
        event.dedupeKey,
        Date.now()
      );
  }
}

export class QueueRepository {
  constructor(private readonly db: DatabaseSync) {}

  append(topic: string, payload: unknown, dedupeKey?: string, availableAt = Date.now()): number {
    const now = Date.now();
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO queue_messages (topic, payload, dedupe_key, status, available_at, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', ?, ?, ?)
      `)
      .run(topic, toJson(payload), dedupeKey ?? null, availableAt, now, now);

    return Number(result.lastInsertRowid ?? 0);
  }

  claim<T>(topic: string, consumer: string, leaseMs: number, limit: number): QueueRecord<T>[] {
    const now = Date.now();
    const dueRows = this.db
      .prepare(`
        SELECT * FROM queue_messages
        WHERE topic = ?
          AND status = 'pending'
          AND available_at <= ?
          AND (lease_until IS NULL OR lease_until <= ?)
        ORDER BY created_at ASC
        LIMIT ?
      `)
      .all(topic, now, now, limit) as Array<Record<string, unknown>>;

    const update = this.db.prepare(`
      UPDATE queue_messages
      SET status = 'inflight',
          consumer = ?,
          attempts = attempts + 1,
          lease_until = ?,
          updated_at = ?
      WHERE id = ?
    `);

    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      for (const row of dueRows) {
        update.run(consumer, now + leaseMs, now, Number(row.id));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return dueRows.map((row) => mapQueueRow<T>({ ...row, consumer, lease_until: now + leaseMs }));
  }

  acknowledge(id: number): void {
    this.updateStatus(id, "acked");
  }

  retry(id: number, delayMs: number, errorMessage?: string): void {
    const now = Date.now();
    this.db
      .prepare(`
        UPDATE queue_messages
        SET status = 'pending',
            available_at = ?,
            consumer = NULL,
            lease_until = NULL,
            last_error = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(now + delayMs, errorMessage ?? null, now, id);
  }

  deadLetter(id: number, reason: string): void {
    const now = Date.now();
    this.db
      .prepare(`
        UPDATE queue_messages
        SET status = 'dead_letter',
            last_error = ?,
            consumer = NULL,
            lease_until = NULL,
            updated_at = ?
        WHERE id = ?
      `)
      .run(reason, now, id);
  }

  replayDeadLetter(id: number): void {
    const now = Date.now();
    this.db
      .prepare(`
        UPDATE queue_messages
        SET status = 'pending',
            last_error = NULL,
            available_at = ?,
            updated_at = ?
        WHERE id = ? AND status = 'dead_letter'
      `)
      .run(now, now, id);
  }

  listDeadLetters<T>(topic?: string): QueueRecord<T>[] {
    const rows = topic
      ? (this.db
          .prepare(`SELECT * FROM queue_messages WHERE status = 'dead_letter' AND topic = ? ORDER BY created_at DESC`)
          .all(topic) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(`SELECT * FROM queue_messages WHERE status = 'dead_letter' ORDER BY created_at DESC`)
          .all() as Array<Record<string, unknown>>);

    return rows.map((row) => mapQueueRow<T>(row));
  }

  private updateStatus(id: number, status: QueueStatus): void {
    const now = Date.now();
    this.db
      .prepare(`
        UPDATE queue_messages
        SET status = ?,
            updated_at = ?,
            consumer = NULL,
            lease_until = NULL
        WHERE id = ?
      `)
      .run(status, now, id);
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

export class AdviceRepository {
  constructor(private readonly db: DatabaseSync) {}

  saveAdvice(card: AdviceCard): void {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO advice_cards
        (id, created_at, symbol, direction, asset_class, thesis, entry_condition, suggested_size_percent,
         invalidation, exit_plan, risk_notes, preference_alignment, rule_delta)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        card.id,
        card.createdAt,
        card.symbol,
        card.direction,
        card.assetClass,
        card.thesis,
        card.entryCondition,
        card.suggestedSizePercent,
        card.invalidation,
        card.exitPlan,
        toJson(card.riskNotes),
        card.preferenceAlignment,
        card.ruleDelta ?? null
      );
  }

  saveApproval(edit: ApprovalEdit): void {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO approval_edits
        (id, advice_card_id, created_at, editor, summary, diff)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(edit.id, edit.adviceCardId, edit.createdAt, edit.editor, edit.summary, toJson(edit.diff));
  }

  getAdvice(id: string): AdviceCard | null {
    const row = this.db
      .prepare(`SELECT * FROM advice_cards WHERE id = ? LIMIT 1`)
      .get(id) as Record<string, unknown> | undefined;

    return row ? mapAdviceCard(row) : null;
  }

  listRecent(limit = 20): AdviceCard[] {
    const rows = this.db
      .prepare(`SELECT * FROM advice_cards ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map(mapAdviceCard);
  }

  listApprovals(limit = 50): ApprovalEdit[] {
    const rows = this.db
      .prepare(`SELECT * FROM approval_edits ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      adviceCardId: String(row.advice_card_id),
      createdAt: String(row.created_at),
      editor: String(row.editor),
      summary: String(row.summary),
      diff: fromJson(String(row.diff))
    }));
  }
}

export class PreferenceRepository {
  constructor(private readonly db: DatabaseSync) {}

  save(snapshot: PreferenceSnapshot): void {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO preference_snapshots
        (id, created_at, source, summary, traits)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(snapshot.id, snapshot.createdAt, snapshot.source, snapshot.summary, toJson(snapshot.traits));
  }

  latest(): PreferenceSnapshot | null {
    const row = this.db
      .prepare(`SELECT * FROM preference_snapshots ORDER BY created_at DESC LIMIT 1`)
      .get() as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    return {
      id: String(row.id),
      createdAt: String(row.created_at),
      source: String(row.source),
      summary: String(row.summary),
      traits: fromJson<string[]>(String(row.traits))
    };
  }

  listRecent(limit = 20): PreferenceSnapshot[] {
    const rows = this.db
      .prepare(`SELECT * FROM preference_snapshots ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      createdAt: String(row.created_at),
      source: String(row.source),
      summary: String(row.summary),
      traits: fromJson<string[]>(String(row.traits))
    }));
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

export class RuleProposalRepository {
  constructor(private readonly db: DatabaseSync) {}

  save(proposal: RuleProposal): void {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO rule_proposals
        (id, created_at, scope, current_version, candidate_version, title, summary, trigger_reason,
         old_vs_new, evidence, expected_benefit, risks, rollback_plan, recommendation, status,
         proposal_path, decided_at, decided_by, decision_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        proposal.id,
        proposal.createdAt,
        proposal.scope,
        proposal.currentVersion,
        proposal.candidateVersion,
        proposal.title,
        proposal.summary,
        proposal.triggerReason,
        toJson(proposal.oldVsNew),
        toJson(proposal.evidence),
        proposal.expectedBenefit,
        toJson(proposal.risks),
        proposal.rollbackPlan,
        proposal.recommendation,
        proposal.status,
        proposal.proposalPath ?? null,
        proposal.decidedAt ?? null,
        proposal.decidedBy ?? null,
        proposal.decisionReason ?? null
      );
  }

  listRecent(limit = 20, scope?: RuleProposal["scope"]): RuleProposal[] {
    const rows = scope
      ? (this.db
          .prepare(`SELECT * FROM rule_proposals WHERE scope = ? ORDER BY created_at DESC LIMIT ?`)
          .all(scope, limit) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(`SELECT * FROM rule_proposals ORDER BY created_at DESC LIMIT ?`)
          .all(limit) as Array<Record<string, unknown>>);

    return rows.map(mapRuleProposal);
  }

  latest(scope: RuleProposal["scope"]): RuleProposal | null {
    const row = this.db
      .prepare(`SELECT * FROM rule_proposals WHERE scope = ? ORDER BY created_at DESC LIMIT 1`)
      .get(scope) as Record<string, unknown> | undefined;

    return row ? mapRuleProposal(row) : null;
  }
}

export class ShadowBookRepository {
  constructor(private readonly db: DatabaseSync) {}

  openPosition(position: ShadowPosition): void {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO shadow_positions
        (id, strategy, symbol, contract, quantity, avg_price, status, realized_pnl, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        position.id,
        position.strategy,
        position.symbol,
        toJson(position.contract),
        position.quantity,
        position.avgPrice,
        position.status,
        position.realizedPnl,
        position.createdAt,
        position.updatedAt
      );
  }

  listOpenPositions(): ShadowPosition[] {
    const rows = this.db
      .prepare(`SELECT * FROM shadow_positions WHERE status = 'open' ORDER BY created_at ASC`)
      .all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      strategy: String(row.strategy) as ShadowPosition["strategy"],
      symbol: String(row.symbol),
      contract: fromJson<OptionContract>(String(row.contract)),
      quantity: Number(row.quantity),
      avgPrice: Number(row.avg_price),
      status: String(row.status) as ShadowPosition["status"],
      realizedPnl: Number(row.realized_pnl),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }));
  }

  getPosition(id: string): ShadowPosition | null {
    const row = this.db
      .prepare(`SELECT * FROM shadow_positions WHERE id = ? LIMIT 1`)
      .get(id) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    return {
      id: String(row.id),
      strategy: String(row.strategy) as ShadowPosition["strategy"],
      symbol: String(row.symbol),
      contract: fromJson<OptionContract>(String(row.contract)),
      quantity: Number(row.quantity),
      avgPrice: Number(row.avg_price),
      status: String(row.status) as ShadowPosition["status"],
      realizedPnl: Number(row.realized_pnl),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  appendOrder(input: {
    positionId?: string;
    ticketId: string;
    strategy: string;
    symbol: string;
    contract: unknown;
    quantity: number;
    side: string;
    fillPrice: number;
    status: string;
    createdAt: string;
  }): string {
    const id = createId("shadow_order");
    this.db
      .prepare(`
        INSERT INTO shadow_orders
        (id, position_id, ticket_id, strategy, symbol, contract, quantity, side, fill_price, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.positionId ?? null,
        input.ticketId,
        input.strategy,
        input.symbol,
        toJson(input.contract),
        input.quantity,
        input.side,
        input.fillPrice,
        input.status,
        input.createdAt
      );
    return id;
  }
}

export class PaperBookRepository {
  constructor(private readonly db: DatabaseSync) {}

  upsertPosition(position: PaperPosition): void {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO paper_positions
        (id, symbol, asset_class, quantity, avg_price, status, realized_pnl, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        position.id,
        position.symbol,
        position.assetClass,
        position.quantity,
        position.avgPrice,
        position.status,
        position.realizedPnl,
        position.createdAt,
        position.updatedAt
      );
  }

  listOpenPositions(): PaperPosition[] {
    const rows = this.db
      .prepare(`SELECT * FROM paper_positions WHERE status = 'open' ORDER BY created_at ASC`)
      .all() as Array<Record<string, unknown>>;

    return rows.map(mapPaperPosition);
  }

  getOpenPositionBySymbol(symbol: string): PaperPosition | null {
    const row = this.db
      .prepare(`
        SELECT * FROM paper_positions
        WHERE symbol = ? AND status = 'open'
        ORDER BY created_at ASC
        LIMIT 1
      `)
      .get(symbol) as Record<string, unknown> | undefined;

    return row ? mapPaperPosition(row) : null;
  }

  appendOrder(input: {
    positionId?: string;
    ticketId: string;
    symbol: string;
    assetClass: string;
    quantity: number;
    side: string;
    fillPrice: number;
    status: string;
    createdAt: string;
  }): string {
    const id = createId("paper_order");
    this.db
      .prepare(`
        INSERT INTO paper_orders
        (id, position_id, ticket_id, symbol, asset_class, quantity, side, fill_price, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.positionId ?? null,
        input.ticketId,
        input.symbol,
        input.assetClass,
        input.quantity,
        input.side,
        input.fillPrice,
        input.status,
        input.createdAt
      );
    return id;
  }
}

export class RuleRegistry {
  private readonly repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = resolveRepoRoot(repoRoot);
  }

  load(scope: "live" | "paper"): RuleSet {
    const activeFile = join(this.repoRoot, "rules", scope, "active-version.json");
    const activeVersion = JSON.parse(readFileSync(activeFile, "utf8")) as {
      activeVersion: string;
      candidateVersion?: string;
    };
    const ruleFile = join(this.repoRoot, "rules", scope, activeVersion.activeVersion, "rule-set.json");
    return JSON.parse(readFileSync(ruleFile, "utf8")) as RuleSet;
  }

  updateCandidate(scope: "live" | "paper", candidateVersion: string): void {
    const activeFile = join(this.repoRoot, "rules", scope, "active-version.json");
    const current = JSON.parse(readFileSync(activeFile, "utf8")) as {
      activeVersion: string;
      candidateVersion?: string;
    };
    current.candidateVersion = candidateVersion;
    writeFileSync(activeFile, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  }

  activate(scope: "live" | "paper", version: string): void {
    const activeFile = join(this.repoRoot, "rules", scope, "active-version.json");
    writeFileSync(
      activeFile,
      `${JSON.stringify({ activeVersion: version, candidateVersion: null }, null, 2)}\n`,
      "utf8"
    );
  }
}

function mapQueueRow<T>(row: Record<string, unknown>): QueueRecord<T> {
  return {
    id: Number(row.id),
    topic: String(row.topic),
    payload: fromJson<T>(String(row.payload)),
    status: String(row.status) as QueueStatus,
    attempts: Number(row.attempts),
    availableAt: Number(row.available_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.consumer ? { consumer: String(row.consumer) } : {}),
    ...(row.lease_until ? { leaseUntil: Number(row.lease_until) } : {}),
    ...(row.dedupe_key ? { dedupeKey: String(row.dedupe_key) } : {}),
    ...(row.last_error ? { lastError: String(row.last_error) } : {})
  };
}

function mapPaperPosition(row: Record<string, unknown>): PaperPosition {
  return {
    id: String(row.id),
    symbol: String(row.symbol),
    assetClass: String(row.asset_class) as PaperPosition["assetClass"],
    quantity: Number(row.quantity),
    avgPrice: Number(row.avg_price),
    status: String(row.status) as PaperPosition["status"],
    realizedPnl: Number(row.realized_pnl),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
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

function mapAdviceCard(row: Record<string, unknown>): AdviceCard {
  return {
    id: String(row.id),
    createdAt: String(row.created_at),
    symbol: String(row.symbol),
    direction: String(row.direction) as AdviceCard["direction"],
    assetClass: String(row.asset_class) as AdviceCard["assetClass"],
    thesis: String(row.thesis),
    entryCondition: String(row.entry_condition),
    suggestedSizePercent: Number(row.suggested_size_percent),
    invalidation: String(row.invalidation),
    exitPlan: String(row.exit_plan),
    riskNotes: fromJson<string[]>(String(row.risk_notes)),
    preferenceAlignment: String(row.preference_alignment),
    ...(row.rule_delta ? { ruleDelta: String(row.rule_delta) } : {})
  };
}

function mapRuleProposal(row: Record<string, unknown>): RuleProposal {
  return {
    id: String(row.id),
    createdAt: String(row.created_at),
    scope: String(row.scope) as RuleProposal["scope"],
    currentVersion: String(row.current_version),
    candidateVersion: String(row.candidate_version),
    title: String(row.title ?? ""),
    summary: String(row.summary),
    triggerReason: String(row.trigger_reason ?? ""),
    oldVsNew: normalizeRuleProposalComparisons(fromJson<unknown>(String(row.old_vs_new))),
    evidence: fromJson<string[]>(String(row.evidence)),
    expectedBenefit: String(row.expected_benefit ?? ""),
    risks: fromJson<string[]>(String(row.risks ?? "[]")),
    rollbackPlan: String(row.rollback_plan ?? ""),
    recommendation: String(row.recommendation) as RuleProposal["recommendation"],
    status: String(row.status ?? "pending_confirmation") as RuleProposal["status"],
    ...(row.proposal_path ? { proposalPath: String(row.proposal_path) } : {}),
    ...(row.decided_at ? { decidedAt: String(row.decided_at) } : {}),
    ...(row.decided_by ? { decidedBy: String(row.decided_by) } : {}),
    ...(row.decision_reason ? { decisionReason: String(row.decision_reason) } : {})
  };
}

function normalizeRuleProposalComparisons(value: unknown): RuleProposalComparison[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => {
    if (typeof entry === "object" && entry !== null) {
      const candidate = entry as Partial<RuleProposalComparison>;
      return {
        field: String(candidate.field ?? "未命名规则项"),
        oldValue: String(candidate.oldValue ?? ""),
        newValue: String(candidate.newValue ?? ""),
        reason: String(candidate.reason ?? "")
      };
    }

    return {
      field: "旧格式提案",
      oldValue: String(entry),
      newValue: "已归档或待人工重写",
      reason: "历史字符串格式不再作为可激活规则差异。"
    };
  });
}
