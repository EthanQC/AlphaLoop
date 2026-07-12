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
// `value` is a decimal ratio (e.g. -0.043 = -4.3%). Exposure fires are
// portfolio-level, not per-symbol: they always carry symbol === '*' (see
// market-alerts.mjs's EXPOSURE_SYMBOL convention) and render a different,
// shorter line shape with no time/symbol/position clause (see
// composeAlertLine below) - only a real per-symbol fire can show a position.
//
// positionsByOwner shape: Record<ownerId, Record<symbol, { quantity, price }>>
// - the caller's best-known current quantity/price for that owner+symbol
// (e.g. sourced from the same sample.positions/sample.quotes fed into
// evaluateAll for this poll cycle). A missing owner, missing symbol, or a
// non-finite quantity/price degrades gracefully (see composeAlertLine)
// instead of ever printing NaN - per the task brief, omit the affected
// clause rather than guess.
import { sendInteractiveCard } from "../../../packages/shared-types/dist/index.js";
import { updateEventMessageId } from "./market-alerts-store.mjs";
import { getZonedParts } from "./trading-schedule.mjs";

const RULE_TYPE_LABEL = {
  daily_move: "日内",
  unrealized_pnl: "浮动盈亏",
  spike_5m: "5分钟"
};

const EXPOSURE_SYMBOL = "*";
const FOOTER_LINE = "详情见今日日报（站点上线后将直达）";

/**
 * Group fires by owner and render one InteractiveCard per owner for this
 * poll cycle. Owners with no feishuOpenId on file are skipped (and the skip
 * is reported to stderr) rather than silently dropped or thrown on - a
 * member without a linked Feishu account simply has no delivery channel yet.
 *
 * @param {object[]} fires see module header for the required shape
 * @param {Record<string, {feishuOpenId?: string}>} memberById
 * @param {Record<string, Record<string, {quantity?: number, price?: number}>>} positionsByOwner
 * @returns {Array<{ownerId: string, openId: string, card: object, eventIds: string[]}>}
 */
export function composeAlertCards(fires, memberById, positionsByOwner) {
  const firesByOwner = new Map();
  for (const fire of fires ?? []) {
    const list = firesByOwner.get(fire.ownerId) ?? [];
    list.push(fire);
    firesByOwner.set(fire.ownerId, list);
  }

  const batches = [];
  for (const [ownerId, ownerFires] of firesByOwner) {
    const openId = memberById?.[ownerId]?.feishuOpenId;
    if (!openId) {
      console.error(
        `market-alerts-cards: skipping owner ${ownerId} - no feishuOpenId on file (${ownerFires.length} fire(s) will not be delivered this cycle).`
      );
      continue;
    }

    const positions = positionsByOwner?.[ownerId] ?? {};
    const lines = ownerFires.map((fire) => composeAlertLine(fire, positions));

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

  return batches;
}

/**
 * Deliver each composed card via the P1 sendInteractiveCard capability and
 * backfill message_id onto every event in the batch on success.
 *
 * Delivery failure (transport returns ok:false, or throws) is logged to
 * stderr and otherwise swallowed: it does NOT throw, and the affected
 * events are left with message_id = NULL. There is deliberately no retry
 * here - the next poll cycle continues naturally and produces fresh fires,
 * so retrying a stale card would risk an alert storm on a transient outage
 * instead of just quietly moving on (see task-p2-5-brief.md).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{ownerId: string, openId?: string, card: object, eventIds?: string[]}>} cardBatches
 * @param {import('../../../packages/shared-types/dist/index.js').CardTransport} [transport]
 * @returns {Promise<{sent: number, failed: number, skipped: number}>}
 */
export async function deliverAlertCards(db, cardBatches, transport) {
  const summary = { sent: 0, failed: 0, skipped: 0 };

  for (const batch of cardBatches ?? []) {
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
        updateEventMessageId(db, eventId, result.messageId);
      }
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Line rendering
// ---------------------------------------------------------------------------

function composeAlertLine(fire, positions) {
  if (fire.symbol === EXPOSURE_SYMBOL) {
    return `组合敞口 ${formatUnsignedPercent(fire.value)}（预算 ${formatTrimmedPercent(fire.threshold)}%）`;
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

  const amount = Math.round(quantity * price * Math.abs(fire.value));
  const sign = fire.value >= 0 ? "+" : "-";
  // Thousands-separated per this codebase's existing dollar-formatting
  // convention (see scheduled-report.mjs's formatNumber) - a large position
  // impact should read as "$12,340", not "$12340".
  return `${base}${holdingClause} · 影响 ${sign}$${amount.toLocaleString("en-US")}`;
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
