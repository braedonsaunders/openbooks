import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { businessToday } from "../platform/business-date.ts";
import { withSimClock } from "../platform/clock.ts";
import { db } from "../platform/db.ts";
import { buildRoeXml, isRoeReasonCode, renderRoeXml, validateRoeXml, type RoeRecordToFile } from "./canada/roexml.ts";
import { sealSecret } from "../platform/secrets.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors, seedWorkerEmployment } from "../testing/fixtures.ts";
import type { RoeRecord } from "./yearend.ts";

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
  mailingAddress: {
    line1: "10 Main Street", line2: "Unit 4", city: "Toronto", region: "ON",
    postalCode: "M5V 2T6", country: "CA",
  },
  totalInsurableHours: "1820.50",
  totalInsurableEarnings: "48000.00",
  periods: [
    { payDate: "2026-06-05", periodStart: "2026-05-16", periodEnd: "2026-05-29", insurableEarnings: "2000.00", insurableHours: "80" },
    { payDate: "2026-05-22", periodStart: "2026-05-02", periodEnd: "2026-05-15", insurableEarnings: "1900.50", insurableHours: "76" },
  ],
  separationAmounts: [
    { block: "17A", code: "1", amount: "1500.25", expectedPaymentOn: "2026-05-29", paymentStatus: "paid" },
    { block: "17C", code: "S01", amount: "500.00", expectedPaymentOn: "2026-05-29", paymentStatus: "paid" },
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

test("ROE Payroll Extract v2 includes the employee address and validates against Service Canada's XSD", async () => {
  const xml = renderRoeXml({ employer: EMPLOYER, records: [file()] });
  await validateRoeXml(xml);
  // These B-tags, order and attributes are the published Appendix D contract.
  assert.match(xml, /<ROEHEADER FileVersion="W-2\.0"/);
  assert.match(xml, /<B5>123456789RP0002<\/B5>/);
  assert.match(xml, /<B9><FN>Grace<\/FN><LN>Hopper<\/LN><A1>10 Main Street<\/A1>/);
  assert.match(xml, /<A2>Toronto ON<\/A2><A3>Unit 4<\/A3><PC>M5V2T6<\/PC><\/B9>/);
  assert.match(xml, /<B16><CD>A00<\/CD><FN>Pat<\/FN><LN>Payroll<\/LN><AC>555<\/AC><TEL>5550100<\/TEL>/);
  assert.match(xml, /<B17A>\s*<VP nbr="1"><CD>1<\/CD><AMT>1500\.25<\/AMT><\/VP><\/B17A>/);
  assert.match(xml, /<B17C>[\s\S]*<CD>S01<\/CD><AMT>500\.00<\/AMT>/);
});

test("ROE XML is a bulk file: one <ROE> per employee", () => {
  const second = file({
    record: { ...RECORD, employeeName: "Ada Byron", payrollReference: "E-9001" },
    issue: { employeePartyId: "emp-2", reasonCode: "K", comment: "Contract cancelled" },
  });
  const xml = renderRoeXml({ employer: EMPLOYER, records: [file(), second] });
  assert.equal(xml.match(/<ROE PrintingLanguage/g)?.length, 2);
  // Block 18 comment travels with reason K.
  assert.match(xml, /<B18>Contract cancelled<\/B18>/);
});

test("ROE XML escapes employer-authored text", () => {
  const xml = renderRoeXml({
    employer: EMPLOYER,
    records: [file({
      issue: { employeePartyId: "emp-1", reasonCode: "K", comment: 'Ended <early> & "abruptly"' },
    })],
  });
  assert.match(xml, /<B18>Ended &lt;early&gt; &amp; &quot;abruptly&quot;<\/B18>/);
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
  assert.match(xml, /<B5>999999999RP0001<\/B5>[\s\S]*<B6>B<\/B6>/);
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
    const employmentId = await seedWorkerEmployment(org.orgId, employeeId, org.subsidiaryId);
    await db.execute(sql`
      insert into addresses (org_id, party_id, line1, city, region, postal_code, country)
      values (${org.orgId}, ${employeeId}, '10 Main Street', 'Toronto', 'ON', 'M5V 2T6', 'CA')`);
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
      insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, employment_id,
                             province, periods_per_year, pay_date, tax_year, currency_code, gross,
                             net_pay, pensionable_earnings, insurable_earnings, factors, created_by,
                             updated_by)
      values (${randomUUID()}, ${org.orgId}, ${documentId}, ${employeeId}, ${employmentId}, 'ON',
              26, '2026-07-21', 2026, 'CAD', '2000.0000', '2000.0000', '2000.0000', '2000.0000',
              '{}'::jsonb, ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into payroll_roe_separation_events
        (org_id, employee_party_id, interruption_on, last_insurable_earnings_on, status, change_reason, created_by, updated_by)
      values (${org.orgId}, ${employeeId}, '2026-07-22', '2026-07-18', 'confirmed', 'fixture', ${actorId}, ${actorId})`);

    // Confirmed separation facts: the ROE refuses by name without them.
    await db.execute(sql`
      insert into payroll_roe_separation_events
        (id, org_id, employee_party_id, interruption_on, last_insurable_earnings_on,
         salary_continuance_end_on, status, change_reason)
      values (${randomUUID()}, ${org.orgId}, ${employeeId}, '2026-07-22', '2026-07-21',
              null, 'confirmed', 'fixture separation')`);

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
