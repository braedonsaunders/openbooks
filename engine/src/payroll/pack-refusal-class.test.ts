/**
 * A pack refusal must BE a payroll refusal, at the boundary the generic layer
 * catches on.
 *
 * `yearend.ts` and `yearend-amendments.ts` both convert a
 * refusal out of a filing's `population()` into that filing's own named
 * refusal, and rethrow anything else — deliberately, so one pack's refusal
 * cannot hide another pack's data, and so an unexpected crash is not silently
 * relabelled as a declared refusal. Both catch `instanceof PayrollError`.
 *
 * Germany declared its ELSTER refusal as a bare `Error`. It was therefore
 * "anything else": it escaped the conversion and threw out of
 * `orgYearEndFilings`, which enumerates EVERY declared pack regardless of what
 * the org installed — so the year-end page died for every org in the one tax
 * year Germany has loaded, which was the current one. The assistant's
 * payroll_year_end tool reported an undocumented error for the same reason.
 *
 * This test drives the real boundary rather than scanning source, for two
 * reasons. A scan for `throw new Error` would have missed Germany outright —
 * it used `Promise.reject(new Error(...))`. And the contract is about what
 * reaches the caller, which only calling it can establish.
 *
 * Pack code may still construct a bare `Error` for an internal invariant — a
 * programmer error, which SHOULD reach the error boundary uncaught. The rule
 * is narrower than "no bare Errors in packs": anything a declared pack surface
 * rejects with, on any input, must be a PayrollError.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { declaredPayrollFilings } from "./filing-registry.ts";
import { PayrollError } from "./error.ts";
import {
  PayrollJurisdictionError,
  PayrollPackError,
  payrollTaxYearSupport,
} from "./packs.ts";
import { payrollSupportedTaxYears } from "./tax-years.ts";
import { createScratchOrg, dropScratchOrgReporting } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("the pack refusal classes are payroll refusals", () => {
  // The hierarchy itself, so it cannot be re-split. Both classes live in leaf
  // modules to dodge a module-evaluation cycle; that is a reason to keep the
  // FILES separate, never a reason to give them separate roots.
  assert.ok(new PayrollPackError("x") instanceof PayrollError);
  assert.ok(new PayrollJurisdictionError("x") instanceof PayrollPackError);
  assert.ok(new PayrollJurisdictionError("x") instanceof PayrollError);
});

/**
 * Years worth driving for one pack: every year it says it supports, plus one
 * past the end and one before the start. The refusal path and the populate
 * path are both in scope — a filing that rejects with the wrong class on an
 * unloaded year is exactly the Germany defect.
 */
function probeYears(country: string): readonly number[] {
  const supported = payrollSupportedTaxYears(payrollTaxYearSupport(country));
  if (supported.length === 0) return [2025, 2026, 2027];
  return [Math.min(...supported) - 1, ...supported, Math.max(...supported) + 1];
}

test(
  "every declared filing's population rejects only with a PayrollError",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      // Install every declared country, so nothing is skipped for want of an
      // org setting: this asks what the pack DOES, not what this tenant bought.
      const countries = declaredPayrollFilings().map((pack) => pack.country);
      await db.execute(sql`
        update orgs set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({
          payroll: { countries },
        })}::jsonb where id = ${org.orgId}`);

      let populations = 0;
      for (const pack of declaredPayrollFilings()) {
        for (const filing of pack.yearEnd) {
          for (const taxYear of probeYears(pack.country)) {
            populations++;
            try {
              await filing.population(org.orgId, taxYear);
            } catch (error) {
              assert.ok(
                error instanceof PayrollError,
                `${pack.country}/${filing.key} for ${taxYear} rejected with `
                + `${(error as { constructor?: { name?: string } })?.constructor?.name ?? typeof error}`
                + ` — "${error instanceof Error ? error.message : String(error)}". A declared pack `
                + "refusal must be a PayrollError (or PayrollPackError, which now extends it), or "
                + "the generic year-end layer rethrows it and the whole page dies for every org.",
              );
            }
          }
        }
      }
      assert.ok(populations > 0, "the probe must actually have called some populations");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
