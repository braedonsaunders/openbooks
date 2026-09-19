import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkFile,
  checkTree,
  codeOnly,
  matchRule,
  mockBlocks,
  moduleExports,
  parseWiring,
  staticImports,
} from "./check-test-mock-surface.mjs";

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "openbooks-mock-surface-"));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

const DB = `export const db = {};
export const schema = {};
export function withBypassContext(fn) { return fn(); }
export function registerRequestOrgResolver() {}
export type OrgCtx = { orgId: string };
`;

const SUBS = `import { db, withBypassContext } from "@openbooks/engine/src/db.ts";
import type { OrgCtx } from "@openbooks/engine/src/db.ts";
export async function subsidiaryOptions() {
  return withBypassContext(async () => db);
}
`;

const ROUTE = `import { db } from "@openbooks/engine/src/db.ts";
import { subsidiaryOptions } from "../lib/subs.ts";
export async function GET() {
  await subsidiaryOptions();
  return db;
}
`;

function mockTest(extraDbExports, wiring) {
  return `import { registerHooks } from "node:module";
import test from "node:test";
const mockSources = new Map([
  ["mock:db", \`
      export const db = {};
      export const schema = {};
${extraDbExports}    \`],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
${wiring}
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});
const routeUrl = "./route.ts?fixture-tag";
const { GET } = await import(routeUrl);
hooks.deregister();
test("route loads", async () => { await GET(); });
`;
}

const MAP_WIRING = `    const mocked = new Map([["@openbooks/engine/src/db.ts", "mock:db"]]).get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };`;

test("import parsing keeps the exported name across aliases and drops types", () => {
  const imports = staticImports(codeOnly(`import { db as database, withBypassContext, type OrgCtx } from "db.ts";
import type { Other } from "other.ts";
const top = await import("./top.ts");
async function load(flag) {
  if (flag) return import("./lazy.ts");
  return null;
}
`));
  assert.deepEqual(
    imports.map((entry) => [entry.spec, [...entry.names].sort(), entry.dynamic]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [
      ["./lazy.ts", [], true],
      ["./top.ts", [], false],
      ["db.ts", ["db", "withBypassContext"], false],
    ],
  );
});

test("inert template text cannot forge imports, wiring, or blocks", () => {
  const src = `import { real } from "./real.ts";
const fixture = \`
  import { forged } from "./forged.ts";
  ["mock:forged", \`export const forged = 1;\`]
  if (specifier === "./forged") return { url: "mock:forged" };
\`;
const interpolated = \`prefix \${real} and \` + "tail";
`;
  const code = codeOnly(src);
  assert.deepEqual(
    staticImports(code).map((entry) => entry.spec),
    ["./real.ts"],
  );
  assert.deepEqual(parseWiring(code), []);
  assert.deepEqual([...mockBlocks(code).keys()], []);
  // Length and newlines survive so positions stay meaningful.
  assert.equal(code.length, src.length);
  assert.equal(code.split("\n").length, src.split("\n").length);
});

test("mock bodies unescape one template level before export extraction", async () => {
  const { unescapeTemplate } = await import("./check-test-mock-surface.mjs");
  assert.equal(unescapeTemplate("a\\`b\\${c}\\\\d\\n"), "a`b${c}\\d\n");
  const have = moduleExports(codeOnly(unescapeTemplate(`export function sealSecret(secret) {
        return { ciphertext: \\\`sealed:\\\${secret}\\\`, nonce: 'nonce' }
      }
      export function validateStoredEmailConfig(config) {}`)));
  assert.deepEqual([...have].sort(), ["sealSecret", "validateStoredEmailConfig"]);
});

test("mock export extraction covers function, const, class, and member forms", () => {
  const have = moduleExports(`export async function a() {}
export const b = 1;
export class C {}
export { d, e as f };
export type G = number;
`);
  assert.deepEqual([...have].sort(), ["C", "a", "b", "d", "f"]);
});

test("complete mock reports no gaps", () => {
  const root = fixture({
    "engine/src/db.ts": DB,
    "web/lib/subs.ts": SUBS,
    "web/app/route.test.ts": mockTest("      export function withBypassContext(fn) { return fn(); }\n      export function registerRequestOrgResolver() {}\n", MAP_WIRING),
    "web/app/route.ts": ROUTE,
  });
  const result = checkFile(join(root, "web/app/route.test.ts"), root);
  assert.deepEqual(result.gaps, []);
  assert.equal(result.unmodeled, false);
});

test("a mock missing a statically-reached export is a gap naming the importer", () => {
  const root = fixture({
    "engine/src/db.ts": DB,
    "web/lib/subs.ts": SUBS,
    "web/app/route.test.ts": mockTest("      export function registerRequestOrgResolver() {}\n", MAP_WIRING),
    "web/app/route.ts": ROUTE,
  });
  const result = checkFile(join(root, "web/app/route.test.ts"), root);
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].spec, "db");
  assert.deepEqual(result.gaps[0].names, ["withBypassContext"]);
  assert.match(result.gaps[0].via.withBypassContext, /subs\.ts/);
});

