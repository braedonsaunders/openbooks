import { seedAdoption, seedRoeIssuanceFixture } from "./filing-test-fixtures.ts";
import { readRoeSeparationFacts, saveRoeSeparationFacts } from "./roe-separation-facts.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { mutatePayRunAdjustment } from "./run-adjustments.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { businessToday } from "../platform/business-date.ts";
import { withSimClock } from "../platform/clock.ts";
import { db } from "../platform/db.ts";
import {
  buildRoeXml,
  isRoeReasonCode,
  renderRoeXml,
  validateRoeXml,
  type RoeRecordToFile,
} from "./canada/roexml.ts";
import { sealSecret } from "../platform/secrets.ts";
import {
  dropScratchOrgReporting,
  seedPayrollSettings,
  grantScratchPermissions,
} from "../testing/fixtures.ts";
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
    id: "acct-2",
    accountNumber: "123456789RP0002",
    name: "Field division",
    remitterType: "regular",
  },
  payPeriodType: "B",
  sinLast3: "286",
  firstDayWorked: "2023-04-03",
  lastDayPaid: "2026-05-29",
  finalPayPeriodEnd: "2026-05-29",
  occupation: "Site supervisor",
  mailingAddress: {
    line1: "10 Main Street",
    line2: "Unit 4",
    city: "Toronto",
    region: "ON",
    postalCode: "M5V 2T6",
    country: "CA",
  },
  totalInsurableHours: "1820.50",
  totalInsurableEarnings: "48000.00",
  periods: [
    {
      payDate: "2026-06-05",
      periodStart: "2026-05-16",
      periodEnd: "2026-05-29",
      insurableEarnings: "2000.00",
      insurableHours: "80",
    },
    {
      payDate: "2026-05-22",
      periodStart: "2026-05-02",
      periodEnd: "2026-05-15",
      insurableEarnings: "1900.50",
      insurableHours: "76",
    },
  ],
  separationAmounts: [
    {
      block: "17A",
      code: "1",
      amount: "1500.25",
      expectedPaymentOn: "2026-05-29",
      paymentStatus: "paid",
    },
    {
      block: "17C",
      code: "S01",
      amount: "500.00",
      expectedPaymentOn: "2026-05-29",
      paymentStatus: "paid",
    },
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
  assert.match(
    xml,
    /<B16><CD>A00<\/CD><FN>Pat<\/FN><LN>Payroll<\/LN><AC>555<\/AC><TEL>5550100<\/TEL>/,
  );
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
    records: [
      file({
        issue: { employeePartyId: "emp-1", reasonCode: "K", comment: 'Ended <early> & "abruptly"' },
      }),
    ],
  });
  assert.match(xml, /<B18>Ended &lt;early&gt; &amp; &quot;abruptly&quot;<\/B18>/);
  assert.ok(!xml.includes("<early>"));
});

