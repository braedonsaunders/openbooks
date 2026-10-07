import { seedPayrollAccountingConfiguration } from '../testing/fixtures.ts';
import { seedPayrollLine } from '../testing/fixtures.ts';
import { seedPayrollDocument, seedPayrollStub } from '../testing/fixtures.ts';
import {
  seedPayrollSchedule, seedPayrollPerson, seedPayrollProfile, createScratchOrg, dropScratchOrgReporting, seedFlowActors,
  seedWorkerEmployment,
} from "../testing/fixtures.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sealSecret } from "../platform/secrets.ts";
import { buildT4Xml } from "./canada/t4xml.ts";
import { buildRl1Xml } from "./canada/quebec/rl1xml.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * T4 and RL-1 transmission refuses a 9-digit non-SIN.
 *
 * A US SSN is also nine digits, and a transposed keystroke usually is too, so
 * `/^\d{9}$/` alone is not an identity check — a SIN carries a Luhn check
 * digit. The ROE builder already enforces `isCanadianSin` for exactly this
 * reason (a foreign identifier transmitted to Service Canada under the
 * employer's CRA number); the T4 and RL-1 builders accepted the same digits
 * and produced a file the agency rejects. Both gates now share the one
 * check, so "123456789" (the shape the controls suite already documents as
 * "a plausible SSN shape") is refused while a real SIN transmits.
 */

async function seedSinYear(sin: string, province: "ON" | "QC"): Promise<{ orgId: string; actorId: string }> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await seedPayrollAccountingConfiguration(org.orgId, {
        t4Transmitter: {
          bn: "123456789", transmitterNumber: "MM123456", name: "SIN Test Employer",
          contactName: "Pat Payroll", contactEmail: "pat@example.com", contactPhone: "5555550100",
        },
        rl1Transmitter: {
          transmitterNumber: "NP123456", certificationNumber: "RQ-26-01-123",
          identificationNumber: "1234567890", fileSequence: 1, name: "SIN Test Employer",
          contactName: "Pat Payroll", contactEmail: "pat@example.com", contactPhone: "5555550100",
        },
      });

  // The declared employee election references a native report-only program.
  await db.execute(sql`
    insert into entitlement_plans (org_id, code, system_key, name, unit, direction,
      accrual_method, accrual_value, liability_account_id, cap_behavior, is_active, created_by, updated_by)
    values (${org.orgId}, 'VAC', 'vacation', 'Vacation', 'money', 'accrue',
      'percent_of_earnings', '4.0000', null, 'warn', true, ${actorId}, ${actorId})`);

  const employeeId = randomUUID();
  await seedPayrollPerson(org.orgId, employeeId, 'Sin Test', {
    subsidiaryId: org.subsidiaryId,
  });
  const employmentId = await seedWorkerEmployment(org.orgId, employeeId, org.subsidiaryId);
  const scheduleId = randomUUID();
  await seedPayrollSchedule(org.orgId, scheduleId, actorId, {
    name: 'Biweekly', frequency: 'biweekly', periodsPerYear: 26, anchorPeriodEnd: '2026-07-18',
    payDateOffsetDays: 3,
  });
  await seedPayrollProfile(org.orgId, employeeId, employmentId, scheduleId, actorId, {
    province: province, payBasis: 'hourly', country: 'CA', federalClaimCode: 1, provincialClaimCode: 1,
    sinEncrypted: sealSecret(sin, { orgId: org.orgId, purpose: "payroll.employee.sin" }), sinLast3: sin.slice(-3),
  }, { percentFloor: '4', method: 'accrue' });


  const earningId = randomUUID();
  await db.execute(sql`
    insert into pay_components (id, org_id, code, name, kind, country, taxable, created_by, updated_by)
    values (${earningId}, ${org.orgId}, 'SAL', 'Salary', 'earning', 'CA', true, ${actorId}, ${actorId})`);
  const documentId = randomUUID();
  await seedPayrollDocument(org.orgId, documentId, {
    kind: 'pay_run', documentNumber: `PAY-${documentId.slice(0, 8)}`, subsidiaryId: org.subsidiaryId,
    documentDate: '2026-07-21', currency: 'CAD', status: 'draft', createdBy: actorId, updatedBy: actorId,
  });
  await db.execute(sql`
    insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
                          tax_year, run_status, calculated_at, created_by, updated_by)
    values (${documentId}, ${org.orgId}, ${scheduleId}, '2026-07-05', '2026-07-18', '2026-07-21',
            2026, 'committed', now(), ${actorId}, ${actorId})`);
  const stubId = randomUUID();
  await seedPayrollStub(org.orgId, documentId, employeeId, employmentId, {
    id: stubId, province: province, periodsPerYear: 26, payDate: '2026-07-21', taxYear: 2026, currency: 'CAD',
    gross: '52000.0000', netPay: '42000.0000', pensionableEarnings: '52000.0000', insurableEarnings: '52000.0000',
    factors: { C: "3200.50", EI: "834.20" }, createdBy: actorId, updatedBy: actorId,
  });
  await seedPayrollLine(org.orgId, stubId, earningId, {
    kind: 'earning', description: 'Salary', amount: '52000.0000', createdBy: actorId, updatedBy: actorId,
  });
  return { orgId: org.orgId, actorId };
}

test(
  "the T4 file refuses a nine-digit number that is not a SIN",
  { skip: !DB },
  async () => {
    const fx = await seedSinYear("123456789", "ON");
    try {
      await assert.rejects(buildT4Xml(fx.orgId, 2026), /missing or invalid SIN/);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "the T4 file still builds for a Luhn-valid SIN",
  { skip: !DB },
  async () => {
    const fx = await seedSinYear("046454286", "ON");
    try {
      const file = await buildT4Xml(fx.orgId, 2026);
      assert.equal(file.slipCount, 1);
      assert.match(file.xml, /<SIN>046454286<\/SIN>/);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "the RL-1 validation refuses a nine-digit number that is not a SIN",
  { skip: !DB },
  async () => {
    const fx = await seedSinYear("123456789", "QC");
    try {
      // buildRl1Xml never renders (the partner-gated refusal), but the SIN
      // gate runs first: a bad SIN must fail as a bad SIN, not as a refusal
      // to render.
      await assert.rejects(buildRl1Xml(fx.orgId, 2026), /missing or invalid SIN/);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "the RL-1 validation passes a Luhn-valid SIN through to the named refusal",
  { skip: !DB },
  async () => {
    const fx = await seedSinYear("046454286", "QC");
    try {
      await assert.rejects(buildRl1Xml(fx.orgId, 2026), /not generated/);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
