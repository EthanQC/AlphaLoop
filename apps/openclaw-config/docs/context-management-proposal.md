# OpenClaw Local Context Management Proposal

Status: accepted and implemented with local SQLite

## Problem

The control agent currently has a stable OpenClaw group session, but each Feishu event may only include the current message and untrusted metadata. It should not pretend to see the whole group backlog unless it fetched or received that backlog.

Paid managed-memory plugins are intentionally not used.

## Recommended Design

Use a local, auditable context stack:

1. Workspace prompt files copied by `scripts/sync-workspaces.sh`.
2. `runtime/openclaw-context.sqlite` for identity/context document indexes, redacted Feishu group-message context, automation inventory, and context maintenance runs.
3. Trading facts, execution records, proposal state, and audit trails remain in their dedicated SQLite/business files.
4. Local report/proposal Markdown remains human-readable artifacts only.

## Feishu Group Context

OpenClaw should keep routing Feishu group messages to the same group session key:

`agent:control:feishu:group:<chat_id>`

That means Feishu group messages are not supposed to be brand-new sessions every time. However, session continuity is not the same as full group backlog awareness. If a message refers to something absent from the session, the control agent should fetch or summarize recent Feishu history through approved tools before answering.

## Proposed Local Cache

Implemented in `runtime/openclaw-context.sqlite` with:

- channel
- chat_id
- message_id
- sender_open_id
- created_at
- normalized_text
- session_key
- redacted raw event excerpt

Retention is short by default and cleanup excludes secrets or broker credentials through redaction before storage.

## Prompt Rules

The control agent should:

- read `CONTEXT.md` and `DELEGATION.md` before self-description or routing answers;
- disclose when only the current Feishu message is available;
- summarize retrieved Feishu context separately from local trading facts;
- keep trading facts in SQLite, not in memory files;
- use `apps/openclaw-config/scripts/context-manager.mjs automation-summary` when asked what scheduled automations exist.
