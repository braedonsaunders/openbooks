#!/usr/bin/env node
/**
 * Route permission-coverage ratchet: every non-public API route must be
 * built on the factory (`defineRoute` from `web/lib/api/route.ts`), which
 * is what proves it declares a permission and a feature. For each route
 * file under `web/app/api` the check accepts exactly three states:
 *
 *   - the file imports `defineRoute` from the factory;
 *   - its URL path is public under `web/lib/proxy-policy.ts` (sessionless
 *     by design: API keys, webhooks, signing links — declared there,
 *     nowhere else);
 *   - its path is listed in `scripts/route-factory.baseline.json`, the
 *     shrink-only ledger of routes the factory shards have not migrated yet.
 *
 * Two import counts ratchet alongside it: routes importing the loose
 * `jsonObject` body schema and routes importing the `sql` tag both shrink
 * as shards land, so either count growing fails the build. A factory route
 * whose feature is `{ none: "" }` fails too; the surviving `{ none }`
 * routes print as a review list.
 *
 *   node scripts/check-route-permission-coverage.mjs                  check
 *   node scripts/check-route-permission-coverage.mjs --write-baseline  reseed
 *     the ledger from the current tree (landing and shard updates only).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const requireFromRoot = createRequire(new URL("../package.json", import.meta.url));
const ts = requireFromRoot("typescript");

const SELF = "scripts/check-route-permission-coverage.mjs";
const BASELINE_PATH = "scripts/route-factory.baseline.json";
const API_PREFIX = "web/app/api/";
const FACTORY_SUFFIX = "web/lib/api/route.ts";

function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

function parse(sourceText, file) {
  return ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Named import `name` from a module whose specifier matches `test`. */
function hasNamedImport(source, name, test) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && test(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        found = bindings.elements.some((element) => (element.propertyName ?? element.name).text === name);
      }
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function factorySpecifier(fileDir) {
  const target = join(repoRoot(), FACTORY_SUFFIX);
  return (specifier) => {
    if (specifier === "@/lib/api/route") return true;
    if (!specifier.startsWith(".")) return false;
    const resolved = resolve(repoRoot(), fileDir, specifier);
    return resolved === target || `${resolved}.ts` === target;
  };
}

function jsonSpecifier(specifier) {
  return specifier === "@/lib/api/json" || specifier.endsWith("/lib/api/json") || specifier === "./json";
}

/**
 * Per-file import facts, from source text alone (tests pass inline
 * sources; the repository tree is only read by main()).
 */
export function analyzeImports(sourceText, fileDir) {
  const source = parse(sourceText, "route.ts");
  return {
    defineRoute: hasNamedImport(source, "defineRoute", factorySpecifier(fileDir)),
    jsonObject: hasNamedImport(source, "jsonObject", jsonSpecifier),
    sql: hasNamedImport(source, "sql", (specifier) => specifier === "drizzle-orm"),
  };
}

/** Every `defineRoute({...})` call's feature declaration. */
export function findRouteFeatures(sourceText) {
  const source = parse(sourceText, "route.ts");
  const calls = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineRoute" &&
      node.arguments.length > 0 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const literal = node.arguments[0];
      const prop = (name) => literal.properties.find((property) =>
        ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === name);
      const feature = prop("feature");
      const entry = { hasPublic: prop("public") !== undefined, hasFeature: feature !== undefined, noneReason: null, noneEmpty: false };
      if (feature && ts.isObjectLiteralExpression(feature.initializer)) {
        const none = feature.initializer.properties.find((property) =>
          ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === "none");
        if (none) {
          entry.noneReason = ts.isStringLiteral(none.initializer) ? none.initializer.text : "<non-literal>";
          entry.noneEmpty = ts.isStringLiteral(none.initializer) && none.initializer.text.trim() === "";
        }
      }
      calls.push(entry);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

function unwrap(node) {
  while (
    node &&
    (ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node))
  ) {
    node = node.expression;
  }
  return node;
}

function stringSet(node) {
  const values = [];
  const unwrapped = unwrap(node);
  const list =
    unwrapped && ts.isNewExpression(unwrapped)
      ? unwrapped.arguments?.[0]
      : unwrapped;
  const elements = list && ts.isArrayLiteralExpression(list) ? list.elements : [];
  for (const element of elements) {
    if (ts.isStringLiteral(element)) values.push(element.text);
  }
  return values;
}

