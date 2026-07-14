import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const REPORT_FONT_STACK = "'PingFang SC', 'Noto Sans CJK SC', 'Microsoft YaHei', 'Hiragino Sans GB', 'Heiti SC', -apple-system, BlinkMacSystemFont, sans-serif";

export async function writeMarkdownPdf({ repoRoot, runtimeDir, markdownPath, pdfPath, markdown }) {
  const htmlPath = join(runtimeDir, "report-html", `${basename(markdownPath, ".md")}.html`);
  mkdirSync(join(runtimeDir, "report-html"), { recursive: true });
  writeFileSync(htmlPath, renderReportHtml(markdown), "utf8");

  // Task H7 (2026-07-14 legacy audit): runChromePdf's readiness poll only
  // checks "file exists, is non-empty, and its size is unchanged across N
  // checks" - a PRE-EXISTING pdfPath from a previous run (same-day re-issue,
  // agent-driven re-issue, --force backfill) satisfies that within ~1-2
  // poll intervals regardless of whether THIS Chrome invocation ever
  // renders anything, so a silent Chrome failure would deliver the
  // PREVIOUS run's PDF as today's. Deleting the stale target before
  // rendering removes the ambiguity at the source - there is no file to be
  // mistaken for "done" until Chrome actually writes one. Combined with the
  // mtime gate inside runChromePdf below (belt-and-suspenders against any
  // remaining race).
  try {
    rmSync(pdfPath, { force: true });
  } catch {
    // Best-effort - if this somehow fails, the mtime gate below still
    // prevents a stale file from being mistaken for this run's output.
  }

  const chromePath = resolveChromePath();
  const profileDir = mkdtempSync(join(tmpdir(), "openclaw-report-chrome-"));
  try {
    await runChromePdf({
      chromePath,
      args: buildChromePdfArgs({ htmlPath, pdfPath, profileDir }),
      repoRoot,
      pdfPath
    });
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }

  if (!existsSync(pdfPath)) {
    throw new Error(`PDF 生成失败：${pdfPath}`);
  }

  return pdfPath;
}

export async function runChromePdf({ chromePath, args, repoRoot, pdfPath }) {
  const timeoutMs = Number(process.env.REPORT_PDF_TIMEOUT_MS ?? 120_000);
  const pollMs = Number(process.env.REPORT_PDF_POLL_MS ?? 1000);
  const requiredStableChecks = Math.max(1, Number(process.env.REPORT_PDF_STABLE_CHECKS ?? 2));
  const startedAt = Date.now();
  const child = spawn(chromePath, args, {
    ...buildChromePdfSpawnOptions(repoRoot)
  });
  let stderr = "";
  let exit = null;
  child.stderr?.on("data", (chunk) => {
    stderr += Buffer.from(chunk).toString("utf8");
    stderr = stderr.slice(-4000);
  });
  child.on("error", (error) => {
    exit = { error };
  });
  child.on("exit", (code, signal) => {
    exit = { code, signal };
  });

  // Task H7: belt-and-suspenders against writeMarkdownPdf's unlink above -
  // a PDF whose mtime predates this run's start can never count as "ready"
  // even if somehow still present (e.g. the unlink failed, or a future
  // caller invokes runChromePdf directly without going through
  // writeMarkdownPdf). `minMtimeMs` is optional so existing callers/tests
  // that construct fileState objects by hand (no mtimeMs) keep working
  // unchanged.
  const minMtimeMs = startedAt - 1000;
  let stability;
  while (!exit) {
    stability = updatePdfStabilityState(stability, readPdfFileState(pdfPath), { requiredStableChecks, minMtimeMs });
    if (stability.ready) {
      terminateChromeProcessGroup(child, "SIGTERM");
      await waitForChromeExit(child, 2500);
      terminateChromeProcessGroup(child, "SIGKILL");
      return;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      terminateChromeProcessGroup(child, "SIGTERM");
      await waitForChromeExit(child, 2500);
      terminateChromeProcessGroup(child, "SIGKILL");
      const error = new Error(`Chrome PDF rendering timed out after ${timeoutMs} ms.`);
      error.code = "ETIMEDOUT";
      if (isUsablePdfAfterChromeError(error, pdfPath)) {
        return;
      }
      throw error;
    }
    await sleep(Math.max(100, pollMs));
  }

  if (exit.error) {
    throw exit.error;
  }
  if (exit.code !== 0 && !existsSync(pdfPath)) {
    throw new Error(`Chrome PDF rendering failed with code ${exit.code ?? "null"} signal ${exit.signal ?? "null"}: ${stderr.trim()}`);
  }
}

export function buildChromePdfSpawnOptions(repoRoot) {
  return {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "pipe"],
    detached: true
  };
}

