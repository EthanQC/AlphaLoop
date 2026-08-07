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

const MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const ENV_LINE_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u;
const MEMBER_CREDENTIAL_KEYS = [
  "LONGBRIDGE_APP_KEY",
  "LONGBRIDGE_APP_SECRET",
  "LONGBRIDGE_ACCESS_TOKEN",
  "LONGBRIDGE_ACCOUNT_MODE",
  "LONGBRIDGE_REGION",
  "LONGPORT_APP_KEY",
  "LONGPORT_APP_SECRET",
  "LONGPORT_ACCESS_TOKEN",
  "LONGPORT_REGION"
] as const;
const GLOBAL_AUTH_KEYS_TO_STRIP = [
  ...MEMBER_CREDENTIAL_KEYS,
  "LONGBRIDGE_OPENAPI_TOKEN_PATH"
] as const;

export interface ResolveMemberExecutionEnvOptions {
  credentialsRoot?: string;
  activeMemberIds: readonly string[];
  baseEnv?: NodeJS.ProcessEnv;
}

export interface MemberExecutionContext {
  env: NodeJS.ProcessEnv;
  mode: "legacy-global" | "member";
}

/**
 * Resolves the exact environment used by the Longbridge subprocess for one
 * proposal owner. The legacy process-wide account is retained only while the
 * database has exactly one active member and the per-member credentials tree
 * is completely empty. Once multi-member/member-credential mode starts, a
 * missing owner file is a hard failure instead of silently trading another
 * member's account.
 */
export function resolveMemberExecutionContext(
  ownerId: string,
  options: ResolveMemberExecutionEnvOptions
): MemberExecutionContext {
  assertSafeMemberId(ownerId);
  if (!options.activeMemberIds.includes(ownerId)) {
    throw new Error(`Owner ${ownerId} is not an active member; refusing broker execution.`);
  }

  const credentialsRoot = options.credentialsRoot
    ?? options.baseEnv?.ALPHALOOP_CREDENTIALS_ROOT
    ?? process.env.ALPHALOOP_CREDENTIALS_ROOT
    ?? join(homedir(), ".alphaloop", "credentials");
  const baseEnv = { ...(options.baseEnv ?? process.env) };
  const ownerEnvPath = join(credentialsRoot, ownerId, "longbridge.env");

  if (!pathEntryExists(ownerEnvPath)) {
    const legacyAllowed = options.activeMemberIds.length === 1
      && !hasAnyMemberCredentialFile(credentialsRoot);
    if (!legacyAllowed) {
      throw new Error(
        `Owner-specific credentials for ${ownerId} are missing; refusing multi-member broker execution.`
      );
    }
    assertOfficialPaperEnv(baseEnv);
    return { env: baseEnv, mode: "legacy-global" };
  }

  const memberDir = join(credentialsRoot, ownerId);
  assertSecureDirectory(memberDir, "member credentials directory");
  const parsed = readSecureCredentialFile(ownerEnvPath);
  const memberValues: NodeJS.ProcessEnv = {};
  for (const key of MEMBER_CREDENTIAL_KEYS) {
    const value = parsed[key];
    if (value !== undefined) {
      memberValues[key] = value;
    }
  }

  for (const key of GLOBAL_AUTH_KEYS_TO_STRIP) {
    delete baseEnv[key];
  }
  const resolved: NodeJS.ProcessEnv = { ...baseEnv, ...memberValues };
  const cacheHome = join(memberDir, ".longbridge-home");
  const rateLimitDir = join(memberDir, "rate-limit");
  ensureSecureDirectory(cacheHome, "member Longbridge cache directory");
  ensureSecureDirectory(rateLimitDir, "member rate-limit directory");
  resolved.HOME = cacheHome;
  resolved.LONGBRIDGE_RATE_LIMIT_DIR = rateLimitDir;

  if (!resolved.LONGBRIDGE_ACCESS_TOKEN?.trim() && !resolved.LONGPORT_ACCESS_TOKEN?.trim()) {
    throw new Error(`Owner-specific credentials for ${ownerId} do not contain an access token.`);
  }
  assertOfficialPaperEnv(resolved);
  return { env: resolved, mode: "member" };
}

function assertSafeMemberId(memberId: string): void {
  if (!MEMBER_ID_PATTERN.test(memberId) || memberId === "." || memberId === "..") {
    throw new Error(`Unsafe member id for credentials lookup: ${JSON.stringify(memberId)}.`);
  }
}

function hasAnyMemberCredentialFile(root: string): boolean {
  if (!existsSync(root)) return false;
  try {
    return readdirSync(root, { withFileTypes: true }).some((entry) => {
      // A symlink inside the credentials root is suspicious state, not proof
      // that the tree is empty and eligible for legacy shared-account mode.
      if (entry.isSymbolicLink()) return true;
      return entry.isDirectory() && pathEntryExists(join(root, entry.name, "longbridge.env"));
    });
  } catch {
    // An unreadable credentials root is not equivalent to an empty root. The
    // conservative result disables the shared-account compatibility path.
    return true;
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function readSecureCredentialFile(path: string): Record<string, string> {
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

function assertSecureDirectory(path: string, label: string): void {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory, not a symlink: ${path}.`);
  }
  assertOwnerOnly(stats.mode, path);
  assertOwnedByCurrentUser(stats.uid, path);
}

function ensureSecureDirectory(path: string, label: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: false, mode: 0o700 });
  }
  assertSecureDirectory(path, label);
}

function assertOwnerOnly(mode: number, path: string): void {
  if ((mode & 0o077) !== 0) {
    throw new Error(`Broker credentials permission must be owner-only (0600 file / 0700 directory): ${path}.`);
  }
}

function assertOwnedByCurrentUser(uid: number, path: string): void {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (currentUid !== undefined && uid !== currentUid) {
    throw new Error(`Broker credentials are not owned by the broker-executor user: ${path}.`);
  }
}

function assertOfficialPaperEnv(env: NodeJS.ProcessEnv): void {
  const failures: string[] = [];
  if (env.LONGBRIDGE_OFFICIAL_PAPER_ENABLED !== "true") {
    failures.push("LONGBRIDGE_OFFICIAL_PAPER_ENABLED=true");
  }
  if (env.LONGBRIDGE_ACCOUNT_MODE !== "paper") {
    failures.push("LONGBRIDGE_ACCOUNT_MODE=paper");
  }
  if (env.ALLOW_LIVE_EXECUTION !== "false") {
    failures.push("ALLOW_LIVE_EXECUTION=false");
  }
  if (failures.length > 0) {
    throw new Error(`Owner broker environment is not official-paper safe; required: ${failures.join(", ")}.`);
  }
}

function parseEnvText(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = ENV_LINE_PATTERN.exec(line);
    if (!match?.[1]) continue;
    parsed[match[1]] = parseEnvValue(match[2] ?? "");
  }
  return parsed;
}

function parseEnvValue(raw: string): string {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/'"'"'/gu, "'");
  }
  if (raw.length >= 2 && raw.startsWith("\"") && raw.endsWith("\"")) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw;
}
