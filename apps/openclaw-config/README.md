# OpenClaw Configuration

This folder contains the OpenClaw-side configuration templates for the local trading stack.

## What is here

- `config/openclaw.example.json5`: Gateway config template with 4 long-lived agents
- `agents/*.md`: Per-agent workspace prompts
- `launchd/*.plist`: macOS LaunchAgent templates
- `scripts/*.sh`: helper scripts to sync workspaces and install LaunchAgents
- `scripts/bootstrap-preferences.mjs`: build a baseline preference snapshot from notes and approvals
- `scripts/generate-rule-proposal.mjs`: 从 SQLite 执行事实、审批编辑和当前规则生成中文、待确认、可审计的规则提案
- `scripts/review-rule-proposal.mjs`: 解析飞书群审核回复，写入提案状态、审计日志，并在二次确认后调用激活脚本
- `scripts/context-manager.mjs`: SQLite-backed local context, Feishu session memory, managed workspace `MEMORY.md`, and combined OpenClaw cron/launchd automation inventory

## Setup flow

1. Install Node.js 24 and pnpm.
2. Install OpenClaw.
3. Sync the private notes repository:

```bash
apps/openclaw-config/scripts/sync-private-notes.sh git@github.com:EthanQC/stock-trading-notes.git
```

4. Set local secrets in `.env.local`, then render the real gateway config:

```bash
node apps/openclaw-config/scripts/render-openclaw-config.mjs
```

### Feishu Trading Copilot delivery

Daily/weekly report delivery prefers `feishu-user-plugin` using the official API as the `Trading Copilot` bot. The built-in OpenClaw Feishu bot/app channel remains the fallback and fallback messages are labeled in Chinese as degraded bot delivery.

The report delivery shape is:

- first Feishu message: rich text summary card
- following messages: full report sent by chapter, with overlong chapters split automatically
- local artifacts: Markdown and PDF are generated together under `reports/<daily|weekly>/`
- PDF upload: if Feishu file upload permission is available, the PDF is also sent to the target group

Install the OpenClaw MCP server without writing secrets into `~/.openclaw/openclaw.json`:

```bash
openclaw mcp set feishu-user-plugin '{"command":"node","args":["/Users/mashu/Documents/codex/apps/openclaw-config/scripts/run-feishu-user-plugin.mjs"]}'
```

Keep credentials only in local env files or the user shell. `LARK_APP_ID`/`LARK_APP_SECRET` may mirror `FEISHU_APP_ID`/`FEISHU_APP_SECRET`; token and cookie values must not be committed.

For bot report delivery, UAT is not required. `LARK_USER_ACCESS_TOKEN` and `LARK_USER_REFRESH_TOKEN` are only needed for user/P2P chat reading.

To refresh user auth locally:

```bash
pnpm feishu:user-plugin:oauth
pnpm feishu:user-plugin:status
```

The OAuth flow uses the plugin redirect URI `http://127.0.0.1:9997/callback`. If user-token scopes are needed later, publish the app version and wait for tenant admin approval before rerunning OAuth.

5. Run [scripts/sync-workspaces.sh](/Users/mashu/Documents/codex/apps/openclaw-config/scripts/sync-workspaces.sh) to materialize per-agent workspaces under `~/.openclaw/workspaces/`.
   The sync also refreshes managed `MEMORY.md` files from the local SQLite context database.
6. Build the TypeScript services:

```bash
pnpm install
pnpm build
pnpm preferences:bootstrap
pnpm proposals:generate
```

规则提案默认不会激活。飞书群内审核分两档：

- 低风险状态变更：回复 `继续观察 <proposal-id> [原因]`、`拒绝 <proposal-id> <原因>`、`归档 <proposal-id> <原因>`。
- 激活两步确认：先回复 `建议激活 <proposal-id> <原因>`，再回复 `确认激活 <proposal-id> HUMAN_APPROVED <原因>`。

本地也可手动运行审核入口：

```bash
pnpm proposals:review from-feishu "继续观察 <proposal-id> 样本还不够" --actor <feishu-open-id>
```

若人工确认候选规则已落地，也可显式运行底层激活脚本：

```bash
node apps/openclaw-config/scripts/activate-rule-version.mjs activate <live|paper> <version> --proposal-id <id> --confirm HUMAN_APPROVED
```

7. Install the sidecar LaunchAgents and the official OpenClaw gateway service:

```bash
apps/openclaw-config/scripts/install-launchd.sh
```

## Notes

- Keep broker credentials and SSH private keys out of workspace memory files.
- The gateway config intentionally disables automatic live execution through the local `broker-executor`.
- Feishu is auto-injected into the rendered config only when `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are present.
- Long-term operating context is kept in local workspace Markdown plus `runtime/openclaw-context.sqlite`; paid Honcho/managed-memory plugins are intentionally not used.
- Local OpenClaw memory is enabled through bundled `memory-core`, `active-memory`, and the local `local-context` plugin. Feishu group messages are stored redacted in SQLite as they arrive, then compact context is injected before prompt build.
- Launchd is the source of truth for deterministic local schedules such as daily/weekly report generation and delivery. OpenClaw cron is better reserved for conversational reminders or agent wakeups that depend on the gateway and model auth.
- To inspect all automation OpenClaw should report to the operator, run:

```bash
node --no-warnings apps/openclaw-config/scripts/context-manager.mjs automation-summary
```
