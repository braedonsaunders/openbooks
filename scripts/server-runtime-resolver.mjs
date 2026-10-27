// next start resolves external @openbooks/* imports. After the build restores
// TypeScript exports, this hook loads the prebuilt files when they exist.
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SERVER_RUNTIME_PACKAGES,
  distSpecifier,
  matchExportSource,
  packageNameAndSubpath,
} from "./server-runtime-packages.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const byName = new Map(SERVER_RUNTIME_PACKAGES.map((pkg) => [pkg.name, pkg]));
const manifests = new Map();

function manifestOf(pkg) {
  if (!manifests.has(pkg.name)) {
    manifests.set(pkg.name, JSON.parse(readFileSync(join(root, pkg.dir, "package.json"), "utf8")));
  }
  return manifests.get(pkg.name);
}

function runtimeFile(specifier) {
  const { name, subpath } = packageNameAndSubpath(specifier);
  const pkg = byName.get(name);
  if (!pkg) return null;
  const manifest = manifestOf(pkg);
  let source = matchExportSource(manifest.exports, subpath);
  if (!source && subpath === "." && typeof manifest.main === "string") {
    source = manifest.main.startsWith("./") ? manifest.main : `./${manifest.main}`;
  }
  if (!source && subpath.startsWith("./")) source = subpath;
  const js = source ? distSpecifier(source) : null;
  if (!js) return null;
  const abs = join(root, pkg.dir, js);
  return existsSync(abs) ? pathToFileURL(abs).href : null;
}

registerHooks({
  resolve(specifier, context, next) {
    const file = runtimeFile(specifier);
    if (file) return next(file, context);
    return next(specifier, context);
  },
});
