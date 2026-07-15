import type { OfficialPaperOrderLifecycleStage } from "@packages/shared-types";

/**
 * TS port of apps/openclaw-config/scripts/broker-status-map.mjs's
 * `mapBrokerStatusToStage` (Phase 6 Task 5, 2026-07-15 plan). That .mjs file
 * is the SINGLE canonical source of truth for translating a raw Longbridge
 * broker order status string into this codebase's {stage, localStatus}
 * pair - see its own doc comment for why this is a from-scratch
 * re-implementation rather than a cross-app import: apps/openclaw-config is
 * plain .mjs with no build step/dist of its own, so it cannot depend on
 * anything compiled out of this TS app without adding a cross-app package
 * dependency + build-ordering the monorepo doesn't otherwise need. This
 * codebase's established convention for exactly this situation (P4/P5's
 * conclusion-box.mjs/.ts pair) is a from-scratch port plus a shared-fixture
 * parity test, not reaching across the app boundary.
 *
 * Consumer: longbridge-paper.ts's own exported `mapBrokerStatusToStage`
 * keeps its PRE-Task-5 bare-stage-string return shape (its existing tests
 * assert `mapBrokerStatusToStage("Pending")).toBe("pending")` etc. - a bare
 * string, not this module's `{stage, localStatus}` object) and now delegates
 * to this module for the actual table, rather than its own inline copy.
 *
 * ANTI-DRIFT: any change to the status table (a new Longbridge status, or a
 * changed stage/localStatus for an existing one) MUST be mirrored in the
 * .mjs file above (or vice versa). The shared fixture at
 * apps/openclaw-config/scripts/__fixtures__/broker-status-map-samples.json
 * is read by BOTH sides' test suites (broker-status-map.test.ts here and
 * there) and asserts they map the exact same input status strings to the
 * exact same output - that test is the enforcement mechanism for this
 * comment, not just documentation of intent.
 */

// Deliberately NOT `ExecutionResultStatus` (which has no "unknown" member) -
// an unrecognized broker status must be representable without either
// widening that shared type for every OTHER caller or lying about certainty
// by picking one of its existing members.
export type BrokerStatusLocalStatus = "accepted" | "rejected" | "submitted" | "pending" | "unknown";

export interface BrokerStatusMapping {
  stage: OfficialPaperOrderLifecycleStage;
  localStatus: BrokerStatusLocalStatus;
}

function normalizeStatus(status: string): string {
  return String(status ?? "").toLowerCase().replace(/[^a-z0-9]/gu, "");
}

const STATUS_TABLE: Record<string, BrokerStatusMapping> = {
  // ---- broker has acknowledged the order; not yet filled/working --------
  notreported: { stage: "submitted", localStatus: "submitted" },
  waittoreport: { stage: "submitted", localStatus: "submitted" },
  new: { stage: "submitted", localStatus: "submitted" },
  waittonew: { stage: "submitted", localStatus: "submitted" },
  waittosubmit: { stage: "submitted", localStatus: "submitted" },
  submitted: { stage: "submitted", localStatus: "submitted" },
  replaced: { stage: "submitted", localStatus: "submitted" },

  // ---- actively working / partially done / a cancel is in flight --------
  pending: { stage: "pending", localStatus: "pending" },
  partialfilled: { stage: "pending", localStatus: "pending" },
  partiallyfilled: { stage: "pending", localStatus: "pending" },
  partialdealt: { stage: "pending", localStatus: "pending" },
  waittodeal: { stage: "pending", localStatus: "pending" },
  waittocancel: { stage: "pending", localStatus: "pending" },
  pendingcancel: { stage: "pending", localStatus: "pending" },

  // ---- terminal: fully filled --------------------------------------------
  filled: { stage: "filled", localStatus: "accepted" },
  fullfilled: { stage: "filled", localStatus: "accepted" },
  executed: { stage: "filled", localStatus: "accepted" },
  dealt: { stage: "filled", localStatus: "accepted" },

  // ---- terminal: cancelled/withdrawn -------------------------------------
  cancelled: { stage: "cancelled", localStatus: "accepted" },
  canceled: { stage: "cancelled", localStatus: "accepted" },
  withdrawn: { stage: "cancelled", localStatus: "accepted" },
  deleted: { stage: "cancelled", localStatus: "accepted" },
  partialwithdrawal: { stage: "cancelled", localStatus: "accepted" },

  // ---- terminal: broker refused/expired ----------------------------------
  rejected: { stage: "rejected", localStatus: "rejected" },
  failed: { stage: "rejected", localStatus: "rejected" },
  expired: { stage: "rejected", localStatus: "rejected" }
};

export function mapBrokerStatusToStage(status: string): BrokerStatusMapping {
  const entry = STATUS_TABLE[normalizeStatus(status)];
  if (entry) {
    return { ...entry };
  }

  // NEVER silently "accepted" - an unrecognized status gets its own
  // distinctly-named stage so it surfaces in audit_log instead of being
  // quietly treated as settled.
  return { stage: "unknown_broker_status", localStatus: "unknown" };
}
