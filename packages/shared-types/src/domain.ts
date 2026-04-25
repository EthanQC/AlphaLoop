import { randomUUID } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type EventType =
  | "news"
  | "price_pulse"
  | "calendar"
  | "manual_note"
  | "system_health";

export type AssetClass = "stock" | "etf" | "option";
export type Environment = "live" | "paper" | "shadow";
export type OrderSide = "buy" | "sell";
export type RiskDecisionStatus = "allow" | "block" | "require_review";
export type QueueStatus = "pending" | "inflight" | "acked" | "dead_letter";
export type OptionStrategy =
  | "long_call"
  | "long_put"
  | "covered_call"
  | "cash_secured_put";
export type EquityAssetClass = "stock" | "etf";

export interface Event {
  id: string;
  type: EventType;
  source: string;
  symbols: string[];
  ts: string;
  payload: JsonValue;
  importance: number;
  dedupeKey: string;
}

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
}

export interface RiskDecision {
  status: RiskDecisionStatus;
  reasons: string[];
  requiresHumanReview: boolean;
}

export interface ExecutionResult {
  ticketId: string;
  environment: Environment;
  status: "accepted" | "rejected" | "simulated";
  provider: "broker-executor" | "longbridge-paper" | "paper-sim" | "options-shadow";
  externalOrderId?: string;
  fillPrice?: number;
  reportId?: string;
  reasons: string[];
}

export interface AdviceCard {
  id: string;
  createdAt: string;
  symbol: string;
  direction: "bullish" | "bearish" | "neutral";
  assetClass: AssetClass;
  thesis: string;
  entryCondition: string;
  suggestedSizePercent: number;
  invalidation: string;
  exitPlan: string;
  riskNotes: string[];
  preferenceAlignment: string;
  ruleDelta?: string;
}

export interface ApprovalEdit {
  id: string;
  adviceCardId: string;
  createdAt: string;
  editor: string;
  summary: string;
  diff: JsonValue;
}

export interface PreferenceSnapshot {
  id: string;
  createdAt: string;
  source: string;
  summary: string;
  traits: string[];
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

export interface RuleProposal {
  id: string;
  createdAt: string;
  scope: "live" | "paper";
  currentVersion: string;
  candidateVersion: string;
  summary: string;
  oldVsNew: string[];
  evidence: string[];
  recommendation: "promote" | "hold";
}

export interface ExecutionReport {
  id: string;
  category: "trade" | "daily" | "weekly";
  title: string;
  body: string;
  metadata: Record<string, JsonValue>;
  createdAt: string;
}

export interface QueueRecord<T = JsonValue> {
  id: number;
  topic: string;
  payload: T;
  status: QueueStatus;
  consumer?: string;
  leaseUntil?: number;
  attempts: number;
  availableAt: number;
  createdAt: number;
  updatedAt: number;
  dedupeKey?: string;
  lastError?: string;
}

export interface ShadowPosition {
  id: string;
  strategy: OptionStrategy;
  symbol: string;
  contract: OptionContract;
  quantity: number;
  avgPrice: number;
  status: "open" | "closed" | "assigned" | "expired";
  realizedPnl: number;
  createdAt: string;
  updatedAt: string;
}

export interface PaperPosition {
  id: string;
  symbol: string;
  assetClass: EquityAssetClass;
  quantity: number;
  avgPrice: number;
  status: "open" | "closed";
  realizedPnl: number;
  createdAt: string;
  updatedAt: string;
}

export interface HonchoMemoryDocument {
  namespace: string;
  category: "preference" | "approval_pattern" | "style" | "watchlist";
  content: string;
  createdAt: string;
  tags: string[];
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

export function assertEvent(value: unknown): asserts value is Event {
  if (typeof value !== "object" || value === null) {
    throw new Error("Event payload must be an object.");
  }

  const candidate = value as Partial<Event>;
  if (typeof candidate.id !== "string" || typeof candidate.type !== "string") {
    throw new Error("Event must include string id and type.");
  }

  if (!Array.isArray(candidate.symbols)) {
    throw new Error("Event symbols must be an array.");
  }
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
}
