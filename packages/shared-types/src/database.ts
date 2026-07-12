import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ExecutionReport,
  OfficialPaperOrderLifecycle
} from "./domain.js";
import { createId } from "./domain.js";

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

export const SCHEMA_VERSION = 1; // Task 2/3/4 will increment this

export function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return Number(row.user_version);
}

const MIGRATIONS: Array<(db: DatabaseSync) => void> = [
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
  }
];

export function migrate(db: DatabaseSync): void {
  let version = getSchemaVersion(db);
  while (version < MIGRATIONS.length) {
    db.exec("BEGIN");
    try {
      const step = MIGRATIONS[version];
      if (!step) {
        throw new Error(`Missing migration step for schema version ${version}`);
      }
      step(db);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
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
