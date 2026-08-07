import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { openTradingDatabase } from "../../../packages/shared-types/dist/index.js";
import { launchdLabelsWithScope } from "./install-launchd-ownership.mjs";
import { consecutiveFailureCount, lastEscalationAt, lastRecoveryAt, lastRunAt, recordJobRun } from "./job-run-log.mjs";
import {
  SCHEDULED_JOB_DAILY_BACKUP,
  SCHEDULED_JOB_ESCALATION_THRESHOLD,
  SCHEDULED_JOB_ESCALATION_THROTTLE_MS,
  SCHEDULED_JOB_OFFICIAL_PAPER_PNL,
  SCHEDULED_JOB_OFFICIAL_PAPER_POLL,
  SCHEDULED_LAUNCHD_JOBS,
  buildScheduledFailureCard,
  isScheduledEscalationDue,
  isScheduledRecoveryDue,
  runScheduledJobWithHeartbeat
} from "./scheduled-job-heartbeat.mjs";

const tempDirs: string[] = [];

function makeDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-scheduled-heartbeat-"));
  tempDirs.push(dir);
  return openTradingDatabase(join(dir, "trading.sqlite"));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

const repoRoot = process.cwd();
const scriptsDir = join(repoRoot, "apps/openclaw-config/scripts");

type Card = { title: string; lines: string[] };

function recordFailures(db: DatabaseSync, job: string, count: number, startMs = Date.parse("2026-07-20T00:00:00.000Z")) {
  for (let index = 0; index < count; index += 1) {
    recordJobRun(db, {
      job,
      startedAt: new Date(startMs + index * 3_600_000).toISOString(),
      ok: false
    });
  }
}

describe("SCHEDULED_LAUNCHD_JOBS", () => {
  // Fixture honesty: this list is only useful if it names the labels the REAL
  // installer really renders as scheduled daemons. Both halves are read from
  // their production sources here - the manifest .txt and the installer .sh -
  // never from a shape authored inside this test.
  const daemonSource = readFileSync(join(scriptsDir, "install-system-daemons.sh"), "utf8");
  const systemLabels = launchdLabelsWithScope("system") as string[];

  it("covers exactly the system daemons that carry a StartCalendarInterval/StartInterval schedule, minus the alerter", () => {
    // A daemon is "scheduled" when write_plist is given a schedule block. In
    // install-system-daemons.sh every such call passes one of the
    // SCHEDULE_<NAME> variables as its 7th argument.
    const scheduledLabels = systemLabels.filter((label) => {
      const call = daemonSource.split(`"${label}" \\`)[1];
      return call !== undefined && /\$\{SCHEDULE_[A-Z_]+\}/u.test(call.split("write_plist")[0] ?? "");
    });

    // market-alerts is scheduled too, but it drives its own, richer
    // escalation state machine inside market-alerts-poll.mjs (delivery-health
    // pair, ALERTER-DOWN artifact, file-based fallback counter) and already
    // wrote run_log rows before this module existed - so it is deliberately
    // NOT wrapped here. Everything else that is scheduled must be.
    expect(scheduledLabels).toContain("com.alphaloop.market-alerts");
    const expected = scheduledLabels.filter((label) => label !== "com.alphaloop.market-alerts").sort();
    const covered = SCHEDULED_LAUNCHD_JOBS.map((entry) => entry.label).sort();
    expect(covered).toEqual(expected);
  });

  it("names every job's label with a scope of `system` in the ownership manifest", () => {
    for (const entry of SCHEDULED_LAUNCHD_JOBS) {
      expect(systemLabels).toContain(entry.label);
    }
  });
});

