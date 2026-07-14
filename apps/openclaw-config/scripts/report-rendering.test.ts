import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const rendering = await import("./report-rendering.mjs");

describe("report rendering", () => {
  it("uses one Chinese sans-serif typography stack for all report PDFs", () => {
    const html = rendering.renderReportHtml("# OpenClaw 日报\n\n- 中文报告");

    expect(html).toContain("PingFang SC");
    expect(html).toContain("Noto Sans CJK SC");
    expect(html).not.toContain("Songti SC");
  });

  it("renders markdown links as readable anchors instead of long raw URLs", () => {
    const html = rendering.renderReportHtml("- 链接：[原文](https://example.com/news?id=123)");

    expect(html).toContain("<a href=\"https://example.com/news?id=123\">原文</a>");
    expect(html).not.toContain("[原文](");
  });

  it("limits Chrome PDF rendering time so scheduled jobs cannot hang forever", () => {
    expect(rendering.buildChromePdfExecOptions("/repo")).toEqual({
      cwd: "/repo",
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 120_000,
      killSignal: "SIGTERM"
    });
  });

  it("runs Chrome with an isolated profile and deterministic headless flags for launchd jobs", () => {
    const args = rendering.buildChromePdfArgs({
      htmlPath: "/tmp/report.html",
      pdfPath: "/tmp/report.pdf",
      profileDir: "/tmp/openclaw-chrome-profile"
    });

    expect(args).toContain("--headless=new");
    expect(args).toContain("--disable-background-networking");
    expect(args).toContain("--disable-extensions");
    expect(args).toContain("--disable-dev-shm-usage");
    expect(args).toContain("--user-data-dir=/tmp/openclaw-chrome-profile");
    expect(args).toContain("--print-to-pdf=/tmp/report.pdf");
    expect(args).toContain("file:///tmp/report.html");
  });

  it("starts Chrome in a detached process group so helper processes can be stopped", () => {
    expect(rendering.buildChromePdfSpawnOptions("/repo")).toEqual({
      cwd: "/repo",
      stdio: ["ignore", "ignore", "pipe"],
      detached: true
    });
  });

  it("accepts a Chrome timeout when the PDF was already written", () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-rendering-test-"));
    try {
      const pdfPath = join(dir, "report.pdf");
      writeFileSync(pdfPath, "%PDF-1.7\nbody\n", "utf8");

      expect(rendering.isUsablePdfAfterChromeError({ code: "ETIMEDOUT" }, pdfPath)).toBe(true);
      expect(rendering.isUsablePdfAfterChromeError({ code: "EACCES" }, pdfPath)).toBe(false);
      expect(rendering.isUsablePdfAfterChromeError({ code: "ETIMEDOUT" }, join(dir, "missing.pdf"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects a stable non-empty PDF so Chrome can be stopped early", () => {
    let state = rendering.updatePdfStabilityState(undefined, { exists: true, size: 1200 }, { requiredStableChecks: 2 });
    expect(state.ready).toBe(false);
    expect(state.stableChecks).toBe(1);

    state = rendering.updatePdfStabilityState(state, { exists: true, size: 1200 }, { requiredStableChecks: 2 });
    expect(state.ready).toBe(true);
    expect(state.stableChecks).toBe(2);

    state = rendering.updatePdfStabilityState(state, { exists: true, size: 1300 }, { requiredStableChecks: 2 });
    expect(state.ready).toBe(false);
    expect(state.stableChecks).toBe(1);
  });

  // Task H7 (2026-07-14 legacy audit): runChromePdf used to treat a
  // PRE-EXISTING pdfPath as "render finished" - a stable, non-empty, but
  // STALE file from a previous run satisfied the readiness check within a
  // couple of poll intervals regardless of whether Chrome ever rendered
  // anything this run, silently delivering yesterday's PDF as today's.
  it("never treats a stale pre-existing PDF (older than minMtimeMs) as ready, no matter how stable its size looks", () => {
    let state = rendering.updatePdfStabilityState(
      undefined,
      { exists: true, size: 1200, mtimeMs: 1_000 },
      { requiredStableChecks: 2, minMtimeMs: 5_000 }
    );
    expect(state.ready).toBe(false);
    expect(state.exists).toBe(false);

    state = rendering.updatePdfStabilityState(
      state,
      { exists: true, size: 1200, mtimeMs: 1_000 },
      { requiredStableChecks: 2, minMtimeMs: 5_000 }
    );
    expect(state.ready).toBe(false);
    expect(state.stableChecks).toBe(0);
  });

  it("treats a freshly (re)written file (mtime >= minMtimeMs) as a normal stability candidate", () => {
    let state = rendering.updatePdfStabilityState(
      undefined,
      { exists: true, size: 1200, mtimeMs: 9_000 },
      { requiredStableChecks: 2, minMtimeMs: 5_000 }
    );
    expect(state.stableChecks).toBe(1);

    state = rendering.updatePdfStabilityState(
      state,
      { exists: true, size: 1200, mtimeMs: 9_000 },
      { requiredStableChecks: 2, minMtimeMs: 5_000 }
    );
    expect(state.ready).toBe(true);
  });

  it("writeMarkdownPdf ignores a stale pre-existing PDF and waits for the real render instead of returning the old content (live repro of the H7 bug)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-rendering-stale-pdf-"));
    try {
      const runtimeDir = join(dir, "runtime");
      const reportsDir = join(dir, "reports");
      const markdownPath = join(reportsDir, "2026-07-14.md");
      const pdfPath = join(reportsDir, "2026-07-14.pdf");
      const fakeChromePath = join(dir, "fake-chrome.sh");

      mkdirSync(reportsDir, { recursive: true });
      writeFileSync(markdownPath, "# stale pdf repro\n", "utf8");
      // Seed a STALE pre-existing PDF at the target path, backdated well
      // before this run - exactly the "same-day re-issue" / "--force
      // backfill" scenario the audit named.
      writeFileSync(pdfPath, "OLD-PDF-FROM-PREVIOUS-RUN", "utf8");
      const past = new Date(Date.now() - 60_000);
      utimesSync(pdfPath, past, past);

      writeFileSync(
        fakeChromePath,
        `#!/bin/bash
for arg in "$@"; do
  case $arg in
    --print-to-pdf=*)
      PDF="\${arg#--print-to-pdf=}"
      ;;
  esac
done
sleep 0.3
printf 'NEW-PDF-FROM-THIS-RUN' > "$PDF"
`,
        "utf8"
      );
      chmodSync(fakeChromePath, 0o755);

      const previousEnv = {
        CHROME_BIN: process.env.CHROME_BIN,
        REPORT_PDF_POLL_MS: process.env.REPORT_PDF_POLL_MS,
        REPORT_PDF_STABLE_CHECKS: process.env.REPORT_PDF_STABLE_CHECKS,
        REPORT_PDF_TIMEOUT_MS: process.env.REPORT_PDF_TIMEOUT_MS
      };
      process.env.CHROME_BIN = fakeChromePath;
      process.env.REPORT_PDF_POLL_MS = "50";
      process.env.REPORT_PDF_STABLE_CHECKS = "2";
      process.env.REPORT_PDF_TIMEOUT_MS = "5000";

      try {
        await rendering.writeMarkdownPdf({
          repoRoot: dir,
          runtimeDir,
          markdownPath,
          pdfPath,
          markdown: "# stale pdf repro\n"
        });
      } finally {
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }

      expect(readFileSync(pdfPath, "utf8")).toBe("NEW-PDF-FROM-THIS-RUN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
