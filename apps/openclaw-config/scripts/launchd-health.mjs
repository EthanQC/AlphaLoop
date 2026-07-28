#!/usr/bin/env node
// Round-6 (2026-07-29 deploy-path failure semantics), finding S3e.
//
// WHAT THIS EXISTS FOR
// --------------------
// `launchctl print system/<label>` exiting 0 proves REGISTRATION, not work.
// install-system-daemons.sh verified with exactly that.
//
// MEASURED 2026-07-29, both versions of that installer run against the same
// sandboxed root and the same launchctl stub, with three daemons injected to
// bootstrap successfully and then be dead on arrival (`state = not running`,
// `last exit code = 1` - which is what the mini's rsshub agent prints today):
//
//   the version at HEAD  -> exit 0, printed every label as `loaded`, and
//                           archived BOTH user-level fallbacks
//   this version         -> exit 1, printed the dead ones as `NOT RUNNING`,
//                           and left both fallbacks on disk
//
// The doctor had already learned the distinction (round-4 finding I5); the
// installer never had.
//
// So the residency contract and the judgement built on it live HERE, in one
// module both callers import:
//
//   openclaw-runtime-doctor-core.mjs  - turns a verdict into a finding
//   install-system-daemons.sh         - runs `node launchd-health.mjs verify
//                                       <label>` with the print output on
//                                       stdin, and only archives a service's
//                                       user-level fallback when it exits 0
//
// A second copy of the residency table in shell would have been a second thing
// to keep in sync; the one thing worse than a check the installer does not have
// is a check that disagrees with the doctor's.
//
// WHAT A PASSING VERDICT DOES AND DOES NOT PROVE
// ----------------------------------------------
// It proves the daemon survived the settle window and that launchd has not
// recorded an abnormal termination for it. It does NOT prove the service works -
// nothing launchd knows can prove that. The loopback probes in the doctor
// (platform-app /health, broker-executor /health, rsshub /healthz, the two
// listener counts) are what prove work, which is why runbook step 8 is still
// the gate and this is only the installer's stop condition.

import { readFileSync } from "node:fs";

// Round-4 finding I5, moved here in round 6 (see the header). Every label in
// install-launchd-ownership.txt gets an entry answering two questions the
// manifest itself cannot:
//
//   residency - what `launchctl print`'s `state` line is ALLOWED to say.
//               "resident" = KeepAlive=true in install-system-daemons.sh's
//               write_plist call (gateway / broker-executor / platform-app /
//               cron-runner): `state = running` is the only healthy answer,
//               anything else means the service is down or crash-throttled.
//               "periodic" = KeepAlive=false + a StartInterval/
//               StartCalendarInterval (market-alerts / daily-backup /
//               official-paper poll+pnl) or RunAtLoad-once
//               (com.alphaloop.rsshub, see its plist template): `state = not
//               running` BETWEEN runs is the normal steady state and must
//               never be reported as a fault - what matters for these is the
//               exit code of the last run.
//
//   probe     - the independent observation that proves the service is doing
//               its job, not just that launchd holds a record for it. Named
//               here (and printed in the no_health_contract finding) so a
//               label added to the manifest without a real probe fails
//               loudly instead of silently inheriting a check that proves
//               nothing.
//
// Measured, not assumed: `launchctl print` on the mini (2026-07-28/29,
// read-only) returns `state = running` + a `pid` for platform-app /
// cron-runner / gateway / broker-executor, and `state = not running` +
// `last exit code = 0` for market-alerts / daily-backup / official-paper
// poll+pnl - with `last exit code = 1` for com.alphaloop.rsshub, which is a
// genuine failure (its body is `docker start rsshub`) that the pre-I5 doctor
// reported as perfectly healthy.
//
// This table is a second list of labels, so it is not allowed to drift
// silently: checkLaunchdJobs emits `launchd-jobs.<slug>.no_health_contract`
// (error) for any required label missing from it, and the test suite asserts
// its key set equals the manifest's system+user rows exactly.
export const LAUNCHD_SERVICE_HEALTH = {
  "ai.openclaw.system.gateway": {
    residency: "resident",
    probe: "gateway-listeners（18789 上恰好一个监听进程）"
  },
  "com.openclaw.system.trading.broker-executor": {
    residency: "resident",
    probe: "broker-executor-health（127.0.0.1:4312/health 返回 200 且 service=broker-executor）"
  },
  "com.alphaloop.platform-app": {
    residency: "resident",
    probe: "platform-app-health（127.0.0.1:4314/health 返回 200 且 service=platform-app）"
  },
  "com.openclaw.trading.cron-runner": {
    residency: "resident",
    probe: "runner-listeners（18792 上恰好一个监听进程）"
  },
  "com.alphaloop.market-alerts": {
    residency: "periodic",
    probe: "alerts-poller-health（run_log 里 market-alerts 的心跳与连续失败数）"
  },
  "com.alphaloop.daily-backup": {
    residency: "periodic",
    probe: "daily-backup-health（runtime/backups 里最新 trading-<日期>.sqlite 的日期戳）"
  },
  "com.openclaw.trading.official-paper.poll": {
    residency: "periodic",
    probe: "official-paper-health（official_paper_snapshots 里 reason=hourly_poll 的最新一行）"
  },
  "com.openclaw.trading.official-paper.pnl": {
    residency: "periodic",
    probe: "official-paper-health（reason=post_open_pnl 的最新一行 + 对应的 reports/official-paper/<日期>-post-open.md）"
  },
  "com.alphaloop.rsshub": {
    residency: "periodic",
    probe: "rsshub-health（127.0.0.1:1200 容器探活）"
  }
};

