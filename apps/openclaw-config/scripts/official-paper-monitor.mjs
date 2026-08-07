#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  REPORT_DELIVERY_DESCRIPTION,
  createId,
  deliverReportToFeishu,
  loadLocalEnv,
  MemberRepository,
  openTradingDatabase,
  sendInteractiveCard
} from "../../../packages/shared-types/dist/index.js";
import { runLongbridgeJsonWithRetry } from "./_longbridge.mjs";
import { buildMemberSubprocessEnv, loadMemberCredentials } from "./member-credentials.mjs";
import { computeExposure } from "./portfolio-exposure.mjs";
import {
  SCHEDULED_JOB_OFFICIAL_PAPER_PNL,
  SCHEDULED_JOB_OFFICIAL_PAPER_POLL,
  runScheduledJobWithHeartbeat
} from "./scheduled-job-heartbeat.mjs";
import { assertOfficialPaperReportEnvironment, normalizeOfficialPaperSnapshot, normalizeQuotePayload, toNumber } from "./report-data.mjs";
import {
  shouldRunOfficialPaperHourlyPoll,
  shouldRunOfficialPaperPnlReport
} from "./trading-schedule.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
loadLocalEnv(repoRoot);

const runtimeDir = join(repoRoot, "runtime");
const reportsDir = join(repoRoot, "reports", "official-paper");
const defaultDbPath = join(runtimeDir, "trading.sqlite");
mkdirSync(runtimeDir, { recursive: true });
mkdirSync(reportsDir, { recursive: true });

// Task H4 (phase2.5 hardening): sentinel for official_paper_snapshots.owner_id
// when the writer can't attribute a snapshot to exactly one member (0 or >1
// active members). Deliberately a DIFFERENT string from stock_analysis_
// targets' '__legacy_shared__' sentinel - these are two independently
// evolving tables/columns (this one is nullable with no FK, no CHECK; that
// one is NOT NULL with a composite PK) and P6 will read this one
// differently (per-member fetch) once multi-account support lands, per the
// task brief ("P6 接入多账户时会按成员分别拉取").
export const SHARED_OWNER_SENTINEL = "__shared__";

// Resolves which member a freshly-fetched snapshot belongs to. Today there is
// exactly one shared Longbridge paper account, so the common case is exactly
// one active member -> that member's id. 0 active members (e.g. a fresh
// install before anyone is seeded) or >1 (P6's eventual multi-account state)
// can't be attributed to a single owner, so they get the shared sentinel
// instead of guessing wrong. Every write from this file must go through this
// - historical rows written before this task keep their legacy NULL owner_id
// unchanged (see schema v4's migration comment: "历史行 NULL 是合法的...但新写入必须带 owner").
export function resolveSnapshotOwnerId(db) {
  const activeMembers = new MemberRepository(db).listActive();
  return activeMembers.length === 1 ? activeMembers[0].id : SHARED_OWNER_SENTINEL;
}

