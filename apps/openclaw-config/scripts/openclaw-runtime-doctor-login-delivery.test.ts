import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const doctor = await import("./openclaw-runtime-doctor-core.mjs");
const { MemberRepository, openTradingDatabase } = await import("../../../packages/shared-types/dist/index.js");
// The REAL producers (same dist-import precedent as this suite's
// createBrokerExecutorServer usage in openclaw-runtime-doctor-core.test.ts):
// every row the doctor reads below was written by the real platform-app login
// route over real loopback HTTP, never by hand - a hand-inserted
// login_send_log/login_delivery_log row could drift from what
// handleRequestCode actually writes (hash format, scope, timing) and the check
// would be vouching for an input no producer emits.
const { createPlatformServer } = await import("../../platform-app/dist/server.js");
const { __resetLoginOperatorAlertThrottleForTests } = await import("../../platform-app/dist/routes/login.js");

/**
 * "login-delivery-health" (2026-07-30, J4 follow-up): members whose codes never
 * arrive see a normal 「已发送」 page by design, and the Feishu operator alert
 * rides the channel whose failure it reports - so the doctor must be able to
 * answer 「验证码到底送到了吗」 from the trading db alone. These cases drive the
 * REAL handleRequestCode (via createPlatformServer over loopback HTTP) with a
 * failing/succeeding/hanging notifier against a REAL file-backed trading db,
 * then run the real doctor over what that left behind.
 *
 * Separate file rather than more cases in openclaw-runtime-doctor-core.test.ts,
 * per that suite's own precedent (openclaw-runtime-doctor-uncovered.test.ts):
 * these cases need the platform-app dist server and their own harness.
 */

const T0 = Date.parse("2026-07-30T10:00:00.000Z");
const MEMBER_EMAIL = "member_1@example.com";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

function makeTradingDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "alphaloop-doctor-login-"));
  tempDirs.push(dir);
  return join(dir, "trading.sqlite");
}

function seedActiveMember(dbPath: string, overrides: Record<string, unknown> = {}): void {
  const db = openTradingDatabase(dbPath);
  new MemberRepository(db).upsert({
    id: "member_1",
    email: MEMBER_EMAIL,
    feishuOpenId: "ou_member_1",
    displayName: "圈内成员",
    riskTags: [],
    stockTags: [],
    showPerformance: true,
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  });
  db.close();
}

type SenderResult = { ok: boolean; reason?: string };

/**
 * One real POST /login against a real loopback platform-app wired to the real
 * file-backed trading db. `sender` stands where the Feishu transport would;
 * everything between the form post and the two ledgers is production code.
 */
async function driveLoginRequest(
  dbPath: string,
  email: string,
  options: {
    sender?: (args: { openId: string; code: string; ttlMinutes: number }) => Promise<SenderResult>;
    /** When set, called between the HTTP response and the sender resolving -
     * the window where the reservation exists but no outcome does. */
    beforeSenderResolves?: (db: ReturnType<typeof openTradingDatabase>) => void;
    /** When set, awaited in that same window - for observing the LIVE
     * in-flight state (reservation committed, send not yet settled) from
     * outside, e.g. by running the doctor over the file mid-send. */
    duringFlight?: () => Promise<void>;
    /** The server's injected wall clock; defaults to T0. */
    clockMs?: number;
  } = {}
): Promise<void> {
  const db = openTradingDatabase(dbPath);
  const pending: Array<Promise<void>> = [];
  let releaseSender: () => void = () => {};
  const gate = options.beforeSenderResolves || options.duringFlight
    ? new Promise<void>((resolve) => {
        releaseSender = resolve;
      })
    : null;
  const sender = options.sender ?? (async () => ({ ok: true }));

  const server = createPlatformServer({
    db,
    repoRoot: process.cwd(),
    now: () => new Date(options.clockMs ?? T0),
    loginCodeSender: async (args) => {
      if (gate) {
        await gate;
      }
      return sender(args);
    },
    onLoginSendSettled: (settled) => pending.push(settled),
    loginOperationalAlert: async () => ({ sent: true, target: "none", deliveries: [] })
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email }).toString(),
      redirect: "manual"
    });
    expect(response.status).toBe(200);
    if (options.duringFlight) {
      await options.duringFlight();
    }
    if (options.beforeSenderResolves) {
      options.beforeSenderResolves(db);
    }
    releaseSender();
    await Promise.all(pending);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      db.close();
    } catch {
      // The beforeSenderResolves hook may have closed it already.
    }
  }
}

