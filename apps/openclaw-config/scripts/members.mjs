#!/usr/bin/env node
// Member/token management CLI for the platform-app identity layer
// (apps/platform-app/src/identity.ts). Conventions follow market-alerts.mjs
// EXACTLY (task brief): a single `buildCliResult` JSON envelope wrapping
// argv-parsing through dispatch, per-command flag allowlists (H6 pattern -
// a flag real for a DIFFERENT subcommand fails loud with "未知参数" instead
// of silently parsing and never being read), Chinese error messages, and a
// non-zero exit on error.
//
// `token` is a two-word command (`token issue` / `token revoke`) - argv[0]
// is inspected first in resolveCommand() so the dispatch table can key on
// the literal two-word string, exactly like every other single-word command.
//
// There is no dedicated members-store.mjs: MemberRepository/ApiTokenRepository/
// AuditLogRepository (packages/shared-types) already ARE the repository
// layer for these tables, so this file only adds argument parsing,
// validation, and the Chinese-error/JSON-envelope dispatch on top of them -
// no raw SQL lives here.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ApiTokenRepository,
  AuditLogRepository,
  MemberRepository,
  createId,
  nowIso,
  openTradingDatabase,
  resolveRuntimePaths
} from "../../../packages/shared-types/dist/index.js";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

// v7 migration placeholder (packages/shared-types database.ts) - not a real
// person, must never be treated as a manageable member. Mirrors the guard in
// apps/platform-app/src/identity.ts.
const LEGACY_SYSTEM_MEMBER_ID = "__legacy_system__";

// This CLI has no genuine boolean/no-value flags (unlike market-alerts.mjs's
// --all/--purge) - every flag here (email/name/feishu/member/label/token-id)
// always expects a value. Kept as an explicit (empty) set, rather than
// omitted, so the intent - "there are none, not that we forgot to list them" -
// is visible at the call site, matching market-alerts.mjs's structure.
const BOOLEAN_FLAGS = new Set();

// Per-command flag allowlist (H6 pattern, market-alerts.mjs Item 3): scoped
// PER SUBCOMMAND so a flag that is real for a different subcommand (e.g.
// --label under `revoke`) fails loud with "未知参数" instead of parsing fine
// and then silently never being read.
const COMMAND_FLAGS = {
  add: new Set(["email", "name", "feishu"]),
  list: new Set([]),
  revoke: new Set(["member"]),
  "token issue": new Set(["member", "label"]),
  "token revoke": new Set(["token-id"])
};

/**
 * Parses `--flag value` pairs from an argv slice (after the subcommand).
 * Mirrors market-alerts.mjs's parseFlags exactly: an unrecognized `--flag`
 * (typo, or a flag real for a different subcommand) throws immediately
 * instead of being silently recorded; a value-flag with nothing after it
 * becomes `""` (not the JS boolean `true`), so it still fails every
 * downstream `!value` check the same way an entirely absent flag would.
 *
 * @param {string[]} argv
 * @param {string} [command]
 */
export function parseFlags(argv, command) {
  const allowedFlags = COMMAND_FLAGS[command] ?? new Set();
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const name = token.slice(2);
    if (!allowedFlags.has(name)) {
      throw new Error(`未知参数：--${name}。`);
    }
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = "";
    } else {
      flags[name] = next;
      i += 1;
    }
  }
  return flags;
}

function requireFlag(flags, name) {
  const value = String(flags[name] ?? "").trim();
  if (!value) {
    throw new Error(`缺少 --${name} 参数。`);
  }
  return value;
}

