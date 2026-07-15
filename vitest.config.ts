import { defineConfig } from "vitest/config";

// Subprocess-spawning test files (real child processes with fixed spawn
// timeouts) started flaking under full-parallel runs once the suite grew
// past ~1100 tests: worker contention delays child startup beyond each
// test's own timeout. They are correct in isolation - the fix is to give
// the whole run a bounded worker pool and these specific files a serial
// lane, NOT to inflate their timeouts (which would slow genuine failures).
const SUBPROCESS_TEST_GLOBS = [
  "**/run-feishu-user-plugin.test.ts",
  "**/install-launchd.test.ts",
  "**/scheduled-report.test.ts",
  // Shares the repo-global Longbridge quote-lock file (TTL 50s since H7)
  // with scheduled-report's real-CLI-stub tests - if they run in parallel
  // workers, one blocks the other past its own test timeout.
  "**/_longbridge.test.ts"
];

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    // Cap parallelism a bit below core count so spawned children always
    // have headroom; vitest default saturates every core with workers,
    // leaving child processes starved during full runs.
    maxWorkers: 6,
    minWorkers: 1,
    poolMatchGlobs: SUBPROCESS_TEST_GLOBS.map((glob) => [glob, "forks"]),
    poolOptions: {
      forks: {
        // The subprocess-heavy files run one-at-a-time in a single fork so
        // their children never race the rest of the suite for CPU.
        singleFork: true
      }
    }
  }
});
