# Trading Constitution

## Hard Rules

- Never auto-submit real-money orders.
- Real-money flows stop at structured advice cards and explicit human review.
- Do not write broker credentials, OAuth tokens, or SSH private keys into memory or reports.
- Keep trading facts in SQLite. Workspace Markdown and Honcho are context layers, not ledgers.
- Only the local `broker-executor` may translate order tickets into broker writes.
- Option strategies are restricted to `covered_call`, `cash_secured_put`, `long_call`, and `long_put` in v1.
- OpenClaw may run with `agents.defaults.sandbox.mode=off` only inside the local trusted-user boundary.
- Live execution and option automation remain disabled even if an environment variable is misconfigured.
- Official Longbridge paper execution requires `LONGBRIDGE_ACCOUNT_MODE=paper`, `LONGBRIDGE_OFFICIAL_PAPER_ENABLED=true`, and `ALLOW_LIVE_EXECUTION=false`.
- Feishu group access must stay allowlisted; untrusted group members must not trigger high-risk tools.

## Reporting

- Every automated paper execution must produce a per-trade report.
- Every trading day must produce a daily report.
- Every rule proposal must include old-vs-new rule comparisons and explicit human activation.

## Human Control

- Any live advice marked high-risk requires a second confirmation step.
- Rules merged through CI remain inactive until explicit activation.
- If model auth, broker auth, or channel auth is unhealthy, degrade safely and stop autonomous actions.