describe("runScheduledJobWithHeartbeat", () => {
  it("writes one ok=1 heartbeat row for a successful run and returns the body's value", async () => {
    const db = makeDb();
    const result = await runScheduledJobWithHeartbeat(
      db,
      { job: SCHEDULED_JOB_DAILY_BACKUP, now: () => new Date("2026-07-30T05:30:00.000Z") },
      () => ({ files: ["trading.sqlite"] })
    );

    expect(result).toEqual({ files: ["trading.sqlite"] });
    expect(lastRunAt(db, SCHEDULED_JOB_DAILY_BACKUP)).toBe("2026-07-30T05:30:00.000Z");
    expect(consecutiveFailureCount(db, SCHEDULED_JOB_DAILY_BACKUP)).toBe(0);
  });

  it("records a failed run and rethrows the original error unchanged", async () => {
    const db = makeDb();
    const boom = new Error("长桥 CLI 超时");

    await expect(
      runScheduledJobWithHeartbeat(
        db,
        { job: SCHEDULED_JOB_OFFICIAL_PAPER_POLL, now: () => new Date("2026-07-30T09:30:00.000Z") },
        () => {
          throw boom;
        }
      )
    ).rejects.toBe(boom);

    expect(consecutiveFailureCount(db, SCHEDULED_JOB_OFFICIAL_PAPER_POLL)).toBe(1);
    expect(lastRunAt(db, SCHEDULED_JOB_OFFICIAL_PAPER_POLL)).toBe("2026-07-30T09:30:00.000Z");
  });

  it("records a not-due invocation as a neutral heartbeat without clearing an open failure", async () => {
    const db = makeDb();
    recordJobRun(db, {
      job: SCHEDULED_JOB_OFFICIAL_PAPER_PNL,
      startedAt: "2026-07-30T10:00:00.000Z",
      ok: false,
      failedStep: "run"
    });

    const result = await runScheduledJobWithHeartbeat(
      db,
      { job: SCHEDULED_JOB_OFFICIAL_PAPER_PNL, now: () => new Date("2026-07-30T11:00:00.000Z") },
      () => ({ skipped: true, reason: "outside_post_open_pnl_window" })
    );

    expect(result).toEqual({ skipped: true, reason: "outside_post_open_pnl_window" });
    expect(lastRunAt(db, SCHEDULED_JOB_OFFICIAL_PAPER_PNL)).toBe("2026-07-30T11:00:00.000Z");
    expect(consecutiveFailureCount(db, SCHEDULED_JOB_OFFICIAL_PAPER_PNL)).toBe(1);
    const latest = db.prepare(`
      SELECT ok, evidence FROM run_log
      WHERE job = ? ORDER BY rowid DESC LIMIT 1
    `).get(SCHEDULED_JOB_OFFICIAL_PAPER_PNL) as { ok: number; evidence: string };
    expect(latest.ok).toBe(1);
    expect(JSON.parse(latest.evidence)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "scheduled_not_due" })
    ]));
  });

  it("does not send a recovery card for a neutral not-due heartbeat", async () => {
    const db = makeDb();
    recordJobRun(db, {
      job: SCHEDULED_JOB_OFFICIAL_PAPER_PNL,
      startedAt: "2026-07-30T10:00:00.000Z",
      ok: false,
      evidence: [{ event: "escalation_sent", at: "2026-07-30T10:00:00.000Z" }]
    });
    const sent: Card[] = [];

    await runScheduledJobWithHeartbeat(
      db,
      {
        job: SCHEDULED_JOB_OFFICIAL_PAPER_PNL,
        now: () => new Date("2026-07-30T11:00:00.000Z"),
        sendCard: async (card: Card) => { sent.push(card); return { ok: true }; }
      },
      () => ({ skipped: true, reason: "outside_post_open_pnl_window" })
    );

    expect(sent).toHaveLength(0);
    expect(lastRecoveryAt(db, SCHEDULED_JOB_OFFICIAL_PAPER_PNL)).toBeNull();
  });

  it("stays silent for the first two failures and escalates on the third", async () => {
    const db = makeDb();
    const sent: Card[] = [];
    const sendCard = async (card: Card) => {
      sent.push(card);
      return { ok: true };
    };

    for (let attempt = 1; attempt <= SCHEDULED_JOB_ESCALATION_THRESHOLD; attempt += 1) {
      await expect(
        runScheduledJobWithHeartbeat(
          db,
          {
            job: SCHEDULED_JOB_OFFICIAL_PAPER_PNL,
            now: () => new Date(`2026-07-30T0${attempt}:00:00.000Z`),
            sendCard
          },
          () => {
            throw new Error("盈亏播报失败");
          }
        )
      ).rejects.toThrow("盈亏播报失败");

      expect(sent).toHaveLength(attempt < SCHEDULED_JOB_ESCALATION_THRESHOLD ? 0 : 1);
    }

    expect(sent[0]?.title).toBe("⚠ 定时任务连续失败：官方模拟盘盈亏播报");
    expect(sent[0]?.lines[0]).toContain("com.openclaw.trading.official-paper.pnl");
    expect(sent[0]?.lines[0]).toContain("连续 3 次");
    expect(lastEscalationAt(db, SCHEDULED_JOB_OFFICIAL_PAPER_PNL)).toBe("2026-07-30T03:00:00.000Z");
  });

  it("throttles a still-open outage to one card per window, then re-escalates after it", async () => {
    const db = makeDb();
    const sent: Card[] = [];
    const sendCard = async (card: Card) => {
      sent.push(card);
      return { ok: true };
    };
    recordFailures(db, SCHEDULED_JOB_DAILY_BACKUP, SCHEDULED_JOB_ESCALATION_THRESHOLD);
    recordJobRun(db, {
      job: SCHEDULED_JOB_DAILY_BACKUP,
      startedAt: "2026-07-20T03:00:00.000Z",
      ok: false,
      evidence: [{ event: "escalation_sent", at: "2026-07-20T03:00:00.000Z" }]
    });

    const withinWindow = new Date(Date.parse("2026-07-20T03:00:00.000Z") + SCHEDULED_JOB_ESCALATION_THROTTLE_MS - 1000);
    await expect(
      runScheduledJobWithHeartbeat(
        db,
        { job: SCHEDULED_JOB_DAILY_BACKUP, now: () => withinWindow, sendCard },
        () => {
          throw new Error("备份目录不可写");
        }
      )
    ).rejects.toThrow();
    expect(sent).toHaveLength(0);

    const afterWindow = new Date(Date.parse("2026-07-20T03:00:00.000Z") + SCHEDULED_JOB_ESCALATION_THROTTLE_MS + 1000);
    await expect(
      runScheduledJobWithHeartbeat(
        db,
        { job: SCHEDULED_JOB_DAILY_BACKUP, now: () => afterWindow, sendCard },
        () => {
          throw new Error("备份目录不可写");
        }
      )
    ).rejects.toThrow();
    expect(sent).toHaveLength(1);
  });

  it("sends a recovery card on the first success after an escalation, and only once", async () => {
    const db = makeDb();
    const sent: Card[] = [];
    const sendCard = async (card: Card) => {
      sent.push(card);
      return { ok: true };
    };
    recordJobRun(db, {
      job: SCHEDULED_JOB_OFFICIAL_PAPER_POLL,
      startedAt: "2026-07-20T03:00:00.000Z",
      ok: false,
      evidence: [{ event: "escalation_sent", at: "2026-07-20T03:00:00.000Z" }]
    });

    await runScheduledJobWithHeartbeat(
      db,
      { job: SCHEDULED_JOB_OFFICIAL_PAPER_POLL, now: () => new Date("2026-07-20T04:00:00.000Z"), sendCard },
      () => ({ polled: true })
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.title).toBe("✅ 定时任务已恢复：官方模拟盘轮询");
    expect(lastRecoveryAt(db, SCHEDULED_JOB_OFFICIAL_PAPER_POLL)).toBe("2026-07-20T04:00:00.000Z");

    await runScheduledJobWithHeartbeat(
      db,
      { job: SCHEDULED_JOB_OFFICIAL_PAPER_POLL, now: () => new Date("2026-07-20T05:00:00.000Z"), sendCard },
      () => ({ polled: true })
    );
    expect(sent).toHaveLength(1);
  });

  it("never marks an escalation as sent when the card was not delivered", async () => {
    const db = makeDb();
    recordFailures(db, SCHEDULED_JOB_DAILY_BACKUP, SCHEDULED_JOB_ESCALATION_THRESHOLD);

    await expect(
      runScheduledJobWithHeartbeat(
        db,
        {
          job: SCHEDULED_JOB_DAILY_BACKUP,
          now: () => new Date("2026-07-20T06:00:00.000Z"),
          sendCard: async () => ({ ok: false, error: "飞书群未配置" })
        },
        () => {
          throw new Error("备份失败");
        }
      )
    ).rejects.toThrow();

    expect(lastEscalationAt(db, SCHEDULED_JOB_DAILY_BACKUP)).toBeNull();
  });

  it("still records the heartbeat when the card transport throws", async () => {
    const db = makeDb();
    recordFailures(db, SCHEDULED_JOB_DAILY_BACKUP, SCHEDULED_JOB_ESCALATION_THRESHOLD);

    await expect(
      runScheduledJobWithHeartbeat(
        db,
        {
          job: SCHEDULED_JOB_DAILY_BACKUP,
          now: () => new Date("2026-07-20T06:00:00.000Z"),
          sendCard: async () => {
            throw new Error("transport exploded");
          }
        },
        () => {
          throw new Error("备份失败");
        }
      )
    ).rejects.toThrow("备份失败");

    expect(consecutiveFailureCount(db, SCHEDULED_JOB_DAILY_BACKUP)).toBe(
      SCHEDULED_JOB_ESCALATION_THRESHOLD + 1
    );
  });

  it("refuses an unknown job name instead of writing an unmonitored heartbeat", async () => {
    const db = makeDb();
    await expect(
      runScheduledJobWithHeartbeat(db, { job: "not-a-scheduled-job" }, () => 1)
    ).rejects.toThrow(/unknown scheduled job/u);
    expect(lastRunAt(db, "not-a-scheduled-job")).toBeNull();
  });
});

