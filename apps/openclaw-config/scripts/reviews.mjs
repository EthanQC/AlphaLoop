#!/usr/bin/env node
// Monthly review CLI (Phase 9 Task 3, 2026-07-16 plan): generate / confirm /
// list / show over MonthlyReviewRepository (Task 1) + review-engine.mjs's
// buildMonthlyReview (Task 2, the primary engine) + review-verifier.mjs's
// recomputeReviewMetrics/compareReviewMetrics (Task 3, the INDEPENDENT
// verifier). Conventions follow members.mjs/proposals.mjs/strategy.mjs
// EXACTLY (task brief): a single `buildCliResult` JSON envelope wrapping
// argv-parsing through dispatch, per-command flag allowlists (H6 pattern - a
// flag real for a DIFFERENT subcommand fails loud with "未知参数" instead of
// silently parsing and never being read), Chinese error messages, a non-zero
// exit on error, an audit_log row per mutating command (category
// `monthly_review`), and a `REVIEWS_DB_PATH` env override mirroring
// members.mjs's `MEMBERS_DB_PATH`.
//
// ---------------------------------------------------------------------------
// THE VERIFIER IS THE DELIVERY GATE, AT RUNTIME, NOT JUST IN A TEST FILE
// ---------------------------------------------------------------------------
// `generate` does not just call buildMonthlyReview and save the result. It
// ALSO calls recomputeReviewMetrics (review-verifier.mjs's independent
// second implementation) against the SAME db/owner/period/now, diffs the two
// via compareReviewMetrics, and REFUSES TO SAVE - throwing an error that
// lists every disagreement - if even one headline number does not match.
// This is what makes the verifier load-bearing in production, not merely a
// test-time cross-check: a primary-engine bug that would have fabricated a
// number never reaches a saved draft, because this CLI is the one and only
// place `buildMonthlyReview`'s output is persisted.
//
// ---------------------------------------------------------------------------
// Cross-app helper wiring (review-engine.mjs's own `helpers` contract)
// ---------------------------------------------------------------------------
// review-engine.mjs's own header explains why `loadLatestPriceForSymbol`/
// `computeComplianceStats` are TS-only (apps/platform-app/src/data/
// strategy.ts) and arrive via an injected `helpers` object rather than a
// direct import - and says the real runtime wiring for that cross-app
// boundary is THIS task's job. The bridge used here is the SAME one
// members.mjs already uses for packages/shared-types (`.../dist/index.js`):
// apps/platform-app builds a `dist/` (its own package.json `build`
// script, `tsc -p tsconfig.json`, wired into the repo's `pnpm -r run build`)
// - this file imports the COMPILED artifact, never the TypeScript source,
// so plain `node reviews.mjs ...` (no ts-node/tsx loader) can run it
// directly. `pnpm build` must have run first for this import to resolve;
// the repo's CI (`pnpm build` then `pnpm test`) and this task's own
// verification checklist both already guarantee that ordering.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AuditLogRepository,
  MemberRepository,
  MonthlyReviewRepository,
  loadLocalEnv,
  nowIso,
  openTradingDatabase,
  resolveRuntimePaths
} from "../../../packages/shared-types/dist/index.js";

import { computeComplianceStats, loadLatestPriceForSymbol } from "../../platform-app/dist/data/strategy.js";

import { composeReviewConfirmCardLines, createFeishuReviewNotifier } from "./feishu-review-notifier.mjs";
import { createMemorydBackend, mirrorRecord } from "./memoryd-mirror.mjs";
import { buildMonthlyReview } from "./review-engine.mjs";
import { compareReviewMetrics, recomputeReviewMetrics } from "./review-verifier.mjs";
import { computeThesisOutcome } from "./thesis-outcome.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const PERIOD_PATTERN = /^\d{4}-\d{2}$/;

// notify-test's mode switches are this CLI's only genuine boolean/no-value
// flags (every other flag always expects a value) - same explicit-set
// convention as members.mjs.
const BOOLEAN_FLAGS = new Set(["dry-run", "send"]);

