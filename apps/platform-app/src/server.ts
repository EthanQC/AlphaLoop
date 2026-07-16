import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { methodNotAllowed, notFound, sendJson } from "@packages/shared-types";

import { applySecurityHeaders, createNonce } from "./security.js";
import type { MemorydBackend } from "./data/memoryd-mirror.js";
import { handleApiResearchRoute, type ResearchWorkerLike } from "./routes/api-research.js";
import { handleApiStrategyRoute } from "./routes/api-strategy.js";
import { handleHomeRoute } from "./routes/home.js";
import { handleMemberCardRoute } from "./routes/member-card.js";
import { handleNewsRoute } from "./routes/news.js";
import { handlePaperRoute } from "./routes/paper.js";
import { handleProposalRoute } from "./routes/proposal.js";
import { handleReportsRoute } from "./routes/reports.js";
import { handleResearchRoute } from "./routes/research.js";
import { handleReviewRoute, type FeishuReviewNotifier } from "./routes/review.js";
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
  /** In-process research worker (Task 3, research/worker.ts) that
   * `POST /api/research` kicks, fire-and-forget, after a successful
   * submission. The real process (index.ts) constructs one wired to real
   * collaborators (a P10-gated research backend, a stock_facts quote reader,
   * a data/strategy.ts-backed memory reader) and calls its own `.start()`
   * separately - this dep only needs `.tick()` (see
   * routes/api-research.ts's `ResearchWorkerLike`). Tests either omit this
   * entirely (a submission stays `queued`, unprocessed - fine for tests that
   * don't exercise the worker) or construct a worker directly (with fake
   * collaborators) and pass it here, ticking it by hand rather than relying
   * on this route's fire-and-forget kick for timing. */
  researchWorker?: ResearchWorkerLike;
  /** Injectable Feishu single-chat confirm notifier (Task 4, routes/
   * review.ts), fired fire-and-forget after `POST /api/reviews/:id/confirm`.
   * Defaults to createFeishuReviewNotifier()'s P10-gated placeholder (always
   * degrades to `{delivered:false}` today) when the real entrypoint
   * (index.ts) doesn't supply one. */
  feishuNotifier?: FeishuReviewNotifier;
}

// Process-level crash guard (2026-07 audit fix): the outer try/catch inside the request
// handler below only wraps the SYNCHRONOUS dispatch() call. The bearer-gated write routes
// (api-strategy.ts, api-research.ts) dispatch their async handlers fire-and-forget as
// `void handleX(...)` - none of those handlers' own DB calls are wrapped in a local
// try/catch, so a throw from node:sqlite (e.g. SQLITE_BUSY - this process runs a research
// worker and shares trading.sqlite with CLIs) surfaces as an unhandled promise rejection,
// which by default terminates the Node process. A member-facing server must survive one
// bad request instead of taking down every other in-flight connection with it. This is
// registered once at module load (not per-request) since it's a process-wide guard, not a
// per-connection one; it deliberately does NOT call process.exit - logging and continuing
// is the correct behavior for a long-lived server (contrast with a one-shot CLI script,
// where crashing loudly is preferable).
let processCrashGuardInstalled = false;
function installProcessCrashGuard(): void {
  if (processCrashGuardInstalled) {
    return;
  }
  processCrashGuardInstalled = true;
  process.on("unhandledRejection", (reason) => {
    console.error(
      `platform-app: unhandled rejection (process kept alive): ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`
    );
  });
  process.on("uncaughtException", (error) => {
    console.error(
      `platform-app: uncaught exception (process kept alive): ${error instanceof Error ? error.stack ?? error.message : String(error)}`
    );
  });
}

/**
 * Builds the platform-app HTTP server. This factory never calls `listen`
 * itself — callers (the real entrypoint or tests) decide the port and host,
 * so tests can bind to an ephemeral port instead of the production one.
 */
export function createPlatformServer(deps: PlatformServerDeps): Server {
  installProcessCrashGuard();
  return createServer((req, res) => {
    const nonce = createNonce();
    applySecurityHeaders(res, nonce);

    // Outer error boundary: any synchronous throw from a route handler (e.g. a
    // corrupt JSON column that JSON.parse rejects, a bad URL) must become a
    // controlled 500, never an uncaught exception that crashes this
    // member-facing process or leaves the socket hanging. Mirrors
    // broker-executor's own top-level try/catch. Async handlers own their own
    // internal error handling (they read bodies and reply asynchronously);
    // this catches the synchronous dispatch path the GET/HTML routes use.
    try {
      dispatch(req, res, nonce);
    } catch (error) {
      console.error(`platform-app: unhandled error for ${req.method} ${req.url}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "内部错误，请稍后重试。" });
      } else {
        res.end();
      }
    }
  });

  function dispatch(req: IncomingMessage, res: ServerResponse, nonce: string): void {
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

    // Submission/promotion JSON API for the in-site question box (Task 3) -
    // dispatches before every GET/HTML route below, same as
    // handleApiStrategyRoute above, but identity-gated via `resolveIdentity`
    // (bearer OR Access email), not bearer-only - see routes/api-research.ts's
    // own module header for why this differs from api-strategy.ts's rule.
    if (
      handleApiResearchRoute(req, res, url, {
        db: deps.db,
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.researchWorker ? { researchWorker: deps.researchWorker } : {})
      })
    ) {
      return;
    }

    // Monthly review reading page (`GET /review/<id>`) + its confirm
    // endpoint (`POST /api/reviews/:id/confirm`, Task 4) - one module owns
    // both (routes/review.ts's own module header), identity-gated via
    // `resolveIdentity` (bearer OR Access) like the research surfaces above,
    // never bearer-only.
    if (
      handleReviewRoute(
        req,
        res,
        url,
        {
          db: deps.db,
          ...(deps.now ? { now: deps.now } : {}),
          ...(deps.memorydBackend ? { memorydBackend: deps.memorydBackend } : {}),
          ...(deps.feishuNotifier ? { feishuNotifier: deps.feishuNotifier } : {})
        },
        nonce
      )
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
  }
}
