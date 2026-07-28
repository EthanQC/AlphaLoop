import { defineConfig } from "vitest/config";

/**
 * The child vitest that proves J1: an import-time write into the guarded
 * runtime root must fail the RUN, not just get logged on the way out.
 *
 * Unlike test/fixtures/runtime-guard-probe.config.ts this one DOES load the
 * real `./test/global-setup.ts`, because the mechanism under test is that
 * file's teardown. Using the production setup rather than a stand-in is the
 * point: a copy would prove something about the copy. Its `tsc -b` is
 * incremental and the parent run has already built, so the cost is a no-op
 * build.
 *
 * The per-test guard is loaded too, so the run also demonstrates that the
 * per-test half stays silent for this window rather than accidentally covering
 * for the backstop.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/fixtures/runtime-guard-import-time.fixture.ts"],
    setupFiles: ["./test/runtime-write-guard.ts"],
    globalSetup: ["./test/global-setup.ts"]
  }
});