// Per-command flag allowlist (H6 pattern, members.mjs/proposals.mjs/
// strategy.mjs): scoped PER SUBCOMMAND so a flag real for a different
// subcommand fails loud with "未知参数" instead of parsing fine and then
// silently never being read.
const COMMAND_FLAGS = {
  generate: new Set(["owner", "period"]),
  "generate-all": new Set(["period"]),
  confirm: new Set(["owner", "review"]),
  list: new Set(["owner"]),
  show: new Set(["owner", "review"]),
  "notify-test": new Set(["owner", "review", "dry-run", "send"])
};

/**
 * Parses `--flag value` pairs from an argv slice (after the subcommand).
 * Mirrors members.mjs/proposals.mjs/strategy.mjs's parseFlags exactly.
 *
 * @param {string[]} argv
 * @param {string} [command]
 */
export function parseFlags(argv, command) {
  const allowedFlags = COMMAND_FLAGS[command] ?? new Set();
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const name = token.slice(2);
    if (!allowedFlags.has(name)) {
      throw new Error(`未知参数：--${name}。`);
    }
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = "";
    } else {
      flags[name] = next;
      i += 1;
    }
  }
  return flags;
}

export function resolveCommand(argv) {
  return argv[0] ?? "";
}

function requireFlag(flags, name) {
  const value = String(flags[name] ?? "").trim();
  if (!value) {
    throw new Error(`缺少 --${name} 参数。`);
  }
  return value;
}

function validatePeriod(period) {
  if (!PERIOD_PATTERN.test(period)) {
    throw new Error(`--period 必须是 YYYY-MM 格式，收到：${period}。`);
  }
  return period;
}

