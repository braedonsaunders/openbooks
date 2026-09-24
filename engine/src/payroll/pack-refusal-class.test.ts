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
import { calculateT4127 } from "./canada/t4127.ts";
import { ratesForPayDate as caRatesForPayDate } from "./canada/rates.ts";
import { ratesForPayDate as usRatesForPayDate } from "./us/rates.ts";
import { miCityWithholding } from "./us/states/mi.ts";
import { ohMunicipalWithholding } from "./us/states/oh.ts";
import { orgYearEndFilings } from "./yearend.ts";
import { filingLifecycle } from "./yearend-amendments.ts";

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

/**
 * The calculation path rejects with a PayrollError too — not just the
 * filing populations above. An unconfigured Ohio municipal rate (or a
 * Michigan city rate, or a pay date in a year no pack transcribed) refused
 * with a bare Error, and the year-end conversion sites rethrow
 * non-PayrollError, so one unconfigured rate killed the whole year-end page
 * org-wide instead of giving a named refusal. Each case below names its
 * remedy in the message (asserted where the wording is the product).
 */
test("pack calculation entries refuse with a PayrollError", () => {
  assert.throws(
    () => ohMunicipalWithholding({ wages: "2000.00", rate: null, municipality: "COLUMBUS" }),
    PayrollError,
  );
  assert.throws(
    () => miCityWithholding({
      city: "DETROIT", wages: "1000.00", rate: null,
      exemptionPerYear: "600", exemptions: 2, periodsPerYear: 26,
    }),
    PayrollError,
  );
  assert.throws(
    () => calculateT4127({ payDate: "2026-01-15", province: "ON", periodsPerYear: 0, income: "1000.00" }),
    PayrollError,
  );
  // Edition resolvers refuse an untranscribed year with an operator remedy —
  // rates for a new year arrive with a pack update, never a scaffold script.
  assert.throws(() => caRatesForPayDate("2031-01-15"), PayrollError);
  assert.throws(() => usRatesForPayDate("2031-01-15"), PayrollError);
  try {
    caRatesForPayDate("2031-01-15");
    assert.fail("expected the 2031 edition refusal");
  } catch (error) {
    assert.ok(error instanceof PayrollError);
    assert.match(error.message, /rates for 2031 .* update the pack/);
  }
});

/**
 * The year-end conversion sites convert pack refusals instead of throwing:
 * a committed stub with an unknown country must surface as the affected
 * filings' named refusals, never as a page-wide crash — through both
 * `orgYearEndFilings` (the page) and `filingLifecycle` (the corrections
 * review), which convert independently.
 */
test(
  "the year-end conversion sites convert an unknown-country stub into named refusals",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const countries = declaredPayrollFilings().map((pack) => pack.country);
      await db.execute(sql`
        update orgs set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({
          payroll: { countries },
        })}::jsonb where id = ${org.orgId}`);
      const employeeId = "00000000-0000-4000-8000-000000000001";
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'person', 'Unknown Country', true, '{}'::jsonb)`);
      const documentId = "00000000-0000-4000-8000-000000000002";
      await db.execute(sql`
        insert into documents (org_id, id, kind, document_number, document_date, currency)
        values (${org.orgId}, ${documentId}, 'pay_run', 'PAY-1', '2026-07-21', 'CAD')`);
      const scheduleId = "00000000-0000-4000-8000-000000000003";
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18')`);
      await db.execute(sql`
        insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end,
                              pay_date, tax_year, run_status, calculated_at, employee_count)
        values (${documentId}, ${org.orgId}, ${scheduleId}, '2026-07-05', '2026-07-18',
                '2026-07-21', 2026, 'committed', now(), 1)`);
      await db.execute(sql`
        insert into pay_stubs (org_id, pay_run_document_id, employee_party_id, province,
                               periods_per_year, pay_date, tax_year, currency_code, gross, net_pay)
        values (${org.orgId}, ${documentId}, ${employeeId}, 'UNKNOWN', 26, '2026-07-21', 2026,
                'CAD', '1000', '800')`);
      // The legacy trigger stamps a country from the province; an UNKNOWN
      // province is precisely the unattributable row. Make it explicit.
      await db.execute(sql`
        update pay_stubs set country = null, country_source = 'unknown'
         where org_id = ${org.orgId} and pay_run_document_id = ${documentId}`);

      const sections = await orgYearEndFilings(org.orgId, 2026);
      assert.ok(sections.length > 0, "the page must still enumerate its filings");
      const refused = sections.filter((section) => section.populationRefusal != null);
      assert.ok(refused.length > 0, "at least one filing must carry the named refusal");
      // The stub's unknown country fires the shared guard in every population
      // that reads it; other packs may carry their own legitimate refusals
      // (an unsupported year, an unconfigured account) — both are converted
      // PayrollErrors, and reaching this line proves no bare Error escaped
      // the page enumeration.
      const t4 = sections.find((section) => section.country === "CA" && section.key === "t4");
      assert.ok(t4?.populationRefusal, "the CA T4 must carry the named refusal");
      assert.match(t4.populationRefusal, /unknown historical country/);
      for (const section of refused) {
        assert.ok(section.populationRefusal!.length > 0);
      }

      const lifecycle = await filingLifecycle(org.orgId, "CA", "t4", 2026);
      assert.match(lifecycle.populationRefusal ?? "", /unknown historical country/);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
