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