test("variable SUT loads resolve through string bindings", () => {
  const imports = staticImports(codeOnly(`const routeUrl = "./route.ts?tag";
const other = "./other.ts";
const { GET } = await import(routeUrl);
const missing = await import(unknownVar);
async function later() {
  return import(other);
}
`));
  const bySpec = new Map(imports.map((entry) => [entry.spec, entry.dynamic]));
  // Top-level variable load always runs: static. Nested stays lazy.
  assert.equal(bySpec.get("./route.ts?tag"), false);
  assert.equal(bySpec.get("./other.ts"), true);
  assert.ok(![...bySpec.keys()].some((spec) => spec.includes("unknownVar")));
});

test("conditional specifier wiring is modeled with its parent constraint", () => {
  const rules = parseWiring(`registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./authz" && context.parentURL?.endsWith("/lib/guard.ts")) {
      return { url: "mock:guard-authz", shortCircuit: true };
    }
    if (specifier.endsWith("/lib/authz")) return { url: "mock:authz", shortCircuit: true };
    return nextResolve(specifier, context);
  },
});`);
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0].parent, { kind: "suffix", value: "/lib/guard.ts" });
  assert.equal(rules[0].mock, "guard-authz");
  assert.deepEqual(rules[1].spec, { kind: "suffix", value: "/lib/authz" });
  const matched = matchRule(rules, "./authz", "file:///x/web/lib/guard.ts");
  assert.equal(matched?.mock, "guard-authz");
  const unmatched = matchRule(rules, "./authz", "file:///x/web/lib/other.ts");
  assert.equal(unmatched, null);
});

test("a specifier rule nested under a parentURL guard inherits the guard", () => {
  const rules = parseWiring(`registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes("/admin/navigation/view.ts")) {
      if (specifier === "next-intl/server") return { url: "mock:nav-loader-intl", shortCircuit: true };
    }
    if (specifier === "other") return { url: "mock:other", shortCircuit: true };
    return nextResolve(specifier, context);
  },
});`);
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0].parent, { kind: "substr", value: "/admin/navigation/view.ts" });
  assert.equal(rules[0].mock, "nav-loader-intl");
  // An unrelated importer must not route to the scoped mock: without the
  // outer guard this rule over-mocks every next-intl/server edge and forges
  // needs (getLocale) the mock never serves at runtime.
  assert.equal(matchRule(rules, "next-intl/server", "file:///x/web/lib/analytics/other.ts"), null);
  assert.equal(matchRule(rules, "next-intl/server", "file:///x/admin/navigation/view.ts")?.mock, "nav-loader-intl");
  assert.deepEqual(rules[1].parent, { kind: "any" });
});

test("||-chained specifier alternatives each become a rule", () => {
  const rules = parseWiring(`registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../../../lib/authz" || specifier === "../../../../lib/authz") {
      return { url: "mock:authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});`);
  assert.equal(rules.length, 2);
  // Without the second disjunct the ../../../../lib/authz edge stays
  // falsely real and forges a request-org exposure chain through it.
  assert.equal(matchRule(rules, "../../../../lib/authz", "file:///x/route.ts")?.mock, "authz");
  assert.equal(matchRule(rules, "../../../lib/authz", "file:///x/route.ts")?.mock, "authz");
});

test("parentURL-first wirings scope the rule and cut data-shimmed edges", () => {
  const rules = parseWiring(`registerHooks({resolve(specifier,context,next){
 if(context.parentURL?.includes('/api/assets/') && specifier.endsWith('/lib/feature-gates'))return {shortCircuit:true,url:'data:text/javascript,export async function guardFeaturePermission(){return null}'};
 if(decodeURIComponent(context.parentURL ?? '').endsWith('/api/assets/[id]/route.ts') && specifier.endsWith('/depreciation.ts'))return {shortCircuit:true,url:'data:text/javascript,export async function buildAllSchedulesWithRunner(){ }'};
 return next(specifier,context);
}});`);
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0].parent, { kind: "substr", value: "/api/assets/" });
  assert.deepEqual(rules[1].parent, { kind: "suffix", value: "/api/assets/[id]/route.ts" });
  // A LITERAL data: stub that declares exports is a mock body, not an opaque
  // cut. This used to assert `mock === null` — the edge was cut and its export
  // set never compared — which is how a stub exporting only `groupTabs` served
  // a module importing `customerGroupTabs`: the module failed to LINK and the
  // whole test file registered ZERO tests instead of failing. The body is now
  // keyed by its own source so needs land on it.
  assert.ok(rules[0].mock?.startsWith("data:export async function guardFeaturePermission"));
  // An unrelated importer of the same specifier must not be cut: without the
  // parent constraint every feature-gates edge in the repo would vanish.
  assert.equal(matchRule(rules, "./lib/feature-gates", "file:///x/other.ts"), null);
  assert.ok(matchRule(rules, "./lib/feature-gates", "file:///x/api/assets/route.ts")?.mock);
});

