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
  "**/_longbridge.test.ts",
  // 2026-07-26: the cron-runner suite grew real-subprocess cases (fake
  // openclaw CLI + spawned pnpm stand-ins + retry/backoff timers) when the
  // alert circuit breaker and run_log recording landed. Under the parallel
  // pool a DIFFERENT case in it times out on nearly every run while the file
  // passes 41/41 in isolation - classic worker starvation, not a real defect.
  "**/openclaw-cron-runner.test.ts"
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
          fileParallelism: false,
          // These files spawn real child processes and wait on poll/backoff
          // timers; the 5s default leaves no headroom on a loaded machine, so
          // a different case flaked on nearly every run even in the serial
          // lane. 60s is generous for cases that normally finish in ~2-15s
          // while still failing fast on a genuine hang.
          testTimeout: 60_000,
          hookTimeout: 60_000
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
