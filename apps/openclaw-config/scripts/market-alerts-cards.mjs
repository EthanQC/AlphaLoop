// Alert card composition and delivery for the market-alerts polling loop.
//
// composeAlertCards is a PURE function (no IO), matching
// market-alerts-engine.mjs's zero-IO design so it stays trivially testable.
// Its `fires` parameter is NOT the bare object evaluateAll returns - see that
// module's documented `results`/`fires` shape
// (`{ ruleId, ownerId, symbol, ruleType, decision, reason, value, triggeredAt }`).
// The (not-yet-written, P2-T6) poller must enrich each fire with two extra
// fields this module needs but the engine has no way to produce:
//
//   - `eventId`: the id assigned by market-alerts-store's recordEvents() for
//     this exact fire. recordEvents is called with the evaluateAll fires
//     array and returns `created` in the same order, so the poller zips
//     `created[i].id` back onto `fires[i]` before calling composeAlertCards.
//     This id is what deliverAlertCards later backfills message_id onto.
//   - `threshold`: the alert_rules row's configured threshold (decimal
//     ratio, e.g. 0.04) for the rule that fired - needed to render the
//     "（阈值 ±4%）" / "（预算 10%）" clause. evaluateAll's bare fire objects
//     don't carry it, and this module deliberately has no rules/ruleById
//     parameter of its own, so the poller (which already has the rules list
//     it fed into evaluateAll) attaches `rule.threshold` per ruleId.
//
// Full expected shape per entry in `fires`:
//   { ruleId, ownerId, symbol, ruleType, value, triggeredAt, threshold, eventId }
//
// This extended contract (beyond what evaluateAll emits) is enforced at the
// top of composeAlertCards, not just documented: every fire must carry a
// finite `threshold` and a non-empty `eventId`, or composeAlertCards throws
// naming the offending ruleId/field. A wiring bug in the not-yet-written
// poller (forgetting to zip one of these on) is a programmer error, not a
// data outage, and must fail loud at the seam instead of quietly rendering
// "（阈值 ±NaN%）" to a user or silently no-oping the message_id backfill
// while `sent` still increments. This is distinct from - and does not
// change - the graceful-degradation behavior for genuinely missing MARKET
// data (a missing position/price for a real per-symbol fire just omits the
// 影响/持仓 clause; see composeAlertLine below).
//
// `value` is a decimal ratio (e.g. -0.043 = -4.3%). Exposure fires are
// portfolio-level, not per-symbol: they always carry symbol === EXPOSURE_SYMBOL
// (imported from market-alerts-engine.mjs, which both this module and
// market-alerts.mjs the rule CLI already import - single source of truth so
// the two can't drift on the sentinel value) and render a different,
// shorter line shape with no symbol/position clause, but still the same
// leading time-of-day prefix as every other line (see composeAlertLine
// below) - only a real per-symbol fire can show a position.
//
// `positions` shape: Record<symbol, { quantity, price }> - note this is
// flat by symbol, NOT nested by ownerId. There is exactly one shared
// Longbridge paper-trading account behind this whole system (see
// official-paper-monitor.mjs - it has no owner/member concept at all), so
// "the position in NVDA" is the same fact regardless of which member's
// alert rule fired on it; there is no such thing as a per-owner position
// here to nest by. Use the exported `buildPositionsForCards(sample)` helper
// to construct this shape directly from the same sample.positions/
// sample.quotes fed into evaluateAll for this poll cycle - it is the one
// obvious right way for the poller to wire this parameter, so a caller
// never has to (mis)guess the shape by hand. A missing symbol, or a
// non-finite quantity/price, degrades gracefully (see composeAlertLine)
// instead of ever printing NaN - per the task brief, omit the affected
// clause rather than guess.
import { sendInteractiveCard } from "../../../packages/shared-types/dist/index.js";
import { EXPOSURE_SYMBOL } from "./market-alerts-engine.mjs";
import { updateEventMessageId } from "./market-alerts-store.mjs";
import { getZonedParts } from "./trading-schedule.mjs";

const RULE_TYPE_LABEL = {
  daily_move: "日内",
  unrealized_pnl: "浮动盈亏",
  spike_5m: "5分钟"
};

const FOOTER_LINE = "详情见今日日报（站点上线后将直达）";

