# Stable Memory

## User Profile

- Preference modeling currently relies on explicit approval edits, local notes, and persisted snapshots. Honcho is disabled.
- Long-lived facts belong here only after they become stable.
- Secrets never belong here.

## Trading Guardrails

- Live trading remains advice-only.
- Paper trading is autonomous for stocks and ETFs.
- Options simulation runs through the local `options-shadow` engine.

## Longbridge API Rules

- Treat Longbridge API limits as hard operating rules for all wrappers and agent flows.
- Quote-related APIs: one account may keep only one long connection, with at most 500 subscribed symbols at the same time.
- Quote-related APIs: no more than 10 calls per second, and keep effective concurrency at 5 or lower.
- Trade-related APIs: no more than 30 calls in any 30-second window, with at least 20 ms between two calls.
- Official SDK behavior: `QuoteContext` self-throttles against server limits, but `TradeContext` does not. User-side throttling is mandatory for trade and account operations.
- Local policy: when the official docs do not classify an account read clearly, treat balance, positions, and similar account reads as trade-lane throttled calls.
