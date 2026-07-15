import {
  loadLocalEnv,
  openTradingDatabase,
  requireEnv,
  resolveRepoRoot,
  resolveRuntimePaths
} from "@packages/shared-types";

import { createBrokerExecutorServer } from "./server.js";

const repoRoot = resolveRepoRoot(process.cwd());
loadLocalEnv(repoRoot);
// BROKER_EXECUTOR_DB_PATH mirrors platform-app's PLATFORM_DB_PATH: unset (a
// no-op) in normal operation, where the real runtime/trading.sqlite is used;
// lets a live/manual verification run this exact binary against a
// disposable temp db instead. Never point it at the real
// runtime/trading.sqlite for a throwaway/manual verification run.
const dbPath = process.env.BROKER_EXECUTOR_DB_PATH ?? resolveRuntimePaths(repoRoot).dbPath;
const db = openTradingDatabase(dbPath);

// Global Constraint ① (2026-07-15 plan, Phase 6 Task 4): "env unset ->
// process refuses to START". requireEnv throws synchronously at module load
// if BROKER_EXECUTOR_SHARED_SECRET is missing/empty, before the server ever
// binds a port - there is no code path in which this process listens for
// requests without a shared secret to check them against.
const sharedSecret = requireEnv("BROKER_EXECUTOR_SHARED_SECRET");
const port = Number(process.env.BROKER_EXECUTOR_PORT ?? 4312);

const server = createBrokerExecutorServer({ db, sharedSecret });

server.listen(port, "127.0.0.1", () => {
  console.log(`broker-executor listening on http://127.0.0.1:${port}`);
});
