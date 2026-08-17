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
  const problem = labourJurisdictionProblem("CA", "CA-MB");
  assert.ok(problem);
  assert.match(problem!, /CA-MB/);
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
  assert.match(setup, /select frequency, anchor_period_end::text as anchor_period_end from pay_schedules/);
  assert.match(setup, /if \(frequency === 'semi_monthly'\)/);
});
