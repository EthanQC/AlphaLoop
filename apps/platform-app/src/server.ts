import { createServer, type Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { methodNotAllowed, notFound, sendJson } from "@packages/shared-types";

import { applySecurityHeaders, createNonce } from "./security.js";

export interface PlatformServerDeps {
  /** Trading database handle. Unused by Task 1's routes but wired through
   * for the identity/report/data routes landing in later tasks. */
  db: DatabaseSync;
  /** Repo root, used by later tasks for on-disk report scanning. */
  repoRoot: string;
  /** Injectable clock for deterministic tests; defaults to wall clock. */
  now?: () => Date;
}

/**
 * Builds the platform-app HTTP server. This factory never calls `listen`
 * itself — callers (the real entrypoint or tests) decide the port and host,
 * so tests can bind to an ephemeral port instead of the production one.
 */
export function createPlatformServer(deps: PlatformServerDeps): Server {
  // Reserved for upcoming tasks (identity resolution, report scanning).
  void deps.db;
  void deps.repoRoot;
  const now = deps.now ?? (() => new Date());
  void now;

  return createServer((req, res) => {
    const nonce = createNonce();
    applySecurityHeaders(res, nonce);

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/health") {
      if (req.method !== "GET") {
        methodNotAllowed(res);
        return;
      }
      sendJson(res, 200, { ok: true, service: "platform-app" });
      return;
    }

    notFound(res);
  });
}
