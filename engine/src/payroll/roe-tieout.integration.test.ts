import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { add, cmp } from "../money/money.ts";
import { seedAdoption } from "./filing-test-fixtures.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { roeCandidates, roeRecord, t4Slips } from "./yearend.ts";
import { qualifyRoeLine } from "./roe-history.ts";
import { grantScratchPermissions } from "../testing/fixtures.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * ROE Block 17 carries declared separation payments and Block 11 the
 * continuance end; candidates and T4 reconcile to payroll.
 */
test(
  "a terminated employee's ROE record, candidacy, and T4 include separation facts",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const filingAccountId = randomUUID();
      assert.equal(
        (
          await db.execute(
            sql`insert into payroll_filing_accounts(id,org_id,subsidiary_id,country,program_type,account_number,name,is_active)
        values(${filingAccountId},${fx.orgId},${fx.subsidiaryId},'CA','ca_rp','123456789RP0001','Original payroll account',true) returning id`,
            "objects",
          )
        ).length,
        1,
      );
      assert.equal(
        (
          await db.execute(
            sql`update employee_payroll_profiles set filing_account_id=${filingAccountId}
        where org_id=${fx.orgId} and employee_party_id=${fx.employeeId} returning employee_party_id`,
            "objects",
          )
        ).length,
        1,
      );
      // No EHT insert here: seedAdoption already carries the decided ON EHT
      // rate, and a second row for the same key conflicts.
      await db.execute(sql`insert into addresses (org_id, party_id, line1, city, region, postal_code, country)
        values (${fx.orgId}, ${fx.employeeId}, '10 Main Street', 'Toronto', 'ON', 'M5V 2T6', 'CA')`);
      await db.execute(sql`
        update employee_roles set terminated_on = '2026-08-10'
         where org_id = ${fx.orgId} and party_id = ${fx.employeeId}`);
      const hours = (day: string, h: string) =>
        db.execute(sql`
          insert into time_entries (org_id, employee_party_id, worked_on, hours, status,
                                    is_billable, billing_status, costing_basis,
                                    created_by, updated_by)
          values (${fx.orgId}, ${fx.employeeId}, ${day}, ${h}, 'approved', false,
                  'unbilled', 'actual', ${fx.actorId}, ${fx.actorId})`);
      for (const day of ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]) {
        await hours(day, "8");
      }
      const regular = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05",
        periodEnd: "2026-07-18",
      });
      assert.deepEqual(
        (
          await calculatePayRun({
            orgId: fx.orgId,
            documentId: regular.documentId,
            actorId: fx.actorId,
          })
        ).errors,
        [],
      );
      await commitPayRun({ orgId: fx.orgId, documentId: regular.documentId, actorId: fx.actorId });

      for (const day of ["2026-07-20", "2026-07-22"]) {
        await hours(day, "8");
      }
      const final = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-19",
        periodEnd: "2026-08-01",
        runType: "termination",
        employeePartyIds: [fx.employeeId],
      });
      assert.deepEqual(
        (
          await calculatePayRun({
            orgId: fx.orgId,
            documentId: final.documentId,
            actorId: fx.actorId,
          })
        ).errors,
        [],
      );
      await commitPayRun({ orgId: fx.orgId, documentId: final.documentId, actorId: fx.actorId });

      // Paid salary-continuance service occupies its actual scheduled period.
      await hours("2026-08-05", "8");
      const continuance = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-08-02",
        periodEnd: "2026-08-15",
      });
      assert.deepEqual(
        (
          await calculatePayRun({
            orgId: fx.orgId,
            actorId: fx.actorId,
            documentId: continuance.documentId,
          })
        ).errors,
        [],
      );
      await commitPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: continuance.documentId,
      });

      // Ground truth, straight from committed stubs.
      const agg = await db.execute<{ gross: string }>(
        sql`
        select sum(s.gross)::text as gross
          from pay_stubs s
          join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
         where s.org_id = ${fx.orgId} and r.run_status = 'committed'`,
        "objects",
      );
      const stubGross = agg.reduce((a, r) => add(a, r.gross), "0");

      const eventId = randomUUID();
      await db.execute(sql`
        with event as (insert into payroll_roe_separation_events
          (id, org_id, employee_party_id,employment_id,subsidiary_id,first_day_worked,source_reference,
           interruption_on, last_insurable_earnings_on, salary_continuance_end_on, status, change_reason)
          values (${eventId}, ${fx.orgId}, ${fx.employeeId},${fx.employmentId},${fx.subsidiaryId},'2026-07-06','Original separation declaration','2026-08-10', '2026-08-01', '2026-08-05', 'confirmed', 'fixture') returning id),
        components as (select distinct component.id, component.code from pay_stub_lines line
          join pay_stubs stub on stub.org_id = line.org_id and stub.id = line.stub_id
          join pay_components component on component.org_id = line.org_id and component.id = line.component_id
          where stub.org_id = ${fx.orgId} and stub.employee_party_id = ${fx.employeeId} and line.kind = 'earning'),
        classified as (insert into payroll_roe_component_classifications
          (org_id, pay_component_id, effective_from, block, category_code, change_reason)
          select ${fx.orgId}::uuid, id, '2020-01-01', case when code = 'VACPAY' then '17A' else 'none' end,
                 case when code = 'VACPAY' then '1' else null end, 'fixture' from components returning pay_component_id)
        insert into payroll_roe_separation_payments
          (org_id, separation_event_id, pay_component_id, amount, payment_status, expected_payment_on, change_reason)
        select ${fx.orgId}::uuid, event.id, components.id, '57.6000'::numeric, 'paid', '2026-08-01'::date, 'fixture'
          from event cross join components where components.code = 'VACPAY'
        union all
        select ${fx.orgId}::uuid, event.id, components.id, '10.0000'::numeric, 'will_pay', '2026-08-20'::date, 'fixture'
          from event cross join components where components.code = 'VACPAY'
      `);

      await grantScratchPermissions(fx.orgId, fx.actorId, ["payroll.read", "payroll.run"]);
      await assert.rejects(
        roeRecord(fx.orgId, fx.employeeId),
        /retained insurable-hour attribution/,
      );
      // The employer's declared time and vacation records supply hours independently
      // of component settings and the retained statutory calculation.
      const sourceRows = [
        ...["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"].map((day) => ({
          documentId: regular.documentId,
          key: "base_pay",
          amount: "240",
          hours: "8",
          start: "2026-07-05",
          end: "2026-07-18",
          from: day,
          to: day,
        })),
        ...["2026-07-20", "2026-07-22"].map((day) => ({
          documentId: final.documentId,
          key: "base_pay",
          amount: "240",
          hours: "8",
          start: "2026-07-19",
          end: "2026-08-01",
          from: day,
          to: day,
        })),
        // Final pay separately pays the prior 960 × 4% accrued balance and
        // the current 480 × 4% cash vacation entitlement.
        {
          documentId: final.documentId,
          key: "vacation_payout",
          amount: "38.40",
          hours: "0",
          start: "2026-07-19",
          end: "2026-08-01",
          from: "2026-07-19",
          to: "2026-08-01",
        },
        {
          documentId: final.documentId,
          key: "vacation_payout",
          amount: "19.20",
          hours: "0",
          start: "2026-07-19",
          end: "2026-08-01",
          from: "2026-07-19",
          to: "2026-08-01",
        },
        {
          documentId: continuance.documentId,
          key: "base_pay",
          amount: "240",
          hours: "8",
          start: "2026-08-02",
          end: "2026-08-15",
          from: "2026-08-05",
          to: "2026-08-05",
        },
      ];
      const bytes = Buffer.from(
        JSON.stringify({
          employeePartyId: fx.employeeId,
          employmentId: fx.employmentId,
          employerSubsidiaryId: fx.subsidiaryId,
          insurable: true,
          sourceRows,
        }),
      );
      const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
      const folder = randomUUID(),
        file = randomUUID(),
        version = randomUUID();
      assert.equal(
        (
          await db.execute(
            sql`insert into folders(id,org_id,name,is_private,owner_id,created_by,updated_by)
        values(${folder},${fx.orgId},'Original separation reporting evidence',true,${fx.actorId},${fx.actorId},${fx.actorId}) returning id`,
            "objects",
          )
        ).length,
        1,
      );
      assert.equal(
        (
          await db.execute(
            sql`insert into files(id,org_id,folder_id,name,content_type,size_bytes,created_by,updated_by)
        values(${file},${fx.orgId},${folder},'original-paid-hours.json','application/json',${bytes.length},${fx.actorId},${fx.actorId}) returning id`,
            "objects",
          )
        ).length,
        1,
      );
      assert.equal(
        (
          await db.execute(
            sql`insert into file_versions(id,file_id,version_number,size_bytes,content_type,content_hash,created_by)
        values(${version},${file},1,${bytes.length},'application/json',${sourceSha256},${fx.actorId}) returning id`,
            "objects",
          )
        ).length,
        1,
      );
      assert.equal(
        (
          await db.execute(
            sql`insert into file_blobs(version_id,bytes) values(${version},${bytes}) returning id`,
            "objects",
          )
        ).length,
        1,
      );
      assert.equal(
        (
          await db.execute(
            sql`update files set current_version_id=${version} where org_id=${fx.orgId} and id=${file} returning id`,
            "objects",
          )
        ).length,
        1,
      );
      const paidLines = await db.execute<{
        id: string;
        documentId: string;
        key: string;
        amount: string;
        earnedFrom: string | null;
        earnedTo: string | null;
      }>(
        sql`
        select line.id,stub.pay_run_document_id as "documentId",component.system_key as key,line.amount::text as amount,line.earned_from::text as "earnedFrom",line.earned_to::text as "earnedTo"
        from pay_stub_lines line join pay_stubs stub on stub.org_id=line.org_id and stub.id=line.stub_id
        join pay_components component on component.org_id=line.org_id and component.id=line.component_id
        where line.org_id=${fx.orgId} and stub.employee_party_id=${fx.employeeId} and line.kind='earning'
          and (line.amount<>0 or line.hours<>0)`,
        "objects",
      );
      assert.equal(paidLines.length, sourceRows.length, JSON.stringify(paidLines));
      for (const source of sourceRows) {
        const matches = paidLines.filter(
          (line) =>
            line.documentId === source.documentId &&
            line.key === source.key &&
            cmp(line.amount, source.amount) === 0 &&
            (source.key !== "base_pay" ||
              (line.earnedFrom === source.from && line.earnedTo === source.to)),
        );
        assert.equal(matches.length, 1);
        assert.equal(cmp(matches[0]!.amount, source.amount), 0);
        await qualifyRoeLine(
          {
            orgId: fx.orgId,
            actorId: fx.actorId,
            employeePartyId: fx.employeeId,
            employmentId: fx.employmentId,
            subsidiaryId: fx.subsidiaryId,
            eventId,
            allowedSubsidiaryIds: null,
          },
          {
            payStubLineId: matches[0]!.id,
            reportPeriodStart: source.start,
            reportPeriodEnd: source.end,
            earnedFrom: source.from,
            earnedTo: source.to,
            isInsurable: true,
            insurableHours: source.hours,
            sourceFileId: file,
            sourceVersionId: version,
            sourceSha256,
            sourceReference: "Original employee separation pay and time record",
            insuranceReference: "Declared insurable wages and vacation payout",
            hoursReference: "Recorded worked hours; vacation payout carries zero additional hours",
            reason: "Qualify original reporting allocations",
            expectedId: null,
            expectedUpdatedAt: null,
          },
        );
      }
      const record = await roeRecord(fx.orgId, fx.employeeId);
      assert.ok(record, "a Canadian terminated employee gets an ROE record");
      assert.equal(record!.lastDayPaid, "2026-08-05");
      assert.equal(record!.finalPayPeriodEnd, "2026-08-15");
      assert.equal(record!.periods.length, 3);
      assert.equal(record!.totalInsurableHours, "56.0000");
      assert.equal(record!.vacationPayOnSeparation, "67.6000");

      const candidates = await roeCandidates(fx.orgId, 2026);
      assert.ok(
        candidates.some((c) => c.employeePartyId === fx.employeeId),
        "the terminated employee is an ROE candidate",
      );

      const slips = await t4Slips(fx.orgId, 2026);
      assert.equal(slips.length, 1);
      assert.equal(slips[0]!.box14EmploymentIncome, stubGross);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
