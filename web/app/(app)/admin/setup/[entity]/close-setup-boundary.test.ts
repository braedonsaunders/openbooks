// source-pin-contract: close-setup workspace module-shape invariant — CloseSetupWorkspace.tsx and every close-setup-* module stay under 800 lines, submodules never backimport CloseSetupWorkspace, and their import graph is acyclic; subjects derived by listing the directory.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const directory = new URL("./", import.meta.url);
const submodules = readdirSync(directory)
  .filter((name) => /^close-setup-.+\.tsx?$/.test(name) && !name.includes(".test."))
  .sort();
const files = ["CloseSetupWorkspace.tsx", ...submodules];
const source = (name: string) => readFileSync(new URL(name, directory), "utf8");

function staticSpecifiers(name: string): string[] {
  const file = ts.createSourceFile(
    name,
    source(name),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const specifiers: string[] = [];
  for (const statement of file.statements) {
    if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) continue;
    const specifier = statement.moduleSpecifier;
    if (specifier && ts.isStringLiteral(specifier)) specifiers.push(specifier.text);
  }
  return specifiers;
}

function resolveSibling(specifier: string): string | null {
  if (!specifier.startsWith("./")) return null;
  const target = specifier.slice(2);
  return files.find((file) => file === target || file.replace(/\.tsx?$/, "") === target) ?? null;
}

test("close-setup workspace modules are discovered and stay focused", () => {
  assert.ok(submodules.length > 0, "the workspace must be composed from close-setup-* modules");
  for (const file of files) {
    const lines = source(file).split("\n").length;
    assert.ok(lines <= 800, `${file} has ${lines} lines; it must stay under 800`);
  }
});

test("close-setup modules never backimport the workspace and form an acyclic graph", () => {
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const dependencies: string[] = [];
    for (const specifier of staticSpecifiers(file)) {
      const target = resolveSibling(specifier);
      if (file !== "CloseSetupWorkspace.tsx") {
        assert.notEqual(
          target,
          "CloseSetupWorkspace.tsx",
          `${file} must not import ./CloseSetupWorkspace`,
        );
      }
      if (target) dependencies.push(target);
    }
    graph.set(file, dependencies);
  }
  const visited = new Set<string>();
  function visit(file: string, path: string[]) {
    assert.ok(
      !path.includes(file),
      `close-setup dependency cycle: ${[...path, file].join(" -> ")}`,
    );
    if (visited.has(file)) return;
    for (const target of graph.get(file) ?? []) visit(target, [...path, file]);
    visited.add(file);
  }
  for (const file of files) visit(file, []);
});
