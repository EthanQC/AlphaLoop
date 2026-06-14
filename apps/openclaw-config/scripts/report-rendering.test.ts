import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});
