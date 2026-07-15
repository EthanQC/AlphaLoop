// 熔断引擎 (Phase 6 Task 2, 2026-07-15 plan): per-owner circuit breaker on top
// of schema v10's `circuit_breaker_state` table (packages/shared-types/src/
// database.ts's CircuitBreakerRepository, Task 1). A trip persists across
// process restarts BY CONSTRUCTION - it is a plain DB row, not in-memory
// state, so a new db connection reading the same file sees the same pause
// (pinned by this module's own test: "trip persists across a new db
// connection").
//
// Plan Global Constraint: per-owner weekly loss > 3% -> new proposal
// generation paused for 7 days; the pause survives restarts; while paused,
// generation requests are rejected with an explanation (assertProposalAllowed
// below) - this is the gate Task 3's `proposals.mjs create` flow calls FIRST,
// before evaluateDiscipline (discipline-engine.mjs).

import { CircuitBreakerRepository } from "../../../packages/shared-types/dist/index.js";
import { currentUsEasternTradingWeek } from "./trading-schedule.mjs";

// Mirrors official-paper-monitor.mjs's SHARED_OWNER_SENTINEL / apps/
// platform-app/src/data/snapshots.ts's SHARED_OWNER_SENTINEL constant - the
// owner_id written to a snapshot that can't be attributed to exactly one
// active member.
const SHARED_OWNER_SENTINEL = "__shared__";

const WEEKLY_LOSS_TRIP_THRESHOLD = -0.03;
const PAUSE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function toDate(now) {
  return now instanceof Date ? now : new Date(now);
}

function toIso(now) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

// Re-implements apps/platform-app/src/data/snapshots.ts's
// `loadSnapshotSeriesForOwner` OWN-ROWS-ELSE-FALLBACK precedence rule
// (see that file's header/doc comments) directly in SQL, rather than
// importing it: that module is platform-app's TypeScript, compiled by its
// own build and not reachable from this package's plain-Node .mjs script
// layer. The rule, verbatim: the owner's OWN row(s) win even if older than
// every other row; the NULL/`'__shared__'` fallback set (no single
// attributable owner) is used ONLY when the owner has ZERO own rows at all -
// own and fallback sets are never mixed into one series.
//
// Bounded to `fetched_at <= nowIso` so callers (and tests) can evaluate "as
// of a given now" without future-dated fixture rows leaking into the series.
// Returns rows ascending by fetched_at (oldest first) - the order the loss
// scan below wants.
function loadOwnerNetAssetsSeries(db, ownerId, nowIso) {
  const ownRows = db
    .prepare(`
      SELECT fetched_at, net_assets FROM official_paper_snapshots
      WHERE owner_id = ? AND fetched_at <= ?
      ORDER BY fetched_at ASC
    `)
    .all(ownerId, nowIso);

  const rows = ownRows.length > 0
    ? ownRows
    : db
        .prepare(`
          SELECT fetched_at, net_assets FROM official_paper_snapshots
          WHERE (owner_id IS NULL OR owner_id = ?) AND fetched_at <= ?
          ORDER BY fetched_at ASC
        `)
        .all(SHARED_OWNER_SENTINEL, nowIso);

  return rows.map((row) => ({
    fetchedAt: String(row.fetched_at),
    netAssets: row.net_assets === null || row.net_assets === undefined ? null : Number(row.net_assets)
  }));
}

/**
 * Weekly loss ratio (e.g. -0.035 for a 3.5% loss) for `ownerId` as of `now`:
 * `(latest - baseline) / baseline`, where:
 *   - `baseline` = the most recent usable snapshot STRICTLY BEFORE this
 *     trading week's Monday 00:00 America/New_York (see trading-schedule.mjs's
 *     `currentUsEasternTradingWeek` for the DST-aware week-start computation);
 *     when no such pre-week snapshot exists, `baseline` falls back to the
 *     EARLIEST usable snapshot within the week.
 *   - `latest` = the most recent usable snapshot at or before `now`.
 * "Usable" excludes null/non-finite `net_assets` (a degraded/missing-value
 * snapshot must never silently feed a loss computation).
 *
 * Returns `null` (never a fabricated number) when fewer than 2 usable points
 * exist in the owner's series, or when `baseline.netAssets` is 0 (a percent
 * change off a zero base is not expressible) - callers (checkAndTripCircuit)
 * treat `null` as "cannot evaluate, do not trip".
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} ownerId
 * @param {Date} [now]
 * @returns {number|null}
 */
