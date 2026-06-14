import { randomUUID } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type AssetClass = "stock" | "etf" | "option";
export type Environment = "live" | "paper" | "shadow";
export type OrderSide = "buy" | "sell";
export type RiskDecisionStatus = "allow" | "block" | "require_review";
export type ExecutionResultStatus = "accepted" | "rejected" | "submitted" | "pending";
export type OfficialPaperOrderLifecycleStage =
  | "submitted"
  | "pending"
  | "filled"
  | "cancelled"
  | "rejected"
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
  externalOrderId: string;
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
}
