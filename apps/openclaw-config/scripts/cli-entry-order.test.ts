// 2026-07-26 regression guard: `node scheduled-report.mjs daily run` died with
//
//   ReferenceError: Cannot access 'CHANNEL_LABELS' before initialization
//     at deriveChannelLabel (scheduled-report.mjs:1056)
//     ... at prepareReport (scheduled-report.mjs:113)
//     at process.processTicksAndRejections
//
// on every run that clustered at least one news event, which made the daily
// report impossible to generate. It was NOT a circular import (see the second
// describe block below, which pins that). The cause was purely source order:
// scheduled-report.mjs's `if (isMainModule) { ... await prepareReport(...) }`
// dispatch sat near the TOP of the file. A top-level `await` SUSPENDS module
// evaluation, so the whole report pipeline ran while every top-level binding
// declared further down the file was still in its temporal dead zone.
// `function` declarations are hoisted, so the entire call chain resolved -
// but `const CHANNEL_LABELS`, declared ~980 lines below the dispatch, had not
// been initialized yet.
//
// Importing the module never reproduced it: for an importer `isMainModule` is
// false, the guard body is skipped, evaluation runs to completion, and the
// const ends up initialized. Only the real CLI path could hit it, which is
// why the existing import-based render tests stayed green throughout.
//
// The invariant below is what makes the hazard structurally impossible rather
// than order-dependent: in a module that hands control to its OWN hoisted
// functions via a top-level `await`, that await must come after every
// top-level lexical (`const`/`let`/`class`) declaration - i.e. the CLI entry
// point belongs at the bottom of the file. Awaiting an IMPORTED function is
// not flagged: it cannot reach this module's bindings, so straight-line
// scripts like longbridge-account-snapshot.mjs stay legal.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const cliScriptDirs = [scriptsDir, resolve(scriptsDir, "../../longbridge-cli/scripts")];

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
}

function listScripts(): string[] {
  return cliScriptDirs
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => name.endsWith(".mjs"))
        .sort()
        .map((name) => join(dir, name))
    );
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/**
 * The first top-level `await` that calls a function DECLARED IN THIS MODULE -
 * the only shape that can re-enter the half-evaluated module body and observe
 * a not-yet-initialized top-level binding. Descent stops at function bodies:
 * an `await` inside a function runs at call time, not during evaluation.
 */
function findTopLevelAwaitIntoLocalFunction(
  sourceFile: ts.SourceFile,
  localFunctions: Set<string>
): { statementIndex: number; callee: string; line: number } | null {
  let hit: { statementIndex: number; callee: string; line: number } | null = null;

  sourceFile.statements.forEach((statement, statementIndex) => {
    if (hit || ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      return;
    }
    const visit = (node: ts.Node, awaited: boolean): void => {
      if (hit || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
        return;
      }
      const inAwait = awaited || ts.isAwaitExpression(node);
      if (
        inAwait &&
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        localFunctions.has(node.expression.text)
      ) {
        hit = { statementIndex, callee: node.expression.text, line: lineOf(sourceFile, node) };
        return;
      }
      ts.forEachChild(node, (child) => visit(child, inAwait));
    };
    visit(statement, false);
  });

  return hit;
}

function collectTopLevelLexicalDeclarations(
  sourceFile: ts.SourceFile
): Array<{ statementIndex: number; name: string; line: number }> {
  const found: Array<{ statementIndex: number; name: string; line: number }> = [];
  sourceFile.statements.forEach((statement, statementIndex) => {
    // `var` is deliberately excluded: it is hoisted AND initialized to
    // undefined, so it can never throw a TDZ ReferenceError.
    if (ts.isVariableStatement(statement)) {
      const lexical = statement.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let);
      if (!lexical) {
        return;
      }
      for (const declaration of statement.declarationList.declarations) {
        found.push({ statementIndex, name: declaration.name.getText(sourceFile), line: lineOf(sourceFile, declaration) });
      }
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      found.push({ statementIndex, name: statement.name.text, line: lineOf(sourceFile, statement) });
    }
  });
  return found;
}

describe("CLI entry point ordering (temporal dead zone guard)", () => {
  it("keeps every top-level await into a module-local function after all top-level lexical declarations", () => {
    const violations: string[] = [];

    for (const file of listScripts()) {
      const sourceFile = parse(file);
      const localFunctions = new Set<string>();
      for (const statement of sourceFile.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name) {
          localFunctions.add(statement.name.text);
        }
      }

      const dispatch = findTopLevelAwaitIntoLocalFunction(sourceFile, localFunctions);
      if (!dispatch) {
        continue;
      }

      const stillInTdz = collectTopLevelLexicalDeclarations(sourceFile).filter(
        (declaration) => declaration.statementIndex > dispatch.statementIndex
      );
      if (stillInTdz.length > 0) {
        violations.push(
          `${file.slice(file.lastIndexOf("/") + 1)}: top-level \`await ${dispatch.callee}(...)\` at line ` +
            `${dispatch.line} runs before ${stillInTdz.map((d) => `${d.name} (line ${d.line})`).join(", ")} ` +
            `is initialized - move the CLI dispatch to the bottom of the file`
        );
      }
    }

    expect(violations).toEqual([]);
  });
});

describe("scheduled-report.mjs module graph", () => {
  it("has no module that imports scheduled-report.mjs back", () => {
    // The crash above looked exactly like a circular-import TDZ, so this pins
    // the disproof: nothing in the reachable graph imports the entry back. If
    // someone ever adds such an edge, the top-level-await dispatch would be
    // re-entered mid-evaluation and the same class of bug returns - this time
    // one that moving the dispatch cannot fix.
    const entry = join(scriptsDir, "scheduled-report.mjs");

    const relativeImportsOf = (file: string): string[] => {
      const sourceFile = parse(file);
      const specifiers: string[] = [];
      const visit = (node: ts.Node): void => {
        let specifier: string | null = null;
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          specifier = node.moduleSpecifier.text;
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const [first] = node.arguments;
          if (first && ts.isStringLiteral(first)) {
            specifier = first.text;
          }
        }
        if (specifier?.startsWith(".")) {
          const resolved = resolve(dirname(file), specifier);
          if (existsSync(resolved)) {
            specifiers.push(resolved);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      return specifiers;
    };

    const reachable = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (reachable.has(file)) {
        continue;
      }
      reachable.add(file);
      queue.push(...relativeImportsOf(file));
    }

    const backEdges = [...reachable].filter((file) => file !== entry && relativeImportsOf(file).includes(entry));
    expect(backEdges).toEqual([]);
    expect(reachable.size).toBeGreaterThan(1);
  });
});
