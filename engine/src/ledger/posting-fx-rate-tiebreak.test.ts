import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./posting-subsidiaries.ts", import.meta.url), "utf8");

// The posting engine's spot lookup lives in ../fx/spot-rate.ts (lookupSpotRate:
// direct-or-inverse with the direct row winning same-date ties). The kernel
// must delegate to it rather than carry its own copy of the union query — a
// second copy is how one pair/date converts alike amounts at two rates. The
// tiebreak itself is pinned behaviourally in ../fx/spot-rate.integration.test.ts;
// this test pins the delegation so a re-inlined query fails loudly.
test("posting spot lookup delegates to the shared FX lookup", () => {
  const start = source.indexOf("const functionalRate");
  assert.ok(start >= 0, "functionalRate is defined");
  const end = source.indexOf("const stamped", start);
  const body = source.slice(start, end >= 0 ? end : undefined);
  assert.match(body, /lookupSpotRate\(runner, doc\.orgId, doc\.currency, targetCurrency, postingDate\)/);
  assert.doesNotMatch(body, /from fx_rates/);
});
