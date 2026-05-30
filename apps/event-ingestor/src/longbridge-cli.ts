import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runLongbridgeJson(args: string[]): Promise<unknown> {
  const attempts = Math.max(1, Number(process.env.LONGBRIDGE_READ_RETRY_ATTEMPTS ?? 4));
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const payload = await runLongbridgeJsonOnce(args);
      if (args[0] === "check") {
        await healLongbridgeRegionCacheFromCheck(payload);
      }
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientLongbridgeError(error)) {
        break;
      }
      await sleep(backoffMs(attempt));
      if (args[0] !== "check") {
        await healLongbridgeRegionCache();
      }
    }
  }

  throw new Error(`Longbridge read failed after ${attempts} attempts: ${sanitizeLongbridgeError(lastError)}`);
}

async function runLongbridgeJsonOnce(args: string[]): Promise<unknown> {
  const { stdout } = await execFileAsync(resolveLongbridgeCli(), [...args, "--format", "json"], {
    encoding: "utf8",
    env: buildLongbridgeCliEnv(),
    timeout: Number(process.env.LONGBRIDGE_CLI_TIMEOUT_MS ?? 45_000)
  });
  const output = stdout.trim();

  if (!output) {
    return {};
  }

  return parseLongbridgeJson(output);
}

export function normalizeSymbol(value: string): string {
  const symbol = value.trim().toUpperCase();
  if (!symbol) {
    return "";
  }
  if (/^[A-Z0-9.-]+\.[A-Z]{2,4}$/u.test(symbol) || symbol.startsWith(".")) {
    return symbol;
  }
  if (/^[A-Z]{1,6}$/u.test(symbol)) {
    return `${symbol}.US`;
  }
  return symbol;
}

export function parseSymbolList(value: string | undefined, fallback: string[]): string[] {
  const seen = new Set<string>();
  return (value?.split(",") ?? fallback)
    .map((entry) => normalizeSymbol(entry))
    .filter(Boolean)
    .filter((symbol) => {
      if (seen.has(symbol)) {
        return false;
      }
      seen.add(symbol);
      return true;
    });
}

export function sanitizeLongbridgeError(error: unknown): string {
  return String((error as Error)?.message ?? error ?? "unknown")
    .replace(/(token|secret|authorization)[^\s]*/giu, "$1=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gu, "Bearer [REDACTED]")
    .slice(0, 500);
}

function isTransientLongbridgeError(error: unknown): boolean {
  const text = `${(error as Error)?.message ?? ""}\n${(error as { stderr?: string })?.stderr ?? ""}`;
  return /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNABORTED|ENOTFOUND|EAI_AGAIN|client error \(Connect\)|socket|TLS|network/iu.test(text);
}

function backoffMs(attempt: number): number {
  const base = Number(process.env.LONGBRIDGE_READ_RETRY_BASE_MS ?? 1200);
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(15_000, base * 2 ** Math.max(0, attempt - 1)) + jitter;
}

async function healLongbridgeRegionCache(): Promise<void> {
  try {
    const payload = await runLongbridgeJsonOnce(["check"]);
    await healLongbridgeRegionCacheFromCheck(payload);
  } catch {
    // The next real adapter request decides success; this only shortens repeated region failures.
  }
}

async function healLongbridgeRegionCacheFromCheck(payload: unknown): Promise<void> {
  const check = payload as {
    connectivity?: Record<string, { ok?: boolean }>;
    region?: { active?: string };
  };
  const connectivity = check?.connectivity;
  if (!connectivity || typeof connectivity !== "object") {
    return;
  }

  const active = normalizeRegion(check.region?.active);
  const candidates = [active, "global", "cn"].filter(Boolean);
  const best = candidates.find((region) => connectivity[region]?.ok === true);
  if (!best) {
    return;
  }

  try {
    await writeFile(resolveRegionCachePath(), best);
  } catch {
    // Cache healing is best-effort and must not hide the original adapter result.
  }
}

function normalizeRegion(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "global" || normalized === "cn") {
    return normalized;
  }
  return "";
}

function parseLongbridgeJson(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    const embedded = parseFirstEmbeddedJson(output);
    if (embedded !== undefined) {
      return embedded;
    }
    throw new Error(`Longbridge CLI did not return parseable JSON: ${output.slice(0, 120)}`);
  }
}

function parseFirstEmbeddedJson(text: string): unknown {
  for (let index = 0; index < text.length; index += 1) {
    const marker = text[index];
    if (marker !== "{" && marker !== "[") {
      continue;
    }

    const jsonText = readBalancedJson(text, index);
    if (!jsonText) {
      continue;
    }

    try {
      return JSON.parse(jsonText);
    } catch {
      // Keep scanning; Longbridge progress text can contain bracketed terminal sequences.
    }
  }

  return undefined;
}

function readBalancedJson(text: string, start: number): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }

    if (char === "}" || char === "]") {
      const expected = stack.pop();
      if (char !== expected) {
        return "";
      }
      if (stack.length === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return "";
}

function resolveLongbridgeCli(): string {
  return process.env.LONGBRIDGE_CLI_PATH ?? `${process.env.HOME}/.local/bin/longbridge`;
}

function resolveRegionCachePath(): string {
  return `${process.env.HOME}/.longbridge/openapi/region-cache`;
}

function buildLongbridgeCliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["LONGBRIDGE_ACCESS_TOKEN", "LONGPORT_ACCESS_TOKEN"]) {
    if (!env[key]?.trim()) {
      delete env[key];
    }
  }
  return env;
}
