// Round 6 (2026-07-29): the judgement install-system-daemons.sh and the doctor
// now share.
//
// FIXTURE PROVENANCE, because this module's entire job is reading one specific
// program's output:
//
//   · "against this machine's real launchctl" below runs `launchctl print`
//     against a label that is actually loaded here and asserts on what comes
//     back. No fixture at all - if launchctl's format changes, this fails.
//   · the two multi-line strings further down are VERBATIM captures, read-only,
//     of `launchctl print` on the deploy target (2026-07-28/29) and of a
//     throwaway probe label on this laptop. They are quoted rather than
//     paraphrased precisely because the defect being fixed was a parser that
//     assumed a field launchd does not always print.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

import {
  classifyTermination,
  describeVerdictForInstaller,
  isHandoverHealthy,
  judgeLaunchdRuntime,
  LAUNCHD_SERVICE_HEALTH,
  parseLaunchdPrint
} from "./launchd-health.mjs";

const healthScript = fileURLToPath(new URL("./launchd-health.mjs", import.meta.url));

/**
 * `launchctl print` for com.alphaloop.platform-app in the mini's gui domain,
 * captured read-only on 2026-07-29 (fields the judgement reads; the omitted
 * lines are the program/environment/coalition blocks). This is the shape the
 * whole S3c finding is about: a job killed by a signal prints NO `last exit
 * code` line at all. `launchctl list` reported status -15 for the same job at
 * the same moment.
 */
const MINI_PLATFORM_APP_PRINT = [
  "gui/501/com.alphaloop.platform-app = {",
  "\tactive count = 1",
  "\tpath = /Users/qingchang/Library/LaunchAgents/com.alphaloop.platform-app.plist",
  "\ttype = LaunchAgent",
  "\tstate = running",
  "\tstdout path = /Users/qingchang/AlphaLoop/logs/platform-app.log",
  "\tstderr path = /Users/qingchang/AlphaLoop/logs/platform-app.err.log",
  "\tenvironment = {",
  "\t\tOSLogRateLimit => 64",
  "\t}",
  "\tdomain = gui/501 [100015]",
  "\truns = 2",
  "\tpid = 31035",
  "\tlast terminating signal = Terminated: 15",
  "\tresource coalition = {",
  "\t\tstate = active",
  "\t}",
  "}"
].join("\n");

/**
 * A crash-looping job, reproduced on this laptop on 2026-07-29 with a
 * throwaway label in the operator's own gui domain (a KeepAlive job whose
 * program exits 1 immediately), booted out again afterwards. Note `state`:
 * launchd reports a throttled relaunch as `spawn scheduled`, not `running`.
 */
const LOCAL_CRASH_LOOP_PRINT = [
  "gui/501/com.alphaloop.deploygate-probe = {",
  "\tstate = spawn scheduled",
  "\truns = 3",
  "\tlast exit code = 1",
  "\tstderr path = /tmp/probe/err.log",
  "}"
].join("\n");

describe("parseLaunchdPrint against this machine's real launchctl", () => {
  function someLoadedUserLabel(): string | null {
    const uid = process.getuid?.();
    if (uid === undefined) {
      return null;
    }
    const listed = execFileSync("launchctl", ["list"], { encoding: "utf8" })
      .split(/\r?\n/u)
      .slice(1)
      .map((line) => line.trim().split(/\s+/u).at(-1))
      .filter((label): label is string => Boolean(label) && label !== "Label");
    return listed.at(0) ?? null;
  }

  it("reads the top-level state of a job that is really loaded here", () => {
    const label = someLoadedUserLabel();
    if (!label) {
      // Never silently pass: say which environment could not be probed.
      throw new Error("no user-domain launchd job is loaded on this machine, so this test cannot run");
    }
    const uid = process.getuid?.();
    const output = execFileSync("launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf8" });
    const detail = parseLaunchdPrint(output);

    // Real launchctl output always carries a top-level state line, and the
    // parser must take THAT one rather than a nested `state = active` from the
    // coalition dicts every job has.
    expect(detail.state).not.toBe("unknown");
    expect(["running", "not running", "spawn scheduled", "waiting"]).toContain(detail.state);
    expect(detail.state).not.toBe("active");
  });

  it("returns null for the fields launchctl did not print, rather than inventing them", () => {
    const detail = parseLaunchdPrint("gui/501/x = {\n\tstate = running\n}");
    expect(detail.lastExitCode).toBeNull();
    expect(detail.lastExitReason).toBeNull();
    expect(detail.lastTerminatingSignal).toBeNull();
    expect(detail.runs).toBeNull();
  });
});

