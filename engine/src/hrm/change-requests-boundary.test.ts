// source-pin-contract: hrm change-requests module-shape invariant — every change-requests*.ts module stays under 800 lines, submodules never backimport change-requests.ts, and their import graph is acyclic; subjects derived by listing the directory.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * HRM change-request operations live in focused modules behind the
 * change-requests.ts facade. Their sibling graph stays acyclic and
 * bounded, and no submodule reaches back through the facade.
 * Source-only: no engine imports or database.
 */
const dir = dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(dir).filter(
  (f) =>
    (f === "change-requests.ts" || f.startsWith("change-requests-")) &&
    f.endsWith(".ts") &&
    !f.endsWith(".test.ts"),
);
const submodules = sources.filter((f) => f !== "change-requests.ts");

const relativeImports = (source: string): string[] =>
  [...source.matchAll(/from\s+["'](\.[^"']*)["']/g)].map((m) => m[1]!);

test("change-requests modules stay bounded", () => {
  assert.ok(sources.includes("change-requests.ts"));
  assert.ok(submodules.length > 0);
  for (const file of sources)
    assert.ok(
      readFileSync(join(dir, file), "utf8").split("\n").length <= 800,
      `${file} exceeds 800 lines`,
    );
});

test("change-requests submodules never backimport the facade", () => {
  for (const file of submodules) {
    const source = readFileSync(join(dir, file), "utf8");
    for (const target of relativeImports(source)) {
      assert.ok(
        target !== "./change-requests" &&
          target !== "./change-requests.ts" &&
          target !== "./change-requests.js",
        `${file} backimports the facade via ${target}`,
      );
    }
  }
});

test("change-requests modules form no static import cycle", () => {
  const edges = new Map<string, string[]>();
  for (const file of sources) {
    const source = readFileSync(join(dir, file), "utf8");
    edges.set(
      file,
      relativeImports(source)
        .filter(
          (t) =>
            (t === "./change-requests" ||
              t === "./change-requests.ts" ||
              t.startsWith("./change-requests-")) &&
            sources.includes(t.slice(2).endsWith(".ts") ? t.slice(2) : `${t.slice(2)}.ts`),
        )
        .map((t) => (t.slice(2).endsWith(".ts") ? t.slice(2) : `${t.slice(2)}.ts`)),
    );
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (file: string, trail: string[]): void => {
    if (done.has(file)) return;
    assert.ok(!visiting.has(file), `import cycle: ${[...trail, file].join(" -> ")}`);
    visiting.add(file);
    for (const next of edges.get(file) ?? []) visit(next, [...trail, file]);
    visiting.delete(file);
    done.add(file);
  };
  for (const file of sources) visit(file, []);
});
