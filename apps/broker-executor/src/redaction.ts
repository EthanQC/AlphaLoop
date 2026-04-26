import type { JsonValue } from "@packages/shared-types";

const sensitiveKeyPattern = /(?:authorization|cookie|password|private[_-]?key|refresh[_-]?token|access[_-]?token|token|secret|api[_-]?key)/iu;
const sensitiveEnvNames = [
  "OPENCLAW_GATEWAY_TOKEN",
  "FEISHU_APP_SECRET",
  "FEISHU_VERIFICATION_TOKEN",
  "HONCHO_API_KEY",
  "LONGPORT_APP_SECRET",
  "LONGPORT_ACCESS_TOKEN",
  "LONGBRIDGE_APP_SECRET",
  "LONGBRIDGE_ACCESS_TOKEN",
  "LARK_COOKIE",
  "LARK_APP_SECRET",
  "LARK_USER_ACCESS_TOKEN",
  "LARK_USER_REFRESH_TOKEN",
  "GITHUB_TOKEN",
  "OPENAI_API_KEY"
];

export function redactSensitiveText(text: string): string {
  let redacted = text;

  for (const secret of collectRuntimeSecrets()) {
    redacted = redacted.split(secret).join("<redacted>");
  }

  return redacted
    .replace(/\b(?:sk|sk-proj|lb|lark|u-)[A-Za-z0-9_-]{16,}\b/gu, "<redacted>")
    .replace(
      /\b((?:authorization|cookie|password|private[_-]?key|refresh[_-]?token|access[_-]?token|token|secret|api[_-]?key)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["']?)[^"',\s}]+/giu,
      "$1$2$3<redacted>"
    );
}

export function redactSensitiveJsonValue(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveJsonValue(entry)) as JsonValue;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      sensitiveKeyPattern.test(key) ? "<redacted>" : redactSensitiveJsonValue(entry)
    ])
  ) as JsonValue;
}

function collectRuntimeSecrets(): string[] {
  return sensitiveEnvNames
    .map((name) => process.env[name]?.trim())
    .filter((value): value is string => Boolean(value && value.length >= 6 && value !== "replace_me"));
}
