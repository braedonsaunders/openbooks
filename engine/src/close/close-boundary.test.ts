import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const files = ["close.ts", "calendar.ts", "defaults.ts", "readiness.ts", "task-dependencies.ts", "run-automation.ts", "period-locks.ts", "run-start.ts", "tasks.ts", "approvals.ts", "run-completion.ts", "reopening.ts", "period-policy.ts", "features.ts", "automations.ts"];
const source = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const parse = (name: string) => ts.createSourceFile(name, source(name), ts.ScriptTarget.Latest, true);

test("close has a thin compatibility facade and focused implementation modules", () => {
  assert.ok(source("close.ts").split("\n").length <= 200);
  for (const file of files.filter((file) => file !== "close.ts")) {
    assert.ok(source(file).split("\n").length <= 800, `${file} must remain a focused operation or policy`);
  }
  for (const statement of parse("close.ts").statements) {
    assert.ok(ts.isExportDeclaration(statement),
      "the public API owns compatibility exports, not lifecycle work");
  }
});

test("close implementation dependencies have no facade backimports or static cycles", () => {
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const dependencies: string[] = [];
    for (const statement of parse(file).statements) {
      if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      assert.notEqual(specifier.text, "./close.ts", `${file} must depend on the owning implementation, not the public facade`);
      const target = specifier.text.replace(/^\.\//, "");
      if (files.includes(target)) dependencies.push(target);
    }
    graph.set(file, dependencies);
  }
  const visited = new Set<string>();
  function visit(file: string, path: string[]) {
    assert.ok(!path.includes(file), `close dependency cycle: ${[...path, file].join(" -> ")}`);
    if (visited.has(file)) return;
    for (const target of graph.get(file) ?? []) visit(target, [...path, file]);
    visited.add(file);
  }
  for (const file of files) visit(file, []);
});

