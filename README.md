# OpenClaw Trading Stack

Monorepo for a local, single-node OpenClaw trading control plane on macOS.

## Scope

- OpenClaw as the control plane and agent router
- Longbridge as the authenticated broker integration for live advice and future market adapters
- Local `paper-sim` for automated stock/ETF simulation
- Option trading automation is disabled by operator policy
- SQLite for durable queueing and transaction facts
- Optional Honcho for long-term preference modeling
- Optional Feishu notifications and channel handoff
- Local approval and preference loop for advice edits
- Weekly rule proposal generation from approvals, notes, and execution history
- GitHub monorepo for code, rules, reports, and CI

## Layout

- `apps/openclaw-config`: OpenClaw config templates, prompts, launchd templates
- `apps/event-bus`: SQLite-backed durable queue API
- `apps/event-ingestor`: Source adapters and event emission loop
- `apps/broker-executor`: Risk gate and execution API
- `apps/live-advisor`: Advice-only consumer for the live lane
- `apps/paper-trader`: Automatic stock/ETF paper consumer and report trigger
- `apps/options-shadow`: Historical option simulation service retained for old records only
- `packages/shared-types`: Shared domain types, SQLite schema, repositories, helpers
- `packages/context-builder`: Runtime context assembly for OpenClaw agents
- `knowledge/notes`: Private research, watchlists, preferences
- `knowledge/memory`: Stable memory and daily summaries
- `rules/live`: Live advisor rule versions
- `rules/paper`: Paper trading rule versions
- `reports/daily`: 中文日报
- `reports/weekly`: 中文周报
- `reports/proposals`: Rule proposal snapshots generated from local evidence

## Prerequisites

- Node.js 24+
- pnpm 9+
- OpenClaw installed locally
- Optional Honcho plugin installed in OpenClaw

## Local bootstrap

```bash
pnpm install
pnpm build
pnpm test
pnpm preferences:bootstrap
pnpm proposals:generate
```

OpenClaw-specific onboarding and launchd setup live in [apps/openclaw-config/README.md](/Users/mashu/Documents/codex/apps/openclaw-config/README.md).

## Local Operator Endpoints

- `GET http://127.0.0.1:4314/v1/advice/recent`
- `POST http://127.0.0.1:4314/v1/advice/approvals`
- `GET http://127.0.0.1:4314/v1/preferences/latest`
- `GET http://127.0.0.1:4312/v1/paper/positions`
- Option and shadow endpoints are historical only and should not be used for automation.

## Local Trusted-User Mode

This stack intentionally runs directly on the local macOS host with `agents.defaults.sandbox.mode=off`.
The boundary is documented in [apps/openclaw-config/docs/local-trusted-user-security.md](/Users/mashu/Documents/codex/apps/openclaw-config/docs/local-trusted-user-security.md).

The mandatory execution baseline is:

- `ALLOW_LIVE_EXECUTION=false`; live flow remains advice-only.
- `LONGBRIDGE_ACCOUNT_MODE=paper` and `LONGBRIDGE_OFFICIAL_PAPER_ENABLED=true` are required for official paper orders.
- Option automation and shadow execution are disabled.
- Feishu group access stays on allowlist with trusted operators only.
- Broker writes are only allowed through local `broker-executor`.
