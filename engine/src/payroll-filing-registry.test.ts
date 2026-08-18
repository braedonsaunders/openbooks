import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  declaredPayrollFilings,
  filingAccountProblem,
  payrollPackFilings,
  registerPayrollFilings,
  registerYearEndFiling,
  separationPaymentKeys,
  unregisterPayrollFilings,
  yearEndFiling,
  type PayrollFilingData,
  type PayrollPackFilings,
} from "./payroll-filing-registry.ts";
import { orgYearEndFilings, roeRecord } from "./payroll-yearend.ts";
import { PayrollPackError } from "./payroll/packs.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * The filing registry is the de-Canadianization contract: packs DECLARE
 * their filings and program types, the generic layer iterates declarations,
 * and a third country attaches by registering — never by editing a union
 * type or a shared query. These tests register a synthetic "ZZ" pack (a
 * P60-shaped year-end certificate) and prove the whole surface — the
 * enumeration, the filing-account validation, the refusals — treats it
 * exactly like the built-ins.
 */

const EMPTY_POPULATION: PayrollFilingData = {
  rowKey: "id",
  columns: [{ key: "employee", label: "Employee" }],
  rows: [],
};

const ZZ_FILINGS: PayrollPackFilings = {
  country: "ZZ",
  programTypes: [
    { key: "zz_paye", label: "ZZ PAYE employer reference" },
    { key: "zz_regional", label: "ZZ regional levy account", requiresRegion: true },
  ],
  yearEnd: [
    {
      key: "p60",
      label: "P60 end-of-year certificate",
      cadence: "annual",
      emptyText: "No committed ZZ pay stubs for this year.",
      population: async () => EMPTY_POPULATION,
      download: {
        label: "Download P60 file",
        build: async () => ({ filename: "P60.xml", contentType: "application/xml", body: "<p60/>" }),
      },
      amendment: {
        supported: true,
        revisions: ["amended", "cancelled"],
        vehicle: "same_form",
        downloadRefusal: "the ZZ pack files corrections on paper",
      },
    },
  ],
};

/** The minimum a synthetic filing must declare, so the tests stay readable. */
const ZZ_AMENDMENT = {
  supported: false,
  refusal: "the ZZ pack does not correct this filing",
} as const;

function withZZ(fn: () => void | Promise<void>) {
  return async () => {
    registerPayrollFilings(ZZ_FILINGS);
    try {
      await fn();
    } finally {
      unregisterPayrollFilings("ZZ");
    }
  };
}

test("a registered third pack's filing appears in the declared enumeration", withZZ(() => {
  const countries = declaredPayrollFilings().map((pack) => pack.country);
  assert.deepEqual(countries, ["CA", "US", "ZZ"], "built-ins first, then registrations");
  const filing = yearEndFiling("ZZ", "p60");
  assert.equal(filing.label, "P60 end-of-year certificate");
  assert.ok(filing.download, "the pack's declared file builder rides along");
}));

test("an undeclared country and an undeclared filing are refused by name", () => {
  assert.throws(() => payrollPackFilings("ZZ"), (error: Error) => {
    assert.ok(error instanceof PayrollPackError);
    assert.match(error.message, /no payroll pack declares filings for ZZ/);
    assert.match(error.message, /CA, US/, "the refusal names what exists");
    return true;
  });
  assert.throws(() => yearEndFiling("CA", "p60"), /declares no "p60" filing/);
});

test("duplicate registrations are refused — one declaration per country", withZZ(() => {
  assert.throws(() => registerPayrollFilings(ZZ_FILINGS), /already declared/);
  assert.throws(() => registerPayrollFilings({ ...ZZ_FILINGS, country: "CA" }), /already declared/);
}));

test("a jurisdiction filing registers onto an existing pack (the RL-1 path)", withZZ(() => {
  registerYearEndFiling("ZZ", {
    key: "fps",
    label: "Full payment submission",
    cadence: "quarterly",
    population: async () => EMPTY_POPULATION,
    amendment: ZZ_AMENDMENT,
  });
  assert.deepEqual(payrollPackFilings("ZZ").yearEnd.map((filing) => filing.key), ["p60", "fps"]);
  // A duplicate key is two declarations of one statutory filing — refused.
  assert.throws(
    () => registerYearEndFiling("ZZ", { key: "p60", label: "x", cadence: "annual", population: async () => EMPTY_POPULATION, amendment: ZZ_AMENDMENT }),
    /already declares a "p60" filing/,
  );
  // Registering onto a pack nobody declared refuses by name.
  assert.throws(
    () => registerYearEndFiling("XX", { key: "x", label: "x", cadence: "annual", population: async () => EMPTY_POPULATION, amendment: ZZ_AMENDMENT }),
    /no payroll pack declares filings for XX/,
  );
}));

test("a filing without a declared cadence is refused — the deadline class is required", withZZ(() => {
  assert.throws(
    () => registerYearEndFiling("ZZ", {
      key: "p45",
      label: "P45 details of employee leaving work",
      population: async () => EMPTY_POPULATION,
      amendment: ZZ_AMENDMENT,
    } as never),
    /declares no cadence/,
  );
  assert.throws(
    () => registerPayrollFilings({
      ...ZZ_FILINGS,
      country: "ZY",
      yearEnd: [{ key: "x", label: "x", population: async () => EMPTY_POPULATION, amendment: ZZ_AMENDMENT } as never],
    }),
    /declares no cadence/,
  );
}));

