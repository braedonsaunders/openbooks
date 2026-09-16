import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { EMAIL_TOKEN_TTL_MS } from "@openbooks/engine/src/flows/email-tokens.ts";

const hooks = registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, _context);
  },
});

const { GET } = (await import("./route.ts")) as typeof import("./route.ts");
hooks.deregister();

// The invalid-link page must state the approval link's real lifetime, derived
// from the configured token TTL — never a hardcoded duration that can drift
// from it (it once claimed 7 days while tokens died after 72 hours). The
// invalid-token path touches no database, so no further mocks are needed.
test("an invalid approval link states the configured token lifetime", async () => {
  const res = await GET(new Request("http://localhost/api/flows/email-action?token=not-a-token"));
  assert.equal(res.status, 400);
  const html = await res.text();
  const hours = EMAIL_TOKEN_TTL_MS / 3_600_000;
  const expected =
    Number.isInteger(hours) && hours % 24 === 0 ? `${hours / 24} days` : `${hours} hours`;
  assert.ok(
    html.includes(`expire after ${expected}`),
    `expected TTL-derived copy ("expire after ${expected}"), got: ${html.slice(0, 300)}`,
  );
  assert.ok(!html.includes("7 days"), "stale hardcoded expiry must not appear");
});