function withDb(options, fn) {
  const db = openTradingDatabase(options.dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// `token` is a two-word command: argv = ["token", "issue", ...] must resolve
// to the literal dispatch key "token issue" (and "token revoke"), while every
// other command stays single-word. A bare "token" (no second word) or
// "token <unrecognized>" resolves to a string that is simply absent from
// COMMANDS, so it falls through to the same "未知子命令" error as any other
// typo - no special-casing needed at the dispatch site.
export function resolveCommand(argv) {
  const [first, second] = argv;
  if (first === "token") {
    return second ? `token ${second}` : "token";
  }
  return first ?? "";
}

export function runAdd(flags, options = {}) {
  const email = requireFlag(flags, "email");
  const name = requireFlag(flags, "name");
  const feishuOpenId = flags.feishu === undefined ? undefined : String(flags.feishu).trim();
  if (flags.feishu !== undefined && !feishuOpenId) {
    throw new Error("缺少 --feishu 参数值。");
  }

  return withDb(options, (db) => {
    const members = new MemberRepository(db);
    // getByEmail does NOT filter by status (see identity.ts's caveat) - a
    // revoked member's email still counts as "in use" here, so re-adding
    // the same email after a revoke correctly fails instead of silently
    // creating a second row that collides on the UNIQUE(email) constraint
    // with a less friendly raw SQLite error.
    if (members.getByEmail(email)) {
      throw new Error(`邮箱已存在，无法重复添加成员：${email}。`);
    }
    if (feishuOpenId && members.getByFeishuOpenId(feishuOpenId)) {
      throw new Error(`飞书 open_id 已被使用：${feishuOpenId}。`);
    }

    const member = {
      id: createId("member"),
      email,
      ...(feishuOpenId ? { feishuOpenId } : {}),
      displayName: name,
      riskTags: [],
      stockTags: [],
      showPerformance: true,
      status: "active",
      createdAt: nowIso()
    };
    members.upsert(member);

    new AuditLogRepository(db).write("platform_members", "add", {
      memberId: member.id,
      email: member.email,
      displayName: member.displayName,
      feishuOpenId: member.feishuOpenId ?? null
    });

    return { ok: true, member };
  });
}

// Admin-facing view: unlike MemberRepository.listActive() (the production
// resolution path's "who counts as a real member" read), this shows revoked
// members too - otherwise confirming a `revoke` actually took effect would
// require reaching for raw SQL. Read-only: writes no audit_log row.
export function runList(_flags, options = {}) {
  return withDb(options, (db) => ({ ok: true, members: new MemberRepository(db).listAll() }));
}

export function runRevoke(flags, options = {}) {
  const memberId = requireFlag(flags, "member");
  if (memberId === LEGACY_SYSTEM_MEMBER_ID) {
    throw new Error(`不能吊销 __legacy_system__（迁移占位成员，并非真实成员）。`);
  }

  return withDb(options, (db) => {
    const members = new MemberRepository(db);
    const member = members.getById(memberId);
    if (!member) {
      throw new Error(`成员不存在：${memberId}。`);
    }

    // Fetch-then-upsert-the-whole-row: upsert overwrites every column, so
    // passing a partial object here would silently null/blank out the
    // member's other fields (email, tags, etc.) instead of only flipping
    // status - fetch first (above), spread it, and override just status.
    members.upsert({ ...member, status: "revoked" });

    new AuditLogRepository(db).write("platform_members", "revoke", { memberId });

    return { ok: true, memberId, status: "revoked" };
  });
}

export function runTokenIssue(flags, options = {}) {
  const memberId = requireFlag(flags, "member");
  const label = requireFlag(flags, "label");

  return withDb(options, (db) => {
    const member = new MemberRepository(db).getById(memberId);
    if (!member) {
      throw new Error(`成员不存在：${memberId}。`);
    }
    if (member.status !== "active") {
      throw new Error(`成员已被吊销，无法签发 token：${memberId}。`);
    }

    const { id, token } = new ApiTokenRepository(db).issue(memberId, label);

    // Audit payload references the token id only - NEVER the plaintext.
    // This is the sole place the plaintext is even allowed to leave issue()'s
    // return value before it is gone forever (verify() only ever compares
    // hashes; there is no way to recover the plaintext from token_hash).
    new AuditLogRepository(db).write("platform_members", "token issue", {
      memberId,
      tokenId: id,
      label
    });

    return {
      ok: true,
      tokenId: id,
      token,
      memberId,
      label,
      warning: "该 token 只会显示这一次，请立即妥善保存；系统不会再次展示明文，遗失后只能吊销并重新签发。"
    };
  });
}

export function runTokenRevoke(flags, options = {}) {
  const tokenId = requireFlag(flags, "token-id");

  return withDb(options, (db) => {
    const result = new ApiTokenRepository(db).revoke(tokenId);
    if (Number(result.changes) === 0) {
      throw new Error(`token 不存在：${tokenId}。`);
    }

    new AuditLogRepository(db).write("platform_members", "token revoke", { tokenId });

    return { ok: true, tokenId, status: "revoked" };
  });
}

const COMMANDS = {
  add: runAdd,
  list: runList,
  revoke: runRevoke,
  "token issue": runTokenIssue,
  "token revoke": runTokenRevoke
};

export function runMembersCommand(command, flags, options = {}) {
  const handler = COMMANDS[command];
  if (!handler) {
    throw new Error(
      `未知子命令：${command || "(空)"}，仅支持 ${Object.keys(COMMANDS).join("/")}。`
    );
  }
  return handler(flags, options);
}

// Same pre-dispatch-through-dispatch-in-one-try/catch shape as
// market-alerts.mjs's buildCliResult: this CLI's binding contract is always
// exactly one line of JSON on stdout, so nothing (an unknown flag, an
// unknown command, a validation error) may escape as a raw stack trace.
export function buildCliResult(argv, options = {}) {
  try {
    const command = resolveCommand(argv);
    const rest = argv.slice(command ? command.split(" ").length : 0);
    const flags = parseFlags(rest, command);
    // MEMBERS_DB_PATH mirrors stock-analysis.mjs's STOCK_ANALYSIS_DB_PATH:
    // unset (and a no-op) in normal operation, where the real
    // runtime/trading.sqlite is used; lets a live/manual verification run
    // this exact binary against a disposable temp db instead, e.g.
    // `MEMBERS_DB_PATH=/tmp/x.sqlite node members.mjs list`.
    const dbPath = options.dbPath ?? process.env.MEMBERS_DB_PATH ?? resolveRuntimePaths(repoRoot).dbPath;
    return runMembersCommand(command, flags, { dbPath });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const result = buildCliResult(process.argv.slice(2));
  console.log(JSON.stringify(result));
  if (result.ok === false) {
    process.exitCode = 1;
  }
}

const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  await main();
}
