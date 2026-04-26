import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RuntimePaths {
  repoRoot: string;
  runtimeRoot: string;
  dbPath: string;
}

export interface LongbridgeAuthState {
  configured: boolean;
  source: "env" | "cli-token" | "none";
  tokenPath?: string;
}

const loadedEnvFiles = new Set<string>();

export function resolveRuntimePaths(repoRoot = process.cwd()): RuntimePaths {
  const normalizedRepoRoot = resolveRepoRoot(repoRoot);
  const runtimeRoot = join(normalizedRepoRoot, "runtime");
  const dbPath = join(runtimeRoot, "trading.sqlite");
  mkdirSync(dirname(dbPath), { recursive: true });
  return { repoRoot: normalizedRepoRoot, runtimeRoot, dbPath };
}

export function loadLocalEnv(repoRoot = process.cwd(), fileName = ".env.local"): Record<string, string> {
  const envPath = join(repoRoot, fileName);
  if (loadedEnvFiles.has(envPath)) {
    return {};
  }

  loadedEnvFiles.add(envPath);
  if (!existsSync(envPath)) {
    return {};
  }

  const parsed: Record<string, string> = {};
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
    if (!match) {
      continue;
    }

    const key = match[1];
    if (!key) {
      continue;
    }

    let value = match[2] ?? "";
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return parsed;
}

export function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function resolveLongbridgeAuthState(): LongbridgeAuthState {
  if (process.env.LONGBRIDGE_ACCESS_TOKEN || process.env.LONGPORT_ACCESS_TOKEN) {
    return {
      configured: true,
      source: "env"
    };
  }

  const configuredTokenPath = process.env.LONGBRIDGE_OPENAPI_TOKEN_PATH;
  if (configuredTokenPath && existsSync(configuredTokenPath)) {
    return {
      configured: true,
      source: "cli-token",
      tokenPath: configuredTokenPath
    };
  }

  const tokenDir = join(homedir(), ".longbridge", "openapi", "tokens");
  if (!existsSync(tokenDir)) {
    return {
      configured: false,
      source: "none"
    };
  }

  const tokenFile = readdirSync(tokenDir)
    .filter((entry) => !entry.startsWith("."))
    .sort()
    .at(0);

  if (!tokenFile) {
    return {
      configured: false,
      source: "none"
    };
  }

  return {
    configured: true,
    source: "cli-token",
    tokenPath: join(tokenDir, tokenFile)
  };
}

export function resolveRepoRoot(startPath: string): string {
  let current = startPath;

  while (true) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return startPath;
    }
    current = parent;
  }
}
