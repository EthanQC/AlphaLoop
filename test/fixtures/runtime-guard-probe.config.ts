import { defineConfig } from "vitest/config";

/**
 * The child vitest that test/runtime-write-guard.test.ts spawns to prove the
 * guard fires for real - same setup file, same hooks, real worker.
 *
 * No `globalSetup`: this probe asserts nothing about `dist`, and rebuilding the
 * workspace a second time inside an already-built run would only make the proof
 * slower. The guarded root arrives through the spawned process's env
 * (ALPHALOOP_RUNTIME_GUARD_ROOT), which the worker inherits, rather than through
 * `test.env` - one fewer assumption about when Vitest applies config env
 * relative to setup files.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/fixtures/runtime-guard-violation.fixture.ts"],
    setupFiles: ["./test/runtime-write-guard.ts"]
  }
});
