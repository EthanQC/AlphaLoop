#!/usr/bin/env node
// P10 public-web-access installer: runs the Cloudflare Tunnel connector
// (`cloudflared tunnel run --token <token>`) as a user LaunchAgent so the
// loopback-only platform-app (127.0.0.1:4314) becomes reachable through
// Cloudflare Access without ever binding a public port itself.
//
// The token comes from the Zero Trust dashboard's tunnel creation step
// ("Install and run a connector" shows it) and is resolved in precedence
// order: `--token <value>` argv flag, then the CF_TUNNEL_TOKEN environment
// variable, then CF_TUNNEL_TOKEN in the repo's .env.local. The token is a
// secret: it is written only into the plist (chmod 600) and is NEVER echoed
// to stdout/stderr or into the success JSON.
//
// Plist conventions follow install-openclaw-cron.mjs's runner service:
// RunAtLoad + KeepAlive, logs under <repo>/runtime/launchd/, PATH pinned to
// include Homebrew's bin dirs (launchd agents do not inherit a login
// shell's PATH), and a bootout -> bootstrap -> enable launchctl cycle so
// re-running the installer picks up a rotated token.
//
// `--dry-run` reports readiness (cloudflared/brew present, token present,
// target plist path) without installing anything - the P10 ignition
// checklist runs it before the Cloudflare side exists.
//
// Everything effectful lives in main() behind the isMainModule guard; the
// exported helpers are pure so install-cloudflared-tunnel.test.ts can cover
// them without touching launchctl, brew, or the filesystem.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseEnvText } from "./env-file.mjs";

export const TUNNEL_LABEL = "com.alphaloop.cloudflared-tunnel";

// Where Homebrew installs cloudflared on Apple Silicon / Intel respectively.
// Checked directly (in addition to `which`) because the installer itself may
// run from a context whose PATH lacks Homebrew - the exact failure mode the
// plist's pinned PATH exists to prevent for the agent.
export const CLOUDFLARED_CANDIDATE_PATHS = [
  "/opt/homebrew/bin/cloudflared",
  "/usr/local/bin/cloudflared"
];

const BREW_CANDIDATE_PATHS = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];

// Cloudflare tunnel tokens are base64(JSON) blobs. The exact alphabet is an
// implementation detail, so this only rejects values that are definitely
// wrong (whitespace, shell metacharacters) - the kind of damage a botched
// copy/paste from the dashboard produces.
const TOKEN_PATTERN = /^[A-Za-z0-9+/_.=-]+$/u;

/**
 * Resolves the tunnel token from (in precedence order) an argv `--token`
 * flag, `env.CF_TUNNEL_TOKEN`, then a CF_TUNNEL_TOKEN line in the given
 * .env.local text. Returns null when absent; throws when a value IS given
 * but is unusable (empty `--token`, whitespace inside) - a mispasted token
 * must fail loudly, not install a broken agent.
 */
export function resolveTunnelToken({ argv = [], env = {}, envFileText = "" } = {}) {
  const flagIndex = argv.indexOf("--token");
  let raw;
  if (flagIndex !== -1) {
    raw = argv[flagIndex + 1];
    if (raw === undefined || raw.startsWith("--")) {
      throw new Error("--token was given without a value");
    }
  } else if (env.CF_TUNNEL_TOKEN !== undefined && String(env.CF_TUNNEL_TOKEN).trim() !== "") {
    raw = env.CF_TUNNEL_TOKEN;
  } else {
    raw = parseEnvText(envFileText).CF_TUNNEL_TOKEN;
  }

  const token = String(raw ?? "").trim();
  if (!token) {
    return null;
  }
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(
      "CF_TUNNEL_TOKEN looks malformed (unexpected whitespace or characters) - " +
        "re-copy it from the Zero Trust dashboard's tunnel connector command"
    );
  }
  return token;
}

/**
 * Builds the LaunchAgent plist running `cloudflared tunnel run --token ...`.
 * Pure string assembly (XML-escaped) so tests can pin the exact contract.
 */
