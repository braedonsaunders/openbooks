import assert from "node:assert/strict";
import test from "node:test";

// The live return-window clamp is clampTaxReturnWindowInSnapshot in
// tax-returns/return.ts (fail-closed when sibling registrations share a
// form). An earlier exported twin here, clampTaxReturnWindow, .find()ed the
// first calendar match and silently clamped, diverging from the live one. It
// is deleted; this pins the module surface so the twin cannot return.
test("nexus-ledger exposes the filing calendar but no window clamp", async () => {
  const mod = (await import("./nexus-ledger.ts")) as Record<string, unknown>;
  assert.equal(typeof mod["loadOrgFilingCalendar"], "function");
  assert.equal(mod["clampTaxReturnWindow"], undefined);
});
