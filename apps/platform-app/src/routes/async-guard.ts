/**
 * The ONE shared rejection guard for fire-and-forget async write dispatches
 * (2026-07 audit fix, factored out of api-strategy.ts/api-research.ts once
 * review.ts needed the identical third copy).
 *
 * Route modules dispatch their async write handlers without awaiting them
 * (`handleX(...)` returns a Promise the sync dispatch function can't await -
 * see api-strategy.ts's `handleApiStrategyRoute`); if the handler's own DB
 * call throws (e.g. node:sqlite SQLITE_BUSY - this process shares
 * trading.sqlite with a research worker and CLIs) the rejection would
 * otherwise be unhandled. The process-level guard in server.ts keeps the
 * PROCESS alive, but without this the client socket hangs until timeout -
 * this closes the socket with a controlled 500 when the handler hasn't
 * already replied, or just ends the response if headers are out the door.
 *
 * The 500 body is `{ ok: false, error }` - the same shape every other error
 * response in the JSON write routes carries (401/400/403/404/429 all send
 * `ok: false`), so a client's `if (!payload.ok)` check reads this failure
 * exactly like any other (an earlier api-strategy-local copy dropped the
 * `ok: false`, the one outlier - unified here, pinned by server.test.ts).
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { sendJson } from "@packages/shared-types";

/**
 * Attaches the rejection handler to a fire-and-forget async write handler's
 * promise. `logPrefix` names the owning route module (e.g. "api-strategy")
 * so the error line keeps the same per-module attribution the local copies
 * had.
 */
export function guardAsyncWrite(
  promise: Promise<void>,
  req: IncomingMessage,
  res: ServerResponse,
  logPrefix: string
): void {
  promise.catch((error: unknown) => {
    console.error(
      `${logPrefix}: async handler failed for ${req.method} ${req.url}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
    );
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: "内部错误，请稍后重试。" });
    } else {
      res.end();
    }
  });
}
