# OpenClaw Configuration

This folder contains the OpenClaw-side configuration templates for the local trading stack.

## What is here

- `config/openclaw.example.json5`: Gateway config template with 4 long-lived agents
- `agents/*.md`: Per-agent workspace prompts
- `launchd/*.plist`: macOS LaunchAgent templates
- `scripts/*.sh`: helper scripts to sync workspaces and install LaunchAgents
- `scripts/bootstrap-preferences.mjs`: build a baseline preference snapshot from notes and approvals
- `scripts/generate-rule-proposal.mjs`: generate local rule proposals from reports and approvals

## Setup flow

1. Install Node.js 24 and pnpm.
2. Install OpenClaw.
3. Sync the private notes repository:

```bash
apps/openclaw-config/scripts/sync-private-notes.sh git@github.com:EthanQC/stock-trading-notes.git
```

4. Install the Honcho plugin if you plan to use managed long-term memory:

```bash
openclaw plugins install @honcho-ai/openclaw-honcho
```

5. Set local secrets in `.env.local`, then render the real gateway config:

```bash
node apps/openclaw-config/scripts/render-openclaw-config.mjs
```

6. Run [scripts/sync-workspaces.sh](/Users/mashu/Documents/codex/apps/openclaw-config/scripts/sync-workspaces.sh) to materialize per-agent workspaces under `~/.openclaw/workspaces/`.
7. Build the TypeScript services:

```bash
pnpm install
pnpm build
pnpm preferences:bootstrap
pnpm proposals:generate
```

8. Install the sidecar LaunchAgents and the official OpenClaw gateway service:

```bash
apps/openclaw-config/scripts/install-launchd.sh
```

## Notes

- Keep broker credentials and SSH private keys out of workspace memory files.
- The gateway config intentionally disables automatic live execution through the local `broker-executor`.
- Feishu is auto-injected into the rendered config only when `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are present.
- Honcho is auto-enabled only when `HONCHO_API_KEY` is present in `.env.local`.
