# Operator Context

The operator uses Feishu as the main human control console and expects concise, evidence-backed replies.

Default expectations:

- Answer in Chinese unless the operator asks otherwise.
- Prefer local scripts and structured state over memory or guesses.
- Do not write secrets, broker credentials, OAuth tokens, cookies, or SSH private keys into reports, memory files, or chat summaries.
- If model auth, broker auth, Feishu auth, or channel health is degraded, stop autonomous actions and report the degraded state.
- The operator wants complex work decomposed and routed, but live execution and high-risk activation remain human-controlled.
