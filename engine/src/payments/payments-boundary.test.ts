import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const LINE_BOUND = 800;

/**
 * Every payments module, DISCOVERED from the directory.
 *
 * This was a hand-written list of eighteen names, and the directory holds
 * twenty-two modules. The four it missed were not small: `acceptance.ts` at 2287
 * lines (2.9x the bound), `operations.ts` at 1508 (1.9x), `psp-settlement.ts` at
 * 1230 (1.5x) and `direct-debit.ts` at 160 — so three modules sat far over a
 * bound this suite reported GREEN.
 *
 * Size was the smaller half. The cycle and facade-backimport test below walks
 * the same list, so a dependency cycle through `operations.ts` or `acceptance.ts`
 * was UNDETECTABLE: not a size problem, a guard that could not see three of the
 * modules it exists to guard.
 *
 * A hand-maintained list standing in for a derivation is the failure shape, and
 * it fails in the direction that reads as healthy — the list only ever omits, and
 * an omission is silence. Deriving also means a module SPLIT (rail-formatters is
 * about to become one file per rail) needs no edit here: the new modules are
 * guarded the moment they exist, which is the opposite of today, where they would
 * be unguarded until someone remembered.
 */
const files = readdirSync(new URL(".", import.meta.url))
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .sort();

/**
 * Modules over the bound when the list started being derived. May only SHRINK.
 *
 * Each is a pre-existing operation module that grew past a bound nothing was
 * enforcing on it, and each wants splitting on its own terms by someone who knows
 * it — not a ceiling raised to fit it. They are exempted from the SIZE bound
 * only; the cycle and facade-backimport checks apply to them in full from now on,
 * which is the half that was never enforced at all.
 */
const OVERSIZED_LEGACY_MODULES = new Set(["acceptance.ts", "operations.ts", "psp-settlement.ts"]);

const source = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const lineCount = (name: string) => source(name).split("\n").length;
const parse = (name: string) => ts.createSourceFile(name, source(name), ts.ScriptTarget.Latest, true);

test("payments uses direct operation modules with no legacy entrypoint", () => {
  assert.equal(existsSync(new URL("payments.ts", import.meta.url)), false, "legacy entrypoint must be deleted");
  assert.ok(files.length > 0, "no payments modules discovered — the glob is broken, not the directory");

  // The exemption list may only shrink: a module that has been split must lose
  // its entry, or the next module to grow past the bound inherits its cover.
  for (const name of OVERSIZED_LEGACY_MODULES) {
    assert.ok(files.includes(name), `${name} is exempted from the line bound but no longer exists`);
    assert.ok(
      lineCount(name) > LINE_BOUND,
      `${name} is exempted from the line bound but is now ${lineCount(name)} lines — delete it from `
      + "OVERSIZED_LEGACY_MODULES; the list may only shrink",
    );
  }

  for (const file of files.filter((file) => !OVERSIZED_LEGACY_MODULES.has(file))) {
    assert.ok(lineCount(file) <= LINE_BOUND, `${file} must remain a focused operation or policy`);
  }
});

test("payments implementation dependencies have no facade backimports or static cycles", () => {
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const dependencies: string[] = [];
    for (const statement of parse(file).statements) {
      if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      assert.notEqual(specifier.text, "./payments.ts", `${file} must depend on the owning implementation, not the public facade`);
      const target = specifier.text.replace(/^\.\//, "");
      if (files.includes(target)) dependencies.push(target);
    }
    graph.set(file, dependencies);
  }
  const visited = new Set<string>();
  function visit(file: string, path: string[]) {
    assert.ok(!path.includes(file), `payments dependency cycle: ${[...path, file].join(" -> ")}`);
    if (visited.has(file)) return;
    for (const target of graph.get(file) ?? []) visit(target, [...path, file]);
    visited.add(file);
  }
  for (const file of files) visit(file, []);
});
