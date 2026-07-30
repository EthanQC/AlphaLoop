#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MemberRepository,
  REPORT_DELIVERY_DESCRIPTION,
  deliverReportToFeishu,
  loadLocalEnv,
  openTradingDatabase
} from "../../../packages/shared-types/dist/index.js";
import { CONFIDENCE_LABELS, parseReportConclusionBox, renderReportConclusionBox } from "./conclusion-box.mjs";
import { renderDailyRoutineChecklist } from "./daily-routine.mjs";
import { runLongbridgeJsonWithRetry } from "./_longbridge.mjs";
import { collectL1News } from "./news-sources.mjs";
import { buildEventFromCluster, clusterArticles } from "./news-engine.mjs";
import { getDailyFacts, upsertEventWithSources } from "./news-store.mjs";
import { createOpenclawSearchBackend, runL2TopicSearch, runL3DeepDive } from "./news-agent-search.mjs";
import { selectDiverseNewsArticles, summarizeNewsSourceBreakdown } from "./report-news.mjs";
import {
  assertOfficialPaperReportEnvironment,
  buildDegradedOfficialPaperSnapshot,
  buildDegradedQuoteSnapshot,
  buildTrackedSymbols,
  normalizeOfficialPaperSnapshot,
  normalizeQuotePayload,
  toNumber
} from "./report-data.mjs";
import { attachPriceSource, estimateMarketValue } from "./official-paper-monitor.mjs";
import { generatePersonalPages } from "./personal-page.mjs";
import {
  formatMacroValuePair,
  localizeMacroTitle,
  normalizeReportMacroCalendarPayload
} from "./report-macro.mjs";
import { fetchEarningsCalendar, renderEarningsCalendarLines } from "./report-earnings.mjs";
import { isUsRegularTradingDate } from "./trading-schedule.mjs";
import { assertReportQuality, findPersonalContentLeaks, validateNarrativeNumbers, validateReportUrls } from "./report-quality.mjs";import { buildDailyFacts, persistDailyFacts, summarizeWeeklyMarketPerformance } from "./report-facts.mjs";

// Phase 4 Task 7: news-search budgets/limits (Global Constraints - spec
// values, not to be changed here). L2 topic search runs for both daily and
// weekly at different budgets.
const NEWS_SEARCH_BUDGET = { daily: 30, weekly: 60 };

// Task 20 (2026-07-28 spec-drift plan): L3 deep-dive budgets, PER KIND, and
// it now runs for BOTH kinds.
//
// It used to be weekly-only, on a 07-07 decision ("L3 日报默认关") that the
// 2026-07-12 requirements (r2) supersede: §3.1 lists 事件深挖（top 2-3，每事件
// ≤5 轮） as a section of the DAILY report, and §3.3 asks the weekly for
// 深挖 3-5 个每事件 ≤8 轮且须含反方证据或明示未找到. Those two sentences are
// exactly the four numbers below. The daily's smaller budget is the point of
// having two: the daily gets the cheap version of the same cross-verification,
// not none of it.
export const L3_BUDGETS = {
  daily: { perEventBudget: 5, maxEvents: 3 },
  weekly: { perEventBudget: 8, maxEvents: 5 }
};

const NEWS_CARD_LIMIT = 8;

// Task 20: how far ahead the earnings calendar looks. Longer than the macro
// lookahead (REPORT_MACRO_LOOKAHEAD_DAYS, 14 days) on purpose - macro releases
// recur weekly-to-monthly, so 14 days always has something in it, while a
// given company reports once a quarter and a 14-day window would show an empty
// list for most of the year. 30 days is the shortest window that reliably
// contains the pool's next reporting date.
const EARNINGS_LOOKAHEAD_DAYS = 30;

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
loadLocalEnv(repoRoot);
const runtimeDir = join(repoRoot, "runtime");
const dbPath = join(runtimeDir, "trading.sqlite");
const statePath = join(runtimeDir, "report-delivery-state.json");
const timezone = process.env.TRADING_TIMEZONE ?? "Asia/Shanghai";

// Task H7 (2026-07-14 legacy audit): this CLI dispatch used to run
// UNCONDITIONALLY at module load time, parsing real `process.argv` via
// assertKind/assertAction/assertDateLabel - which made the module
// impossible to `import` for testing at all (any importer, e.g. a seam
// test that only wants the pure renderDailyReport/renderWeeklyReport/
// isPreparedReportMarkdownComplete functions, would crash on import
// because those asserts validate whatever argv the TEST RUNNER happens to
// be invoked with, not "daily"/"weekly"/etc). Guarded the same way every
// other testable CLI script in this directory already is (stock-analysis.mjs,
// market-alerts-poll.mjs, official-paper-monitor.mjs) - kind/action/
// windowInfo/reportPath are declared here (prepareReport/
// deliverReport close over them) but only ever COMPUTED inside the guard,
// exactly as before when actually run as a CLI. The guard itself lives at
// the very BOTTOM of this file - see the "CLI entry point" section there for
// why it must not sit here.
let kind;
let action;
let windowInfo;
let reportPath;

async function prepareReport(reportKind, info) {
  assertOfficialPaperReportEnvironment();
  const db = openTradingDatabase(dbPath);
  // C1: `selectExecutionReports(db, info)` used to be called here and its rows
  // handed to the public renderer. It is now owner-scoped and REQUIRES an
  // ownerId, and the public body no longer renders execution content at all -
  // so the public path does not read the table. The owner-scoped read happens
  // per member inside generatePersonalPages below.
  const marketData = await fetchRequiredReportMarketData(info, reportKind, db);

  // Phase 4 Task 6: build + persist this trading day's daily_facts BEFORE
  // rendering - report-quality.mjs's facts.numeric_match gate
  // (validateNarrativeNumbers) needs an independently-computed ground truth
  // already sitting in daily_facts by the time anything downstream inspects
  // the rendered narrative. Writing it after render would let a broken or
  // hand-edited render slip out with no matching facts row to catch it
  // against.
  const dailyFacts = buildDailyFacts({
    snapshot: marketData.officialPaperSnapshot,
    qqqQuote: marketData.qqqQuote,
    macroEntries: marketData.macroEvents,
    tradingDay: info.label
  });
  persistDailyFacts(db, info.label, dailyFacts);

  // Task 20 (§3.3): the weekly's own 周度行情归因, read AFTER the line above so
  // this run's own trading day is part of the week it summarizes.
  const weeklyMarketPerformance = reportKind === "weekly"
    ? summarizeWeeklyMarketPerformance(readWindowDailyFacts(db, info))
    : null;

  const report = reportKind === "daily"
    ? renderDailyReport(info, marketData)
    : renderWeeklyReport(info, { ...marketData, weeklyMarketPerformance });

  assertReportQuality(report, { kind: reportKind });
  writeFileSync(reportPath, `${report}\n`, "utf8");

  // Requirements §3.2「个人页（每人一份，随日报生成）」: the public body above
  // deliberately carries no holdings/strategy content (Task 4), so the same
  // run must produce each active member's own page - otherwise that content
  // exists nowhere at all. Generated AFTER the public report passed its
  // quality gate, from the same db handle and the same window label, and
  // persisted into personal_pages (schema v16) rather than onto disk: the page
  // is owner-private and must not sit next to the world-readable report file.
  //
  // Per-member failures are collected, not thrown: one member's page failing
  // must not cost the other members theirs, nor destroy an already-written
  // public report. They are recorded in the state file and printed, so a
  // silent gap is impossible.
  const personalPages = generatePersonalPages({
    db,
    kind: reportKind,
    date: info.label,
    helpers: {
      renderOfficialPaperSnapshot,
      summarizeOfficialAccount,
      summarizeOfficialPositions,
      // C1/C2: the owner-scoped execution read and the fill formatter that used
      // to feed the PUBLIC digest, injected for §3.3's weekly
      // 「本周我的交易 vs 策略一致性回顾」 section.
      selectExecutionReports,
      countUnattributedExecutionReports,
      // R5: the metadata-first reader of what was actually traded. Without it
      // §3.3 had only the body regexes, which no live writer's output matches.
      extractExecutionFacts,
      summarizeExecutionRow
    }
  });
  if (personalPages.failures.length > 0) {
    console.error(JSON.stringify({
      personalPagesFailed: personalPages.failures,
      kind: reportKind,
      label: info.label
    }, null, 2));
  }

  updateState(info, {
    preparedAt: new Date().toISOString(),
    path: reportPath,
    kind: reportKind,
    personalPages: {
      generated: personalPages.generated.map((entry) => ({ ownerId: entry.ownerId, id: entry.id })),
      failures: personalPages.failures
    },
    requiredDataSources: {
      officialPaperSnapshot: true,
      marketNews: true,
      macroCalendar: true,
      qqqQuote: true
    },
    sourceEvidence: marketData.sourceEvidence,
    deliveredAt: undefined,
    chunks: undefined,
    deliveries: undefined,
    regeneratedDuringDelivery: undefined,
    preparedInSameRun: undefined
  });

  return {
    path: reportPath,
    markdown: report,
    // Handed back (not just written to the state file) so the delivery
    // orchestration can address each member's own page without re-reading it.
    personalPages
  };
}

