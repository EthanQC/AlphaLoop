import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - plain .mjs module without type declarations
import { buildShimScript, installShim } from "./install-longbridge-cli.mjs";

let tempHome: string | undefined;

afterEach(() => {
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  }
});

describe("buildShimScript", () => {
  it("execs node against the built dist entry and forwards argv", () => {
    const script = buildShimScript("/repo/AlphaLoop") as string;
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain('exec node "/repo/AlphaLoop/apps/longbridge-cli/dist/index.js" "$@"');
  });
});

describe("installShim", () => {
  it("writes an executable shim at $HOME/.local/bin/longbridge", () => {
    tempHome = mkdtempSync(join(tmpdir(), "longbridge-cli-install-"));
    const shimPath = installShim({ homeDir: tempHome, repoRoot: "/repo/AlphaLoop" }) as string;
    expect(shimPath).toBe(join(tempHome, ".local", "bin", "longbridge"));
    const content = readFileSync(shimPath, "utf8");
    expect(content).toContain("apps/longbridge-cli/dist/index.js");
    const mode = statSync(shimPath).mode & 0o777;
    expect(mode & 0o111).not.toBe(0);
  });
});
