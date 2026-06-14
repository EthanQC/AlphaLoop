import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(join(process.cwd(), "apps/openclaw-config/scripts/openclaw-cron-runner.mjs"), "utf8");

describe("OpenClaw cron runner", () => {
  it("uses the launchd-provided pnpm binary when spawning project jobs", () => {
    expect(script).toContain("process.env.PNPM_BIN");
    expect(script).toContain("[pnpmBin, \"stock-analysis:scheduled\"]");
  });

  it("turns spawn failures into structured run results instead of crashing the service", () => {
    expect(script).toContain("child.on(\"error\"");
    expect(script).toContain("ok: !exit.error && exit.code === 0");
    expect(script).toContain("error: exit.error ? String");
  });

  it("watches OpenClaw cron run logs and records processed runs", () => {
    expect(script).toContain("OPENCLAW_CRON_DIR");
    expect(script).toContain("jobs.json");
    expect(script).toContain("processed-runs.json");
    expect(script).toContain("openclaw-cron-run-log");
    expect(script).toContain("readCronRunEntries");
  });
});
