// source-pin-contract: setup write module-shape invariant — every write*.ts module in web/lib/setup stays under 800 lines, submodules never backimport write.ts, and their import graph is acyclic; subjects derived by listing the directory.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const MAX_LINES = 800;
const directory = fileURLToPath(new URL(".", import.meta.url));

const subjects = readdirSync(directory)
  .filter(
    (name) => (name === "write.ts" || /^write-.+\.ts$/.test(name)) && !name.endsWith(".test.ts"),
  )
  .sort();

const sources = new Map(
  subjects.map((name) => [name, readFileSync(`${directory}/${name}`, "utf8")]),
);

/** Static `import … from`, side-effect `import '…'` and `export … from` specifiers. */
function staticSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /^\s*(?:import|export)\b(?:[^'"`;]*?\bfrom\s*)?\s*['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  return specifiers;
}

/** The write module a relative specifier names, or null for any other module. */
function writeModule(specifier: string): string | null {
  const match = /^\.\/(write(?:-[^/]+)?)(?:\.ts)?$/.exec(specifier);
  return match ? `${match[1]}.ts` : null;
}

const edges = new Map(
  subjects.map((name) => [
    name,
    staticSpecifiers(sources.get(name)!)
      .map(writeModule)
      .filter((target): target is string => target !== null),
  ]),
);

test("the setup write facade and its submodules are discovered", () => {
  assert.ok(subjects.includes("write.ts"), "write.ts is present");
  assert.ok(
    subjects.some((name) => name.startsWith("write-")),
    "at least one write-*.ts submodule is present",
  );
});

test(`every setup write module stays within ${MAX_LINES} lines`, () => {
  for (const [name, source] of sources) {
    const lines = source.endsWith("\n") ? source.split("\n").length - 1 : source.split("\n").length;
    assert.ok(lines <= MAX_LINES, `${name} has ${lines} lines; split it below ${MAX_LINES}`);
  }
});

test("setup write submodules never import the write.ts facade", () => {
  for (const [name, targets] of edges) {
    if (name === "write.ts") continue;
    assert.ok(
      !targets.includes("write.ts"),
      `${name} imports ./write; depend on the owning write-*.ts module instead`,
    );
  }
});

test("setup write modules resolve every relative write import to a discovered module", () => {
  for (const [name, targets] of edges) {
    for (const target of targets)
      assert.ok(sources.has(target), `${name} imports ${target}, which does not exist`);
  }
});

test("the setup write import graph is acyclic", () => {
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string, path: string[]) => {
    if (state.get(name) === "done") return;
    assert.notEqual(state.get(name), "visiting", `import cycle: ${[...path, name].join(" → ")}`);
    state.set(name, "visiting");
    for (const target of edges.get(name) ?? []) visit(target, [...path, name]);
    state.set(name, "done");
  };
  for (const name of subjects) visit(name, []);
});
