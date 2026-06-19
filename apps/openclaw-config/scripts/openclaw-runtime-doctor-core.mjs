export function analyzeOpenClawRuntimeSnapshot(snapshot = {}) {
  const findings = [];
  const gatewayPids = distinctPids(snapshot.gatewayListeners);
  const runnerPids = distinctPids(snapshot.cronRunnerListeners);
  const gatewayErrorLines = Array.isArray(snapshot.gatewayErrorLines) ? snapshot.gatewayErrorLines : [];
  const recentRunnerResults = Array.isArray(snapshot.recentRunnerResults) ? snapshot.recentRunnerResults : [];
  const nowMs = Number(snapshot.nowMs ?? Date.now());
  const gatewayErrorWindowMs = Math.max(1, Number(snapshot.gatewayErrorWindowMs ?? 2 * 60_000));

  if (gatewayPids.length === 0) {
    findings.push(error("gateway.not_listening", "18789 没有 OpenClaw gateway 监听进程。"));
  } else if (gatewayPids.length > 1) {
    findings.push(error("gateway.duplicate_listener", `18789 出现多个 gateway 监听 PID：${gatewayPids.join("、")}。`));
  }

  const eaddrinuseLines = gatewayErrorLines
    .filter((line) => /EADDRINUSE|address already in use|Port 18789 is already in use/iu.test(line))
    .filter((line) => isRecentLogLine(line, nowMs, gatewayErrorWindowMs));
  if (eaddrinuseLines.length >= 2) {
    findings.push(error("gateway.restart_storm", `gateway 日志最近仍有 ${eaddrinuseLines.length} 条端口占用/重复启动记录。`));
  }

  if (runnerPids.length === 0) {
    findings.push(error("runner.not_listening", "18792 没有 openclaw-cron-runner 监听进程。"));
  } else if (runnerPids.length > 1) {
    findings.push(error("runner.duplicate_listener", `18792 出现多个 runner 监听 PID：${runnerPids.join("、")}。`));
  }

  for (const result of latestRunnerResultsByJob(recentRunnerResults).filter((entry) => entry && entry.ok === false).slice(0, 5)) {
    findings.push(error(
      "runner.recent_failure",
      `${result.job ?? "unknown"} 最近失败：${result.error || result.stderrTail || result.file || "未提供错误摘要"}`
    ));
  }

  if (findings.length === 0) {
    findings.push({
      severity: "info",
      code: "runtime.steady",
      message: "gateway 与 cron-runner 均为单实例监听，最近 runner 结果没有失败。"
    });
  }

  return {
    ok: !findings.some((finding) => finding.severity === "error"),
    findings
  };
}

function distinctPids(list) {
  return Array.from(new Set((Array.isArray(list) ? list : [])
    .map((entry) => Number(entry?.pid))
    .filter((pid) => Number.isFinite(pid) && pid > 0)));
}

function latestRunnerResultsByJob(results) {
  const byJob = new Map();
  for (const result of results) {
    const job = String(result?.job ?? result?.file ?? "unknown");
    if (!byJob.has(job)) {
      byJob.set(job, result);
    }
  }
  return Array.from(byJob.values());
}

function isRecentLogLine(line, nowMs, windowMs) {
  const timestamp = String(line ?? "").match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)/u)?.[1];
  if (!timestamp) {
    return true;
  }
  const parsed = Date.parse(timestamp);
  return !Number.isFinite(parsed) || nowMs - parsed <= windowMs;
}

function error(code, message) {
  return { severity: "error", code, message };
}
