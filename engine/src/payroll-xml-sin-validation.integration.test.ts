import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { sealSecret } from "./secrets.ts";
import { buildT4Xml } from "./payroll-t4xml.ts";
import { buildRl1Xml } from "./payroll-rl1xml.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

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
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      payroll: {
        t4Transmitter: {
          bn: "123456789", transmitterNumber: "MM123456", name: "SIN Test Employer",
          contactName: "Pat Payroll", contactEmail: "pat@example.com", contactPhone: "5555550100",
        },
        rl1Transmitter: {
          transmitterNumber: "NP123456", certificationNumber: "RQ-26-01-123",
          identificationNumber: "1234567890", fileSequence: 1, name: "SIN Test Employer",
          contactName: "Pat Payroll", contactEmail: "pat@example.com", contactPhone: "5555550100",
        },
      },
    })}::jsonb where id = ${org.orgId}`);

  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, subsidiary_id, custom)
    values (${employeeId}, ${org.orgId}, 'person', 'Sin Test', true, ${org.subsidiaryId}, '{}'::jsonb)`);
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
            ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                           pay_basis, country, federal_claim_code,
                                           provincial_claim_code, vacation_percent, vacation_method,
                                           sin_encrypted, sin_last3, is_active, created_by, updated_by)
    values (${org.orgId}, ${employeeId}, ${scheduleId}, ${province}, 'hourly', 'CA', 1, 1, '4', 'accrue',
            ${sealSecret(sin)}, ${sin.slice(-3)}, true, ${actorId}, ${actorId})`);

  const earningId = randomUUID();
  await db.execute(sql`
    insert into pay_components (id, org_id, code, name, kind, country, taxable, created_by, updated_by)
    values (${earningId}, ${org.orgId}, 'SAL', 'Salary', 'earning', 'CA', true, ${actorId}, ${actorId})`);
  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                           currency, status, created_by, updated_by)
    values (${org.orgId}, ${documentId}, 'pay_run', ${`PAY-${documentId.slice(0, 8)}`},
            ${org.subsidiaryId}, '2026-07-21', 'CAD', 'draft', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
                          tax_year, run_status, calculated_at, created_by, updated_by)
    values (${documentId}, ${org.orgId}, ${scheduleId}, '2026-07-05', '2026-07-18', '2026-07-21',
            2026, 'committed', now(), ${actorId}, ${actorId})`);
  const stubId = randomUUID();
  await db.execute(sql`
    insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, province,
                           periods_per_year, pay_date, tax_year, currency_code, gross, net_pay,
                           pensionable_earnings, insurable_earnings, factors, created_by, updated_by)
    values (${stubId}, ${org.orgId}, ${documentId}, ${employeeId}, ${province}, 26, '2026-07-21',
            2026, 'CAD', '52000.0000', '42000.0000', '52000.0000', '52000.0000',
            ${JSON.stringify({ C: "3200.50", EI: "834.20" })}::jsonb,
            ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, amount,
                                created_by, updated_by)
    values (${org.orgId}, ${stubId}, ${earningId}, 'earning', 'Salary', '52000.0000',
            ${actorId}, ${actorId})`);
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
