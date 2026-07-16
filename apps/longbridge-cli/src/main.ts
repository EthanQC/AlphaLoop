// Entry orchestration with every side effect injected (env, fs, stdout,
// stderr, adapter factory) so the full flow is unit-testable. Exit-code
// contract (consumed by _longbridge.mjs and broker-executor):
//   0 = success, stdout carries exactly one JSON document (never empty);
//   1 = runtime/SDK failure (stderr keeps transient wording for retries);
//   2 = usage / credentials error (fail fast, no retry).

import type { LongbridgeAdapter } from "./adapter.js";
import { HELP_TEXT, parseArgv, UsageError } from "./cli.js";
import {
  CredentialsError,
  resolveCredentials,
  resolveRegion,
  type EnvLike,
  type FsLike,
  type Region,
  type RegionResolution,
  type ResolvedCredentials
} from "./env.js";
import { CheckFailedError, runCommand } from "./run.js";
import { sanitizeErrorText } from "./sanitize.js";

export type AdapterFactory = (region: Region) => LongbridgeAdapter;

export interface MainDeps {
  env: EnvLike;
  fs: FsLike;
  stdout(text: string): void;
  stderr(text: string): void;
  createAdapterFactory(creds: ResolvedCredentials, env: EnvLike, regions: RegionResolution): AdapterFactory;
}

function probeTimeoutFromEnv(env: EnvLike): number | undefined {
  const raw = Number(env.LONGBRIDGE_CHECK_PROBE_TIMEOUT_MS ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

export async function main(argv: string[], deps: MainDeps): Promise<number> {
  let secrets: string[] = [];

  try {
    const { command } = parseArgv(argv);
    if (command.kind === "help") {
      deps.stdout(HELP_TEXT);
      return 0;
    }

    const creds = resolveCredentials(deps.env, deps.fs);
    secrets = [creds.appKey, creds.appSecret, creds.accessToken];
    const regions = resolveRegion(deps.env, deps.fs);
    const adapterFor = deps.createAdapterFactory(creds, deps.env, regions);

    const payload = await runCommand(command, {
      adapterFor,
      regions,
      probeTimeoutMs: probeTimeoutFromEnv(deps.env)
    });

    const json = JSON.stringify(payload);
    if (json === undefined || json === "") {
      throw new Error("内部错误：命令产生了空 JSON 输出");
    }
    deps.stdout(json);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`longbridge: ${error.message}\n用法详见: longbridge --help`);
      return 2;
    }
    if (error instanceof CredentialsError) {
      deps.stderr(`longbridge: ${error.message}`);
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    const prefix = error instanceof CheckFailedError ? "" : "命令执行失败: ";
    deps.stderr(`longbridge: ${prefix}${sanitizeErrorText(message, secrets)}`);
    return 1;
  }
}
