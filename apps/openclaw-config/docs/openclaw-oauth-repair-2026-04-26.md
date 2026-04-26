# OpenClaw OAuth Repair - 2026-04-26

## Scope

- Provider: `openai-codex`
- Target model: `openai-codex/gpt-5.5`
- Heartbeat model: `openai-codex/gpt-5.4-mini`
- Flow used: normal browser OAuth only, not device pairing

## What Changed

1. Added an OpenClaw-only CLI proxy wrapper at:
   - `~/.local/node-v24/bin/openclaw`
2. Added a stable OpenClaw proxy shim outside the Node install path:
   - `~/.local/bin/openclaw`
3. Updated shell startup PATH priority so the stable shim is used before the Node install path:
   - `~/.zprofile`
   - `~/.zshrc`
4. Preserved the original OpenClaw CLI symlink at:
   - `~/.local/node-v24/bin/openclaw.real`
   - `~/.local/node-v24/bin/openclaw.unproxied`
5. The wrappers export proxy env vars only for OpenClaw:
   - `HTTP_PROXY=http://127.0.0.1:7897`
   - `HTTPS_PROXY=http://127.0.0.1:7897`
   - `ALL_PROXY=http://127.0.0.1:7897`
6. Completed normal OpenAI Codex browser OAuth.
7. Synced the resulting valid `openai-codex` OAuth profile into:
   - `main`
   - `control`
   - `live-advisor`
   - `paper-trader`
   - `evolution`
   - `personal-assistant`

## Backups

- Pre-sync auth backup:
  - `~/.openclaw/backups/auth-sync-20260426-125044`
- Earlier cleanup backup:
  - `~/.openclaw/backups/auth-20260425-202340`

## Findings

- Direct CLI egress reached an unsupported region for OpenAI OAuth token exchange.
- The local proxy at `127.0.0.1:7897` reached a supported region.
- An OpenClaw update replaced the first wrapper attempt, so the wrapper was recreated after the update.
- To survive future OpenClaw updates, `~/.local/bin/openclaw` now acts as the stable shim and is placed earlier in PATH than `~/.local/node-v24/bin`.
- OAuth succeeded after the wrapper was restored.
- The successful profile was initially written to the `control` auth store, while default `models status` reads the `main` auth store. The valid profile was therefore synced across all OpenClaw agent auth stores.

## Verification

- `openclaw models status --json`
  - resolved default: `openai-codex/gpt-5.5`
  - missing providers: none
  - `openai-codex` OAuth status: ok
- `openclaw models --agent <agent> status --json`
  - all 5 configured agents resolve default model to `openai-codex/gpt-5.5`
  - all 5 configured agents show `openai-codex` OAuth status ok
- `openclaw agents list --json`
  - 5 configured agents use `openai-codex/gpt-5.5`
- `openclaw health --json`
  - ok: true
- Config check:
  - default primary model: `openai-codex/gpt-5.5`
  - default heartbeat model: `openai-codex/gpt-5.4-mini`
  - all 5 agent heartbeat models: `openai-codex/gpt-5.4-mini`

## Secret Handling

- No OAuth access token, refresh token, account id, cookie, authorization code, or callback URL is recorded in this note.
- Auth secrets remain only in local OpenClaw auth store files under `~/.openclaw`.
