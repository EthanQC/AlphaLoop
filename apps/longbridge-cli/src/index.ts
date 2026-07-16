#!/usr/bin/env node
// Bin entry for the longbridge CLI (installed at ~/.local/bin/longbridge via
// scripts/install-longbridge-cli.mjs). All logic lives in main.ts; this file
// only wires real I/O and guarantees the process exits even though the SDK's
// websocket connections would otherwise keep the event loop alive (a hung
// process would be killed by the callers' 45s execFileSync timeout and
// counted as a failure).

import { readFileSync, readdirSync } from "node:fs";

import type { FsLike } from "./env.js";
import { createLongportAdapterFactory } from "./longport-adapter.js";
import { main } from "./main.js";

const realFs: FsLike = {
  readTextFile(path: string): string | undefined {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  listDir(path: string): string[] | undefined {
    try {
      return readdirSync(path);
    } catch {
      return undefined;
    }
  }
};

const stdoutChunks: string[] = [];

function exitAfterFlush(code: number): void {
  const output = stdoutChunks.join("\n");
  if (output === "") {
    process.exit(code);
  }
  // Wait for stdout to flush before exiting so piped consumers always see
  // the full JSON document; the unref'ed timer is a safety net.
  process.stdout.write(`${output}\n`, () => process.exit(code));
  setTimeout(() => process.exit(code), 5_000).unref();
}

main(process.argv.slice(2), {
  env: process.env as Record<string, string | undefined>,
  fs: realFs,
  stdout: (text) => {
    stdoutChunks.push(text);
  },
  stderr: (text) => {
    process.stderr.write(`${text}\n`);
  },
  createAdapterFactory: createLongportAdapterFactory
}).then(exitAfterFlush, (error: unknown) => {
  // main() catches everything it can; this is the last-resort guard.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`longbridge: 未预期的错误: ${message}\n`);
  process.exit(1);
});