test("a literal data: stub is compared, so a missing export is a gap", () => {
  // The behaviour the cut used to hide, asserted directly: the stub declares
  // `groupTabs`, the importer needs `customerGroupTabs`.
  const rules = parseWiring(`registerHooks({resolve(specifier,context,next){
 if(specifier.endsWith('/group-tabs'))return {shortCircuit:true,url:'data:text/javascript,export async function groupTabs(){return []}'};
 return next(specifier,context);
}});`);
  assert.equal(rules.length, 1);
  const rule = matchRule(rules, "../components/module-home/group-tabs", "file:///x/ar/view.ts");
  assert.ok(rule, "the rule matches the importer");
  assert.equal(rule.mock, "data:export async function groupTabs(){return []}");
});

test("a data: stub built from a template still cuts, because it cannot be read", () => {
  // The projection blanks template TEXT, so only the backtick survives. A rule
  // must still be produced and must still cut — dropping it entirely let the
  // walk descend into the REAL module and report a false gap against a stub
  // that was in fact serving it.
  const rules = parseWiring(`registerHooks({resolve(specifier,context,next){
 if(specifier === '../subsidiaries')return {shortCircuit:true,url:\`data:text/javascript,\${encodeURIComponent(src)}\`};
 return next(specifier,context);
}});`);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].mock, null);
});

test("||-chained parent alternatives each scope the rule", () => {
  const rules = parseWiring(`registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier === "../../../../lib/authz" || specifier === "../../../../lib/projects-gate")
      && (context.parentURL?.includes("projects/duplicates") || context.parentURL?.includes("projects/merge"))
    ) {
      return { url: "mock:authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});`);
  assert.equal(rules.length, 4);
  // The merge-route importer matches through the second parent alternative:
  // without it the edge stays falsely real and forges an exposure chain.
  assert.equal(matchRule(rules, "../../../../lib/authz", "file:///x/projects/merge/route.ts")?.mock, "authz");
  assert.equal(matchRule(rules, "../../../../lib/authz", "file:///x/projects/duplicates/route.ts")?.mock, "authz");
  assert.equal(matchRule(rules, "../../../../lib/projects-gate", "file:///x/projects/merge/route.ts")?.mock, "authz");
  assert.equal(matchRule(rules, "../../../../lib/authz", "file:///x/other/route.ts"), null);
});

test("stub-factory consequences cut the edge with no mock needs", () => {
  const rules = parseWiring(`const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}');
    if (specifier === '../../../../lib/feature-gates') return virtual(\`
      export async function guardFeaturePermission() { return null; }
    \`);
    return next(specifier, context);
  },
});`);
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0].spec, { kind: "exact", value: "server-only" });
  assert.equal(rules[0].mock, null);
  assert.deepEqual(rules[1].spec, { kind: "exact", value: "../../../../lib/feature-gates" });
  assert.equal(rules[1].mock, null);
});

test("a dynamically-reached missing export warns instead of failing", () => {
  const root = fixture({
    "engine/src/db.ts": DB,
    "web/lib/subs.ts": SUBS,
    "web/app/route.test.ts": mockTest("      export function registerRequestOrgResolver() {}\n", MAP_WIRING),
    "web/app/route.ts": `import { db } from "@openbooks/engine/src/db.ts";
export async function GET(flag) {
  if (flag) {
    const { subsidiaryOptions } = await import("../lib/subs.ts");
    await subsidiaryOptions();
  }
  return db;
}
`,
  });
  const result = checkFile(join(root, "web/app/route.test.ts"), root);
  assert.deepEqual(result.gaps, []);
  assert.equal(result.lazy.length, 1);
  assert.deepEqual(result.lazy[0].names, ["withBypassContext"]);
});

test("mock blocks the wiring cannot model fail closed as unmodeled", () => {
  const root = fixture({
    "engine/src/db.ts": DB,
    "web/app/route.test.ts": `import { registerHooks } from "node:module";
import test from "node:test";
function customResolve(specifier, context, nextResolve) {
  if (String(specifier).includes("db")) return { url: "mock:db", shortCircuit: true };
  return nextResolve(specifier, context);
}
const mockSources = new Map([["mock:db", "export const db = {};"]]);
const hooks = registerHooks({ resolve: customResolve });
const { GET } = await import("./route.ts?t");
hooks.deregister();
test("route loads", async () => {});
`,
    "web/app/route.ts": ROUTE,
  });
  const blocks = mockBlocks("const m = new Map([[\"mock:db\", \"export const db = {};\"]]);");
  assert.ok(blocks.has("db"));
  const result = checkFile(join(root, "web/app/route.test.ts"), root);
  assert.equal(result.unmodeled, true);
});

test("the live repository has no mock-surface gaps and no unmodeled wiring", () => {
  const report = checkTree();
  assert.deepEqual(report.gaps, [], `${report.gaps.length} mock-surface gaps:\n${report.gaps.map((gap) => `${gap.file} [mock:${gap.spec}] missing ${gap.names.join(", ")}`).join("\n")}`);
  assert.deepEqual(report.unmodeled, [], `${report.unmodeled.length} unmodeled wirings:\n${report.unmodeled.join("\n")}`);
});
