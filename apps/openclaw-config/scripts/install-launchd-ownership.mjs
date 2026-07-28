import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Task 9 (2026-07-28 spec-drift remediation): the one reader for
// install-launchd-ownership.txt, so the node-side installers and the zsh-side
// installers agree on who owns a label instead of each keeping a private copy
// of the list. The .txt (rather than an .mjs export) is what lets
// install-system-daemons.sh / install-launchd.sh read the same rows with awk
// without needing node on PATH.

export const LAUNCHD_OWNERSHIP_FILE = fileURLToPath(
  new URL("./install-launchd-ownership.txt", import.meta.url)
);

export const LAUNCHD_OWNERSHIP_SCOPES = ["system", "user", "retired", "external"];

/**
 * Parses the manifest into `[{ scope, label }]` in file order.
 * Throws on an unknown scope: a typo'd row would otherwise silently mean
 * "this label is owned by nobody and installed by nobody".
 */
export function readLaunchdOwnership(file = LAUNCHD_OWNERSHIP_FILE) {
  const rows = [];
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const [scope, label, ...rest] = line.split(/\s+/u);
    if (!LAUNCHD_OWNERSHIP_SCOPES.includes(scope)) {
      throw new Error(`${file}: unknown scope "${scope}" (expected one of ${LAUNCHD_OWNERSHIP_SCOPES.join(", ")})`);
    }
    if (!label || rest.length > 0) {
      throw new Error(`${file}: malformed row "${line}" (expected "<scope> <label>")`);
    }
    rows.push({ scope, label });
  }
  return rows;
}

/** Every label with the given scope, in file order. */
export function launchdLabelsWithScope(scope, file = LAUNCHD_OWNERSHIP_FILE) {
  return readLaunchdOwnership(file).filter((row) => row.scope === scope).map((row) => row.label);
}

/**
 * The labels no installer may ever leave in ~/Library/LaunchAgents: everything
 * a system daemon now owns, plus everything nobody owns.
 */
export function userLevelLabelsToRetire(file = LAUNCHD_OWNERSHIP_FILE) {
  return readLaunchdOwnership(file)
    .filter((row) => row.scope === "system" || row.scope === "retired")
    .map((row) => row.label);
}
