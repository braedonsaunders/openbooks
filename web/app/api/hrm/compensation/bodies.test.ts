import assert from "node:assert/strict";
import test from "node:test";

// F3-39: the band/cycle/line amount schema accepts what a typed client
// serializes — a JSON number or a numeric string — and canonicalizes it
// through the exact-decimal grammar. A naive string-only regex rejected JSON
// numbers and canonical spellings like ".5" before the money parser ran.
process.env.OPENBOOKS_DB_URL = "";
process.env.OPENBOOKS_MIGRATION_DB_URL = "";

const { createBandBody } = await import("./bodies.ts");

const BAND = {
  levelId: "11111111-1111-4111-8111-111111111111",
  currency: "USD",
  basis: "annual",
  min: "50000",
  target: "65000",
  max: "80000",
  effectiveFrom: "2026-01-01",
  reason: "annual ladder",
};

test("band amounts accept JSON numbers and canonicalize them", () => {
  const parsed = createBandBody.safeParse({ ...BAND, min: 50000, target: 65000.5, max: "080000.00" });
  if (!parsed.success) assert.fail(JSON.stringify(parsed.error.issues));
  assert.equal(parsed.data.min, "50000");
  assert.equal(parsed.data.target, "65000.5");
  assert.equal(parsed.data.max, "80000");
});

test("band amounts accept canonical spellings the naive regex rejected", () => {
  const parsed = createBandBody.safeParse({ ...BAND, min: ".5", target: " 65000 ", max: "+80000" });
  if (!parsed.success) assert.fail(JSON.stringify(parsed.error.issues));
  assert.equal(parsed.data.min, "0.5");
});

test("band amounts refuse the unconfigured by name with a remedy", () => {
  for (const [min, needle] of [
    ["12,34", "decimal point"],
    ["1,234", "ambiguous"],
    ["abc", "not a number"],
    ["10.12345", "at most 4 decimal places"],
  ] as Array<[unknown, string]>) {
    const parsed = createBandBody.safeParse({ ...BAND, min });
    if (parsed.success) assert.fail(`min ${String(min)} must be refused`);
    const issue = parsed.error.issues.find((i) => i.path.join(".") === "min");
    assert.ok(issue, `refusal names the min path for ${String(min)}`);
    assert.match(issue!.message, new RegExp(needle), `remedy for ${String(min)}: ${issue!.message}`);
  }
});

test("band amounts refuse zero, negatives, and non-scalars", () => {
  for (const min of [0, -5, "0", "-12.5", true, null, {}]) {
    const parsed = createBandBody.safeParse({ ...BAND, min: min as never });
    if (parsed.success) assert.fail(`min ${String(min)} must be refused`);
  }
});
