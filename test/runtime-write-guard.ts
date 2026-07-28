/**
 * H1 (2026-07-28, round-5): the per-test half of the runtime-write guard.
 *
 * Wired as `setupFiles` on BOTH vitest projects, so it runs inside every test
 * worker and its hooks apply to every test in every file. It records what lives
 * under the real runtime root before each test and looks again after; an entry
 * created, modified or deleted fails THAT test with the path that changed.
 *
 * `test/runtime-root-snapshot.ts` carries the finding this exists for, the two
 * mechanisms measured and rejected before it, and the snapshot rules.
 *
 * Two windows this half cannot see, both covered by the whole-run backstop in
 * test/global-setup.ts: a write during module IMPORT (collection happens before
 * the first beforeEach) and a write that lands after the last test finishes.
 */
import { afterEach, beforeEach } from "vitest";

import { describeRuntimeChanges, diffRuntimeEntries, hasRuntimeChanges, snapshotRuntimeEntries } from "./runtime-root-snapshot.js";

let baseline = new Map<string, string>();

beforeEach(() => {
  // Re-taken per test rather than once per file, so an offending test fails
  // alone instead of poisoning every test that follows it.
  baseline = snapshotRuntimeEntries();
});

afterEach((context) => {
  const changes = diffRuntimeEntries(baseline, snapshotRuntimeEntries());
  if (hasRuntimeChanges(changes)) {
    throw new Error(describeRuntimeChanges(changes, `the test "${context.task.name}"`));
  }
});
