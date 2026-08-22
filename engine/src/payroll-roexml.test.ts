import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { businessToday } from "./business-date.ts";
import { withSimClock } from "./clock.ts";
import { db } from "./db.ts";
import { buildRoeXml, isRoeReasonCode, renderRoeXml, type RoeRecordToFile } from "./payroll-roexml.ts";
import { sealSecret } from "./secrets.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";
import type { RoeRecord } from "./payroll-yearend.ts";

/**
 * ROE Web bulk XML: the blocks Service Canada expects must all be present and
 * carry the payroll data — an ROE that silently drops a block is rejected at
 * upload or, worse, understates a claimant's entitlement.
 */

const EMPLOYER = {
  bn: "999999999RP0001",
  name: "Acme Ltd",
  contactName: "Pat Payroll",
  contactPhone: "5555550100",
};

const RECORD: RoeRecord = {
  employeePartyId: "emp-1",
  employeeName: "Grace Hopper",
  country: "CA",
  payrollReference: "E-4471",
  filingAccount: {
    id: "acct-2", accountNumber: "123456789RP0002", name: "Field division",
    remitterType: "regular",
  },
  payPeriodType: "B",
  sinLast3: "286",
  firstDayWorked: "2023-04-03",
  lastDayPaid: "2026-05-29",
  finalPayPeriodEnd: "2026-05-29",
  occupation: "Site supervisor",
  totalInsurableHours: "1820.50",
  totalInsurableEarnings: "48000.00",
  periods: [
    { payDate: "2026-06-05", periodStart: "2026-05-16", periodEnd: "2026-05-29", insurableEarnings: "2000.00", insurableHours: "80" },
    { payDate: "2026-05-22", periodStart: "2026-05-02", periodEnd: "2026-05-15", insurableEarnings: "1900.50", insurableHours: "76" },
  ],
  vacationPayOnSeparation: "1500.25",
  otherMoniesOnSeparation: "500.00",
};

const file = (overrides: Partial<RoeRecordToFile> = {}): RoeRecordToFile => ({
  record: RECORD,
  issue: { employeePartyId: "emp-1", reasonCode: "A" },
  sin: "046454286",
  ...overrides,
});

test("ROE XML carries every documented block", () => {
  const xml = renderRoeXml({ employer: EMPLOYER, records: [file()] });

  // Employer / payroll account (blocks 4 and 5): the employee's own program
  // account files the ROE, not the employer's default business number.
  assert.match(xml, /<PayrollReferenceNumber>E-4471<\/PayrollReferenceNumber>/);
  assert.match(xml, /<BusinessNumber>123456789RP0002<\/BusinessNumber>/);
  assert.match(xml, /<EmployerName>Acme Ltd<\/EmployerName>/);
  // Block 6 pay-period type, block 8 SIN, block 9 name, block 13 occupation.
  assert.match(xml, /<PayPeriodType>B<\/PayPeriodType>/);
  assert.match(xml, /<SIN>046454286<\/SIN>/);
  assert.match(xml, /<Surname>Hopper<\/Surname>/);
  assert.match(xml, /<GivenName>Grace<\/GivenName>/);
  assert.match(xml, /<Occupation>Site supervisor<\/Occupation>/);
  // Blocks 10 / 11 / 12 — employment dates.
  assert.match(xml, /<FirstDayWorked>2023-04-03<\/FirstDayWorked>/);
  assert.match(xml, /<LastDayPaid>2026-05-29<\/LastDayPaid>/);
  assert.match(xml, /<FinalPayPeriodEndDate>2026-05-29<\/FinalPayPeriodEndDate>/);
  // Blocks 15A / 15B totals and 15C per-period detail, newest period first.
  assert.match(xml, /<TotalInsurableHours>1820\.50<\/TotalInsurableHours>/);
  assert.match(xml, /<TotalInsurableEarnings>48000\.00<\/TotalInsurableEarnings>/);
  assert.equal(xml.match(/<PayPeriod>/g)?.length, 2);
  assert.match(
    xml,
    /<PayPeriodNumber>1<\/PayPeriodNumber><PayPeriodEndDate>2026-05-29<\/PayPeriodEndDate><InsurableEarnings>2000\.00<\/InsurableEarnings><InsurableHours>80\.00<\/InsurableHours>/,
  );
  assert.match(xml, /<PayPeriodNumber>2<\/PayPeriodNumber><PayPeriodEndDate>2026-05-15<\/PayPeriodEndDate>/);
  // Block 16 reason + contact, block 17 separation payments.
  assert.match(xml, /<ReasonForIssue>A<\/ReasonForIssue>/);
  assert.match(xml, /<VacationPay>1500\.25<\/VacationPay>/);
  assert.match(xml, /<OtherMonies>500\.00<\/OtherMonies>/);
  assert.match(xml, /<ContactName>Pat Payroll<\/ContactName>/);
  assert.match(xml, /<ROEs count="1">/);
});