describe("judging the shapes the deploy target actually prints", () => {
  it("reads the mini's signal-killed platform-app without inventing an exit code", () => {
    const detail = parseLaunchdPrint(MINI_PLATFORM_APP_PRINT);
    expect(detail.state).toBe("running");
    expect(detail.lastExitCode).toBeNull();
    expect(detail.lastTerminatingSignal).toBe("Terminated: 15");
    expect(detail.runs).toBe(2);
    expect(detail.pid).toBe(31035);

    // SIGTERM is what launchd sends on bootout and `kickstart -k`, both of
    // which this deploy path does to every daemon on every run.
    expect(classifyTermination(detail).abnormal).toBe(false);
    expect(judgeLaunchdRuntime("com.alphaloop.platform-app", detail).status).toBe("ok");
  });

  it("calls a throttled crash loop what it is", () => {
    const detail = parseLaunchdPrint(LOCAL_CRASH_LOOP_PRINT);
    expect(detail.state).toBe("spawn scheduled");
    const verdict = judgeLaunchdRuntime("com.alphaloop.platform-app", detail);
    expect(verdict.status).toBe("not_running");
    expect(isHandoverHealthy(verdict)).toBe(false);
    expect(describeVerdictForInstaller("com.alphaloop.platform-app", verdict))
      .toMatch(/bootstrapped but NOT RUNNING/u);
  });

  it("treats a signal death that is not an orderly stop as abnormal", () => {
    expect(classifyTermination({ lastTerminatingSignal: "Segmentation fault: 11" }).abnormal).toBe(true);
    expect(classifyTermination({ lastTerminatingSignal: "Killed: 9" }).abnormal).toBe(false);
    expect(classifyTermination({ lastExitReason: "JETSAM_REASON_MEMORY_HIGHWATER" }).abnormal).toBe(true);
    expect(classifyTermination({ lastExitCode: 0 }).abnormal).toBe(false);
    expect(classifyTermination({ lastExitCode: 1 }).abnormal).toBe(true);
  });

  it("judges a resident daemon relaunched 20+ times as a crash loop whatever killed it", () => {
    const verdict = judgeLaunchdRuntime("com.alphaloop.platform-app", {
      state: "running",
      runs: 918,
      lastExitCode: null,
      lastTerminatingSignal: null
    });
    expect(verdict.status).toBe("crash_looping");
  });

  it("keeps a periodic job's idle state healthy, and its failed run unhealthy", () => {
    const idle = judgeLaunchdRuntime("com.alphaloop.market-alerts", {
      state: "not running",
      lastExitCode: 0,
      runs: 2945
    });
    expect(idle.status).toBe("ok");

    const failed = judgeLaunchdRuntime("com.alphaloop.market-alerts", {
      state: "not running",
      lastExitCode: 1,
      runs: 1
    });
    expect(failed.status).toBe("last_run_failed");
    expect(isHandoverHealthy(failed)).toBe(false);
  });

  it("refuses to vouch for a label with no residency contract", () => {
    const verdict = judgeLaunchdRuntime("com.example.not-ours", { state: "running" });
    expect(verdict.status).toBe("no_health_contract");
    expect(isHandoverHealthy(verdict)).toBe(false);
  });
});

describe("the CLI seam install-system-daemons.sh actually runs", () => {
  function verify(label: string, printed: string): { status: number; output: string } {
    try {
      const stdout = execFileSync(process.execPath, [healthScript, "verify", label], {
        input: printed,
        encoding: "utf8"
      });
      return { status: 0, output: stdout };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { status: failure.status ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
    }
  }

  it("exits 0 only for a daemon that is really up", () => {
    const healthy = verify(
      "com.alphaloop.platform-app",
      "system/com.alphaloop.platform-app = {\n\tstate = running\n\truns = 2\n\tpid = 91\n}"
    );
    expect(healthy.status).toBe(0);
    expect(healthy.output).toMatch(/running/u);
  });

  it("exits 1, with the reason, for a daemon that bootstrapped and died", () => {
    const dead = verify(
      "com.alphaloop.platform-app",
      "system/com.alphaloop.platform-app = {\n\tstate = not running\n\truns = 1\n\tlast exit code = 1\n}"
    );
    expect(dead.status).toBe(1);
    expect(dead.output).toMatch(/bootstrapped but NOT RUNNING/u);
    expect(dead.output).toMatch(/last exit code = 1/u);
  });

  it("treats empty stdin - what a failed `launchctl print` pipes in - as not loaded", () => {
    const missing = verify("com.alphaloop.platform-app", "");
    expect(missing.status).toBe(1);
    expect(missing.output).toMatch(/found no such job/u);
  });

  it("exits 2 when called wrong, so 'unhealthy' and 'misused' are never confused", () => {
    const misused = verify("", "");
    expect(misused.status).toBe(2);
  });

  it("covers every label the ownership manifest scopes to launchd", async () => {
    // The drift guard for the table itself: a label added to the manifest with
    // no residency contract would make this module answer no_health_contract
    // for it, which the installer treats as "cannot verify" and the doctor
    // reports as an error - loud, but only at deploy time. This fails first.
    const doctorCore = await import("./openclaw-runtime-doctor-core.mjs");
    const required = doctorCore.REQUIRED_LAUNCHD_JOBS.map((job: { label: string }) => job.label).sort();
    expect(Object.keys(LAUNCHD_SERVICE_HEALTH).sort()).toEqual(required);
  });
});
