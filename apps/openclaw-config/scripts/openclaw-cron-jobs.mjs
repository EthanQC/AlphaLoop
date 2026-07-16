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
      // 每人一份 per-owner". Standard cron has no "first weekend of the
      // month" field, so this is built from the two fields it DOES have:
      // day-of-month 1-7 (the first calendar week) AND day-of-week 6,0
      // (Saturday, Sunday) - the intersection of "within the first 7 days"
      // and "a Saturday or Sunday" is exactly the month's first weekend,
      // whether that weekend is entirely inside days 1-7 (one Sat + one Sun)
      // or straddles day 7/8 (only one of the two falls inside this window -
      // still the first weekend day that DOES fall in it). This can fire
      // TWICE in months where both the first Saturday and first Sunday land
      // within days 1-7 - harmless, since `pnpm reviews:generate` runs
      // `reviews.mjs generate-all`, and MonthlyReviewRepository.upsertDraft
      // is an idempotent overwrite-the-draft upsert (Task 1), not an
      // append; a second same-period run just re-generates the same draft
      // (or is a no-op per owner if a review was already confirmed - see
      // that command's own per-owner error handling, which does not abort
      // the batch).
      //
      // "pnpm reviews:generate" (matching this plan's literal cron-job name)
      // maps to `reviews.mjs generate-all` (see package.json) - the
      // per-member BATCH entry point, deliberately a DIFFERENT reviews.mjs
      // subcommand than the single-owner `generate` (mirrors proposals.mjs's
      // own `sweep` being a distinct subcommand from its single-target
      // decision commands).
      name: "openclaw-trading-monthly-review",
      description: "OpenClaw-owned monthly per-owner review draft generation (first weekend of the month).",
      cron: "0 10 1-7 * 6,0",
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
