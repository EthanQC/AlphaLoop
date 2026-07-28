#!/usr/bin/env node
/**
 * Static coverage for apps/openclaw-config (defect G3, 2026-07-28).
 *
 * WHY THIS EXISTS
 * ---------------
 * `pnpm typecheck` ran in 4 of the 5 workspace directories; this one had no
 * package.json and no tsconfig, so tsc had never looked at any of its ~74 .mjs
 * scripts. That is exactly where the defect commit 73177f0 fixed lived:
 * reconcile-official-paper-orders.mjs called `reports.save(...)` without an
 * ownerId, every reconciled real fill landed with owner_id NULL, and the
 * member who placed the order never saw it on their own weekly page. 73177f0's
 * message then claimed "a forgotten stamp is a compile error rather than a
 * silent orphan" - true only for broker-executor, the TypeScript writer that
 * never forgot. The .mjs writer that DID forget was still never compiled.
 *
 * WHAT WAS CHOSEN, AND WHY NOT THE OBVIOUS THING
 * ----------------------------------------------
 * Full `checkJs` over the directory is a swamp: measured 2526 errors under the
 * repo's strict base config, and still 148 with `strict:false` +
 * `noImplicitAny:false` - overwhelmingly JS-inference artifacts (`{}` defaults
 * on destructured parameters, string literals widening against literal unions),
 * i.e. noise that would have to be suppressed rather than fixed, in ~74 files
 * this task does not own. A guard drowned in noise gets switched off.
 *
 * So this is narrower and precise: it runs the real TypeScript checker over the
 * .mjs sources and asks ONE question about the boundary that actually matters -
 * the calls these scripts make into the workspace's compiled, typed packages
 * (packages/shared-types/dist, apps/platform-app/dist):
 *
 *   does any object literal handed to one of them omit a property the declared
 *   parameter type requires?
 *
 * WHAT IT CATCHES
 *   - a required field missing from an object literal passed to a typed
 *     function/method/constructor declared in a workspace `dist/*.d.ts`
 *     (the reports.save-without-ownerId class);
 *   - a write on a repository instance the checker cannot type at all,
 *     reported as a failure rather than skipped - see BLIND SITES below.
 *
 * WHAT IT DOES NOT CATCH
 *   - wrong VALUE types (`status: "actve"`), extra properties, or a required
 *     field present but explicitly `undefined`;
 *   - arguments that are not object literals (a variable, a function result):
 *     no dataflow is attempted;
 *   - object literals containing a spread, and parameters whose type is a
 *     union: undecidable here, reported as `unverifiable` so the count is
 *     visible instead of silently zero;
 *   - fields the DB schema requires but the TypeScript type marks optional -
 *     this checker is only ever as strict as the type;
 *   - anything in a .mjs that does not cross into a workspace dist package.
 *
 * BLIND SITES
 * A plain .mjs loses the type as soon as a repository instance is passed into a
 * function: `reconcileStuckFailedProposal(db, proposals, reports, audit, input)`
 * types every parameter `any`, and `reports.save({...})` inside it was
 * unverifiable - the historic defect sat in precisely such a spot. Rather than
 * silently skipping those, any call to a repository method on a name that is
 * bound to `new SomethingRepository(...)` somewhere in this directory, whose
 * receiver still types as `any`, is reported as a violation. The fix is a JSDoc
 * `@param` on the receiving function, which costs a comment and puts the write
 * back under the checker.
 *
 * Run: `node apps/openclaw-config/scripts/check-repository-writes.mjs`
 * (wired as this directory's `pnpm typecheck`).
 */
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

// The repo's own TypeScript, resolved from the root package.json rather than
// imported by bare specifier: this directory deliberately declares no
// dependencies of its own, and every other script here imports nothing but
// node: builtins and relative paths. Resolving explicitly keeps that true and
// guarantees the guard checks with the same compiler `pnpm build` uses.
const ts = createRequire(join(REPO_ROOT, "package.json"))("typescript");

/** A compiled workspace package's declaration files - the typed boundary. */
const WORKSPACE_DIST_DECLARATION = /\/(?:packages|apps)\/[^/]+\/dist\/.*\.d\.ts$/u;

export function defaultRoots() {
  return readdirSync(HERE)
    .filter((entry) => entry.endsWith(".mjs"))
    .map((entry) => join(HERE, entry))
    .sort();
}

function createProgram(roots) {
  return ts.createProgram(roots, {
    allowJs: true,
    // Diagnostics are deliberately OFF. The checker still binds and types every
    // file, which is all this guard reads; turning them on would bury the one
    // question being asked under the JS-inference noise documented above.
    checkJs: false,
    noEmit: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: false,
    skipLibCheck: true,
    types: ["node"],
    typeRoots: [join(REPO_ROOT, "node_modules", "@types")]
  });
}

