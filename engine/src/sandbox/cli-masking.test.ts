import assert from "node:assert/strict";
import test from "node:test";
import { resolveCreateMasking } from "./cli-masking.ts";

test("tier decides masking when --masked is absent", () => {
  assert.equal(resolveCreateMasking("masked", undefined), true);
  assert.equal(resolveCreateMasking("full", undefined), false);
  assert.equal(resolveCreateMasking("dev", undefined), false);
  assert.equal(resolveCreateMasking("as_of", undefined), false);
});

test("an explicit --masked agreeing with its tier is honoured", () => {
  assert.equal(resolveCreateMasking("masked", "true"), true);
  assert.equal(resolveCreateMasking("full", "false"), false);
});

test("an explicit --masked contradicting its tier is refused by name", () => {
  // C-48: --tier=full --masked=true used to be silently ignored, handing an
  // UNMASKED full clone with live PII to an operator who asked for masking.
  assert.throws(() => resolveCreateMasking("full", "true"), /--masked=true requires --tier=masked/);
  assert.throws(() => resolveCreateMasking("dev", "true"), /--masked=true requires --tier=masked/);
  assert.throws(() => resolveCreateMasking("as_of", "true"), /--masked=true requires --tier=masked/);
  // ...and --masked=false on the masked tier would silently unmask a tier
  // whose whole meaning is scrubbed PII.
  assert.throws(() => resolveCreateMasking("masked", "false"), /--masked=false contradicts --tier=masked/);
});
