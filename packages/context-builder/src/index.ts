import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  PreferenceRepository,
  RuleRegistry,
  loadLocalEnv,
  openTradingDatabase,
  resolveRepoRoot,
  resolveRuntimePaths
} from "@packages/shared-types";

import { HonchoClient } from "./honcho.js";

export interface BuildContextInput {
  repoRoot?: string;
  scope: "control" | "live" | "paper" | "evolution";
  query: string;
  includeHoncho?: boolean;
}

export interface BuiltContext {
  scope: BuildContextInput["scope"];
  prompt: string;
  sections: Record<string, string>;
}

export async function buildAgentContext(input: BuildContextInput): Promise<BuiltContext> {
  const repoRoot = resolveRepoRoot(input.repoRoot ?? process.cwd());
  loadLocalEnv(repoRoot);
  const { dbPath } = resolveRuntimePaths(repoRoot);
  const db = openTradingDatabase(dbPath);
  const preferences = new PreferenceRepository(db).latest();
  const rules = new RuleRegistry(repoRoot);

  const sections: Record<string, string> = {
    constitution: readText(join(repoRoot, "AGENTS.md")),
    memory: readText(join(repoRoot, "knowledge", "memory", "MEMORY.md")),
    notes: readPrivateNotes(join(repoRoot, "knowledge", "notes", "private-repo")),
    preferences: preferences
      ? [
          `Summary: ${preferences.summary}`,
          `Traits: ${preferences.traits.join(", ")}`
        ].join("\n")
      : "No preference snapshot stored yet."
  };

  if (input.scope === "live" || input.scope === "paper") {
    const ruleScope = input.scope === "live" ? "live" : "paper";
    sections.activeRules = JSON.stringify(rules.load(ruleScope), null, 2);
  }

  if (input.includeHoncho && process.env.HONCHO_ENDPOINT) {
    const honcho = new HonchoClient({
      endpoint: process.env.HONCHO_ENDPOINT,
      ...(process.env.HONCHO_API_KEY ? { apiKey: process.env.HONCHO_API_KEY } : {}),
      namespace: process.env.HONCHO_NAMESPACE ?? "trading-user"
    });

    try {
      const memories = await honcho.search(input.query);
      sections.honcho = memories
        .map((memory, index) => {
          return `Memory ${index + 1}\nCategory: ${memory.category}\nTags: ${memory.tags.join(", ")}\n${memory.content}`;
        })
        .join("\n\n");
    } catch (error) {
      sections.honcho = `Honcho unavailable: ${(error as Error).message}`;
    }
  }

  const prompt = Object.entries(sections)
    .map(([name, value]) => `## ${name}\n${value}`)
    .join("\n\n");

  return {
    scope: input.scope,
    prompt,
    sections
  };
}

function readText(filePath: string): string {
  if (!existsSync(filePath)) {
    return `Missing file: ${filePath}`;
  }

  return readFileSync(filePath, "utf8").trim();
}

function readPrivateNotes(notesRoot: string): string {
  if (!existsSync(notesRoot)) {
    return "No private notes repository synced yet.";
  }

  const files = collectMarkdownFiles(notesRoot).sort((left, right) => left.localeCompare(right));
  if (files.length === 0) {
    return "Private notes repository is present but contains no markdown notes.";
  }

  return files
    .map((filePath) => {
      const relativePath = filePath.slice(notesRoot.length + 1);
      return `### ${relativePath}\n${readFileSync(filePath, "utf8").trim()}`;
    })
    .join("\n\n");
}

function collectMarkdownFiles(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (entry.name === ".git") {
      continue;
    }

    if (entry.isDirectory()) {
      results.push(...collectMarkdownFiles(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".md") && statSync(entryPath).size > 0) {
      results.push(entryPath);
    }
  }

  return results;
}
