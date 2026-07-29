export function buildManagedOpenClawCronJobs(repoRoot) {
  const root = String(repoRoot ?? "").trim();
  if (!root) {
    throw new Error("repoRoot is required to build OpenClaw cron jobs.");
  }

  return [
    {
      name: "openclaw-trading-daily-report",
      description: "OpenClaw-owned daily trading report with quality validation.",
      cron: "0 20 * * 2-6",
      timezone: "Asia/Shanghai",
      agent: "control",
      session: "main",
      wake: "next-heartbeat",
      timeoutSeconds: 900,
      systemEvent: buildScheduleMarker(root, "pnpm report:daily:run", "daily report quality pipeline")
    },
    {
      name: "openclaw-trading-weekly-report",
      description: "OpenClaw-owned weekly trading report with quality validation.",
      cron: "0 20 * * 1",
      timezone: "Asia/Shanghai",
      agent: "control",
      session: "main",
      wake: "next-heartbeat",
      timeoutSeconds: 900,
      systemEvent: buildScheduleMarker(root, "pnpm report:weekly:run", "weekly report quality pipeline")
    },
    {
      name: "openclaw-trading-stock-analysis",
      description: "OpenClaw-owned scheduled stock analysis with quality validation.",
      cron: "0 21 * * *",
      timezone: "Asia/Shanghai",
      agent: "control",
      session: "main",
      wake: "next-heartbeat",
      timeoutSeconds: 1200,
      systemEvent: buildScheduleMarker(root, "pnpm stock-analysis:scheduled", "stock-analysis quality pipeline")
    },
    {
      // Phase 6 Task 3 (2026-07-15 plan): the expiry sweep for pending
      // proposals - listPendingExpired -> consumeApproval(decision:'expired')
      // -> card re-render "已过期". Hourly (not daily) because a proposal's
      // expiry window is 24h from creation, not pinned to a fixed clock time -
      // an hourly cadence keeps a lapsed proposal's card from sitting stale
      // for the better part of a day. Races safely with a concurrent human
      // click on the same token (Task 1's atomic consumeApproval already
      // decides the winner; proposals.mjs's sweep skips gracefully on a loss).
      name: "openclaw-trading-proposal-sweep",
      description: "OpenClaw-owned hourly sweep of expired trading proposals.",
      cron: "0 * * * *",
      timezone: "Asia/Shanghai",
      agent: "control",
      session: "main",
      wake: "next-heartbeat",
      timeoutSeconds: 120,
      systemEvent: buildScheduleMarker(root, "pnpm proposals:sweep", "proposal-expiry sweep")
    },
    {
      // Phase 9 Task 3 (2026-07-16 plan, review flywheel): monthly per-owner
      // review draft generation - plan's literal spec: "每月第一个周末生成、
      // 每人一份 per-owner".
      //
      // Task 21 (2026-07-28 spec-drift plan) - THE "FIRST WEEKEND" IS NOT IN
      // THIS EXPRESSION AND CANNOT BE. This used to read `0 10 1-7 * 6,0`,
      // with a comment calling the day-of-month and day-of-week fields "the
      // intersection of within the first 7 days and a Saturday or Sunday".
      // Cron does not intersect those two fields. OpenClaw schedules through
      // croner, whose `legacyMode` default implements the POSIX/Vixie rule -
      // when BOTH fields are restricted, a run fires when EITHER matches.
      // Enumerated against the croner build installed on the deployed mini,
      // `0 10 1-7 * 6,0` produced 14 runs in August 2026 (Aug 1-9, then every
      // weekend). The expression below restricts only day-of-week, so it
      // means the same thing under either reading, and the "first weekend"
      // half is a real, testable guard in the command itself:
      // trading-schedule.mjs's `isFirstWeekendOfMonth`, checked at the top of
      // reviews.mjs's `runGenerateAll`, which answers
      // `{ok:true, skipped:"not-first-weekend"}` on the other ~8 weekend days
      // a month. A skipped run is cheap (it opens the db, checks the date and
      // returns) and, unlike a cron field, it is covered by a test.
      //
      // Firing on both days of that first weekend is harmless: `pnpm
      // reviews:generate` runs `reviews.mjs generate-all`, and
      // MonthlyReviewRepository.upsertDraft is an idempotent
      // overwrite-the-draft upsert (Task 1), not an append; a second
      // same-period run just re-generates the same draft (or is a no-op per
      // owner if a review was already confirmed - see that command's own
      // per-owner error handling, which does not abort the batch).
      //
      // "pnpm reviews:generate" (matching this plan's literal cron-job name)
      // maps to `reviews.mjs generate-all` (see package.json) - the
      // per-member BATCH entry point, deliberately a DIFFERENT reviews.mjs
      // subcommand than the single-owner `generate` (mirrors proposals.mjs's
      // own `sweep` being a distinct subcommand from its single-target
      // decision commands).
      name: "openclaw-trading-monthly-review",
      description: "OpenClaw-owned monthly per-owner review draft generation (first weekend of the month).",
      cron: "0 10 * * 6,0",
      timezone: "Asia/Shanghai",
      agent: "control",
      session: "main",
      wake: "next-heartbeat",
      timeoutSeconds: 300,
      systemEvent: buildScheduleMarker(root, "pnpm reviews:generate", "monthly per-owner review draft generation")
    }
  ];
}

function buildScheduleMarker(repoRoot, command, label) {
  return [
    `OpenClaw cron schedule marker for the ${label}.`,
    `The local OpenClaw cron runner watches this run log and executes: cd ${repoRoot} && ${command}`,
    "Do not execute this command from the main agent turn; the repository runner owns execution, report validation, and delivery.",
    "Do not submit live-money orders. Keep all trading actions within the project safety constitution."
  ].join("\n");
}
