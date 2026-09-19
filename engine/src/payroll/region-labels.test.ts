import assert from "node:assert/strict";
import test from "node:test";
import {
  PAYROLL_COUNTRY_PACKS,
  installablePayrollPacks,
  payrollRegionLabel,
  type PayrollCountryPack,
} from "./packs.ts";

/**
 * Region pickers must show names, not codes.
 *
 * Observed: the employee Country picker showed GB/DE/FR, the onboarding
 * wizard's nation labels showed GB/ENG/SCT, and AU state pickers showed
 * NSW/VIC/QLD — while the packs declare full names (AU_STATE_NAMES,
 * GB_NATION_NAMES, DE_LAENDER …). The labels existed in a different field
 * from the one the UI reads (`regions.known` is codes-only), so this wires
 * the missing derivation: every pack declares `regions.regionNames` and the
 * UI reads `payrollRegionLabel`.
 */

test("every known region of every pack has a declared display name", () => {
  const missing: string[] = [];
  for (const pack of Object.values(PAYROLL_COUNTRY_PACKS)) {
    for (const code of pack.regions.known) {
      if (!pack.regions.regionNames[code]) missing.push(`${pack.country}/${code}`);
    }
  }
  assert.deepEqual(missing, [], "regions with no declared display name");
});

test("declared region names are what the pickers read", () => {
  assert.equal(payrollRegionLabel("AU", "NSW"), "New South Wales");
  assert.equal(payrollRegionLabel("GB", "SCT"), "Scotland");
  assert.equal(payrollRegionLabel("CA", "QC"), "Québec");
  assert.equal(payrollRegionLabel("DE", "BY"), "Bayern");
});

test("a new pack is picked up with no generic-layer edit (synthetic fifteenth pack)", () => {
  const synthetic: PayrollCountryPack = {
    ...(PAYROLL_COUNTRY_PACKS.CA as PayrollCountryPack),
    country: "XX",
    name: "Synthetica",
    installable: true,
    regions: {
      label: "province",
      known: ["XA", "XB"],
      supported: ["XA", "XB"],
      unsupportedReason: "unused {region}",
      regionNames: { XA: "Xanadu", XB: "Xebec" },
    },
  };
  (PAYROLL_COUNTRY_PACKS as Record<string, PayrollCountryPack>)["XX"] = synthetic;
  try {
    assert.ok(
      installablePayrollPacks().some((pack) => pack.country === "XX" && pack.name === "Synthetica"),
      "the installable list derives from the registry",
    );
    assert.equal(payrollRegionLabel("XX", "XA"), "Xanadu");
    assert.equal(payrollRegionLabel("XX", "XB"), "Xebec");
  } finally {
    delete (PAYROLL_COUNTRY_PACKS as Record<string, PayrollCountryPack>)["XX"];
  }
});
