import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const wrapperPath = join(repoRoot, "apps/openclaw-config/scripts/run-feishu-user-plugin.mjs");

describe("run-feishu-user-plugin wrapper", () => {
  it("forwards termination to the underlying feishu-user-plugin process", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-feishu-plugin-"));
    const markerPath = join(tempDir, "marker.log");
    const fakeNpxPath = join(tempDir, "npx");

    writeFileSync(fakeNpxPath, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

appendFileSync(process.env.FAKE_NPX_MARKER, \`started:\${process.pid}\\n\`);
process.on("SIGTERM", () => {
  appendFileSync(process.env.FAKE_NPX_MARKER, "term\\n");
  process.exit(0);
});
setInterval(() => {}, 1000);
`, "utf8");
    chmodSync(fakeNpxPath, 0o755);

    const child = spawn(process.execPath, [wrapperPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        FAKE_NPX_MARKER: markerPath,
        PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}`
      },
      stdio: "ignore"
    });

    try {
      await waitForMarker(markerPath, "started", 2_000);
      child.kill("SIGTERM");
      await waitForExit(child, 3_000);
      await waitForMarker(markerPath, "term", 1_000);
      expect(readFileSync(markerPath, "utf8")).toContain("term");
    } finally {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
      cleanupFakeChild(markerPath);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Task H7 (2026-07-14 legacy audit): `npx -y feishu-user-plugin` (no
  // version) resolves whatever the registry serves as `latest` at every
  // cold start, with every Feishu secret in the spawned process's
  // environment - a broken/compromised publish would run silently under
  // this repo's own credentials. The wrapper must always pass a pinned
  // `feishu-user-plugin@<version>` package spec, never the bare name.
  it("pins feishu-user-plugin to a specific version instead of trusting npx's registry-of-the-day resolution", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-feishu-plugin-pin-"));
    const markerPath = join(tempDir, "argv.log");
    const fakeNpxPath = join(tempDir, "npx");

    writeFileSync(fakeNpxPath, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

writeFileSync(process.env.FAKE_NPX_MARKER, JSON.stringify(process.argv.slice(2)));
process.exit(0);
`, "utf8");
    chmodSync(fakeNpxPath, 0o755);

    const child = spawn(process.execPath, [wrapperPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        FAKE_NPX_MARKER: markerPath,
        PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}`
      },
      stdio: "ignore"
    });

    try {
      await waitForExit(child, 3_000);
      const recordedArgv = JSON.parse(readFileSync(markerPath, "utf8")) as string[];
      expect(recordedArgv[0]).toBe("-y");
      expect(recordedArgv[1]).toMatch(/^feishu-user-plugin@\d+\.\d+\.\d+$/u);
      expect(recordedArgv[1]).not.toBe("feishu-user-plugin");
    } finally {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function waitForMarker(filePath: string, expected: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    const tick = () => {
      try {
        if (readFileSync(filePath, "utf8").includes(expected)) {
          resolvePromise();
          return;
        }
      } catch {
        // The marker is created by the fake npx process.
      }

      if (Date.now() - startedAt > timeoutMs) {
        rejectPromise(new Error(`Timed out waiting for marker ${expected}`));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error("wrapper did not exit"));
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

function cleanupFakeChild(markerPath: string): void {
  try {
    const contents = readFileSync(markerPath, "utf8");
    const pid = Number(contents.match(/started:(\d+)/u)?.[1]);
    if (Number.isFinite(pid) && pid > 0) {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // Best-effort cleanup for the failing-test path.
  }
}