// A resident daemon accumulates a `runs` only by dying and being relaunched.
//
// MEASURED (2026-07-29, this laptop, a throwaway label in the operator's own
// gui domain, booted out afterwards): `runs` is per LOAD, not per lifetime -
// a crash-looping job at runs = 3 went back to runs = 1 after
// `launchctl bootout` + `launchctl bootstrap`. install-system-daemons.sh boots
// every label out and back in on every run, so this counter cannot accumulate
// across deploys, and 20 means 19 deaths since the last install.
//
// A healthy install leaves runs = 2 (RunAtLoad spawns it once, then
// `kickstart -k` restarts it) - which is exactly what the mini reports today
// for platform-app and broker-executor, with 10 for gateway and cron-runner.
export const RESIDENT_CRASH_LOOP_RUNS = 20;

// Signals launchd ITSELF sends to stop a job: SIGTERM on bootout /
// `kickstart -k`, and SIGKILL when the job is still alive after its
// `exit timeout` seconds. install-system-daemons.sh sends both of those to
// every daemon on every run, so counting them as crashes would report every
// healthy install as a failure. Measured on the mini: com.alphaloop.platform-app
// prints `last terminating signal = Terminated: 15` right now, with
// `state = running` and runs = 2 - a normal service that was restarted.
//
// Every other signal is abnormal: nothing in this deploy path sends SIGSEGV /
// SIGBUS / SIGABRT / SIGILL to a daemon, so those only come from the process
// dying on its own.
const ORDERLY_STOP_SIGNALS = new Set([9, 15]);

/**
 * Parses the fields of `launchctl print <target>` this deploy path judges on.
 *
 * `launchctl print` indents the job dict's own keys with exactly ONE tab and
 * every nested dict's keys with two or more - verified against ~400 real jobs
 * on this laptop and against the AlphaLoop labels on the mini. Anchoring on
 * that single tab is what keeps `state` from picking up the `state = active`
 * lines inside the nested coalition/endpoint dicts, which a looser `^\s*state`
 * would also match.
 *
 * The loose fallback is opt-in per field, and only `state` opts in - that
 * preserves exactly the behaviour of the pre-I5 probe (whose only pattern was
 * the loose one, and which still returned the right answer because the
 * top-level line always comes first in the output). The new fields do NOT opt
 * in: a nested `pid` with no top-level one would otherwise be reported as the
 * job's pid, i.e. an observation nothing actually made.
 */
export function parseLaunchdPrint(text) {
  const source = String(text ?? "");
  return {
    state: readLaunchdPrintField(source, "state", { fallbackToLoose: true }) ?? "unknown",
    lastExitCode: toFiniteNumber(readLaunchdPrintField(source, "last exit code")),
    lastExitReason: readLaunchdPrintField(source, "last exit reason"),
    // Round-6 finding S3c. A job whose last termination was by SIGNAL prints NO
    // `last exit code` line at all - it prints this instead. Measured twice:
    // on the mini, com.alphaloop.platform-app reports
    // `last terminating signal = Terminated: 15` (and `launchctl list` shows
    // status -15); locally, SIGSEGV-ing a probe job produced
    // `last terminating signal = Segmentation fault: 11`. The doctor's crash
    // detection used to hang entirely off `last exit code`, so every
    // signal-killed daemon - the shape the mini prints right now - was invisible
    // to it.
    lastTerminatingSignal: readLaunchdPrintField(source, "last terminating signal"),
    pid: toFiniteNumber(readLaunchdPrintField(source, "pid")),
    runs: toFiniteNumber(readLaunchdPrintField(source, "runs")),
    stderrPath: readLaunchdPrintField(source, "stderr path")
  };
}

