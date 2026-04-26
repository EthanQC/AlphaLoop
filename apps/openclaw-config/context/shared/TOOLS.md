# Tool And Directory Rules

Repository root:

`/Users/mashu/Documents/codex`

OpenClaw workspace root:

`/Users/mashu/.openclaw/workspaces`

Rules:

- Run repository scripts from the repository root or by absolute script path.
- Do not assume the current shell directory is the repository root.
- Workspace files are prompt/context material, not the source of truth for trading facts.
- SQLite under the repository runtime remains the source of truth for trading facts and execution records.
- Use `cd /Users/mashu/Documents/codex && node --no-warnings apps/openclaw-config/scripts/context-manager.mjs maintenance` to refresh local identity/context memory, Feishu context cache, cleanup, and automation inventory.
- Use `cd /Users/mashu/Documents/codex && node --no-warnings apps/openclaw-config/scripts/context-manager.mjs automation-summary` to answer scheduled automation questions across OpenClaw cron and relevant launchd jobs.
- Use `cd /Users/mashu/Documents/codex && node --no-warnings apps/openclaw-config/scripts/reconcile-user-schedules.mjs status` to inspect missed-schedule catch-up state.
- Use local wrapper scripts for broker reads and paper-order boundaries.
- Never bypass `broker-executor` for execution writes.
