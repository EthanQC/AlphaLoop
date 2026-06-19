export function buildCronFailureAlertMarkdown(result, attempt = {}) {
  const job = clean(result?.job ?? "unknown");
  const title = "# OpenClaw 自动报告失败告警";
  const marker = [
    clean(result?.openclawJobName ?? "unknown-job"),
    clean(result?.openclawRunId ?? result?.openclawRunAtMs ?? "unknown-run")
  ].join(" / ");
  const retry = attempt?.nextRetryAt
    ? `- 下一次自动重试：${clean(attempt.nextRetryAt)}（第 ${Number(attempt.attempts ?? 1)} 次失败后）。`
    : "- 下一次自动重试：等待 runner backoff 状态。";

  return [
    title,
    "",
    "## 摘要",
    "",
    `- 任务：${job}`,
    `- 触发：${clean(result?.trigger ?? "unknown")}`,
    `- OpenClaw marker：${marker}`,
    `- 命令：${clean(result?.command ?? "unknown")}`,
    `- 退出：code=${clean(result?.code ?? "null")}，signal=${clean(result?.signal ?? "null")}`,
    retry,
    "- 状态：本次产出未标记 processed；runner 会自动重试，不会静默断档。",
    "",
    "## 证据",
    "",
    `- 开始：${clean(result?.startedAt ?? "unknown")}`,
    `- 结束：${clean(result?.finishedAt ?? "unknown")}`,
    result?.error ? `- 错误：${sanitizeAlertText(result.error, 1000)}` : "- 错误：子进程返回非零退出码。",
    "",
    "### stdout 尾部",
    "",
    fenced(sanitizeAlertText(result?.stdoutTail ?? "无 stdout 尾部。", 2000)),
    "",
    "### stderr 尾部",
    "",
    fenced(sanitizeAlertText(result?.stderrTail ?? "无 stderr 尾部。", 2000)),
    "",
    "## 操作边界",
    "",
    "- 不提交任何真实资金订单。",
    "- 报告链路恢复前，所有交易建议仍停在人工复核。"
  ].join("\n");
}

export function sanitizeAlertText(value, maxLength = 2000) {
  return clean(value)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/giu, "Bearer [REDACTED]")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|AUTHORIZATION|ACCESS_KEY)[A-Z0-9_]*)\s*=\s*[^\s；，]+/giu, "$1=[REDACTED]")
    .replace(/\b(token|secret|authorization|password)\b\s*[:=]\s*[^\s；，]+/giu, "$1=[REDACTED]")
    .slice(0, maxLength);
}

function fenced(value) {
  return `\`\`\`text\n${String(value).replace(/```/gu, "'''")}\n\`\`\``;
}

function clean(value) {
  return String(value ?? "").replace(/\r\n/gu, "\n").trim();
}
