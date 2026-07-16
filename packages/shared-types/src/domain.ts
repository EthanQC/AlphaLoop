import { randomUUID } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type AssetClass = "stock" | "etf" | "option";
export type Environment = "live" | "paper" | "shadow";
export type OrderSide = "buy" | "sell";
export type RiskDecisionStatus = "allow" | "block" | "require_review";
export type ExecutionResultStatus = "accepted" | "rejected" | "submitted" | "pending";
// Phase 6 Task 4 (2026-07-15 plan) adds three stages to this union, ahead of
// any broker status ever actually mapping to them (that mapper is Task 5's
// "broker-status-map" module) - they are written directly by
// broker-executor's /v1/tickets record-before-execute sequence:
// "submitting" (Global Constraint ⑤: the lifecycle row inserted BEFORE the
// broker call, while the CLI invocation hasn't returned yet), "accepted"
// (an order the broker has acknowledged but not yet filled - reserved for
// Task 5's status mapper; included here now because Constraint ④'s
// open-orders budget query already needs to treat it as one of the
// non-terminal "still counts against the owner's budget" stages), and
// "submit_unconfirmed" (Constraint ⑥: the CLI call threw or timed out - the
// order MAY exist at the broker, so this is deliberately NOT "rejected"/
// "failed"; Task 5's reconciliation is what adjudicates it either way).
// Phase 6 Task 5 (2026-07-15 plan) adds two more stages, both written by the
// reconcile rebuild (apps/openclaw-config/scripts/reconcile-official-paper-
// orders.mjs), never by the broker-status-map itself returning them for a
// STATUS STRING it did recognize:
// "unknown_broker_status" - the shared broker-status-map module
// (broker-status-map.ts/.mjs) returns this for a broker status string it
// does NOT recognize, deliberately distinct from the pre-existing plain
// "unknown" (which means "no status string was available at all", e.g. the
// CLI never returned one) - never silently "accepted".
// "failed" - reconcile's own submit_unconfirmed adjudication: the CLI
// call that recorded this row errored/timed out (stage was
// 'submit_unconfirmed'), and a later reconcile pass found no matching order
// in the broker's own day-order list after the adjudication timeout window
// elapsed - distinct from "rejected" (broker explicitly refused it).
export type OfficialPaperOrderLifecycleStage =
  | "submitting"
  | "submitted"
  | "accepted"
  | "pending"
  | "filled"
  | "cancelled"
  | "rejected"
  | "submit_unconfirmed"
  | "unknown_broker_status"
  | "failed"
  | "unknown";
export type OptionStrategy =
  | "long_call"
  | "long_put"
  | "covered_call"
  | "cash_secured_put";
export type EquityAssetClass = "stock" | "etf";

export interface OptionContract {
  underlying: string;
  optionType: "call" | "put";
  expiration: string;
  strike: number;
  multiplier: number;
}

export interface MarketSnapshot {
  bid?: number;
  ask?: number;
  last?: number;
  underlyingPrice?: number;
  timestamp: string;
}

export interface OrderTicket {
  id: string;
  source: string;
  submittedAt: string;
  environment: Environment;
  assetClass: AssetClass;
  symbol: string;
  side: OrderSide;
  quantity: number;
  conviction: "normal" | "high";
  notionalUsd: number;
  strategy?: OptionStrategy;
  optionContract?: OptionContract;
  marketSnapshot?: MarketSnapshot;
  metadata?: Record<string, JsonValue>;
  // Phase 6 Task 4 (2026-07-15 plan): every ticket the hardened /v1/tickets
  // endpoint builds now comes from an approved Proposal, never from a
  // caller-supplied ticket object - these two fields carry that provenance
  // through risk evaluation, lifecycle recording, and the executed-proposal
  // linkage (proposals.markExecuted). Optional on the TYPE (existing
  // broker-executor unit tests construct bare tickets without them) but
  // assertOrderTicket below requires them at the one call site that matters:
  // the executor's own pre-execution sanity check on its server-built ticket.
  ownerId?: string;
  proposalId?: string;
}

export interface RiskDecision {
  status: RiskDecisionStatus;
  reasons: string[];
  requiresHumanReview: boolean;
}

