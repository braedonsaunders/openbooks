import assert from "node:assert/strict";
import test from "node:test";
import { SAMPLE_COMPANY_PROFILES } from "./catalog.ts";
import { getProfile } from "../sim/profiles/index.ts";

const setupIndustries = [
  "general_business",
  "construction_contractor",
  "professional_services",
  "engineering_architecture",
  "it_software_saas",
  "accounting_firm",
  "wholesale_distribution",
  "property_management",
  "nonprofit",
  "manufacturing",
  "healthcare_practice",
];

test("sample catalog covers every setup industry exactly once", () => {
  assert.deepEqual(
    SAMPLE_COMPANY_PROFILES.map((profile) => profile.industryKey).sort(),
    [...setupIndustries].sort(),
  );
  assert.equal(new Set(SAMPLE_COMPANY_PROFILES.map((profile) => profile.profileId)).size, setupIndustries.length);
  assert.equal(new Set(SAMPLE_COMPANY_PROFILES.map((profile) => profile.companyName)).size, setupIndustries.length);
});

test("every sample profile describes meaningful data coverage", () => {
  for (const profile of SAMPLE_COMPANY_PROFILES) {
    const simulator = getProfile(profile.profileId);
    assert.ok(profile.companyName.length >= 8, profile.industryKey);
    assert.ok(profile.focus.length >= 3, profile.industryKey);
    assert.equal(simulator.name, profile.companyName, profile.industryKey);
    assert.ok(simulator.customers.length >= 4, profile.industryKey);
    assert.ok(simulator.vendors.length >= 5, profile.industryKey);
    for (const customer of simulator.customers) {
      const probability = Object.values(customer.payment).reduce((sum, value) => sum + value, 0);
      assert.ok(Math.abs(probability - 1) < 1e-9, `${profile.industryKey}: ${customer.name}`);
    }
  }
});
