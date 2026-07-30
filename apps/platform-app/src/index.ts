import {
  loadLocalEnv,
  openTradingDatabase,
  resolveRepoRoot,
  resolveRuntimePaths
} from "@packages/shared-types";

import { createFeishuReviewNotifier } from "./data/feishu-review-notifier.js";
import { listFilterSymbols } from "./data/news.js";
import { loadLatestSnapshotForOwner } from "./data/snapshots.js";
import { getAccessJwtMode, primeAccessJwtCache } from "./identity.js";
import {
  createDefaultMemoryReader,
  createDefaultQuoteReader,
  createDefaultResearchBackend,
  createResearchWorker
} from "./research/worker.js";
import { createPlatformServer } from "./server.js";
import { assertSessionSecretConfigured } from "./session.js";

const repoRoot = resolveRepoRoot(process.cwd());
loadLocalEnv(repoRoot);

// Email-code login (2026-07-27, routes/login.ts): the session cookie is
// worthless unless it is signed with a real secret, and there is deliberately
// no default to fall back on - so refuse to serve at all rather than boot a
// login nobody can complete (or, worse, one signed with something guessable).
// Must run AFTER loadLocalEnv (that is what puts .env.local into process.env)
// and BEFORE the server is built.
assertSessionSecretConfigured();
// PLATFORM_DB_PATH mirrors stock-analysis.mjs's STOCK_ANALYSIS_DB_PATH and
// members.mjs's MEMBERS_DB_PATH: unset (and a no-op) in normal operation,
// where the real runtime/trading.sqlite is used; lets a live/manual
// verification run this exact binary against a disposable temp db instead,
// e.g. `PLATFORM_DB_PATH=/tmp/x.sqlite pnpm platform:dev`. This is the ONLY
// db path override this process honors - never point it at the real
// runtime/trading.sqlite for a throwaway/manual verification run.
const dbPath = process.env.PLATFORM_DB_PATH ?? resolveRuntimePaths(repoRoot).dbPath;
const db = openTradingDatabase(dbPath);

const port = Number(process.env.PLATFORM_APP_PORT ?? 4314);

// Phase 8 Task 3 (2026-07-16 plan): the real in-process research worker,
// wired to real collaborators - a LIVE research backend (research-engine.mjs's
// createResearchBackend over the shared OpenClaw gateway client; a gateway
// failure becomes a gracefully `degraded`/`failed` task, never a crash - see
// research/worker.ts), a stock_facts quote reader, and a
// data/strategy.ts-backed memory reader (owner-pre-bound per claimed task by
// the worker itself, never a free scope param).
//
// `symbolUniverse` is §1.3's full 提问标的范围 = 全体标的池并集 + 本人持仓, and it
// is a RESOLVER, not an array (2026-07-30). Both halves of that change fix a
// real wrong answer rather than a tidiness concern:
//   · 并集 half - data/news.ts's `listFilterSymbols` (the same "every symbol
//     anyone in the circle is tracking" query the news page's filter chips
//     use) is re-read per task, so a symbol added to the pool today is
//     askable today; as a startup-time constant it stayed invisible until
//     someone restarted this process.
//   · 持仓 half - was missing entirely. Measured against the mini's live
//     database on 2026-07-30: the one active member's watchlist is
//     NVDA/TSM/GOOG/QQQM/AMZN while the position they actually hold is
//     QQQ.US, which appears in no watchlist row. Asking about their own
//     holding would have been answered 「QQQ.US 不在你的标的池」 - false.
// Only the asking member's OWN snapshot rows count: `loadLatestSnapshotForOwner`
// falls back to unattributed/`__shared__` rows when a member has none of their
// own, and an unattributed account's positions are not this member's 持仓, so
// the ownerId is compared before the positions are used.
function resolveResearchSymbolUniverse(ownerId: string): string[] {
  const pool = new Set<string>();
  for (const symbol of listFilterSymbols(db)) {
    const normalized = symbol.trim().toUpperCase();
    if (normalized) {
      pool.add(normalized);
    }
  }
  const snapshot = loadLatestSnapshotForOwner(db, ownerId);
  if (snapshot && snapshot.ownerId === ownerId) {
    for (const position of snapshot.positions) {
      const normalized = String(position.symbol ?? "").trim().toUpperCase();
      if (normalized) {
        pool.add(normalized);
      }
    }
  }
  return [...pool];
}

const researchWorker = createResearchWorker({
  db,
  backend: createDefaultResearchBackend(),
  quoteReader: createDefaultQuoteReader(db),
  memoryReader: createDefaultMemoryReader(db),
  symbolUniverse: resolveResearchSymbolUniverse
});
researchWorker.start();

// Real Feishu confirm notifier (data/feishu-review-notifier.ts): looks up
// the review owner's members.feishu_open_id and sends the 月度复盘确认摘要 card
// over the same sendInteractiveCard channel the market alerts already use.
// Credentials (FEISHU_APP_ID/FEISHU_APP_SECRET) come from the loadLocalEnv
// call above; a member with no open_id on file degrades to
// {delivered:false, reason} without ever failing the confirm.
const feishuNotifier = createFeishuReviewNotifier({ db });

const server = createPlatformServer({ db, repoRoot, researchWorker, feishuNotifier });

// P10: resolve the Cloudflare Access JWT mode once at startup so it shows in
// the boot log, and so a fail-closed deployment warns immediately rather than
// on the first request. Env comes from the loadLocalEnv call above; identity.ts
// re-reads process.env per request, so no further plumbing is needed here.
//   - "disabled": pre-P10 blind trust of the email header, gated behind the
//     explicit CF_ACCESS_DISABLED=true escape (local/loopback only).
//   - "enforce": CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD both set -
//     Cf-Access-Jwt-Assertion fully verified against the team's JWKS (and its
//     email claim matched to the header) before the email header is trusted.
//   - "fail-closed": neither disabled nor fully configured - all email-header
//     logins are rejected until fixed (see identity.ts's warning). The
//     forgeable header is never trusted by default.
// In enforce mode the JWKS cache is pre-warmed (awaited, never throws) so
// the first tunneled request does not eat the cold-start fail-closed miss.
const accessJwtMode = getAccessJwtMode();
await primeAccessJwtCache();

// Loopback only — this service is never exposed beyond localhost directly;
// external access is expected to go through a Cloudflare Access tunnel (P10).
server.listen(port, "127.0.0.1", () => {
  console.log(`platform-app listening on http://127.0.0.1:${port} (access-jwt: ${accessJwtMode})`);
});
