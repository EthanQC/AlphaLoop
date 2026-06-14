import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(join(process.cwd(), "apps/openclaw-config/scripts/install-user-schedules.mjs"), "utf8");

describe("user launchd schedule cleanup", () => {
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
