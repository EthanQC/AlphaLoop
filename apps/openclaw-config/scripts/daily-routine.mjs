import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const routinePath = resolve(
  repoRoot,
  "knowledge",
  "notes",
  "stock-trading-notes",
  "daily-routine.md"
);

export function loadDailyRoutineChecklist(filePath = routinePath) {
  const markdown = readFileSync(filePath, "utf8");
  const entries = [];
  let section = "";

  for (const rawLine of markdown.split(/\r?\n/u)) {
    const heading = /^(#{2,3})\s+(.+)$/u.exec(rawLine.trim());
    if (!heading) {
      continue;
    }

    const level = heading[1]?.length ?? 0;
    const title = heading[2]?.trim() ?? "";
    if (level === 2) {
      section = title;
      continue;
    }

    if (level === 3 && (section === "信息检索" || section === "信息分类与处理")) {
      entries.push({ section, title });
    }
  }

  return entries;
}

export function renderDailyRoutineChecklist() {
  const grouped = new Map();
  for (const entry of loadDailyRoutineChecklist()) {
    const rows = grouped.get(entry.section) ?? [];
    rows.push(entry.title);
    grouped.set(entry.section, rows);
  }

  return Array.from(grouped.entries())
    .flatMap(([section, titles]) => [
      `### ${section}`,
      "",
      ...titles.map((title) => `- ${title}`)
    ])
    .join("\n");
}