async function deliverReport(reportKind, info, alreadyPrepared) {
  let markdown = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
  let regeneratedDuringDelivery = false;
  // Task 4: a prepared file that still carries the owner's account/holdings was
  // written by the pre-§3.1 renderer, i.e. it is STALE - exactly what the
  // completeness check already regenerates for. Re-rendering it is the honest
  // fix; letting assertReportQuality below throw on it would instead halt the
  // whole scheduled job over a file we know how to rebuild correctly.
  const preparedWithPersonalContent = findPersonalContentLeaks(markdown).length > 0;
  // Task 13: same reasoning for a file written before the conclusion box
  // shipped (every report already on disk on the mini). It is STALE, not
  // broken - regenerate it instead of letting the report.conclusion_box gate
  // below throw and kill the scheduled run.
  const preparedWithoutConclusionBox = markdown !== "" && parseReportConclusionBox(markdown) === null;
  if (!isPreparedReportMarkdownComplete(markdown) || preparedWithPersonalContent || preparedWithoutConclusionBox) {
    const prepared = await prepareReport(reportKind, info);
    markdown = prepared.markdown;
    alreadyPrepared = true;
    regeneratedDuringDelivery = true;
  }

  const titlePrefix = reportKind === "daily" ? "OpenClaw 日报" : "OpenClaw 周报";
  assertReportQuality(markdown, { kind: reportKind });

  // Phase 4 Task 7 (T6 leftover wiring): validateReportUrls/
  // validateNarrativeNumbers were defined by Task 6 but never called from
  // anywhere - both are strictly opt-in to the new-format marker (see their
  // own era-compatibility comments in report-quality.mjs), so running them
  // unconditionally here is safe for legacy-format reports (they no-op).
  // validateNarrativeNumbers still throws: a narrative number that does not
  // match daily_facts is OUR OWN output being wrong, and shipping it would
  // ship a false claim.
  //
  // validateReportUrls does not throw over a link this pipeline cannot
  // verify. The rule it enforces (see report-quality.mjs, which owns the
  // evidence model and the measurements behind it): only a GET that came back
  // 404/410, or a GET whose body is the origin's own not-found page, is
  // fabrication-grade evidence and may block delivery. Everything else - a
  // timeout, a 429, a 5xx, an auth wall, an exhausted budget - is DISCLOSED
  // in the report instead of destroying it.
  //
  // Both halves of that rule are outage scar tissue. 2026-07-28: four weekly
  // runs died on one wallstreetcn.com link and the cron-runner halted the
  // weekly job. 2026-07-30: the daily job had been dead for days because the
  // check sent HEAD, and wallstreetcn answers HEAD 404 for its own LIVE
  // articles - so two real citations per day were being read as invented and
  // the finished report was thrown away. Measured against the mini's own
  // 2026-07-30 daily report, the old check failed it on
  // livenews/3141798 + /3141797 (both live, both GET 200) and the current one
  // passes it.
  //
  // The disclosure is appended before delivery, so the file on disk, the
  // platform page and the Feishu card all carry the same honest text.
  const db = openTradingDatabase(dbPath);
  const urlCheck = await validateReportUrls(markdown, { timeoutMs: 5000 });
  const dailyFacts = getDailyFacts(db, info.label);
  const numericCheck = validateNarrativeNumbers(markdown, dailyFacts);
  if (!urlCheck.ok || !numericCheck.ok) {
    throw new Error(`报告质量校验失败：${[...urlCheck.failures, ...numericCheck.failures].join(", ")}`);
  }
  if (urlCheck.disclosure) {
    markdown = appendUrlVerificationDisclosure(markdown, urlCheck.disclosure);
    writeFileSync(reportPath, markdown, "utf8");
  }

  // No `openId`, `audience: "group"`: 日报/周报 are 公共通知 (requirements §4 -
  // 群: 公共报告发布卡), not owner-scoped, so the card goes to the circle's
  // group chat (FEISHU_GROUP_CHAT_ID). With no group configured the delivery
  // layer REFUSES (2026-07-29, J2) rather than shipping the card to the global
  // target: that target is one person's DM on this deployment, and delivering a
  // 公共资产 there under `sent: true` is a wrong audience dressed as a success.
  // The refusal arrives as `sent:false` + `groupFallback`, both recorded below
  // rather than swallowed.
  // `reportKind`/`reportDate` are what let the card carry the 查看完整报告
  // button back to /daily/<date> (§1.1).
  // Task 13: the card's 结论/置信度 are PARSED BACK OUT of the markdown that is
  // actually being delivered, not recomputed from `data` - the card and the
  // report then cannot disagree, whatever happened to the file in between
  // (a URL disclosure appended, a re-render, an operator edit). A file whose
  // box does not parse hands over no conclusion at all rather than a guessed
  // one; deliverReportToFeishu falls back to its own bullet extraction.
  //
  // Written as a ternary VALUE rather than a conditional spread on purpose: a
  // spread would make this literal undecidable for check-repository-writes.mjs
  // (this directory's `pnpm typecheck`), turning a checked call across the
  // typed boundary into a blind site.
  const deliveredConclusion = parseReportConclusionBox(markdown);
  const result = await deliverReportToFeishu({
    title: `${titlePrefix} ${info.label}`,
    markdown,
    markdownPath: reportPath,
    audience: "group",
    reportKind,
    reportDate: info.label,
    conclusion: deliveredConclusion
      ? {
          headline: deliveredConclusion.coreConclusion,
          confidence: CONFIDENCE_LABELS[deliveredConclusion.confidence],
          bullets: [`依据：${deliveredConclusion.basis}`, `截至：${deliveredConclusion.asOf}`]
        }
      : undefined
  });

  // The personal half of §4 (单聊: 个人页摘要). Runs whether or not the public
  // card made it: the two audiences fail independently, and a group chat
  // misconfiguration must not also cost every member the page that carries
  // their own holdings and strategy (which Task 4 removed from the public
  // body, so this is the ONLY channel that delivers it).
  //
  // C4: idempotent per (kind, date, owner). The state file already recorded who
  // received their card; until now nothing read it back, so any retry of this
  // window re-sent every member's card. `previouslyDelivered` is that record.
  const personalCards = await deliverPersonalPageCards({
    db,
    reportKind,
    date: info.label,
    previouslyDelivered: readDeliveredPersonalCards(readState(), reportKind, info.label)
  });
  if (personalCards.failed.length > 0 || personalCards.skipped.length > 0) {
    console.error(JSON.stringify({
      personalCards: { failed: personalCards.failed, skipped: personalCards.skipped },
      kind: reportKind,
      label: info.label
    }, null, 2));
  }
  // Only stamp `deliveredAt` on entries that actually sent - a not-delivered
  // entry carrying a delivery timestamp is exactly the kind of false record
  // the state file exists to prevent.
  const deliveries = result.deliveries.map((entry) => ({
    ...entry,
    ...(entry.sent ? { deliveredAt: new Date().toISOString() } : {})
  }));
  const chapterMessages = deliveries.filter((entry) => entry.kind === "chapter");

  // 2026-07-26: deliverReportToFeishu no longer throws for an undeliverable
  // report (that throw is what killed every scheduled run on the mini before
  // a single row reached the run log). Degrade instead of crashing: the
  // report itself was generated and is on disk, so record the FAILED
  // delivery attempt in the state file, print the reason as structured
  // output, and leave `deliveredAt` unset so the next run retries delivery.
  // A non-zero exit code still marks the run as failed - degrading must not
  // turn a missed delivery into a silently "successful" run.
  if (!result.sent) {
    updateState(info, {
      path: reportPath,
      kind: reportKind,
      chunks: chapterMessages.length,
      deliveries,
      deliveryFailedAt: new Date().toISOString(),
      deliveryFailureReason: result.reason ?? "Report delivery was not sent.",
      // Round-7 finding K5. The comment above deliverReportToFeishu has claimed
      // since J2 that the refusal 「arrives as `sent:false` + `groupFallback`,
      // both recorded below」 - and only the SUCCESS branch below carried
      // `groupFallback`, so on the one path where it is now always true it was
      // never written. The doctor's `notification-routing.last_delivery_missed_group`
      // reads exactly this field, which is why an error-severity check had
      // become unreachable.
      groupFallback: result.groupFallback ?? false,
      ...(result.groupFallbackReason ? { groupFallbackReason: result.groupFallbackReason } : {}),
      personalCards,
      regeneratedDuringDelivery,
      preparedInSameRun: alreadyPrepared
    });
    console.error(JSON.stringify({
      delivered: false,
      kind: reportKind,
      label: info.label,
      reason: result.reason ?? "Report delivery was not sent.",
      targets: deliveries.map((entry) => entry.target),
      personalCards: summarizePersonalCardOutcome(personalCards),
      path: reportPath
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const outcome = summarizeRunOutcome({ reportSent: true, personalCards });

  updateState(info, {
    deliveredAt: new Date().toISOString(),
    path: reportPath,
    kind: reportKind,
    chunks: chapterMessages.length,
    deliveries,
    groupFallback: result.groupFallback ?? false,
    ...(result.groupFallbackReason ? { groupFallbackReason: result.groupFallbackReason } : {}),
    // The `delivered` list here is what the NEXT run reads back as its
    // idempotency record (see readDeliveredPersonalCards) - it carries every
    // member who has this window's card, including the ones this run skipped
    // because an earlier attempt had already sent theirs.
    personalCards,
    personalCardsComplete: outcome.personalCardsComplete,
    // Named per-member so a partial personal delivery is auditable from the
    // state file alone, without diffing two runs' stderr.
    ...(outcome.personalCardsComplete
      ? { personalCardsFailedAt: undefined, personalCardFailures: undefined }
      : { personalCardsFailedAt: new Date().toISOString(), personalCardFailures: outcome.personalCardFailures }),
    // Clear any failure recorded by an earlier attempt at this same window
    // (updateState merges into the existing entry; undefined drops the key).
    deliveryFailedAt: undefined,
    deliveryFailureReason: undefined,
    regeneratedDuringDelivery,
    preparedInSameRun: alreadyPrepared
  });

  console.log(JSON.stringify({
    delivered: true,
    kind: reportKind,
    label: info.label,
    chunks: chapterMessages.length,
    targets: deliveries.map((entry) => entry.target),
    fallbackUsed: deliveries.some((entry) => entry.fallback),
    groupFallback: result.groupFallback ?? false,
    ...(result.groupFallbackReason ? { groupFallbackReason: result.groupFallbackReason } : {}),
    personalCards: summarizePersonalCardOutcome(personalCards),
    // C4: reported on the SUCCESS line too, so "the report shipped" can never
    // be read as "and everybody got their page". The failing owners were
    // already printed to stderr above and are persisted in the state file.
    personalCardsComplete: outcome.personalCardsComplete,
    ...(outcome.personalCardsComplete ? {} : { personalCardFailures: outcome.personalCardFailures }),
    path: reportPath
  }, null, 2));

  // C4: only the PUBLIC report's delivery decides the exit code. This used to
  // be `if (personalCards.failed.length > 0) process.exitCode = 1`, which
  // marked the whole cron run failed over one unreachable member DM - and the
  // runner's retry re-runs prepare + deliver, so it re-rendered the report and
  // (before the idempotency record above) handed a duplicate card to every
  // member who already had theirs. The failure is per-member, so the remedy is
  // per-member: the next scheduled run retries exactly the members still
  // missing a card, and until then the gap is disclosed in stdout, stderr and
  // the state file rather than hidden.
  //
  // Assigned only when non-zero: writing a literal 0 here would CLEAR a failure
  // any other part of the run had already recorded, which is the one way this
  // line could turn a broken run into a reported-successful one.
  if (outcome.exitCode !== 0) {
    process.exitCode = outcome.exitCode;
  }
}

const PERSONAL_PAGE_KIND_LABELS = { daily: "日报", weekly: "周报" };

// Which owner-only platform page the card's button opens (deep-links.ts).
const PERSONAL_PAGE_DEEP_LINK_KINDS = { daily: "personal-daily", weekly: "personal-weekly" };

// How much of a personal page fits on a glance card before it stops being a
// glance surface. The full page is one button-tap away.
const PERSONAL_CARD_MAX_BULLETS = 4;
const PERSONAL_CARD_MAX_LINE_CHARS = 160;

/**
 * §4 单聊: every active member gets THEIR OWN personal page as one card in
 * their own DM, with a /daily/<date>/me (or /weekly/…) button.
 *
 * Reads the pages back out of `personal_pages` rather than taking them from
 * the generator's return value, so a delivery-only run (the report was
 * prepared by an earlier invocation) sends exactly the same pages the platform
 * will show. Nothing is rendered here: a page that does not exist is REPORTED,
 * never improvised.
 *
 * Per-member outcomes are collected, never thrown:
 *   - `delivered` - the member HAS this window's card. Entries carried over
 *                   from an earlier attempt are marked `reused: true`; the list
 *                   is therefore the complete "who has it" record, which is
 *                   what makes it safe to persist and read straight back.
 *   - `skipped`   - the member has no Feishu account bound; disclosed with the
 *                   reason, since their page still exists on the platform.
 *   - `failed`    - the page is missing, or Feishu rejected the card.
 *
 * C4 (2026-07-28 review): `previouslyDelivered` is the idempotency record -
 * the (kind, date, ownerId) triples that already got their card, read out of
 * report-delivery-state.json by readDeliveredPersonalCards. This loop used to
 * consult NOTHING: updateState wrote {delivered, skipped, failed} for every run
 * and no code path ever read it back, so a retry of the window re-sent the card
 * to every member who already had it.
 *
 * @param {{db: object, reportKind: 'daily'|'weekly', date: string, previouslyDelivered?: Array<{ownerId: string, messageId?: string}>, deliver?: Function}} input
 */
export async function deliverPersonalPageCards({
  db,
  reportKind,
  date,
  previouslyDelivered = [],
  deliver = deliverReportToFeishu
} = {}) {
  if (!db) {
    throw new Error("deliverPersonalPageCards requires a db handle.");
  }
  const kindLabel = PERSONAL_PAGE_KIND_LABELS[reportKind];
  if (!kindLabel) {
    throw new Error(`deliverPersonalPageCards supports daily/weekly only, got: ${String(reportKind)}`);
  }
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    throw new Error(`deliverPersonalPageCards requires a YYYY-MM-DD date, got: ${String(date)}`);
  }

  const delivered = [];
  const skipped = [];
  const failed = [];
  const selectPage = db.prepare(`
    SELECT markdown FROM personal_pages WHERE owner_id = ? AND kind = ? AND date = ?
  `);

  // Owner -> the record of the earlier successful send. Kept whole (not just as
  // a Set of ids) so the carried-over entry can preserve its original
  // messageId: the state file must keep pointing at the message the member
  // actually received, not lose it on the retry that skipped them.
  const alreadyDelivered = new Map();
  for (const entry of Array.isArray(previouslyDelivered) ? previouslyDelivered : []) {
    const ownerId = typeof entry?.ownerId === "string" ? entry.ownerId.trim() : "";
    if (ownerId !== "") {
      alreadyDelivered.set(ownerId, entry);
    }
  }

  for (const member of new MemberRepository(db).listActive()) {
    // Idempotency, keyed on (reportKind, date, member.id) - the window is
    // already fixed by this call's own arguments, so membership in this map IS
    // the triple. Carried over rather than dropped, so the record stays
    // complete for the run after this one.
    const prior = alreadyDelivered.get(member.id);
    if (prior) {
      delivered.push({ ...prior, ownerId: member.id, reused: true });
      continue;
    }

    const row = selectPage.get(member.id, reportKind, date);
    const markdown = row ? String(row.markdown ?? "") : "";
    if (markdown.trim() === "") {
      failed.push({
        ownerId: member.id,
        reason: `本次${kindLabel}未生成该成员的个人页（personal_pages 无记录），没有可投递的内容。`
      });
      continue;
    }

    const openId = member.feishuOpenId?.trim();
    if (!openId) {
      skipped.push({
        ownerId: member.id,
        reason: "该成员未绑定飞书 open_id，个人页只能在平台查看；绑定后下一次报告即可送达单聊。"
      });
      continue;
    }

    try {
      const result = await deliver({
        title: `我的个人页 · ${kindLabel} ${date}`,
        markdown,
        openId,
        reportKind: PERSONAL_PAGE_DEEP_LINK_KINDS[reportKind],
        reportDate: date,
        conclusion: summarizePersonalPage(markdown)
      });
      if (result?.sent) {
        const messageId = result.deliveries?.find((entry) => entry.kind === "summary" && entry.sent)?.detail;
        delivered.push({ ownerId: member.id, ...(messageId ? { messageId } : {}) });
      } else {
        failed.push({
          ownerId: member.id,
          reason: result?.reason ?? "个人页卡片未送达（投递层没有给出原因）。"
        });
      }
    } catch (error) {
      failed.push({ ownerId: member.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return { delivered, skipped, failed };
}

/**
 * The card-sized read of a personal page: one headline plus at most four
 * labelled bullets, each taken VERBATIM from the page (truncated, never
 * paraphrased) so the card and the page cannot disagree.
 *
 * Sections are the `## <n>. <title>` headings personal-page.mjs writes. A page
 * with no sections yields an empty conclusion, which the card layer turns into
 * its own honest empty state rather than padding.
 *
 * @param {string} markdown
 * @returns {{headline: string, bullets: string[]}}
 */
export function summarizePersonalPage(markdown) {
  const sections = parsePersonalPageSections(String(markdown ?? ""));
  if (sections.length === 0) {
    return { headline: "", bullets: [] };
  }

  const [holdings, ...rest] = sections;
  const headline = truncateCardLine(
    holdings.bullets.find((line) => line.startsWith("速览："))?.slice("速览：".length)
      ?? holdings.bullets.find((line) => !line.startsWith("数据归属："))
      ?? holdings.bullets[0]
      ?? ""
  );

  const bullets = [];
  const netChange = holdings.bullets.find((line) => line.startsWith("区间净值变动："));
  if (netChange) {
    bullets.push(truncateCardLine(netChange));
  }
  for (const section of rest) {
    if (bullets.length >= PERSONAL_CARD_MAX_BULLETS) {
      break;
    }
    const first = section.bullets[0];
    if (first) {
      bullets.push(truncateCardLine(`${section.label}：${first}`));
    }
  }

  return { headline, bullets: bullets.slice(0, PERSONAL_CARD_MAX_BULLETS) };
}

function parsePersonalPageSections(markdown) {
  const sections = [];
  for (const rawLine of markdown.replace(/\r\n/gu, "\n").split("\n")) {
    const line = rawLine.trim();
    const heading = /^##\s+\d+\.\s+(.+)$/u.exec(line);
    if (heading?.[1]) {
      const title = heading[1].trim();
      sections.push({ title, label: title.replace(/^我的/u, ""), bullets: [] });
      continue;
    }
    const bullet = /^-\s+(.+)$/u.exec(line);
    if (bullet?.[1] && sections.length > 0) {
      sections[sections.length - 1].bullets.push(bullet[1].trim());
    }
  }
  return sections;
}

function truncateCardLine(text) {
  const single = String(text).replace(/\s+/gu, " ").trim();
  return single.length > PERSONAL_CARD_MAX_LINE_CHARS
    ? `${single.slice(0, PERSONAL_CARD_MAX_LINE_CHARS - 1)}…`
    : single;
}

// Counts for the run's structured stdout line; the per-member detail (with
// reasons) goes to the state file and to stderr, so a summary never hides a
// member who did not get their page.
function summarizePersonalCardOutcome(personalCards) {
  return {
    delivered: personalCards.delivered.length,
    reused: personalCards.delivered.filter((entry) => entry.reused).length,
    skipped: personalCards.skipped.length,
    failed: personalCards.failed.length
  };
}

/**
 * C4: the idempotency record, read out of report-delivery-state.json.
 *
 * The state file is keyed `${kind}:${label}`, so the (kind, date) half of the
 * key is the entry lookup and `ownerId` is the third component. Only entries
 * under `personalCards.delivered` count - a `skipped` (no Feishu binding) or
 * `failed` member has NOT got their card and must be retried, which is the
 * whole point of retrying at all.
 *
 * Total-function on purpose: a missing, half-written or hand-edited state file
 * yields `[]`, i.e. "nobody has their card yet". Erring that way costs at worst
 * one duplicate card; erring the other way (treating garbage as "delivered")
 * would silently deny a member their page forever.
 *
 * @param {Record<string, unknown>|undefined} state
 * @param {'daily'|'weekly'} kind
 * @param {string} date
 * @returns {Array<{ownerId: string, messageId?: string}>}
 */
export function readDeliveredPersonalCards(state, kind, date) {
  const entry = state && typeof state === "object" ? state[`${kind}:${date}`] : null;
  const delivered = entry && typeof entry === "object" ? entry.personalCards?.delivered : null;
  if (!Array.isArray(delivered)) {
    return [];
  }
  return delivered.filter((record) => typeof record?.ownerId === "string" && record.ownerId.trim() !== "");
}

/**
 * C4: what the run's exit code should be, and whether the personal half is
 * complete.
 *
 * This used to be `if (personalCards.failed.length > 0) process.exitCode = 1`.
 * A non-zero exit marks the whole cron run failed, and the cron-runner's
 * default `run` action re-does prepare + deliver - so one member's unreachable
 * DM cost a full re-render of the report AND (before the idempotency record
 * above) a duplicate card for every member who had already received theirs.
 *
 * Only the PUBLIC report's delivery decides the exit code now. A failed
 * personal card is still surfaced - `personalCardsComplete: false` plus the
 * failing owners, printed to stderr and persisted in the state file - because a
 * silent success is worse than a loud partial. What it no longer does is trigger
 * a blind whole-run retry: the failure is per-member, so the fix is per-member
 * (the next scheduled run retries exactly the members still missing a card).
 *
 * @param {{reportSent: boolean, personalCards: {delivered: object[], skipped: object[], failed: object[]}}} input
 */
export function summarizeRunOutcome({ reportSent, personalCards } = {}) {
  const failures = Array.isArray(personalCards?.failed) ? personalCards.failed : [];
  return {
    exitCode: reportSent ? 0 : 1,
    personalCardsComplete: failures.length === 0,
    personalCardFailures: failures
  };
}

// Exported for the seam test (scheduled-report.test.ts): generates a real
// report from realistic fixture data and runs isPreparedReportMarkdownComplete
// against it, so the marker text and the completeness check can never
// silently diverge again (see that function's own doc comment).
// C1: `data.executionRows` is no longer READ by either public renderer. The
// three filter/count lines that used to stand here (trade rows, daily rows,
// rejected rows) existed only to feed the digest and the 执行边界 counts, both
// of which were owner data in a public document. Not reading the rows at all
// is the structural version of the fix: a future edit cannot leak a field the
// renderer never has in hand.
export function renderDailyReport(info, data) {
  return [
    `# OpenClaw 日报 ${info.label}`,
    "",
    `窗口：${formatWindow(info)}`,
    "",
    ...renderNewsSearchDegradedHeaderMarker(data),
    "- 语言：中文。",
    `- 投递：${REPORT_DELIVERY_DESCRIPTION}。`,
    "",
    "## 1. 今日结论",
    "",
    renderReportConclusionBlock(data),
    "",
    "### 今日要点",
    "",
    ...renderCoreSummary(data, { period: "今日" }),
    "",
    "## 2. 信息收集与分类",
    "",
    renderDataSourceSummary(data),
    "",
    renderDailyRoutineClassification(data),
    "",
    renderMarketIntelligence(data, { period: "今日" }),
    "",
    "## 3. 影响路径",
    "",
    renderImpactPath(data),
    "",
    "## 4. QQQ 固定观察",
    "",
    renderQqqSection(data.qqqQuote),
    "",
    "## 5. 官方模拟盘",
    "",
    renderPublicAccountScopeNotice(),
    "",
    renderPublicExecutionScopeNotice(),
    "",
    "## 6. 风险与异常",
    "",
    "- 实盘：禁止自动提交真实资金订单。",
    "- 官方模拟盘：只使用长桥官方模拟盘，OpenClaw 最多使用总仓 10%。",
    "- 期权：不生成、不预览、不执行任何期权自动化。",
    `- 渠道：${REPORT_DELIVERY_DESCRIPTION}。`,
    "",
    "## 7. 明日跟踪",
    "",
    renderNextTracking(data, "明日")
  ].join("\n");
}

// C1: same as renderDailyReport above - the public weekly body no longer reads
// `data.executionRows` at all.
export function renderWeeklyReport(info, data) {
  return [
    `# OpenClaw 周报 ${info.label}`,
    "",
    `窗口：${formatWindow(info)}`,
    "",
    ...renderNewsSearchDegradedHeaderMarker(data),
    "- 语言：中文。",
    `- 投递：${REPORT_DELIVERY_DESCRIPTION}。`,
    "",
    "## 1. 本周结论",
    "",
    renderReportConclusionBlock(data),
    "",
    "### 本周要点",
    "",
    ...renderCoreSummary(data, { period: "本周" }),
    "",
    "## 2. 市场主线回顾与分类",
    "",
    renderDataSourceSummary(data),
    "",
    renderDailyRoutineClassification(data),
    "",
    renderMarketIntelligence(data, { period: "本周" }),
    "",
    "## 3. QQQ 与美股风险温度",
    "",
    renderWeeklyMarketPerformance(data.weeklyMarketPerformance, info),
    "",
    renderQqqSection(data.qqqQuote),
    "",
    "## 4. 模拟盘与执行复盘",
    "",
    renderPublicAccountScopeNotice(),
    "",
    renderPublicExecutionScopeNotice(),
    "",
    "## 5. 风险与异常",
    "",
    "- 实盘：禁止自动提交真实资金订单。",
    "- 官方模拟盘：只使用长桥官方模拟盘，OpenClaw 最多使用总仓 10%。",
    "- 期权：不生成、不预览、不执行任何期权自动化。",
    `- 渠道：${REPORT_DELIVERY_DESCRIPTION}。`,
    "",
    "## 6. 下周跟踪",
    "",
    renderNextTracking(data, "下周")
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Task 20 (2026-07-28 spec-drift plan) - 周度行情归因（§3.3）
// ---------------------------------------------------------------------------
//
// The weekly report used to be the daily report with reworded headings: every
// section it rendered described a single instant, including the QQQ block,
// which printed the same one quote the daily printed. Nothing in it was about
// the WEEK. This is the section that is: week open -> week close over the
// window, plus the deepest peak-to-trough decline inside it, computed by
// report-facts.mjs's summarizeWeeklyMarketPerformance from the daily_facts
// rows the daily runs already persisted.
//
// WORDING CONSTRAINT, not a style choice: report-quality.mjs's
// facts.numeric_match gate scans the narrative for `涨跌 … %` and compares
// whatever it finds against the SINGLE-DAY `qqq.changePct` fact. A weekly
// return written as "周涨跌 -1.23%" would be matched against today's daily
// change and fail the gate on every correct report. 区间收益/最大回撤 carry the
// same meaning to a reader and are outside every NUMERIC_MATCH_PATTERNS
// regex, which is why the numbers are labelled that way.
function renderWeeklyMarketPerformance(summary, info) {
  const header = ["### 周度行情归因", ""];
  if (!summary || !summary.available) {
    return [
      ...header,
      `- 周度收益与回撤本次不可得：${summary?.reason ?? "没有拿到本窗口的每日行情事实"}。`,
      `- 窗口：${formatWindow(info)}；本段只使用已落库的 daily_facts，不会用当日单点行情代替一周表现。`
    ].join("\n");
  }

  const direction = summary.returnPct >= 0 ? "+" : "";
  const missingNote = summary.missingDays.length > 0
    ? `；窗口内 ${summary.missingDays.length} 天没有行情事实（${summary.missingDays.join("、")}），多为周末/休市或当日报告未产出`
    : "";

  return [
    ...header,
    `- 周开：${summary.openDay} ${summary.symbolLabel} ${formatNumber(summary.openPrice)}；周收：${summary.closeDay} ${summary.symbolLabel} ${formatNumber(summary.closePrice)}。`,
    `- 区间收益：${direction}${formatNumber(summary.returnPct)}%（按已落库的每日收盘事实，${summary.observedDays} 个交易日）${missingNote}。`,
    `- 最大回撤：${formatNumber(summary.maxDrawdownPct)}%（自 ${summary.drawdownPeakDay} 高点回落至 ${summary.drawdownTroughDay}）。`,
    `- 口径：数据来自 daily_facts 的 qqq.price，与本报告数字校验用的是同一份事实表；窗口 ${formatWindow(info)}。`
  ].join("\n");
}

// Task 4 (2026-07-28 spec-drift plan): the "- 模拟盘：当前持仓 …；净资产 …，现金
// …；模拟盘暴露 …，剩余自由发挥预算约 …" bullet that used to sit here is GONE
// from the public body - 2026-07-12 requirements §3.1 ("公共日报不含任何个人持仓
// 与策略内容"). It is not deleted, it moves to the per-owner personal page
// (summarizeOfficialPositions/summarizeOfficialAccount/summarizePaperBudget are
// exported for exactly that). report-quality.mjs's report.no_personal_content
// gate fails any public report that grows it back.
// ---------------------------------------------------------------------------
// Task 13 (2026-07-28 spec-drift plan) - 结论框: 核心结论 + 置信度 + 依据 + 截至
// ---------------------------------------------------------------------------
// 2026-07-12 requirements §1.4「摘要卡先行（核心结论+置信度）」/ §3.5「核心结论
// （一行观点+置信度三档+"截至"时间）」. Rendered through conclusion-box.mjs so
// the report, the platform reading page and the Feishu conclusion card share
// one vocabulary (### 结论框, 核心结论/置信度, 高/中/低).
//
// THE TIER IS DERIVED, NEVER DECLARED. It is a statement about how much
// evidence this particular run actually had, so it is computed from the same
// data the body renders:
//
//   低  - a source the conclusion rests on is missing: the QQQ quote came back
//         degraded, no news was read at all, or fewer than half the tracked
//         pool got any coverage. A conclusion drawn on that cannot be asserted
//         with confidence, and the 依据 line says which piece was missing.
//   中  - every source answered, but something was disclosed: a news source
//         degraded, the L2 agent search was unavailable, the macro calendar
//         warned, part of the pool went uncovered, or the news cap left
//         symbols unsearched.
//   高  - quote + news + macro all answered, EVERY tracked symbol got news,
//         and there was not one degradation to disclose.
//
// What is deliberately NOT an input: the official paper account snapshot. The
// public body carries no account content at all (§3.1, Task 4), so the
// conclusion does not rest on it and its read failing must not silently move a
// market/news tier. Account degradation is still disclosed in 证据与来源's
// 长桥降级 line, and it is the personal page's business.
const NEWS_COVERAGE_LOW_RATIO = 0.5;
// How many degradation items the box spells out before it starts counting.
// The full list is always in 证据与来源 - the box stays a glance surface.
const MAX_BASIS_DEGRADATIONS = 4;

/**
 * @param {object} data the same marketData object the renderers receive
 * @returns {{coreConclusion: string, confidence: 'high'|'medium'|'low', basis: string[], asOf: string, coverage: {covered: number, total: number, missing: string[]}, degradations: string[]}}
 */
export function buildReportConclusion(data) {
  const quote = data.qqqQuote ?? {};
  const quoteDegraded = quote.degraded === true
    || toNumber(quote.last ?? quote.last_done ?? quote.lastDone) === undefined;
  const quoteReason = singleLine(quote.degradedReason ?? "原因未返回", 100);
  const articles = Array.isArray(data.marketNews) ? data.marketNews : [];
  const coverage = summarizeNewsCoverage(data);
  const macroEvents = Array.isArray(data.macroEvents) ? data.macroEvents : [];
  const macroWarnings = data.macroWarnings ?? [];
  const newsWarnings = data.newsWarnings ?? [];
  const beyondLimit = data.symbolsBeyondNewsLimit ?? [];

  const degradations = [];
  if (data.newsSearchDegraded) {
    degradations.push(`agent 检索不可用（L1-only 模式）：${singleLine(data.newsSearchReason ?? "原因未知", 100)}`);
  }
  for (const warning of newsWarnings) {
    degradations.push(`新闻源降级：${singleLine(warning, 100)}`);
  }
  for (const warning of macroWarnings) {
    degradations.push(`宏观日历降级：${singleLine(warning, 100)}`);
  }
  if (beyondLimit.length > 0) {
    degradations.push(`标的池截断：${beyondLimit.join("、")} 本次未检索`);
  }

  // An uncovered symbol IS a degradation for tier purposes, but it is not
  // repeated in the 降级 clause - the 新闻 clause right above already names
  // every one of them, and saying it twice in a four-line box is noise.
  const confidence = quoteDegraded || articles.length === 0 || coverage.ratio < NEWS_COVERAGE_LOW_RATIO
    ? "low"
    : degradations.length > 0 || coverage.missing.length > 0
      ? "medium"
      : "high";

  const newsSignal = summarizeNewsSignals(articles);
  const marketClause = quoteDegraded
    ? `QQQ 行情不可用（${quoteReason}），本次不给出价格位置判断`
    : summarizeQqqMove(quote);
  const coreConclusion = `${marketClause}；${newsSignal.bias}，${newsSignal.action}`;

  const basis = [
    quoteDegraded ? `行情不可用：${quoteReason}` : `行情：QQQ 可用（${formatQuoteTimestamp(quote)}）`,
    articles.length === 0
      ? "新闻：本窗口没有读到任何可用新闻"
      : `新闻：读取 ${articles.length} 条，覆盖 ${coverage.covered}/${coverage.total} 标的${coverage.missing.length > 0 ? `（未覆盖 ${coverage.missing.join("、")}）` : ""}`,
    macroWarnings.length > 0 ? "宏观：日历读取降级" : `宏观：事件 ${macroEvents.length} 条`,
    degradations.length === 0
      ? "降级：本次无降级项"
      : `降级：${summarizeDegradationList(degradations)}`
  ];

  const fetchedAt = data.sourceEvidence?.fetchedAt;
  const asOf = Number.isFinite(new Date(String(fetchedAt ?? "")).getTime())
    ? `${formatReportDateTime(fetchedAt)}（北京时间）`
    : "数据时间未知（本次运行没有记录抓取时间）";

  return { coreConclusion, confidence, basis, asOf, coverage, degradations };
}

function summarizeDegradationList(degradations) {
  if (degradations.length <= MAX_BASIS_DEGRADATIONS) {
    return degradations.join("；");
  }
  const shown = degradations.slice(0, MAX_BASIS_DEGRADATIONS).join("；");
  return `${shown}；等共 ${degradations.length} 项（完整清单见「证据与来源」）`;
}

/**
 * How much of the tracked pool this run actually has news for. A symbol counts
 * as covered when an article was fetched FOR it (article.symbol - the per-symbol
 * feeds) or when a clustered event named it as affected (event.impact.affected -
 * how a market-wide feed like 财联社 reaches a specific ticker). Both are read
 * from the same values the body renders; the events come from resolveNewsEvents,
 * i.e. the exact list the 多源新闻 section shows.
 */
function summarizeNewsCoverage(data) {
  const tracked = Array.from(new Set((data.trackedSymbols ?? []).map((symbol) => String(symbol).toUpperCase()).filter(Boolean)));
  const covered = new Set();
  for (const article of data.marketNews ?? []) {
    const symbol = String(article?.symbol ?? "").toUpperCase();
    if (symbol && tracked.includes(symbol)) {
      covered.add(symbol);
    }
  }
  for (const event of resolveNewsEvents(data)) {
    for (const symbol of event?.impact?.affected ?? []) {
      const upper = String(symbol).toUpperCase();
      if (tracked.includes(upper)) {
        covered.add(upper);
      }
    }
  }
  const missing = tracked.filter((symbol) => !covered.has(symbol));
  return {
    total: tracked.length,
    covered: covered.size,
    missing,
    // An empty pool cannot be under-covered; it fails the low branch on the
    // "no news at all" test instead of on a 0/0 ratio.
    ratio: tracked.length === 0 ? 1 : covered.size / tracked.length
  };
}

function renderReportConclusionBlock(data) {
  const conclusion = buildReportConclusion(data);
  return renderReportConclusionBox({
    coreConclusion: conclusion.coreConclusion,
    confidence: conclusion.confidence,
    basis: conclusion.basis,
    asOf: conclusion.asOf
  });
}

function renderCoreSummary(data, counts) {
  const qqqSummary = summarizeQqqMove(data.qqqQuote);
  const newsSignal = summarizeNewsSignals(data.marketNews);
  const macroSignal = summarizeMacroSignal(data.macroEvents);
  return [
    `- 市场信号：${qqqSummary}；新闻主线：${newsSignal.summary}。`,
    `- 宏观信号：${macroSignal}。`,
    `- 操作含义：${newsSignal.action}；新增模拟盘仓位仍必须通过总仓 10% 预算检查。`,
    // C1: this line used to append "交易/执行报告 N 条，其中拒绝或未执行 M 条".
    // Those counts are derived from execution_reports, i.e. from individual
    // members' order flow - with a handful of members a count is enough to
    // reconstruct who did what, so it is owner data too, not an aggregate. The
    // RULE the line exists to state is public and stays verbatim; the numbers
    // moved to the owner's own page.
    `- 执行边界：${counts.period}没有自动提交实盘订单；期权自动化保持禁用；按成员的成交与拒绝笔数只在本人个人页披露。`
  ];
}

function renderImpactPath(data) {
  const newsSignal = summarizeNewsSignals(data.marketNews);
  const macroSignal = summarizeMacroSignal(data.macroEvents);
  const qqqSummary = summarizeQqqMove(data.qqqQuote);
  const technologyNews = data.marketNews.find((article) => /ai|nvidia|semiconductor|chip|technology|人工智能|半导体/iu.test(article.title));
  const companyNews = data.marketNews.find((article) => /earnings|revenue|profit|guidance|shares|acquires|公司|财报|指引/iu.test(article.title));

  return [
    `- 大盘：${qqqSummary}；新闻分类为 ${newsSignal.bias}，但操作上仍按“新闻验证，不直接加仓”处理。`,
    `- 宏观：${macroSignal}；如果后续利率或制造业数据反向变化，需要重新评估成长股估值压力。`,
    `- 板块：${technologyNews ? `${newsEvent(technologyNews)}是本窗口最明确的科技线索。` : "没有读到足以单独驱动板块的高置信科技线索。"}半导体、AI、利率和美元仍是 QQQ 的主要传导变量。`,
    `- 个股：${companyNews ? `${newsEvent(companyNews)}需要进入个股模板复核。` : "没有读到足以直接触发个股模板的新公司基本面事件。"}实盘动作继续停在人工复核前。`
  ].join("\n");
}

function renderNextTracking(data, label) {
  const qqq = data.qqqQuote;
  const last = toNumber(qqq.last ?? qqq.last_done ?? qqq.lastDone);
  const high = toNumber(qqq.high);
  const low = toNumber(qqq.low);
  const post = toNumber(qqq.post_market_quote?.last);
  const nextMacro = data.macroEvents[0];
  const newsThemes = selectDiverseNewsArticles(data.marketNews, 3)
    .map((article) => newsEvent(article))
    .join("；") || "暂无高置信新闻主线";

  return [
    `- QQQ：${label}先看 ${formatOptionalNumber(low)} - ${formatOptionalNumber(high)} 区间是否被放量突破；最新价 ${formatOptionalNumber(last)}，盘后 ${formatOptionalNumber(post)}。`,
    `- 新闻：复核 ${newsThemes}；只有当新闻能落到收入、利润、指引、订单或监管约束时，才升级为个股基本面事件。`,
    `- 宏观：${nextMacro ? `${nextMacro.date} ${nextMacro.time || ""} ${nextMacro.title}` : "未来窗口没有高重要性宏观事件"}；关注是否改变利率、通胀或制造业景气预期。`,
    // Task 4: the owner's exposure/remaining-budget numbers used to be spelled
    // out here. The RULE they express is public and stays; the numbers are
    // personal and live on the personal page now.
    "- 仓位纪律：任何新增模拟盘动作仍需通过人工复核和 10% 总仓上限；本人账户明细不进入公共报告。"
  ].join("\n");
}

function renderDataSourceSummary(data) {
  return [
    "### 证据与来源",
    "",
    `- 数据底座：本地交易数据库、长桥官方模拟盘账户、长桥行情（QQQ 行情）、美国宏观日历、多源新闻检索；跟踪标的 ${formatTrackedSymbols(data.trackedSymbols)}（全体成员标的池并集 + 全体持仓）。`,
    // Task 10: an un-searched symbol is disclosed, never silently absent.
    ...(data.symbolsBeyondNewsLimit?.length
      ? [`- 标的池截断：本次新闻检索上限 ${data.newsSymbolLimit ?? "未知"} 只，标的池中 ${formatTrackedSymbols(data.symbolsBeyondNewsLimit)} 未纳入本次检索（可调 REPORT_NEWS_SYMBOL_LIMIT）；这些标的本次没有被搜过，而不是没有新闻。`]
      : []),
    `- 新闻检索：每个标的最多读取 ${Number(process.env.REPORT_NEWS_COUNT_PER_SYMBOL ?? 5)} 条长桥新闻，并补充 Yahoo Finance 搜索、Yahoo Finance RSS 和 Google News RSS；本次共读取 ${data.marketNews.length} 条。`,
    `- 新闻来源分布：${summarizeNewsSourceBreakdown(data.marketNews)}。`,
    ...(data.longbridgeWarnings?.length ? [`- 长桥降级：${data.longbridgeWarnings.join("；")}；报告继续生成，但任何新增动作必须人工复核。`] : []),
    ...(data.newsWarnings.length ? [`- 新闻降级：${data.newsWarnings.join("；")}。`] : []),
    ...(data.newsSearchDegraded ? [`- 新闻检索降级：agent 检索不可用（L1-only 模式）；原因：${data.newsSearchReason ?? "原因未知"}；本次仅使用 L1 确定性采集结果，事件聚类不含 L2/L3 补充证据。`] : []),
    `- 宏观与行情：美国二星/三星宏观事件窗口从 ${data.sourceEvidence.fetchedAt.slice(0, 10)} 起向后 ${Number(process.env.REPORT_MACRO_LOOKAHEAD_DAYS ?? 14)} 天；${formatQuoteTimestamp(data.qqqQuote)}。`,
    ...(data.macroWarnings?.length ? [`- 宏观日历降级：${data.macroWarnings.join("；")}。`] : []),
    // Task 4: 账户资产行数/官方持仓数 used to be spelled out here too. A count
    // is still owner data (it tells every reader how many positions the owner
    // holds), so the public audit line keeps only the source-health facts;
    // the counts stay in report-delivery-state.json's sourceEvidence, which is
    // runtime state, not a published document.
    `- 审计状态：账户模式 ${translateAccountMode(data.sourceEvidence.accountMode)}；令牌 ${translateSessionStatus(data.sourceEvidence.longbridgeSessionStatus)}；可用区域 ${formatRegions(data.sourceEvidence.longbridgeOkRegions)}；宏观事件 ${data.sourceEvidence.macroEventsCount} 条。`
  ].join("\n");
}

// Task 4: the honest replacement for the account block the public report used
// to print. The data is not missing and not degraded - it is deliberately
// out of scope for a document every member can read, and the reader is told
// so rather than left to guess (Global Constraints: unavailable data is
// disclosed with its reason).
function renderPublicAccountScopeNotice() {
  return [
    "- 账户与仓位明细不进入公共报告：公共日报/周报只发布行情、新闻、宏观与 QQQ 基准。",
    "- 本人的账户快照与策略对照只对本人可见，不在这里呈现。"
  ].join("\n");
}

function renderDailyRoutineCompliance() {
  return [
    "### daily-routine.md 检查清单",
    "",
    "本报告按以下信息检索与分类框架组织，若某项当天没有高置信来源，仍保留为待跟踪项：",
    "",
    renderDailyRoutineChecklist()
  ].join("\n");
}

function renderDailyRoutineClassification(data) {
  const qqqSummary = summarizeQqqMove(data.qqqQuote);
  const newsSignal = summarizeNewsSignals(data.marketNews);
  const macroSignal = summarizeMacroSignal(data.macroEvents);
  const commodityNews = data.marketNews.find((article) => /crude|oil|gold|commodity|能源|黄金|原油/iu.test(article.title));
  const currencyNews = data.marketNews.find((article) => /dollar|yuan|currency|fx|汇率|美元/iu.test(article.title));
  const technologyNews = data.marketNews.find((article) => /ai|nvidia|semiconductor|chip|technology|人工智能|半导体/iu.test(article.title));
  const companyNews = data.marketNews.find((article) => /earnings|revenue|profit|guidance|shares|acquires|公司|财报|指引/iu.test(article.title));

  return [
    "### 市场叙事与分类结论",
    "",
    `- 主线：${newsSignal.summary}；整体情绪 ${newsSignal.bias}。`,
    `- 基本面：${companyNews ? `${newsEvent(companyNews)}需要等公司公告或财报验证。` : "没有读到足以直接改变单一公司基本面的高置信更新。"}${technologyNews ? `技术线索集中在${newsEvent(technologyNews)}，主要传导到科技权重和 QQQ 情绪。` : "技术/科研突破项没有形成可审计的新证据。"}`,
    `- 宏观与资产联动：${macroSignal}；${commodityNews ? `商品线索为${newsEvent(commodityNews)}。` : "商品端没有足以进入结论的新增压力。"}${currencyNews ? ` 汇率线索为${newsEvent(currencyNews)}。` : "汇率端没有足以进入结论的新增压力。"}`,
    `- 大盘确认：${qqqSummary}；${newsSignal.action}`
  ].join("\n");
}

// C1 (2026-07-28 review): renderExecutionDigest USED TO LIVE HERE and expanded
// the last 8 execution_reports rows into this very body - symbol, side,
// quantity, reference price, the report id as an "审计索引" - which meant member
// two reading /daily/<date> saw member one's order flow. Task 4 had already
// moved the ACCOUNT snapshot out for the same §3.1 reason ("公共日报不含任何个人
// 持仓与策略内容") and simply missed this second leak.
//
// The digest is not deleted, it MOVED: personal-page.mjs's 「本周我的交易 vs
// 策略一致性回顾」 renders the same fills, owner-scoped, on the owner's own
// page (spec §3.3). What stays here is the disclosure - the reader is told the
// detail exists and why they cannot see it, rather than being left to conclude
// nothing was traded.
function renderPublicExecutionScopeNotice() {
  return [
    "- 成交与执行明细不进入公共报告：每笔成交只属于下单的那一位成员，按 §3.1 只在其本人的个人页呈现。",
    "- 本节也不发布任何按成员计数的口径（成交笔数、拒绝笔数等）：在小圈子里，计数本身即可反推他人的动作。"
  ].join("\n");
}

/**
 * R5 (2026-07-28 verifier): what was actually traded, read from the row's own
 * STRUCTURED metadata first and only then from prose.
 *
 * Every consumer of execution_reports used to regex the body, and the body the
 * real writer emits (broker-executor's buildExecutionReportBody) was pure
 * Chinese 工单/状态/执行方/… with no side, quantity or price in it at all - so
 * against production rows the extraction returned nothing and the weekly
 * consistency section rendered 「无对照」 for every record, permanently. The
 * writers persist these facts in `metadata`; that is the source of truth.
 *
 * Order per field: metadata (exact, written by the producer) -> body/title
 * regex (best effort, covers legacy rows and the reconcile writer's prose) ->
 * null. `null` means NOT KNOWN and must be disclosed as such by the caller -
 * never defaulted, never guessed.
 *
 * `source` records which of the two answered, so a page can say where a fact
 * came from instead of presenting a parse as if it were a record.
 *
 * @param {{title?: string, body?: string, metadata?: unknown}} row
 */
export function extractExecutionFacts(row) {
  const text = `${row?.title ?? ""}\n${row?.body ?? ""}`;
  const metadata = parseExecutionMetadata(row?.metadata);
  const result = metadata.result && typeof metadata.result === "object" ? metadata.result : {};

  const symbol = firstKnown([
    ["metadata", normalizeFactSymbol(metadata.symbol)],
    ["body", extractSymbol(text)]
  ]);
  const side = firstKnown([
    ["metadata", normalizeFactSide(metadata.side)],
    ["body", extractSide(text)]
  ]);
  const quantity = firstKnown([
    ["metadata", normalizeFactNumber(metadata.quantity)],
    ["body", extractQuantity(text)]
  ]);
  // A fill price and a limit price are different claims - what was PAID vs what
  // was ASKED - so which one was found is carried alongside the number and the
  // page labels it accordingly. Collapsing both into 「参考价格」 would present a
  // limit price as if the trade had executed there.
  const fillPrice = normalizeFactNumber(metadata.fillPrice ?? result.fillPrice);
  const limitPrice = normalizeFactNumber(metadata.limitPrice ?? result.limitPrice);
  const price = firstKnown([
    ["metadata", fillPrice],
    ["metadata", limitPrice],
    ["body", extractPrice(text)]
  ]);
  const priceKind = price.value === null ? null : fillPrice !== null ? "成交价" : limitPrice !== null ? "限价" : "参考价格";

  return {
    symbol: symbol.value,
    side: side.value,
    quantity: quantity.value,
    price: price.value,
    priceKind,
    sources: { symbol: symbol.source, side: side.source, quantity: quantity.source, price: price.source }
  };
}

function firstKnown(candidates) {
  for (const [source, value] of candidates) {
    if (value !== null && value !== undefined && value !== "") {
      return { value, source };
    }
  }
  return { value: null, source: null };
}

function parseExecutionMetadata(raw) {
  if (raw && typeof raw === "object") {
    return raw;
  }
  if (typeof raw !== "string" || raw.trim() === "") {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeFactSymbol(value) {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  return text === "" ? null : text;
}

// Only the two order sides the system can actually place are accepted. An
// unrecognized string is NOT KNOWN, not a coin flip.
function normalizeFactSide(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (text === "buy") {
    return "买入";
  }
  if (text === "sell") {
    return "卖出";
  }
  return null;
}

function normalizeFactNumber(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? String(parsed) : null;
}

// Kept and exported for the personal page (C2): the same extraction that used
// to feed the public digest now feeds 「本周我的交易 vs 策略一致性回顾」, where
// the reader IS the owner of the row. Injected into personal-page.mjs through
// `helpers` rather than imported, because scheduled-report.mjs imports that
// module (see its header on the one-directional dependency).
//
// R5: `facts` is passed in by callers that already resolved them (the personal
// page also consults the row's linked proposal), so the heading and the
// verdict on the same line can never disagree about what was traded.
export function summarizeExecutionRow(row, facts = extractExecutionFacts(row)) {
  const text = `${row.title ?? ""}\n${row.body ?? ""}`;
  const symbol = facts.symbol ?? "未标明标的";
  const side = facts.side;
  const quantity = facts.quantity;
  const price = facts.price;
  const strategy = extractOptionStrategy(text);
  const details = [`标的 ${symbol}`];

  if (side) {
    details.push(`方向 ${side}`);
  }
  if (quantity) {
    details.push(`数量 ${quantity}`);
  }
  if (price) {
    details.push(`${facts.priceKind ?? "参考价格"} ${price}`);
  }
  if (strategy) {
    details.push(`检测到${translateOptionStrategy(strategy)}，期权自动化保持禁用`);
  }
  if (/token empty|401001/iu.test(text)) {
    details.push("鉴权为空导致官方模拟盘提交失败");
  }
  if (/not valid JSON|Unexpected token/iu.test(text)) {
    details.push("返回内容不是结构化响应，记录为解析失败");
  }
  if (/No real-money order was submitted/iu.test(text)) {
    details.push("回查记录声明没有提交真实资金订单");
  }
  if (/Status:\s*NotReported/iu.test(text)) {
    details.push("订单状态为未上报");
  }
  if (details.length === 1) {
    details.push("详细内容保存在本地数据库，中文报告不直接展开旧英文正文");
  }

  return {
    heading: side ? `${symbol} ${side}记录` : `${symbol} 记录`,
    status: classifyExecutionStatus(row, text),
    summary: `${details.join("；")}。`
  };
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return null;
}

/**
 * F4 (2026-07-28 round 3): the row's own STRUCTURED outcome.
 *
 * classifyExecutionStatus used to answer "did this trade happen?" by running
 * /failed|API error|token empty|not valid JSON|Unexpected token/iu over the
 * body. reconcile-official-paper-orders.mjs - one of exactly two writers of
 * execution_reports (`grep -rn "reports.save(" apps` finds this one and
 * broker-executor/src/server.ts's success path, nothing else) - ends EVERY
 * body it writes with the constant line
 * 「- 已将提案状态由 failed 更正为 executed，并补记一条交易执行报告。」. The English
 * word `failed` inside that Chinese success sentence matched the regex, so
 * 100% of reconciled fills were reported to their own owner as
 * 「写入或回查失败，未确认为新成交。」 - the opposite of what the same row's body
 * says. Reproduced end to end by running the real reconcileOfficialPaperOrders
 * against a temp sqlite db and feeding the row it wrote to this function.
 *
 * Both writers already record the outcome as DATA, so read the data:
 *   - reconcile-official-paper-orders.mjs's reconcileStuckFailedProposal puts
 *     lifecycleStage / localStatus / brokerStatus at the top level of
 *     `metadata`;
 *   - broker-executor's buildExecutionReportMetadata nests the whole
 *     ExecutionResult under `metadata.result`, so the same three facts are at
 *     metadata.result.brokerOrderStage / .status / .brokerStatus.
 * Both shapes were confirmed by running the producers, not by reading them.
 *
 * `stage` is null only for a row carrying no structured outcome at all
 * (pre-metadata history); only then may the caller fall back to prose.
 */
function readExecutionOutcome(row) {
  const metadata = parseExecutionMetadata(row?.metadata);
  const result = metadata.result && typeof metadata.result === "object" ? metadata.result : {};
  return {
    stage: firstText(metadata.lifecycleStage, result.brokerOrderStage),
    localStatus: firstText(metadata.localStatus, result.status),
    brokerStatus: firstText(metadata.brokerStatus, result.brokerStatus)
  };
}

// F4: one verdict per member of OfficialPaperOrderLifecycleStage
// (packages/shared-types/src/domain.ts) except the two "we do not know" ones,
// which are handled separately below so the raw broker status can be named.
// Only 'filled' is ever allowed to claim 成交.
const EXECUTION_STAGE_VERDICTS = {
  filled: "券商已确认成交。",
  submitted: "订单已提交至券商并存活，尚未观察到成交。",
  accepted: "订单已被券商受理，尚未观察到成交。",
  pending: "订单在券商侧仍在进行中（部分成交或撤单请求在途），尚未确认为全部成交。",
  submitting: "仍在向券商提交，尚未拿到回执。",
  cancelled: "订单已撤销，未成交。",
  rejected: "券商拒绝该订单，未成交。",
  failed: "提交失败，未确认为新成交。",
  submit_unconfirmed: "提交结果未确认，未确认为新成交。"
};

// F4: second-tier structured signal. ExecutionResult.brokerOrderStage is
// optional on the type, so a result that carries only `status` still gets a
// data-derived verdict instead of falling through to prose. 'accepted' here
// deliberately does NOT claim 成交: the local status 'accepted' is what
// broker-status-map.mjs returns for BOTH 'filled' AND 'cancelled', so on its
// own it cannot distinguish a fill from a cancellation.
const EXECUTION_LOCAL_STATUS_VERDICTS = {
  accepted: "执行方已接受该订单；本记录没有券商生命周期阶段，无法据此断言是否成交。",
  submitted: "订单已提交，尚未观察到成交。",
  pending: "订单仍在进行中，尚未观察到成交。",
  rejected: "该订单被拒绝，未成交。"
};

/**
 * M14 (2026-07-28 round-4 verifier): own-property lookup, and a string or
 * nothing.
 *
 * Both verdict tables above are plain object literals and both keys come from
 * a row's metadata JSON - i.e. from data, not from code. A plain `table[key]`
 * therefore resolves INHERITED keys: measured, `metadata.lifecycleStage =
 * "toString"` made the verdict `Function.prototype.toString`, which is truthy,
 * so classifyExecutionStatus returned a function and personal-page.mjs
 * interpolated 「  - 状态：function toString() { [native code] }」 onto a
 * member's page. `constructor`, `valueOf` and `hasOwnProperty` behave the same
 * way. Unknown keys must fall through to the "we cannot judge this" branches
 * below, exactly like any other unrecognized status.
 */
function lookupVerdict(table, key) {
  if (typeof key !== "string" || !Object.hasOwn(table, key)) {
    return undefined;
  }
  const verdict = table[key];
  return typeof verdict === "string" ? verdict : undefined;
}

function classifyExecutionStatus(row, text) {
  const outcome = readExecutionOutcome(row);

  if (outcome.stage) {
    const verdict = lookupVerdict(EXECUTION_STAGE_VERDICTS, outcome.stage);
    if (verdict) {
      return verdict;
    }
    // 'unknown_broker_status' / 'unknown', or a stage value this table does
    // not know: say so, naming the broker status, rather than guessing.
    return outcome.brokerStatus
      ? `券商状态「${outcome.brokerStatus}」不在本系统的状态映射表内，无法判定是否成交。`
      : "本记录的券商状态无法识别，无法判定是否成交。";
  }

  const localVerdict = lookupVerdict(EXECUTION_LOCAL_STATUS_VERDICTS, outcome.localStatus);
  if (localVerdict) {
    return localVerdict;
  }

  // ---- prose fallback: rows with NO structured outcome only ---------------
  // Reachable only for pre-metadata history. Both live writers always record a
  // stage, so neither writer's rows can reach these regexes - which is the
  // whole point: `failed` inside 「由 failed 更正为 executed」 can no longer be
  // read as a failure. The other four patterns were audited the same way and
  // no producer in this repo emits 'API error', 'token empty' or 'Unexpected
  // token' into an execution_reports body at all; 'not valid JSON' exists only
  // in _openclaw-gateway.mjs's own thrown error, which never reaches this
  // table. They stay because for a legacy English row they are the only signal
  // there is.
  if (/Option trading is disabled|Option strategy .* not allowed|期权/iu.test(text)) {
    return "期权相关请求已拦截，未执行。";
  }
  if (/failed|API error|token empty|not valid JSON|Unexpected token/iu.test(text)) {
    return "写入或回查失败，未确认为新成交。";
  }
  if (/was found in Longbridge order list|reconciliation/iu.test(text)) {
    return "官方模拟盘回查到记录；不涉及实盘自动下单。";
  }
  if (/rejected|not allowed|disabled|未执行|不允许/iu.test(text)) {
    return "规则或风控拦截，未执行。";
  }
  if (row.category === "daily") {
    return "报告记录已入库。";
  }
  return "执行记录已入库。";
}

// R5, corrected by F6 (2026-07-28 round 3). The Chinese patterns come FIRST
// because they are what this repo's own writers emit today, but the two
// writers do NOT emit the same fields, and this comment used to claim they
// did ("both write 标的/方向/数量/限价/成交价"):
//   - broker-executor's buildExecutionReportBody writes 工单/标的/方向/数量/状态/
//     执行方 always, plus 外部订单号/券商状态/生命周期阶段/限价/成交价 when the
//     ExecutionResult carries them;
//   - reconcile-official-paper-orders.mjs's reconcileStuckFailedProposal
//     writes 工单/状态/执行方/外部订单号/券商状态/生命周期阶段 (+限价 when the
//     broker order carried a price) and 原因 - never 标的/方向/数量, which it
//     keeps in `metadata` only. That is fine because extractExecutionFacts
//     reads metadata first; it is NOT fine to describe it as prose that exists.
// Both bodies were read back off rows produced by running the real writers.
// The English patterns are for rows written before either writer emitted
// Chinese; the set used to contain ONLY those, which is why every row parsed
// as "nothing known".
function extractSymbol(text) {
  const patterns = [
    /标的[：:]\s*([A-Z]{1,5}(?:\.[A-Z]{2})?)/iu,
    /\bSymbol:\s*([A-Z]{1,5}(?:\.US)?)/iu,
    /\bfor\s+([A-Z]{1,5}(?:\.US)?)/iu,
    /\border\s+(?:buy|sell)\s+([A-Z]{1,5}(?:\.US)?)/iu,
    /\b([A-Z]{1,5}\.US)\b/u
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].toUpperCase();
    }
  }
  return null;
}

function extractSide(text) {
  const chinese = text.match(/方向[：:]\s*(买入|卖出)/u);
  if (chinese?.[1]) {
    return chinese[1];
  }
  const match = text.match(/\b(?:Side:\s*|order\s+)(buy|sell)\b/iu);
  if (!match?.[1]) {
    return null;
  }
  return match[1].toLowerCase() === "buy" ? "买入" : "卖出";
}

function extractQuantity(text) {
  return text.match(/数量[：:]\s*([0-9.]+)/u)?.[1] ?? text.match(/\bQuantity:\s*([0-9.]+)/iu)?.[1] ?? null;
}

function extractPrice(text) {
  return (
    text.match(/成交价[：:]\s*([0-9.]+)/u)?.[1] ??
    text.match(/限价[：:]\s*([0-9.]+)/u)?.[1] ??
    text.match(/--price\s+([0-9.]+)/iu)?.[1] ??
    text.match(/\bprice[:\s]+([0-9.]+)/iu)?.[1] ??
    null
  );
}

function extractOptionStrategy(text) {
  return text.match(/\b(covered_call|cash_secured_put|long_call|long_put)\b/iu)?.[1]?.toLowerCase() ?? null;
}

function translateOptionStrategy(strategy) {
  const labels = {
    covered_call: "备兑看涨策略",
    cash_secured_put: "现金担保看跌策略",
    long_call: "买入看涨期权策略",
    long_put: "买入看跌期权策略"
  };
  return labels[strategy] ?? "期权策略";
}

function translateReportCategory(category) {
  return category === "trade" ? "交易/执行" : "报告";
}

function translateAssetClass(assetClass) {
  const labels = {
    stock: "股票",
    etf: "交易型开放式指数基金"
  };
  return labels[assetClass] ?? String(assetClass ?? "资产");
}

function translateDataSource(source) {
  const labels = {
    "longbridge-official-paper": "长桥官方模拟盘"
  };
  return labels[String(source ?? "")] ?? "已验证来源";
}

function translateAccountMode(mode) {
  const labels = {
    paper: "模拟盘",
    live: "实盘"
  };
  return labels[String(mode ?? "").toLowerCase()] ?? "未知模式";
}

function translateSessionStatus(status) {
  const labels = {
    valid: "有效",
    expired: "过期",
    unknown: "未知"
  };
  return labels[String(status ?? "").toLowerCase()] ?? String(status ?? "未知");
}

function translateRiskLevel(value) {
  const labels = {
    safe: "安全",
    normal: "正常",
    warning: "警示",
    danger: "高风险"
  };
  return labels[String(value ?? "").toLowerCase()] ?? "未知";
}

function translateCurrency(value) {
  const labels = {
    USD: "美元",
    HKD: "港元",
    CNH: "离岸人民币",
    CNY: "人民币"
  };
  const key = String(value ?? "USD").toUpperCase();
  return labels[key] ?? key;
}

function translateQuoteStatus(value) {
  const labels = {
    normal: "正常",
    halted: "停牌",
    delisted: "退市"
  };
  return labels[String(value ?? "").toLowerCase()] ?? "未知";
}

function translateMarket(value) {
  const labels = {
    US: "美国",
    HK: "香港",
    CN: "中国内地"
  };
  return labels[String(value ?? "").toUpperCase()] ?? String(value ?? "");
}

function shouldShowMarketPrefix(market, title) {
  const label = translateMarket(market);
  return Boolean(label) && !String(title ?? "").startsWith(label);
}

function translateSecurityName(symbol, name) {
  const labels = {
    "QQQ.US": "纳指 100 交易型开放式指数基金",
    AAPL: "苹果公司",
    MSFT: "微软公司"
  };
  return labels[String(symbol ?? "").toUpperCase()] ?? labels[String(name ?? "").toUpperCase()] ?? "持仓标的";
}

function formatTrackedSymbols(symbols) {
  return symbols.length ? symbols.join("、") : "未配置";
}

function formatRegions(regions) {
  const labels = {
    cn: "中国区",
    global: "全球区",
    hk: "香港区"
  };
  return Array.isArray(regions) && regions.length
    ? regions.map((region) => labels[String(region).toLowerCase()] ?? String(region)).join("、")
    : "未返回";
}

// Task 4: exported (with renderOfficialPaperSnapshot below and the already-
// exported summarizePaperBudget) because the owner's account is no longer
// rendered into the PUBLIC body - these are the seam the per-owner personal
// page renders it from instead, so the account view exists in one place rather
// than being re-implemented next to the page that shows it.
export function summarizeOfficialPositions(rows) {
  if (!rows.length) {
    return "空仓";
  }
  return rows.map((row) => `${row.symbol} ${formatNumber(row.quantity, 4)} 份`).join("、");
}

export function summarizeOfficialAccount(snapshot) {
  if (snapshot.degraded) {
    return `官方模拟盘读取降级：${snapshot.degradedReason ?? "原因未返回"}；本报告不据此提出新增仓位`;
  }
  const asset = snapshot.primaryAsset ?? {};
  const netAssets = formatOptionalNumber(toNumber(asset.net_assets ?? asset.netAssets));
  const cash = formatOptionalNumber(toNumber(asset.total_cash ?? asset.totalCash));
  const risk = translateRiskLevel(asset.risk_level ?? asset.riskLevel);
  return `净资产 ${netAssets} ${translateCurrency(asset.currency)}，现金 ${cash}，风险等级 ${risk}`;
}

function summarizeQqqMove(quote) {
  const last = toNumber(quote.last ?? quote.last_done ?? quote.lastDone);
  const prevClose = toNumber(quote.prev_close ?? quote.prevClose);
  if (last === undefined || prevClose === undefined || prevClose === 0) {
    return "QQQ 行情可读取，但缺少涨跌幅字段";
  }
  const change = last - prevClose;
  const direction = change > 0 ? "上涨" : change < 0 ? "下跌" : "持平";
  return `QQQ 最新价 ${formatNumber(last)}，较前收${direction} ${formatNumber(Math.abs(change))}（${formatPercent(Math.abs(change) / prevClose)}）`;
}

function summarizeMarketNewsTitle(title) {
  const text = String(title ?? "");
  if (/trade representative|ustr|tariff|trade policy/iu.test(text)) {
    return {
      event: "美国贸易政策或关税相关消息更新",
      impact: "关注贸易政策变化对科技股估值和纳指风险偏好的影响"
    };
  }
  if (/wall street extends rally|tech strength|tech leaps|technology/iu.test(text)) {
    return {
      event: "美股在科技板块带动下延续上涨",
      impact: "对 QQQ 偏正面，但需防止短线追高"
    };
  }
  if (/week ahead|monday|what to watch/iu.test(text)) {
    return {
      event: "下周市场前瞻更新",
      impact: "关注周一开盘、宏观数据和科技股消息对 QQQ 的影响"
    };
  }
  if (/global markets|crude|iran|truce|middle east/iu.test(text)) {
    return {
      event: "全球市场和地缘风险预期变化",
      impact: "若避险需求下降，成长股风险偏好可能改善；若反复则波动上升"
    };
  }
  if (/stock market indicator|warning|buffett|2007/iu.test(text)) {
    return {
      event: "市场风险指标出现警示信号",
      impact: "提示不要只看短线上涨，需同时关注回撤和仓位上限"
    };
  }
  if (/nvidia|huang|ai|artificial intelligence/iu.test(text)) {
    return {
      event: "人工智能和英伟达增长预期相关消息",
      impact: "对纳指和 QQQ 的科技权重股情绪有直接影响"
    };
  }
  if (/micron|semiconductor|chip|\bmu\b/iu.test(text)) {
    return {
      event: "半导体板块相关消息",
      impact: "可能影响纳指科技链条情绪，需观察是否扩散到 QQQ"
    };
  }
  if (/linde|nasdaq|underperform/iu.test(text)) {
    return {
      event: "个股相对纳指表现偏弱的讨论",
      impact: "作为市场宽度参考，暂不直接改变 QQQ 持仓判断"
    };
  }
  if (/hedge|shorted|crash/iu.test(text)) {
    return {
      event: "市场风险对冲和高空头股票反弹相关消息",
      impact: "说明风险偏好回升，但也可能放大短期波动"
    };
  }
  if (/market|stocks|wall street|nasdaq|qqq/iu.test(text)) {
    return {
      event: "美股市场走势相关消息",
      impact: "作为 QQQ 趋势和风险偏好的辅助证据"
    };
  }
  if (/earnings|revenue|profit|guidance/iu.test(text)) {
    return {
      event: "公司业绩或指引相关消息",
      impact: "关注是否影响科技股盈利预期"
    };
  }
  if (/[\u3400-\u9fff]/u.test(text)) {
    return {
      event: singleLine(text, 120),
      impact: "媒体、渠道和链接已列在新闻明细中；先作为可核对线索，不单独触发加仓"
    };
  }
  return {
    event: "多源检索返回的一般市场新闻",
    impact: "媒体、渠道和链接已列在新闻明细中；先作为可核对线索，不单独触发加仓"
  };
}

function summarizeNewsSignals(articles) {
  const classified = articles.map(classifyMarketNews);
  const positive = classified.filter((item) => item.bias === "利好").length;
  const negative = classified.filter((item) => item.bias === "利空").length;
  const watch = classified.length - positive - negative;
  const concreteThemes = classified
    .filter((item) => !/一般市场新闻/u.test(item.event))
    .slice(0, 3)
    .map((item) => item.event);
  const topThemes = (concreteThemes.length ? concreteThemes : classified.slice(0, 3).map((item) => item.event)).join("；") || "暂无可用新闻主线";
  const bias = positive > negative
    ? "中性偏多"
    : negative > positive
      ? "中性偏谨慎"
      : "中性，等待更多确认";
  const action = negative > positive
    ? "不追高，优先观察风险事件是否扩散"
    : positive > negative
      ? "可以继续观察强势延续，但不因单日新闻直接加仓"
      : "保持轻仓观察，把新闻作为验证项而不是交易触发器";
  return {
    summary: `${topThemes}；分类 ${positive} 条偏利好、${negative} 条偏利空、${watch} 条待验证`,
    bias,
    action
  };
}

function summarizeMacroSignal(entries) {
  if (entries.length === 0) {
    return "未来窗口没有返回二星/三星美国宏观事件，宏观项暂不提供新增交易触发";
  }
  const next = entries[0];
  // Task 23: the SECOND place a macro entry reaches the reader (the 宏观信号
  // line, distinct from the 宏观日历 list). It printed the same raw English
  // title and the same glued "Previous187"; both go through report-macro.mjs
  // now, so the two renderings of one event cannot describe it differently.
  const values = next.values
    .filter((item) => item.key && item.value)
    .slice(0, 3)
    .map((item) => formatMacroValuePair(item))
    .filter(Boolean)
    .join(" / ");
  const title = localizeMacroTitle(next.title) || next.title;
  return `${next.date} ${next.time || ""} ${title}${values ? `（${values}）` : ""}；关注是否改变利率、通胀或制造业景气预期`;
}

// Task H7 (2026-07-14 legacy audit): this used to read `snapshot.quotes`,
// a field NO producer of officialPaperSnapshot (normalizeOfficialPaperSnapshot/
// buildDegradedOfficialPaperSnapshot in report-data.mjs) ever sets - the
// lookup was always undefined, so every non-QQQ position silently fell back
// to its cost basis (or 0 when cost_price was missing), understating or
// zeroing real exposure in the "今日结论"/"明日跟踪" budget line. Fix: reuse
// H4's attachPriceSource/estimateMarketValue (official-paper-monitor.mjs) -
// the same position.price/priceSource-aware valuation already used for the
// trusted official_paper_snapshots table - instead of a second, dead
// hand-rolled computation. The only live quote this pipeline fetches is
// QQQ.US, so non-QQQ positions still price at cost when that's all that's
// available, but it is now EXPLICIT (priceSource: 'cost'/'zero') and
// disclosed in the rendered line, rather than a silently-wrong number
// presented as ground truth.
export function summarizePaperBudget(snapshot, qqqQuote) {
  const asset = snapshot.primaryAsset ?? {};
  const netAssets = toNumber(asset.net_assets ?? asset.netAssets) ?? 0;
  const quotes = qqqQuote ? [qqqQuote] : [];
  const { positions: pricedPositions, degradedSymbols } = attachPriceSource(snapshot.positions, quotes);
  const marketValue = estimateMarketValue({ positions: pricedPositions });
  if (netAssets <= 0) {
    return "无法计算模拟盘暴露比例";
  }
  const exposure = marketValue / netAssets * 100;
  const remaining = Math.max(0, netAssets * 0.1 - marketValue);
  const degradedNote = degradedSymbols.length > 0
    ? `（${degradedSymbols.join("、")}未取得实时行情，按估算价计入，非真实市价）`
    : "";
  return `模拟盘暴露 ${exposure.toFixed(2)}%，剩余自由发挥预算约 ${formatNumber(remaining)} 美元${degradedNote}`;
}

function classifyMarketNews(article) {
  const summary = summarizeMarketNewsTitle(article.titleZh ?? article.title);
  const text = `${article.title ?? ""} ${article.titleZh ?? ""} ${summary.event} ${summary.impact}`;
  let bias = "待验证";
  if (/rally|strength|leaps|growth|truce|improve|上行|上涨|改善|正面|增长|缓和/iu.test(text)) {
    bias = "利好";
  }
  if (/warning|tariff|crude|iran|crash|underperform|risk event|geopolitical risk|下跌|警示|关税|风险事件|地缘风险|偏弱/iu.test(text)) {
    bias = bias === "利好" ? "待验证" : "利空";
  }
  const fundamentalImpact = /earnings|revenue|profit|guidance|ai|semiconductor|chip|财报|营收|利润|指引|人工智能|半导体/iu.test(text)
    ? "可能影响基本面，需原始公告确认"
    : "更多影响情绪/风险偏好，暂不视为基本面变化";
  return {
    ...summary,
    bias,
    fundamentalImpact,
    article
  };
}

function newsEvent(article) {
  return article.titleZh ?? summarizeMarketNewsTitle(article.title).event;
}

function renderClassifiedNewsLine(article) {
  const item = classifyMarketNews(article);
  return `- ${formatReportDateTime(article.publishedAt)} ${article.symbol}：${newsEvent(article)}；媒体：${article.publisher ?? article.sourceName ?? article.source}；分类：${item.bias}；基本面：${item.fundamentalImpact}；影响：${item.impact}。`;
}

function renderMarketIntelligence(data, { period = "本窗口" } = {}) {
  // Task 23 (2026-07-30): the indicator name and the value keys used to be
  // printed exactly as Longbridge sends them - all-English, and glued
  // ("Previous3.625") - inside an otherwise all-Chinese report. Both now go
  // through report-macro.mjs: a known indicator renders 中文名（English
  // original）, an unknown one says so outright rather than passing English
  // off as the label. See that module's header for the rules.
  const macroLines = data.macroEvents.length > 0
    ? data.macroEvents.slice(0, 8).map((entry) => {
        const values = entry.values
          .filter((item) => item.key && item.value)
          .slice(0, 3)
          .map((item) => formatMacroValuePair(item))
          .filter(Boolean)
          .join(" / ");
        const title = localizeMacroTitle(entry.title) || entry.title;
        const market = shouldShowMarketPrefix(entry.market, title) ? `${translateMarket(entry.market)} ` : "";
        return `- ${entry.date} ${entry.time || ""} ${market}${title}${values ? `（${values}）` : ""}`;
      })
    : ["- 未来宏观日历没有返回高重要性事件。"];

  // Task 20 (2026-07-28 spec-drift plan): requirements §3.1's section is
  // 「宏观与财报日历」, not 「宏观日历」 - the earnings half had never been built.
  // THE HEADING TEXT IS LOAD-BEARING IN THREE OTHER PLACES, all updated with
  // this rename: report-quality.mjs's macro.evidence gate,
  // isPreparedReportMarkdownComplete's marker list (below), and
  // notifications.ts's extractActionableSummaryBullets, which pulls the Feishu
  // card's macro line by heading pattern. None of them would have failed
  // loudly: "宏观与财报日历" does not contain "宏观日历" as a contiguous
  // substring, and `^###\s+宏观日历` cannot match the level-4 sub-heading, so
  // the card would simply have come out one line shorter forever. Same class
  // of silent divergence H7 found between "长桥行情" and "长桥 QQQ 行情"; see
  // isPreparedReportMarkdownComplete's own note.
  return [
    renderClusteredNewsSection(data, period),
    "",
    "### 宏观与财报日历",
    "",
    "#### 宏观日历",
    "",
    ...macroLines,
    "",
    "#### 财报日历",
    "",
    ...renderEarningsCalendarLines(data.earningsCalendar)
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Phase 4 Task 7: clustered news section ("### 多源新闻（事件聚类）")
// ---------------------------------------------------------------------------
//
// Replaces the pre-Task-7 per-article rendering (selectDiverseNewsArticles +
// renderChineseNewsLine over data.marketNews) with a per-EVENT rendering
// over news-engine.mjs's clustered `event` shape: one card per clustered
// story (中文标题/影响/两行摘要/来源角标+原文链接), plus a mandatory per-event
// "compat" detail line reusing the SAME dense single-line shape
// report-quality.mjs's OLD gates (news.detail_depth/news.source_diversity/
// news.generic_chinese_summary/news.translation) already check for - those
// gates are UNCONDITIONAL (not gated behind the new-format marker, see that
// file's own "judged by the old gates AND the new ones" comment), so a
// new-format report must still satisfy them. The compat line's fields (媒体/
// 渠道/分类/基本面/标题要点/影响/链接) are derived from the SAME event.impact
// this card's own "影响" line already shows - one source of truth, not a
// second independently-computed classification.
//
// Section-tail statistics (来源分布/非券商源占比/中文源占比) are the BINDING
// format Task 6's news.source_diversity_v2/news.chinese_ratio gates parse
// (see report-quality.mjs's SOURCE_SUMMARY_LINE_PATTERN/
// CHINESE_RATIO_LINE_PATTERN) - each stat is its OWN bullet line (not merged
// into one line) because CHINESE_RATIO_LINE_PATTERN is anchored at the start
// of its bullet.

function resolveNewsEvents(data) {
  if (Array.isArray(data.newsEvents)) {
    return data.newsEvents;
  }
  // Fallback for callers that supply raw `marketNews` without a precomputed
  // `newsEvents` field (e.g. direct renderDailyReport/renderWeeklyReport unit
  // tests) - prepareReport's real data-fetch path always sets `newsEvents`
  // explicitly (computed once, alongside the DB persist - see
  // fetchRequiredReportMarketData), so this recomputation only ever runs for
  // callers that skipped that step.
  return buildNewsEvents(data.marketNews ?? [], data.trackedSymbols ?? []);
}

function buildNewsEvents(articles, trackedSymbols) {
  return clusterArticles(articles).map((cluster) => buildEventFromCluster(cluster, trackedSymbols));
}

function persistNewsEvents(db, events) {
  for (const event of events) {
    if (!event?.clusterKey) {
      continue;
    }
    upsertEventWithSources(
      db,
      {
        clusterKey: event.clusterKey,
        titleZh: event.titleZh,
        summaryZh: event.summaryZh,
        impactDirection: event.impact?.direction,
        impactAffected: event.impact?.affected,
        impactReason: event.impact?.reason
      },
      event.sources ?? []
    );
  }
}

function hasCjkText(value) {
  return /[㐀-鿿]/u.test(String(value ?? ""));
}

function translateImpactDirectionLabel(direction) {
  if (direction === "bullish") {
    return "利好";
  }
  if (direction === "bearish") {
    return "利空";
  }
  if (direction === "neutral") {
    return "中性";
  }
  return "待验证";
}

function classifyEventFundamentalImpact(event) {
  const text = `${event?.titleZh ?? ""} ${event?.summaryZh ?? ""} ${event?.impact?.reason ?? ""}`;
  return /earnings|revenue|profit|guidance|ai|semiconductor|chip|财报|营收|利润|指引|人工智能|半导体/iu.test(text)
    ? "可能影响基本面，需原始公告确认"
    : "更多影响情绪/风险偏好，暂不视为基本面变化";
}

// Display label per source origin (news-engine.mjs's toSourceRecord sets
// `origin` from the L1 article's `source` field - see news-sources.mjs's
// fetchers for which literal strings each source uses).
const CHANNEL_LABELS = {
  "rsshub-cls": "财联社电报",
  "rsshub-wallstreetcn": "华尔街见闻直播",
  "rsshub-gelonghui": "格隆汇快讯",
  finnhub: "Finnhub",
  "yahoo-finance-search": "Yahoo Finance 搜索",
  "yahoo-finance-rss": "Yahoo Finance RSS",
  "google-news-rss": "Google News",
  "longbridge-news": "长桥新闻",
  "openclaw-l2-search": "OpenClaw 检索"
};

function deriveChannelLabel(origin) {
  return CHANNEL_LABELS[String(origin ?? "")] ?? String(origin ?? "未知渠道");
}

// Sorts by known publishedAt descending; unknown-time entries sort LAST
// ("未知时间→「时间未知」置底", Global Constraints) rather than being treated
// as "now".
function orderByRecencyUnknownLast(list, getIso) {
  return [...list].sort((left, right) => {
    const leftMs = getIso(left) ? Date.parse(getIso(left)) : NaN;
    const rightMs = getIso(right) ? Date.parse(getIso(right)) : NaN;
    const leftKnown = Number.isFinite(leftMs);
    const rightKnown = Number.isFinite(rightMs);
    if (leftKnown && rightKnown) {
      return rightMs - leftMs;
    }
    if (leftKnown !== rightKnown) {
      return leftKnown ? -1 : 1;
    }
    return 0;
  });
}

function orderEventsByRecency(events) {
  return orderByRecencyUnknownLast(events, (event) => event?.lastPublishedAt);
}

function orderSourcesByRecency(sources) {
  return orderByRecencyUnknownLast(sources, (source) => source?.publishedAt);
}

// One "来源角标" bullet per source: media name + Beijing time (or honest
// "时间未知"), and the original link rendered as a markdown `[原文](url)` -
// titles/urls reaching this point are already defused (Task 1's
// defuseMarkdownInText, applied at news-engine.mjs's buildEventFromCluster/
// toSourceRecord), so it is safe to splice the raw url into the link target.
function renderSourceBadgeLine(source) {
  const timeLabel = source.publishedAt ? formatReportDateTime(source.publishedAt) : "时间未知";
  const link = source.url ? `[原文](${source.url})` : "原文链接未提供";
  return `- 来源：${source.publisher || deriveChannelLabel(source.origin)}（${timeLabel}）；${link}`;
}

// The mandatory dense compat-detail line (see section header comment) for
// one event, keyed off one representative source (preferring one with a
// URL, so "链接：" is populated rather than falling back to "来源索引：").
function renderEventDetailCompatLine(event, source) {
  const bias = translateImpactDirectionLabel(event?.impact?.direction);
  const fundamentalImpact = classifyEventFundamentalImpact(event);
  const channelLabel = deriveChannelLabel(source.origin);
  const timeLabel = source.publishedAt ? formatReportDateTime(source.publishedAt) : "时间未知";
  const symbolLabel = event?.impact?.affected?.[0] ?? "市场";
  const shouldShowOriginalTitle = !hasCjkText(source.titleRaw);
  const pieces = [
    `- ${timeLabel} ${symbolLabel}：${event.titleZh}`,
    `媒体：${source.publisher || channelLabel}`,
    `渠道：${channelLabel}`,
    `标题要点：${event.titleZh}`,
    shouldShowOriginalTitle ? `原始标题：${singleLine(source.titleRaw, 200)}` : null,
    `影响：${event?.impact?.reason || "多源检索线索，先作为可核对信息，不单独触发加仓"}`,
    `分类：${bias}`,
    `基本面：${fundamentalImpact}`,
    source.url ? `链接：[原文](${source.url})` : `来源索引：${channelLabel}`
  ].filter(Boolean);
  return `${pieces.join("；")}。`;
}

function renderNewsEventCard(event, index) {
  const [summaryLine1 = "", summaryLine2 = ""] = String(event.summaryZh ?? "").split("\n");
  const biasLabel = translateImpactDirectionLabel(event?.impact?.direction);
  const affectedLabel = event?.impact?.affected?.length ? event.impact.affected.join("、") : "大盘/宏观";
  const reasonLabel = event?.impact?.reason || "多源检索线索，先作为可核对信息，不单独触发加仓";
  const orderedSources = orderSourcesByRecency(event.sources ?? []);
  const representativeSource = orderedSources.find((source) => source.url) ?? orderedSources[0];

  return [
    `#### ${index}. ${event.titleZh}`,
    "",
    `- 影响：方向 ${biasLabel}；标的 ${affectedLabel}；理由 ${reasonLabel}`,
    `- 摘要：${summaryLine1}`,
    ...(summaryLine2 ? [`  ${summaryLine2}`] : []),
    ...orderedSources.map(renderSourceBadgeLine),
    ...(representativeSource ? [renderEventDetailCompatLine(event, representativeSource)] : [])
  ].join("\n");
}

function summarizeEventSourceBreakdown(sources) {
  const counts = new Map();
  for (const source of sources) {
    const label = source.publisher || deriveChannelLabel(source.origin);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const breakdown = Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([label, count]) => `${label} ${count} 条`)
    .join("；");
  return breakdown || "暂无新闻来源";
}

function computeNonBrokerSourceRatio(sources) {
  if (sources.length === 0) {
    return 0;
  }
  const nonBroker = sources.filter((source) => source.origin !== "longbridge-news").length;
  return (nonBroker / sources.length) * 100;
}

function computeChineseSourceRatio(sources) {
  if (sources.length === 0) {
    return 0;
  }
  const zh = sources.filter((source) => source.lang === "zh").length;
  return (zh / sources.length) * 100;
}

function translateUncertaintyLabel(value) {
  const labels = { high: "高", medium: "中", low: "低" };
  return labels[value] ?? "未知";
}

// L3 deep-dive subsection ("事件-证据-反方证据/not_found-不确定性").
//
// Task 20 (2026-07-28 spec-drift plan): this is no longer weekly-only. §3.1
// puts 事件深挖（top 2-3，每事件 ≤5 轮） in the DAILY report and §3.3 gives the
// weekly the bigger budget (3-5 events, ≤8 rounds) - both kinds now pass
// `enabled: true` with their own L3_BUDGETS entry, so the heading no longer
// claims 周报专属 and the empty state no longer says 本周.
//
// It still renders nothing when runL3DeepDive answers `{skipped: true}` -
// which now only happens when a caller explicitly disables it, not per-kind.
// Independent of the L2 header/warnings marker: L3 carries its OWN degraded
// flag/reason from its own (possibly-failed) backend calls.
function renderL3DeepDiveSection(l3Result, events, periodLabel = "本窗口") {
  if (!l3Result || l3Result.skipped) {
    return null;
  }

  const entries = Array.isArray(l3Result.events) ? l3Result.events : [];
  const eventLines = entries.map((entry) => {
    const event = events.find((candidate) => candidate.clusterKey === entry.eventClusterKey);
    const title = event?.titleZh ?? entry.eventClusterKey ?? "未知事件";
    const evidenceCount = Array.isArray(entry.evidence) ? entry.evidence.length : 0;
    const counterLabel = Array.isArray(entry.counterEvidence) && entry.counterEvidence.length > 0
      ? `${entry.counterEvidence.length} 条反方证据`
      : "not_found（未找到反方证据）";
    return `- 事件：${title}；证据：${evidenceCount} 条独立佐证；反方证据：${counterLabel}；不确定性：${translateUncertaintyLabel(entry.analysis?.uncertainty)}。`;
  });

  const degradedNote = l3Result.degraded
    ? [`- 深度核查在本次运行中降级：${l3Result.degradedReason ?? "原因未知"}；以上为降级前已完成的事件，其余高影响事件未获得独立交叉验证。`]
    : [];

  return [
    "### 事件深挖（L3 深度核查）",
    "",
    ...(eventLines.length > 0 ? eventLines : [`- ${periodLabel}没有触发深度核查的高影响事件。`]),
    ...degradedNote
  ].join("\n");
}

function renderClusteredNewsSection(data, periodLabel = "本窗口") {
  const events = resolveNewsEvents(data);
  if (events.length === 0) {
    return [
      "### 多源新闻（事件聚类）",
      "",
      "- 本窗口没有聚类出可用新闻事件；多源采集结果全部为空会在数据收集阶段直接报错，因此这通常表示聚类后事件数为零而非采集失败。"
    ].join("\n");
  }

  const cardEvents = orderEventsByRecency(events).slice(0, NEWS_CARD_LIMIT);
  const cards = cardEvents.map((event, index) => renderNewsEventCard(event, index + 1));

  const allSources = events.flatMap((event) => (Array.isArray(event.sources) ? event.sources : []));
  const sourceBreakdown = summarizeEventSourceBreakdown(allSources);
  const nonBrokerRatio = computeNonBrokerSourceRatio(allSources);
  const chineseRatio = computeChineseSourceRatio(allSources);

  const l3Section = renderL3DeepDiveSection(data.l3DeepDive, events, periodLabel);

  // Quiet-news-day honesty (pairs with report-quality.mjs's scarcity escape
  // on news.detail_depth): fewer than 3 clustered events on a genuinely
  // quiet session must not block the whole report - disclose the scarcity
  // explicitly instead. The gate only honors this line when events >= 1, so
  // it cannot be used to ship an empty section.
  const scarcityDisclosure = cardEvents.length < 3
    ? [`- 事件稀少提示：本窗口仅聚类出 ${cardEvents.length} 件事件（少于常规 3 件），已全部呈现，无遗漏。`]
    : [];

  return [
    "### 多源新闻（事件聚类）",
    "",
    cards.join("\n\n"),
    "",
    ...scarcityDisclosure,
    `- 新闻来源分布：${sourceBreakdown}。`,
    `- 非券商源占比：${nonBrokerRatio.toFixed(2)}%。`,
    `- 中文源占比：${chineseRatio.toFixed(2)}%。`,
    ...(l3Section ? ["", l3Section] : [])
  ].join("\n");
}

// Header disclosure line (Global Constraints / 07-03:213 semantic): when the
// restricted-agent (L2/L3) search backend is unavailable/throws (today: the
// P10 placeholder from createOpenclawSearchBackend), the report degrades to
// an "L1-only" path and must say so at the very top, not just bury it in the
// evidence section (renderDataSourceSummary carries the matching warnings
// bullet).
function renderNewsSearchDegradedHeaderMarker(data) {
  if (!data.newsSearchDegraded) {
    return [];
  }
  return [`⚠ agent 检索不可用（L1-only 模式）：${data.newsSearchReason ?? "原因未知"}`, ""];
}

// ---------------------------------------------------------------------------
// Phase 4 Task 7: L2 topic search wrapper (report-time orchestration)
// ---------------------------------------------------------------------------

// Wraps createOpenclawSearchBackend()+runL2TopicSearch in a try/catch of its
// own IN ADDITION to runL2TopicSearch's internal per-call degradation
// handling (news-agent-search.mjs's executeQueries already catches a
// searchBackend throw and returns `{degraded: true, ...}` without ever
// rethrowing) - this outer catch only exists to also cover a hypothetical
// synchronous throw from constructing the backend itself, so this function
// can never let a news-search failure crash report generation; the resulting
// `degraded` state is a first-class part of the render (header marker +
// warnings bullet), never a lost report.
async function runNewsAgentSearch({ symbols, l1Titles, budget }) {
  const backend = createOpenclawSearchBackend();
  try {
    const result = await runL2TopicSearch({ searchBackend: backend, budget, symbols, l1Titles });
    if (result.degraded) {
      return { degraded: true, reason: result.degradedReason, results: result.results, backend };
    }
    return { degraded: false, reason: null, results: result.results, backend };
  } catch (error) {
    return { degraded: true, reason: String(error?.message ?? error), results: [], backend };
  }
}

// Maps a validated L2 result item (news-agent-search.mjs's schema:
// {title, publisher, url, publishedAt, summary_zh, impact, evidence_quote})
// into the L1 article shape news-engine.mjs's clusterArticles/
// buildEventFromCluster expect, so a genuine L2 finding can merge into an
// existing L1 cluster (same normalized URL/similar title - and, per
// deriveImpact's documented precedence, its OWN structured `impact` then
// wins for that cluster) or seed a brand-new event when it matches nothing
// already collected.
function mapL2ResultToArticle(item) {
  const titleHasCjk = hasCjkText(item.title);
  return {
    id: item.url,
    symbol: Array.isArray(item.impact?.affected) ? item.impact.affected[0] : undefined,
    title: item.title,
    titleZh: titleHasCjk ? item.title : item.summary_zh,
    summary: item.summary_zh,
    url: item.url,
    publisher: item.publisher,
    sourceName: item.publisher,
    source: "openclaw-l2-search",
    publishedAt: item.publishedAt ?? undefined,
    publishedAtMs: item.publishedAt ? Date.parse(item.publishedAt) : undefined,
    relatedTickers: Array.isArray(item.impact?.affected) ? item.impact.affected : [],
    impact: item.impact
  };
}

// Task 4: no longer called by renderDailyReport/renderWeeklyReport - the
// public body carries renderPublicAccountScopeNotice() in its place. Exported
// for the per-owner personal page (and the test that proves the account data
// still renders in full, i.e. that this was a relocation, not a deletion).
export function renderOfficialPaperSnapshot(snapshot) {
  if (snapshot.degraded) {
    return [
      `- 来源：${translateDataSource(snapshot.source)}；账户模式：${translateAccountMode(snapshot.accountMode)}；抓取时间：${formatReportDateTime(snapshot.fetchedAt)}`,
      `- 状态：读取降级；原因：${snapshot.degradedReason ?? "原因未返回"}`,
      "- 净资产/现金/购买力：本次不可用，禁止据此扩大模拟盘仓位。",
      "- 当前长桥官方模拟盘持仓：本次不可核验；以最近成功报告和人工复核为准。"
    ].join("\n");
  }
  const asset = snapshot.primaryAsset ?? {};
  const header = [
    `- 来源：${translateDataSource(snapshot.source)}；账户模式：${translateAccountMode(snapshot.accountMode)}；抓取时间：${formatReportDateTime(snapshot.fetchedAt)}`,
    `- 净资产：${formatOptionalNumber(toNumber(asset.net_assets ?? asset.netAssets))} ${translateCurrency(asset.currency)}；现金：${formatOptionalNumber(toNumber(asset.total_cash ?? asset.totalCash))}；购买力：${formatOptionalNumber(toNumber(asset.buy_power ?? asset.buyPower))}`,
    `- 风险等级：${translateRiskLevel(asset.risk_level ?? asset.riskLevel)}`
  ];

  if (snapshot.positions.length === 0) {
    return [...header, "- 当前长桥官方模拟盘没有持仓。"].join("\n");
  }

  return [
    ...header,
    ...snapshot.positions.map((row) => {
      const available = row.available === undefined ? "" : `，可用 ${formatNumber(row.available, 4)}`;
      const cost = row.costPrice === undefined ? "成本不可用" : `成本 ${formatNumber(row.costPrice, 3)}`;
      return `- ${row.symbol}（${translateSecurityName(row.symbol, row.name)}）：${formatNumber(row.quantity, 4)} ${translateAssetClass(row.assetClass)}${available}，${cost}，币种 ${translateCurrency(row.currency)}`;
    })
  ].join("\n");
}

function renderQqqSection(quote) {
  if (quote?.degraded) {
    return [
      `- 标的：${quote.symbol ?? "QQQ.US"}`,
      `- 状态：行情读取降级；原因：${quote.degradedReason ?? "原因未返回"}`,
      `- 时间：${formatReportDateTime(quote.timestamp)}`,
      "- 操作含义：不能用本次行情判断突破或加仓，只保留新闻/宏观观察。"
    ].join("\n");
  }
  const last = toNumber(quote.last ?? quote.last_done ?? quote.lastDone);
  const prevClose = toNumber(quote.prev_close ?? quote.prevClose);
  const open = toNumber(quote.open);
  const high = toNumber(quote.high);
  const low = toNumber(quote.low);
  const volume = toNumber(quote.volume);
  const change = last !== undefined && prevClose !== undefined
    ? `${formatNumber(last - prevClose)} / ${formatPercent((last - prevClose) / prevClose)}`
    : "不可用";

  const lines = [
    `- 标的：${quote.symbol ?? "QQQ.US"}`,
    `- 最新价：${formatOptionalNumber(last)}；前收：${formatOptionalNumber(prevClose)}；区间涨跌：${change}`,
    `- 日内：开 ${formatOptionalNumber(open)} / 高 ${formatOptionalNumber(high)} / 低 ${formatOptionalNumber(low)} / 量 ${formatOptionalNumber(volume, 0)}`,
    `- 状态：${translateQuoteStatus(quote.status)}`
  ];

  const post = quote.post_market_quote;
  if (post && typeof post === "object") {
    lines.push(`- 盘后：${formatOptionalNumber(toNumber(post.last))}，时间 ${formatReportDateTime(post.timestamp)}`);
  }

  const pre = quote.pre_market_quote;
  if (pre && typeof pre === "object") {
    lines.push(`- 盘前：${formatOptionalNumber(toNumber(pre.last))}，时间 ${formatReportDateTime(pre.timestamp)}`);
  }

  return lines.join("\n");
}

/**
 * C1 (2026-07-28 review): the owner-scoped read of `execution_reports`.
 *
 * This used to filter on category and the time window only, and its rows went
 * straight into the PUBLIC daily/weekly body - so every member read every
 * other member's fills. There is no such thing as an owner-agnostic caller
 * for this table any more, so `ownerId` is REQUIRED rather than optional: an
 * accidental `selectExecutionReports(db, info)` must fail loudly instead of
 * silently reverting to "everybody's rows".
 *
 * `owner_id = ?` also excludes the unattributed (NULL) history v17 deliberately
 * did not backfill - those rows belong to nobody, so they are publishable to
 * nobody. Their existence is disclosed by count, see
 * countUnattributedExecutionReports.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{start: Date, end: Date}} info report window
 * @param {string} ownerId
 */
export function selectExecutionReports(db, info, ownerId) {
  if (typeof ownerId !== "string" || ownerId.trim() === "") {
    throw new Error("selectExecutionReports requires an ownerId - execution reports are owner-scoped (schema v17).");
  }
  return db
    .prepare(`
      SELECT id, category, title, body, metadata, created_at, owner_id
      FROM execution_reports
      WHERE category IN ('trade', 'daily') AND owner_id = ?
      ORDER BY created_at ASC
    `)
    .all(ownerId)
    .filter((row) => isWithinWindow(row.created_at, info));
}

/**
 * How many rows inside the window belong to nobody (v17 left pre-existing
 * history unattributed rather than inventing an owner). Reported so the
 * exclusion is DISCLOSED on the owner's page instead of looking like "there
 * were no trades".
 */
export function countUnattributedExecutionReports(db, info) {
  return db
    .prepare(`
      SELECT created_at FROM execution_reports
      WHERE category IN ('trade', 'daily') AND owner_id IS NULL
    `)
    .all()
    .filter((row) => isWithinWindow(row.created_at, info)).length;
}


async function fetchRequiredReportMarketData(info, reportKind, db) {
  const fetchedAt = new Date().toISOString();
  const longbridgeWarnings = [];
  const [checkResult, assetsResult, positionsResult, quoteResult] = await Promise.allSettled([
    fetchRequiredLongbridgeJson("trade", ["check"], "Longbridge 连通性/令牌检查"),
    fetchRequiredLongbridgeJson("trade", ["assets"], "Longbridge 官方模拟盘资产"),
    fetchRequiredLongbridgeJson("trade", ["positions"], "Longbridge 官方模拟盘持仓"),
    fetchRequiredLongbridgeJson("quote", ["quote", "QQQ.US"], "Longbridge QQQ 行情")
  ]);
  const officialPaperSnapshot = buildOfficialPaperSnapshotFromSettled({
    checkResult,
    assetsResult,
    positionsResult,
    fetchedAt,
    warnings: longbridgeWarnings
  });
  const qqqQuote = buildQqqQuoteFromSettled({
    quoteResult,
    fetchedAt,
    warnings: longbridgeWarnings
  });
  // Task 10 (2026-07-28 spec-drift plan): the pool is now the union of every
  // member's watchlist + held positions (§0.4), read from the db - see
  // buildTrackedSymbols. The per-run cap stays (each symbol costs 4-5 upstream
  // fetches and Yahoo already answers 429 on the mini at ONE symbol), but a
  // capped-out symbol is now DISCLOSED in the report's 证据与来源 block rather
  // than silently dropped: a reader must be able to tell "no news about TSM"
  // from "TSM was never searched".
  const pooledSymbols = buildTrackedSymbols({
    db,
    positions: officialPaperSnapshot.positions,
    extraSymbols: splitCsv(process.env.REPORT_NEWS_SYMBOLS ?? "")
  });
  const newsSymbolLimit = Math.max(1, Number(process.env.REPORT_NEWS_SYMBOL_LIMIT ?? 8));
  const trackedSymbols = pooledSymbols.slice(0, newsSymbolLimit);
  const symbolsBeyondNewsLimit = pooledSymbols.slice(newsSymbolLimit);
  // Task 20: the earnings half of §3.1's 「宏观与财报日历」, over the FULL pool
  // (not the news-capped slice) - the news cap exists because each symbol costs
  // 4-5 upstream news fetches, while an earnings lookup is one cheap Finnhub
  // call per symbol, so there is no reason to hide a pool member's reporting
  // date behind that cap. Fetched alongside the other two so a slow calendar
  // does not serialize behind the news collection.
  const [marketNewsResult, macroCalendarResult, earningsCalendar] = await Promise.all([
    fetchMarketNews(trackedSymbols),
    fetchMacroCalendar(info),
    fetchEarningsCalendar({
      symbols: pooledSymbols,
      from: info.label,
      to: addDays(info.label, EARNINGS_LOOKAHEAD_DAYS),
      lookaheadDays: EARNINGS_LOOKAHEAD_DAYS,
      env: process.env
    })
  ]);
  const marketNews = marketNewsResult.articles;
  const macroEvents = macroCalendarResult.entries;

  // Phase 4 Task 7: L2 topic search, budget by report kind (§0.4: daily <=30,
  // weekly <=60). `runNewsAgentSearch` resolves its own default backend -
  // news-agent-search.mjs's createOpenclawSearchBackend, LIVE gateway wiring,
  // not a throwing placeholder. When the gateway is unreachable or answers
  // unparseably, the run degrades instead of crashing, and the degradation is
  // a first-class disclosed state (header marker + warnings bullet).
  const newsSearch = await runNewsAgentSearch({
    symbols: trackedSymbols,
    l1Titles: marketNews.map((article) => article.title),
    budget: NEWS_SEARCH_BUDGET[reportKind] ?? NEWS_SEARCH_BUDGET.daily
  });

  const combinedArticles = !newsSearch.degraded && newsSearch.results.length > 0
    ? [...marketNews, ...newsSearch.results.map(mapL2ResultToArticle)]
    : marketNews;

  // Cluster once, persist once (single writer - report generation and the
  // platform news page share the same trading db/process host per Global
  // Constraints) - both render faces (this report, the platform's
  // listNewsEvents) read the SAME upserted rows.
  const newsEvents = buildNewsEvents(combinedArticles, trackedSymbols);
  persistNewsEvents(db, newsEvents);

  // Task 20: L3 deep-dive runs for BOTH kinds now, each at its own spec'd
  // budget (see L3_BUDGETS - §3.1 daily 5/3, §3.3 weekly 8/5).
  const l3Budget = L3_BUDGETS[reportKind] ?? L3_BUDGETS.daily;
  const l3DeepDive = await runL3DeepDive({
    searchBackend: newsSearch.backend,
    events: newsEvents,
    perEventBudget: l3Budget.perEventBudget,
    maxEvents: l3Budget.maxEvents,
    enabled: true
  });

  return {
    officialPaperSnapshot,
    qqqQuote,
    trackedSymbols,
    // Task 10: what the pool held BEYOND this run's news-fetch cap, and the cap
    // itself - rendered as a disclosure line, and counted as a degradation by
    // the conclusion box's confidence tier (Task 13).
    symbolsBeyondNewsLimit,
    newsSymbolLimit,
    marketNews,
    newsEvents,
    newsSearchDegraded: newsSearch.degraded,
    newsSearchReason: newsSearch.reason,
    l3DeepDive,
    newsWarnings: marketNewsResult.warnings,
    longbridgeWarnings,
    macroEvents,
    macroWarnings: macroCalendarResult.warnings,
    earningsCalendar,
    sourceEvidence: {
      fetchedAt,
      accountMode: officialPaperSnapshot.accountMode,
      longbridgeSessionStatus: officialPaperSnapshot.check.sessionStatus,
      longbridgeOkRegions: officialPaperSnapshot.check.okRegions,
      assetRows: officialPaperSnapshot.assets.length,
      officialPositions: officialPaperSnapshot.positions.length,
      trackedSymbols,
      symbolsBeyondNewsLimit,
      newsSymbolLimit,
      newsCount: marketNews.length,
      newsSourceBreakdown: summarizeNewsSourceBreakdown(marketNews),
      newsWarnings: marketNewsResult.warnings,
      longbridgeWarnings,
      macroEventsCount: macroEvents.length,
      macroWarnings: macroCalendarResult.warnings,
      earningsEventsCount: earningsCalendar.entries.length,
      earningsQueriedSymbols: earningsCalendar.queriedSymbols,
      earningsWarnings: earningsCalendar.skippedReason
        ? [earningsCalendar.skippedReason, ...earningsCalendar.warnings]
        : earningsCalendar.warnings,
      quoteSymbol: qqqQuote.symbol ?? "QQQ.US",
      quoteTimestamp: qqqQuote.timestamp ?? qqqQuote.post_market_quote?.timestamp ?? qqqQuote.pre_market_quote?.timestamp ?? null
    }
  };
}

async function fetchRequiredLongbridgeJson(category, args, label) {
  return runLongbridgeJsonWithRetry(category, args, { label });
}

function buildOfficialPaperSnapshotFromSettled({ checkResult, assetsResult, positionsResult, fetchedAt, warnings }) {
  const failures = [
    settledFailureLabel(checkResult, "连通性/令牌"),
    settledFailureLabel(assetsResult, "资产"),
    settledFailureLabel(positionsResult, "持仓")
  ].filter(Boolean);
  if (failures.length > 0) {
    warnings.push(`官方模拟盘读取降级：${failures.join("；")}`);
    return buildDegradedOfficialPaperSnapshot({
      fetchedAt,
      reason: failures.join("；")
    });
  }

  try {
    return normalizeOfficialPaperSnapshot({
      check: checkResult.value,
      assets: assetsResult.value,
      positions: positionsResult.value,
      fetchedAt
    });
  } catch (error) {
    const reason = singleLine(error?.message ?? error, 180);
    warnings.push(`官方模拟盘格式降级：${reason}`);
    return buildDegradedOfficialPaperSnapshot({ fetchedAt, reason });
  }
}

function buildQqqQuoteFromSettled({ quoteResult, fetchedAt, warnings }) {
  if (quoteResult.status === "rejected") {
    const reason = singleLine(quoteResult.reason?.message ?? quoteResult.reason, 180);
    warnings.push(`QQQ 行情读取降级：${reason}`);
    return buildDegradedQuoteSnapshot("QQQ.US", { fetchedAt, reason });
  }

  try {
    return normalizeQuotePayload(quoteResult.value, "QQQ.US");
  } catch (error) {
    const reason = singleLine(error?.message ?? error, 180);
    warnings.push(`QQQ 行情格式降级：${reason}`);
    return buildDegradedQuoteSnapshot("QQQ.US", { fetchedAt, reason });
  }
}

function settledFailureLabel(result, label) {
  if (result.status !== "rejected") {
    return "";
  }
  return `${label}失败：${singleLine(result.reason?.message ?? result.reason, 140)}`;
}

// Phase 4 Task 4: fetchMarketNews now delegates to news-sources.mjs's
// collectL1News instead of hand-rolling its own Promise.allSettled fan-out
// over 4 hardcoded sources. Behavior-preserving for the four pre-existing
// sources (same env var semantics, same "throw when everything came back
// empty" invariant) - RSSHub and Finnhub simply join the same pool as two
// more entries in collectL1News's source list, so they can only ADD
// articles/warnings, never change how the four original sources behave.
async function fetchMarketNews(symbols) {
  const { articles, warnings } = await collectL1News({ symbols, env: process.env });
  return { articles, warnings };
}

// Task H7 (2026-07-14 legacy audit): every OTHER required data source
// (official-paper snapshot, QQQ quote, each news feed) degrades gracefully
// via Promise.allSettled + a buildDegraded*/warnings path - this fetch had
// NO try/catch at all, and its caller (fetchRequiredReportMarketData)
// combined it with fetchMarketNews via a plain Promise.all, so an expired
// Longbridge token or unparseable CLI output (both non-transient, thrown on
// the FIRST attempt per _longbridge.mjs) crashed the entire daily/weekly
// report - exactly when the degradation notices would matter most. The
// quality gate already accepts "宏观日历降级" text (report-quality.mjs) and
// renderMarketIntelligence already renders an empty macroEvents list as
// "未来宏观日历没有返回高重要性事件" - this fetch just needed to stop being
// the one required source with no degradation path into that existing
// machinery.
export async function fetchMacroCalendar(info) {
  const start = info.label;
  const end = addDays(info.label, Number(process.env.REPORT_MACRO_LOOKAHEAD_DAYS ?? 14));
  try {
    const payload = await fetchRequiredLongbridgeJson("quote", [
      "finance-calendar",
      "macrodata",
      "--market",
      "US",
      "--star",
      "2",
      "--star",
      "3",
      "--start",
      start,
      "--end",
      end,
      "--count",
      String(Number(process.env.REPORT_MACRO_COUNT ?? 20))
    ], "Longbridge 美国宏观日历");
    return normalizeReportMacroCalendarPayload(payload);
  } catch (error) {
    const reason = singleLine(error?.message ?? error, 180);
    return { entries: [], warnings: [`宏观日历读取失败：${reason}`] };
  }
}

function formatQuoteTimestamp(quote) {
  const timestamps = [
    quote?.timestamp,
    quote?.post_market_quote?.timestamp,
    quote?.pre_market_quote?.timestamp
  ].filter(Boolean);
  return timestamps.length > 0 ? `行情时间 ${formatReportDateTime(timestamps[0])}` : "行情时间未提供";
}

// Task H7 (2026-07-14 legacy audit): the "长桥行情" marker never appeared in
// any rendered report - renderDataSourceSummary emitted "长桥 QQQ 行情"
// (note the space), which does not contain "长桥行情" as a contiguous
// substring. isPreparedReportMarkdownComplete therefore ALWAYS returned
// false on a genuine report, so every `deliver` regenerated the report from
// scratch (doubling every Longbridge/news/macro fetch), and
// a delivery-time-only outage would fail delivery even though a valid,
// already-quality-checked report sat on disk. Fix, chosen side: the
// RENDERER now emits "长桥行情" literally (see renderDataSourceSummary's
// "长桥行情（QQQ 行情）" text) so both markers are satisfied by the same
// phrase - the check itself is unchanged, keeping this list the single
// definition of "a prepared report has everything deliver needs" (see the
// seam test in scheduled-report.test.ts, which generates a real report via
// renderDailyReport/renderWeeklyReport and runs this exact function against
// it, so the two sides can never silently diverge again).
export function isPreparedReportMarkdownComplete(markdown) {
  const text = String(markdown ?? "");
  return [
    "长桥官方模拟盘",
    "多源新闻",
    // Task 20: was "宏观日历". A report prepared before the earnings half
    // existed is genuinely INCOMPLETE for today's deliver step, and the whole
    // point of this list is that `deliver` re-renders such a file rather than
    // shipping it. Note that "宏观与财报日历" does not contain "宏观日历" as a
    // contiguous substring - the old marker survived the rename only by
    // accidentally matching the `#### 宏观日历` sub-heading, which is exactly
    // the kind of coincidence the 长桥行情 story below is about.
    "宏观与财报日历",
    "长桥行情",
    "QQQ 行情"
  ].every((marker) => text.includes(marker));
}

// Places the link-verification disclosure where the report already keeps its
// other honesty lines: the tail-statistics block of 多源新闻（事件聚类）,
// directly beside 新闻来源分布/中文源占比/事件稀少提示. Falls back to the end
// of the document when that block is absent (legacy-format report), so the
// disclosure can never be silently dropped. Idempotent: re-delivering an
// already-disclosed report does not stack duplicate lines.
export function appendUrlVerificationDisclosure(markdown, disclosure) {
  const text = String(markdown ?? "");
  if (!disclosure || text.includes(disclosure)) {
    return text;
  }
  const lines = text.split("\n");
  const anchor = lines.findLastIndex((line) => line.trimStart().startsWith("- 中文源占比："));
  if (anchor === -1) {
    return `${text.replace(/\s*$/u, "")}\n\n${disclosure}\n`;
  }
  lines.splice(anchor + 1, 0, disclosure);
  return lines.join("\n");
}

export function resolveReportWindow(reportKind, explicitDate) {
  const label = explicitDate ?? formatDateLabel(new Date(), timezone);
  assertDateLabel(label);
  const startOffsetDays = reportKind === "daily" ? -1 : -7;
  const startLabel = addDays(label, startOffsetDays);
  return {
    kind: reportKind,
    label,
    startLabel,
    endLabel: label,
    start: new Date(`${startLabel}T20:00:00+08:00`),
    end: new Date(`${label}T20:00:00+08:00`)
  };
}

function isWithinWindow(value, info) {
  const ts = new Date(String(value)).getTime();
  return Number.isFinite(ts) && ts > info.start.getTime() && ts <= info.end.getTime();
}

/**
 * Every calendar date label whose daily_facts row falls inside `info`'s window
 * (Task 20's weekly summary input), oldest first.
 *
 * A daily run on date D writes `daily_facts.trading_day = D` at 20:00 Beijing
 * on D, which is the window's own boundary instant. The window is half-open
 * the same way isWithinWindow above is - `(start, end]` - so D = startLabel is
 * excluded and D = endLabel (this very run) is included.
 */
export function reportWindowDateLabels(info) {
  const labels = [];
  for (let label = addDays(info.startLabel, 1); label <= info.endLabel; label = addDays(label, 1)) {
    labels.push(label);
  }
  return labels;
}

function readWindowDailyFacts(db, info) {
  return reportWindowDateLabels(info).map((tradingDay) => ({
    tradingDay,
    facts: getDailyFacts(db, tradingDay)
  }));
}

/**
 * Task 21 (2026-07-28 spec-drift plan): the US-market-holiday guard.
 *
 * WHAT THE WINDOW ACTUALLY COVERS. A report labelled L spans
 * `(L-1 20:00, L 20:00]` Beijing (daily) or `(L-7 20:00, L 20:00]` (weekly).
 * Beijing 20:00 is 08:00 America/New_York the SAME date, so a daily report's
 * window brackets exactly one US regular session: the one on L-1. That is why
 * the daily cron is Tue-Sat Beijing - it covers Mon-Fri New York.
 *
 * On a full NYSE close there is no session in that window at all: no quote
 * moves, no session news, nothing for 影响路径 or 明日跟踪 to be about. The
 * report still rendered, with every section quietly describing the previous
 * session's stale numbers as if they were today's. The honest output is not a
 * thinner report, it is no report plus a stated reason.
 *
 * REFUSES TO GUESS. `isUsRegularTradingDate` answers `null` when
 * trading-schedule.mjs's holiday table has no data for that year, and a `null`
 * day counts as a POSSIBLE trading day here - an un-updated calendar rolling
 * into a new year must never be able to cancel a whole year of reports in
 * silence. The skip only ever fires on a date the calendar can positively
 * place.
 *
 * @returns {{ok: true, skipped: string, kind: string, label: string,
 *            coveredUsDates: string[], reason: string} | null}
 */
export function resolveUsMarketHolidaySkip(reportKind, info) {
  const coveredUsDates = reportWindowDateLabels(info).map((label) => addDays(label, -1));
  const openDates = coveredUsDates.filter((label) => isUsRegularTradingDate(label) !== false);
  if (openDates.length > 0) {
    return null;
  }
  return {
    ok: true,
    skipped: "us-market-holiday",
    kind: reportKind,
    label: info.label,
    coveredUsDates,
    reason: `窗口内的美股日期全部休市（${coveredUsDates.join("、")}），本次不产出${reportKind === "weekly" ? "周报" : "日报"}。`
  };
}

function formatWindow(info) {
  return `${info.startLabel} 20:00 - ${info.endLabel} 20:00（北京时间）`;
}

function formatReportDateTime(value) {
  const ts = new Date(String(value ?? "")).getTime();
  if (!Number.isFinite(ts)) {
    return "时间不可用";
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(ts));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`;
}

function formatDateLabel(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function addDays(label, days) {
  const [year, month, day] = label.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// C4: the state file is now READ, not only written - readDeliveredPersonalCards
// needs it to know which members already have this window's card. A missing or
// unparsable file is an empty state, never a crash: the file is runtime
// bookkeeping, and losing it must degrade to "send the cards" rather than kill
// the run.
//
// R7 (2026-07-28 verifier): both halves take the file path, and the module-level
// pair below binds it to the real runtime file. The idempotency guard only
// works if the key `updateState` WRITES is the key `readDeliveredPersonalCards`
// LOOKS UP - had `info.kind` ever been undefined, every run would have written
// `undefined:<date>` and quietly re-sent every card - and a test cannot exercise
// that agreement without going through an actual file. It must never be the
// production one, hence the parameter.
export function readDeliveryState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeDeliveryStateEntry(path, info, patch) {
  const state = readDeliveryState(path);

  const key = `${info.kind}:${info.label}`;
  state[key] = {
    ...(state[key] ?? {}),
    window: {
      start: info.start.toISOString(),
      end: info.end.toISOString(),
      label: formatWindow(info)
    },
    ...patch
  };
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

function readState() {
  return readDeliveryState(statePath);
}

function updateState(info, patch) {
  writeDeliveryStateEntry(statePath, info, patch);
}

function assertKind(value) {
  if (value === "daily" || value === "weekly") {
    return value;
  }
  throw new Error("Report kind must be daily or weekly.");
}

function assertAction(value) {
  if (value === "prepare" || value === "deliver" || value === "run") {
    return value;
  }
  throw new Error("Report action must be prepare, deliver, or run.");
}

function assertDateLabel(value) {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(String(value))) {
    return;
  }
  throw new Error(`Report date must use YYYY-MM-DD format; received ${JSON.stringify(value)}.`);
}

function singleLine(value, maxChars = 260) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function splitCsv(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function formatOptionalNumber(value, digits = 2) {
  return value === undefined ? "不可用" : formatNumber(value, digits);
}

function formatNumber(value, digits = 2) {
  return Number(value).toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  });
}

function formatPercent(value) {
  return Number(value).toLocaleString("en-US", {
    style: "percent",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  });
}

// ---------------------------------------------------------------------------
// CLI entry point - MUST remain the LAST statement in this module.
// ---------------------------------------------------------------------------
// 2026-07-26 regression fix: this dispatch used to sit near the TOP of the
// file (right below the `let kind/action/...` declarations, ~line 65). It
// contains a top-level `await`, so running the file as a CLI SUSPENDED module
// evaluation at that point and executed the entire report pipeline while
// every top-level binding declared further down was still in its temporal
// dead zone. `function` declarations are hoisted, so prepareReport ->
// renderDailyReport -> renderClusteredNewsSection -> deriveChannelLabel all
// resolved fine - but `const CHANNEL_LABELS`, declared ~980 lines BELOW the
// old dispatch site, had not been initialized yet, so every daily/weekly run
// that clustered at least one news event died with:
//   ReferenceError: Cannot access 'CHANNEL_LABELS' before initialization
// It was invisible to `import`-based tests and to a bare module load: for any
// importer `isMainModule` is false, the block is skipped, evaluation runs to
// completion, and CHANNEL_LABELS ends up initialized. Only the real CLI path
// hit it, and only when the news section had events to render - which is why
// it looked like a phantom circular import (it is not one; the module graph
// reachable from here has no cycle back into this file).
// Keeping the dispatch LAST means the module body is always fully evaluated
// before any of it runs, which makes the hazard structurally impossible
// rather than order-dependent. cli-entry-order.test.ts enforces this for
// every CLI script in this directory.
const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  const [kindArg = "daily", actionArg = "run", dateArg] = process.argv.slice(2).filter((arg) => arg !== "--");
  kind = assertKind(kindArg);
  action = assertAction(actionArg);
  windowInfo = resolveReportWindow(kind, dateArg);
  reportPath = join(repoRoot, "reports", kind, `${windowInfo.label}.md`);

  // Task 21: the US-holiday guard runs BEFORE any directory is created, any
  // upstream is called and any file is written - a skipped run must leave no
  // half-made report behind. Prints the same `{ok, skipped, reason}` envelope
  // stock-analysis.mjs's own not_due skip prints, so the cron runner records a
  // successful, self-explaining run rather than a mystery no-op.
  const holidaySkip = resolveUsMarketHolidaySkip(kind, windowInfo);
  if (holidaySkip) {
    console.log(JSON.stringify(holidaySkip));
    process.exit(0);
  }

  mkdirSync(join(repoRoot, "reports", kind), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });

  if (action === "prepare") {
    const report = await prepareReport(kind, windowInfo);
    console.log(report.path);
  } else if (action === "deliver") {
    await deliverReport(kind, windowInfo, false);
  } else {
    await prepareReport(kind, windowInfo);
    await deliverReport(kind, windowInfo, true);
  }
}
