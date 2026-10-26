import { readFileSync } from "node:fs";

/** Test loaders resolve exactly the same explicit contracts as the package runtime. */
const engineRoot = new URL("../../engine/", import.meta.url);
const engineExports = (
  JSON.parse(readFileSync(new URL("package.json", engineRoot), "utf8")) as {
    exports: Record<string, string>;
  }
).exports;
const prefix = "@openbooks/engine/";

export function resolveEngineSpecifier(specifier: string): string | null {
  if (!specifier.startsWith(prefix)) return null;
  const mapped = engineExports[`./${specifier.slice(prefix.length)}`];
  return typeof mapped === "string" ? new URL(mapped, engineRoot).href : null;
}

/** Aliases of one contract retain the same test double and module identity. */
export function canonicalEngineSpecifier(specifier: string): string | null {
  if (!specifier.startsWith(prefix)) return null;
  const mapped = engineExports[`./${specifier.slice(prefix.length)}`];
  if (typeof mapped !== "string") return null;
  const canonical = Object.entries(engineExports).find(([, target]) => target === mapped);
  return canonical ? `${prefix}${canonical[0].slice(2)}` : null;
}

/** One native module keeps one transport double across aliases and relative imports. */
export function isEngineModuleImport(
  specifier: string,
  parentURL: string | undefined,
  target: string,
): boolean {
  const expected = resolveEngineSpecifier(target);
  if (!expected) return false;
  if (resolveEngineSpecifier(specifier) === expected) return true;
  return Boolean(
    parentURL?.startsWith("file:") &&
    specifier.startsWith(".") &&
    new URL(specifier, parentURL).href === expected,
  );
}
