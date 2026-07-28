import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  describeRuntimeChanges,
  diffRuntimeEntries,
  hasRuntimeChanges,
  snapshotRuntimeEntries
} from "./runtime-root-snapshot.js";

/**
 * G1 (2026-07-28, round-4 verifier): the suite used to be able to run against a
 * PREVIOUS build's output, and did.
 *
 * `pnpm test` was a bare `vitest run` with no build step (and pnpm 9 defaults
 * `enable-pre-post-scripts=false`, so a `pretest` hook would not have fired
 * either). Meanwhile ~60 files under apps/openclaw-config/scripts - production
 * .mjs scripts AND the .test.ts files that drive them - load
 * `../../../packages/shared-types/dist/index.js` by path, and one of them
 * (reviews.mjs) loads `../../platform-app/dist/data/strategy.js`. `dist` is
 * gitignored. So editing packages/shared-types/src and running the suite
 * without a build tested the OLD dist, and a round-2 claim of "proven by
 * running the real producer through the real delivery layer" was measured
 * against exactly that stale artifact.
 *
 * The obvious shortcut - aliasing `dist` to `src` in the vitest config - is
 * wrong here: the .mjs scripts genuinely `import` dist in production, so an
 * alias would prove things about a module graph production never loads. The
 * fix therefore keeps the dist imports and removes the staleness instead: this
 * global setup BUILDS the workspace before any test file is loaded, and refuses
 * to let the run start if the build fails or leaves a required artifact
 * missing. It runs for every vitest entry point - `pnpm test`, a bare
 * `vitest run`, `vitest run <one-file>`, watch mode, an IDE runner - which is
 * why it lives here rather than in the `test` script.
 *
 * Cost: `tsc -b` is incremental (every project is `composite: true`), so a
 * no-op build is ~0.15s.
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");

/**
 * The `composite` projects the root tsconfig references, in the exact spelling
 * `tsc -b --dry` reports them. Kept explicit so that ADDING a project to the
 * root tsconfig without teaching this file about it fails the run instead of
 * silently going unverified.
 *
 * H4 (2026-07-28, round-5): that second sentence was not true when it was
 * written. `staleProjects` only ever filtered THIS list, so a fifth project
 * would have been built by `tsc -b` and then checked by nobody - the report
 * would simply not mention it and nothing would complain.
 * `unlistedProjects` below is what makes the claim true.
 */
const BUILT_PROJECTS = [
  "packages/shared-types/tsconfig.json",
  "apps/broker-executor/tsconfig.json",
  "apps/longbridge-cli/tsconfig.json",
  "apps/platform-app/tsconfig.json"
] as const;

/**
 * Emitted files that source outside the TypeScript projects loads BY PATH, so
 * tsc's own "up to date" bookkeeping is not enough to vouch for them: `tsc -b`
 * trusts its .tsbuildinfo and will report a project up to date even when its
 * output files have been deleted (verified 2026-07-28: `rm dist/index.js` then
 * `tsc -b` restores nothing). A missing artifact here forces `--force`.
 */
const REQUIRED_ARTIFACTS = [
  "packages/shared-types/dist/index.js",
  "packages/shared-types/dist/index.d.ts",
  "apps/platform-app/dist/data/strategy.js",
  "apps/broker-executor/dist/index.js",
  "apps/longbridge-cli/dist/index.js"
] as const;

/**
 * Set by this setup, read by test/build-freshness.test.ts. Its only job is to
 * make deleting the `globalSetup` wiring a failing test rather than a silent
 * return to stale-dist testing.
 */
export const BUILD_STAMP_ENV = "ALPHALOOP_TEST_WORKSPACE_BUILD";

/**
 * J1 (2026-07-29, round-6): a violation detected in the TEARDOWN below has to
 * fail the process itself, because throwing is not enough.
 *
 * Measured on vitest 4.1.7 (this repo's pinned version), minimal config, one
 * passing test, a globalSetup whose teardown throws:
 *
 *     Test Files  1 passed (1)
 *          Tests  1 passed (1)
 *     error during close Error: TEARDOWN-THREW ...
 *     $? = 0
 *
 * The reason is in vitest's own `Vitest.close()`
 * (dist/chunks/cli-api.C6CiCDM3.js:13919-13940): teardown rejections are
 * collected into `teardownErrors`, handed to `this.logger.error("error during
 * close", ...)`, and `process.exitCode` is never touched. So the backstop that
 * exists to protect the deploy machine's live Longbridge rate-limit ledger
 * printed the violation and then blessed the run - and "error during close"
 * reads like a cleanup nit rather than a failure.
 *
 * This does three things instead of one, because the swallow was itself the
 * result of trusting a single library-version-specific behavior:
 *   1. prints the violation to stderr under an unmissable banner, on our own
 *      terms rather than as vitest's close-time footnote;
 *   2. sets `process.exitCode` - safe as the primary mechanism because no
 *      branch anywhere in vitest 4.1.7 ever assigns `process.exitCode = 0`
 *      (grepped: every write in dist/ is `= 1`, `= 130` or `= 128 + signal`),
 *      so nothing downstream can undo it;
 *   3. registers a last-word `exit` listener, so that a future vitest which
 *      DOES reset the code before exiting still cannot make this green.
 * Then it throws, so vitest also reports it and a future vitest that honors
 * teardown throws needs no further change here.
 *
 * Deliberately NOT used by the setup-phase failures below. Those were measured
 * on the same version and already exit 1 (vitest routes a globalSetup throw
 * through its "Unhandled Error" path, which does set the code); routing them
 * through this would additionally set `process.exitCode` inside vitest WORKER
 * processes, because test/build-freshness.test.ts and
 * test/runtime-write-guard.test.ts call the exported helpers and `setup()`
 * itself from inside a worker, and a worker exiting non-zero of its own accord
 * is reported as a crashed pool rather than as the failed assertion it is.
 * test/runtime-write-guard.test.ts pins BOTH halves of that split by injection.
 */
