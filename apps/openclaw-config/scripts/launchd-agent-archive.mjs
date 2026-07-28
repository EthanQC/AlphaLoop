import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Round-5 finding D1 (2026-07-28 spec-drift remediation, deploy path).
//
// WHAT WENT WRONG
// ---------------
// install-system-daemons.sh is careful: when a daemon fails to bootstrap it
// KEEPS that service's old user-level LaunchAgent, so the machine goes on
// running the old copy of that one service. Runbook step 4
// (`pnpm launchd:install-user`) then ran `rmSync(plistPath)` over the exact
// same label list, unconditionally and with no backup, and step 5
// (`pnpm openclaw:cron:install`) did the identical thing - deleting the
// fallback the previous step had deliberately preserved.
//
// Measured with the real installers against a sandboxed root: injecting a
// bootstrap failure for com.alphaloop.market-alerts made step 3 exit 1 and
// correctly keep ~/Library/LaunchAgents/com.alphaloop.market-alerts.plist;
// step 4 then removed it, exit 0, silently.
//
// Three of those labels cannot be recreated from this repo at all -
// com.openclaw.trading.cron-runner, com.openclaw.trading.official-paper.poll
// and com.openclaw.trading.official-paper.pnl have no template under
// apps/openclaw-config/launchd/ (the installers that used to write them stopped
// writing anything in ac741d8). All three are sitting in the mini's
// ~/Library/LaunchAgents right now - `ls -la` there, read-only, while this was
// written - so this is the live deploy target, not a hypothetical.
//
// THE RULE THIS MODULE ENFORCES
// -----------------------------
//   1. Nothing is ever deleted. A retired plist is MOVED into
//      ~/Library/LaunchAgents.disabled/openclaw-system-backup-<ts>/, the same
//      archive install-system-daemons.sh uses, and can be bootstrapped back.
//   2. A label whose service was taken over by a system daemon is only
//      retired once that daemon answers `launchctl print system/<label>`.
//      If it does not, the user-level copy is left completely alone - not
//      booted out, not moved - because it is what the machine is running.
//   3. If the archive itself cannot be written (the mini's
//      ~/Library/LaunchAgents.disabled is `root staff` from a pre-M7 sudo run,
//      so an unprivileged process cannot create anything under it), the plist
//      stays where it is and is reported. "Could not archive" never degrades
//      into "deleted anyway".

/**
 * Which system daemon replaces a given user-level label. Mirrors
 * install-system-daemons.sh's own `supersedes()` case statement - the two are
 * asserted equal in install-launchd.test.ts, because a label that script
 * archives on the strength of a daemon being up has to be the same label this
 * module refuses to touch while that daemon is down.
 */
export const SYSTEM_DAEMON_SUPERSEDING = {
  "com.openclaw.trading.broker-executor": "com.openclaw.system.trading.broker-executor",
  "ai.openclaw.gateway": "ai.openclaw.system.gateway"
};

export function systemDaemonReplacing(label) {
  return SYSTEM_DAEMON_SUPERSEDING[label] ?? label;
}

export const ARCHIVE_PARENT_DIR_NAME = "LaunchAgents.disabled";