test("ROE XML is a bulk file: one <ROE> per employee", () => {
  const second = file({
    record: { ...RECORD, employeeName: "Ada Byron", payrollReference: "E-9001" },
    issue: { employeePartyId: "emp-2", reasonCode: "K", comment: "Contract cancelled" },
  });
  const xml = renderRoeXml({ employer: EMPLOYER, records: [file(), second] });
  assert.equal(xml.match(/<ROE>/g)?.length, 2);
  assert.match(xml, /<ROEs count="2">/);
  // Block 18 comment travels with reason K.
  assert.match(xml, /<Comment>Contract cancelled<\/Comment>/);
});

test("ROE XML escapes employer-authored text", () => {
  const xml = renderRoeXml({
    employer: EMPLOYER,
    records: [file({
      issue: { employeePartyId: "emp-1", reasonCode: "K", comment: 'Ended <early> & "abruptly"' },
    })],
  });
  assert.match(xml, /<Comment>Ended &lt;early&gt; &amp; &quot;abruptly&quot;<\/Comment>/);
  assert.ok(!xml.includes("<early>"));
});

test("employees with no filing account file under the employer business number", () => {
  const xml = renderRoeXml({
    employer: EMPLOYER,
    records: [file({
      record: {
        ...RECORD,
        filingAccount: { id: null, accountNumber: null, name: null, remitterType: null },
      },
    })],
  });
  assert.match(xml, /<BusinessNumber>999999999RP0001<\/BusinessNumber>[\s\S]*<PayPeriodType>/);
});

test("reason-for-issue codes are a closed statutory set", () => {
  assert.ok(isRoeReasonCode("A"));
  assert.ok(isRoeReasonCode("K"));
  assert.ok(!isRoeReasonCode("Q"));
  assert.ok(!isRoeReasonCode(""));
  assert.ok(!isRoeReasonCode(undefined));
});

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

test("ROE XML filenames stamp the org calendar day, not UTC today", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await db.execute(sql`
      update orgs set settings = ${JSON.stringify({
        timeZone: "Pacific/Auckland",
        payroll: {
          t4Transmitter: {
            bn: "999999999RP0001",
            name: "Acme Ltd",
            contactName: "Pat Payroll",
            contactPhone: "5555550100",
          },
        },
      })}::jsonb where id = ${org.orgId}`);

    const employeeId = randomUUID();
    const scheduleId = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, subsidiary_id, custom)
      values (${employeeId}, ${org.orgId}, 'person', 'Grace Hopper', true, ${org.subsidiaryId}, '{}'::jsonb)`);
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
      values (${org.orgId}, ${employeeId}, ${scheduleId}, 'ON', 'hourly', 'CA', 1, 1, '4', 'accrue',
              ${sealSecret("046454286")}, '286', true, ${actorId}, ${actorId})`);

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
    await db.execute(sql`
      insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, province,
                             periods_per_year, pay_date, tax_year, currency_code, gross, net_pay,
                             pensionable_earnings, insurable_earnings, factors, created_by, updated_by)
      values (${randomUUID()}, ${org.orgId}, ${documentId}, ${employeeId}, 'ON', 26, '2026-07-21',
              2026, 'CAD', '2000.0000', '2000.0000', '2000.0000', '2000.0000',
              '{}'::jsonb, ${actorId}, ${actorId})`);

    // 13:00Z on Jun 15 is already Jun 16 in Auckland. UTC today and wall-clock
    // today must not leak into a Service Canada upload filename.
    await withSimClock("2026-06-15T13:00:00Z", async () => {
      const file = await buildRoeXml(org.orgId, [{ employeePartyId: employeeId, reasonCode: "A" }]);
      assert.equal(file.filename, `ROE-${await businessToday(org.orgId)}.xml`);
      assert.equal(file.filename, "ROE-2026-06-16.xml");
      assert.notEqual(file.filename, `ROE-${new Date().toISOString().slice(0, 10)}.xml`);
      assert.notEqual(file.filename, "ROE-2026-06-15.xml");
    });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
