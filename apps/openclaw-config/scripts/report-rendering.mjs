import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export const REPORT_FONT_STACK = "'PingFang SC', 'Noto Sans CJK SC', 'Microsoft YaHei', 'Hiragino Sans GB', 'Heiti SC', -apple-system, BlinkMacSystemFont, sans-serif";

export function writeMarkdownPdf({ repoRoot, runtimeDir, markdownPath, pdfPath, markdown }) {
  const htmlPath = join(runtimeDir, "report-html", `${basename(markdownPath, ".md")}.html`);
  mkdirSync(join(runtimeDir, "report-html"), { recursive: true });
  writeFileSync(htmlPath, renderReportHtml(markdown), "utf8");

  const chromePath = resolveChromePath();
  const profileDir = mkdtempSync(join(tmpdir(), "openclaw-report-chrome-"));
  try {
    try {
      execFileSync(chromePath, buildChromePdfArgs({ htmlPath, pdfPath, profileDir }), buildChromePdfExecOptions(repoRoot));
    } catch (error) {
      if (!isUsablePdfAfterChromeError(error, pdfPath)) {
        throw error;
      }
    }
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }

  if (!existsSync(pdfPath)) {
    throw new Error(`PDF 生成失败：${pdfPath}`);
  }

  return pdfPath;
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
