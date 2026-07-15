import { defineConfig } from "vitest/config";

// Subprocess-spawning / lock-contending test files started flaking under
// full-parallel runs once the suite grew past ~1100 tests: worker saturation
// starves spawned child processes past their fixed timeouts, and the
// repo-global Longbridge quote lock (TTL 50s since H7) lets _longbridge
// tests block scheduled-report's macro-degradation test across workers.
// Vitest 4 project split: these files run in a serial lane
// (fileParallelism: false), everything else keeps a bounded parallel pool.
// Timeouts stay untouched so genuine hangs still fail fast.
const SERIAL_TEST_GLOBS = [
  "**/run-feishu-user-plugin.test.ts",
  "**/install-launchd.test.ts",
  "**/scheduled-report.test.ts",
  "**/_longbridge.test.ts"
];

export default defineConfig({
  test: {
    maxWorkers: 6,
    projects: [
      {
        test: {
          name: "serial-subprocess",
          environment: "node",
          include: [...SERIAL_TEST_GLOBS],
          fileParallelism: false
        }
      },
      {
        test: {
          name: "main",
          environment: "node",
          include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
          exclude: ["**/node_modules/**", ...SERIAL_TEST_GLOBS]
        }
      }
    ]
  }
});