async function withDb(options, fn) {
  const db = openTradingDatabase(options.dbPath);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

function requireActiveMember(db, ownerId) {
  const member = new MemberRepository(db).getById(ownerId);
  if (!member) {
    throw new Error(`成员不存在：${ownerId}。`);
  }
  if (member.status !== "active") {
    throw new Error(`成员已被吊销，无法生成复盘：${ownerId}。`);
  }
  return member;
}

// -----------------------------------------------------------------------
// Beijing-calendar "previous month" (for `generate-all`'s default period -
// see runGenerateAll's own doc comment for why "previous month", not "this
// month"). Pure UTC+8 offset arithmetic - Beijing has no DST, mirroring
// review-engine.mjs's own beijingMonthUtcRange convention.
// -----------------------------------------------------------------------

function previousBeijingPeriod(nowValue) {
  const shifted = new Date(new Date(nowValue).getTime() + 8 * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const currentMonth = shifted.getUTCMonth() + 1; // 1-12, current Beijing calendar month
  const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
  const prevYear = currentMonth === 1 ? year - 1 : year;
  return `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
}

// -----------------------------------------------------------------------
// Feishu single-chat delivery of a confirmed review's summary card - REAL
// since the P10 wiring: the default notifier is
// feishu-review-notifier.mjs's createFeishuReviewNotifier({db}), which looks
// up the owner's members.feishu_open_id and delivers over the exact
// sendInteractiveCard channel market-alerts-cards.mjs already uses in
// production. A member with no open_id on file degrades to an honest
// {delivered:false, reason} - correct and intended, since confirm's SQL
// status change has already committed regardless of whether this
// notification goes out.
// -----------------------------------------------------------------------

// Fire-and-forget wrapper around the injected notifier - never throws/
// rejects, mirrors memoryd-mirror.mjs's mirrorRecord discipline exactly
// (backend throw/reject/`{ok:false}` all degrade to a warned, honest
// `{delivered:false, reason}` instead of propagating to confirm's caller).
async function notifyFeishuReviewConfirmed(notifier, { ownerId, review }) {
  try {
    const result = await notifier({
      ownerId,
      title: `${review.period} 月度复盘已确认`,
      lines: composeReviewConfirmCardLines({
        id: review.id,
        period: review.period,
        confirmedAt: review.confirmedAt ?? null,
        result: review.resultJson
      })
    });
    if (result?.ok) {
      return { delivered: true, messageId: result.messageId ?? null };
    }
    const reason = result?.reason ? String(result.reason) : "feishu notifier returned ok:false";
    console.warn(`飞书单聊复盘确认通知跳过（owner=${ownerId}）：${reason}`);
    return { delivered: false, reason };
  } catch (error) {
    const reason = String(error?.message ?? error);
    console.warn(`飞书单聊复盘确认通知跳过（owner=${ownerId}）：${reason}`);
    return { delivered: false, reason };
  }
}

// -----------------------------------------------------------------------
// generate: buildMonthlyReview (primary) -> recomputeReviewMetrics
// (verifier, SAME db/owner/period/now) -> compareReviewMetrics. Any
// disagreement REFUSES to save (throws, listing every mismatch) - see this
// module's header for why this makes the verifier load-bearing at runtime.
// -----------------------------------------------------------------------

async function generateForOwner(db, ownerId, period, options) {
  requireActiveMember(db, ownerId);

  const now = options.now ?? nowIso();
  const helpers = { computeThesisOutcome, loadLatestPriceForSymbol, computeComplianceStats };

  const primaryResult = buildMonthlyReview({ db, ownerId, period, now, helpers });
  const verifierResult = recomputeReviewMetrics({ db, ownerId, period, now });
  const mismatches = compareReviewMetrics(primaryResult, verifierResult);

  if (mismatches.length > 0) {
    throw new Error(
      `独立验证器与主复盘引擎的头条数字不一致，拒绝保存复盘草稿（owner=${ownerId}, period=${period}）：${JSON.stringify(mismatches)}`
    );
  }

  const review = new MonthlyReviewRepository(db).upsertDraft({ ownerId, period, resultJson: primaryResult });

  new AuditLogRepository(db).write("monthly_review", "generate", {
    reviewId: review.id,
    ownerId,
    period,
    selfCheck: "consistent"
  });

  return { ok: true, review, selfCheck: { consistent: true, mismatches: [] } };
}

export async function runGenerate(flags, options = {}) {
  const ownerId = requireFlag(flags, "owner");
  const period = validatePeriod(requireFlag(flags, "period"));

  return withDb(options, (db) => generateForOwner(db, ownerId, period, options));
}

// `generate-all`: the cron-facing batch entry point (mirrors proposals.mjs's
// `sweep` - a distinct subcommand from the single-target one, not an
// overloaded `--owner`-optional `generate`). Iterates every ACTIVE member
// (MemberRepository.listActive()) and generates one draft each for the SAME
// period, defaulting (when `--period` is omitted, as the monthly cron always
// omits it) to the PREVIOUS Beijing calendar month - a review generated on
// the first weekend of a new month should cover the month that JUST ENDED
// (decisionReview/alertQuality are period-scoped to "what happened this
// month"; generating a review for the brand-new month it runs in would
// always show empty data). A single owner's failure (self-check
// disagreement, revoked membership, anything else) is caught and recorded
// per-owner, never aborting the rest of the batch - mirrors proposals.mjs's
// runSweep's own per-row resilience for the exact same reason (a cron sweep
// must not let one bad row block everyone else's draft).
export async function runGenerateAll(flags, options = {}) {
  const nowValue = options.now ?? nowIso();
  let period = flags.period !== undefined ? String(flags.period).trim() : "";
  if (!period) {
    period = previousBeijingPeriod(nowValue);
  } else {
    validatePeriod(period);
  }

  return withDb(options, async (db) => {
    const members = new MemberRepository(db).listActive();
    const results = [];
    for (const member of members) {
      try {
        const result = await generateForOwner(db, member.id, period, { ...options, now: nowValue });
        results.push({ ownerId: member.id, ok: true, reviewId: result.review.id });
      } catch (error) {
        results.push({ ownerId: member.id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { ok: true, period, generated: results.filter((r) => r.ok).length, total: members.length, results };
  });
}

// -----------------------------------------------------------------------
// confirm: MonthlyReviewRepository.confirm (owner-gated, one-way draft ->
// confirmed) -> memoryd mirror (type=decision, fire-and-forget) + Feishu
// single-chat card (fire-and-forget). Neither post-confirm side effect can
// ever undo or fail the confirm itself - the SQL status change has already
// committed by the time either is attempted.
// -----------------------------------------------------------------------

export async function runConfirm(flags, options = {}) {
  const ownerId = requireFlag(flags, "owner");
  const reviewId = requireFlag(flags, "review");

  return withDb(options, async (db) => {
    const review = new MonthlyReviewRepository(db).confirm(reviewId, ownerId);

    const summary =
      review.resultJson && typeof review.resultJson === "object" && !Array.isArray(review.resultJson) ? review.resultJson : {};

    const memorydBackend = options.memorydBackend ?? createMemorydBackend();
    const mirror = await mirrorRecord(memorydBackend, {
      ownerId,
      recordType: "monthly_review",
      title: `${review.period} 月度复盘结论`,
      content: JSON.stringify({
        period: review.period,
        oneLineLesson: summary.oneLineLesson ?? null,
        errorCategories: summary.errorCategories ?? [],
        nextSteps: summary.nextSteps ?? []
      }),
      visibility: "private"
    });

    const feishuNotifier = options.feishuNotifier ?? createFeishuReviewNotifier({ db });
    const notify = await notifyFeishuReviewConfirmed(feishuNotifier, { ownerId, review });

    new AuditLogRepository(db).write("monthly_review", "confirm", {
      reviewId: review.id,
      ownerId,
      period: review.period,
      mirrored: mirror.mirrored,
      notified: notify.delivered
    });

    return { ok: true, review, mirror, notify };
  });
}

// -----------------------------------------------------------------------
// notify-test: operator smoke command for the review confirm card channel
// (`pnpm reviews:notify-test -- --owner <id> [--review <id>] [--dry-run|--send]`).
// Composes the EXACT same 月度复盘确认摘要 card the confirm path sends (via the
// owner's latest review, or --review, or a clearly-labeled placeholder card
// when the owner has no reviews yet) so an operator can live-verify one real
// card send end to end. --dry-run (the default) only reports the composed
// card + whether feishu_open_id resolves - it never sends anything; --send
// delivers for real through createFeishuReviewNotifier({db})'s default
// transport (requires FEISHU_APP_ID/FEISHU_APP_SECRET, loaded from
// .env.local by main()'s loadLocalEnv).
// -----------------------------------------------------------------------

export async function runNotifyTest(flags, options = {}) {
  const ownerId = requireFlag(flags, "owner");
  const dryRunFlag = Boolean(flags["dry-run"]);
  const sendFlag = Boolean(flags.send);
  if (dryRunFlag && sendFlag) {
    throw new Error("--dry-run 与 --send 只能二选一。");
  }
  const mode = sendFlag ? "send" : "dry-run";

  return withDb(options, async (db) => {
    const member = new MemberRepository(db).getById(ownerId);
    if (!member) {
      throw new Error(`成员不存在：${ownerId}。`);
    }

    const reviewRepo = new MonthlyReviewRepository(db);
    let review = null;
    const requestedReviewId = String(flags.review ?? "").trim();
    if (requestedReviewId) {
      review = reviewRepo.getById(requestedReviewId);
      if (!review) {
        throw new Error(`复盘不存在：${requestedReviewId}。`);
      }
      // Same owner-gate as `show`: a review is private to its own owner.
      if (review.ownerId !== ownerId) {
        throw new Error(`非本人操作被拒：该复盘属于 ${review.ownerId}，操作者 ${ownerId} 无权使用。`);
      }
    } else {
      // listForOwner orders by period DESC - [0] is the latest review.
      review = reviewRepo.listForOwner(ownerId)[0] ?? null;
    }

    const card = review
      ? {
          title: `${review.period} 月度复盘已确认`,
          lines: composeReviewConfirmCardLines({
            id: review.id,
            period: review.period,
            confirmedAt: review.confirmedAt ?? null,
            result: review.resultJson
          })
        }
      : {
          // No review row for this owner yet - still send SOMETHING honest so
          // the channel itself can be smoke-verified, clearly labeled a test.
          title: "飞书复盘通知通道测试",
          lines: [
            "这是一条复盘确认摘要卡的通道测试（该成员暂无复盘记录，使用占位内容）。",
            `成员：${ownerId}`,
            `发送时间：${options.now ?? nowIso()}`
          ]
        };

    if (mode === "dry-run") {
      return { ok: true, mode, ownerId, feishuOpenId: member.feishuOpenId ?? null, reviewId: review?.id ?? null, card };
    }

    const notifier = options.feishuNotifier ?? createFeishuReviewNotifier({ db });
    const sent = await notifier({ ownerId, title: card.title, lines: card.lines });
    const delivered = sent?.ok === true;

    new AuditLogRepository(db).write("monthly_review", "notify-test", {
      ownerId,
      reviewId: review?.id ?? null,
      delivered
    });

    if (delivered) {
      return { ok: true, mode, ownerId, reviewId: review?.id ?? null, delivered: true, messageId: sent.messageId ?? null };
    }
    // A failed live send must be VISIBLE (non-zero exit via main()'s
    // ok===false check), unlike confirm's fire-and-forget degrade - the whole
    // point of this command is to verify delivery.
    return {
      ok: false,
      mode,
      ownerId,
      reviewId: review?.id ?? null,
      delivered: false,
      error: sent?.reason ? String(sent.reason) : "飞书卡片发送失败。"
    };
  });
}

// Read-only - no audit_log row, matching members.mjs/strategy.mjs's runList
// convention.
export async function runList(flags, options = {}) {
  const ownerId = requireFlag(flags, "owner");
  return withDb(options, (db) => ({ ok: true, reviews: new MonthlyReviewRepository(db).listForOwner(ownerId) }));
}

export async function runShow(flags, options = {}) {
  const ownerId = requireFlag(flags, "owner");
  const reviewId = requireFlag(flags, "review");

  return withDb(options, (db) => {
    const review = new MonthlyReviewRepository(db).getById(reviewId);
    if (!review) {
      throw new Error(`复盘不存在：${reviewId}。`);
    }
    // Owner enforcement: THE negative test this command exists to pin down -
    // a review is always private to its own owner, never readable by anyone
    // else (plan Global Constraint: "隔离铁律...复盘页/列表 B 看不到 A 的").
    if (review.ownerId !== ownerId) {
      throw new Error(`非本人操作被拒：该复盘属于 ${review.ownerId}，操作者 ${ownerId} 无权查看。`);
    }
    return { ok: true, review };
  });
}

const COMMANDS = {
  generate: runGenerate,
  "generate-all": runGenerateAll,
  confirm: runConfirm,
  list: runList,
  show: runShow,
  "notify-test": runNotifyTest
};

export async function runReviewsCommand(command, flags, options = {}) {
  const handler = COMMANDS[command];
  if (!handler) {
    throw new Error(`未知子命令：${command || "(空)"}，仅支持 ${Object.keys(COMMANDS).join("/")}。`);
  }
  return handler(flags, options);
}

// Same pre-dispatch-through-dispatch-in-one-try/catch shape as members.mjs/
// proposals.mjs/strategy.mjs's buildCliResult: this CLI's binding contract is
// always exactly one line of JSON on stdout, so nothing (an unknown flag, an
// unknown command, a validation error, a self-check refusal) may escape as a
// raw stack trace.
export async function buildCliResult(argv, options = {}) {
  try {
    const command = resolveCommand(argv);
    const rest = argv.slice(command ? 1 : 0);
    const flags = parseFlags(rest, command);
    // REVIEWS_DB_PATH mirrors members.mjs's MEMBERS_DB_PATH: unset (and a
    // no-op) in normal operation, where the real runtime/trading.sqlite is
    // used; lets a live/manual verification run this exact binary against a
    // disposable temp db instead.
    const dbPath = options.dbPath ?? process.env.REVIEWS_DB_PATH ?? resolveRuntimePaths(repoRoot).dbPath;
    return await runReviewsCommand(command, flags, { ...options, dbPath });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  // Real Feishu delivery (confirm's default notifier, notify-test --send)
  // needs FEISHU_APP_ID/FEISHU_APP_SECRET from .env.local - same startup
  // convention as market-alerts-poll.mjs/feishu-context.mjs. Done here (CLI
  // entry only) rather than at module top so importing this module in tests
  // stays side-effect free.
  loadLocalEnv(repoRoot);
  const result = await buildCliResult(process.argv.slice(2));
  console.log(JSON.stringify(result));
  if (result.ok === false) {
    process.exitCode = 1;
  }
}

const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  await main();
}
