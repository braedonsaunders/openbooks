import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const files = [
  "posting-document.ts", "posting-prepare.ts", "posting-commit.ts",
  "posting-replay.ts", "posting-projection.ts", "posting-dispatch.ts", "posting-accounts.ts",
  "posting-provider-tax.ts", "posting-subsidiaries.ts", "posting-period.ts",
  "posting-contracts.ts", "posting-rules.ts", "posting-tax-policy.ts", "posting-invariants.ts",
];
const source = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const parse = (name: string) => ts.createSourceFile(name, source(name), ts.ScriptTarget.Latest, true);

test("posting uses direct operation modules with no legacy entrypoint", () => {
  assert.equal(existsSync(new URL("posting.ts", import.meta.url)), false, "legacy entrypoint must be deleted");
  for (const file of files.filter((file) => file !== "posting.ts")) {
    assert.ok(source(file).split("\n").length <= 800, `${file} must remain a focused operation or policy`);
  }

});

test("posting implementation dependencies have no facade backimports or static cycles", () => {
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const dependencies: string[] = [];
    for (const statement of parse(file).statements) {
      if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      assert.notEqual(specifier.text, "./posting.ts", `${file} must depend on the owning implementation, not the public facade`);
      const target = specifier.text.replace(/^\.\//, "");
      if (files.includes(target)) dependencies.push(target);
    }
    graph.set(file, dependencies);
  }
  const visited = new Set<string>();
  function visit(file: string, path: string[]) {
    assert.ok(!path.includes(file), `posting dependency cycle: ${[...path, file].join(" -> ")}`);
    if (visited.has(file)) return;
    for (const target of graph.get(file) ?? []) visit(target, [...path, file]);
    visited.add(file);
  }
  for (const file of files) visit(file, []);
});

test("posting coordinator prepares, commits and dispatches in that order", () => {
  const text = source("posting-document.ts");
  const prepare = text.indexOf("await prepareDocumentPosting(");
  const commit = text.indexOf("await commitDocumentPosting(");
  const effects = text.indexOf("await runPostDocumentEffects(");
  assert.ok(prepare >= 0 && commit > prepare && effects > commit);
  assert.match(text, /if \(!options\.deferEffects\)/);
  assert.doesNotMatch(source("posting-prepare.ts"), /inDbTransaction/);
  assert.match(source("posting-commit.ts"), /return await inDbTransaction\(async \(tx\) =>/);
});
