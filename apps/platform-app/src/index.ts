import {
  loadLocalEnv,
  openTradingDatabase,
  resolveRepoRoot,
  resolveRuntimePaths
} from "@packages/shared-types";

import { listFilterSymbols } from "./data/news.js";
import {
  createDefaultMemoryReader,
  createDefaultQuoteReader,
  createDefaultResearchBackend,
  createResearchWorker
} from "./research/worker.js";
import { createPlatformServer } from "./server.js";

const repoRoot = resolveRepoRoot(process.cwd());
loadLocalEnv(repoRoot);
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
// wired to real collaborators - a P10-gated research backend (throws until
// P10 stands up the real restricted OpenClaw gateway; the worker itself
// already turns that throw into a gracefully `degraded`/`failed` task, never
// a crash - see research/worker.ts), a stock_facts quote reader, and a
// data/strategy.ts-backed memory reader (owner-pre-bound per claimed task by
// the worker itself, never a free scope param). `symbolUniverse` is the
// circle's full tracked-symbol pool (data/news.ts's `listFilterSymbols` -
// already used by the news page's own filter-chip row for the identical
// "every symbol anyone in the circle is tracking" query) resolved once at
// process startup; the plan's full "标的池并集 + 本人持仓" definition also
// folds in each asking member's own positions, which - along with keeping
// this pool fresh across a long-running process without a restart - is left
// to a later task (this worker's own `symbolUniverse` is a plain injected
// array, not a per-call resolver, by design - see its own doc comment).
const symbolUniverse = listFilterSymbols(db);
const researchWorker = createResearchWorker({
  db,
  backend: createDefaultResearchBackend(),
  quoteReader: createDefaultQuoteReader(db),
  memoryReader: createDefaultMemoryReader(db),
  symbolUniverse
});
researchWorker.start();

const server = createPlatformServer({ db, repoRoot, researchWorker });

// Loopback only — this service is never exposed beyond localhost directly;
// external access is expected to go through a Cloudflare Access tunnel (P10).
server.listen(port, "127.0.0.1", () => {
  console.log(`platform-app listening on http://127.0.0.1:${port}`);
});
