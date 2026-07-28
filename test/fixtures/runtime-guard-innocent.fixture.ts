/**
 * A test file that does nothing wrong, used as the payload for child-vitest
 * probes whose subject is the globalSetup rather than the test.
 *
 * Keeping the payload green matters: a probe that asserts "the run exited
 * non-zero" proves nothing if the test file could have failed on its own.
 */
import { expect, it } from "vitest";

it("PASSES: touches nothing outside its own process", () => {
  expect(true).toBe(true);
});
