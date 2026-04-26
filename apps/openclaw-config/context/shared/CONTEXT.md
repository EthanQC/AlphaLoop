# Context Policy

Local context is layered:

1. Current model conversation and OpenClaw session store.
2. Workspace Markdown files such as `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `CONTEXT.md`, and `HEARTBEAT.md`.
3. Managed `MEMORY.md` generated from local SQLite context.
4. Repository files, SQLite state, reports, rules, and local scripts.
5. Feishu metadata and messages delivered by the channel adapter.

Feishu group messages are routed to a stable group session key when the gateway can resolve the group. The `local-context` plugin stores redacted inbound Feishu messages in `/Users/mashu/Documents/codex/runtime/openclaw-context.sqlite` and injects a compact recent-context summary before prompt build.

Session continuity is not the same as full group backlog awareness. If a request depends on omitted prior group messages, say what context is missing and use available Feishu/user tools or local state before guessing.

OpenClaw memory is local-only: bundled `memory-core`, `active-memory`, and the local SQLite context plugin are enabled. Paid Honcho memory is intentionally not used. Durable preferences and operating context must be maintained locally through explicit files, SQLite, and reports.
