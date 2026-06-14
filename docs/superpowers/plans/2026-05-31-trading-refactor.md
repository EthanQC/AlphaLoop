# Trading Stack Refactor Plan - 2026-05-31

## Goal

Keep only the main branch and reduce the product surface to four Chinese Feishu-facing capabilities:

1. Daily and weekly market reports.
2. Batch stock analysis reports.
3. Official Longbridge paper-account monitoring and paper execution within a 10% budget.
4. Normal OpenClaw replies when mentioned in the allowlisted Feishu group.

Everything else should be removed from exposed scripts, agents, launchd jobs, and package references.

## Constraints

- Never submit live-money orders.
- Official paper execution requires `LONGBRIDGE_ACCOUNT_MODE=paper`, `LONGBRIDGE_OFFICIAL_PAPER_ENABLED=true`, and `ALLOW_LIVE_EXECUTION=false`.
- Do not persist broker credentials, OAuth tokens, or private keys in reports or memory.
- Trading facts stay in SQLite; Markdown is context and report material only.
- Only `broker-executor` may translate tickets into broker writes.
- Feishu group access stays allowlisted.
- All pushed group content is Chinese.

## Implementation Steps

- [x] Record the branch cleanup state and prune exposed package scripts to the four retained capabilities.
- [x] Add tests for:
  - report scheduling: daily Tue-Fri 20:00, weekly Monday 20:00;
  - stock analysis cadence: every third day at 21:00;
  - US market-time windows with DST;
  - official paper environment and 10% budget guards;
  - Feishu report delivery mode as PDF plus summary card.
- [x] Add a Feishu-derived stock analysis template under `knowledge/notes/stock-trading-notes`.
- [x] Add deterministic scripts for:
  - stock analysis target management and scheduled report delivery;
  - official paper hourly polling and post-open P&L report delivery;
  - launchd user schedules for the retained jobs only.
- [x] Replace local paper-sim fallback with official-paper rejection unless the exact safe environment is present.
- [x] Remove old live-advisor, event ingestion, rule proposal, context maintenance, source-request, and local paper-sim surfaces from package scripts, OpenClaw config, launchd templates, and TypeScript references.
- [x] Run tests, typecheck, build, smoke health checks, launchd checks, and static diff checks.
- [x] Complete independent code review and fix Critical findings before commit or push.
- [x] Fix review follow-ups that affect runtime safety:
  - exact `ALLOW_LIVE_EXECUTION=false` guard for official paper writes;
  - broker-executor ignores caller-supplied exposure metadata and requires a fresh trusted SQLite official-paper snapshot;
  - report fallback disabled because fallback cannot guarantee PDF delivery;
  - old user-level launchd labels are retired during install;
  - Feishu group replies default to require mention;
  - execution reports and broker rejection reasons are Chinese;
  - daily/weekly reports load the `daily-routine.md` checklist;
  - NYSE 2026 holidays and early-close dates are applied to official-paper polling/P&L windows.
  - stock analysis adds read-only Yahoo chart/quote/options supplements for 6-month trend, 180-day moving average, PE/PB, and nearest option-chain context.

## Progress Evidence

- Branch state checked: only `main`, `origin/main`, and `origin/HEAD -> origin/main` remain.
- Feishu history read and normalized: 1294 messages, 26 pages, 2025-01-10 through 2026-05-31.
- Feishu-derived context written to `knowledge/notes/stock-trading-notes/feishu-history-insights.md`.
- Stock analysis template written to `knowledge/notes/stock-trading-notes/stock-analysis-template.md`.
- User launchd schedules reinstalled; active retained jobs:
  - `com.openclaw.trading.report.daily.prepare`
  - `com.openclaw.trading.report.daily.deliver`
  - `com.openclaw.trading.report.weekly.prepare`
  - `com.openclaw.trading.report.weekly.deliver`
  - `com.openclaw.trading.stock-analysis`
  - `com.openclaw.trading.official-paper.poll`
  - `com.openclaw.trading.official-paper.pnl`
- Verification on 2026-05-31:
  - `pnpm test`: 9 files / 33 tests passed.
  - `pnpm typecheck`: passed.
  - `pnpm build`: passed.
  - `git diff --check`: clean.
  - `openclaw health --json`: ok; Feishu channel running.
  - OpenClaw Chinese reply smoke: confirmed only the four retained capabilities.
- Independent review status:
  - Initial reviewer verdict was not ready because of official-paper guard and 10% budget enforcement.
  - Critical findings were fixed and covered by failing-then-passing tests.
  - Stock analysis now uses Longbridge quote/news plus Yahoo read-only chart/quote/options supplements; if a supplement fails, the report marks that dimension as `待验证` instead of fabricating facts.

## Deletion Boundary

Remove or detach these non-core surfaces:

- `apps/live-advisor`
- `apps/event-bus`
- `apps/event-ingestor`
- `apps/paper-trader` as a local queue consumer
- rule proposal review plugin and proposal reports
- local paper-sim submit script
- source request and private-notes publishing scripts
- context-builder package and context maintenance schedules
- rule activation/generation review scripts from exposed package scripts

Keep:

- `apps/broker-executor`
- `apps/openclaw-config` scripts/config needed for Feishu auth, report delivery, Longbridge reads, official paper execution, schedules, and OpenClaw config rendering
- `packages/shared-types`
- `knowledge/notes/stock-trading-notes`
- `reports/daily` and `reports/weekly`
