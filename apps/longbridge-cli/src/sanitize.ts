// Error-text scrubbing: the binary must never print raw credentials to
// stderr (the wrappers additionally redact + cap at 500 chars on their side,
// but defense-in-depth starts here). Transient network wording (timeout /
// socket / TLS / ...) must survive unchanged so _longbridge.mjs's
// isTransientLongbridgeError still recognizes retryable failures.

const MAX_LENGTH = 2000;

export function sanitizeErrorText(text: string, secrets: Iterable<string | undefined>): string {
  let out = String(text ?? "");

  for (const secret of secrets) {
    const value = secret?.trim();
    if (!value || value.length < 4) {
      continue;
    }
    out = out.split(value).join("[REDACTED]");
  }

  out = out
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gu, "Bearer [REDACTED]")
    .replace(
      /([A-Za-z0-9_-]*(?:token|secret|password|authorization))(["']?\s*[:=：]\s*["']?)([^\s"',;]+)/giu,
      "$1$2[REDACTED]"
    );

  return out.length > MAX_LENGTH ? out.slice(0, MAX_LENGTH) : out;
}
