import {
  seedPayrollComponent,
  seedPayrollDocument,
  seedPayrollLine,
  seedPayrollParty,
  seedPayrollPerson,
  seedPayrollSchedule,
  seedPayrollStub,
  seedPayrollVendorRole,
  seedFlowActors,
  createScratchOrg,
  dropScratchOrg,
  seedWorkerEmployment,
} from "../testing/fixtures.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp } from "../money/money.ts";
import {
  assertPayrollRemittanceBillCurrent,
  createRemittanceBill,
  payrollRemittanceSummary,
} from "./remittance.ts";
import { PayrollError } from "./error.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const RANGE = { from: "2026-10-01", to: "2026-10-31" };

// Runs committed BEFORE any remittance vendor was assigned carry a null
// commit-time snapshot. Assigning the vendors on the components afterwards
// must route the unremitted liabilities to per-vendor cards with a working
// Create-bill action — not leave one "No remittance vendor assigned" card.
async function seedVendorlessOctober() {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const filingAccountId = randomUUID();
  await db.execute(sql`
    insert into payroll_filing_accounts
      (id, org_id, country, program_type, account_number, name, remitter_type, is_default)
    values (${filingAccountId}, ${org.orgId}, 'CA', 'ca_rp', '123456789RP0088',
      'October fixture account', 'regular', true)`);
  const craAccountId = randomUUID();
  const wcbAccountId = randomUUID();
  for (const [id, number, name] of [
    [craAccountId, "2110", "Payroll Deductions Payable"],
    [wcbAccountId, "2120", "WCB Premiums Payable"],
  ] as const) {
    await db.execute(sql`
      insert into accounts
        (id, org_id, number, name, type, is_summary, is_active, eliminate,
         reconcilable, required_dimensions, custom, subsidiary_include_children)
      values
        (${id}, ${org.orgId}, ${number}, ${name}, 'liability_payable', false, true, false, false,
         '[]'::jsonb, '{}'::jsonb, true)`);
  }
  const craVendorId = randomUUID();
  const wcbVendorId = randomUUID();
  await seedPayrollParty(org.orgId, craVendorId, {
    kind: "company",
    displayName: "CRA - Payroll Deductions",
    isActive: true,
  });
  await seedPayrollParty(org.orgId, wcbVendorId, {
    kind: "company",
    displayName: "WCB Alberta",
    isActive: true,
  });
  await seedPayrollVendorRole(org.orgId, craVendorId, actorId);
  await seedPayrollVendorRole(org.orgId, wcbVendorId, actorId);
  // Deliberately no org-level payroll vendor settings and no component
  // vendors yet: the pack declaration alone must not route anything.
  const taxComponentId = randomUUID();
  const wcbComponentId = randomUUID();
  await seedPayrollComponent(org.orgId, taxComponentId, {
    code: "TAX",
    name: "Income tax",
    kind: "deduction",
    systemKey: "income_tax",
    liabilityAccountId: craAccountId,
    sequence: 10,
    country: "CA",
    createdBy: actorId,
    updatedBy: actorId,
  });
  await seedPayrollComponent(org.orgId, wcbComponentId, {
    code: "WCB",
    name: "Workers compensation",
    kind: "employer_contribution",
    systemKey: null,
    liabilityAccountId: wcbAccountId,
    sequence: 20,
    country: "CA",
    createdBy: actorId,
    updatedBy: actorId,
  });
  const scheduleId = randomUUID();
  await seedPayrollSchedule(org.orgId, scheduleId, actorId, {
    name: "October schedule",
    frequency: "monthly",
    periodsPerYear: 12,
    anchorPeriodEnd: "2026-10-31",
    payDateOffsetDays: 0,
  });
  const documentId = randomUUID();
  await seedPayrollDocument(org.orgId, documentId, {
    kind: "pay_run",
    documentNumber: "OCT-VENDORLESS",
    subsidiaryId: org.subsidiaryId,
    documentDate: "2026-10-31",
    postingDate: "2026-10-31",
    postingPeriodId: org.periodId,
    currency: "CAD",
    status: "draft",
    memo: "October fixture",
    createdBy: actorId,
    updatedBy: actorId,
  });
  await db.execute(sql`
    insert into pay_runs
      (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
       tax_year, run_status, run_type, created_by, updated_by)
    values
      (${documentId}, ${org.orgId}, ${scheduleId}, '2026-10-01', '2026-10-31',
       '2026-10-31', 2026, 'committed', 'regular', ${actorId}, ${actorId})`);
  const accrue = async (
    componentId: string,
    kind: "deduction" | "employer_contribution",
    liabilityAccountId: string,
    amount: string,
    label: string,
  ) => {
    const employeeId = randomUUID();
    const stubId = randomUUID();
    await seedPayrollPerson(org.orgId, employeeId, `October ${label}`, {
      subsidiaryId: org.subsidiaryId,
      createdBy: actorId,
      updatedBy: actorId,
    });
    const employmentId = await seedWorkerEmployment(org.orgId, employeeId, org.subsidiaryId);
    await seedPayrollStub(org.orgId, documentId, employeeId, employmentId, {
      country: "CA",
      countrySource: "calculation",
      id: stubId,
      province: "ON",
      periodsPerYear: 12,
      payDate: "2026-10-31",
      taxYear: 2026,
      currency: "CAD",
      gross: amount,
      pensionableEarnings: amount,
      insurableEarnings: amount,
      netPay: amount,
      employerCost: amount,
      vacationAccrued: "0",
      factors: {},
      filingAccountId,
      filingAccountSource: "calculation",
      createdBy: actorId,
      updatedBy: actorId,
    });
    await seedPayrollLine(org.orgId, stubId, componentId, {
      id: randomUUID(),
      kind,
      description: label,
      amount,
      sequence: 10,
      liabilityAccountId,
      liabilityAccountSource: "commit",
      remittancePartyId: null,
      createdBy: actorId,
      updatedBy: actorId,
    });
  };
  await accrue(taxComponentId, "deduction", craAccountId, "7679.31", "tax");
  await accrue(wcbComponentId, "employer_contribution", wcbAccountId, "425.99", "wcb");
  return {
    org,
    actorId,
    filingAccountId,
    craVendorId,
    wcbVendorId,
    taxComponentId,
    wcbComponentId,
  };
}

