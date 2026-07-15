// Phase 6 Task 6 (2026-07-15 plan): per-member broker credential loader.
//
// Today AlphaLoop has exactly ONE shared Longbridge paper account, read via
// the process-wide env (LONGBRIDGE_ACCESS_TOKEN etc., see _longbridge.mjs)
// and a single on-disk cache (region-cache under $HOME/.longbridge, the
// rate-limit state/lock files under runtime/). This module is the credential
// side of P6's multi-account scaffold: a per-member on-disk credentials
// directory that, WHEN POPULATED (P10 - real second account), lets
// official-paper-monitor.mjs fetch each member's OWN account with the
// member's own env and its own isolated caches, instead of the one shared
// pair of files every caller currently contends over.
//
// Directory layout (root default `~/.alphaloop/credentials`, overridable via
// ALPHALOOP_CREDENTIALS_ROOT for tests / alternate hosts):
//   <root>/<memberId>/longbridge.env       - the member's Longbridge credentials
//   <root>/<memberId>/.longbridge-home     - isolated $HOME for that member's
//                                            longbridge CLI subprocess (its
//                                            own region-cache/token store)
//   <root>/<memberId>/rate-limit           - isolated rate-limit state/lock
//                                            files for that member's calls
//
// A member with no `<root>/<memberId>/longbridge.env` file is NOT an error -
// it just means that member has no linked broker account yet (the common
// case for every member today). Callers degrade to "this member has no
// account" (loadMemberCredentials returns null), never throw.
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseEnvText } from "./env-file.mjs";

// The credential keys this loader will actually pass through into the
// subprocess env. Deliberately an explicit allowlist (not "copy every key in
// the file") so an operator's longbridge.env can carry unrelated comments/
// stray keys without this module blindly forwarding arbitrary env into a
// subprocess. Covers both the LONGBRIDGE_* and LONGPORT_* names the real CLI/
// SDK and this repo's existing scripts already read (see _longbridge.mjs's
// buildLongbridgeCliEnv / apps/broker-executor/src/redaction.ts's sensitive-
// key list for the same two-prefix convention).
const LONGBRIDGE_CREDENTIAL_KEYS = [
  "LONGBRIDGE_APP_KEY",
  "LONGBRIDGE_APP_SECRET",
  "LONGBRIDGE_ACCESS_TOKEN",
  "LONGBRIDGE_ACCOUNT_MODE",
  "LONGBRIDGE_REGION",
  "LONGPORT_APP_KEY",
  "LONGPORT_APP_SECRET",
  "LONGPORT_ACCESS_TOKEN"
];

/**
 * Resolves the credentials root directory: explicit `rootDir` argument wins,
 * then `ALPHALOOP_CREDENTIALS_ROOT` (test/alternate-host override), then the
 * default `~/.alphaloop/credentials`.
 *
 * @param {string} [rootDir]
 * @returns {string}
 */
export function resolveCredentialsRoot(rootDir) {
  return rootDir ?? process.env.ALPHALOOP_CREDENTIALS_ROOT ?? join(homedir(), ".alphaloop", "credentials");
}

/**
 * @typedef {object} MemberCredentials
 * @property {Record<string, string>} env - LONGBRIDGE_* / LONGPORT_* values parsed from
 *   the member's longbridge.env, ready to merge into a subprocess env.
 * @property {{home: string, rateLimitDir: string}} cachePaths - per-member
 *   isolated cache directories (created on disk by this function so a
 *   caller can use them immediately).
 * @property {string[]} [warnings] - present only when non-empty (matches
 *   this codebase's existing warnings-array convention, e.g. proposals.mjs).
 */

/**
 * Loads member `memberId`'s broker credentials from
 * `<root>/<memberId>/longbridge.env`. Returns `null` (never throws) when the
 * member has no credentials directory/file at all - "this member has no
 * linked broker account" is an entirely normal, common state, not an error.
 *
 * A credentials file whose permissions are wider than owner-only (i.e. any
 * group/other bit set - `mode & 0o077 !== 0`) is NOT blocked - trading
 * secrets on a misconfigured filesystem are still usable, this is a
 * defense-in-depth warning, not a hard gate - but the returned object
 * carries a `warnings` entry so a caller (a future doctor/audit script, or
 * just this function's own console output) can surface it.
 *
 * @param {string} memberId
 * @param {{rootDir?: string}} [options]
 * @returns {MemberCredentials | null}
 */
export function loadMemberCredentials(memberId, { rootDir } = {}) {
  const root = resolveCredentialsRoot(rootDir);
  const memberDir = join(root, memberId);
  const envPath = join(memberDir, "longbridge.env");

  if (!existsSync(envPath)) {
    return null;
  }

  const warnings = [];
  try {
    const stats = statSync(envPath);
    // 0o077 = any group or other permission bit (read/write/execute). An
    // owner-only file is 0o600/0o400/... - `mode & 0o077 === 0`.
    if ((stats.mode & 0o077) !== 0) {
      warnings.push(`凭据文件权限过宽（非仅所有者可读）：${envPath}（建议 chmod 600）`);
    }
  } catch {
    // A stat failure right after existsSync succeeded (e.g. TOCTOU race, a
    // permissions-only edge case) does not itself invalidate the read below -
    // the actual readFileSync call is the authoritative success/failure.
  }

  const raw = readFileSync(envPath, "utf8");
  const parsed = parseEnvText(raw);

  const env = {};
  for (const key of LONGBRIDGE_CREDENTIAL_KEYS) {
    if (parsed[key] !== undefined) {
      env[key] = parsed[key];
    }
  }

  const cachePaths = {
    home: join(memberDir, ".longbridge-home"),
    rateLimitDir: join(memberDir, "rate-limit")
  };
  mkdirSync(cachePaths.home, { recursive: true });
  mkdirSync(cachePaths.rateLimitDir, { recursive: true });

  return {
    env,
    cachePaths,
    ...(warnings.length > 0 ? { warnings } : {})
  };
}

/**
 * Builds a FRESH env object to inject into a member's longbridge CLI
 * subprocess: the member's own LONGBRIDGE_* / LONGPORT_* credentials, `HOME`
 * overridden to that member's isolated cache directory (so the real
 * longbridge CLI's own on-disk state - token store, region cache - never
 * collides with another member's or the shared account's), and
 * `LONGBRIDGE_RATE_LIMIT_DIR` set to that member's isolated rate-limit
 * directory (a convention private to this codebase's own _longbridge.mjs,
 * NOT read by the real longbridge binary - see that file's
 * `runLongbridgeText` options handling, which reads `options.rateLimitDir`
 * first and falls back to this env var so a caller that only has this one
 * env object in hand - e.g. a future subprocess-spawning caller - does not
 * also have to thread a second parameter through separately).
 *
 * NEVER mutates `process.env` - every value is copied into a brand new
 * object. Base is a shallow copy of the CURRENT process.env (so PATH and
 * other ambient variables the CLI needs still resolve), with the member's
 * credentials and cache overrides layered on top; the caller passes the
 * returned object directly as a subprocess spawn's `env`.
 *
 * @param {MemberCredentials} creds
 * @returns {Record<string, string>}
 */
export function buildMemberSubprocessEnv(creds) {
  const env = { ...process.env, ...creds.env };
  env.HOME = creds.cachePaths.home;
  env.LONGBRIDGE_RATE_LIMIT_DIR = creds.cachePaths.rateLimitDir;
  return env;
}
