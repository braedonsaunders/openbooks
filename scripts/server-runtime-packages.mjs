// Workspace packages the production server loads as prebuilt JavaScript.
// One Node module instance per process: Next must not compile these into each
// server layer. The committed package exports stay on TypeScript so tests and
// the dev server keep running against source; the production build points the
// `node` condition at dist for tracing and for the standalone server.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SERVER_RUNTIME_PACKAGES = [
  { name: "@openbooks/engine", dir: "engine" },
  { name: "@openbooks/schema", dir: "schema", schemaPatterns: true },
  { name: "@openbooks/jobs", dir: "packages/jobs" },
  { name: "@openbooks/emails", dir: "packages/emails" },
  { name: "@openbooks/forms-core", dir: "packages/forms-core" },
  { name: "@openbooks/customization", dir: "packages/customization" },
  { name: "@openbooks/pdf", dir: "packages/pdf" },
  { name: "@openbooks/reports", dir: "packages/reports" },
  { name: "@openbooks/networking", dir: "packages/networking" },
];

export const SERVER_RUNTIME_PACKAGE_NAMES = SERVER_RUNTIME_PACKAGES.map((pkg) => pkg.name);

/** Source export path → prebuilt file, preserving the path under src/. */
export function distSpecifier(source) {
  if (typeof source !== "string" || !source.startsWith("./src/") || !source.endsWith(".ts")) {
    return null;
  }
  return `./dist/${source.slice("./src/".length, -3)}.js`;
}

/**
 * Server condition loads prebuilt JS. Development, the React Server
 * condition, and the default condition stay on TypeScript: webpack dev and
 * the client bundle compile source, and the worker bundle does too.
 * `node` is what Next's file tracer and the production process use.
 */
export function conditionalExport(source) {
  const js = distSpecifier(source);
  if (!js) return source;
  return {
    development: source,
    "react-server": source,
    node: js,
    default: source,
  };
}

export function exportSource(target) {
  if (typeof target === "string") return target;
  if (target && typeof target === "object") {
    if (typeof target.development === "string") return target.development;
    if (typeof target.default === "string") return target.default;
  }
  return null;
}

export function packageNameAndSubpath(specifier) {
  const first = specifier.indexOf("/");
  if (!specifier.startsWith("@")) {
    if (first === -1) return { name: specifier, subpath: "." };
    return { name: specifier.slice(0, first), subpath: `.${specifier.slice(first)}` };
  }
  const second = first === -1 ? -1 : specifier.indexOf("/", first + 1);
  if (second === -1) return { name: specifier, subpath: "." };
  return { name: specifier.slice(0, second), subpath: `.${specifier.slice(second)}` };
}

export function matchExportSource(exportsMap, subpath) {
  if (!exportsMap || typeof exportsMap !== "object") return null;
  if (Object.hasOwn(exportsMap, subpath)) return exportSource(exportsMap[subpath]);
  for (const [key, value] of Object.entries(exportsMap)) {
    const star = key.indexOf("*");
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
    const source = exportSource(value);
    if (typeof source === "string") return source.replaceAll("*", matched);
  }
  return null;
}

/** True while the production build has pointed engine exports at dist. */
export function serverRuntimeExportsActive(repoRoot) {
  const manifestPath = join(repoRoot, "engine/package.json");
  if (!existsSync(manifestPath)) return false;
  const money = JSON.parse(readFileSync(manifestPath, "utf8")).exports?.["./money"];
  return typeof money?.node === "string" && money.node.endsWith(".js");
}
