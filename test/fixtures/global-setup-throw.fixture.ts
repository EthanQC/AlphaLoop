/**
 * J1's second half, driven by test/runtime-write-guard.test.ts.
 *
 * test/global-setup.ts has five ways to refuse a run. Four of them (build
 * failure, missing artifact, stale project, unlisted project) throw from the
 * SETUP phase and are left as plain throws, on the measured basis that vitest
 * routes a globalSetup throw through its "Unhandled Error" path and exits 1.
 * The fifth throws from the TEARDOWN, where vitest 4.1.7 swallows it, which is
 * why `failRunFromTeardown` exists.
 *
 * That asymmetry is a load-bearing assumption about a third-party library, and
 * the round-6 finding was precisely that such an assumption had gone stale
 * unnoticed. This fixture pins it: if a vitest upgrade ever starts swallowing
 * setup-phase throws too, the parent test fails here and says so, instead of
 * four build-freshness guards quietly becoming decorative.
 */
export default async function setup(): Promise<() => void> {
  throw new Error("SETUP PHASE REFUSED THE RUN: stand-in for a stale-dist refusal");
}