function readLaunchdPrintField(text, key, { fallbackToLoose = false } = {}) {
  const strict = text.match(new RegExp(`^\\t${key} = (.*)$`, "mu"));
  if (strict) {
    return strict[1].trim();
  }
  if (!fallbackToLoose) {
    return null;
  }
  return text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "mu"))?.[1] ?? null;
}

// `(never exited)` - launchd's own wording for "this job has never
// terminated" - is not a number and must stay `null` rather than becoming
// NaN or a fabricated 0.
export function toFiniteNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `Segmentation fault: 11` -> 11; `Terminated: 15` -> 15; anything else -> null. */
export function terminatingSignalNumber(value) {
  const match = String(value ?? "").match(/(-?\d+)\s*$/u);
  return match ? toFiniteNumber(match[1]) : null;
}

/**
 * Did this job's last termination look like a failure?
 *
 * Three independent signals, because launchd prints exactly one of them
 * depending on how the process died (all three shapes measured - see
 * parseLaunchdPrint and ORDERLY_STOP_SIGNALS above):
 *   a non-zero `last exit code`      - exited by itself with a failure status
 *   any `last exit reason`           - launchd killed it for a reason of its
 *                                      own (JETSAM_..., etc.)
 *   a `last terminating signal` that - died on a signal nothing in this deploy
 *   is not an orderly stop             path sends
 */
export function classifyTermination(detail) {
  const exitCode = toFiniteNumber(detail?.lastExitCode);
  if (exitCode !== null && exitCode !== 0) {
    return { abnormal: true, why: `last exit code = ${exitCode}` };
  }
  if (detail?.lastExitReason) {
    return { abnormal: true, why: `last exit reason = ${detail.lastExitReason}` };
  }
  const signal = terminatingSignalNumber(detail?.lastTerminatingSignal);
  if (signal !== null && !ORDERLY_STOP_SIGNALS.has(signal)) {
    return { abnormal: true, why: `last terminating signal = ${detail.lastTerminatingSignal}` };
  }
  return { abnormal: false, why: "" };
}

/**
 * Renders whatever launchd actually told us about the last termination.
 * Nothing here is defaulted: a job with no `last exit code` line says so
 * instead of being reported as a clean exit.
 */
export function describeLaunchdExit(row) {
  const parts = [];
  const exitCode = toFiniteNumber(row?.lastExitCode);
  if (exitCode !== null) {
    parts.push(`last exit code = ${exitCode}`);
  }
  if (row?.lastExitReason) {
    parts.push(`last exit reason = ${row.lastExitReason}`);
  }
  if (row?.lastTerminatingSignal) {
    parts.push(`last terminating signal = ${row.lastTerminatingSignal}`);
  }
  if (exitCode === null && !row?.lastExitReason && !row?.lastTerminatingSignal) {
    parts.push("launchctl 未给出退出码");
  }
  const runs = toFiniteNumber(row?.runs);
  if (runs !== null) {
    parts.push(`runs = ${runs}`);
  }
  const pid = toFiniteNumber(row?.pid);
  if (pid !== null) {
    parts.push(`pid = ${pid}`);
  }
  return parts.length > 0 ? `，${parts.join("，")}` : "";
}

/**
 * The one judgement, shared by the installer and the doctor.
 *
 * @returns {{status: string, evidence: string, runs: number|null, probe: string|null}}
 *   status is one of:
 *     ok                        - launchd's own record shows nothing wrong
 *     not_loaded                - no record in this domain at all
 *     no_health_contract        - the label is in the manifest but not in
 *                                 LAUNCHD_SERVICE_HEALTH, so nothing here can
 *                                 judge it (never silently "fine")
 *     state_unknown             - launchctl answered but printed no state line
 *     not_running               - resident daemon that is not running
 *     crash_looping             - resident daemon relaunched >= 20 times since
 *                                 it was loaded
 *     restarted_after_failure   - resident daemon running now, last termination
 *                                 was abnormal
 *     last_run_failed           - periodic job whose last run terminated
 *                                 abnormally
 */
