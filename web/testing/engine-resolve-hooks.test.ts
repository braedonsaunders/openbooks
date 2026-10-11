import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalEngineSpecifier, resolveEngineSpecifier } from "./engine-resolve-hooks.ts";

const engineRoot = new URL("../../engine/", import.meta.url);
const engineExports = JSON.parse(readFileSync(new URL("package.json", engineRoot), "utf8")).exports as Record<string, string>;

test("every named contract resolves to the package target without changing module identity", () => {
  for (const [subpath, target] of Object.entries(engineExports)) {
    const specifier = `@openbooks/engine/${subpath.slice(2)}`;
    assert.equal(resolveEngineSpecifier(specifier), new URL(target, engineRoot).href);
    assert.equal(resolveEngineSpecifier(canonicalEngineSpecifier(specifier)!), resolveEngineSpecifier(specifier));
    assert.equal(import.meta.resolve(specifier), resolveEngineSpecifier(specifier));
  }
});

test("implementation paths and unknown contracts are inaccessible to test loaders and Node", () => {
  for (const specifier of [
    "@openbooks/engine/src/platform/db.ts",
    "@openbooks/engine/src/billing/entitlements.ts",
    "@openbooks/engine/no-such-contract",
    "@openbooks/engine/money?unit-test",
    "@openbooks/engine/../web/lib/auth.ts",
  ]) {
    assert.equal(resolveEngineSpecifier(specifier), null);
    assert.equal(canonicalEngineSpecifier(specifier), null);
    // Run native resolution without an inherited TypeScript loader, which may
    // deliberately support filesystem fallback for development.
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      assert.throws(() => import.meta.resolve(${JSON.stringify(specifier)}), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    `], { cwd: new URL("../../", import.meta.url) });
  }
  assert.equal(resolveEngineSpecifier("drizzle-orm"), null);
  assert.equal(resolveEngineSpecifier("@openbooks/engine"), null);
});
