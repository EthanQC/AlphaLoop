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
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync
} from "node:fs";
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
  "LONGPORT_ACCESS_TOKEN",
  "LONGPORT_REGION"
];
const GLOBAL_AUTH_KEYS_TO_STRIP = [
  ...LONGBRIDGE_CREDENTIAL_KEYS,
  "LONGBRIDGE_OPENAPI_TOKEN_PATH"
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
 * Returns true only when the credential root is missing or contains no
 * credential-bearing/suspicious entries. This is the compatibility gate for
 * the ambient legacy account: once any member credential (including an
 * inactive/unknown member) or symlink exists, callers must not silently read
 * the process-global account for a different active member.
 */
export function isMemberCredentialTreeEmpty({ rootDir } = {}) {
  const root = resolveCredentialsRoot(rootDir);
  if (!pathEntryExists(root)) {
    return true;
  }
  assertSecureDirectory(root, "member credentials root");
  // The active-member loader decides which known directory is usable. This
  // gate answers a narrower safety question: may callers fall back to the
  // ambient shared account? Only a literally empty root is unambiguous;
  // unknown/partial directories and ordinary files are configuration state,
  // not permission to silently select another account.
  return readdirSync(root, { withFileTypes: true }).length === 0;
}

/**
 * @typedef {object} MemberCredentials
 * @property {Record<string, string>} env - LONGBRIDGE_* / LONGPORT_* values parsed from
 *   the member's longbridge.env, ready to merge into a subprocess env.
 * @property {{home: string, rateLimitDir: string}} cachePaths - per-member
 *   isolated cache directories (created on disk by this function so a
 *   caller can use them immediately).
 */

/**
 * Loads member `memberId`'s broker credentials from
 * `<root>/<memberId>/longbridge.env`. Returns `null` (never throws) when the
 * member has no credentials directory/file at all - "this member has no
 * linked broker account" is an entirely normal, common state, not an error.
 *
 * Once a credential path exists, every filesystem check is fail-closed: the
 * member directory must be a real owner-only directory; longbridge.env must
 * be a real owner-only file owned by this process uid; and the file is opened
 * with O_NOFOLLOW and compared with its pre-open inode to close symlink/TOCTOU
 * gaps. A missing file is still the ordinary "member has no account" signal.
 *
 * @param {string} memberId
 * @param {{rootDir?: string}} [options]
 * @returns {MemberCredentials | null}
 */
export function loadMemberCredentials(memberId, { rootDir } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(memberId) || memberId === "." || memberId === "..") {
    throw new Error(`Unsafe member id for credentials lookup: ${JSON.stringify(memberId)}`);
  }
  const root = resolveCredentialsRoot(rootDir);
  if (!pathEntryExists(root)) {
    return null;
  }
  assertSecureDirectory(root, "member credentials root");
  const memberDir = join(root, memberId);
  const envPath = join(memberDir, "longbridge.env");

  if (!pathEntryExists(envPath)) {
    return null;
  }

  assertSecureDirectory(memberDir, "member credentials directory");
  const parsed = readSecureCredentialFile(envPath);

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
  ensureSecureDirectory(cachePaths.home, "member Longbridge cache directory");
  ensureSecureDirectory(cachePaths.rateLimitDir, "member rate-limit directory");

  return {
    env,
    cachePaths
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
  const env = { ...process.env };
  for (const key of GLOBAL_AUTH_KEYS_TO_STRIP) {
    delete env[key];
  }
  Object.assign(env, creds.env);
  env.HOME = creds.cachePaths.home;
  env.LONGBRIDGE_RATE_LIMIT_DIR = creds.cachePaths.rateLimitDir;
  if (!env.LONGBRIDGE_ACCESS_TOKEN?.trim() && !env.LONGPORT_ACCESS_TOKEN?.trim()) {
    throw new Error("Member-specific Longbridge credentials do not contain an access token.");
  }
  return env;
}

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

function readSecureCredentialFile(path) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Broker credentials must be a regular file, not a symlink: ${path}.`);
  }
  assertOwnerOnly(before.mode, path);
  assertOwnedByCurrentUser(before.uid, path);

  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`Broker credentials changed during secure open: ${path}.`);
    }
    assertOwnerOnly(opened.mode, path);
    assertOwnedByCurrentUser(opened.uid, path);
    return parseEnvText(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}

function assertSecureDirectory(path, label) {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory, not a symlink: ${path}.`);
  }
  assertOwnerOnly(stats.mode, path);
  assertOwnedByCurrentUser(stats.uid, path);
}

function ensureSecureDirectory(path, label) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: false, mode: 0o700 });
  }
  assertSecureDirectory(path, label);
}

function assertOwnerOnly(mode, path) {
  if ((mode & 0o077) !== 0) {
    throw new Error(`Broker credentials permission must be owner-only (0600 file / 0700 directory): ${path}.`);
  }
}

function assertOwnedByCurrentUser(uid, path) {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (currentUid !== undefined && uid !== currentUid) {
    throw new Error(`Broker credentials are not owned by the monitoring user: ${path}.`);
  }
}