/**
 * Group fires by owner and render one InteractiveCard per owner for this
 * poll cycle. This is a PURE function - no IO, including no console.error;
 * see deliverAlertCards for where the skip is actually logged. Owners with
 * no feishuOpenId on file are reported in the returned `skipped` array
 * rather than silently dropped - a member without a linked Feishu account
 * simply has no delivery channel yet, but that fact must be countable by
 * the caller, not swallowed here.
 *
 * Every fire's extended contract (`threshold`, `eventId` - see module
 * header) is validated up front: a fire missing either throws, naming the
 * offending ruleId/field. That is a wiring bug in the caller, not bad
 * market data, so it must fail loud instead of degrading into a NaN clause
 * or a silently-dropped message_id backfill.
 *
 * @param {object[]} fires see module header for the required shape
 * @param {Record<string, {feishuOpenId?: string}>} memberById
 * @param {Record<string, {quantity?: number, price?: number}>} positions flat by symbol - see module header; build via buildPositionsForCards(sample)
 * @returns {{
 *   batches: Array<{ownerId: string, openId: string, card: object, eventIds: string[]}>,
 *   skipped: Array<{ownerId: string, reason: "no_open_id", eventIds: string[]}>
 * }}
 */
export function composeAlertCards(fires, memberById, positions) {
  for (const fire of fires ?? []) {
    assertValidFire(fire);
  }

  const firesByOwner = new Map();
  for (const fire of fires ?? []) {
    const list = firesByOwner.get(fire.ownerId) ?? [];
    list.push(fire);
    firesByOwner.set(fire.ownerId, list);
  }

  const batches = [];
  const skipped = [];
  for (const [ownerId, ownerFires] of firesByOwner) {
    const openId = memberById?.[ownerId]?.feishuOpenId;
    if (!openId) {
      skipped.push({
        ownerId,
        reason: "no_open_id",
        eventIds: ownerFires.map((fire) => fire.eventId)
      });
      continue;
    }

    const lines = ownerFires.map((fire) => composeAlertLine(fire, positions ?? {}));

    batches.push({
      ownerId,
      openId,
      card: {
        title: `盘中提醒 ${ownerFires.length} 条`,
        lines: [...lines, FOOTER_LINE]
      },
      eventIds: ownerFires.map((fire) => fire.eventId)
    });
  }

  return { batches, skipped };
}

// Enforces the extended fire contract documented in the module header
// (`threshold`, `eventId` beyond what evaluateAll emits) for every fire,
// exposure included - the exposure line's "（预算 ±NaN%）" clause is exactly
// as user-visible a failure as a per-symbol fire's "（阈值 ±NaN%）" one, so
// both need the same guard. Throws (rather than skipping/omitting) because
// this is a programmer error in the caller's wiring, not missing market
// data - see the module header's graceful-degradation-is-for-MARKET-data-only
// distinction.
function assertValidFire(fire) {
  const ruleId = fire?.ruleId ?? "(unknown rule)";
  if (typeof fire?.eventId !== "string" || fire.eventId.length === 0) {
    throw new Error(
      `composeAlertCards: fire for rule ${ruleId} is missing a valid eventId - the caller must zip market-alerts-store's recordEvents() created[i].id onto this fire before calling composeAlertCards (see module header).`
    );
  }
  if (!Number.isFinite(fire?.threshold)) {
    throw new Error(
      `composeAlertCards: fire for rule ${ruleId} is missing a finite threshold - the caller must attach the alert_rules row's threshold onto this fire before calling composeAlertCards (see module header).`
    );
  }
}

/**
 * Deliver each composed card via the P1 sendInteractiveCard capability and
 * backfill message_id onto every event in the batch on success. Also counts
 * (and logs to stderr - this is the IO function, unlike composeAlertCards)
 * the owners composeAlertCards already decided to skip for lack of a
 * feishuOpenId, so they land in the same `skipped` total returned here.
 *
 * Takes composeAlertCards' full return value directly ({ batches, skipped })
 * rather than a bare batches array plus a separate skipped count - the two
 * functions are meant to be chained (`deliverAlertCards(db,
 * composeAlertCards(fires, memberById, positions), transport)`), so threading
 * the same shape through both is the one obvious way to wire them, with no
 * separate count parameter to get out of sync with the array it summarizes.
 *
 * Delivery failure (transport returns ok:false, or throws) is logged to
 * stderr and otherwise swallowed: it does NOT throw, and the affected
 * events are left with message_id = NULL. There is deliberately no retry
 * here - the next poll cycle continues naturally and produces fresh fires,
 * so retrying a stale card would risk an alert storm on a transient outage
 * instead of just quietly moving on (see task-p2-5-brief.md).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   batches: Array<{ownerId: string, openId?: string, card: object, eventIds?: string[]}>,
 *   skipped?: Array<{ownerId: string, reason: string, eventIds: string[]}>
 * }} composed composeAlertCards' return value
 * @param {import('../../../packages/shared-types/dist/index.js').CardTransport} [transport]
 * @returns {Promise<{sent: number, failed: number, skipped: number}>}
 */