export interface ExecutionResult {
  ticketId: string;
  environment: Environment;
  status: ExecutionResultStatus;
  provider: "broker-executor" | "longbridge-paper";
  externalOrderId?: string;
  fillPrice?: number;
  limitPrice?: number;
  brokerStatus?: string;
  brokerOrderStage?: OfficialPaperOrderLifecycleStage;
  submittedAt?: string;
  observedAt?: string;
  rawBrokerPayload?: JsonValue;
  reportId?: string;
  reasons: string[];
}

export interface OfficialPaperOrderLifecycle {
  id: string;
  ticketId?: string;
  // Phase 6 Task 4: the record-before-execute row is INSERTed before the
  // broker call happens - at that moment there is no external_order_id yet
  // (that only exists once the broker replies). Was `string` (required);
  // widened to optional. `external_order_id` in the DDL keeps its UNIQUE
  // constraint (collisions among REAL broker order ids are still caught) but
  // drops NOT NULL (migration v11) so this pre-broker-call row can exist.
  externalOrderId?: string;
  provider: "longbridge-paper";
  environment: "paper";
  accountMode: "paper";
  symbol: string;
  assetClass: EquityAssetClass;
  side: OrderSide;
  quantity: number;
  limitPrice?: number;
  brokerStatus: string;
  localStatus: ExecutionResultStatus;
  lifecycleStage: OfficialPaperOrderLifecycleStage;
  submittedAt: string;
  lastObservedAt: string;
  raw?: JsonValue;
  notes: string[];
  // Phase 6 Task 4: per-owner ownership already existed as a bare DB column
  // (v4 migration's ALTER TABLE ... ADD COLUMN owner_id) but was never
  // surfaced on this domain type - the new record-before-execute writers
  // (ProposalRepository-linked inserts) need to read/write it, and the
  // per-owner open-orders budget query (Constraint ④) groups by it.
  ownerId?: string;
}

// Phase 6 Task 1 (2026-07-15 plan): mirrors the `proposals` table (v3 DDL,
// packages/shared-types/src/database.ts) field-for-field. `status` is the
// state-machine's full value set enforced by that table's CHECK constraint -
// `consumeApproval` (ProposalRepository) is the ONLY writer allowed to move a
// row out of 'pending', per the plan's execution-chain invariant ("approval
// _token 原子消费...唯一的状态跃迁通道").
export type ProposalConfidence = "low" | "medium" | "high";

export type ProposalStatus =
  | "pending"
  | "approved"
  | "approved_half"
  | "rejected"
  | "expired"
  | "executed"
  | "failed";

export interface Proposal {
  id: string;
  ownerId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  orderType: string;
  limitPrice?: number;
  reason: string;
  evidence: JsonValue[];
  strategyRef?: string;
  disciplineReport: JsonValue[];
  invalidation?: string;
  stopLoss?: number;
  budgetImpact?: number;
  confidence?: ProposalConfidence;
  status: ProposalStatus;
  approvalToken?: string;
  consumedAt?: string;
  decidedAt?: string;
  decidedBy?: string;
  ticketId?: string;
  outcome?: string;
  cardMessageId?: string;
  createdAt: string;
  expiresAt: string;
}

export interface RuleSet {
  version: string;
  scope: "live" | "paper";
  maxIdeaExposurePercent: number;
  maxHighConvictionExposurePercent: number;
  maxConcurrentIdeas: number;
  maxHighConvictionIdeas: number;
  maxDailyNewRiskPercent: number;
  allowedOptionStrategies: OptionStrategy[];
  notes: string[];
}

export interface ExecutionReport {
  id: string;
  category: "trade" | "daily" | "weekly";
  title: string;
  body: string;
  metadata: Record<string, JsonValue>;
  createdAt: string;
}

export interface Member {
  id: string;
  email: string;
  feishuOpenId?: string;
  displayName: string;
  riskTags: string[];
  stockTags: string[];
  showPerformance: boolean;
  status: "active" | "revoked";
  createdAt: string;
}

