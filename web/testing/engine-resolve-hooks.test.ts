import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveEngineSpecifier } from "./engine-resolve-hooks.ts";

const engineRoot = new URL("../../engine/", import.meta.url);
const engineExports = (
  JSON.parse(readFileSync(new URL("package.json", engineRoot), "utf8")) as {
    exports?: Record<string, string>;
  }
).exports ?? {};

test("named engine contracts resolve through the package exports map", () => {
  for (const subpath of ["money", "platform/database", "commerce", "billing"]) {
    const target = engineExports[`./${subpath}`];
    assert.ok(typeof target === "string", `engine package exports ./${subpath}`);
    assert.equal(
      resolveEngineSpecifier(`@openbooks/engine/${subpath}`),
      new URL(target, engineRoot).href,
    );
  }
});

test("implementation paths resolve to the same file as before", () => {
  for (const subpath of ["src/platform/db.ts", "src/billing/entitlements.ts"]) {
    const resolved = resolveEngineSpecifier(`@openbooks/engine/${subpath}`);
    assert.equal(resolved, new URL(subpath, engineRoot).href);
    assert.ok(existsSync(fileURLToPath(resolved as string)), `${subpath} exists`);
  }
});

test("unrelated and unknown specifiers fall through to the next resolver", () => {
  assert.equal(resolveEngineSpecifier("drizzle-orm"), null);
  assert.equal(resolveEngineSpecifier("@openbooks/engine"), null);
  assert.equal(resolveEngineSpecifier("@openbooks/engine/no-such-contract"), null);
  assert.equal(resolveEngineSpecifier("@openbooks/engine/money?unit-test"), null);
});
