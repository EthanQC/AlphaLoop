// Task H7 (2026-07-14 legacy audit): setup-feishu-user-auth.mjs and
// authorize-feishu-user.mjs each had their own ad hoc .env.local reader/
// writer, and both were broken in different, incompatible ways:
//   - setup-feishu-user-auth.mjs's updateEnvFile wrote every value UNQUOTED
//     (a successful `oauth` run writes LARK_UAT_SCOPE, a ~20-item
//     space-separated scope string, and LARK_COOKIE, a `k=v; k=v; ...`
//     string, as bare `KEY=value` lines) - `source .env.local` in
//     install-launchd.sh then either aborts ("command not found") or
//     silently truncates the value at the first shell-special character.
//   - authorize-feishu-user.mjs's writeEnv fully rewrote the ENTIRE file
//     from a parsed key/value map on every run: it destroyed every comment
//     line, reordered every key alphabetically, DE-QUOTED every value that
//     happened to already be quoted (loadEnv stripped quotes without
//     reversing any escaping), and used JSON.stringify-style double quotes
//     which do not protect `$` from shell expansion.
//
// Both scripts write to the SAME physical .env.local, so they must agree on
// exactly one quoting convention - this module is that single source of
// truth. `applyEnvUpdates` is deliberately NOT a parse-the-whole-file-then-
// reserialize-everything round trip (that was the root cause of both bugs
// above): it only ever rewrites the specific lines whose key is being
// changed, leaving every other line (comments included) byte-for-byte
// identical, and appends genuinely new keys at the end.
//
// Quoting: values are left bare when they contain only shell-safe
// characters (keeps the file readable for simple values, minimal diff from
// today's convention); anything else is wrapped in POSIX single quotes,
// which suppress ALL shell expansion (including `$`, unlike double quotes)
// - the one exception (an embedded single quote) is escaped with the
// standard `'"'"'` trick. parseEnvValue is the exact inverse, and also
// still understands legacy double-quoted (JSON.stringify-style) values so
// pre-existing lines written by the OLD authorize-feishu-user.mjs keep
// reading back correctly.

const KEY_LINE_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u;
const SAFE_BARE_VALUE_PATTERN = /^[A-Za-z0-9_.\-/:@,+]*$/u;

export function parseEnvValue(raw) {
  const value = String(raw ?? "");
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/'"'"'/gu, "'");
  }
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function formatEnvValue(value) {
  const text = String(value ?? "");
  if (SAFE_BARE_VALUE_PATTERN.test(text)) {
    return text;
  }
  return `'${text.replace(/'/gu, `'"'"'`)}'`;
}

// Parses `text` (the raw contents of an .env-style file) into a plain
// object of decoded values. Comments and malformed lines are ignored, just
// like every existing reader in this repo.
export function parseEnvText(text) {
  const values = {};
  for (const rawLine of String(text ?? "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = KEY_LINE_PATTERN.exec(line);
    if (!match) {
      continue;
    }
    values[match[1]] = parseEnvValue(match[2] ?? "");
  }
  return values;
}

// Minimal-edit rewrite: only lines whose key appears in `updates` are ever
// changed (replaced with a correctly-quoted `KEY=value` line); every other
// line - comments, blank lines, untouched keys - is preserved byte-for-byte.
// Keys present in `updates` with no existing line are appended at the end.
export function applyEnvUpdates(text, updates) {
  const existing = String(text ?? "");
  const lines = existing.length > 0 ? existing.split(/\r?\n/u) : [];
  if (lines.length > 0 && lines[lines.length - 1] === "" && existing.endsWith("\n")) {
    lines.pop();
  }

  const seen = new Set();
  const nextLines = lines.map((line) => {
    const match = KEY_LINE_PATTERN.exec(line);
    if (!match || !(match[1] in updates)) {
      return line;
    }
    seen.add(match[1]);
    return `${match[1]}=${formatEnvValue(updates[match[1]])}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) {
      nextLines.push(`${key}=${formatEnvValue(value)}`);
    }
  }

  return `${nextLines.join("\n")}\n`;
}
