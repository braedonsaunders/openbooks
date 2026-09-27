// source-pin-contract: inventory module-shape invariant — no module imports the deleted inventory.ts facade, every operation module stays under 800 lines, and their import graph is acyclic; subjects derived by listing the directory, never hand-listed.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const DIR = new URL("./", import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, DIR), "utf8");
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.split("//", 1)[0])
    .join("\n");

const operationFiles = (): string[] =>
  readdirSync(DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => f.toString());

test("legacy inventory facade is absent and unreferenced", () => {
  assert.equal(
    existsSync(new URL("./inventory.ts", DIR)),
    false,
    "engine/src/inventory/inventory.ts must not exist — import the owning module",
  );
  for (const file of readdirSync(DIR).map((f) => f.toString())) {
    if (!file.endsWith(".ts") || file === "inventory-boundary.test.ts") continue;
    const code = stripComments(read(`./${file}`));
    assert.equal(
      /["']\.\/inventory(\.ts|\.js)?["']/.test(code),
      false,
      `${file} still targets the deleted facade`,
    );
  }
});

test("inventory operation modules stay acyclic and bounded", () => {
  const files = operationFiles();
  const edges = new Map<string, string[]>();
  for (const file of files) {
    const code = stripComments(read(`./${file}`));
    const deps = [...code.matchAll(/from ["']\.\/([A-Za-z-]+\.ts)["']/g)]
      .map((match) => {
        assert.ok(match[1], "relative import must capture its dependency");
        return match[1];
      })
      .filter((dep) => files.includes(dep));
    edges.set(file, [...new Set(deps)]);
    const lines = read(`./${file}`).split("\n").length;
    assert.ok(lines <= 800, `${file} must stay <= 800 lines (now ${lines})`);
  }
  // Depth-first cycle check over the intra-inventory import graph.
  const state = new Map<string, "open" | "closed">();
  const visit = (file: string, trail: string[]): void => {
    if (state.get(file) === "closed") return;
    assert.equal(
      trail.includes(file),
      false,
      `inventory import cycle: ${[...trail, file].join(" -> ")}`,
    );
    for (const dep of edges.get(file) ?? []) visit(dep, [...trail, file]);
    state.set(file, "closed");
  };
  for (const file of files) visit(file, []);
});
