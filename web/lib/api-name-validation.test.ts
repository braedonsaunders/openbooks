import assert from "node:assert/strict";
import { registerHooks } from "node:module";
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

// The convention every name-bearing route follows: a non-string name is
// refused, a string passes through untouched. Per-route wiring (each route
// actually passing its schema to parseJsonBody) is proved behaviourally in
// api/name-boundary.integration.test.ts, which drives all eight routes.
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

test("the shared name boundary rejects non-string JSON values", async () => {
  for (const value of [null, 0, false, {}, []]) {
    const parsed = await parseJsonBody(jsonRequest({ name: value }), nameBodySchema);
    assert.equal(parsed.ok, false, `expected ${JSON.stringify(value)} to be rejected`);
  }
  const parsed = await parseJsonBody(jsonRequest({ name: "  Field rates  " }), nameBodySchema);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.data.name, "  Field rates  ");
});