test("the built-ins declare the statute's own cadence", () => {
  assert.equal(yearEndFiling("CA", "t4").cadence, "annual");
  assert.equal(yearEndFiling("CA", "rl1").cadence, "annual");
  assert.equal(yearEndFiling("US", "w2").cadence, "annual");
  assert.equal(yearEndFiling("US", "941").cadence, "quarterly");
  // The ROE is a SEPARATION document — due per interruption of earnings,
  // within days of the employee event, never at year-end.
  assert.equal(yearEndFiling("CA", "roe").cadence, "separation");
});

/* ------------------------------------------------------------------ */
/* Filing accounts: pack-declared program types replace the DB CHECKs  */
/* ------------------------------------------------------------------ */

test("a filing account with a registered pack's program type is accepted", withZZ(() => {
  assert.equal(
    filingAccountProblem({ country: "ZZ", programType: "zz_paye", stateCode: null }),
    null,
  );
  // The built-ins pass through the same declaration, not a special case.
  assert.equal(filingAccountProblem({ country: "CA", programType: "ca_rp", stateCode: null }), null);
  assert.equal(filingAccountProblem({ country: "US", programType: "us_ein", stateCode: null }), null);
  assert.equal(filingAccountProblem({ country: "US", programType: "us_state_sui", stateCode: "CA" }), null);
}));

test("an undeclared program type is refused, naming what the pack declares", withZZ(() => {
  const problem = filingAccountProblem({ country: "ZZ", programType: "zz_nope", stateCode: null });
  assert.ok(problem, "undeclared program type must be refused");
  assert.match(problem!, /does not file under program type "zz_nope"/);
  assert.match(problem!, /zz_paye/, "the refusal names the declared types");
  assert.match(
    filingAccountProblem({ country: "GB", programType: "paye", stateCode: null })!,
    /no payroll pack declares filing program types for GB/,
  );
}));

test("a region-scoped program type requires its region, and only then", withZZ(() => {
  assert.match(
    filingAccountProblem({ country: "ZZ", programType: "zz_regional", stateCode: null })!,
    /state code is required/,
  );
  assert.equal(
    filingAccountProblem({ country: "ZZ", programType: "zz_regional", stateCode: "NW" }),
    null,
  );
  assert.match(
    filingAccountProblem({ country: "ZZ", programType: "zz_paye", stateCode: "NW" })!,
    /carries no state\/region code/,
  );
}));

/* ------------------------------------------------------------------ */
/* Separation payments are a pack declaration                          */
/* ------------------------------------------------------------------ */

test("separation-payment component keys come from the pack, or refuse", withZZ(() => {
  assert.deepEqual(separationPaymentKeys("CA"), {
    vacationPay: ["vacation_payout"],
    otherMonies: ["bonus"],
  });
  // ZZ declares no mapping: consumers refuse instead of filing 0.00.
  assert.throws(() => separationPaymentKeys("ZZ"), /declares no separation-payment component mapping/);
  assert.throws(() => separationPaymentKeys("US"), /declares no separation-payment component mapping/);
}));

/* ------------------------------------------------------------------ */
/* The org-year enumeration (DB)                                       */
/* ------------------------------------------------------------------ */

test(
  "the year-end enumeration surfaces a registered pack's filing",
  { skip: !DB },
  withZZ(async () => {
    const org = await createScratchOrg();
    try {
      await db.execute(sql`
        update orgs
           set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{payroll}',
                                    '{"countries": ["CA", "ZZ"]}'::jsonb)
         where id = ${org.orgId}`);
      const filings = await orgYearEndFilings(org.orgId, 2026);
      const zz = filings.find((filing) => filing.country === "ZZ" && filing.key === "p60");
      assert.ok(zz, "the synthetic pack's filing is enumerated");
      assert.equal(zz!.installed, true);
      assert.equal(zz!.label, "P60 end-of-year certificate");
      assert.deepEqual(zz!.download, { label: "Download P60 file", note: null });
      // The built-ins are enumerated the same way — no special path.
      assert.ok(filings.some((filing) => filing.country === "CA" && filing.key === "t4"));
      assert.ok(filings.some((filing) => filing.country === "CA" && filing.key === "roe"));
      assert.ok(filings.some((filing) => filing.country === "US" && filing.key === "941"));
      assert.ok(filings.some((filing) => filing.country === "US" && filing.key === "w2"));
      const us = filings.find((filing) => filing.country === "US" && filing.key === "w2");
      assert.equal(us!.installed, false, "US pack is not installed for this org");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  }),
);

/* ------------------------------------------------------------------ */
/* ROE: no pay schedule means a refusal, never an invented Block 6     */
/* ------------------------------------------------------------------ */

test(
  "an ROE for a schedule-less employee is refused by employee name",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      const employeeId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, subsidiary_id, custom)
        values (${employeeId}, ${org.orgId}, 'person', 'Sam Scheduleless', true, ${org.subsidiaryId}, '{}'::jsonb)`);
      await db.execute(sql`
        insert into employee_roles (org_id, party_id, hired_on, is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, '2024-01-01', true, ${actorId}, ${actorId})`);
      // No payroll profile at all — the profiles table requires a pay
      // schedule, so the schedule-less employee is the one the LEFT JOIN
      // produces a null frequency for (imported history, terminated staff).
      // Block 6 (pay-period type) and the Block 15 window cannot be derived,
      // so the builder must refuse — previously it invented
      // `biweekly`/`27`/`"B"` and filed anyway.
      await assert.rejects(
        roeRecord(org.orgId, employeeId),
        (error: Error) => {
          assert.match(error.message, /Sam Scheduleless/, "the refusal names the employee");
          assert.match(error.message, /no pay schedule/);
          return true;
        },
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
