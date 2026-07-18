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

// P10 (Cloudflare Access JWT verification, apps/platform-app/src/identity.ts):
// with CF_ACCESS_TEAM_DOMAIN/CF_ACCESS_AUD unset the header identity path now
// FAILS CLOSED by default (the forgeable Cf-Access-Authenticated-User-Email
// header is never trusted without proof). Tests run in the loopback-dev
// posture, so this pins the documented escape hatch CF_ACCESS_DISABLED=true
// for the whole suite - route tests that authenticate via the Access header
// keep working without editing each one, and identity.test.ts overrides it
// per-test to exercise enforce/fail-closed modes.
const TEST_ENV = { CF_ACCESS_DISABLED: "true" };

export default defineConfig({
  test: {
    maxWorkers: 6,
    projects: [
      {
        test: {
          name: "serial-subprocess",
          environment: "node",
          env: TEST_ENV,
          include: [...SERIAL_TEST_GLOBS],
          fileParallelism: false
        }
      },
      {
        test: {
          name: "main",
          environment: "node",
          env: TEST_ENV,
          include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
          exclude: ["**/node_modules/**", ...SERIAL_TEST_GLOBS]
        }
      }
    ]
  }
});