async function assignComponentVendor(orgId: string, componentId: string, vendorId: string | null) {
  await db.execute(sql`
    update pay_components set remittance_party_id = ${vendorId} where org_id = ${orgId} and id = ${componentId}`);
}

test(
  "liabilities committed before vendor assignment remit per current component vendor",
  { skip: !DB },
  async () => {
    const fx = await seedVendorlessOctober();
    try {
      const before = await payrollRemittanceSummary(fx.org.orgId, RANGE);
      assert.equal(before.length, 1, "vendorless October accrues into one unassigned card");
      assert.equal(before[0]!.partyId, null);
      assert.ok(
        cmp(before[0]!.total, "8105.30") === 0,
        `unassigned card totals the period, got ${before[0]!.total}`,
      );

      await assignComponentVendor(fx.org.orgId, fx.taxComponentId, fx.craVendorId);
      await assignComponentVendor(fx.org.orgId, fx.wcbComponentId, fx.wcbVendorId);

      const groups = await payrollRemittanceSummary(fx.org.orgId, RANGE);
      assert.equal(groups.length, 2, "one card per assigned vendor, no unassigned card");
      const cra = groups.find((g) => g.partyId === fx.craVendorId);
      const wcb = groups.find((g) => g.partyId === fx.wcbVendorId);
      assert.ok(
        cra && cmp(cra.total, "7679.31") === 0,
        `CRA card carries the tax liability, got ${cra?.total}`,
      );
      assert.equal(cra.partyName, "CRA - Payroll Deductions");
      assert.ok(
        wcb && cmp(wcb.total, "425.99") === 0,
        `WCB card carries the premium, got ${wcb?.total}`,
      );
      assert.equal(wcb.partyName, "WCB Alberta");

      const craBill = await createRemittanceBill(fx.org.orgId, fx.actorId, {
        partyId: fx.craVendorId,
        ...RANGE,
        filingAccountId: fx.filingAccountId,
      });
      assert.ok(craBill.documentId, "the CRA card raises its draft bill");
      await assert.rejects(
        createRemittanceBill(fx.org.orgId, fx.actorId, {
          partyId: fx.craVendorId,
          ...RANGE,
          filingAccountId: fx.filingAccountId,
        }),
        /already exists/,
        "an exact re-run is refused by name instead of minted twice",
      );

      // Reassigning the component afterwards must not move history: the
      // billed October lines keep the issued bill's vendor, the draft stays
      // current, and nothing new is billable to the new vendor.
      const thirdVendorId = randomUUID();
      await seedPayrollParty(fx.org.orgId, thirdVendorId, {
        kind: "company",
        displayName: "Other Collector",
        isActive: true,
      });
      await seedPayrollVendorRole(fx.org.orgId, thirdVendorId, fx.actorId);
      await assignComponentVendor(fx.org.orgId, fx.taxComponentId, thirdVendorId);
      const after = await payrollRemittanceSummary(fx.org.orgId, RANGE);
      const historic = after.find((g) => g.partyId === fx.craVendorId);
      assert.ok(
        historic && cmp(historic.total, "7679.31") === 0,
        "billed October lines keep the issued bill's vendor",
      );
      assert.ok(historic.existingBills.some((b) => b.documentId === craBill.documentId));
      assert.equal(
        after.find((g) => g.partyId === thirdVendorId),
        undefined,
        "no remainder leaks to the reassigned vendor",
      );
      await assertPayrollRemittanceBillCurrent(fx.org.orgId, craBill.documentId);
      await assert.rejects(
        createRemittanceBill(fx.org.orgId, fx.actorId, {
          partyId: thirdVendorId,
          ...RANGE,
          filingAccountId: fx.filingAccountId,
        }),
        PayrollError,
        "the reassigned vendor has nothing billable for the period",
      );
    } finally {
      await dropScratchOrg(fx.org.orgId);
    }
  },
);