export function judgeLaunchdRuntime(label, detail, contract = LAUNCHD_SERVICE_HEALTH[label]) {
  const probe = contract?.probe ?? null;
  if (!contract) {
    return { status: "no_health_contract", evidence: "", runs: null, probe };
  }
  if (detail === null || detail === undefined) {
    return { status: "not_loaded", evidence: "", runs: null, probe };
  }

  const evidence = describeLaunchdExit(detail);
  const runs = toFiniteNumber(detail.runs);
  const state = String(detail.state ?? "unknown");
  const termination = classifyTermination(detail);

  if (state === "unknown") {
    return { status: "state_unknown", evidence, runs, probe };
  }

  if (contract.residency === "resident") {
    if (state !== "running") {
      return { status: "not_running", evidence, runs, probe, state };
    }
    // Ordered before the termination test on purpose: `runs` counts deaths
    // since this label was loaded (measured - see RESIDENT_CRASH_LOOP_RUNS),
    // so a service being relaunched 20 times is a crash loop whatever launchd
    // says about the LAST death - including the signal deaths that print no
    // exit code at all, which is the shape that used to make this branch
    // unreachable.
    if (runs !== null && runs >= RESIDENT_CRASH_LOOP_RUNS) {
      return { status: "crash_looping", evidence, runs, probe, state };
    }
    if (termination.abnormal) {
      return { status: "restarted_after_failure", evidence, runs, probe, state };
    }
    return { status: "ok", evidence, runs, probe, state };
  }

  if (termination.abnormal) {
    return { status: "last_run_failed", evidence, runs, probe, state };
  }
  return { status: "ok", evidence, runs, probe, state };
}

/**
 * The installer's stop condition: may this service's user-level fallback be
 * archived, and may the label be reported as installed?
 *
 * Only a clean verdict counts. In particular `restarted_after_failure` does
 * NOT: right after a fresh bootstrap `runs` has been reset, so an abnormal
 * termination at that moment means the daemon died inside the settle window -
 * dead on arrival, not "it crashed once last month".
 */
export function isHandoverHealthy(verdict) {
  return verdict?.status === "ok";
}

/** One English line for the installer's failure report. */
export function describeVerdictForInstaller(label, verdict) {
  const evidence = String(verdict?.evidence ?? "").replace(/^，/u, "").replace(/，/gu, ", ");
  const tail = evidence ? ` (${evidence})` : "";
  switch (verdict?.status) {
    case "ok":
      return `${label}: running`;
    case "not_loaded":
      return `${label}: launchctl print found no such job in the system domain`;
    case "no_health_contract":
      return `${label}: no residency contract in launchd-health.mjs, so nothing can verify it`;
    case "state_unknown":
      return `${label}: launchctl printed no state line, so this run could not verify it${tail}`;
    case "not_running":
      return `${label}: bootstrapped but NOT RUNNING - it is a KeepAlive service, so this is dead on arrival${tail}`;
    case "crash_looping":
      return `${label}: crash-looping - relaunched ${verdict.runs} times since it was loaded${tail}`;
    case "restarted_after_failure":
      return `${label}: died inside the settle window and was relaunched${tail}`;
    case "last_run_failed":
      return `${label}: its first run under launchd failed${tail}`;
    default:
      return `${label}: unrecognised verdict ${JSON.stringify(verdict?.status)}`;
  }
}

// ---------------------------------------------------------------------------
// CLI seam for install-system-daemons.sh:
//
//   "${LAUNCHCTL}" print "system/<label>" | node launchd-health.mjs verify <label>
//
// exit 0  - healthy, the installer may archive this service's user plists
// exit 1  - not healthy; the reason is on stdout, verbatim, for the report
// exit 2  - this script was called wrong (never confused with "unhealthy")
//
// Reading the print output from stdin rather than shelling out to launchctl
// here keeps the installer's LAUNCHCTL test seam authoritative: the sandbox
// suite's stub launchctl is what answers, exactly as it does for every other
// call the installer makes.
// ---------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const [, , command, label] = process.argv;
  if (command !== "verify" || !label) {
    console.error("usage: launchctl print system/<label> | node launchd-health.mjs verify <label>");
    process.exit(2);
  }
  let printed = "";
  try {
    printed = readFileSync(0, "utf8");
  } catch {
    printed = "";
  }
  // An empty stdin means `launchctl print` produced nothing, which is what a
  // non-zero print exit looks like from here: no job.
  const verdict = printed.trim().length === 0
    ? judgeLaunchdRuntime(label, null)
    : judgeLaunchdRuntime(label, parseLaunchdPrint(printed));
  console.log(describeVerdictForInstaller(label, verdict));
  process.exit(isHandoverHealthy(verdict) ? 0 : 1);
}
