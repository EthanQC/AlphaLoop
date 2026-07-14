import {
  loadLocalEnv,
  openTradingDatabase,
  resolveRepoRoot,
  resolveRuntimePaths
} from "@packages/shared-types";

import { createPlatformServer } from "./server.js";

const repoRoot = resolveRepoRoot(process.cwd());
loadLocalEnv(repoRoot);
const { dbPath } = resolveRuntimePaths(repoRoot);
const db = openTradingDatabase(dbPath);

const port = Number(process.env.PLATFORM_APP_PORT ?? 4314);

const server = createPlatformServer({ db, repoRoot });

// Loopback only — this service is never exposed beyond localhost directly;
// external access is expected to go through a Cloudflare Access tunnel (P10).
server.listen(port, "127.0.0.1", () => {
  console.log(`platform-app listening on http://127.0.0.1:${port}`);
});
