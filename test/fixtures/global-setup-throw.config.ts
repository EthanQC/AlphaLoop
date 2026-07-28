import { defineConfig } from "vitest/config";

/**
 * Child vitest for the setup-phase half of J1. Reuses the innocent fixture as
 * its only test file - a run that would otherwise be entirely green, so a
 * non-zero exit can only have come from the refusing globalSetup.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/fixtures/runtime-guard-innocent.fixture.ts"],
    globalSetup: ["./test/fixtures/global-setup-throw.fixture.ts"]
  }
});