// Phase 8 Task 1 (2026-07-16 plan, in-site research): mirrors the
// `research_tasks` table (v3 DDL + v13's result_json/confidence/title
// columns, packages/shared-types/src/database.ts) field-for-field.
// `ResearchConfidence` deliberately reuses the exact same three-value
// vocabulary as `ProposalConfidence`/`analysis_predictions.confidence` (low/
// medium/high) - the view layer (Task 4) renders it through the SAME
// CONFIDENCE_LABELS 高/中/低 mapping those other confidence fields already
// use (apps/platform-app/src/reports/conclusion-box.ts), so a fourth
// independent vocabulary here would just be friction.
export type ResearchConfidence = "low" | "medium" | "high";

export type ResearchTaskStatus = "queued" | "running" | "done" | "degraded" | "failed";

export type ResearchVisibility = "private" | "public";

export interface ResearchEvidenceItem {
  ref: string;
  title: string;
  url?: string;
  publisher?: string;
}

export interface ResearchKeyPoint {
  text: string;
  evidenceRefs: string[];
}

export interface ResearchDataTableRow {
  label: string;
  value: string | number;
  source: string;
}

export interface ResearchSkippedStep {
  step: string;
  reason: string;
}

// comparison.theses / comparison.disciplines: the plan's Task 1 line only
// names these two arrays ("对照：theses:[...], disciplines:[...]") without
// pinning a per-item shape - that belongs to Task 2 (research-engine.mjs),
// which owns the actual agree/conflict comparison verdict logic. Left as JsonValue[]
// here rather than guessing ahead of that task's own design.
export interface ResearchComparison {
  theses: JsonValue[];
  disciplines: JsonValue[];
}

// The parsed shape of `research_tasks.result_json` (plan Task 1, verbatim
// field list): the deterministic research pipeline's (Task 2) final,
// conclusion-first write. Every field here is produced by that pipeline, not
// hand-authored - this type only describes the shape once it exists.
export interface ResearchResult {
  conclusion: string;
  confidence: ResearchConfidence;
  keyPoints: ResearchKeyPoint[];
  dataTable: ResearchDataTableRow[];
  comparison: ResearchComparison;
  suggestedAction?: string;
  evidence: ResearchEvidenceItem[];
  skipped: ResearchSkippedStep[];
}

export interface ResearchTask {
  id: string;
  ownerId: string;
  question: string;
  status: ResearchTaskStatus;
  steps: JsonValue[];
  budgetSpent: number;
  resultPath?: string;
  // Parsed research_tasks.result_json - undefined until the task reaches
  // done/degraded (setResult writes it; queued/running rows never have it).
  resultJson?: ResearchResult;
  confidence?: ResearchConfidence;
  title?: string;
  visibility: ResearchVisibility;
  createdAt: string;
  finishedAt?: string;
}

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function assertOrderTicket(value: unknown): asserts value is OrderTicket {
  if (typeof value !== "object" || value === null) {
    throw new Error("Order ticket must be an object.");
  }

  const candidate = value as Partial<OrderTicket>;
  const requiredStrings = [
    candidate.id,
    candidate.source,
    candidate.submittedAt,
    candidate.environment,
    candidate.assetClass,
    candidate.symbol,
    candidate.side
  ];

  if (requiredStrings.some((entry) => typeof entry !== "string")) {
    throw new Error("Order ticket missing required string fields.");
  }

  if (typeof candidate.quantity !== "number" || candidate.quantity <= 0) {
    throw new Error("Order ticket quantity must be a positive number.");
  }

  if (typeof candidate.notionalUsd !== "number" || candidate.notionalUsd <= 0) {
    throw new Error("Order ticket notionalUsd must be a positive number.");
  }

  // Phase 6 Task 4 (2026-07-15 plan): every ticket that reaches this
  // assertion is now built server-side by broker-executor from an approved
  // Proposal (the old caller-supplied `{ ticket }` HTTP body is retired) -
  // ownerId/proposalId are therefore always expected to be present, and a
  // ticket missing either one is a broker-executor construction bug, not a
  // client input error, so it fails loud here rather than silently
  // executing without owner-scoped risk/budget attribution.
  if (typeof candidate.ownerId !== "string" || !candidate.ownerId) {
    throw new Error("Order ticket missing required ownerId.");
  }
  if (typeof candidate.proposalId !== "string" || !candidate.proposalId) {
    throw new Error("Order ticket missing required proposalId.");
  }
}