function snapshotWith(dbPath: string, nowMs: number) {
  return {
    gatewayListeners: [{ pid: 100, command: "node", endpoint: "127.0.0.1:18789" }],
    cronRunnerListeners: [{ pid: 200, command: "node", endpoint: "127.0.0.1:18792" }],
    nowMs,
    dbPath
  };
}

type Finding = { code: string; severity: string; message: string };

function findingFor(report: { findings: Finding[] }, code: string): Finding {
  const found = report.findings.find((entry) => entry.code === code);
  if (!found) {
    throw new Error(`no ${code} finding; got: ${report.findings.map((entry) => entry.code).join(", ")}`);
  }
  return found;
}

describe("doctor: login-delivery-health over what the real login route left behind", () => {
  it("reports delivery_failing when a member's code delivery failed and never recovered", async () => {
    __resetLoginOperatorAlertThrottleForTests();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dbPath = makeTradingDbPath();
    seedActiveMember(dbPath);

    await driveLoginRequest(dbPath, MEMBER_EMAIL, {
      sender: async () => ({ ok: false, reason: "飞书网络超时" })
    });

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotWith(dbPath, T0 + 10 * 60_000));

    const finding = findingFor(report, "login-delivery-health.delivery_failing");
    expect(finding.severity).toBe("error");
    expect(finding.message).toContain("member_1");
    expect(finding.message).toContain("飞书网络超时");
    expect(finding.message).toContain("LOGIN-DELIVERY-FAILED");
    // The member's email must not surface in an operator-facing report.
    expect(finding.message).not.toContain(MEMBER_EMAIL);
    expect(report.ok).toBe(false);
  });

  it("reports delivery_failing for the active-member-without-feishu_open_id case", async () => {
    __resetLoginOperatorAlertThrottleForTests();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dbPath = makeTradingDbPath();
    seedActiveMember(dbPath, { feishuOpenId: undefined });

    await driveLoginRequest(dbPath, MEMBER_EMAIL);

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotWith(dbPath, T0 + 10 * 60_000));

    const finding = findingFor(report, "login-delivery-health.delivery_failing");
    expect(finding.severity).toBe("error");
    expect(finding.message).toContain("no_feishu_open_id");
  });

  it("stays quiet when the delivery succeeded", async () => {
    __resetLoginOperatorAlertThrottleForTests();
    const dbPath = makeTradingDbPath();
    seedActiveMember(dbPath);

    await driveLoginRequest(dbPath, MEMBER_EMAIL, { sender: async () => ({ ok: true }) });

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotWith(dbPath, T0 + 10 * 60_000));

    expect(report.findings.some((entry) => entry.code.startsWith("login-delivery-health."))).toBe(false);
  });

  it("downgrades to recent_failures once a later attempt to the same member succeeded", async () => {
    __resetLoginOperatorAlertThrottleForTests();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dbPath = makeTradingDbPath();
    seedActiveMember(dbPath);

    await driveLoginRequest(dbPath, MEMBER_EMAIL, {
      sender: async () => ({ ok: false, reason: "飞书网络超时" })
    });
    // The real route enforces a 60s per-email cooldown against the injected
    // clock - a second request inside it would reserve nothing. Real recovery
    // happens on the member's retry a minute later, so the retry is driven
    // through the same real producer with its clock one cooldown later.
    await driveLoginRequest(dbPath, MEMBER_EMAIL, {
      sender: async () => ({ ok: true }),
      clockMs: T0 + 61_000
    });

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotWith(dbPath, T0 + 10 * 60_000));

    const finding = findingFor(report, "login-delivery-health.recent_failures");
    expect(finding.severity).toBe("warn");
    expect(report.findings.some((entry) => entry.code === "login-delivery-health.delivery_failing")).toBe(false);
  });

  it("ignores reservations from addresses that match no member - stranger probes cannot trip it", async () => {
    __resetLoginOperatorAlertThrottleForTests();
    const dbPath = makeTradingDbPath();
    seedActiveMember(dbPath);

    // The real route reserves a slot for ANY plausible address (that is the
    // anti-enumeration design) and then delivers nothing for a non-member.
    await driveLoginRequest(dbPath, "nobody@example.com");

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotWith(dbPath, T0 + 10 * 60_000));

    expect(report.findings.some((entry) => entry.code.startsWith("login-delivery-health."))).toBe(false);
  });

  it("reports missing_outcomes when the job died between reserving the slot and recording anything", async () => {
    __resetLoginOperatorAlertThrottleForTests();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const dbPath = makeTradingDbPath();
    seedActiveMember(dbPath);

    // The realistic shape of "the process died mid-job": the reservation and
    // the issued code are already committed (they happen synchronously before
    // the response), the Feishu call is in flight, and then the db becomes
    // unavailable - so deliverCode's own failure handling CANNOT write its
    // outcome row. Closing the handle underneath the pending send reproduces
    // that window without reaching into either table by hand.
    await driveLoginRequest(dbPath, MEMBER_EMAIL, {
      sender: async () => ({ ok: false, reason: "飞书网络超时" }),
      beforeSenderResolves: (db) => db.close()
    });
    // The route logged the failure AND the failed outcome write.
    expect(errorSpy.mock.calls.flat().map(String).join("\n")).toContain("failed to record a delivery outcome");

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotWith(dbPath, T0 + 10 * 60_000));

    const finding = findingFor(report, "login-delivery-health.missing_outcomes");
    expect(finding.severity).toBe("error");
    expect(finding.message).toContain("member_1");
    expect(report.ok).toBe(false);
  });

  it("gives an in-flight send its grace period instead of calling it missing", async () => {
    __resetLoginOperatorAlertThrottleForTests();
    const dbPath = makeTradingDbPath();
    seedActiveMember(dbPath);

    // The doctor runs MID-SEND: the reservation is committed, the Feishu call
    // has not settled, so no outcome row exists yet - the exact state every
    // healthy request passes through for a few seconds. A 30s-old reservation
    // with no outcome must be "still in flight", not "missing".
    await driveLoginRequest(dbPath, MEMBER_EMAIL, {
      sender: async () => ({ ok: true }),
      duringFlight: async () => {
        const report = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotWith(dbPath, T0 + 30_000));
        expect(report.findings.some((entry) => entry.code.startsWith("login-delivery-health."))).toBe(false);
      }
    });

    // And once the send settles, the recorded success keeps it quiet for good.
    const after = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotWith(dbPath, T0 + 10 * 60_000));
    expect(after.findings.some((entry) => entry.code.startsWith("login-delivery-health."))).toBe(false);
  });

  it("warns table_missing on a pre-v19 db where members are requesting codes", async () => {
    __resetLoginOperatorAlertThrottleForTests();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dbPath = makeTradingDbPath();
    seedActiveMember(dbPath);

    // Real reservation first (the failing sender also writes an outcome row) -
    // then reproduce the deployed v18 shape, where login_delivery_log has
    // never existed: the live mini is at schema 18 until this change deploys,
    // and its real producer (the pre-v19 login route) writes login_send_log
    // rows and nothing else. Dropping the table is the closest this test can
    // get to that machine without running the retired v18 build.
    await driveLoginRequest(dbPath, MEMBER_EMAIL, {
      sender: async () => ({ ok: false, reason: "飞书网络超时" })
    });
    const db = openTradingDatabase(dbPath);
    db.exec("DROP TABLE login_delivery_log; PRAGMA user_version = 18;");
    db.close();

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotWith(dbPath, T0 + 10 * 60_000));

    const finding = findingFor(report, "login-delivery-health.table_missing");
    expect(finding.severity).toBe("warn");
    expect(finding.message).toContain("login_delivery_log");
    expect(finding.message).toContain("v19");
  });

  it("says nothing at all on a machine with members but no login traffic", async () => {
    const dbPath = makeTradingDbPath();
    seedActiveMember(dbPath);

    const report = await doctor.analyzeOpenClawRuntimeSnapshot(snapshotWith(dbPath, T0));

    expect(report.findings.some((entry) => entry.code.startsWith("login-delivery-health."))).toBe(false);
  });
});
