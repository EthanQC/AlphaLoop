/**
 * H1 (2026-07-28, round-5): the mechanics behind test/runtime-write-guard.ts.
 *
 * WHAT WAS BROKEN
 * ---------------
 * `pnpm test` wrote into the repo's REAL `runtime/` and clobbered the live
 * Longbridge rate-limit ledger. `_longbridge.mjs` resolves its rate-limit
 * directory as
 * `options.rateLimitDir ?? options.env?.LONGBRIDGE_RATE_LIMIT_DIR ?? runtimeRoot`
 * with `runtimeRoot` = `<repo>/runtime`, the same directory production uses,
 * and five calls in `_longbridge.test.ts` passed no directory at all. Measured
 * 2026-07-28: `vitest run apps/openclaw-config/scripts/_longbridge.test.ts`
 * alone changed the sha256 AND the mtime of both
 * `runtime/longbridge-rate-limit-quote.json` and `-trade.json`. On the deploy
 * machine that ledger is live state protecting a real broker rate limit, and it
 * sits beside `trading.sqlite`.
 *
 * WHY BEHAVIOR AND NOT A MOCKED `fs`
 * ----------------------------------
 * Two mechanisms were measured first and rejected:
 *  - monkey-patching `fs.writeFileSync` from a setup file intercepts nothing
 *    under Vitest 4 (probed 2026-07-28: a `.mjs` doing
 *    `import { writeFileSync } from "node:fs"` and a test doing
 *    `await import("node:fs")` both reached the ORIGINAL - builtin ESM named
 *    exports are snapshotted at instantiation, long before setup files load);
 *  - aliasing `node:fs` to a wrapper covers only what Vite transforms, which is
 *    the mechanism that matters least here: `trading.sqlite` is written by
 *    better-sqlite3's native binding and never passes through `node:fs`, and
 *    several suites spawn real child processes.
 * Watching the directory itself has neither blind spot - a native write, a
 * subprocess write and an `fs` write are all just entries that changed.
 *
 * This module is deliberately free of any vitest import so that both the
 * per-test guard (a setup file, inside a worker) and the whole-run backstop
 * (test/global-setup.ts, in the main process) can share one implementation.
 */
import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Resolved ONCE, at module load, which is before any test body runs. That
 * ordering is the point: `ALPHALOOP_RUNTIME_GUARD_ROOT` exists so this guard's
 * own end-to-end proof (test/fixtures/runtime-guard-violation.fixture.ts) can be
 * watched over a temp directory rather than having to write into the real
 * `runtime/` to demonstrate that writing into it fails. A test cannot use it to
 * escape the guard: by the time a test could set the variable, this constant is
 * already resolved.
 */
export const RUNTIME_GUARD_ROOT = process.env.ALPHALOOP_RUNTIME_GUARD_ROOT ?? join(ROOT, "runtime");

/**
 * One entry's identity, cheap enough to take before and after every single
 * test: type + size + mtime + inode. Content is never read - a rewrite that
 * keeps the byte length identical still moves mtimeMs (millisecond resolution,
 * nanoseconds underneath on APFS), and an atomic replace moves the inode.
 */
function fingerprint(absolute: string): string {
  const stats = lstatSync(absolute);
  if (stats.isSymbolicLink()) {
    return `symlink -> ${readlinkSync(absolute)}`;
  }
  if (stats.isDirectory()) {
    return "directory";
  }
  return `file size=${stats.size} mtimeMs=${stats.mtimeMs} ino=${stats.ino}`;
}

/**
 * Every entry UNDER the runtime root, keyed by its path relative to that root.
 *
 * The root itself is deliberately not an entry. Five production modules
 * (`_longbridge.mjs`, `official-paper-monitor.mjs`, `scheduled-report.mjs`,
 * `stock-analysis.mjs`, `setup-feishu-user-auth.mjs`) run
 * `mkdirSync(runtimeRoot, { recursive: true })` at import time, so importing any
 * of them on a machine with no `runtime/` yet - a fresh clone, CI - creates an
 * empty directory. That destroys nothing, and failing every test on a fresh
 * clone would just get this guard deleted. Anything INSIDE it, including a
 * nested directory, is a violation.
 */
export function snapshotRuntimeEntries(root: string = RUNTIME_GUARD_ROOT): Map<string, string> {
  const entries = new Map<string, string>();
  const walk = (directory: string): void => {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      // Absent (or unreadable) root: nothing to protect yet.
      return;
    }
    for (const name of names) {
      const absolute = join(directory, name);
      let mark: string;
      try {
        mark = fingerprint(absolute);
      } catch {
        // Raced with its own deletion between readdir and lstat; the next
        // snapshot will disagree about it, which is the outcome we want.
        mark = "unreadable";
      }
      entries.set(relative(root, absolute).split(sep).join("/"), mark);
      if (mark === "directory") {
        walk(absolute);
      }
    }
  };
  walk(root);
  return entries;
}

export interface RuntimeChanges {
  created: string[];
  deleted: string[];
  modified: string[];
}

export function diffRuntimeEntries(before: Map<string, string>, after: Map<string, string>): RuntimeChanges {
  const created: string[] = [];
  const deleted: string[] = [];
  const modified: string[] = [];
  for (const [path, mark] of after) {
    const previous = before.get(path);
    if (previous === undefined) {
      created.push(path);
    } else if (previous !== mark) {
      modified.push(path);
    }
  }
  for (const path of before.keys()) {
    if (!after.has(path)) {
      deleted.push(path);
    }
  }
  return { created: created.sort(), deleted: deleted.sort(), modified: modified.sort() };
}

export function hasRuntimeChanges(changes: RuntimeChanges): boolean {
  return changes.created.length + changes.deleted.length + changes.modified.length > 0;
}

export function describeRuntimeChanges(changes: RuntimeChanges, subject: string): string {
  const lines = [
    `${subject} wrote into the repository's real runtime directory (${RUNTIME_GUARD_ROOT}).`,
    "",
    "That directory is not scratch space. On the deploy machine it holds the live",
    "Longbridge rate-limit ledger (longbridge-rate-limit-*.json, which is what keeps",
    "the account under a real broker limit), the report delivery state, and",
    "trading.sqlite. A test run must leave every byte of it alone.",
    ""
  ];
  const section = (label: string, paths: string[]): void => {
    if (paths.length > 0) {
      lines.push(`${label}: ${paths.join(", ")}`);
    }
  };
  section("created", changes.created);
  section("modified", changes.modified);
  section("deleted", changes.deleted);
  lines.push(
    "",
    "Point the code under test at a temp directory instead. For the Longbridge",
    "wrapper that means passing `{ rateLimitDir }` (or an env carrying",
    "LONGBRIDGE_RATE_LIMIT_DIR) to runLongbridgeText/Json - given neither, it falls",
    "back to <repo>/runtime. For anything with a database, pass an explicit path",
    "under mkdtempSync(join(tmpdir(), ...))."
  );
  return lines.join("\n");
}
