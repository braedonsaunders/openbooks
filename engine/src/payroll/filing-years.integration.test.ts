import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  orgFilingYearOptions,
  orgPayrollDataYears,
  orgYearEndFilings,
} from "./yearend.ts";
import { payrollFilingYearOptions } from "./packs.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../testing/fixtures.ts";

/**
 * The year-end picker must offer the tax year of any posted run — even when
 * the pack's fiscal year runs ahead of the calendar year.
 *
 * Observed: an AU org posted a run with a September 2026 pay date (AU tax
 * year 2027: 1 July basis, named for the closing year), then opened year-end
 * to finalise. The picker listed 2026 down to 2021 only — the year just paid
 * was unreachable, so STP finalisation for that year could not be started.
 * The picker range was derived from the calendar year (`currentYear - i`),
 * which is right for calendar-year packs and wrong for every fiscal-year one.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

test("AU September: the pack year ahead of the calendar year is offered first", () => {
  const years = payrollFilingYearOptions({ today: "2026-09-19", countries: ["AU"] });
  assert.equal(years[0], 2027, `expected 2027 first, got ${years}`);
  assert.ok(years.includes(2026), `draft edition 2026 still offered, got ${years}`);
  assert.deepEqual(years, [2027, 2026, 2025, 2024, 2023, 2022]);
});

test("a posted run's year is offered even outside the window", () => {
  const years = payrollFilingYearOptions({
    today: "2026-09-19",
    countries: ["AU"],
    dataYears: [2019],
  });
  assert.ok(years.includes(2019), `expected 2019 unioned in, got ${years}`);
  assert.equal(years[0], 2027);
});

test("declared editions are offered even outside the window", () => {
  // Data from far ahead moves the window past the editions; the editions are
  // still offered because the range derives from them, not just the window.
  const years = payrollFilingYearOptions({
    today: "2026-09-19",
    countries: ["AU"],
    dataYears: [2035],
  });
  assert.equal(years[0], 2035);
  assert.ok(years.includes(2027), `published edition 2027 still offered, got ${years}`);
  assert.ok(years.includes(2026), `draft edition 2026 still offered, got ${years}`);
});

test("calendar packs keep the calendar window", () => {
  assert.deepEqual(
    payrollFilingYearOptions({ today: "2026-09-19", countries: ["US"] }),
    [2026, 2025, 2024, 2023, 2022, 2021],
  );
  assert.deepEqual(
    payrollFilingYearOptions({ today: "2026-09-19", countries: ["IE"] }),
    [2026, 2025, 2024, 2023, 2022, 2021],
  );
});

test("GB January-March defaults to the pack year, not the calendar year", () => {
  // GB opens 6 April (opening-year naming): on 2027-02-15 the pack is still
  // in tax year 2026. The old calendar derivation defaulted the surface to
  // 2027 — a year that had not started. GB can never strand a POSTED year
  // (opening-year naming keeps the pack year at or below the calendar year),
  // but it gets the same pack-driven default as every other country.
  const years = payrollFilingYearOptions({ today: "2027-02-15", countries: ["GB"] });
  assert.equal(years[0], 2026, `expected pack year 2026 first, got ${years}`);
  assert.ok(!years.includes(2027), `the unstarted calendar year is not offered, got ${years}`);
});

test("unknown countries are skipped and orgs with no packs keep the calendar window", () => {
  assert.deepEqual(
    payrollFilingYearOptions({ today: "2026-09-19", countries: ["XX"] }),
    [2026, 2025, 2024, 2023, 2022, 2021],
  );
  assert.deepEqual(
    payrollFilingYearOptions({ today: "2026-09-19", countries: [] }),
    [2026, 2025, 2024, 2023, 2022, 2021],
  );
});

test("an invalid business date with no other signal refuses instead of offering NaN", () => {
  assert.throws(
    () => payrollFilingYearOptions({ today: "not-a-date", countries: [] }),
    /invalid business date/,
  );
});

/** A committed AU pay run paid 2026-09-15: pack tax year 2027. */
async function seedAuCommittedRun(): Promise<{ orgId: string }> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`
    update orgs set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({
      payroll: { countries: ["AU"] },
    })}::jsonb where id = ${org.orgId}`);
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Monthly', 'monthly', 12, '2026-09-30', 0, true,
            ${actorId}, ${actorId})`);
  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${org.orgId}, 'person', 'Ava Worker', true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (org_id, party_id, hired_on, is_active, created_by, updated_by)
    values (${org.orgId}, ${employeeId}, '2024-01-01', true, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country,
                                           province, pay_basis, is_active, created_by, updated_by)
    values (${org.orgId}, ${employeeId}, ${scheduleId}, 'AU', 'NSW', 'salary', true,
            ${actorId}, ${actorId})`);
  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                           currency, status, created_by, updated_by)
    values (${org.orgId}, ${documentId}, 'pay_run', ${`PAY-${documentId.slice(0, 8)}`},
            ${org.subsidiaryId}, '2026-09-15', 'AUD', 'approved', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
                          tax_year, run_status, calculated_at, created_by, updated_by)
    values (${documentId}, ${org.orgId}, ${scheduleId}, '2026-09-01', '2026-09-15', '2026-09-15',
            2027, 'committed', now(), ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, province,
                           periods_per_year, pay_date, tax_year, country, country_source,
                           currency_code, gross, net_pay, created_by, updated_by)
    values (${randomUUID()}, ${org.orgId}, ${documentId}, ${employeeId}, 'NSW',
            12, '2026-09-15', 2027, 'AU', 'calculation',
            'AUD', '9000.0000', '7000.0000', ${actorId}, ${actorId})`);
  return { orgId: org.orgId };
}

test(
  "a posted AU run in tax year 2027 is offered by the year-end surface",
  { skip: !DB },
  async () => {
    const { orgId } = await seedAuCommittedRun();
    try {
      assert.deepEqual(await orgPayrollDataYears(orgId), [2027]);
      const years = await orgFilingYearOptions(orgId, "2026-09-19");
      assert.ok(
        years.includes(2027),
        `posted tax year 2027 must be offered, got ${years}`,
      );
      assert.equal(years[0], 2027, `pack year 2027 is the default, got ${years}`);
      // The year the picker hid was servable all along: the enumeration
      // answers 2027 for this org (the STP section carries the pack's own
      // declared refusal; what was missing was ever being OFFERED the year).
      const sections = await orgYearEndFilings(orgId, 2027);
      assert.ok(
        sections.some((section) => section.country === "AU"),
        "expected an AU year-end section for 2027",
      );
    } finally {
      await dropScratchOrgReporting(orgId);
    }
  },
);
