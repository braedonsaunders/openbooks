import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyze, importsOf, stripComments, stronglyConnected } from "./check-engine-boundaries.mjs";

// A synthetic engine: two low modules, one orchestrator. Acyclic with the
// "cycles" pin retired: any cycle is refused.
function scaffold(manifest, files) {
  const root = mkdtempSync(join(tmpdir(), "engine-boundaries-"));
  mkdirSync(join(root, "engine/src"), { recursive: true });
  writeFileSync(join(root, "engine/src/modules.json"), JSON.stringify(manifest));
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(join(root, "engine/src", file, ".."), { recursive: true });
    writeFileSync(join(root, "engine/src", file), source);
  }
  return root;
}

const MANIFEST = {
  modules: {
    platform: { description: "db", dependsOn: [] },
    records: { description: "primitives", dependsOn: ["platform"] },
    ledger: { description: "posting", dependsOn: ["payments", "platform", "records"] },
    payments: { description: "payments", dependsOn: ["platform"] },
  },
  cycles: [],
};
const FILES = {
  "platform/db.ts": "export const db = 1;\n",
  "records/numbering.ts": 'import { db } from "../platform/db.ts";\nexport const next = () => db;\n',
  "ledger/posting-example.ts": 'import { db } from "@openbooks/engine/src/platform/db.ts";\nimport { next } from "../records/numbering.ts";\nexport async function post() { const { pay } = await import("../payments/payment-example.ts"); return pay(next(), db); }\n',
  "payments/payment-example.ts": 'import { db } from "../platform/db.ts";\nexport const pay = (n, d) => n + d + db;\n',
  "ledger/posting.test.ts": 'import { pay } from "../payments/payment-example.ts";\nimport { x } from "@/lib/anything.ts";\n',
};

test("a clean acyclic tree passes: every file in a module, every edge declared and used", () => {
  const root = scaffold(MANIFEST, FILES);
  try {
    const { problems, files } = analyze(root);
    assert.deepEqual(problems, []);
    assert.equal(files, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file at engine/src root is refused with the remedy", () => {
  const root = scaffold(MANIFEST, { ...FILES, "stray.ts": "export const x = 1;\n" });
  try {
    const { problems } = analyze(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /engine\/src\/stray\.ts: files do not live at engine\/src root/); // source-path: synthetic
    assert.match(problems[0], /Move it into the module it belongs to/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an undeclared cross-module import names file, line, both modules and the remedy", () => {
  const root = scaffold(MANIFEST, {
    ...FILES,
    "records/numbering.ts": 'import { db } from "../platform/db.ts";\n\nimport { pay } from "../payments/payment-example.ts";\nexport const next = () => pay(db, db);\n',
  });
  try {
    const { problems } = analyze(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^engine\/src\/records\/numbering\.ts:3: module "records" imports "\.\.\/payments\/payment-example\.ts" from module "payments", which it does not declare/);
    assert.match(problems[0], /modules\.records\.dependsOn/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a declared edge nothing uses is refused, so the manifest cannot grant permission in advance", () => {
  const manifest = structuredClone(MANIFEST);
  manifest.modules.records.dependsOn = ["payments", "platform"];
  const root = scaffold(manifest, FILES);
  try {
    const { problems } = analyze(root);
    assert.deepEqual(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /module "records" declares dependsOn "payments" but no non-test file in engine\/src\/records\/ imports it/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("any cycle is refused, with both modules named and the remedy", () => {
  const manifest = structuredClone(MANIFEST);
  manifest.modules.payments.dependsOn = ["ledger", "platform"];
  const files = {
    ...FILES,
    "payments/payment-example.ts": 'import type { post } from "../ledger/posting-example.ts";\nimport { db } from "../platform/db.ts";\nexport const pay = (n, d) => n + d + db;\n',
  };
  const root = scaffold(manifest, files);
  try {
    const { problems } = analyze(root);
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /contains a cycle through \{ledger, payments\}/);
    assert.match(problems[0], /must be acyclic/);
    assert.match(problems[0], /remove an edge/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a retired pin entry is refused even when the graph is acyclic", () => {
  const manifest = structuredClone(MANIFEST);
  manifest.cycles = [["ledger", "payments"]];
  const root = scaffold(manifest, FILES);
  try {
    const { problems } = analyze(root);
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /"cycles" pin is retired/);
    assert.match(problems[0], /must stay empty/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a directory that is not a declared module is refused", () => {
  const root = scaffold(MANIFEST, { ...FILES, "mystery/thing.ts": "export const x = 1;\n" });
  try {
    const { problems } = analyze(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /directory "mystery" is not a declared module/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("engine code importing the web app is refused; tests may", () => {
  const root = scaffold(MANIFEST, { ...FILES, "ledger/posting-example.ts": FILES["ledger/posting-example.ts"] + 'import { y } from "@/lib/thing.ts";\n' });
  try {
    const { problems } = analyze(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /engine\/src\/ledger\/posting-example\.ts:4: engine code must not import the web app/); // source-path: synthetic
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("importsOf sees static, re-export, type and dynamic imports but not comments", () => {
  const source = [
    'import { a } from "./a.ts";',
    'export { b } from "./b.ts";',
    'import type { C } from "./c.ts";',
    '// import { d } from "./d.ts";',
    '/* import { e } from "./e.ts"; */',
    'const f = await import("./f.ts");',
    'const url = "https://example.com//not-a-comment";',
  ].join("\n");
  assert.deepEqual(
    importsOf("engine/src/x/y.ts", source).map(({ spec, line }) => `${line}:${spec}`),
    ["1:./a.ts", "2:./b.ts", "3:./c.ts", "6:./f.ts"],
  );
  assert.equal(stripComments(source).split("\n").length, source.split("\n").length, "line numbers survive comment stripping");
});

test("stronglyConnected finds cycles and leaves acyclic modules as singletons", () => {
  const sccs = stronglyConnected({
    a: { dependsOn: ["b"] },
    b: { dependsOn: ["a", "c"] },
    c: { dependsOn: [] },
  });
  const sizes = sccs.map((c) => c.length).sort();
  assert.deepEqual(sizes, [1, 2]);
});
