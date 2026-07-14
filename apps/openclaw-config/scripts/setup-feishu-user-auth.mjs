#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { applyEnvUpdates, parseEnvText } from "./env-file.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const envPath = join(repoRoot, ".env.local");
const runtimeDir = join(repoRoot, "runtime");
const oauthUrlPath = join(runtimeDir, "feishu-oauth-url.txt");
const oauthStatePath = join(runtimeDir, "feishu-oauth-state.json");
const port = Number(process.env.FEISHU_USER_PLUGIN_OAUTH_PORT ?? 9997);
const redirectUri = `http://127.0.0.1:${port}/callback`;
const scopes = [
  "offline_access",
  "auth:user.id:read",
  "im:message",
  "im:message:readonly",
  "im:chat",
  "im:chat:readonly",
  "contact:user.base:readonly",
  "contact:user.id:readonly",
  "docx:document",
  "drive:drive",
  "bitable:app",
  "wiki:wiki:readonly",
  "wiki:wiki",
  "okr:okr:readonly",
  "okr:okr.period:readonly",
  "okr:okr.content:readonly",
  "calendar:calendar:readonly",
  "calendar:calendar.event:read",
  "docs:document.media:download",
  "docs:document.media:upload"
].join(" ");

mkdirSync(runtimeDir, { recursive: true });

// Task H7 (2026-07-14 legacy audit): guarded the same way every other
// testable CLI script in this directory already is (stock-analysis.mjs,
// market-alerts-poll.mjs, official-paper-monitor.mjs) - this is what makes
// updateEnvFile/loadEnvFile importable and directly testable (see
// setup-feishu-user-auth.test.ts) without spawning the OAuth HTTP server or
// touching the real .env.local as a side effect of `import`.
const isMainModule = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  const [command, ...args] = process.argv.slice(2);
  const env = loadEnvFile(envPath);
  applyFeishuAliases(env);

  if (command === "cookie-from-state") {
    const [statePath] = args;
    if (!statePath) {
      throw new Error("Usage: setup-feishu-user-auth.mjs cookie-from-state <playwright-storage-state.json>");
    }
    importCookieFromPlaywrightState(statePath, env);
  } else if (command === "oauth") {
    await runOauth(env);
  } else if (command === "open-oauth-url") {
    openOauthUrl(env);
  } else if (command === "status") {
    printStatus(env);
  } else {
    console.error("Usage:");
    console.error("  setup-feishu-user-auth.mjs cookie-from-state <playwright-storage-state.json>");
    console.error("  setup-feishu-user-auth.mjs oauth");
    console.error("  setup-feishu-user-auth.mjs open-oauth-url");
    console.error("  setup-feishu-user-auth.mjs status");
    process.exit(1);
  }
}

function importCookieFromPlaywrightState(statePath, currentEnv) {
  const absoluteStatePath = resolve(statePath);
  const parsed = JSON.parse(readFileSync(absoluteStatePath, "utf8"));
  const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];
  const feishuCookies = cookies
    .filter((cookie) => typeof cookie?.name === "string" && typeof cookie?.value === "string")
    .filter((cookie) => /(^|\.)feishu\.cn$/iu.test(String(cookie.domain ?? "").replace(/^\./u, "")) || String(cookie.domain ?? "").endsWith(".feishu.cn"));

  const cookieMap = new Map();
  for (const cookie of feishuCookies) {
    cookieMap.set(cookie.name, cookie.value);
  }

  if (!cookieMap.has("session") && !cookieMap.has("sl_session")) {
    throw new Error("Playwright state did not include Feishu session cookies. Please log in to https://www.feishu.cn/messenger/ first.");
  }

  updateEnvFile(envPath, {
    LARK_COOKIE: Array.from(cookieMap.entries()).map(([key, value]) => `${key}=${value}`).join("; ")
  });

  writeFileSync(oauthStatePath, `${JSON.stringify({
    cookieImportedAt: new Date().toISOString(),
    cookieNames: Array.from(cookieMap.keys()).sort()
  }, null, 2)}\n`, "utf8");

  console.log(`Feishu cookie imported from Playwright state (${cookieMap.size} cookies).`);
}

async function runOauth(currentEnv) {
  const appId = currentEnv.LARK_APP_ID;
  const appSecret = currentEnv.LARK_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("Missing LARK_APP_ID/LARK_APP_SECRET. Set them in .env.local or FEISHU_APP_ID/FEISHU_APP_SECRET first.");
  }

  const authUrl = `https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=${encodeURIComponent(appId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}`;
  writeFileSync(oauthUrlPath, `${authUrl}\n`, "utf8");

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", redirectUri);
    if (url.pathname !== "/callback") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    if (!code) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end("<h2>授权失败：未收到 code</h2>");
      return;
    }

    try {
      const tokenData = await exchangeCode({ appId, appSecret, code });
      const updates = {
        LARK_USER_ACCESS_TOKEN: tokenData.access_token,
        LARK_USER_REFRESH_TOKEN: tokenData.refresh_token ?? "",
        LARK_UAT_SCOPE: tokenData.scope ?? "",
        LARK_UAT_EXPIRES: String(Math.floor(Date.now() / 1000 + resolveExpiresIn(tokenData.expires_in)))
      };
      updateEnvFile(envPath, updates);
      writeFileSync(oauthStatePath, `${JSON.stringify({
        authorizedAt: new Date().toISOString(),
        hasRefreshToken: Boolean(tokenData.refresh_token),
        expiresIn: resolveExpiresIn(tokenData.expires_in),
        scope: tokenData.scope ?? null
      }, null, 2)}\n`, "utf8");

      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<h2>授权成功</h2><p>Token 已写入本地 .env.local，可以关闭此页面。</p>");
      console.log(`OAuth authorization saved. refresh_token=${tokenData.refresh_token ? "yes" : "no"}`);
      setTimeout(() => server.close(() => process.exit(0)), 500);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/html; charset=utf-8" });
      response.end(`<h2>Token 交换失败</h2><p>${escapeHtml(error.message)}</p>`);
      console.error(`OAuth token exchange failed: ${error.message}`);
    }
  });

  server.on("error", (error) => {
    console.error(`OAuth server failed: ${error.message}`);
    process.exit(1);
  });

  await new Promise((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));
  console.log(`OAuth URL written to ${oauthUrlPath}`);
  console.log(authUrl);
  openUrl(authUrl);

  setTimeout(() => {
    console.error("OAuth authorization timed out.");
    server.close(() => process.exit(1));
  }, 180000).unref();
}

