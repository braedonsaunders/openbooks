import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BASELINE_EXPOSED, noInterp, scanFile, scanTree, stripped } from "./check-test-bypass-scope.mjs";
import { codeOnly } from "./check-test-mock-surface.mjs";

function fixtureTree(files) {
  const root = mkdtempSync(join(tmpdir(), "openbooks-bypass-"));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

const READER = `import "./request-org.ts";
export function reader() { return "data"; }
`;
const REQUEST_ORG = `// Stand-in: importing this module replaces the test bypass resolver.
export function registerRequestOrgResolver() {}
`;

function tree(extra) {
  return fixtureTree({
    "web/lib/request-org.ts": REQUEST_ORG,
    "web/lib/reader.ts": READER,
    "web/lib/lazy-reader.ts": READER,
    ...extra,
  });
}

test("bare setup under an eager web-reader import is exposed", () => {
  const root = tree({
    "web/lib/bad.integration.test.ts": `import test from "node:test";
const { reader } = await import("./reader.ts");
test("setup", async () => {
  const org = await createScratchOrg();
  await db.execute(sql\`insert into orgs(id) values (1)\`);
  await reader();
});
`,
  });
  try {
    const findings = scanFile(join(root, "web/lib/bad.integration.test.ts"), root);
    assert.equal(findings.length, 2);
    assert.ok(findings.some((finding) => finding.call.startsWith("createScratchOrg")));
    assert.ok(findings.some((finding) => finding.call.startsWith("db.execute(insert")));
    assert.ok(findings[0].via.includes("reader.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrapped setup, lazy-only reach, and unreached files are clean", () => {
  const root = tree({
    "web/lib/good.integration.test.ts": `import test from "node:test";
const { reader } = await import("./reader.ts");
test("setup", async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg();
    await db.execute(sql\`insert into orgs(id) values (1)\`);
    await db.execute(sql\`insert into t(id) values (\${ids.map((id) => \`'\${id}'\`).join(",")})\`);
    await db.execute(sql\`insert into u(id) values (\${ids.filter((id) => /[(]/.test(id)).join(",")})\`);
  });
  await reader();
});
`,
    "web/lib/lazy.integration.test.ts": `import test from "node:test";
test("setup", async () => {
  const org = await createScratchOrg();
  const { lazyReader } = await import("./lazy-reader.ts");
  await lazyReader();
});
`,
    "engine/src/plain.integration.test.ts": `import test from "node:test";
test("setup", async () => {
  const org = await createScratchOrg();
  await db.execute(sql\`insert into orgs(id) values (1)\`);
});
`,
    "web/lib/support.ts": `export async function seed() {
  const org = await createScratchOrg();
}
`,
  });
  try {
    for (const file of [
      "web/lib/good.integration.test.ts",
      "web/lib/lazy.integration.test.ts",
      "engine/src/plain.integration.test.ts",
    ]) {
      assert.deepEqual(scanFile(join(root, file), root), [], file);
    }
    assert.deepEqual(scanFile(join(root, "web/lib/support.ts"), root), []);
    assert.deepEqual(scanTree(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a top-level bypass reinstall neutralizes eager reader imports", () => {
  const root = tree({
    "web/lib/reinstalled.integration.test.ts": `import test from "node:test";
import { installTrustedTestDatabaseBypass } from "./bypass.ts";
const { reader } = await import("./reader.ts");
installTrustedTestDatabaseBypass();
async function seed() {
  await db.execute(sql\`insert into t(id) values (1)\`);
}
test("setup", async () => {
  const org = await createScratchOrg();
  await seed();
  await reader();
});
`,
  });
  try {
    assert.deepEqual(scanFile(join(root, "web/lib/reinstalled.integration.test.ts"), root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reader loaded after the reinstall re-exposes later writes", () => {
  const root = tree({
    "web/lib/relate.integration.test.ts": `import test from "node:test";
import { installTrustedTestDatabaseBypass } from "./bypass.ts";
const { reader } = await import("./reader.ts");
installTrustedTestDatabaseBypass();
const { lazyReader } = await import("./lazy-reader.ts");
test("setup", async () => {
  const org = await createScratchOrg();
  await lazyReader();
});
`,
    "web/lib/inner.integration.test.ts": `import test from "node:test";
import { installTrustedTestDatabaseBypass } from "./bypass.ts";
const { reader } = await import("./reader.ts");
installTrustedTestDatabaseBypass();
test("setup", async () => {
  const org = await createScratchOrg();
  const { lazyReader } = await import("./lazy-reader.ts");
  await lazyReader();
});
`,
  });
  try {
    // A top-level reader import after the call re-clobbers the slot.
    assert.ok(scanFile(join(root, "web/lib/relate.integration.test.ts"), root).length > 0);
    // So does a lazy in-test import: the reinstall cannot cover it.
    assert.ok(scanFile(join(root, "web/lib/inner.integration.test.ts"), root).length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a direct bypass reinstall covers setup; a scoped resolver does not", () => {
  const root = tree({
    "web/lib/direct.integration.test.ts": `import test from "node:test";
import { registerRequestOrgResolver } from "./db.ts";
const { reader } = await import("./reader.ts");
registerRequestOrgResolver(() => ({ orgId: null, bypass: true }));
test("setup", async () => {
  const org = await createScratchOrg();
  await reader();
});
`,
    "web/lib/scoped.integration.test.ts": `import test from "node:test";
import { registerRequestOrgResolver } from "./db.ts";
const { reader } = await import("./reader.ts");
registerRequestOrgResolver(() => ({ orgId: "o1", bypass: false }));
test("setup", async () => {
  const org = await createScratchOrg();
  await reader();
});
`,
  });
  try {
    assert.deepEqual(scanFile(join(root, "web/lib/direct.integration.test.ts"), root), []);
    // Enforcement is not coverage: a scoped resolver still denies setup.
    assert.ok(scanFile(join(root, "web/lib/scoped.integration.test.ts"), root).length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("helpers called only from scoped helpers are transitively covered", () => {
  const root = tree({
    "web/lib/transitive.integration.test.ts": `import test from "node:test";
const { reader } = await import("./reader.ts");
async function inner() {
  await db.execute(sql\`insert into t(id) values (1)\`);
}
async function outer() {
  await inner();
}
test("a", async () => {
  await withBypassContext(() => outer());
});
test("b", async () => {
  await inner();
});
`,
  });
  try {
    const findings = scanFile(join(root, "web/lib/transitive.integration.test.ts"), root);
    // Only the bare call in test b is exposed; the outer->inner chain is clean.
    assert.equal(findings.length, 1);
    assert.ok(findings[0].note.includes("inner"));
    assert.equal(findings[0].name, "b");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("projections preserve offsets on adversarial templates", () => {
  const src = [
    "await withBypassContext(async () => {",
    "  await db.execute(sql`insert into t(id) values (${ids.map((id) => `'${id}'`).join(\",\")})`);",
    "  await db.execute(sql`insert into u(id) values (${ids.filter((id) => /[(]/.test(id)).join(\",\")})`);",
    "  const q = 'it''s (closed) `not a template`';",
    "  await createScratchOrg();",
    "});",
  ].join("\n");
  const text = noInterp(stripped(codeOnly(src)));
  assert.equal(text.length, codeOnly(src).length);
  for (const token of ["withBypassContext(", "createScratchOrg()", "db.execute("]) {
    assert.equal(text.indexOf(token), codeOnly(src).indexOf(token), token);
  }
  // Quoted contents (including stray backticks) are blanked, not shifted.
  assert.equal(text.indexOf("not a template"), -1);
  // Interpolation bodies (and only they) are gone.
  assert.ok(!text.includes("ids.map"));
  assert.ok(!text.includes("ids.filter"));
});

test("test bodies before the import and named test callbacks are still exposed", () => {
  const root = tree({
    "web/lib/early.integration.test.ts": `import test from "node:test";
test("setup", async () => {
  const org = await createScratchOrg();
});
const { reader } = await import("./reader.ts");
test("uses", async () => {
  await reader();
});
`,
    "web/lib/named.integration.test.ts": `import test from "node:test";
const { reader } = await import("./reader.ts");
async function seed() {
  await db.execute(sql\`insert into t(id) values (1)\`);
}
test("works", seed);
`,
  });
  try {
    const early = scanFile(join(root, "web/lib/early.integration.test.ts"), root);
    assert.equal(early.length, 1);
    assert.equal(early[0].name, "setup");
    const named = scanFile(join(root, "web/lib/named.integration.test.ts"), root);
    assert.equal(named.length, 1);
    assert.equal(named[0].name, "works");
    assert.ok(named[0].note.includes("seed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("helpers called under a scope are covered; helpers called bare are flagged", () => {
  const root = tree({
    "web/lib/helpers.integration.test.ts": `import test from "node:test";
const { reader } = await import("./reader.ts");
async function safeSeed() {
  await db.execute(sql\`insert into t(id) values (1)\`);
}
async function bareSeed() {
  await db.execute(sql\`update t set a = 1\`);
}
test("a", async () => {
  await withBypassContext(() => safeSeed());
});
test("b", async () => {
  await bareSeed();
  await reader();
});
`,
  });
  try {
    const findings = scanFile(join(root, "web/lib/helpers.integration.test.ts"), root);
    assert.equal(findings.length, 1);
    assert.ok(findings[0].call.startsWith("db.execute(update"));
    assert.ok(findings[0].note.includes("bareSeed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the live repository exposes no files outside the tracked baseline", () => {
  const findings = scanTree();
  const exposed = [...new Set(findings.map((finding) => finding.file))].sort();
  const baseline = [...BASELINE_EXPOSED.keys()].sort();
  const added = exposed.filter((file) => !BASELINE_EXPOSED.has(file));
  const removed = baseline.filter((file) => !exposed.includes(file));
  assert.deepEqual(
    { added, removed },
    { added: [], removed: [] },
    `${added.length} new RLS exposures (wrap them, do not list them):\n` +
    added.map((file) => `  + ${file}`).join("\n") +
    (removed.length > 0 ? `\n${removed.length} fixed files still listed (drop their entries):\n` +
      removed.map((file) => `  - ${file}`).join("\n") : ""),
  );
});

test("client receivers write like db.execute; DDL and reads stay out of scope", () => {
  const root = tree({
    "web/lib/receivers.integration.test.ts": `import test from "node:test";
const { reader } = await import("./reader.ts");
test("writes", async () => {
  await writer.query(\`update t set a = 1\`);
  await db.execute(sql.raw(\`create function f() returns void language plpgsql as $$ begin end $$\`));
  await reader();
});
test("reads", async () => {
  await pool.query(\`select id from t\`);
  await db.execute(sql\`select id from t\`);
  await reader();
});
`,
  });
  try {
    const findings = scanFile(join(root, "web/lib/receivers.integration.test.ts"), root);
    assert.deepEqual(
      findings.map((finding) => finding.call).sort(),
      ["writer.query(update ...)"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A one-off check of a single file must agree with scanTree about that file.
// A repo-relative path used to resolve against the process cwd, so the same
// exposed file reported zero findings from any other directory — a silent
// false clean that was once presented as proof the file was scoped.
test("a repo-relative path is scanned from the repo, not the process cwd", () => {
  const exposed = [...BASELINE_EXPOSED.keys()][0];
  const fromRoot = scanFile(exposed);
  assert.ok(fromRoot.length > 0, `${exposed} is in the baseline but scanned clean`);
  const cwd = process.cwd();
  process.chdir(tmpdir());
  try {
    assert.deepEqual(
      scanFile(exposed).map((finding) => `${finding.line}:${finding.call}`),
      fromRoot.map((finding) => `${finding.line}:${finding.call}`),
    );
  } finally {
    process.chdir(cwd);
  }
});
