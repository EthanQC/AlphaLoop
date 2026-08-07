import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./install-memoryd-runtime.sh", import.meta.url));
const roots: string[] = [];

function temp(prefix: string) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("install-memoryd-runtime", () => {
  it("checks out the pinned revision, performs a frozen sync, and is idempotent", () => {
    const source = temp("alphaloop-memoryd-source-");
    mkdirSync(join(source, "memoryd"), { recursive: true });
    writeFileSync(join(source, "memoryd", "pyproject.toml"), "[project]\nname='memoryd'\nversion='0'\n");
    writeFileSync(join(source, "memoryd", "uv.lock"), "version = 1\n");
    execFileSync("git", ["init", "-q"], { cwd: source });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: source });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: source });
    execFileSync("git", ["add", "."], { cwd: source });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: source });
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();

    const fakeBin = temp("alphaloop-memoryd-bin-");
    const uvLog = join(fakeBin, "uv.log");
    const uv = join(fakeBin, "uv");
    writeFileSync(uv, [
      "#!/bin/sh",
      `printf '%s\\n' \"$*\" >> '${uvLog}'`,
      "mkdir -p .venv/bin",
      "printf '#!/bin/sh\\nexit 0\\n' > .venv/bin/memoryd-mcp",
      "chmod +x .venv/bin/memoryd-mcp"
    ].join("\n"));
    chmodSync(uv, 0o755);

    const home = temp("alphaloop-memoryd-home-");
    const installRoot = join(home, ".local", "share", "alphaloop-memoryd");
    const env = {
      ...process.env,
      TARGET_HOME: home,
      MEMORYD_INSTALL_ROOT: installRoot,
      MEMORYD_SOURCE_URL: source,
      MEMORYD_SOURCE_REV: revision,
      UV_BIN: uv
    };

    execFileSync("zsh", [script], { env });
    execFileSync("zsh", [script], { env });

    const checkout = join(installRoot, "source");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim()).toBe(revision);
    expect(existsSync(join(checkout, "memoryd", ".venv", "bin", "memoryd-mcp"))).toBe(true);
    expect(existsSync(join(home, "Library", "Application Support", "AlphaLoop", "memoryd"))).toBe(true);
    expect(readFileSync(uvLog, "utf8").trim().split("\n")).toEqual([
      "sync --frozen --no-dev",
      "sync --frozen --no-dev"
    ]);
  });
});