test("employees with no filing account file under the employer business number", () => {
  const xml = renderRoeXml({
    employer: EMPLOYER,
    records: [
      file({
        record: {
          ...RECORD,
          filingAccount: { id: null, accountNumber: null, name: null, remitterType: null },
        },
      }),
    ],
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
  const f = await seedAdoption();
  const org = { orgId: f.orgId };
  try {
    await seedPayrollSettings(f.orgId, { features: { payroll: true } });
    await grantScratchPermissions(f.orgId, f.actorId, ["payroll.read", "payroll.run"]);
    await db.execute(sql`update orgs set settings=jsonb_set(jsonb_set(settings,'{timeZone}','"Pacific/Auckland"'::jsonb),
      '{payroll,t4Transmitter}',${JSON.stringify(EMPLOYER)}::jsonb) where id=${f.orgId}`);
    const accountId = randomUUID();
    await db.execute(sql`insert into payroll_filing_accounts(id,org_id,subsidiary_id,country,program_type,account_number,name,is_active)
      values(${accountId},${f.orgId},${f.subsidiaryId},'CA','ca_rp','999999999RP0001','Canadian payroll account',true)`);
    await db.execute(sql`update employee_payroll_profiles set filing_account_id=${accountId},
      sin_encrypted=${sealSecret("046454286", { orgId: f.orgId, purpose: "payroll.employee.sin" })},sin_last3='286'
      where org_id=${f.orgId} and employee_party_id=${f.employeeId}`);
    await seedRoeIssuanceFixture(f.orgId, f.employeeId);
    const current = await readRoeSeparationFacts({
      orgId: f.orgId,
      actorId: f.actorId,
      employeePartyId: f.employeeId,
      allowedSubsidiaryIds: null,
    });
    assert.ok(current);
    await saveRoeSeparationFacts({
      orgId: f.orgId,
      actorId: f.actorId,
      employeePartyId: f.employeeId,
      employmentId: f.employmentId,
      subsidiaryId: f.subsidiaryId,
      allowedSubsidiaryIds: null,
      firstDayWorked: "2026-07-05",
      interruptionOn: "2026-07-19",
      lastInsurableEarningsOn: "2026-07-18",
      salaryContinuanceEndOn: null,
      sourceReference: "Original employer final service declaration",
      reason: "Confirm final worked date",
      status: "confirmed",
      expectedId: current.id,
      expectedUpdatedAt: current.updatedAt,
    });
    const component = await db.execute<{ id: string }>(
      sql`select id from pay_components where org_id=${f.orgId} and system_key='base_pay'`,
      "objects",
    );
    assert.equal(component.length, 1);
    const run = await createPayRun({
      orgId: f.orgId,
      actorId: f.actorId,
      payScheduleId: f.scheduleId,
      periodStart: "2026-07-05",
      periodEnd: "2026-07-18",
      payDate: "2026-07-21",
    });
    await mutatePayRunAdjustment({
      orgId: f.orgId,
      actorId: f.actorId,
      documentId: run.documentId,
      reason: "Original employee final wages",
      mutation: {
        action: "add",
        employeePartyId: f.employeeId,
        componentId: component[0]!.id,
        amount: "2000",
        hours: "80",
        replaceComponent: true,
        earnedFrom: "2026-07-05",
        earnedTo: "2026-07-18",
      },
    });
    assert.deepEqual(
      (await calculatePayRun({ orgId: f.orgId, actorId: f.actorId, documentId: run.documentId }))
        .errors,
      [],
    );
    await commitPayRun({ orgId: f.orgId, actorId: f.actorId, documentId: run.documentId });
    const before = await db.execute<{ snapshot: string }>(
      sql`select to_jsonb(stub)::text as snapshot from pay_stubs stub
      where org_id=${f.orgId} and pay_run_document_id=${run.documentId} order by id`,
      "objects",
    );
    const employeeId = f.employeeId;
    // 13:00Z on Jun 15 is already Jun 16 in Auckland. UTC today and wall-clock
    // today must not leak into a Service Canada upload filename.
    await withSimClock("2026-06-15T13:00:00Z", async () => {
      const file = await buildRoeXml(org.orgId, [{ employeePartyId: employeeId, reasonCode: "A" }]);
      assert.equal(file.filename, `ROE-${await businessToday(org.orgId)}.xml`);
      assert.equal(file.filename, "ROE-2026-06-16.xml");
      assert.notEqual(file.filename, `ROE-${new Date().toISOString().slice(0, 10)}.xml`);
      assert.notEqual(file.filename, "ROE-2026-06-15.xml");
      assert.deepEqual(
        await db.execute<{ snapshot: string }>(
          sql`select to_jsonb(stub)::text as snapshot from pay_stubs stub
        where org_id=${f.orgId} and pay_run_document_id=${run.documentId} order by id`,
          "objects",
        ),
        before,
        "filename generation preserves committed employee payroll",
      );
    });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
