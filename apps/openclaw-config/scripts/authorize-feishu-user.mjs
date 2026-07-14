#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { repoRoot } from "./repo-root.mjs";
import { applyEnvUpdates, parseEnvText } from "./env-file.mjs";

// Task H7 (2026-07-14 legacy audit): guarded the same way every other
// testable CLI script in this directory already is - this is what makes
// computeAuthorizeEnvUpdates/applyAuthorizeEnvUpdate importable and
// directly testable (see authorize-feishu-user.test.ts) without running
// the real allowlist-file write, render-openclaw-config.mjs, or
// install-launchd.sh as a side effect of `import`.
const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  const openId = process.argv[2]?.trim();

  if (!openId || !openId.startsWith("ou_")) {
    console.error("Usage: authorize-feishu-user.mjs <feishu_open_id>");
    process.exit(1);
  }

  const envPath = join(repoRoot, ".env.local");
  const { allowFrom } = applyAuthorizeEnvUpdate(envPath, openId);
  updateOpenClawAllowlist(openId);

  execFileSync(process.execPath, [join(repoRoot, "apps", "openclaw-config", "scripts", "render-openclaw-config.mjs")], {
    cwd: repoRoot,
    stdio: "inherit"
  });
  // install-launchd.sh has a `#!/bin/zsh` shebang and its render loop uses
  // zsh-only extended-glob qualifiers (`(N)`, see that script) - invoking it
  // via `bash` throws a syntax error (`unexpected token '('`) and crashes this
  // script before the launchd jobs are ever installed. Found via task H2's
  // live verification of the newly-added `pnpm launchd:install-backup-alerts`
  // alias, which wraps this exact same script.
  execFileSync("zsh", [join(repoRoot, "apps", "openclaw-config", "scripts", "install-launchd.sh")], {
    cwd: repoRoot,
    stdio: "inherit"
  });

  console.log(JSON.stringify({ authorized: true, openId, allowFrom }, null, 2));
}

// Task H7 (2026-07-14 legacy audit): pure computation of what changes,
// separated from the env-file read/write below - directly testable, and
// makes the intent ("add this open id to the allowlist, flip the DM policy
// on if it's still the default") obvious independent of file I/O.
export function computeAuthorizeEnvUpdates(currentEnv, openId) {
  const allowFrom = mergeCsv(currentEnv.FEISHU_ALLOW_FROM, openId);
  const updates = { FEISHU_ALLOW_FROM: allowFrom.join(",") };
  if (!currentEnv.FEISHU_DM_POLICY || currentEnv.FEISHU_DM_POLICY === "pairing") {
    updates.FEISHU_DM_POLICY = "allowlist";
  }
  return { allowFrom, updates };
}

// Task H7 (2026-07-14 legacy audit): this used to be `loadEnv` + `writeEnv`
// - writeEnv fully rewrote the ENTIRE file from a parsed key/value map on
// every run (destroyed every comment, reordered every key alphabetically,
// DE-QUOTED every pre-quoted value with no reversal of the escaping, and
// used JSON.stringify-style double quotes that don't protect `$` from shell
// expansion). Now a minimal-edit update via the shared env-file.mjs helpers
// (same convention setup-feishu-user-auth.mjs uses for the SAME physical
// .env.local) - only FEISHU_ALLOW_FROM/FEISHU_DM_POLICY are ever touched;
// every other line is preserved byte-for-byte.
export function applyAuthorizeEnvUpdate(envPath, openId) {
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const currentEnv = parseEnvText(existing);
  const { allowFrom, updates } = computeAuthorizeEnvUpdates(currentEnv, openId);
  writeFileSync(envPath, applyEnvUpdates(existing, updates), "utf8");
  return { allowFrom, updates };
}

function updateOpenClawAllowlist(newOpenId) {
  const credentialsDir = join(homedir(), ".openclaw", "credentials");
  mkdirSync(credentialsDir, { recursive: true });
  const allowPath = join(credentialsDir, "feishu-main-allowFrom.json");
  const current = existsSync(allowPath)
    ? JSON.parse(readFileSync(allowPath, "utf8"))
    : { version: 1, allowFrom: [] };

  const allowFrom = Array.isArray(current.allowFrom) ? current.allowFrom.map(String) : [];
  if (!allowFrom.includes(newOpenId)) {
    allowFrom.push(newOpenId);
  }

  writeFileSync(
    allowPath,
    `${JSON.stringify({ version: 1, allowFrom }, null, 2)}\n`,
    "utf8"
  );
}

function mergeCsv(existingValue, nextValue) {
  const values = new Set(
    String(existingValue ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
  values.add(nextValue);
  return Array.from(values);
}