/** The public surface, parsed from proxy-policy source (never duplicated). */
export function loadPublicSurface(proxySourceText) {
  const source = parse(proxySourceText, "proxy-policy.ts");
  let exact = [];
  let roots = [];
  const visit = (node) => {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        if (declaration.name.text === "EXACT_PUBLIC_PATHS") exact = stringSet(declaration.initializer);
        if (declaration.name.text === "PUBLIC_SEGMENT_ROOTS") roots = stringSet(declaration.initializer);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { exact, roots };
}

export function isPublicRoute(urlPath, surface) {
  if (surface.exact.includes(urlPath)) return true;
  return surface.roots.some((root) => urlPath === root || urlPath.startsWith(`${root}/`));
}

function routeUrlPath(file) {
  return `/api/${file.slice(API_PREFIX.length, -"/route.ts".length)}`;
}

function discoverRoutes(root = repoRoot()) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean)
    .filter((file) => file.startsWith(API_PREFIX) && file.endsWith("/route.ts"));
}

function readBaseline(root) {
  const path = join(root, BASELINE_PATH);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function snapshot(root) {
  const proxySource = readFileSync(join(root, "web/lib/proxy-policy.ts"), "utf8");
  const surface = loadPublicSurface(proxySource);
  const uncovered = [];
  const noneRoutes = [];
  const featureViolations = [];
  let jsonObjectImporters = 0;
  let sqlImporters = 0;
  for (const file of discoverRoutes(root)) {
    const source = readFileSync(join(root, file), "utf8");
    const fileDir = dirname(file);
    const facts = analyzeImports(source, fileDir);
    if (facts.jsonObject) jsonObjectImporters += 1;
    if (facts.sql) sqlImporters += 1;
    if (facts.defineRoute) {
      for (const call of findRouteFeatures(source)) {
        if (!call.hasPublic && !call.hasFeature) {
          featureViolations.push(`${file}: defineRoute without a feature (the type refuses omission; add a key or { none: "<reason>" })`);
        }
        if (call.noneEmpty) featureViolations.push(`${file}: feature { none: "" } carries no reason`);
        if (call.noneReason !== null && !call.noneEmpty) noneRoutes.push(`${file} ({ none: "${call.noneReason}" })`);
      }
      continue;
    }
    if (isPublicRoute(routeUrlPath(file), surface)) continue;
    uncovered.push(file);
  }
  uncovered.sort();
  noneRoutes.sort();
  return { uncovered, noneRoutes, featureViolations, jsonObjectImporters, sqlImporters };
}

function runCli() {
  const root = repoRoot();
  if (process.argv.includes("--write-baseline")) {
    const current = snapshot(root);
    const baseline = {
      $comment: "Shrink-only ledger for the route-factory migration: every entry is a non-public route still hand-rolling its guards. Shards remove entries as they migrate; nothing here may grow.",
      routes: current.uncovered,
      jsonObjectImporters: current.jsonObjectImporters,
      sqlImporters: current.sqlImporters,
    };
    writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`seeded ${BASELINE_PATH}: ${current.uncovered.length} routes, ${current.jsonObjectImporters} jsonObject importers, ${current.sqlImporters} sql importers.`);
    return;
  }

  const current = snapshot(root);
  const baseline = readBaseline(root);
  if (!baseline) {
    console.error(`missing ${BASELINE_PATH}: seed it with \`node ${SELF} --write-baseline\` at landing.`);
    process.exitCode = 1;
    return;
  }
  const failures = [];
  const baselineSet = new Set(baseline.routes ?? []);
  const currentSet = new Set(current.uncovered);
  for (const file of current.uncovered) {
    if (!baselineSet.has(file)) failures.push(`new uncovered route (use the factory or mark public in proxy-policy): ${file}`);
  }
  for (const file of baseline.routes ?? []) {
    if (!currentSet.has(file)) failures.push(`stale baseline entry (migrated — remove it): ${file}`);
  }
  if (current.jsonObjectImporters !== baseline.jsonObjectImporters) {
    failures.push(`jsonObject importers: tree has ${current.jsonObjectImporters}, baseline pins ${baseline.jsonObjectImporters} (update the ledger as shards land)`);
  }
  if (current.sqlImporters !== baseline.sqlImporters) {
    failures.push(`sql importers: tree has ${current.sqlImporters}, baseline pins ${baseline.sqlImporters} (update the ledger as shards land)`);
  }
  failures.push(...current.featureViolations);
  if (failures.length > 0) {
    console.error(`route permission coverage failed:\n${failures.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(
      `route permission coverage passed (${current.uncovered.length} ledger routes, ` +
      `${current.jsonObjectImporters} jsonObject importers, ${current.sqlImporters} sql importers).`,
    );
  }
  if (current.noneRoutes.length > 0) {
    console.log(`always-on ({ none }) routes under review:\n${current.noneRoutes.join("\n")}`);
  }
}

// Importing this module (unit tests) must not scan the tree; only a direct
// invocation runs the check.
if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
