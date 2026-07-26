import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("job execution timeouts (2026-07-26: weekly was being SIGTERM'd every run)", () => {
  const source = readFileSync(
    join(process.cwd(), "apps/openclaw-config/scripts/openclaw-cron-runner.mjs"),
    "utf8"
  );

  function timeoutMinutesFor(route: string): number {
    const line = source
      .split("\n")
      .find((candidate) => candidate.includes(`"${route}"`) && candidate.includes("timeoutMs"));
    if (!line) {
      throw new Error(`no allowedJobs entry found for ${route}`);
    }
    const match = /timeoutMs:\s*(\d+)\s*\*\s*60\s*\*\s*1000/u.exec(line);
    if (!match) {
      throw new Error(`could not parse timeoutMs for ${route}: ${line}`);
    }
    return Number(match[1]);
  }

  it("gives the weekly report enough headroom for its measured ~20 minute runtime", () => {
    // Live evidence (mini, 2026-07-26): three consecutive weekly runs died with
    // signal SIGTERM exactly 15:00 after start, and a manual run took ~20min.
    // A cap at or below the measured runtime means the pipeline can NEVER
    // succeed, so this pins real headroom rather than the old 15.
    expect(timeoutMinutesFor("/run/weekly")).toBeGreaterThanOrEqual(40);
  });

  it("keeps every job's timeout above its measured runtime", () => {
    // daily measured ~3.5min; stock-analysis fans out per symbol; the two
    // bookkeeping jobs are seconds. These are floors, not exact values.
    expect(timeoutMinutesFor("/run/daily")).toBeGreaterThanOrEqual(15);
    expect(timeoutMinutesFor("/run/stock-analysis")).toBeGreaterThanOrEqual(20);
    expect(timeoutMinutesFor("/run/monthly-review")).toBeGreaterThanOrEqual(5);
    expect(timeoutMinutesFor("/run/proposal-sweep")).toBeGreaterThanOrEqual(2);
  });
});
