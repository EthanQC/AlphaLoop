import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(join(process.cwd(), "apps/openclaw-config/scripts/install-user-schedules.mjs"), "utf8");

describe("user launchd schedule cleanup", () => {
  it("installs daily prepare and deliver schedules for Tuesday through Saturday Shanghai time", () => {
    expect(script).toContain("label: \"com.openclaw.trading.report.daily.prepare\"");
    expect(script).toContain("label: \"com.openclaw.trading.report.daily.deliver\"");
    expect(script).toContain("[2, 3, 4, 5, 6].map((Weekday)");
  });

  it("retires old user-level trading jobs when installing retained schedules", () => {
    for (const label of [
      "com.openclaw.trading.event-bus",
      "com.openclaw.trading.event-ingestor",
      "com.openclaw.trading.live-advisor",
      "com.openclaw.trading.paper-trader",
      "com.openclaw.trading.catchup",
      "com.openclaw.trading.maintenance.latest",
      "com.openclaw.trading.context.maintenance"
    ]) {
      expect(script).toContain(label);
    }
  });
});
