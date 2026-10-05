import { readFileSync } from "node:fs";

/**
 * One shared resolver for `@openbooks/engine/*` specifiers in web tests.
 *
 * Component, page and route tests run outside the bundler, so a bare engine
 * import needs a filesystem target. The per-test copies used to rewrite only
 * `@openbooks/engine/src/...` by string surgery and left every named
 * contract (`@openbooks/engine/money`, `@openbooks/engine/platform/database`,
 * ...) to ambient resolution, which breaks wherever the workspace link is
 * not on the resolver's path. This resolves every engine specifier the same
 * way: exact entries through the engine package's own `exports` map, and
 * the longer-standing `/src/` implementation paths to the same file the
 * copies reached. Anything else returns null so the caller falls through to
 * the next resolver.
 *
 * Call it inside a test's `resolve` hook before delegating:
 *
 *   const engineUrl = resolveEngineSpecifier(specifier);
 *   if (engineUrl) return nextResolve(engineUrl, context);
 */
const engineRoot = new URL("../../engine/", import.meta.url);
const engineExports = (
  JSON.parse(readFileSync(new URL("package.json", engineRoot), "utf8")) as {
    exports?: Record<string, string>;
  }
).exports ?? {};

export function resolveEngineSpecifier(specifier: string): string | null {
  const prefix = "@openbooks/engine/";
  if (!specifier.startsWith(prefix)) return null;
  const subpath = specifier.slice(prefix.length);
  if (subpath === "" || subpath.includes("?")) return null;
  const mapped = engineExports[`./${subpath}`];
  if (typeof mapped === "string") return new URL(mapped, engineRoot).href;
  // Implementation paths predate the named contracts (the `./src/*` export
  // pattern admits them); keep resolving them to the same file as before.
  if (subpath.startsWith("src/")) return new URL(subpath, engineRoot).href;
  return null;
}
