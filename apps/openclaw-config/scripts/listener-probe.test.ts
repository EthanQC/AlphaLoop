import { describe, expect, it, vi } from "vitest";

import { readListeners, resolveLsofBin } from "./listener-probe.mjs";

describe("listener probe", () => {
  it("uses macOS's absolute lsof path when launchd PATH cannot resolve lsof", () => {
    const exists = vi.fn((path: unknown) => path === "/usr/sbin/lsof");

    expect(resolveLsofBin({ env: {}, exists })).toBe("/usr/sbin/lsof");
  });

  it("parses listeners through the resolved absolute binary", () => {
    const exec = vi.fn(() => [
      "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
      "node 91837 qingchang 23u IPv4 0x1 0t0 TCP 127.0.0.1:18789 (LISTEN)",
      ""
    ].join("\n"));

    expect(readListeners("18789", {
      exec,
      exists: (path: unknown) => path === "/usr/sbin/lsof",
      env: {}
    })).toEqual([{ command: "node", pid: 91837, endpoint: "127.0.0.1:18789" }]);
    expect(exec).toHaveBeenCalledWith("/usr/sbin/lsof", ["-nP", "-iTCP:18789", "-sTCP:LISTEN"]);
  });

  it("honors an explicit LSOF_BIN override", () => {
    expect(resolveLsofBin({
      env: { LSOF_BIN: "/custom/lsof" },
      exists: () => false
    })).toBe("/custom/lsof");
  });
});
