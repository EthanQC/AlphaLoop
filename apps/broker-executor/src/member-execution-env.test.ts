import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveMemberExecutionContext } from "./member-execution-env.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "alphaloop-broker-creds-"));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
}

function writeCredentials(root: string, ownerId: string, body: string, mode = 0o600): string {
  const memberDir = join(root, ownerId);
  mkdirSync(memberDir, { recursive: true, mode: 0o700 });
  chmodSync(memberDir, 0o700);
  const path = join(memberDir, "longbridge.env");
  writeFileSync(path, body, { mode });
  chmodSync(path, mode);
  return path;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

describe("resolveMemberExecutionContext", () => {
  const safeBase: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    LONGBRIDGE_ACCESS_TOKEN: "legacy-global-token",
    LONGBRIDGE_ACCOUNT_MODE: "paper",
    LONGBRIDGE_OFFICIAL_PAPER_ENABLED: "true",
    ALLOW_LIVE_EXECUTION: "false"
  };

  it("keeps the legacy process env only for the sole active owner when no member credentials exist", () => {
    const root = tempRoot();
    const resolved = resolveMemberExecutionContext("mem_owner", {
      credentialsRoot: root,
      activeMemberIds: ["mem_owner"],
      baseEnv: safeBase
    });

    expect(resolved.mode).toBe("legacy-global");
    expect(resolved.env.LONGBRIDGE_ACCESS_TOKEN).toBe("legacy-global-token");
    expect(resolved.env).not.toBe(safeBase);
  });

  it("fails closed instead of sharing one global account when more than one member is active", () => {
    expect(() => resolveMemberExecutionContext("mem_owner", {
      credentialsRoot: tempRoot(),
      activeMemberIds: ["mem_owner", "mem_other"],
      baseEnv: safeBase
    })).toThrow(/member-specific|owner-specific|multi-member/i);
  });

  it("does not treat a credential-path lookup error as an empty tree eligible for legacy global mode", () => {
    const ownerId = `mem_${"x".repeat(300)}`;
    expect(() => resolveMemberExecutionContext(ownerId, {
      credentialsRoot: tempRoot(),
      activeMemberIds: [ownerId],
      baseEnv: safeBase
    })).toThrow();
  });

  it("does not treat an unknown file in the credential root as an empty legacy tree", () => {
    const root = tempRoot();
    writeFileSync(join(root, "unexpected-state"), "present", { mode: 0o600 });

    expect(() => resolveMemberExecutionContext("mem_owner", {
      credentialsRoot: root,
      activeMemberIds: ["mem_owner"],
      baseEnv: safeBase
    })).toThrow(/credentials|legacy|member/i);
  });

  it("does not treat an unknown empty directory in the credential root as an empty legacy tree", () => {
    const root = tempRoot();
    mkdirSync(join(root, "inactive_or_unknown"), { mode: 0o700 });

    expect(() => resolveMemberExecutionContext("mem_owner", {
      credentialsRoot: root,
      activeMemberIds: ["mem_owner"],
      baseEnv: safeBase
    })).toThrow(/credentials|legacy|member/i);
  });

  it("rejects a symlinked credentials root instead of following it into legacy global mode", () => {
    const target = tempRoot();
    const parent = tempRoot();
    const symlinkRoot = join(parent, "credentials-link");
    symlinkSync(target, symlinkRoot);

    expect(() => resolveMemberExecutionContext("mem_owner", {
      credentialsRoot: symlinkRoot,
      activeMemberIds: ["mem_owner"],
      baseEnv: safeBase
    })).toThrow(/credentials root|directory|symlink/i);
  });

  it("rejects a credentials root with group or other permissions", () => {
    const root = tempRoot();
    chmodSync(root, 0o755);

    expect(() => resolveMemberExecutionContext("mem_owner", {
      credentialsRoot: root,
      activeMemberIds: ["mem_owner"],
      baseEnv: safeBase
    })).toThrow(/permission|0700/i);
  });

  it("rejects a broad-permission credentials root even when the owner file exists", () => {
    const root = tempRoot();
    writeCredentials(root, "mem_owner", "LONGBRIDGE_ACCESS_TOKEN=owner\nLONGBRIDGE_ACCOUNT_MODE=paper\n");
    chmodSync(root, 0o755);

    expect(() => resolveMemberExecutionContext("mem_owner", {
      credentialsRoot: root,
      activeMemberIds: ["mem_owner"],
      baseEnv: safeBase
    })).toThrow(/permission|0700/i);
  });

  it("rejects a symlinked credentials root even when the owner file exists", () => {
    const target = tempRoot();
    writeCredentials(target, "mem_owner", "LONGBRIDGE_ACCESS_TOKEN=owner\nLONGBRIDGE_ACCOUNT_MODE=paper\n");
    const parent = tempRoot();
    const symlinkRoot = join(parent, "credentials-link");
    symlinkSync(target, symlinkRoot);

    expect(() => resolveMemberExecutionContext("mem_owner", {
      credentialsRoot: symlinkRoot,
      activeMemberIds: ["mem_owner"],
      baseEnv: safeBase
    })).toThrow(/credentials root|directory|symlink/i);
  });

  it.skipIf(typeof process.getuid !== "function")("rejects a credentials root not owned by the broker-executor uid", () => {
    const root = tempRoot();
    const currentUid = process.getuid?.() ?? 0;
    vi.spyOn(process, "getuid").mockReturnValue(currentUid + 1);

    try {
      expect(() => resolveMemberExecutionContext("mem_owner", {
        credentialsRoot: root,
        activeMemberIds: ["mem_owner"],
        baseEnv: safeBase
      })).toThrow(/not owned|broker-executor user/i);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("loads only the requested owner's secure file, strips global credentials, and isolates caches", () => {
    const root = tempRoot();
    writeCredentials(root, "mem_owner", [
      "LONGBRIDGE_APP_KEY=owner-key",
      "LONGBRIDGE_APP_SECRET=owner-secret",
      "LONGBRIDGE_ACCESS_TOKEN=owner-token",
      "LONGBRIDGE_ACCOUNT_MODE=paper"
    ].join("\n"));
    writeCredentials(root, "mem_other", [
      "LONGBRIDGE_ACCESS_TOKEN=other-token",
      "LONGBRIDGE_ACCOUNT_MODE=paper"
    ].join("\n"));

    const resolved = resolveMemberExecutionContext("mem_owner", {
      credentialsRoot: root,
      activeMemberIds: ["mem_owner", "mem_other"],
      baseEnv: {
        ...safeBase,
        LONGPORT_ACCESS_TOKEN: "also-global",
        LONGBRIDGE_OPENAPI_TOKEN_PATH: "/tmp/global-token-file"
      }
    });

    expect(resolved.mode).toBe("member");
    expect(resolved.env.LONGBRIDGE_ACCESS_TOKEN).toBe("owner-token");
    expect(resolved.env.LONGPORT_ACCESS_TOKEN).toBeUndefined();
    expect(resolved.env.LONGBRIDGE_OPENAPI_TOKEN_PATH).toBeUndefined();
    expect(resolved.env.HOME).toBe(join(root, "mem_owner", ".longbridge-home"));
    expect(resolved.env.LONGBRIDGE_RATE_LIMIT_DIR).toBe(join(root, "mem_owner", "rate-limit"));
  });

  it("fails closed when member-credential mode exists but this owner has no file", () => {
    const root = tempRoot();
    writeCredentials(root, "mem_other", "LONGBRIDGE_ACCESS_TOKEN=other\nLONGBRIDGE_ACCOUNT_MODE=paper\n");

    expect(() => resolveMemberExecutionContext("mem_owner", {
      credentialsRoot: root,
      activeMemberIds: ["mem_owner", "mem_other"],
      baseEnv: safeBase
    })).toThrow(/mem_owner.*credentials|credentials.*mem_owner/i);
  });

  it("rejects path traversal, symlinks, broad permissions, and live-account member files", () => {
    const root = tempRoot();
    expect(() => resolveMemberExecutionContext("../mem_owner", {
      credentialsRoot: root,
      activeMemberIds: ["../mem_owner"],
      baseEnv: safeBase
    })).toThrow(/member id/i);

    const target = writeCredentials(root, "mem_target", "LONGBRIDGE_ACCESS_TOKEN=target\nLONGBRIDGE_ACCOUNT_MODE=paper\n");
    const symlinkDir = join(root, "mem_symlink");
    mkdirSync(symlinkDir, { mode: 0o700 });
    symlinkSync(target, join(symlinkDir, "longbridge.env"));
    expect(() => resolveMemberExecutionContext("mem_symlink", {
      credentialsRoot: root,
      activeMemberIds: ["mem_symlink"],
      baseEnv: safeBase
    })).toThrow(/regular file|symlink/i);

    writeCredentials(root, "mem_open", "LONGBRIDGE_ACCESS_TOKEN=open\nLONGBRIDGE_ACCOUNT_MODE=paper\n", 0o644);
    expect(() => resolveMemberExecutionContext("mem_open", {
      credentialsRoot: root,
      activeMemberIds: ["mem_open"],
      baseEnv: safeBase
    })).toThrow(/permission|0600/i);

    writeCredentials(root, "mem_live", "LONGBRIDGE_ACCESS_TOKEN=live\nLONGBRIDGE_ACCOUNT_MODE=live\n");
    expect(() => resolveMemberExecutionContext("mem_live", {
      credentialsRoot: root,
      activeMemberIds: ["mem_live"],
      baseEnv: safeBase
    })).toThrow(/paper/i);
  });
});
