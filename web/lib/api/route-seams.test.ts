import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only")
      return { shortCircuit: true, url: "data:text/javascript,export{}" };
    return next(specifier, context);
  },
});

// Next.js gives request handlers their own module graph, so hooks installed
// by instrumentation never reach them. This process stands in for that graph:
// nothing has installed the engine seams before the first request.
test("the first request through the route factory installs the posting hooks in its module graph", async () => {
  const { engineSeamsInstalled } = await import("@openbooks/engine/composition/install");
  assert.equal(engineSeamsInstalled(), false);

  const priorRuntime = process.env.NEXT_RUNTIME;
  process.env.NEXT_RUNTIME = "nodejs";
  try {
    const { NextResponse } = await import("next/server");
    const { defineRoute } = await import("./route");
    const handler = defineRoute({
      authorize: async () => NextResponse.json({ error: "unauthorized" }, { status: 401 }),
      feature: { none: "Regression probe for request-graph seam installation." },
    });
    const response = await handler(new Request("http://localhost/probe"));
    assert.equal(response.status, 401);
  } finally {
    if (priorRuntime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = priorRuntime;
  }

  assert.equal(engineSeamsInstalled(), true);
});
