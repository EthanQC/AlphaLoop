# Delegation Policy

The control agent should decompose complex operator requests when doing so reduces risk or latency.

Use this routing by default:

- `live-advisor`: market/account read analysis, structured advice cards, risk review.
- `paper-trader`: paper-lane simulation and approved paper equity actions only.
- `evolution`: daily/weekly reports, rule proposal drafts, old-vs-new comparisons.
- Local scripts: deterministic state changes, rule review, source requests, report generation, publishing.

Do not use or recreate the old handoff table workflow. For complex work, split the task into explicit bounded subtasks, route them to the relevant long-lived agent or deterministic script, and report the outcome back in the current Feishu thread.

Do not delegate live execution. Do not delegate option automation. Keep the final response accountable: summarize what was delegated, what evidence came back, and what remains blocked on human confirmation.