export async function deliverAlertCards(db, composed, transport) {
  // Same fail-loud-on-a-wiring-bug rule as composeAlertCards' fire validation:
  // handed a bare array (this function's pre-fix signature) or anything else
  // without a `batches` array, we would otherwise destructure to undefined and
  // return a zeroed, success-looking {sent:0, failed:0, skipped:0} summary
  // while silently delivering nothing at all. Throw instead of quietly
  // reporting a clean no-op.
  if (!composed || !Array.isArray(composed.batches)) {
    throw new Error(
      `deliverAlertCards: expected composeAlertCards' { batches, skipped } return value, got ${Array.isArray(composed) ? "a bare array (the pre-fix signature)" : JSON.stringify(composed)} - pass the composed object straight through (see module header).`
    );
  }

  const { batches, skipped } = composed;
  const summary = { sent: 0, failed: 0, skipped: 0 };

  for (const entry of skipped ?? []) {
    summary.skipped += 1;
    console.error(
      `market-alerts-cards: skipping owner ${entry.ownerId} - no feishuOpenId on file (${entry.eventIds.length} fire(s) will not be delivered this cycle).`
    );
  }

  for (const batch of batches ?? []) {
    if (!batch?.openId || !Array.isArray(batch.eventIds) || batch.eventIds.length === 0) {
      summary.skipped += 1;
      console.error(
        `market-alerts-cards: skipping malformed card batch for owner ${batch?.ownerId ?? "unknown"} - missing openId or eventIds.`
      );
      continue;
    }

    const result = await sendInteractiveCard(batch.card, { openId: batch.openId }, transport);
    if (!result.ok) {
      summary.failed += 1;
      console.error(
        `market-alerts-cards: card delivery failed for owner ${batch.ownerId} (${batch.eventIds.length} event(s) left without message_id, no retry this cycle): ${result.error ?? "unknown error"}`
      );
      continue;
    }

    summary.sent += 1;
    // A successful send without a parsed messageId (see notifications.ts'
    // sendInteractiveCard) still counts as sent - there's just nothing to
    // backfill onto alert_events for later feedback correlation.
    if (result.messageId) {
      for (const eventId of batch.eventIds) {
        // Item 2 (task P2.5 Task 6): the card has ALREADY been sent
        // successfully by this point - a DB error backfilling message_id
        // (e.g. lock contention) is a bookkeeping failure, not a delivery
        // failure, and must never be allowed to escape this loop and abort
        // the REMAINING owners' batches in this same cycle (whose sends
        // haven't even been attempted yet). Logged and swallowed, same
        // no-retry-this-cycle philosophy as a transport failure above.
        try {
          updateEventMessageId(db, eventId, result.messageId);
        } catch (error) {
          console.error(
            `market-alerts-cards: failed to backfill message_id for event ${eventId} (card was already sent - still counts as sent): ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  }

  return summary;
}

/**
 * Build composeAlertCards' `positions` argument directly from the same
 * sample the poller already fed into evaluateAll this poll cycle - see the
 * module header for why this is flat by symbol rather than nested by owner.
 * `quantity` comes from sample.positions (the shared Longbridge account's
 * holding), `price` from sample.quotes (that account's latest quote) - the
 * two live in separate top-level sample fields upstream (see
 * market-alerts-engine.mjs's documented sample shape) and are merged here
 * per symbol so composeAlertLine only has one shape to read from.
 *
 * @param {{
 *   positions?: Record<string, {quantity?: number}>,
 *   quotes?: Record<string, {price?: number}>
 * }} sample
 * @returns {Record<string, {quantity?: number, price?: number}>}
 */
export function buildPositionsForCards(sample) {
  const enginePositions = sample?.positions ?? {};
  const quotes = sample?.quotes ?? {};
  const symbols = new Set([...Object.keys(enginePositions), ...Object.keys(quotes)]);

  const positions = {};
  for (const symbol of symbols) {
    positions[symbol] = {
      quantity: enginePositions[symbol]?.quantity,
      price: quotes[symbol]?.price
    };
  }
  return positions;
}

// ---------------------------------------------------------------------------
// Line rendering
// ---------------------------------------------------------------------------

function composeAlertLine(fire, positions) {
  if (fire.symbol === EXPOSURE_SYMBOL) {
    // Portfolio-level fires drop the (meaningless) symbol but keep the same
    // leading time-of-day prefix as every other line - only the SYMBOL is
    // exposure-specific, not the timestamp.
    const hhmm = formatShanghaiTime(fire.triggeredAt);
    return `${hhmm} 组合敞口 ${formatUnsignedPercent(fire.value)}（预算 ${formatTrimmedPercent(fire.threshold)}%）`;
  }

  const hhmm = formatShanghaiTime(fire.triggeredAt);
  const label = RULE_TYPE_LABEL[fire.ruleType] ?? fire.ruleType;
  const symbol = formatDisplaySymbol(fire.symbol);
  const base = `${hhmm} ${symbol} ${label} ${formatSignedPercent(fire.value)}（阈值 ±${formatTrimmedPercent(fire.threshold)}%）`;

  const position = positions?.[fire.symbol];
  const quantity = position?.quantity;
  if (!Number.isFinite(quantity)) {
    return base;
  }
  // No space between the threshold clause's closing "）" and this "·" - the
  // task brief's own example line has none there (while every other "·"
  // junction in the line is space-padded); matched literally rather than
  // "cleaned up" to a uniform delimiter.
  const holdingClause = `· 持仓 ${Math.round(quantity)} 股`;

  const price = position?.price;
  if (!Number.isFinite(price)) {
    return `${base}${holdingClause}`;
  }

  // `quantity` can be negative (a short position). The sign of the dollar
  // impact must come from `value * quantity` together, not from `value`
  // alone - a short position gains on a down move, so a negative quantity
  // flips the sign back to "+". The magnitude is the abs() of the full
  // product (quantity * price * value); computing it as
  // `quantity * price * Math.abs(value)` instead would leave a short
  // position's magnitude negative and render a double-negative
  // "影响 -$-43" once prefixed with `sign`.
  const magnitude = Math.round(Math.abs(quantity * price * fire.value));
  const sign = fire.value * quantity >= 0 ? "+" : "-";
  // Thousands-separated per this codebase's existing dollar-formatting
  // convention (see scheduled-report.mjs's formatNumber) - a large position
  // impact should read as "$12,340", not "$12340".
  return `${base}${holdingClause} · 影响 ${sign}$${magnitude.toLocaleString("en-US")}`;
}

function formatShanghaiTime(iso) {
  const { hour, minute } = getZonedParts(new Date(iso), "Asia/Shanghai");
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// Strips a dotted exchange suffix (e.g. "NVDA.US" -> "NVDA") for the
// user-facing card copy, mirroring the suffix pattern report-data.mjs's
// normalizeSymbol uses to detect an already-suffixed symbol. A bare symbol
// with no such suffix passes through unchanged.
function formatDisplaySymbol(symbol) {
  return String(symbol ?? "").replace(/\.[A-Z]{2,4}$/u, "");
}

// Main move value: always shown with 1 decimal and an explicit "+" for a
// non-negative value (toFixed already supplies "-" for a negative one),
// e.g. -0.043 -> "-4.3%", 0.03 -> "+3.0%".
function formatSignedPercent(ratio) {
  const pct = ratio * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

// Exposure's ratio is one-sided (over-budget only, never negative) - shown
// unsigned, e.g. 0.104 -> "10.4%".
function formatUnsignedPercent(ratio) {
  return `${(ratio * 100).toFixed(1)}%`;
}

// Threshold/budget clauses use the rule's configured spec constant, which is
// normally a clean number (0.04, 0.06, 0.025, 0.10) - trim a trailing ".0"
// rather than force 1 decimal everywhere, e.g. 0.04 -> "4", 0.025 -> "2.5".
function formatTrimmedPercent(ratio) {
  return `${Number((ratio * 100).toFixed(1))}`;
}