describe("escalation/recovery predicates", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");

  it("does not escalate below the threshold", () => {
    expect(isScheduledEscalationDue(now, SCHEDULED_JOB_ESCALATION_THRESHOLD - 1, null, null)).toBe(false);
  });

  it("escalates immediately for a NEW outage even inside the previous outage's throttle window", () => {
    const escalated = "2026-07-20T11:00:00.000Z";
    const recovered = "2026-07-20T11:30:00.000Z";
    expect(isScheduledEscalationDue(now, SCHEDULED_JOB_ESCALATION_THRESHOLD, escalated, recovered)).toBe(true);
  });

  it("never announces a recovery for a job that never escalated", () => {
    expect(isScheduledRecoveryDue(null, null)).toBe(false);
    expect(isScheduledRecoveryDue(null, "2026-07-20T11:00:00.000Z")).toBe(false);
  });

  it("builds a card that names the launchd label the operator has to go look at", () => {
    const card = buildScheduledFailureCard({
      displayName: "每日备份",
      label: "com.alphaloop.daily-backup",
      consecutiveFailures: 4,
      errorSummary: "ENOSPC"
    });
    expect(card.lines[0]).toBe("launchd 任务 com.alphaloop.daily-backup 已连续 4 次运行失败。");
    expect(card.lines[1]).toContain("ENOSPC");
  });
});
