// Next's file tracer does not walk the prebuilt server runtime. This copies
// those packages, their dist trees, and their production dependencies into the
// standalone output so Node can load the same files the build externalized.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_RUNTIME_PACKAGES } from "./server-runtime-packages.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const standalone = join(root, "web", process.env.NEXT_DIST_DIR || ".next", "standalone");

function readManifest(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

function dependencyNames(manifest) {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ];
}

function copyRuntimePackage(pkg) {
  const source = join(root, pkg.dir);
  const destination = join(standalone, pkg.dir);
  if (!existsSync(join(source, "dist"))) {
    throw new Error(`standalone runtime copy: ${pkg.dir}/dist is missing`);
  }
  mkdirSync(destination, { recursive: true });
  cpSync(join(source, "package.json"), join(destination, "package.json"));
  cpSync(join(source, "dist"), join(destination, "dist"), { recursive: true, dereference: true });
  const link = join(standalone, "node_modules", pkg.name);
  mkdirSync(dirname(link), { recursive: true });
  rmSync(link, { recursive: true, force: true });
  symlinkSync(relative(dirname(link), destination), link);
}

function copyDependency(name, seen) {
  if (seen.has(name) || name.startsWith("@openbooks/")) return;
  seen.add(name);
  const source = join(root, "node_modules", name);
  if (!existsSync(source)) return;
  const destination = join(standalone, "node_modules", name);
  if (!existsSync(destination)) {
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
  let manifest;
  try {
    manifest = readManifest(source);
  } catch {
    return;
  }
  for (const dependency of dependencyNames(manifest)) copyDependency(dependency, seen);
}

export function copyStandaloneRuntime() {
  if (!existsSync(standalone)) {
    throw new Error(`standalone runtime copy: ${standalone} does not exist`);
  }
  const seen = new Set();
  for (const pkg of SERVER_RUNTIME_PACKAGES) {
    copyRuntimePackage(pkg);
    for (const dependency of dependencyNames(readManifest(join(root, pkg.dir)))) {
      copyDependency(dependency, seen);
    }
  }
  console.log(`Copied the prebuilt server runtime into ${standalone}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  copyStandaloneRuntime();
}
