// Task H7 (2026-07-14 legacy audit): install-user-schedules.mjs (direct
// launchd plists) and install-openclaw-cron.mjs (openclaw cron jobs run
// through the com.openclaw.trading.cron-runner launchd service) used to
// each hardcode their OWN copy of this exact list of 5 labels - one script
// installed them as plists, the other retired those SAME plists in favor of
// its cron-runner equivalents. Whichever installer ran SECOND silently
// undid the first: running `openclaw:cron:install` then (re-)running
// `launchd:install-user` (the documented fix for a machine that's missing
// the official-paper polling jobs, which ONLY install-user-schedules.mjs
// installs) resurrected the 5 "retired" jobs, so both channels fired and
// every daily/weekly/stock-analysis report was generated and delivered
// TWICE.
//
// docs/superpowers/specs/2026-06-14-openclaw-report-quality-cron-design.md
// is explicit that the openclaw cron channel, not direct launchd, is meant
// to own scheduled report production going forward. Single-sourcing this
// list means install-user-schedules.mjs no longer installs these jobs at
// all (see its own comment) - it only imports this list to defensively
// retire them (idempotent if install-openclaw-cron.mjs already did) - and
// install-openclaw-cron.mjs imports the exact same list to retire. Neither
// script can drift from the other because there is only one array to edit.
export const MANAGED_REPORT_LAUNCHD_LABELS = [
  "com.openclaw.trading.report.daily.prepare",
  "com.openclaw.trading.report.daily.deliver",
  "com.openclaw.trading.report.weekly.prepare",
  "com.openclaw.trading.report.weekly.deliver",
  "com.openclaw.trading.stock-analysis"
];
