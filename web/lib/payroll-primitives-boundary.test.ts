import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  labourJurisdictionProblem,
} from "@openbooks/engine/src/payroll/packs.ts";

/**
 * The API boundary for two payroll primitives whose validity is a PACK
 * declaration, not a database constraint.
 *
 * A CHECK constraint cannot enumerate an open pack registry, and the UI is
 * never the enforcement point (AGENTS.md), so both refusals live at the API
 * boundary and are asserted here — the same pattern
 * `payroll-filing-accounts` / `filingAccountProblem` established.
 */

const source = (path: string) => readFileSync(path, "utf8");
const profiles = source("web/app/api/payroll/profiles/route.ts");
const setup = source("web/app/api/admin/setup/[entity]/route.ts");

test("the payroll profile API refuses an undeclared labour jurisdiction by name", () => {
  // The route asks the pack declarations, and returns THEIR message verbatim —
  // so the operator is told which value was refused and which are declared,
  // and adding a jurisdiction to a pack needs no edit to the route.
  assert.match(profiles, /labourJurisdictionProblem/);
  assert.match(profiles, /const labourProblem = labourJurisdictionProblem\(country, labourJurisdiction\)/);
  assert.match(profiles, /NextResponse\.json\(\{ error: labourProblem \}, \{ status: 422 \}\)/);
  // Refused BEFORE the insert, and empty means "derive it from the region".
  assert.ok(
    profiles.indexOf("labourProblem") < profiles.indexOf("insert into employee_payroll_profiles"),
    "the refusal must precede the write",
  );
  assert.match(profiles, /labour_jurisdiction = excluded\.labour_jurisdiction/);

  // The message the route returns, for the value the API is asked to refuse.
  // Every Canadian province is declared now; 'CA-ZZ' — employed outside any of
  // them — is what remains ungoverned by any employment-standards act.
  const problem = labourJurisdictionProblem("CA", "CA-ZZ");
  assert.ok(problem);
  assert.match(problem!, /CA-ZZ/);
  assert.match(problem!, /CA-ON/);
});

test("the profile editor's options come from the packs, not from a second list", () => {
  // employmentJurisdictionsOf, so a tax administration's own calendar is never
  // offered as somebody's employment standards.
  assert.match(profiles, /employmentJurisdictionsOf/);
  assert.match(profiles, /labourJurisdictions: labourJurisdictionOptions\(\)/);
  const panel = source("web/app/(app)/payroll/_ui/EmployeesPanel.tsx");
  assert.match(panel, /props\.labourJurisdictions\?\.\[country\]/);
  // The editor must not enumerate jurisdiction keys of its own.
  assert.doesNotMatch(panel, /'CA-ON'/);
  assert.doesNotMatch(panel, /LABOUR_JURISDICTIONS/);
});

test("the setup API refuses a semi-monthly anchor that names no calendar", () => {
  assert.match(setup, /semiMonthlyAnchorProblem/);
  assert.match(setup, /entity\.key === 'pay-schedules'/);
  // Edits are validated against the STORED frequency/anchor when the body omits
  // one, exactly as the filing-account check does — otherwise changing only the
  // frequency of an existing schedule would skip the anchor check.
  //
  // Asserted as the PROPERTY rather than as one literal SELECT: the columns
  // this block needs grow (periods_per_year joined them), and a test pinned to
  // the exact statement fails on a correct change while proving nothing extra.
  assert.match(setup, /from pay_schedules\s*\n?\s*where id = \$\{rowId\} and org_id = \$\{orgId\}/);
  for (const column of ["frequency", "periods_per_year", "anchor_period_end"]) {
    assert.match(
      setup, new RegExp(column),
      `the stored ${column} must be readable, or an edit that omits it skips its check`,
    );
  }
  assert.match(setup, /body\.frequency \?\? current\?\.frequency/);
  assert.match(setup, /if \(frequency === 'semi_monthly'\)/);
});

test("the setup API refuses a period count the schedule's own calendar cannot produce", () => {
  // The sibling defect: `periods_per_year` is factor P, and the table's CHECK
  // only constrains it to the union across all frequencies — so a semi-monthly
  // schedule could save with 26 and annualize every withholding on a count its
  // own boundaries contradict.
  assert.match(setup, /payPeriodsPerYearProblem/);
  assert.match(setup, /body\.periodsPerYear \?\? current\?\.periods_per_year/);
  assert.ok(
    setup.indexOf("payPeriodsPerYearProblem(frequency, periodsPerYear)") > 0,
    "the check must be given both fields — the pairing is the whole point",
  );
});