export function buildTunnelPlist({ label = TUNNEL_LABEL, cloudflaredBin, token, logDir, pathEnv, workingDirectory }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(cloudflaredBin)}</string>
    <string>tunnel</string>
    <string>run</string>
    <string>--token</string>
    <string>${escapeXml(token)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(pathEnv)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(logDir, `${label}.out.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(logDir, `${label}.err.log`))}</string>
</dict>
</plist>
`;
}

/**
 * launchd PATH for the agent: cloudflared's own dir first, then the
 * caller's PATH, then the standard fallbacks (Homebrew's /opt/homebrew/bin
 * included) - same convention as install-openclaw-cron.mjs.
 */
export function buildLaunchdPath(extraDirs, basePath = "") {
  return [
    ...extraDirs,
    ...String(basePath ?? "").split(":"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ].filter(Boolean).filter((value, index, all) => all.indexOf(value) === index).join(":");
}

export function escapeXml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function findExecutable(candidatePaths, name) {
  for (const candidate of candidatePaths) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  try {
    const found = execFileSync("which", [name], {
      encoding: "utf8",
      env: { ...process.env, PATH: buildLaunchdPath([], process.env.PATH) }
    }).trim();
    return found || null;
  } catch {
    return null;
  }
}

function ensureCloudflaredInstalled() {
  const existing = findExecutable(CLOUDFLARED_CANDIDATE_PATHS, "cloudflared");
  if (existing) {
    return existing;
  }

  const brew = findExecutable(BREW_CANDIDATE_PATHS, "brew");
  if (!brew) {
    throw new Error(
      "cloudflared is not installed and Homebrew was not found - install Homebrew " +
        "(https://brew.sh) or install cloudflared manually, then re-run"
    );
  }

  console.error("[tunnel:install] cloudflared not found - installing via brew...");
  execFileSync(brew, ["install", "cloudflared"], { stdio: ["ignore", "inherit", "inherit"] });

  const installed = findExecutable(CLOUDFLARED_CANDIDATE_PATHS, "cloudflared");
  if (!installed) {
    throw new Error("brew install cloudflared completed but the binary still cannot be found");
  }
  return installed;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const envLocalPath = join(repoRoot, ".env.local");
  const envFileText = existsSync(envLocalPath) ? readFileSync(envLocalPath, "utf8") : "";

  const token = resolveTunnelToken({ argv: args, env: process.env, envFileText });
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${TUNNEL_LABEL}.plist`);

  if (dryRun) {
    const cloudflaredBin = findExecutable(CLOUDFLARED_CANDIDATE_PATHS, "cloudflared");
    console.log(JSON.stringify({
      dryRun: true,
      label: TUNNEL_LABEL,
      plistPath,
      tokenPresent: token !== null,
      cloudflaredInstalled: cloudflaredBin !== null,
      cloudflaredBin,
      brewAvailable: findExecutable(BREW_CANDIDATE_PATHS, "brew") !== null
    }, null, 2));
    return;
  }

  if (!token) {
    throw new Error(
      "no tunnel token found - pass --token <value>, export CF_TUNNEL_TOKEN, or add " +
        "CF_TUNNEL_TOKEN to .env.local (Zero Trust dashboard -> Networks -> Tunnels -> " +
        "create tunnel -> the connector command's token)"
    );
  }

  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("this installer requires macOS launchctl (no uid available)");
  }

  const cloudflaredBin = ensureCloudflaredInstalled();
  const logDir = join(repoRoot, "runtime", "launchd");
  mkdirSync(logDir, { recursive: true });
  mkdirSync(dirname(plistPath), { recursive: true });

  const plist = buildTunnelPlist({
    label: TUNNEL_LABEL,
    cloudflaredBin,
    token,
    logDir,
    pathEnv: buildLaunchdPath([dirname(cloudflaredBin)], process.env.PATH),
    workingDirectory: repoRoot
  });
  // The plist embeds the tunnel token: create/overwrite with owner-only
  // permissions (writeFileSync's mode only applies on create, so chmodSync
  // covers the re-run/overwrite path too).
  writeFileSync(plistPath, plist, { encoding: "utf8", mode: 0o600 });
  chmodSync(plistPath, 0o600);

  try {
    execFileSync("launchctl", ["bootout", `gui/${uid}`, plistPath], { stdio: "ignore" });
  } catch {
    // Not loaded yet.
  }
  execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { stdio: "ignore" });
  execFileSync("launchctl", ["enable", `gui/${uid}/${TUNNEL_LABEL}`], { stdio: "ignore" });

  // NOTE: no token in this payload - keep it that way.
  console.log(JSON.stringify({
    installed: true,
    label: TUNNEL_LABEL,
    plistPath,
    cloudflaredBin,
    logDir
  }, null, 2));
}

const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  try {
    await main();
  } catch (error) {
    console.error(`[tunnel:install] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
