// Phase 6 Task 5 (2026-07-15 plan): SINGLE SOURCE OF TRUTH for translating a
// raw Longbridge broker order status string into this codebase's own
// {stage, localStatus} pair. Both broker-executor's longbridge-paper.ts
// (the executor's own order-submission path) and this app's
// reconcile-official-paper-orders.mjs (day-order reconciliation) need the
// EXACT SAME table - a broker status recognized by one side and silently
// mis-mapped (or defaulted to "accepted") by the other is exactly the kind
// of blind spot the audit's reconcile findings (#1/#2/#5/#6) flagged.
//
// DUAL-SIDE-WITH-SHARED-FIXTURE (the P4/P5 precedent - see
// apps/openclaw-config/scripts/conclusion-box.mjs's own doc comment for the
// original model this follows): THIS .mjs file is the canonical
// implementation. apps/openclaw-config/scripts is plain .mjs with no build
// step/dist of its own, so it cannot import anything compiled from
// apps/broker-executor's TS output without adding a cross-app package
// dependency + build-ordering the monorepo doesn't otherwise need (and
// apps/broker-executor is an app, not a shared package - nothing else in
// this repo imports across that particular boundary). Rather than force
// that new coupling, apps/broker-executor/src/broker-status-map.ts is a
// from-scratch, independently-typed PORT of this exact table (not a
// re-export) - the shared fixture at apps/openclaw-config/scripts/
// __fixtures__/broker-status-map-samples.json is read by BOTH sides' test
// suites (broker-status-map.test.ts here, broker-status-map.test.ts in
// apps/broker-executor/src) and asserts they map the exact same input
// status strings to the exact same {stage, localStatus} output - a silent
// drift between the two fails on at least one side.
//
// Longbridge's own status strings are not case-stable across API versions/
// CLI wrappers in practice (this codebase has seen "Filled", "filled", and
// spaced/punctuated variants from different code paths) - normalizeStatus
// lowercases and strips everything but [a-z0-9] so "Wait To Cancel",
// "wait_to_cancel", and "WaitToCancel" all hit the same table key.
function normalizeStatus(status) {
  return String(status ?? "").toLowerCase().replace(/[^a-z0-9]/gu, "");
}

// Every key is a normalizeStatus(...) output. Grouped by local semantic
// bucket. The exact Longbridge enum values the Phase 6 Task 5 deliverable
// calls out by name (Filled/PartialFilled/New/WaitToNew/WaitToSubmit/
// NotReported/Pending/PartialWithdrawal/WaitToCancel/PendingCancel/Canceled/
// Replaced/Rejected/Expired/WaitToDeal) sit alongside the older aliases
// longbridge-paper.ts's PRE-Task-5 inline mapper already handled (kept so
// behavior for those statuses is unchanged - "verify its tests stay green").
const STATUS_TABLE = {
  // ---- broker has acknowledged the order; not yet filled/working --------
  notreported: { stage: "submitted", localStatus: "submitted" },
  waittoreport: { stage: "submitted", localStatus: "submitted" }, // pre-existing alias
  new: { stage: "submitted", localStatus: "submitted" },
  waittonew: { stage: "submitted", localStatus: "submitted" },
  waittosubmit: { stage: "submitted", localStatus: "submitted" },
  submitted: { stage: "submitted", localStatus: "submitted" }, // literal broker string "Submitted"
  replaced: { stage: "submitted", localStatus: "submitted" }, // order amended, still live under new terms

  // ---- actively working / partially done / a cancel is in flight --------
  pending: { stage: "pending", localStatus: "pending" },
  partialfilled: { stage: "pending", localStatus: "pending" },
  partiallyfilled: { stage: "pending", localStatus: "pending" }, // pre-existing alias
  partialdealt: { stage: "pending", localStatus: "pending" }, // pre-existing alias
  waittodeal: { stage: "pending", localStatus: "pending" },
  // Finding-adjacent: WaitToCancel/PendingCancel are a cancel REQUEST in
  // flight, not a completed cancel and not "unknown" - the order is still
  // open (pending), which is exactly what the replay test for
  // "cancel-in-progress" pins down.
  waittocancel: { stage: "pending", localStatus: "pending" },
  pendingcancel: { stage: "pending", localStatus: "pending" },

  // ---- terminal: fully filled --------------------------------------------
  filled: { stage: "filled", localStatus: "accepted" },
  fullfilled: { stage: "filled", localStatus: "accepted" }, // pre-existing alias
  executed: { stage: "filled", localStatus: "accepted" }, // pre-existing alias
  dealt: { stage: "filled", localStatus: "accepted" }, // pre-existing alias

  // ---- terminal: cancelled/withdrawn -------------------------------------
  cancelled: { stage: "cancelled", localStatus: "accepted" },
  canceled: { stage: "cancelled", localStatus: "accepted" }, // Longbridge's own US spelling
  withdrawn: { stage: "cancelled", localStatus: "accepted" }, // pre-existing alias
  deleted: { stage: "cancelled", localStatus: "accepted" }, // pre-existing alias
  // Partial withdrawal = part of the order was cancelled; treated as a
  // cancel variant (a judgment call - there is no dedicated "partially
  // cancelled" stage in this codebase's lifecycle vocabulary).
  partialwithdrawal: { stage: "cancelled", localStatus: "accepted" },

  // ---- terminal: broker refused/expired ----------------------------------
  rejected: { stage: "rejected", localStatus: "rejected" },
  failed: { stage: "rejected", localStatus: "rejected" }, // pre-existing alias
  expired: { stage: "rejected", localStatus: "rejected" }
};

export const BROKER_STATUS_TABLE_KEYS = Object.keys(STATUS_TABLE);

/**
 * @param {string} status raw broker status string, any case/punctuation.
 * @returns {{ stage: string, localStatus: string }}
 */
export function mapBrokerStatusToStage(status) {
  const entry = STATUS_TABLE[normalizeStatus(status)];
  if (entry) {
    return { ...entry };
  }

  // Global Constraint (Phase 6 Task 5 plan, "对账重建规则"): an unrecognized
  // broker status string NEVER silently becomes "accepted" (or any other
  // looks-fine bucket) - it gets its own distinctly-named stage so a
  // human/audit_log entry can spot it, instead of reconciliation quietly
  // treating an unknown order as settled.
  return { stage: "unknown_broker_status", localStatus: "unknown" };
}
