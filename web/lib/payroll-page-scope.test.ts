import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readingPagePairs } from './page-source'
import test from "node:test";

/**
 * The payroll server pages and assistant tools must read every population
 * through web/lib/payroll-scoped-views.ts, never the engine directly: the
 * loaders are where the caller's subsidiary scope is applied, and a page that
 * bypassed them once rendered a restricted caller the year-end slips its own
 * JSON route refused with 404.
 *
 * A page is its `page.tsx` AND its `view.ts`: the ViewSpec conversion moved
 * the loaders into the sibling, and these greps must follow the code. The
 * `never` patterns match a CALL rather than a bare name, so a comment that
 * explains why the unscoped loader is not used does not read as using it.
 */
const read = readingPagePairs((path: string) => readFileSync(new URL(path, import.meta.url), "utf8"));

const PAGES: Record<string, { uses: RegExp[]; never: RegExp[] }> = {
  "../app/(app)/payroll/year-end/page.tsx": {
    uses: [/scopedYearEndFilings\(authz, year\)/, /if \(!filings\)[\s\S]{0,200}?notFound\(\)/],
    never: [/orgYearEndFilings\(/],
  },
  "../app/(app)/payroll/separations/page.tsx": {
    uses: [/scopedYearEndFilings\(authz, year\)/, /if \(!filings\)[\s\S]{0,200}?notFound\(\)/],
    never: [/orgYearEndFilings\(/],
  },
  "../app/(app)/payroll/remittances/page.tsx": {
    uses: [/scopedRemittanceSummary\(authz, \{ from, to \}\)/, /if \(!groups\)[\s\S]{0,200}?notFound\(\)/],
    never: [/payrollRemittanceSummary\(/],
  },
  "../app/(app)/payroll/opening-balances/page.tsx": {
    uses: [/scopedOpeningBalances\(authz, year\)/, /scopedEntitlementOpenings\(authz\)/],
    never: [/openingBalancesForYear\(/, /entitlementOpenings\(/],
  },
  "../app/(app)/payroll/retro/page.tsx": {
    uses: [/scopedRetroSchedules\(authz\)/],
    never: [/from pay_schedules/],
  },
  "./assistant/tools-payroll.ts": {
    uses: [
      /scopedYearEndFilings\(authz, a\.taxYear\)/,
      /scopedRemittanceSummary\(authz, \{/,
      /subsidiaryVisibleFilter\(sql`d\.subsidiary_id`, authz\.allowedSubsidiaryIds\)/,
      /subsidiaryScopeAllows\(authz\.allowedSubsidiaryIds, run\.subsidiary_id/,
      /payrollVisiblePartyFilter\(authz\)/,
      /guardPayrollEmployees\(authz, \[a\.employeePartyId\]\)/,
      /payRunReadiness\(authz\.user\.orgId, a\.documentId, authz\.allowedSubsidiaryIds\)/,
    ],
    never: [/orgYearEndFilings\(/, /payrollRemittanceSummary\(/],
  },
};

for (const [file, rules] of Object.entries(PAGES)) {
  test(`${file} reads payroll populations through the scoped loaders`, () => {
    const text = read(file);
    for (const pattern of rules.uses) assert.match(text, pattern);
    for (const pattern of rules.never) assert.doesNotMatch(text, pattern);
  });
}

test("the JSON routes share the loaders' scope decisions", () => {
  assert.match(read("../app/api/payroll/year-end/route.ts"), /guardPayrollYearEndFilings\(gate, filings, year\)/);
  assert.match(read("../app/api/payroll/remittances/route.ts"), /guardRemittancePeriod\(gate, from, to\)/);
  assert.match(read("../app/api/payroll/opening-balances/route.ts"), /scopedOpeningBalances\(gate, year\)/);
  assert.match(
    read("../app/api/payroll/opening-balances/entitlements/route.ts"),
    /scopedEntitlementOpenings\(gate, \{/,
  );
});
