#!/usr/bin/env node
// Builds @apps/longbridge-cli and installs the shim every repo consumer
// exec's: ~/.local/bin/longbridge (see _longbridge.mjs / longbridge-paper.ts
// resolveLongbridgeCli — LONGBRIDGE_CLI_PATH overrides the path, this script
// installs the default). Usage:
//   pnpm longbridge:install            # build + install
//   node scripts/install-longbridge-cli.mjs --skip-build

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRootDefault = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export function buildShimScript(repoRoot) {
  const distEntry = join(repoRoot, "apps", "longbridge-cli", "dist", "index.js");
  return `#!/bin/sh\n# Installed by apps/longbridge-cli/scripts/install-longbridge-cli.mjs\nexec node "${distEntry}" "$@"\n`;
}

export function installShim({ homeDir, repoRoot }) {
  const binDir = join(homeDir, ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  const shimPath = join(binDir, "longbridge");
  writeFileSync(shimPath, buildShimScript(repoRoot));
  chmodSync(shimPath, 0o755);
  return shimPath;
}

function buildPackage(repoRoot) {
  const result = spawnSync("pnpm", ["--filter", "@apps/longbridge-cli", "run", "build"], {
    cwd: repoRoot,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error(`构建 @apps/longbridge-cli 失败（exit ${result.status ?? "signal"}）`);
  }
}

function main() {
  const skipBuild = process.argv.includes("--skip-build");
  if (!skipBuild) {
    buildPackage(repoRootDefault);
  }
  const shimPath = installShim({ homeDir: homedir(), repoRoot: repoRootDefault });
  process.stdout.write(`已安装 longbridge shim: ${shimPath}\n`);
  process.stdout.write(`指向: ${join(repoRootDefault, "apps", "longbridge-cli", "dist", "index.js")}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
