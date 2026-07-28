// Round 7. The doctor CLI's readers were previously unreachable from a test -
// the CLI is a script that runs a whole health check on import - and three of
// this round's findings were in there. These are the pure halves, split into
// openclaw-runtime-doctor-probes.mjs and driven with the exact shapes the real
// CLI and the real gateway produce.
import { describe, expect, it } from "vitest";

import {
  describeOpenClawCliFailure,
  judgeReportDeliveryState,
  parseOpenClawCronList
} from "./openclaw-runtime-doctor-probes.mjs";

describe("K8: reading the openclaw cron registry", () => {
  // The envelope measured read-only on the deploy target, 2026-07-29:
  // `openclaw cron list --json --agent control --all` ->
  // {jobs, total, offset, limit, hasMore, nextOffset, deliveryPreviews}.
  const envelope = (jobs: unknown[], extra: Record<string, unknown> = {}) => ({
    jobs,
    total: jobs.length,
    offset: 0,
    limit: jobs.length,
    hasMore: false,
    nextOffset: null,
    ...extra
  });

  it("reads the shape the deploy target returns today", () => {
    const parsed = parseOpenClawCronList(envelope([
      { id: "1", name: "openclaw-trading-daily-report", agentId: "control", enabled: true },
      { id: "2", name: "openclaw-trading-weekly-report", agentId: "control", enabled: true }
    ]));

    expect(parsed.names).toEqual(["openclaw-trading-daily-report", "openclaw-trading-weekly-report"]);
    expect(parsed.disabledNames).toEqual([]);
    expect(parsed.total).toBe(2);
    expect(parsed.truncated).toBe(false);
  });

  it("keeps a disabled job out of the installed set instead of counting it as present", () => {
    const parsed = parseOpenClawCronList(envelope([
      { name: "openclaw-trading-daily-report", enabled: true },
      { name: "openclaw-trading-stock-analysis", enabled: false }
    ]));

    expect(parsed.names).toEqual(["openclaw-trading-daily-report"]);
    expect(parsed.disabledNames).toEqual(["openclaw-trading-stock-analysis"]);
  });

  it("carries hasMore through, because a truncated page is not an absence", () => {
    // This gateway also serves the operator's 186-agent personal fleet, and
    // this CLI version has no --limit/--offset to page with.
    const parsed = parseOpenClawCronList(envelope(
      [{ name: "somebody-elses-job", enabled: true }],
      { total: 240, limit: 200, hasMore: true, nextOffset: 200 }
    ));

    expect(parsed.truncated).toBe(true);
    expect(parsed.total).toBe(240);
  });

  it("still understands a bare array and a {data} envelope from older CLIs", () => {
    expect(parseOpenClawCronList([{ name: "a" }]).names).toEqual(["a"]);
    expect(parseOpenClawCronList({ data: [{ id: "b" }] }).names).toEqual(["b"]);
    // No `enabled` field at all means "this CLI does not report it" - such a
    // job is installed, not disabled.
    expect(parseOpenClawCronList([{ name: "a" }]).disabledNames).toEqual([]);
  });
});

describe("K8: naming the reason an openclaw call failed", () => {
  it("does not report the CLI's own warning banner as the cause", () => {
    // The banner this CLI prints to stderr even on success.
    const error = {
      stderr: [
        "Config warnings:",
        "  - gateway.remote.url is set but unused",
        "GatewayTransportError: connect ECONNREFUSED 127.0.0.1:18789"
      ].join("\n")
    };

    expect(describeOpenClawCliFailure(error)).toBe("GatewayTransportError: connect ECONNREFUSED 127.0.0.1:18789");
  });

  it("falls back to the last stderr line, then to the process error, never to a blank", () => {
    expect(describeOpenClawCliFailure({ stderr: "Config warnings:\n  - only warnings here" }))
      .toBe("- only warnings here");
    expect(describeOpenClawCliFailure({ stderr: "", message: "spawn openclaw ENOENT" }))
      .toBe("spawn openclaw ENOENT");
  });
});

describe("K5: which report delivery the gate judges", () => {
  // THE SHAPE THE DEPLOY TARGET PRODUCES TODAY. After J2 a circle-public report
  // with no FEISHU_GROUP_CHAT_ID is REFUSED, so it is recorded with
  // `deliveryFailedAt` and never a `deliveredAt` - and this reader used to rank
  // by `deliveredAt` alone, which made the error-severity check that reads
  // `groupFallback` unreachable.
  const refused = {
    "daily:2026-07-20": {
      deliveredAt: "2026-07-20T12:00:00.000Z",
      groupFallback: false
    },
    "weekly:2026-07-26": {
      deliveryFailedAt: "2026-07-26T12:00:00.000Z",
      deliveryFailureReason: "圈子公共报告没有配置群聊目标（FEISHU_GROUP_CHAT_ID）",
      groupFallback: true,
      groupFallbackReason: "FEISHU_GROUP_CHAT_ID 未配置"
    }
  };

  it("sees a refused delivery that is newer than the last successful one", () => {
    const judged = judgeReportDeliveryState(refused);

    expect(judged.lastDeliveryLabel).toBe("weekly:2026-07-26");
    expect(judged.lastDeliveryGroupFallback).toBe(true);
    expect(judged.lastDeliverySent).toBe(false);
    expect(judged.lastDeliveryReason).toBe("FEISHU_GROUP_CHAT_ID 未配置");
  });

  it("uses the failure reason when there is no groupFallbackReason", () => {
    const judged = judgeReportDeliveryState({
      "daily:2026-07-27": {
        deliveryFailedAt: "2026-07-27T12:00:00.000Z",
        deliveryFailureReason: "Report delivery was not sent.",
        groupFallback: true
      }
    });

    expect(judged.lastDeliveryReason).toBe("Report delivery was not sent.");
  });

  it("says nothing about a state file with no delivery in it", () => {
    expect(judgeReportDeliveryState({ "daily:2026-07-28": { path: "reports/daily/2026-07-28.md" } }))
      .toMatchObject({ lastDeliveryLabel: null, lastDeliveryGroupFallback: false, lastDeliverySent: null });
    expect(judgeReportDeliveryState(null)).toMatchObject({ lastDeliveryLabel: null });
  });

  it("reports a successful group delivery as sent, with no fallback", () => {
    const judged = judgeReportDeliveryState({
      "daily:2026-07-28": { deliveredAt: "2026-07-28T12:00:00.000Z", groupFallback: false }
    });

    expect(judged.lastDeliverySent).toBe(true);
    expect(judged.lastDeliveryGroupFallback).toBe(false);
  });
});
