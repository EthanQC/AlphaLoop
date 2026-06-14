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
