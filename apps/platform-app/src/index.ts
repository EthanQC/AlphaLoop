import {
  loadLocalEnv,
  openTradingDatabase,
  resolveRepoRoot,
  resolveRuntimePaths
} from "@packages/shared-types";

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

const server = createPlatformServer({ db, repoRoot });

// Loopback only — this service is never exposed beyond localhost directly;
// external access is expected to go through a Cloudflare Access tunnel (P10).
server.listen(port, "127.0.0.1", () => {
  console.log(`platform-app listening on http://127.0.0.1:${port}`);
});
