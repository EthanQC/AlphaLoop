import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const MACOS_LSOF = "/usr/sbin/lsof";
const COMMON_LINUX_LSOF = "/usr/bin/lsof";

export function resolveLsofBin({ env = process.env, exists = existsSync } = {}) {
  const configured = String(env.LSOF_BIN ?? "").trim();
  if (configured) return configured;
  if (exists(MACOS_LSOF)) return MACOS_LSOF;
  if (exists(COMMON_LINUX_LSOF)) return COMMON_LINUX_LSOF;
  return "lsof";
}

function runLsof(binary, args) {
  try {
    return execFileSync(binary, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

export function readListeners(port, options = {}) {
  const binary = resolveLsofBin(options);
  const exec = options.exec ?? runLsof;
  const output = exec(binary, ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  return output
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/u);
      const last = parts.at(-1);
      return {
        command: parts[0],
        pid: Number(parts[1]),
        endpoint: last === "(LISTEN)" ? parts.at(-2) : last
      };
    })
    .filter((entry) => Number.isFinite(entry.pid));
}
