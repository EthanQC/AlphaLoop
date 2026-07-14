/**
 * Markdown -> platform-app HTML renderer for the report reading pages
 * (Task 4). This is NOT a general-purpose markdown engine - it supports
 * exactly the subset the existing `reports/**\/*.md` files use (headings,
 * paragraphs, ul/ol lists, `|`-tables, bold/italic/inline code, fenced code
 * blocks, links), and nothing more.
 *
 * SECURITY (plan Global Constraints: "markdown->HTML 全程严格转义...禁止 raw
 * HTML 直通"): every character of source text that isn't part of a markdown
 * construct this renderer explicitly understands goes through
 * `escapeHtml`/the `html` tagged template from Task 3's render/html.ts. Raw
 * HTML embedded in a report (e.g. a stray `<script>`) is never parsed as
 * markup - it is just text, and gets escaped like any other text. Links are
 * only ever turned into `<a>` elements when their URL starts with `http://`
 * or `https://`; anything else (`javascript:`, bare `//host`, etc.) is
 * rendered as plain text with the URL dropped entirely.
 */
import { escapeHtml, html, joinHtml, trustedHtml, type Html } from "../render/html.js";

export interface MarkdownTocEntry {
  id: string;
  text: string;
  level: number;
}

export interface MarkdownSourceLink {
  text: string;
  url: string;
}

export interface MarkdownRenderResult {
  html: Html;
  toc: MarkdownTocEntry[];
  sources: MarkdownSourceLink[];
}

const HEADING_RE = /^(#{1,3})\s+(.+)$/u;
const ORDERED_ITEM_RE = /^(\d+)[.)]\s+(.+)$/u;
const BULLET_ITEM_RE = /^[-*]\s+(.+)$/u;
const FENCE_RE = /^```/u;
const HTTP_LINK_RE = /^https?:\/\//iu;
const TABLE_SEPARATOR_RE = /^:?-{2,}:?$/u;

// Placeholder markers used while building an inline-formatted string.
// `` (a Unicode Private Use Area codepoint) is the delimiter
// deliberately, NOT whitespace or a control byte: report text routinely
// contains space-padded numbers (e.g. "已遵守 23 天", "0 条偏利空") that would
// false-positive-match a whitespace-delimited token pattern and silently
// vanish (no token registered at that index -> substituted with ""), and a
// raw NUL byte is risky to carry through text pipelines. A PUA codepoint
// cannot appear in real markdown report text and round-trips as ordinary
// text everywhere. escapeHtml only touches `& < > " '`, so these markers
// survive the final escaping pass untouched and get swapped back for their
// real (already-safe) HTML afterwards.
const TOKEN_MARKER = "";
const TOKEN_RE = /(\d+)/gu;

function tokenize(tokens: Html[], value: Html): string {
  const index = tokens.length;
  tokens.push(value);
  return `${TOKEN_MARKER}${index}${TOKEN_MARKER}`;
}

/**
 * Renders one line of inline markdown (bold/italic/inline code/links) as
 * `Html`, escaping everything else. Every http(s) link found is also
 * appended to `sources` (shared across the whole document) so the reading
 * page can render a "来源清单" of every link the report cites.
 */
