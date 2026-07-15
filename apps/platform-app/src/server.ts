import { createServer, type Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { methodNotAllowed, notFound, sendJson } from "@packages/shared-types";

import { applySecurityHeaders, createNonce } from "./security.js";
import type { MemorydBackend } from "./data/memoryd-mirror.js";
import { handleApiStrategyRoute } from "./routes/api-strategy.js";
import { handleHomeRoute } from "./routes/home.js";
import { handleMemberCardRoute } from "./routes/member-card.js";
import { handleNewsRoute } from "./routes/news.js";
import { handlePaperRoute } from "./routes/paper.js";
import { handleProposalRoute } from "./routes/proposal.js";
import { handleReportsRoute } from "./routes/reports.js";
import { handleResearchRoute } from "./routes/research.js";
import { handleStockRoute } from "./routes/stock.js";
import { handleStrategyRoute } from "./routes/strategy.js";

export interface PlatformServerDeps {
  /** Trading database handle; used by identity resolution (Task 2) and the
   * report routes (Task 4), and wired through for later tasks' data routes. */
  db: DatabaseSync;
  /** Repo root; used by the report routes (Task 4) for on-disk scanning. */
  repoRoot: string;
  /** Injectable clock for deterministic tests; defaults to wall clock. */
  now?: () => Date;
  /** Injectable memoryd mirror backend for the bearer-gated strategy write
   * API (Task 4, routes/api-strategy.ts); defaults to
   * `createMemorydBackend()`'s P10-gated placeholder (fire-and-forget
   * degrade - see data/memoryd-mirror.ts) when the real entrypoint
   * (index.ts) doesn't supply one. */
  memorydBackend?: MemorydBackend;
}

/**
 * Builds the platform-app HTTP server. This factory never calls `listen`
 * itself — callers (the real entrypoint or tests) decide the port and host,
 * so tests can bind to an ephemeral port instead of the production one.
 */
export function createPlatformServer(deps: PlatformServerDeps): Server {
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

    // Bearer-gated JSON write API (Task 4) dispatches BEFORE every GET/HTML
    // route below - it owns the whole `/api/*` namespace, is never identity-
    // gated via the Access-email header (bearer only - see api-strategy.ts's
    // own header), and returns JSON, not an HTML page.
    if (
      handleApiStrategyRoute(req, res, url, {
        db: deps.db,
        ...(deps.memorydBackend ? { memorydBackend: deps.memorydBackend } : {})
      })
    ) {
      return;
    }

    if (
      handleReportsRoute(
        req,
        res,
        url,
        // exactOptionalPropertyTypes: only include `now` when deps actually
        // supplied one - explicitly setting it to `undefined` is a type
        // error against ReportsRouteDeps's optional `now?: () => Date`.
        { db: deps.db, repoRoot: deps.repoRoot, ...(deps.now ? { now: deps.now } : {}) },
        nonce
      )
    ) {
      return;
    }

    if (
      handleHomeRoute(
        req,
        res,
        url,
        { db: deps.db, repoRoot: deps.repoRoot, ...(deps.now ? { now: deps.now } : {}) },
        nonce
      )
    ) {
      return;
    }

    if (handleNewsRoute(req, res, url, { db: deps.db, ...(deps.now ? { now: deps.now } : {}) }, nonce)) {
      return;
    }

    if (handlePaperRoute(req, res, url, { db: deps.db, ...(deps.now ? { now: deps.now } : {}) }, nonce)) {
      return;
    }

    if (
      handleStockRoute(
        req,
        res,
        url,
        { db: deps.db, repoRoot: deps.repoRoot, ...(deps.now ? { now: deps.now } : {}) },
        nonce
      )
    ) {
      return;
    }

    if (handleStrategyRoute(req, res, url, { db: deps.db, ...(deps.now ? { now: deps.now } : {}) }, nonce)) {
      return;
    }

    if (handleMemberCardRoute(req, res, url, { db: deps.db, ...(deps.now ? { now: deps.now } : {}) }, nonce)) {
      return;
    }

    if (handleProposalRoute(req, res, url, { db: deps.db, ...(deps.now ? { now: deps.now } : {}) }, nonce)) {
      return;
    }

    if (handleResearchRoute(req, res, url, { db: deps.db, ...(deps.now ? { now: deps.now } : {}) }, nonce)) {
      return;
    }

    notFound(res);
  });
}