export function computeWeeklyLoss(db, ownerId, now = new Date()) {
  const nowDate = toDate(now);
  const nowIso = toIso(nowDate);
  const { weekStartUtcIso } = currentUsEasternTradingWeek(nowDate);

  const series = loadOwnerNetAssetsSeries(db, ownerId, nowIso);
  const usable = series.filter((point) => point.netAssets !== null && Number.isFinite(point.netAssets));

  if (usable.length < 2) {
    return null;
  }

  const preWeek = usable.filter((point) => point.fetchedAt < weekStartUtcIso);
  const baseline = preWeek.length > 0
    ? preWeek[preWeek.length - 1]
    : usable.find((point) => point.fetchedAt >= weekStartUtcIso);
  const latest = usable[usable.length - 1];

  if (!baseline || baseline.netAssets === 0) {
    return null;
  }

  const loss = (latest.netAssets - baseline.netAssets) / baseline.netAssets;
  return Number.isFinite(loss) ? loss : null;
}

/**
 * Evaluates and (if warranted) trips `ownerId`'s circuit breaker as of `now`.
 * Three mutually exclusive outcomes:
 *   - already paused (still within a prior trip's window) -> `{paused: true, until}`,
 *     WITHOUT re-tripping (pausedUntil/reason/weeklyLossPct are left untouched -
 *     see this module's "already-paused does not re-trip" test);
 *   - weekly loss computable AND < -3% AND not currently paused -> trips
 *     (pausedUntil = now + 7 days) and returns `{tripped: true, card}`, `card`
 *     being a ready-to-render Feishu-card-shaped `{title, lines}` (Task 3
 *     wires this into the actual card send);
 *   - otherwise -> `{ok: true}`.
 *
 * Clears an already-expired pause row first (best-effort hygiene - an
 * expired row is already treated as "not paused" by `isPaused`'s own
 * `paused_until > now` check regardless, but leaving it around would
 * misreport the owner's last trip indefinitely to anything reading
 * `getState()` directly - same rationale as `CircuitBreakerRepository
 * .clearIfExpired`'s own doc comment).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} ownerId
 * @param {Date} [now]
 */
export function checkAndTripCircuit(db, ownerId, now = new Date()) {
  const nowDate = toDate(now);
  const nowIso = toIso(nowDate);
  const repo = new CircuitBreakerRepository(db);

  repo.clearIfExpired(ownerId, nowIso);

  if (repo.isPaused(ownerId, nowIso)) {
    const state = repo.getState(ownerId);
    return { paused: true, until: state ? state.pausedUntil : null };
  }

  const weeklyLoss = computeWeeklyLoss(db, ownerId, nowDate);
  if (weeklyLoss !== null && weeklyLoss < WEEKLY_LOSS_TRIP_THRESHOLD) {
    const pausedUntil = new Date(nowDate.getTime() + PAUSE_DURATION_MS).toISOString();
    const weeklyLossPct = weeklyLoss * 100;
    const lossPctText = weeklyLossPct.toFixed(2);
    const reason = `本交易周亏损 ${lossPctText}%，超过熔断阈值 -3%`;

    repo.trip(ownerId, { pausedUntil, reason, weeklyLossPct });

    return {
      tripped: true,
      card: {
        title: "⛔ 熔断触发",
        lines: [
          `本交易周亏损 ${lossPctText}%，已触发熔断（阈值 -3%）。`,
          `新提案生成已暂停至 ${pausedUntil}。`,
          "暂停期间不会生成新的交易提案。"
        ]
      }
    };
  }

  return { ok: true };
}

/**
 * Gate called before a proposal is generated (Task 3's `proposals.mjs
 * create` flow, FIRST in the sequence, per the plan's Global Constraint).
 * Clears an already-expired pause first, then throws a Chinese error
 * (including the recovery time) if `ownerId` is still paused; otherwise
 * returns normally.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} ownerId
 * @param {Date} [now]
 */
export function assertProposalAllowed(db, ownerId, now = new Date()) {
  const nowIso = toIso(now);
  const repo = new CircuitBreakerRepository(db);

  repo.clearIfExpired(ownerId, nowIso);

  if (repo.isPaused(ownerId, nowIso)) {
    const state = repo.getState(ownerId);
    const until = state ? state.pausedUntil : "未知时间";
    throw new Error(`熔断暂停中：新提案生成已暂停，将于 ${until} 恢复。`);
  }
}