function renderInline(raw: string, sources: MarkdownSourceLink[]): Html {
  const tokens: Html[] = [];
  let working = raw;

  // Inline code first (highest precedence - its contents must not be
  // reinterpreted as a link/bold/italic marker).
  working = working.replace(/`([^`]+)`/gu, (_match, code: string) =>
    tokenize(tokens, html`<code>${code}</code>`)
  );

  // Links: [text](url). Only http(s) URLs become real anchors; anything
  // else renders as the link's visible text with the URL discarded.
  working = working.replace(/\[([^\]]+)\]\(([^)\s]+)\)/gu, (_match, text: string, url: string) => {
    if (HTTP_LINK_RE.test(url)) {
      sources.push({ text, url });
      return tokenize(
        tokens,
        html`<a href="${url}" rel="noreferrer" target="_blank">${text}</a>`
      );
    }
    return tokenize(tokens, html`${text}`);
  });

  // Bold, then italic (bold's ** already consumed, so a leftover single `*`
  // pair is unambiguous).
  working = working.replace(/\*\*([^*]+)\*\*/gu, (_match, inner: string) =>
    tokenize(tokens, html`<strong>${inner}</strong>`)
  );
  working = working.replace(/\*([^*]+)\*/gu, (_match, inner: string) =>
    tokenize(tokens, html`<em>${inner}</em>`)
  );

  // Everything that's left is plain text, including any raw HTML the source
  // happened to contain (e.g. `<script>`) - escape it like any other text,
  // then splice the already-safe tokenized fragments back in.
  const escaped = escapeHtml(working);
  const restored = escaped.replace(TOKEN_RE, (_match, idx: string) => {
    const token = tokens[Number(idx)];
    return token ? token.__html : "";
  });
  return trustedHtml(restored);
}

/**
 * Slugifies heading text for use as an `id` attribute: keeps Han (Chinese)
 * characters and ASCII alphanumerics, collapses everything else (markdown
 * punctuation, whitespace, symbols) to `-`. Only ever emits
 * `[\p{Han}a-z0-9-]`, so the result is always attribute-safe by construction
 * regardless of what the heading text contains. `seen` disambiguates
 * duplicate headings within one document (`foo`, `foo-2`, `foo-3`, ...).
 */
function slugifyHeading(text: string, seen: Map<string, number>): string {
  const base =
    text
      .trim()
      .toLowerCase()
      .replace(/[^\p{Script=Han}a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "section";

  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

function parseTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return null;
  }
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function renderList(tag: "ul" | "ol", items: readonly Html[]): Html {
  const inner = joinHtml(items);
  return tag === "ul" ? html`<ul>${inner}</ul>` : html`<ol>${inner}</ol>`;
}

export function renderMarkdown(md: string): MarkdownRenderResult {
  const toc: MarkdownTocEntry[] = [];
  const sources: MarkdownSourceLink[] = [];
  const slugSeen = new Map<string, number>();
  const blocks: Html[] = [];

  let listTag: "ul" | "ol" | null = null;
  let listItems: Html[] = [];
  let tableRows: Html[] | null = null;
  let inCodeBlock = false;
  let codeLines: string[] = [];

  const closeList = (): void => {
    if (listTag && listItems.length > 0) {
      blocks.push(renderList(listTag, listItems));
    }
    listTag = null;
    listItems = [];
  };

  const closeTable = (): void => {
    if (tableRows) {
      blocks.push(html`<table><tbody>${joinHtml(tableRows)}</tbody></table>`);
    }
    tableRows = null;
  };

  const lines = md.replace(/\r\n/gu, "\n").split("\n");

  for (const rawLine of lines) {
    if (inCodeBlock) {
      if (FENCE_RE.test(rawLine.trim())) {
        inCodeBlock = false;
        blocks.push(html`<pre><code>${codeLines.join("\n")}</code></pre>`);
        codeLines = [];
      } else {
        codeLines.push(rawLine);
      }
      continue;
    }

    const line = rawLine.trimEnd();

    if (FENCE_RE.test(line.trim())) {
      closeList();
      closeTable();
      inCodeBlock = true;
      codeLines = [];
      continue;
    }

    if (!line.trim()) {
      closeList();
      closeTable();
      continue;
    }

    const tableCells = parseTableRow(line);
    if (tableCells) {
      closeList();
      if (tableCells.every((cell) => TABLE_SEPARATOR_RE.test(cell))) {
        continue; // `| --- | --- |` divider row - not real content.
      }
      const isHeaderRow = tableRows === null;
      if (isHeaderRow) {
        tableRows = [];
      }
      const cellTag = isHeaderRow ? "th" : "td";
      const cellsHtml = joinHtml(
        tableCells.map((cell) =>
          cellTag === "th"
            ? html`<th>${renderInline(cell, sources)}</th>`
            : html`<td>${renderInline(cell, sources)}</td>`
        )
      );
      tableRows!.push(html`<tr>${cellsHtml}</tr>`);
      continue;
    }
    closeTable();

    const heading = HEADING_RE.exec(line);
    if (heading) {
      closeList();
      const level = (heading[1] ?? "").length;
      const text = (heading[2] ?? "").trim();
      const displayHtml = renderInline(text, sources);
      if (level === 2) {
        const id = slugifyHeading(text, slugSeen);
        toc.push({ id, text, level });
        blocks.push(html`<h2 id="${id}">${displayHtml}</h2>`);
      } else if (level === 1) {
        blocks.push(html`<h1>${displayHtml}</h1>`);
      } else {
        blocks.push(html`<h3>${displayHtml}</h3>`);
      }
      continue;
    }

    const ordered = ORDERED_ITEM_RE.exec(line);
    const bullet = ordered ? null : BULLET_ITEM_RE.exec(line);
    if (ordered || bullet) {
      const tag: "ul" | "ol" = ordered ? "ol" : "ul";
      const content = (ordered ? ordered[2] : (bullet as RegExpExecArray)[1]) ?? "";
      if (listTag && listTag !== tag) {
        closeList();
      }
      listTag = tag;
      listItems.push(html`<li>${renderInline(content, sources)}</li>`);
      continue;
    }
    closeList();

    blocks.push(html`<p>${renderInline(line, sources)}</p>`);
  }

  closeList();
  closeTable();
  if (inCodeBlock && codeLines.length > 0) {
    // Unterminated fence at EOF - flush what was collected instead of
    // silently dropping it. Drop a single trailing empty line first: it's
    // an artifact of the source file's own trailing newline (a properly
    // *closed* fence never has this, since the closing ``` line is
    // consumed by the fence check, not pushed to codeLines), so trim it
    // here for the same visual result either way.
    if (codeLines[codeLines.length - 1] === "") {
      codeLines = codeLines.slice(0, -1);
    }
    if (codeLines.length > 0) {
      blocks.push(html`<pre><code>${codeLines.join("\n")}</code></pre>`);
    }
  }

  return { html: joinHtml(blocks), toc, sources };
}
