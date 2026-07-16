// Credential / region / endpoint resolution. Pure given injected env + fs so
// tests never touch the real filesystem or real secrets.
//
// Precedence rules mirror docs/superpowers/specs/secrets-inventory.md §2/§7
// and packages/shared-types/src/runtime.ts resolveLongbridgeAuthState:
//   - LONGBRIDGE_* wins over legacy LONGPORT_* when both are set;
//   - with no token env var, fall back to LONGBRIDGE_OPENAPI_TOKEN_PATH, then
//     the first non-dot entry (sorted) of $HOME/.longbridge/openapi/tokens/;
//   - region: LONGBRIDGE_REGION / LONGPORT_REGION env override, then the
//     $HOME/.longbridge/openapi/region-cache file (maintained by
//     _longbridge.mjs's healLongbridgeRegionCacheFromCheck), then "global".

export type Region = "global" | "cn";

export interface EnvLike {
  readonly [key: string]: string | undefined;
}

export interface FsLike {
  /** Returns file content, or undefined when unreadable/missing. */
  readTextFile(path: string): string | undefined;
  /** Returns directory entries, or undefined when unreadable/missing. */
  listDir(path: string): string[] | undefined;
}

export class CredentialsError extends Error {}

export interface ResolvedCredentials {
  appKey: string;
  appSecret: string;
  accessToken: string;
  tokenSource: "env" | "file";
}

export interface RegionResolution {
  active: Region;
  cached: Region | undefined;
  source: "env" | "cache" | "default";
}

export interface RegionEndpoints {
  httpUrl: string;
  quoteWsUrl: string;
  tradeWsUrl: string;
}

const REGION_ENDPOINTS: Record<Region, RegionEndpoints> = {
  global: {
    httpUrl: "https://openapi.longportapp.com",
    quoteWsUrl: "wss://openapi-quote.longportapp.com/v2",
    tradeWsUrl: "wss://openapi-trade.longportapp.com/v2"
  },
  cn: {
    httpUrl: "https://openapi.longportapp.cn",
    quoteWsUrl: "wss://openapi-quote.longportapp.cn/v2",
    tradeWsUrl: "wss://openapi-trade.longportapp.cn/v2"
  }
};

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function pickEnv(env: EnvLike, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = trimmed(env[name]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function parseTokenFileContent(content: string): string | undefined {
  const text = content.trim();
  if (!text) {
    return undefined;
  }
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      for (const key of ["access_token", "accessToken", "token"]) {
        const value = parsed[key];
        if (typeof value === "string" && value.trim()) {
          return value.trim();
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
  return text;
}

function readTokenFromDisk(env: EnvLike, fs: FsLike): string | undefined {
  const explicitPath = trimmed(env.LONGBRIDGE_OPENAPI_TOKEN_PATH);
  if (explicitPath !== undefined) {
    const content = fs.readTextFile(explicitPath);
    return content === undefined ? undefined : parseTokenFileContent(content);
  }

  const home = trimmed(env.HOME);
  if (home === undefined) {
    return undefined;
  }

  const tokenDir = `${home}/.longbridge/openapi/tokens`;
  const entry = (fs.listDir(tokenDir) ?? [])
    .filter((name) => !name.startsWith("."))
    .sort()
    .at(0);
  if (entry === undefined) {
    return undefined;
  }

  const content = fs.readTextFile(`${tokenDir}/${entry}`);
  return content === undefined ? undefined : parseTokenFileContent(content);
}

export function resolveCredentials(env: EnvLike, fs: FsLike): ResolvedCredentials {
  const appKey = pickEnv(env, "LONGBRIDGE_APP_KEY", "LONGPORT_APP_KEY");
  const appSecret = pickEnv(env, "LONGBRIDGE_APP_SECRET", "LONGPORT_APP_SECRET");

  let tokenSource: "env" | "file" = "env";
  let accessToken = pickEnv(env, "LONGBRIDGE_ACCESS_TOKEN", "LONGPORT_ACCESS_TOKEN");
  if (accessToken === undefined) {
    const fileToken = readTokenFromDisk(env, fs);
    if (fileToken !== undefined) {
      accessToken = fileToken;
      tokenSource = "file";
    }
  }

  const missing: string[] = [];
  if (appKey === undefined) {
    missing.push("LONGBRIDGE_APP_KEY（或 LONGPORT_APP_KEY）");
  }
  if (appSecret === undefined) {
    missing.push("LONGBRIDGE_APP_SECRET（或 LONGPORT_APP_SECRET）");
  }
  if (accessToken === undefined) {
    missing.push(
      "LONGBRIDGE_ACCESS_TOKEN（或 LONGPORT_ACCESS_TOKEN；也未在 LONGBRIDGE_OPENAPI_TOKEN_PATH / $HOME/.longbridge/openapi/tokens/ 找到令牌文件）"
    );
  }
  if (missing.length > 0 || appKey === undefined || appSecret === undefined || accessToken === undefined) {
    throw new CredentialsError(`缺少 Longbridge OpenAPI 凭据: ${missing.join("；")}`);
  }

  return { appKey, appSecret, accessToken, tokenSource };
}

function normalizeRegion(value: string | undefined): Region | undefined {
  const text = value?.trim().toLowerCase();
  return text === "global" || text === "cn" ? text : undefined;
}

export function resolveRegion(env: EnvLike, fs: FsLike): RegionResolution {
  const home = trimmed(env.HOME);
  const cached = home === undefined
    ? undefined
    : normalizeRegion(fs.readTextFile(`${home}/.longbridge/openapi/region-cache`));

  const envRegion = normalizeRegion(pickEnv(env, "LONGBRIDGE_REGION", "LONGPORT_REGION"));
  if (envRegion !== undefined) {
    return { active: envRegion, cached, source: "env" };
  }
  if (cached !== undefined) {
    return { active: cached, cached, source: "cache" };
  }
  return { active: "global", cached: undefined, source: "default" };
}

export function endpointsForRegion(region: Region, env?: EnvLike): RegionEndpoints {
  const defaults = REGION_ENDPOINTS[region];
  return {
    httpUrl: trimmed(env?.LONGPORT_HTTP_URL) ?? defaults.httpUrl,
    quoteWsUrl: trimmed(env?.LONGPORT_QUOTE_WS_URL) ?? defaults.quoteWsUrl,
    tradeWsUrl: trimmed(env?.LONGPORT_TRADE_WS_URL) ?? defaults.tradeWsUrl
  };
}