/** Method names declared on any `*Repository` class in the typed boundary. */
function repositoryMethodNames(program) {
  const names = new Set();
  for (const file of program.getSourceFiles()) {
    if (!WORKSPACE_DIST_DECLARATION.test(file.fileName)) {
      continue;
    }
    const visit = (node) => {
      if (ts.isClassDeclaration(node) && node.name && node.name.text.endsWith("Repository")) {
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && member.name) {
            names.add(member.name.getText());
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return names;
}

/** Local names ever bound to `new SomethingRepository(...)` in the roots. */
function repositoryBindingNames(program, checker, roots) {
  const names = new Set();
  for (const file of program.getSourceFiles()) {
    if (!roots.includes(file.fileName)) {
      continue;
    }
    const visit = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isNewExpression(node.initializer) &&
        /Repository$/u.test(checker.typeToString(checker.getTypeAtLocation(node.initializer)))
      ) {
        names.add(node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return names;
}

function propertyNameOf(property) {
  if (!property.name) {
    return undefined;
  }
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) {
    return property.name.text;
  }
  return undefined;
}

function locate(file, node) {
  const { line } = file.getLineAndCharacterOfPosition(node.getStart());
  return `${file.fileName.replace(`${REPO_ROOT}/`, "")}:${line + 1}`;
}

/**
 * @returns {{violations: string[], unverifiable: string[], stats: {boundaryCalls: number, checkedLiterals: number, files: number}}}
 */
export function checkRepositoryWrites(roots = defaultRoots()) {
  const program = createProgram(roots);
  const checker = program.getTypeChecker();
  const repoMethods = repositoryMethodNames(program);
  const repoBindings = repositoryBindingNames(program, checker, roots);

  const violations = [];
  const unverifiable = [];
  const stats = { boundaryCalls: 0, checkedLiterals: 0, files: 0 };

  for (const file of program.getSourceFiles()) {
    if (!roots.includes(file.fileName)) {
      continue;
    }
    stats.files += 1;

    const visit = (node) => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        inspectCall(node);
      }
      ts.forEachChild(node, visit);
    };

    const inspectCall = (node) => {
      const signature = checker.getResolvedSignature(node);
      const declaration = signature?.declaration;

      // A repository write the checker cannot see into at all.
      if (
        !declaration &&
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        repoBindings.has(node.expression.expression.text) &&
        repoMethods.has(node.expression.name.text)
      ) {
        violations.push(
          `${locate(file, node)}: \`${node.expression.getText()}\` is a repository call whose receiver types as \`any\`, ` +
            `so nothing here can tell whether its payload is complete. Give the enclosing function a JSDoc ` +
            `@param {import("../../../packages/shared-types/dist/index.js").X} for it.`
        );
        return;
      }

      if (!signature || !declaration) {
        return;
      }
      if (!WORKSPACE_DIST_DECLARATION.test(declaration.getSourceFile().fileName)) {
        return;
      }
      stats.boundaryCalls += 1;

      const args = node.arguments ?? [];
      args.forEach((argument, index) => {
        if (!ts.isObjectLiteralExpression(argument)) {
          return;
        }
        const parameter = signature.parameters[index];
        if (!parameter) {
          return;
        }
        const parameterType = checker.getTypeOfSymbolAtLocation(parameter, node);
        if (parameterType.isUnion()) {
          unverifiable.push(`${locate(file, argument)}: parameter type is a union - not decided here`);
          return;
        }
        const required = checker
          .getPropertiesOfType(parameterType)
          .filter((property) => (property.flags & ts.SymbolFlags.Optional) === 0);
        if (required.length === 0) {
          return;
        }
        if (argument.properties.some((property) => ts.isSpreadAssignment(property))) {
          unverifiable.push(`${locate(file, argument)}: object literal spreads - not decided here`);
          return;
        }
        stats.checkedLiterals += 1;

        const present = new Set(argument.properties.map(propertyNameOf).filter(Boolean));
        const missing = required.map((property) => property.getName()).filter((name) => !present.has(name));
        if (missing.length > 0) {
          violations.push(
            `${locate(file, argument)}: \`${node.expression.getText().slice(0, 60)}\` is missing required ` +
              `${missing.map((name) => `\`${name}\``).join(", ")} of ${checker.typeToString(parameterType)}`
          );
        }
      });
    };

    visit(file);
  }

  return { violations, unverifiable: unverifiable.sort(), stats };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { violations, unverifiable, stats } = checkRepositoryWrites();
  console.log(
    `check-repository-writes: ${stats.files} .mjs files, ${stats.boundaryCalls} calls into a workspace dist package, ` +
      `${stats.checkedLiterals} object literals checked against a required-property list.`
  );
  for (const entry of unverifiable) {
    console.log(`  undecidable: ${entry}`);
  }
  if (violations.length > 0) {
    console.error(`\n${violations.length} repository write site(s) omit a field the type requires:\n`);
    for (const violation of violations) {
      console.error(`  ${violation}`);
    }
    process.exit(1);
  }
  console.log("no repository write site omits a required field.");
}
