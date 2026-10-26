import assert from "node:assert/strict";
import test from "node:test";
import { journalAmortizationInput } from "./journal-amortization";

test("journal boundaries preserve template identity and valid service dates", () => {
  const line = {
    amortizationTemplateId: "e13a576f-71e7-4cdb-9924-c1fa94816aaf",
    amortizationStartOn: "2028-02-29",
    amortizationEndOn: "2028-12-31",
  };
  assert.deepEqual(journalAmortizationInput.parse(line), line);
  assert.deepEqual(journalAmortizationInput.parse({ amortizationTemplateId: null }), {
    amortizationTemplateId: null,
  });
});

test("journal boundaries refuse malformed template identities and impossible dates", () => {
  assert.equal(
    journalAmortizationInput.safeParse({ amortizationTemplateId: "other-org-key" }).success,
    false,
  );
  assert.equal(
    journalAmortizationInput.safeParse({ amortizationStartOn: "2027-02-29" }).success,
    false,
  );
});
