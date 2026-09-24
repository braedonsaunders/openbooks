import assert from "node:assert/strict";
import test from "node:test";
import { HI_CERTIFICATE } from "./hi.ts";
import { resolvedCertificate } from "./conformance-support.ts";
import { requireMilitarySpouseEligibility } from "./military-spouse.ts";

const requirements = [
  { key: "servicemember_present_under_orders", description: "the servicemember is in Hawaii under orders" },
  { key: "spouse_present_to_accompany", description: "the spouse is in Hawaii to accompany them" },
  { key: "same_non_hawaii_domicile", description: "they share a domicile outside Hawaii" },
] as const;

test("military-spouse exemption guard requires a filed certificate", () => {
  const certificate = resolvedCertificate(HI_CERTIFICATE, {
    filing_status: "nonresident_military_spouse",
    servicemember_present_under_orders: "true",
    spouse_present_to_accompany: "true",
    same_non_hawaii_domicile: "true",
  });
  assert.throws(
    () => requireMilitarySpouseEligibility({ ...certificate, onFile: false }, "Hawaii", requirements),
    /Hawaii military-spouse withholding exemption requires the filed state exemption certificate/,
  );
});

test("military-spouse exemption guard names every unproven eligibility fact", () => {
  const certificate = resolvedCertificate(HI_CERTIFICATE, {
    filing_status: "nonresident_military_spouse",
    servicemember_present_under_orders: "true",
  });
  assert.throws(
    () => requireMilitarySpouseEligibility(certificate, "Hawaii", requirements),
    /Hawaii military-spouse withholding exemption requires proof that the spouse is in Hawaii to accompany them; they share a domicile outside Hawaii/,
  );
});

test("military-spouse exemption guard accepts the complete state-specific evidence set", () => {
  const certificate = resolvedCertificate(HI_CERTIFICATE, {
    filing_status: "nonresident_military_spouse",
    servicemember_present_under_orders: "true",
    spouse_present_to_accompany: "true",
    same_non_hawaii_domicile: "true",
  });
  assert.doesNotThrow(() => requireMilitarySpouseEligibility(certificate, "Hawaii", requirements));
});
