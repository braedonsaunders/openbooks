// source-pin-contract: order-cycle module-shape invariant — every order-cycle*.ts module stays under 800 lines, submodules never backimport order-cycle.ts, and their import graph is acyclic; subjects derived by listing the directory.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const MAX_LINES = 800;
const directory = new URL("./", import.meta.url);

const subjects = readdirSync(directory)
  .filter((name) => /^order-cycle(-[\w-]+)?\.ts$/.test(name) && !name.endsWith(".test.ts"))
  .sort();

const sourceOf = (name: string) => readFileSync(new URL(name, directory), "utf8");

/** Sibling specifiers named by static `import … from` and `export … from` declarations. */
function siblingSpecifiers(source: string): string[] {
  const pattern = /^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"](\.\/[^'"]+)['"]/gm;
  return [...source.matchAll(pattern)].map((match) => match[1]!);
}

function resolveSibling(specifier: string): string {
  const name = specifier.slice(2);
  return name.endsWith(".ts") ? name : `${name}.ts`;
}

test("the order-cycle subject listing finds the facade and its submodules", () => {
  assert.ok(subjects.includes("order-cycle.ts"), "the facade module is listed");
  assert.ok(
    subjects.filter((name) => name !== "order-cycle.ts").length >= 4,
    "the submodules are listed",
  );
});

test("every order-cycle module stays under the line bound", () => {
  for (const name of subjects) {
    const lines = sourceOf(name).split("\n").length;
    assert.ok(lines <= MAX_LINES, `${name} has ${lines} lines; the bound is ${MAX_LINES}`);
  }
});

test("order-cycle submodules never import the facade", () => {
  for (const name of subjects.filter((subject) => subject !== "order-cycle.ts")) {
    const backImports = siblingSpecifiers(sourceOf(name)).filter(
      (specifier) => resolveSibling(specifier) === "order-cycle.ts",
    );
    assert.deepEqual(backImports, [], `${name} imports the order-cycle facade`);
  }
});

test("the order-cycle module graph is acyclic", () => {
  const subjectSet = new Set(subjects);
  const edges = new Map(
    subjects.map((name) => [
      name,
      siblingSpecifiers(sourceOf(name))
        .map(resolveSibling)
        .filter((target) => subjectSet.has(target)),
    ]),
  );
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string, path: string[]) => {
    if (state.get(name) === "done") return;
    assert.notEqual(state.get(name), "visiting", `import cycle: ${[...path, name].join(" -> ")}`);
    state.set(name, "visiting");
    for (const target of edges.get(name) ?? []) visit(target, [...path, name]);
    state.set(name, "done");
  };
  for (const name of subjects) visit(name, []);
});
