import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { parseJsonBody } = await import("./api/json");

const webRoot = join(import.meta.dirname, "..");
const oidcStartPath = join(webRoot, "app/api/auth/oidc/start/route.ts");
const affectedRoutes = [
  "app/api/accounts/[id]/route.ts",
  "app/api/customization/form-layouts/[id]/route.ts",
  "app/api/customization/list-views/[id]/route.ts",
  "app/api/insights/cards/[id]/route.ts",
  "app/api/insights/dashboards/[id]/route.ts",
  "app/api/labor-rate-cards/[id]/route.ts",
  "app/api/labor-rate-cards/route.ts",
  "app/api/projects/[id]/route.ts",
] as const;

const nameBodySchema = z.looseObject({
  name: z.string().optional(),
});

function jsonRequest(body: unknown): Request {
  return new Request("http://openbooks.test", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("name-bearing API routes use the shared zod name boundary", () => {
  for (const relativePath of affectedRoutes) {
    const source = readFileSync(join(webRoot, relativePath), "utf8");
    assert.match(source, /parseJsonBody\(/, relativePath);
    const schemaSource = source.match(/z\.looseObject\(\s*(\{[\s\S]*?\})\s*\)/)?.[1];
    assert.ok(schemaSource, `${relativePath} must declare the shared name schema`);
    assert.match(
      schemaSource,
      /name:\s*z\.string\(\)\.optional\(\)/,
      `${relativePath} must validate name as a string`,
    );
    assert.match(
      source,
      /parseJsonBody\(\s*[^,]+,\s*(?:nameBodySchema|patchBodySchema)\s*\)/,
      `${relativePath} must pass the name schema to the shared parser`,
    );
    assert.doesNotMatch(
      source,
      /parseJsonBody\(\s*[^,]+,\s*jsonObject\s*\)/,
      `${relativePath} must not pass the untyped jsonObject boundary`,
    );
  }
});

test("the shared name boundary rejects non-string JSON values", async () => {
  for (const value of [null, 0, false, {}, []]) {
    const parsed = await parseJsonBody(jsonRequest({ name: value }), nameBodySchema);
    assert.equal(parsed.ok, false, `expected ${JSON.stringify(value)} to be rejected`);
  }
  const parsed = await parseJsonBody(jsonRequest({ name: "  Field rates  " }), nameBodySchema);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.data.name, "  Field rates  ");
});

test("OIDC start applies same-origin validation before persisting its return path", () => {
  const source = readFileSync(oidcStartPath, "utf8");
  assert.match(source, /const candidate = safeReturnTo\(value\)/);
  assert.match(source, /new URL\(candidate, appOrigin\)\.origin === appOrigin/);
  assert.match(source, /beginOidcAuthorization\(safeOidcNext\(/);
});