function openOauthUrl(currentEnv) {
  const appId = currentEnv.LARK_APP_ID;
  if (!appId) {
    throw new Error("Missing LARK_APP_ID.");
  }
  if (!existsSync(oauthUrlPath)) {
    const authUrl = `https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=${encodeURIComponent(appId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}`;
    writeFileSync(oauthUrlPath, `${authUrl}\n`, "utf8");
  }
  const authUrl = readFileSync(oauthUrlPath, "utf8").trim();
  console.log(authUrl);
  openUrl(authUrl);
}

function printStatus(currentEnv) {
  console.log(JSON.stringify({
    larkCookie: Boolean(currentEnv.LARK_COOKIE),
    larkAppCredentials: Boolean(currentEnv.LARK_APP_ID && currentEnv.LARK_APP_SECRET),
    userAccessToken: Boolean(currentEnv.LARK_USER_ACCESS_TOKEN),
    userRefreshToken: Boolean(currentEnv.LARK_USER_REFRESH_TOKEN),
    userTokensRequiredForBotDelivery: false,
    targetGroupName: currentEnv.FEISHU_USER_PLUGIN_GROUP_NAME ?? "炒股这一块",
    targetBotChatId: currentEnv.FEISHU_USER_PLUGIN_BOT_CHAT_ID || currentEnv.FEISHU_NOTIFY_CHAT_ID ? "configured" : "missing",
    targetUserChatId: currentEnv.FEISHU_USER_PLUGIN_CHAT_ID ? "configured" : "missing",
    oauthRedirectUri: redirectUri
  }, null, 2));
}

async function exchangeCode({ appId, appSecret, code }) {
  const response = await fetch("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: appId,
      client_secret: appSecret,
      code,
      redirect_uri: redirectUri
    })
  });

  const raw = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`OAuth response was not JSON: ${raw.slice(0, 160)}`);
  }

  if (!response.ok || parsed.error) {
    throw new Error(parsed.error_description ?? parsed.error ?? `${response.status} ${response.statusText}`);
  }
  if (parsed.code && parsed.code !== 0) {
    throw new Error(parsed.msg ?? `Feishu OAuth error ${parsed.code}`);
  }

  const data = parsed.access_token ? parsed : parsed.data;
  if (!data?.access_token) {
    throw new Error("OAuth response did not include an access token.");
  }
  return data;
}

// Task H7 (2026-07-14 legacy audit): now a thin wrapper around the shared
// env-file.mjs parser (see its module header) instead of an ad hoc
// naive-quote-stripping reader - keeps this script's read side and its
// write side (updateEnvFile below) using the exact same decode rules.
export function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }
  return parseEnvText(readFileSync(filePath, "utf8"));
}

// Task H7 (2026-07-14 legacy audit): `values` is now expected to be ONLY
// the keys actually being changed (every call site below was fixed to stop
// passing `{...currentEnv, ...updates}` - the merged form used to make
// EVERY existing KEY=value line in the file eligible for rewriting, which
// silently DE-QUOTED every one of them on every oauth/cookie-import run).
// applyEnvUpdates (env-file.mjs) does the actual minimal-edit, correctly-
// quoted rewrite; this function only owns the "only LARK_*/known
// feishu-user-plugin keys may be newly appended" restriction that predates
// this fix and is kept as a defensive scope limiter.
export function updateEnvFile(filePath, values) {
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const existingKeys = parseEnvText(existing);
  // Preserves the pre-existing scope limit: a key with NO line in the file
  // yet may only be newly appended if it's a recognized feishu-user-plugin
  // key; a key that already has a line may still be updated in place
  // regardless (matches this function's original behavior 1:1).
  const allowedUpdates = Object.fromEntries(
    Object.entries(values).filter(
      ([key]) => key in existingKeys || /^LARK_/u.test(key) || key === "FEISHU_USER_PLUGIN_CHAT_ID" || key === "FEISHU_USER_PLUGIN_GROUP_NAME"
    )
  );
  writeFileSync(filePath, applyEnvUpdates(existing, allowedUpdates), "utf8");
}

function applyFeishuAliases(currentEnv) {
  if (!currentEnv.LARK_APP_ID && currentEnv.FEISHU_APP_ID) {
    currentEnv.LARK_APP_ID = currentEnv.FEISHU_APP_ID;
  }
  if (!currentEnv.LARK_APP_SECRET && currentEnv.FEISHU_APP_SECRET) {
    currentEnv.LARK_APP_SECRET = currentEnv.FEISHU_APP_SECRET;
  }
}

function openUrl(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(command, args, () => {});
}

function resolveExpiresIn(value) {
  return typeof value === "number" && value > 0 ? value : 7200;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}
