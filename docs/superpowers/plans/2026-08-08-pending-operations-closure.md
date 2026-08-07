# AlphaLoop Pending Operations Closure Plan

**Goal:** Close every currently executable repository and mini deployment task with measured evidence, while preserving the Trading Constitution's human-review and no-live-order boundaries.

**Constraints:** SQL remains the strategy-memory source of truth; memoryd is a loopback-only, best-effort mirror. Real-money execution stays disabled. Proposal approval remains an explicit human action. No credential or token is printed or committed.

## Task 1: Ignite the real memoryd mirror

- Replace both P10 placeholder backends with a tested MCP Streamable HTTP client.
- Initialize a session, call `mem_save`, validate the structured result, close the session, and convert transport/protocol errors into the existing fire-and-forget failure result.
- Configure the endpoint through `MEMORYD_MCP_URL`, defaulting to `http://127.0.0.1:8766/mcp`.
- Add parity tests for the CLI and platform implementations.

## Task 2: Make memoryd an unattended managed service

- Add an idempotent user-level runtime installer that checks out a pinned memory-system revision and performs a frozen production sync.
- Add `com.alphaloop.memoryd` to the system LaunchDaemon ownership manifest and installer, bound only to loopback with a dedicated data root and admin tools disabled.
- Add the same residency contract and a real MCP initialize probe to runtime doctor.
- Extend installer/doctor tests before running the full suite.

## Task 3: Close deploy and operational drift

- Push the reviewed commit, prepare the memoryd runtime on the mini, and execute the canonical deploy path.
- Verify current commit receipts, all managed daemons, all OpenClaw cron jobs (including reconciliation), report freshness, delivery routing, public Access boundary, database integrity, and the memoryd write path.
- Run L3 daily preparation against a valid trading date and retain its measured result without fabricating a market-day delivery.

## Task 4: Exercise recovery and scheduled follow-up

- Create the Longbridge paper-token expiry reminder through Codex automation.
- Reboot the mini only through the authorized system path, then verify unattended services before GUI login. If macOS privilege policy blocks the command, preserve that as the only explicit external-operation blocker; do not bypass it.

## Task 5: Preserve human-only and identity-only gates

- Deliver/verify proposal approval cards, but do not click approval or execute a proposal on the user's behalf.
- Onboard mashu only if a unique, verifiable email or Feishu identity already exists in authorized project state. Do not invent an identity or token.

## Task 6: Independent validation and integration

- Run build, typecheck, focused tests, full tests, and live doctor evidence.
- Ask an independent subagent to review the diff and evidence against this plan and the Trading Constitution.
- Fix all valid findings, rerun verification, merge to `main`, push, and report completed items, remaining external gates, artifact/commit identity, and deployment state.
