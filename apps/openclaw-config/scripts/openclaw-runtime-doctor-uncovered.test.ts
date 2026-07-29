import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const doctor = await import("./openclaw-runtime-doctor-core.mjs");

/**
 * Doctor findings that could fire on the deploy machine and that no test in the
 * tree named, found by test/claim-guard.test.ts once its own list stopped
 * vouching for itself (2026-07-29). Each `it` below removes one entry from
 * FINDING_CODES_WITHOUT_TESTS; what is left there is listed with its reason.
 *
 * A separate file rather than more cases in openclaw-runtime-doctor-core.test.ts
 * on purpose: that file and the doctor itself are being edited by another agent
 * this round, and these cases are about branches nobody is touching.
 *
 * The snapshot handed to `analyzeOpenClawRuntimeSnapshot` here is deliberately
 * NOT an otherwise-healthy machine - every other check is free to complain. The
 * claim under test is "this specific finding fires with this specific code and
 * severity", so the assertions are on the finding, never on `report.ok`.
 */

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

type Finding = { code: string; severity: string; message: string };

function findingFor(report: { findings: Finding[] }, code: string): Finding {
  const found = report.findings.find((entry) => entry.code === code);
  if (!found) {
    throw new Error(`no ${code} finding; got: ${report.findings.map((entry) => entry.code).join(", ")}`);
  }
  return found;
}

describe("doctor: two processes on one port", () => {
  // The deploy path really can produce this: install-launchd.sh ends in
  // `openclaw gateway install`, which re-creates the user-level
  // ai.openclaw.gateway agent next to the system daemon - a known, documented
  // limitation in install-launchd-ownership.txt. The doctor is what notices.
  it("reports gateway.duplicate_listener when 18789 has more than one listening pid", async () => {
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      gatewayListeners: [
        { pid: 100, command: "node", endpoint: "127.0.0.1:18789" },
        { pid: 101, command: "node", endpoint: "[::1]:18789" }
      ],
      cronRunnerListeners: [{ pid: 200, command: "node", endpoint: "127.0.0.1:18792" }]
    });

    const finding = findingFor(report, "gateway.duplicate_listener");
    expect(finding.severity).toBe("error");
    expect(finding.message).toContain("100");
    expect(finding.message).toContain("101");
    expect(report.ok).toBe(false);
  });

  it("counts pids, not rows - one process bound to both loopback families is not a duplicate", async () => {
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      gatewayListeners: [
        { pid: 100, command: "node", endpoint: "127.0.0.1:18789" },
        { pid: 100, command: "node", endpoint: "[::1]:18789" }
      ],
      cronRunnerListeners: [{ pid: 200, command: "node", endpoint: "127.0.0.1:18792" }]
    });

    expect(report.findings.some((entry) => entry.code === "gateway.duplicate_listener")).toBe(false);
  });

  it("reports runner.duplicate_listener when 18792 has more than one listening pid", async () => {
    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      gatewayListeners: [{ pid: 100, command: "node", endpoint: "127.0.0.1:18789" }],
      cronRunnerListeners: [
        { pid: 200, command: "node", endpoint: "127.0.0.1:18792" },
        { pid: 201, command: "node", endpoint: "127.0.0.1:18792" }
      ]
    });

    const finding = findingFor(report, "runner.duplicate_listener");
    expect(finding.severity).toBe("error");
    expect(finding.message).toContain("200");
    expect(finding.message).toContain("201");
  });
});

describe("doctor: the persona file exists but cannot be read", () => {
  // The missing and empty branches are covered next door. This is the third:
  // the path resolves to something readFileSync refuses. A directory named
  // AGENTS.md is the reproducible version (EISDIR on macOS and Linux both) of
  // what a root-owned mode-600 file left by a sudo run does on the mini.
  it("reports control-persona.unreadable rather than treating an unreadable persona as present", async () => {
    const dir = makeTempDir("alphaloop-doctor-persona-unreadable-");
    const personaPath = join(dir, "AGENTS.md");
    mkdirSync(personaPath);

    const report = await doctor.analyzeOpenClawRuntimeSnapshot({
      gatewayListeners: [{ pid: 100, command: "node", endpoint: "127.0.0.1:18789" }],
      cronRunnerListeners: [{ pid: 200, command: "node", endpoint: "127.0.0.1:18792" }],
      controlWorkspaceAgentsPath: personaPath
    });

    const finding = findingFor(report, "control-persona.unreadable");
    expect(finding.severity).toBe("error");
    expect(finding.message).toContain(personaPath);
    // Not the missing/empty branches - an unreadable file is a different fact
    // from an absent one, and the remedy differs (permissions, not re-render).
    expect(report.findings.some((entry) => entry.code === "control-persona.missing")).toBe(false);
    expect(report.findings.some((entry) => entry.code === "control-persona.empty")).toBe(false);
  });
});