/** `openclaw-system-backup-20260728224500`, matching the shell's `date +%Y%m%d%H%M%S`. */
export function archiveDirectoryName(now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `openclaw-system-backup-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function defaultLaunchctl(args) {
  try {
    execFileSync("launchctl", args, { stdio: "ignore" });
    return 0;
  } catch (error) {
    return typeof error?.status === "number" ? error.status : 1;
  }
}

/**
 * Retires user-level LaunchAgents.
 *
 * @param {object} options
 * @param {string[]} options.labels                labels to consider, in order
 * @param {boolean} [options.requireReplacementDaemon]
 *   true  - a label is only retired once `launchctl print system/<daemon>`
 *           succeeds for the daemon that replaces it (the D1 rule);
 *   false - for labels nothing replaces (legacy trading jobs, the report
 *           schedules the openclaw cron channel took over): stop and archive.
 * @param {string} [options.home]                  defaults to the real $HOME
 * @param {number|undefined} [options.uid]
 * @param {(args: string[]) => number} [options.launchctl] exit status of `launchctl <args>`
 * @param {Date} [options.now]
 * @returns {{archived: object[], kept: object[]}}
 */
export function retireUserLevelAgents({
  labels,
  requireReplacementDaemon = true,
  home = homedir(),
  uid = process.getuid?.(),
  launchctl = defaultLaunchctl,
  now = new Date()
}) {
  const launchAgentsDir = join(home, "Library", "LaunchAgents");
  // ~/Library/LaunchAgents.disabled/<stamp>/ - the SAME archive
  // install-system-daemons.sh writes (its BACKUP_PARENT), so an operator has
  // one place to look and one place to restore from, whichever installer
  // retired the label.
  const archiveDir = join(home, "Library", ARCHIVE_PARENT_DIR_NAME, archiveDirectoryName(now));
  const archived = [];
  const kept = [];
  let archiveDirReady = false;

  const ensureArchiveDir = () => {
    if (archiveDirReady) {
      return null;
    }
    try {
      mkdirSync(archiveDir, { recursive: true });
      archiveDirReady = true;
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  for (const label of labels) {
    const plistPath = join(launchAgentsDir, `${label}.plist`);
    const plistExists = existsSync(plistPath);
    const replacement = systemDaemonReplacing(label);

    if (requireReplacementDaemon) {
      // Ask launchd, not the filesystem: a plist sitting in
      // /Library/LaunchDaemons proves an installer ran, not that the daemon
      // came up. This is the same question install-system-daemons.sh asks
      // before it archives anything, asked again here because the two run
      // minutes apart and the answer can have changed in between.
      if (launchctl(["print", `system/${replacement}`]) !== 0) {
        if (plistExists) {
          kept.push({
            label,
            plistPath,
            reason: `system/${replacement} 未加载：这台机器当前跑的就是这份用户级副本，删掉它会让该服务彻底停摆`
              + `（其中 cron-runner / official-paper.poll / official-paper.pnl 三个标签在仓库里没有任何模板，删了无法重建）。`
              + `请先修好 sudo zsh apps/openclaw-config/scripts/install-system-daemons.sh 再重跑本命令。`
          });
        }
        continue;
      }
    }

    if (uid !== undefined) {
      // Only now: the daemon is verified up, so stopping the old copy hands
      // over rather than turning the service off.
      launchctl(["bootout", `gui/${uid}`, plistPath]);
    }

    if (!plistExists) {
      continue;
    }

    const dirError = ensureArchiveDir();
    if (dirError !== null) {
      kept.push({
        label,
        plistPath,
        reason: `无法创建归档目录 ${archiveDir}（${dirError}）——脚本绝不会因此改为删除，plist 原地保留。`
          + `mini 上这个目录曾被 sudo 运行创建成 root 所有；修法：sudo chown -R "$(id -un)":staff ~/Library/${ARCHIVE_PARENT_DIR_NAME}`
      });
      continue;
    }

    const destination = join(archiveDir, `${label}.plist`);
    try {
      renameSync(plistPath, destination);
    } catch {
      // Different filesystem (a home directory on another volume): copy, then
      // remove the original only after the copy is verified in place.
      try {
        copyFileSync(plistPath, destination);
        if (!existsSync(destination)) {
          throw new Error(`copy to ${destination} produced no file`);
        }
        rmSync(plistPath);
      } catch (moveError) {
        kept.push({
          label,
          plistPath,
          reason: `归档移动失败（${moveError instanceof Error ? moveError.message : String(moveError)}）——plist 原地保留，未删除。`
        });
        continue;
      }
    }
    archived.push({ label, from: plistPath, to: destination });
  }

  return { archived, kept };
}

/**
 * The one place that turns a retire result into console output plus an exit
 * code, so `pnpm launchd:install-user` and `pnpm openclaw:cron:install` report
 * a half-migrated machine identically.
 */
export function reportRetireResult({ archived, kept }, { log = console.log, warn = console.error } = {}) {
  for (const entry of archived) {
    log(JSON.stringify({ retiredLaunchAgent: true, label: entry.label, archivedTo: entry.to }, null, 2));
  }
  for (const entry of kept) {
    warn(JSON.stringify({ keptLaunchAgent: true, label: entry.label, plistPath: entry.plistPath, reason: entry.reason }, null, 2));
  }
  return kept.length > 0;
}
