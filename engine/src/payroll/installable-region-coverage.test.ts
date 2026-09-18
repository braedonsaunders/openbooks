/**
 * An installable pack must withhold for somebody.
 *
 * `installable: true` is the pack's claim that a tenant can provision this
 * country and run a payroll. `regions.supported` is the list of regions whose
 * income tax the engine computes end to end, and the generic gate
 * `assertPayrollRegionSupported` (packs.ts) — wired into every run at
 * payroll-run.ts:3413 — throws for any region NOT in it. So a pack that is
 * installable with `supported: []` is installable for nobody: provisioning
 * succeeds, then the first employee throws.
 *
 * France shipped exactly that. `regions.supported` was correctly emptied at
 * the skeleton stage by finding F-fr-001, when PAS genuinely did not compute;
 * the grille then landed, `withholding().regions[0].implemented` flipped to
 * true and the pack flipped to `installable: true`, and nobody reopened the
 * guard that the earlier finding had closed. Both halves were locally
 * defensible and the pair was wrong, which is why this asserts the RELATION
 * between the two fields rather than either field's value.
 *
 * This is the region-gate twin of statutory-push-coverage.test.ts: the same
 * class (a pack's own goldens exercise the engine, never the generic path a
 * real run takes), caught at the other gate.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  PAYROLL_COUNTRY_PACKS,
  assertPayrollRegionSupported,
  payrollRegionSupported,
  resolveEmployeePayrollContext,
} from "./packs.ts";

const ENTRIES = Object.entries(PAYROLL_COUNTRY_PACKS);

/**
 * The per-employee gate a real run takes, reached through the production
 * function (`payroll-run.ts:1892`) rather than a re-implementation of it.
 *
 * `ctx.assertRegionSupported` is an opt-in callback a pack may decline to
 * call — Italy's engine says so in a comment — but Link 4 of
 * `resolveEmployeePayrollContext` calls `assertPayrollRegionSupported`
 * UNCONDITIONALLY for every country. Declining the callback does not exempt a
 * pack from the gate, which is why this drives the unconditional path.
 */
function resolveOneEmployee(country: string, region: string): void {
  resolveEmployeePayrollContext({
    run: {
      country: country as never,
      subsidiaryId: "sub-1",
      subsidiaryName: `${country} Entity`,
      currency: "XXX",
      taxYear: 2026,
      payDate: "2026-06-30",
    },
    employee: { partyId: "emp-1", name: "Test Employee", country, region },
  });
}

test("every installable pack supports at least one known region", () => {
  for (const [country, pack] of ENTRIES) {
    if (!pack.installable) continue;
    assert.ok(
      pack.regions.supported.length > 0,
      `${country} is installable but regions.supported is empty — provisioning would `
      + "succeed and then every employee would fail the generic region gate with "
      + `"${pack.regions.unsupportedReason}". Either support a region or make the pack `
      + "not installable.",
    );
  }
});

test("a supported region is a known region, and the generic gate lets it through", () => {
  for (const [country, pack] of ENTRIES) {
    for (const region of pack.regions.supported) {
      assert.ok(
        pack.regions.known.includes(region),
        `${country} supports "${region}" which is not in regions.known`,
      );
      // The real gate, not a re-implementation of it.
      assert.doesNotThrow(
        () => assertPayrollRegionSupported(country, region),
        `${country}/${region} is declared supported but the generic gate refuses it`,
      );
      assert.equal(payrollRegionSupported(country, region), true);
    }
  }
});

test("an installable pack can resolve an employee in at least one region", () => {
  for (const [country, pack] of ENTRIES) {
    if (!pack.installable) continue;
    const resolvable = pack.regions.known.filter((region) => {
      try {
        resolveOneEmployee(country, region);
        return true;
      } catch {
        return false;
      }
    });
    assert.ok(
      resolvable.length > 0,
      `${country} is installable but no known region resolves an employee — every employee `
      + "would throw PayrollJurisdictionError at Link 4 before any statutory line is computed.",
    );
  }
});

/**
 * The withholding declaration and the region list are two statements of the
 * same fact and must agree. `implemented: true` on a region the pack does not
 * support is the France defect; `supported` on a region declared unimplemented
 * is its mirror. Regions the pack withholds for through a mechanism other than
 * a per-region withholding entry (the US files states separately) are keyed by
 * their own declaration, so only regions appearing in BOTH structures are
 * compared.
 */
test("withholding implemented flags agree with regions.supported", () => {
  for (const [country, pack] of ENTRIES) {
    const withholding = pack.withholding?.();
    if (!withholding) continue;
    for (const entry of withholding.regions) {
      if (!pack.regions.known.includes(entry.region)) continue;
      const supported = pack.regions.supported.includes(entry.region);
      assert.equal(
        entry.implemented,
        supported,
        `${country}/${entry.region}: withholding declares implemented=${entry.implemented} but `
        + `regions.supported ${supported ? "includes" : "does not include"} it. These are the same `
        + "fact; one of them is stale.",
      );
    }
  }
});
