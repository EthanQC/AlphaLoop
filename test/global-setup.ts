import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
 * The four `composite` projects the root tsconfig references, in the exact
 * spelling `tsc -b --dry` reports them. Kept explicit so that ADDING a project
 * to the root tsconfig without teaching this file about it fails the run
 * instead of silently going unbuilt and unverified.
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

export default async function setup(): Promise<void> {
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

  process.env[BUILD_STAMP_ENV] = JSON.stringify({
    builtAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    setupPid: process.pid,
    projects: [...BUILT_PROJECTS],
    forced: missing.length > 0
  });
}
