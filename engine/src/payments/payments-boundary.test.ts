import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const files = ["payment-contracts.ts", "payment-accounts.ts", "payment-queries.ts", "credit-allocation.ts", "payment-documents.ts", "payment-posting.ts", "payment-return.ts", "run-readiness.ts", "run-creation.ts", "run-cancellation.ts", "run-remittance.ts", "run-posting.ts", "run-files.ts", "run-claim.ts", "settlement-policy.ts", "rail-settings.ts", "rail-formatters.ts", "payment-errors.ts"];
const source = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const parse = (name: string) => ts.createSourceFile(name, source(name), ts.ScriptTarget.Latest, true);

test("payments uses direct operation modules with no legacy entrypoint", () => {
  assert.equal(existsSync(new URL("payments.ts", import.meta.url)), false, "legacy entrypoint must be deleted");
  for (const file of files.filter((file) => file !== "payments.ts")) {
    assert.ok(source(file).split("\n").length <= 800, `${file} must remain a focused operation or policy`);
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