export function updatePdfStabilityState(previous, fileState, options = {}) {
  const requiredStableChecks = Math.max(1, Number(options.requiredStableChecks ?? 2));
  // Task H7 (2026-07-14 legacy audit): when set, a file whose mtime is
  // OLDER than minMtimeMs is treated as if it doesn't exist for readiness
  // purposes - it's a stale artifact from a previous run, not this run's
  // output, no matter how "stable" its size looks. `minMtimeMs` is
  // optional and defaults to "no gate" so existing callers (this file's
  // own tests) that never pass mtimeMs/minMtimeMs are unaffected.
  const hasMinMtime = Number.isFinite(options.minMtimeMs);
  const mtimeMs = Number(fileState?.mtimeMs ?? 0);
  const isStale = hasMinMtime && Boolean(fileState?.exists) && mtimeMs < options.minMtimeMs;
  const exists = Boolean(fileState?.exists) && !isStale;
  const size = exists ? Number(fileState?.size ?? 0) : 0;
  const lastSize = Number(previous?.size ?? -1);
  const stableChecks = exists && size > 0 && size === lastSize
    ? Number(previous?.stableChecks ?? 0) + 1
    : exists && size > 0 ? 1 : 0;
  return {
    exists,
    size,
    stableChecks,
    ready: stableChecks >= requiredStableChecks
  };
}

function readPdfFileState(pdfPath) {
  try {
    const stats = statSync(pdfPath);
    return {
      exists: true,
      size: stats.size,
      mtimeMs: stats.mtimeMs
    };
  } catch {
    return {
      exists: false,
      size: 0,
      mtimeMs: 0
    };
  }
}

function waitForChromeExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function terminateChromeProcessGroup(child, signal) {
  if (!child?.pid) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
  }
}

export function buildChromePdfExecOptions(repoRoot) {
  return {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "pipe"],
    timeout: Number(process.env.REPORT_PDF_TIMEOUT_MS ?? 120_000),
    killSignal: "SIGTERM"
  };
}

export function buildChromePdfArgs({ htmlPath, pdfPath, profileDir }) {
  return [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-extensions",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-pdf-header-footer",
    `--user-data-dir=${profileDir}`,
    `--print-to-pdf=${pdfPath}`,
    `file://${htmlPath}`
  ];
}

export function isUsablePdfAfterChromeError(error, pdfPath) {
  if (String(error?.code ?? "") !== "ETIMEDOUT") {
    return false;
  }
  try {
    return statSync(pdfPath).size > 0;
  } catch {
    return false;
  }
}

function resolveChromePath() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  ].filter(Boolean);

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error("未找到可用于生成 PDF 的 Chrome/Chromium。请安装 Google Chrome 或设置 CHROME_BIN。");
  }
  return found;
}

export function renderReportHtml(markdown) {
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<style>",
    "@page { size: A4; margin: 18mm 16mm; }",
    `body { font-family: ${REPORT_FONT_STACK}; color: #111827; font-size: 13px; line-height: 1.58; }`,
    "h1 { font-size: 24px; margin: 0 0 14px; padding-bottom: 10px; border-bottom: 2px solid #111827; }",
    "h2 { font-size: 18px; margin: 22px 0 10px; padding-bottom: 4px; border-bottom: 1px solid #d1d5db; }",
    "h3 { font-size: 15px; margin: 16px 0 8px; }",
    "p { margin: 7px 0; }",
    "ul { margin: 7px 0 10px 20px; padding: 0; }",
    "li { margin: 4px 0; }",
    "table { border-collapse: collapse; width: 100%; margin: 10px 0 14px; }",
    "th, td { border: 1px solid #d1d5db; padding: 5px 7px; text-align: left; vertical-align: top; }",
    "th { background: #f3f4f6; }",
    "code { font-family: SFMono-Regular, Menlo, monospace; background: #f3f4f6; padding: 1px 3px; border-radius: 3px; }",
    "</style>",
    "</head>",
    "<body>",
    markdownToHtml(markdown),
    "</body>",
    "</html>"
  ].join("\n");
}

function markdownToHtml(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let inList = false;
  let inTable = false;
  const closeList = () => {
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
  };
  const closeTable = () => {
    if (inTable) {
      html.push("</tbody></table>");
      inTable = false;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      closeList();
      closeTable();
      continue;
    }

    const tableCells = parseTableLine(line);
    if (tableCells) {
      closeList();
      if (!inTable) {
        html.push("<table><tbody>");
        inTable = true;
      }
      if (tableCells.every((cell) => /^:?-{3,}:?$/u.test(cell))) {
        continue;
      }
      const tag = html.at(-1) === "<table><tbody>" ? "th" : "td";
      html.push(`<tr>${tableCells.map((cell) => `<${tag}>${formatInlineHtml(cell)}</${tag}>`).join("")}</tr>`);
      continue;
    }

    closeTable();
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(3, heading[1].length);
      html.push(`<h${level}>${formatInlineHtml(heading[2])}</h${level}>`);
      continue;
    }

    const bullet = /^-\s+(.+)$/u.exec(line);
    if (bullet) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${formatInlineHtml(bullet[1])}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${formatInlineHtml(line)}</p>`);
  }

  closeList();
  closeTable();
  return html.join("\n");
}

function parseTableLine(line) {
  if (!line.startsWith("|") || !line.endsWith("|")) {
    return null;
  }
  return line.slice(1, -1).split("|").map((cell) => cell.trim());
}

function formatInlineHtml(value) {
  return escapeHtml(value)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gu, "<a href=\"$2\">$1</a>")
    .replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
    .replace(/`([^`]+)`/gu, "<code>$1</code>");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}