// 2026-07-30, found by following the FIRST live order end to end: nothing
// scheduled reconcile-official-paper-orders.mjs. It had a package.json entry
// (`longbridge:reconcile-official-paper`) and two doc comments describing when
// it runs, but no launchd job, no openclaw cron entry and no other caller -
// proposal-sweep only expires pending proposals. So a submitted order that
// FILLED would sit as `submitted|New` in official_paper_order_lifecycle
// forever: no execution report, nothing on the owner's personal page, and the
// operator's approved trade silently never confirmed. The hourly poll is the
// right host: it already runs exactly during US regular hours (the only time
// fills happen), already holds the Longbridge session, and a reconcile needs
// the same freshness the snapshot does. Reconcile failure must not cost the
// snapshot - the two results are reported separately, never merged.
async function reconcileAfterPoll(db) {
  try {
    const { reconcileOfficialPaperOrders } = await import("./reconcile-official-paper-orders.mjs");
    const result = await reconcileOfficialPaperOrders(db);
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Exported (2026-07-30) so the reconcile wiring is testable at the seam that
// broke: `deps.perMember` / `deps.reconcile` are injection points ONLY - the
// CLI dispatch below passes neither, so production always runs the real pair.
export async function pollOfficialPaper(db, forceRun = false, deps = {}) {
  const { reconcile = reconcileAfterPoll, perMember = pollOfficialPaperPerMember } = deps;
  if (!forceRun && !shouldRunOfficialPaperHourlyPoll(new Date())) {
    console.log(JSON.stringify({ skipped: true, reason: "outside_us_hourly_poll_window" }, null, 2));
    return;
  }

  // Task 6 (2026-07-15 phase6 plan): try per-member polling FIRST. As long as
  // zero active members have a `<credentials root>/<memberId>/longbridge.env`
  // file (true in every real deployment today - P10 is when a second real
  // account's credentials actually get written), `pollOfficialPaperPerMember`
  // returns `null` and this falls through to the exact H4 single-shared-
  // account path below, byte-for-byte unchanged (including the strategy
  // reflection this per-member branch deliberately does NOT generate yet -
  // per-member reflections are a P7/control-agent concern, out of this
  // task's scope).
  const perMemberResults = await perMember(db);
  if (perMemberResults) {
    const reconcileResult = await reconcile(db);
    console.log(JSON.stringify({ polled: true, perMember: true, snapshots: perMemberResults, reconcile: reconcileResult }, null, 2));
    return;
  }

  assertOfficialPaperReportEnvironment();
  const snapshot = await fetchOfficialPaperSnapshot();
  const snapshotId = saveSnapshot(db, snapshot, "hourly_poll");
  const reflection = buildStrategyReflection(snapshot);
  const reflectionId = createId("paper_reflection");
  db.prepare(`
    INSERT INTO paper_strategy_reflections (id, snapshot_id, created_at, summary, payload)
    VALUES (?, ?, ?, ?, ?)
  `).run(reflectionId, snapshotId, snapshot.fetchedAt, reflection.summary, JSON.stringify(reflection));

  const reconcileResult = await reconcile(db);
  console.log(JSON.stringify({ polled: true, snapshotId, reflectionId, summary: reflection.summary, reconcile: reconcileResult }, null, 2));
}

// Task 6 (2026-07-15 phase6 plan): per-member polling loop. For every
// currently-ACTIVE member (MemberRepository.listActive() - same active-only
// scoping resolveSnapshotOwnerId already uses), tries to load that member's
// own broker credentials (member-credentials.mjs's loadMemberCredentials).
// Members with no credentials file are silently skipped (an ordinary
// member has no linked broker account today) - NOT an error.
//
// - Zero credentialed members (the ubiquitous case right now) -> returns
//   `null`, the explicit "nothing to do here, use the H4 shared-account
//   path" signal `pollOfficialPaper` above branches on.
// - One or more credentialed members -> fetches EACH member's OWN snapshot
//   with THEIR OWN env/cache isolation (buildMemberSubprocessEnv) and saves
//   it with `owner_id = member.id` (never the resolveSnapshotOwnerId
//   single-active-member/`'__shared__'` inference H4 uses - a credentialed
//   member's snapshot is directly attributable, no inference needed).
//
// `fetchImpl` is the injection seam (plan: "长桥抓取本身保持可注入
// (fetchImpl/execFn)...真实多账户 = P10") - tests pass a fixture function
// `(member, creds) => snapshot` so this loop is fully exercisable without a
// real longbridge CLI/subprocess. The real default
// (`fetchOfficialPaperSnapshotForMember`) builds that member's isolated
// subprocess env and calls the SAME `fetchOfficialPaperSnapshot` the H4
// shared path uses, just parameterized per member.
export async function pollOfficialPaperPerMember(db, options = {}) {
  const { fetchImpl = fetchOfficialPaperSnapshotForMember, credentialsRootDir, reason = "hourly_poll_per_member" } = options;

  const activeMembers = new MemberRepository(db).listActive();
  const credentialed = activeMembers
    .map((member) => ({ member, creds: loadMemberCredentials(member.id, { rootDir: credentialsRootDir }) }))
    .filter((entry) => entry.creds !== null);

  if (credentialed.length === 0) {
    return null;
  }

  const results = [];
  for (const { member, creds } of credentialed) {
    const env = buildMemberSubprocessEnv(creds);
    // Per-member files may override LONGBRIDGE_ACCOUNT_MODE. Validate the
    // fully merged subprocess environment before any broker read so a live
    // account can never be fetched and mislabeled as official paper data.
    assertOfficialPaperReportEnvironment(env);
    const snapshot = await fetchImpl(member, creds, env);
    const snapshotId = saveSnapshot(db, snapshot, reason, member.id);
    results.push({ ownerId: member.id, snapshotId });
  }
  return results;
}

// Real (non-test) fetchImpl default for pollOfficialPaperPerMember: builds
// this member's isolated subprocess env (HOME + rate-limit dir, never
// mutating global process.env - member-credentials.mjs's
// buildMemberSubprocessEnv) and reuses fetchOfficialPaperSnapshot's exact
// check/assets/positions/quotes sequence, just threaded with that env
// instead of the ambient shared-account one.
async function fetchOfficialPaperSnapshotForMember(member, creds, env = buildMemberSubprocessEnv(creds)) {
  return fetchOfficialPaperSnapshot({ env, rateLimitDir: creds.cachePaths.rateLimitDir });
}

async function sendPnlReport(db, forceRun = false) {
  if (!forceRun && !shouldRunOfficialPaperPnlReport(new Date())) {
    console.log(JSON.stringify({ skipped: true, reason: "outside_post_open_pnl_window" }, null, 2));
    return;
  }

  assertOfficialPaperReportEnvironment();
  const snapshot = await fetchOfficialPaperSnapshot();
  const snapshotId = saveSnapshot(db, snapshot, OFFICIAL_PAPER_REPORT_REASON);
  const previousDay = findComparisonSnapshot(db, snapshot.fetchedAt, "previous_day");
  const previousWeek = findComparisonSnapshot(db, snapshot.fetchedAt, "previous_week");
  const markdown = renderPnlReport(snapshot, previousDay, previousWeek);
  const label = snapshot.fetchedAt.slice(0, 10);
  const markdownPath = join(reportsDir, `${label}-post-open.md`);
  writeFileSync(markdownPath, `${markdown}\n`, "utf8");

  // Resolved from the persisted rows with the platform's own date-level rule
  // (resolveOfficialPaperDateAttribution), never from re-running
  // resolveSnapshotOwnerId: the card's recipient and the page's 403 gate answer
  // the same question over the same rows, and the basis is printed below so a
  // later run that changes the answer is visible in the run log.
  const scope = resolvePnlReportScope(db, snapshotId);
  const delivery = await deliverReportToFeishu(buildPnlDeliveryPayload({
    current: snapshot,
    previousDay,
    previousWeek,
    markdown,
    markdownPath,
    scope
  }));
  // 2026-07-26: same reasoning as stock-analysis.mjs - the snapshot is
  // already persisted by this point, so a Feishu delivery failure must not
  // throw the whole run away. deliverReportToFeishu returns {sent:false,
  // reason} instead of throwing; report it honestly and exit non-zero.
  if (!delivery.sent) {
    console.error(JSON.stringify({
      ok: false,
      step: "feishu-delivery",
      reason: delivery.reason ?? "模拟盘收支变化报告未发送。"
    }));
    process.exitCode = 1;
  }

  console.log(JSON.stringify({
    delivered: delivery.sent,
    snapshotId,
    markdownPath,
    // The exact basis the page will re-derive: report date, the rule's verdict
    // over this date's rows, and the scope that verdict produced. A same-date
    // rerun that flips this leaves a record of WHY the page closed on a date
    // whose card already went out. The owner's open_id is deliberately NOT
    // logged - the attribution question is answered by member id.
    attribution: {
      reportDate: label,
      ...resolveOfficialPaperDateAttribution(db, label),
      visibility: scope.visibility,
      ...(scope.reason ? { scopeReason: scope.reason } : {})
    },
    ...(delivery.sent ? {} : { deliveryReason: delivery.reason })
  }, null, 2));
}

/** The `reason` the platform keys its /official-paper attribution on
 * (routes/reports.ts OFFICIAL_PAPER_REPORT_REASON). A snapshot written with any
 * other reason produced no `<date>-post-open.md` and is invisible to that
 * query, so it can never be the basis for a card either. */
const OFFICIAL_PAPER_REPORT_REASON = "post_open_pnl";

/** `owner_id` values that are NOT a member. Mirrors routes/reports.ts's
 * NON_MEMBER_OWNER_IDS exactly: this file's own "could not attribute" sentinel
 * plus the v7 migration placeholder identity.ts refuses to resolve. */
const NON_MEMBER_OWNER_IDS = new Set([SHARED_OWNER_SENTINEL, "__legacy_system__"]);

/**
 * Who the platform will say owns `/official-paper/<reportDate>` — computed here
 * with the SAME rule, over the SAME rows, as routes/reports.ts
 * resolveOfficialPaperAttributions (2026-07-28 spec drift R4/F9).
 *
 * That rule is date-scoped, not row-scoped: it groups EVERY `post_open_pnl` row
 * whose `substr(fetched_at, 1, 10)` is this date and refuses to attribute the
 * date at all when they do not all name one real member. Reading only this
 * run's own row — which is what this file used to do — is a DIFFERENT question
 * with a different answer: two same-date `post_open_pnl` rows with different
 * owners (e.g. a `__shared__` row at 14:00Z and a `member_1` row at 14:05Z)
 * gave the card `owner-private -> member_1` while the page 403s member_1 too.
 *
 * Returned shape matches the platform's: `{kind:"owner", ownerId}` or
 * `{kind:"unattributable", reason}`. Kept exported so the agreement is testable
 * against the real route rather than asserted in a comment
 * (routes/reports.test.ts "card scope and page attribution agree").
 */
export function resolveOfficialPaperDateAttribution(db, reportDate) {
  const rows = db.prepare(`
    SELECT owner_id FROM official_paper_snapshots
    WHERE reason = ? AND substr(fetched_at, 1, 10) = ?
    GROUP BY owner_id
  `).all(OFFICIAL_PAPER_REPORT_REASON, reportDate);

  const owners = new Set(rows.map((row) => (
    typeof row.owner_id === "string" && row.owner_id.length > 0 ? row.owner_id : null
  )));

  if (owners.size === 0) {
    return {
      kind: "unattributable",
      reason: `${reportDate} 当天没有任何 post_open_pnl 快照记录，无法确认这份报告属于谁`
    };
  }
  if (owners.size > 1) {
    const listed = [...owners].map((owner) => owner ?? "（空归属）").join("、");
    return {
      kind: "unattributable",
      reason: `${reportDate} 当天存在 ${owners.size} 份归属不同的 post_open_pnl 记录（${listed}），平台按同一规则判定为无法归属，页面对所有人关闭`
    };
  }
  const [ownerId] = [...owners];
  if (ownerId === null) {
    return {
      kind: "unattributable",
      reason: `${reportDate} 当天的快照没有写入归属成员（owner_id 为空），无法确认这份账户数据属于谁`
    };
  }
  if (NON_MEMBER_OWNER_IDS.has(ownerId)) {
    return {
      kind: "unattributable",
      reason: `${reportDate} 当天的快照归属是占位值 ${ownerId}（写入时就不是恰好 1 位活跃成员，无法归属到某一个人），平台上的 /official-paper 页面对所有人关闭`
    };
  }
  return { kind: "owner", ownerId };
}

/**
 * The `ReportScope` for a PnL card: WHO is allowed to read this account's
 * balances (2026-07-28 spec drift R2, corrected R4/F9).
 *
 * Both sides answer from `resolveOfficialPaperDateAttribution`'s rule over this
 * snapshot's own report date, so the card's recipient and the page's 403 gate
 * agree on the rows that exist WHEN THIS RUN ASKS. That is the whole guarantee,
 * and it is not more than that: the page re-reads at request time, so a LATER
 * same-date `post_open_pnl` row with a different owner (a second `pnl --force`
 * run that day) can still close a page whose card was already delivered. That
 * later run resolves the same conflict and refuses to send, and sendPnlReport
 * prints the attribution basis it used (`attribution` in its JSON output), so
 * the divergence shows up in the run log instead of being silent.
 *
 * Honest outcomes, no others:
 *   - the date attributes to one real member with a Feishu open_id ->
 *     owner-private to that member.
 *   - the date is unattributable (no row, several owners, an empty owner, or a
 *     non-member sentinel) -> owner-unresolved, carrying the platform's own
 *     reason. The page is closed to EVERYONE in this state; a card that went
 *     anywhere would be handing one account's balances to whoever the default
 *     target is.
 *   - a real member who has not bound a Feishu account -> owner-unresolved.
 *     There is no DM to send to, and "no DM available" must never degrade into
 *     "send it to the group".
 */
export function resolvePnlReportScope(db, snapshotId) {
  const row = db
    .prepare("SELECT fetched_at, reason FROM official_paper_snapshots WHERE id = ?")
    .get(snapshotId);
  if (!row) {
    return {
      visibility: "owner-unresolved",
      reason: `快照 ${snapshotId} 在 official_paper_snapshots 里不存在，无法确认这份账户数据属于谁`
    };
  }
  if (row.reason !== OFFICIAL_PAPER_REPORT_REASON) {
    // The platform only attributes post_open_pnl rows; a card built on any
    // other reason would be claiming an owner for a page that has none.
    return {
      visibility: "owner-unresolved",
      reason: `本次快照的 reason 是 ${String(row.reason)}，平台只按 ${OFFICIAL_PAPER_REPORT_REASON} 快照判定 /official-paper 的归属，两边无法对齐`
    };
  }

  const attribution = resolveOfficialPaperDateAttribution(db, String(row.fetched_at).slice(0, 10));
  if (attribution.kind !== "owner") {
    return { visibility: "owner-unresolved", reason: attribution.reason };
  }
  const ownerId = attribution.ownerId;

  const member = new MemberRepository(db).getById(ownerId);
  if (!member) {
    return {
      visibility: "owner-unresolved",
      reason: `快照归属 ${ownerId}，但成员表里没有这个成员，无法确认收件人`
    };
  }

  const ownerOpenId = member.feishuOpenId?.trim() ?? "";
  if (ownerOpenId === "") {
    return {
      visibility: "owner-unresolved",
      reason: `成员 ${member.displayName}（${ownerId}）尚未绑定飞书 open_id，模拟盘收支变化只能在平台查看；绑定后下一次报告即可送达单聊`
    };
  }

  return { visibility: "owner-private", ownerOpenId };
}

// Audit item (b), 2026-07-14 (task H4): the manual `snapshot` subcommand used
// to skip assertOfficialPaperReportEnvironment entirely - poll/pnl both
// asserted it, but a wrong-environment manual run (not a paper account) would
// write that account's data straight into the trusted official_paper_snapshots
// table with no gate at all. Extracted into its own function (rather than
// inlined at the CLI dispatch site) so the assertion-then-fetch-then-save
// order is directly testable without spawning a process.
export async function runManualSnapshot(db) {
  assertOfficialPaperReportEnvironment();
  const snapshot = await fetchOfficialPaperSnapshot();
  saveSnapshot(db, snapshot, "manual");
  return snapshot;
}

// Task 6 (2026-07-15 phase6 plan): `execOptions` is an optional
// `{env, rateLimitDir}` pair forwarded verbatim to every
// runLongbridgeJsonWithRetry call below (which in turn forwards it to
// _longbridge.mjs's per-call override params - see that file's Task 6
// comments). Omitted (every pre-Task-6 caller: pollOfficialPaper/
// sendPnlReport/runManualSnapshot's default single-shared-account path) -
// every call uses _longbridge.mjs's own unchanged defaults. Only
// fetchOfficialPaperSnapshotForMember (this file's per-member fetchImpl
// default) passes a real `execOptions`.
async function fetchOfficialPaperSnapshot(execOptions = {}) {
  const fetchedAt = new Date().toISOString();
  const check = await runLongbridgeJsonWithRetry("trade", ["check"], { label: "Longbridge 连通性/令牌检查", ...execOptions });
  const [assets, positions] = await Promise.all([
    runLongbridgeJsonWithRetry("trade", ["assets"], { label: "Longbridge 官方模拟盘资产", ...execOptions }),
    runLongbridgeJsonWithRetry("trade", ["positions"], { label: "Longbridge 官方模拟盘持仓", ...execOptions })
  ]);
  const snapshot = normalizeOfficialPaperSnapshot({ check, assets, positions, fetchedAt });
  const quotes = [];
  for (const position of snapshot.positions) {
    try {
      const payload = await runLongbridgeJsonWithRetry("quote", ["quote", position.symbol], { label: `Longbridge ${position.symbol} 行情`, ...execOptions });
      quotes.push(normalizeQuotePayload(payload, position.symbol));
    } catch (error) {
      quotes.push({ symbol: position.symbol, error: String(error?.message ?? error).slice(0, 160) });
    }
  }
  const { positions: pricedPositions, degradedSymbols } = attachPriceSource(snapshot.positions, quotes);
  return {
    ...snapshot,
    positions: pricedPositions,
    quotes,
    degraded: degradedSymbols.length > 0,
    degradedReason: degradedSymbols.length > 0 ? `行情读取失败：${degradedSymbols.join("、")}` : null
  };
}

// Audit item (a), 2026-07-14 (task H4): a per-symbol quote fetch failure used
// to be silently folded into cost-price (or 0 if cost was also missing)
// inside estimateMarketValue, with NO marker anywhere in the persisted
// snapshot - the `reason` column (hourly_poll/post_open_pnl/manual) implies
// "this ran to completion", not "N positions are degraded estimates", so
// nothing downstream (exposure, PnL deltas, the rendered report) could tell
// a real market price from a stale cost-basis guess. Every position now
// carries an explicit, persisted `priceSource`:
//   'live' - a usable last/last_done price came back from the quote fetch.
//   'cost' - the quote fetch failed/was unusable, but the position's own
//            cost basis was available as a fallback.
//   'zero' - quote fetch failed AND cost basis is missing/unusable; this
//            position contributes 0 to market value (the worst case).
// Reuses the existing `degraded`/`degradedReason` field convention from
// report-data.mjs's buildDegradedOfficialPaperSnapshot/buildDegradedQuoteSnapshot
// (a DIFFERENT failure mode - total Longbridge fetch failure - but the same
// shape) rather than inventing new field names for the same concept.
export function attachPriceSource(positions, quotes) {
  const degradedSymbols = [];
  const priced = positions.map((position) => {
    const quote = quotes.find((entry) => String(entry.symbol ?? "").toUpperCase() === position.symbol);
    const last = toNumber(quote?.last ?? quote?.last_done ?? quote?.lastDone);
    if (last !== undefined) {
      return { ...position, priceSource: "live", price: last };
    }
    const cost = toNumber(position.costPrice);
    if (cost !== undefined) {
      degradedSymbols.push(`${position.symbol}(按成本估值)`);
      return { ...position, priceSource: "cost", price: cost };
    }
    degradedSymbols.push(`${position.symbol}(按0估值)`);
    return { ...position, priceSource: "zero", price: 0 };
  });
  return { positions: priced, degradedSymbols };
}

// Task 6 (2026-07-15 phase6 plan): `explicitOwnerId` lets a per-member caller
// (pollOfficialPaperPerMember) attribute a snapshot directly to the member it
// was fetched for - no inference needed, unlike the H4 shared-account path,
// which must GUESS an owner from `resolveSnapshotOwnerId`'s active-member-
// count heuristic. Omitted (every H4 caller) -> the exact prior behavior.
export function saveSnapshot(db, snapshot, reason, explicitOwnerId) {
  const id = createId("official_paper_snapshot");
  const primary = snapshot.primaryAsset ?? {};
  const netAssets = readAssetFigure(primary.net_assets, primary.netAssets);
  const totalCash = readAssetFigure(primary.total_cash, primary.totalCash);
  const marketValue = estimateMarketValue(snapshot);
  const ownerId = explicitOwnerId ?? resolveSnapshotOwnerId(db);
  db.prepare(`
    INSERT INTO official_paper_snapshots
    (id, fetched_at, reason, net_assets, total_cash, market_value, positions, raw, owner_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    snapshot.fetchedAt,
    reason,
    netAssets ?? null,
    totalCash ?? null,
    marketValue,
    JSON.stringify(snapshot.positions),
    JSON.stringify(snapshot),
    ownerId
  );
  return id;
}

// Audit item (a) follow-through: this is the "exposure computation" the task
// brief names - it must disclose degradation instead of silently trusting
// estimateMarketValue's number as ground truth. countDegradedPositions/
// snapshot.degraded (set by fetchOfficialPaperSnapshot's attachPriceSource
// call) drive an explicit note appended to the summary whenever any position
// was priced by fallback (cost/zero) rather than a live quote.
export function buildStrategyReflection(snapshot) {
  const primary = snapshot.primaryAsset ?? {};
  // 2026-07-28 (spec drift R3/N4, same class as summarizeAsset): this used to
  // be `?? 0`, which turned "the snapshot carried no asset account" into a real
  // zero net-asset account - and then divided by it. computeExposure already
  // has an honest null path (exposureRatio null, detail says so); it just was
  // never reachable from here.
  const netAssets = readAssetFigure(primary.net_assets, primary.netAssets);
  const marketValue = estimateMarketValue(snapshot);
  const exposure = computeExposure({ netAssets, marketValue, positions: snapshot.positions });
  const exposurePercent = exposure.exposureRatio === null ? null : exposure.exposureRatio * 100;
  const budgetPercent = exposure.budgetRatio * 100;
  const remainingBudget = netAssets === null
    ? null
    : Math.max(0, netAssets * budgetPercent / 100 - marketValue);
  const degraded = Boolean(snapshot.degraded);
  const degradedCount = countDegradedPositions(snapshot.positions);
  const degradedNote = degraded
    ? `（含 ${degradedCount} 笔持仓因行情读取失败按成本/0 估值，敞口与市值为估计值，非真实值）`
    : "";
  const summary = exposurePercent === null || remainingBudget === null
    ? `本次快照没有返回账户资金数据（净资产未知），无法计算暴露比例与剩余预算${degradedNote}；持仓估值 ${formatMoney(marketValue)}。`
    : `官方模拟盘当前暴露 ${exposurePercent.toFixed(2)}%${degradedNote}，剩余 OpenClaw 自由发挥预算约 ${remainingBudget.toFixed(2)} USD。`;
  return {
    summary,
    exposurePercent,
    budgetPercent,
    remainingBudget,
    positionCount: snapshot.positions.length,
    degraded,
    // Unknown net assets cannot clear a budget check, so the action is the
    // conservative one - never the "allowed" branch computeExposure returns by
    // default when it has nothing to compare.
    action: netAssets === null
      ? "暂停新增，先修复账户资金数据读取"
      : (exposure.overBudget ? "停止新增并等待降仓" : "允许继续观察，新增前仍需通过 broker-executor 预算检查")
  };
}

function countDegradedPositions(positions) {
  return (positions ?? []).filter((position) => position?.priceSource && position.priceSource !== "live").length;
}

/**
 * The Feishu delivery payload for the post-open PnL report.
 *
 * 2026-07-28 (spec drift A3). This call site passed only title/markdown/paths,
 * which was survivable while a report was delivered as a summary plus every
 * chapter. It is not survivable now that a report is ONE conclusion card built
 * from bullet lines: the 收支变化表 is a markdown TABLE, and the card's bullet
 * extractor only reads "- " lines, so the numbers this whole report exists to
 * deliver never reached the reader.
 *
 * Three deliberate decisions:
 *
 *   - `scope`, from the caller (resolvePnlReportScope). 2026-07-28 (R2): this
 *     used to say only `audience: "dm"` and trust that to keep the balances
 *     private. It did not. `audience` says which CHANNEL a card belongs to, not
 *     who may read it, and the legacy user-plugin channel has no DM to offer -
 *     so it published 「QQQ.US：数量 1，成本 663.88 USD…」 to the shared group
 *     and recorded sent:true. The payload now DECLARES that this content
 *     belongs to exactly one member, and names them; a snapshot that cannot be
 *     attributed declares that instead and is refused rather than redirected.
 *     `audience: "dm"` is kept as the channel hint it always was.
 *   - `reportKind: "official-paper"`. 2026-07-28 (R1): this used to be omitted
 *     on the grounds that "there is no /official-paper deep-link page", which
 *     was circular - the page has always been served (routes/reports.ts
 *     READING_PATH_SEGMENTS) and is now owner-gated (403 for anyone who is not
 *     the snapshot's attributed owner, with no existence leak). The card gets
 *     its 查看完整报告 button back. The numbers still travel IN the card too,
 *     because the 收支变化表 is a markdown TABLE the bullet extractor cannot
 *     read - a link is the full text, not a substitute for the conclusion.
 *
 * A missing comparison snapshot is DISCLOSED, never computed as a 0 change -
 * "no baseline exists" and "nothing moved" are different facts, and only one of
 * them is true here.
 */
export function buildPnlDeliveryPayload({ current, previousDay, previousWeek, markdown, markdownPath, scope }) {
  if (!scope || typeof scope.visibility !== "string") {
    // Refusing here rather than defaulting: every default is a guess about who
    // may read one member's account balances, and the delivery layer would have
    // to un-guess it. A caller that cannot resolve an owner passes
    // {visibility: "owner-unresolved", reason} - saying so is always possible.
    throw new TypeError("buildPnlDeliveryPayload requires an explicit `scope` (see resolvePnlReportScope): 模拟盘收支变化 is owner-private and must declare who may read it.");
  }
  const label = current.fetchedAt.slice(0, 10);
  const currentAsset = summarizeAsset(current);
  const missingFigures = describeMissingAssetFigures(currentAsset);
  const degradedCount = countDegradedPositions(current.positions);
  const reflection = buildStrategyReflection(current);

  const bullets = [
    renderComparisonBullet(PREVIOUS_DAY_COMPARISON, currentAsset, previousDay),
    renderComparisonBullet(PREVIOUS_WEEK_COMPARISON, currentAsset, previousWeek),
    renderPositionsBullet(current, degradedCount),
    `反思：${reflection.summary}（动作：${reflection.action}）`
  ];

  return {
    title: `OpenClaw 模拟盘收支变化 ${label}`,
    markdown,
    markdownPath,
    scope,
    audience: "dm",
    // `label` is `fetchedAt.slice(0, 10)` - the exact same string the writer
    // used for the filename and the exact key routes/reports.ts matches
    // (`substr(fetched_at, 1, 10)`), so the link cannot land on a date the
    // page does not have.
    reportKind: "official-paper",
    reportDate: label,
    conclusion: {
      // The headline is the one line a reader takes at face value, so a figure
      // the snapshot did not supply says 暂无 AND says it is not a zero
      // (spec drift R3): 「净资产 0.00 USD」 on a missing fetch reads as a
      // wiped-out account.
      headline: [
        `净资产 ${formatMoney(currentAsset.netAssets)}，现金 ${formatMoney(currentAsset.totalCash)}，持仓估值 ${formatMoney(currentAsset.marketValue)}`,
        missingFigures ? `（${missingFigures}：本次快照未返回账户资金数据，不是 0）` : ""
      ].join(""),
      bullets
    }
  };
}

/**
 * The two baselines this report compares against, described ONCE so the card
 * bullet and the markdown table cannot disagree about what a row means or about
 * why a baseline is absent.
 *
 * `minGapText` is the gap `findComparisonSnapshot` actually requires, and
 * `COMPARISON_LOOKBACK_ROWS` is the `LIMIT` that same query actually uses - the
 * "no baseline" sentence below is generated from the same two values the search
 * runs on, so it states the real reason rather than a plausible one.
 */
const COMPARISON_LOOKBACK_ROWS = 80;
const PREVIOUS_DAY_COMPARISON = { label: "前一日", minGapText: "24 小时" };
const PREVIOUS_WEEK_COMPARISON = { label: "上一周最后一个交易日", minGapText: "7 天" };

function missingBaselineSentence(comparison) {
  return `无可比快照（本次快照之前最近 ${COMPARISON_LOOKBACK_ROWS} 条记录里，没有比它早 ${comparison.minGapText}以上的快照），本次不计算变化。`;
}

function renderComparisonBullet(comparison, currentAsset, baseSnapshot) {
  if (!baseSnapshot) {
    return `跟${comparison.label}：${missingBaselineSentence(comparison)}`;
  }
  const base = summarizeAsset(baseSnapshot);
  // Names the baseline snapshot itself, so "跟前一日" is a claim the reader can
  // check rather than a label over unlabelled arithmetic.
  return `跟${comparison.label}（基准快照 ${formatShanghaiTime(baseSnapshot.fetchedAt)}）：净资产 ${formatFigureDelta(currentAsset.netAssets, base.netAssets)}，现金 ${formatFigureDelta(currentAsset.totalCash, base.totalCash)}`;
}

function renderPositionsBullet(snapshot, degradedCount) {
  const positions = snapshot.positions ?? [];
  if (positions.length === 0) {
    return "持仓：当前无持仓。";
  }
  const listed = positions.slice(0, 3).map((position) => `${position.symbol}×${position.quantity}`).join("、");
  const more = positions.length > 3 ? `等 ${positions.length} 个标的` : "";
  // Never let a cost/zero fallback price pass as a real market valuation.
  const degraded = degradedCount > 0
    ? `；其中 ${degradedCount} 个标的估值降级（行情读取失败，按成本价或 0 代替，非真实市价）`
    : "";
  return `持仓：${listed}${more}${degraded}。`;
}

/**
 * The 收支变化表.
 *
 * 2026-07-28 (spec drift R4/F8). Every row used to print the CURRENT snapshot's
 * net assets/cash/market value in columns 2-4, whichever comparison the row was
 * labelled with - so 「跟前一日 | 100123.45 USD | ...」 showed today's balances
 * under headings a reader takes for the comparison point. And a row with no
 * baseline printed 「基准」 in both delta columns, which reads as "this row IS
 * the reference", i.e. a baseline that does not exist.
 *
 * Now: columns 2-4 belong to the row's OWN snapshot (the 当前 row shows the
 * current one, a comparison row shows the baseline it names, with that
 * baseline's timestamp), the delta columns state their own direction in the
 * header, and a missing baseline says 无可比快照 in every cell plus a note under
 * the table giving the reason - never a number and never 基准.
 */
/**
 * The 收支变化表 header row this renderer emits, hoisted out of the template
 * below so it is a NAMED thing the platform can check a file against rather
 * than a literal duplicated in two apps (2026-07-30, spec-drift Task 12).
 *
 * It doubles as this report family's ERA MARKER: the pre-2026-07-28 renderer
 * (see the R4/F8 note above) wrote `| 对比项 | 净资产 | 现金 | 持仓估值 |
 * 净资产变化 | 现金变化 |`, whose columns 2-4 meant something else entirely,
 * so a file carrying THIS header was written by the current renderer and a
 * file carrying the old one was not. `official-paper` has no quality gate of
 * its own (report-quality.mjs judges daily/weekly/stock-analysis only), so
 * this is the only per-file era evidence that exists for it.
 */
export const PNL_TABLE_HEADER =
  "| 对比项 | 该行净资产 | 该行现金 | 该行持仓估值 | 净资产变化（当前 − 该行） | 现金变化（当前 − 该行） |";

export function renderPnlReport(current, previousDay, previousWeek) {
  const currentAsset = summarizeAsset(current);
  const reflection = buildStrategyReflection(current);
  const comparisons = [
    { comparison: PREVIOUS_DAY_COMPARISON, baseSnapshot: previousDay },
    { comparison: PREVIOUS_WEEK_COMPARISON, baseSnapshot: previousWeek }
  ];
  const missingNotes = comparisons
    .filter((entry) => !entry.baseSnapshot)
    .map((entry) => `- ${entry.comparison.label}：${missingBaselineSentence(entry.comparison)}`);

  return [
    `# OpenClaw 模拟盘收支变化 ${current.fetchedAt.slice(0, 10)}`,
    "",
    `生成时间：${formatShanghaiTime(current.fetchedAt)}`,
    "",
    "- 语言：中文。",
    `- 投递：${REPORT_DELIVERY_DESCRIPTION}。`,
    "- 账户：长桥官方模拟盘。",
    "- 范围：OpenClaw 最多使用总仓 10%；剩余 90% 不动。",
    "- 实盘：禁止自动提交真实资金订单。",
    "",
    "## 收支变化表",
    "",
    PNL_TABLE_HEADER,
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    renderTableRow([
      "当前",
      formatMoney(currentAsset.netAssets),
      formatMoney(currentAsset.totalCash),
      formatMoney(currentAsset.marketValue),
      "—（本行即当前快照）",
      "—（本行即当前快照）"
    ]),
    ...comparisons.map((entry) => renderComparisonRow(entry.comparison, currentAsset, entry.baseSnapshot)),
    ...(missingNotes.length > 0 ? ["", ...missingNotes] : []),
    "",
    "## 持仓",
    "",
    ...renderPositionLines(current),
    "",
    "## 策略反思",
    "",
    `- ${reflection.summary}`,
    `- 动作：${reflection.action}。`,
    "- 若模型鉴权、券商鉴权或飞书渠道异常，停止自动动作并降级为只读报告。"
  ].join("\n");
}

function renderTableRow(cells) {
  return `| ${cells.join(" | ")} |`;
}

/** One baseline row: the named snapshot's own figures, then what changed
 * between it and the current snapshot. A baseline that does not exist prints
 * 无可比快照 in every cell - not a number, and not 基准. */
function renderComparisonRow(comparison, currentAsset, baseSnapshot) {
  if (!baseSnapshot) {
    return renderTableRow([comparison.label, "无可比快照", "无可比快照", "无可比快照", "无可比快照", "无可比快照"]);
  }
  const base = summarizeAsset(baseSnapshot);
  return renderTableRow([
    `${comparison.label}（${formatShanghaiTime(baseSnapshot.fetchedAt)}）`,
    formatMoney(base.netAssets),
    formatMoney(base.totalCash),
    formatMoney(base.marketValue),
    formatFigureDelta(currentAsset.netAssets, base.netAssets),
    formatFigureDelta(currentAsset.totalCash, base.totalCash)
  ]);
}

function renderPositionLines(snapshot) {
  if (snapshot.positions.length === 0) {
    return ["- 当前无持仓。"];
  }
  return snapshot.positions.map((position) => {
    const quote = snapshot.quotes?.find((entry) => String(entry.symbol ?? "").toUpperCase() === position.symbol);
    const last = toNumber(quote?.last ?? quote?.last_done ?? quote?.lastDone);
    // Audit item (a): "最新价" keeps showing the raw quote result (still
    // "暂无" when the quote fetch failed - truthful, not hidden) but now
    // appends an explicit note when this position's contribution to market
    // value/exposure above came from a fallback, not a real quote.
    const degradedNote = position.priceSource && position.priceSource !== "live"
      ? `（估值降级：行情读取失败，按${position.priceSource === "cost" ? "成本价" : "0"}代替，非真实市价）`
      : "";
    return `- ${position.symbol}：数量 ${position.quantity}，成本 ${formatMoney(position.costPrice)}，最新价 ${formatMoney(last)}${degradedNote}。`;
  });
}

/**
 * The account figures a card/table line needs, with MISSING kept distinct from
 * ZERO (2026-07-28 spec drift R3/N4).
 *
 * These used to be `?? 0`. That was survivable while the numbers only appeared
 * in the markdown table; once the last round promoted them into the card
 * HEADLINE, a snapshot with no `primaryAsset` produced the authoritative-looking
 * 「净资产 0.00 USD，现金 0.00 USD，持仓估值 0.00 USD」 - a wiped-out account, not
 * a missing fetch. `null` here, and every consumer discloses it.
 *
 * `marketValue` stays a number on purpose: it is computed from the positions
 * this snapshot actually carries, so 0 there genuinely means "nothing held".
 */
function summarizeAsset(snapshot) {
  const primary = snapshot.primaryAsset ?? {};
  return {
    netAssets: readAssetFigure(primary.net_assets, primary.netAssets),
    totalCash: readAssetFigure(primary.total_cash, primary.totalCash),
    marketValue: estimateMarketValue(snapshot)
  };
}

/**
 * First readable figure among the broker's field spellings, or `null`.
 *
 * Not just `toNumber(a ?? b)`: `Number(null)` and `Number("")` are both 0, so a
 * field the broker returned as an explicit null or an empty string would have
 * been read as a real zero balance.
 */
function readAssetFigure(...candidates) {
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === "") {
      continue;
    }
    const parsed = toNumber(candidate);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return null;
}

/** Names the figures this snapshot could not supply, for a single honest
 * disclosure clause; `null` when everything is present. */
function describeMissingAssetFigures(asset) {
  const missing = [
    ...(asset.netAssets === null ? ["净资产"] : []),
    ...(asset.totalCash === null ? ["现金"] : [])
  ];
  return missing.length === 0 ? null : missing.join("、");
}

// Trusts `position.price` (set by attachPriceSource for every position that
// passes through fetchOfficialPaperSnapshot - live/cost/zero, always a
// finite number) as the single source of truth, rather than independently
// re-deriving a price from quotes the way this function used to. Falls back
// to the pre-H4 `costPrice ?? 0` derivation for legacy raw snapshots (parsed
// from official_paper_snapshots.raw by findComparisonSnapshot) that predate
// this task and never had `.price`/`.priceSource` attached - so historical
// PnL comparisons keep computing exactly the same number they always did.
export function estimateMarketValue(snapshot) {
  return snapshot.positions.reduce((sum, position) => {
    const price = typeof position.price === "number" && Number.isFinite(position.price)
      ? position.price
      : toNumber(position.costPrice) ?? 0;
    return sum + position.quantity * price;
  }, 0);
}

function findComparisonSnapshot(db, fetchedAt, mode) {
  const currentMs = new Date(fetchedAt).getTime();
  const offsetMs = mode === "previous_day" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  // The LIMIT comes from the same constant the "no baseline" disclosure quotes,
  // so the sentence can never describe a search this query does not run.
  const rows = db.prepare(`
    SELECT raw FROM official_paper_snapshots
    WHERE fetched_at < ?
    ORDER BY fetched_at DESC
    LIMIT ${COMPARISON_LOOKBACK_ROWS}
  `).all(fetchedAt);
  const target = rows.find((row) => currentMs - new Date(JSON.parse(String(row.raw)).fetchedAt).getTime() >= offsetMs);
  if (!target) {
    return null;
  }
  return JSON.parse(String(target.raw));
}

// `Number(null)` is 0, so these have to reject null/undefined BEFORE
// converting - otherwise every "we have no figure" sentinel prints as a
// confident 0.00 USD, which is the whole defect summarizeAsset just stopped
// producing.
function formatMoney(value) {
  if (value === null || value === undefined) {
    return "暂无";
  }
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(2)} USD` : "暂无";
}

function formatDelta(value) {
  if (value === null || value === undefined) {
    return "暂无";
  }
  const number = Number(value);
  return Number.isFinite(number) ? `${number >= 0 ? "+" : ""}${number.toFixed(2)} USD` : "暂无";
}

/** A change between two figures, or a statement of why there is none. A
 * subtraction involving a missing operand is not a 0 change. */
function formatFigureDelta(current, base) {
  if (current === null || base === null) {
    return "无法计算（缺少账户资金数据）";
  }
  return formatDelta(current - base);
}

function formatShanghaiTime(value) {
  const timestamp = new Date(String(value ?? "")).getTime();
  if (!Number.isFinite(timestamp)) {
    return "时间不可用";
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(timestamp));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`;
}