export function failRunFromTeardown(message: string): never {
  const banner = "=".repeat(72);
  process.stderr.write(
    `\n${banner}\nRUN FAILED: RUNTIME WRITE GUARD\n${banner}\n\n${message}\n\n` +
      `(test/global-setup.ts forced a non-zero exit here: vitest 4.1.7 logs a teardown throw as `+
      `"error during close" and would otherwise exit 0.)\n${banner}\n\n`
  );
  process.exitCode = 1;
  process.on("exit", () => {
    if (process.exitCode === undefined || process.exitCode === null || process.exitCode === 0) {
      process.exitCode = 1;
    }
  });
  throw new Error(message);
}

function runTsc(args: string[]): string {
  try {
    return execFileSync(process.execPath, [TSC, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim();
    throw new Error(
      `tsc ${args.join(" ")} failed, so packages/*/dist is stale or absent and every test that ` +
        `imports dist would be measuring the PREVIOUS build. Fix the build first.\n${output || failure.message || ""}`
    );
  }
}

export function missingArtifacts(): string[] {
  return REQUIRED_ARTIFACTS.filter((relative) => !existsSync(join(ROOT, relative)));
}

/**
 * Projects `tsc -b --dry` does NOT report as up to date - i.e. whose emitted
 * output no longer matches its sources.
 *
 * A project that disappears from the report counts as not-up-to-date too: if
 * tsc ever changes the wording of the "is up to date" line, this must fail
 * loudly rather than quietly find nothing to complain about.
 */
export function staleProjects(): string[] {
  const report = runTsc(["-b", "--dry"]);
  return BUILT_PROJECTS.filter((project) => !report.includes(`'${join(ROOT, project)}' is up to date`));
}

/**
 * Projects `tsc -b` builds that BUILT_PROJECTS does not name (H4).
 *
 * `tsc -b --dry` reports one line per project in the build graph
 * (`Project '<abs path>/tsconfig.json' is up to date`), so the graph can be
 * compared against the list rather than only sampled through it. Without this,
 * adding a fifth reference to the root tsconfig would leave it built but never
 * checked for staleness, and both this file's header and
 * test/build-freshness.test.ts would go on reporting green about four.
 */
export function unlistedProjects(): string[] {
  const report = runTsc(["-b", "--dry"]);
  const listed = new Set(BUILT_PROJECTS.map((project) => join(ROOT, project)));
  const seen = [...report.matchAll(/Project '([^']+)'/gu)].map((match) => match[1] as string);
  return [...new Set(seen)].filter((project) => !listed.has(project)).sort();
}

export default async function setup(): Promise<() => void> {
  const startedAt = Date.now();
  runTsc(["-b"]);

  const missing = missingArtifacts();
  if (missing.length > 0) {
    runTsc(["-b", "--force"]);
    const stillMissing = missingArtifacts();
    if (stillMissing.length > 0) {
      throw new Error(
        `the workspace build finished but these artifacts are still absent, and tests import them ` +
          `by path: ${stillMissing.join(", ")}`
      );
    }
  }

  const stale = staleProjects();
  if (stale.length > 0) {
    throw new Error(
      `after building, tsc still does not consider these projects up to date: ${stale.join(", ")}. ` +
        `Refusing to run the suite against output that does not match its sources.`
    );
  }

  const unlisted = unlistedProjects();
  if (unlisted.length > 0) {
    throw new Error(
      `tsc -b builds these projects, but BUILT_PROJECTS in test/global-setup.ts does not name them, so ` +
        `nothing checks whether their output matches their sources: ${unlisted.join(", ")}. Add them to that list.`
    );
  }

  process.env[BUILD_STAMP_ENV] = JSON.stringify({
    builtAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    setupPid: process.pid,
    projects: [...BUILT_PROJECTS],
    forced: missing.length > 0
  });

  // H1's whole-run backstop. test/runtime-write-guard.ts fails the individual
  // test that writes into the real runtime/, but its window opens at the first
  // beforeEach - it cannot see a write that happens while a test file is being
  // IMPORTED (five production .mjs modules touch runtimeRoot at import time),
  // nor one that lands after the last test finished. This compares the whole
  // directory across the whole run and fails the run if anything moved.
  const before = snapshotRuntimeEntries();
  return () => {
    const changes = diffRuntimeEntries(before, snapshotRuntimeEntries());
    if (hasRuntimeChanges(changes)) {
      // Not a bare `throw`: vitest 4.1.7 swallows one here and exits 0, which
      // made this whole backstop decorative. See failRunFromTeardown.
      failRunFromTeardown(describeRuntimeChanges(changes, "this test run"));
    }
  };
}