// ---------------------------------------------------------------------------
// CLI entry point. Guarded by isMainModule so importing this module (tests)
// never opens the real runtime db or dispatches a command as a side effect
// of `import` - mirrors stock-analysis.mjs/market-alerts.mjs/market-alerts-
// poll.mjs's existing testable-CLI pattern (task H4).
// ---------------------------------------------------------------------------

const KNOWN_COMMANDS = new Set(["poll", "pnl", "snapshot"]);

// Task 24 (2026-07-28 spec-drift remediation): `poll` and `pnl` are the two
// bodies launchd runs unattended (com.openclaw.trading.official-paper.poll /
// .pnl), so they - and only they - write a run_log heartbeat and feed the
// consecutive-failure escalation. `snapshot` is an operator typing a command
// by hand and reading the answer on their own screen; wrapping it would put
// a human's ad-hoc runs into the same failure streak that decides whether the
// SCHEDULED job is broken, which is exactly the wrong signal.
const SCHEDULED_JOB_BY_COMMAND = new Map([
  ["poll", SCHEDULED_JOB_OFFICIAL_PAPER_POLL],
  ["pnl", SCHEDULED_JOB_OFFICIAL_PAPER_PNL]
]);

async function main() {
  const [command = "poll", ...args] = process.argv.slice(2);
  const force = args.includes("--force");

  // Validate the command BEFORE opening the (real, shared) trading db - an
  // unknown command has no business touching the db at all, and this also
  // means the {ok:false} envelope below (audit fix) never has a chance to
  // depend on db state for the most common operator mistake (a typo'd
  // subcommand).
  if (!KNOWN_COMMANDS.has(command)) {
    throw new Error("Usage: official-paper-monitor.mjs <poll|pnl|snapshot> [--force]");
  }

  const db = openTradingDatabase(defaultDbPath);
  try {
    const scheduledJob = SCHEDULED_JOB_BY_COMMAND.get(command);
    if (scheduledJob) {
      await runScheduledJobWithHeartbeat(
        db,
        {
          job: scheduledJob,
          inputs: [{ command, force }],
          sendCard: (card) => sendInteractiveCard(card, { operator: true })
        },
        () => (command === "poll" ? pollOfficialPaper(db, force) : sendPnlReport(db, force))
      );
    } else {
      const snapshot = await runManualSnapshot(db);
      console.log(JSON.stringify(snapshot, null, 2));
    }
  } finally {
    db.close();
  }
}

const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  try {
    await main();
  } catch (error) {
    // Single-line JSON error envelope + non-zero exit, matching stock-
    // analysis.mjs/market-alerts.mjs's contract (2026-07 audit fix: this
    // entry point had no try/catch at all, so an unknown command or a
    // locked/corrupt db surfaced as a multi-line raw Node stack trace
    // instead - a control agent or operator reading this CLI's output must
    // never have to parse one to learn what went wrong).
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
