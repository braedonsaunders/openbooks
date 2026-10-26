import { seedPayrollAccountingConfiguration } from "../testing/fixtures.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp, sum } from "../money/money.ts";
import { setPackSlotAccount } from "./packs.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { mutatePayRunAdjustment, PayRunAdjustmentIdempotencyConflict } from "./run-adjustments.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { seedOntarioEhtFixture, seedVacationTerms } from "./filing-test-fixtures.ts";
import {
  createScratchOrg,
  dropScratchOrgReporting,
  seedFlowActors,
  seedWorkerEmployment,
  grantScratchPermissions,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * An audited employer-only issued levy entry books the exact issued premium
 * beside the native assessment, without touching assessable earnings,
 * native assessed factors, or employee net pay.
 *
 * Biweekly salary 1,000.00 prices assessed WCB 13.20 at 1.32% and assessed
 * EHT 19.50 at 1.95% (no exemption in this fixture). Issued operator
 * entries of 17.82 (WCB) and 26.32 (EHT) take the stub LINES to 31.02 and
 * 45.82 while assessed factors stay 13.20/19.50 on 1,000.00 of assessable
 * earnings and the issued amounts are retained separately as WCB_ADJ and
 * EHT_ADJ; the unadjusted peer keeps the native amounts and both stubs
 * pay the same net.
 */
test(
  "employer levy adjustment books the issued premium beside assessment with no net-pay effect",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await grantScratchPermissions(org.orgId, actorId, ["payroll.manage"]);
    try {
      const account = async (number: string, name: string, type: string) => {
        const id = randomUUID();
        await db.execute(sql`
          insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                                reconcilable, required_dimensions, custom, subsidiary_include_children)
          values (${id}, ${org.orgId}, ${number}, ${name}, ${type}, false, true, false, false,
                  '[]'::jsonb, '{}'::jsonb, true)`);
        return id;
      };
      const wageExpense = await account("6000", "Wages expense", "expense");
      const burdenExpense = await account("6010", "Payroll burden", "expense");
      const netPayable = await account("2300", "Wages payable", "liability_current");
      const craPayable = await account("2310", "CRA remittances payable", "liability_current");
      const wcbPayable = await account("2330", "WSIB payable", "liability_current");
      const ehtPayable = await account("2340", "EHT payable", "liability_current");
      await seedPayrollAccountingConfiguration(org.orgId, {
        wageExpenseAccountId: wageExpense,
        burdenExpenseAccountId: burdenExpense,
        netPayAccountId: netPayable,
        wagesTo: "expense",
        slotAccounts: {
          CA: { cpp: craPayable, ei: craPayable, qpip: craPayable, income_tax: craPayable },
        },
      });

      await seedPayrollComponents(org.orgId, actorId, "CA");
      await seedOntarioEhtFixture(org.orgId, actorId, "0");
      await setPackSlotAccount(org.orgId, actorId, "CA", "wcb", wcbPayable);
      await setPackSlotAccount(org.orgId, actorId, "CA", "eht", ehtPayable);

      const wcbGroupId = randomUUID();
      await db.execute(sql`
        insert into worker_comp_groups (id, org_id, code, name, rate_percent, max_assessable, is_active)
        values (${wcbGroupId}, ${org.orgId}, 'CLASS-A', 'Construction class A', '1.32', '121700', true)`);
      const otherGroupId = randomUUID();
      await db.execute(sql`
        insert into worker_comp_groups (id, org_id, code, name, rate_percent, max_assessable, is_active)
        values (${otherGroupId}, ${org.orgId}, 'CLASS-B', 'Construction class B', '1.32', '121700', true)`);

      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
                ${actorId}, ${actorId})`);

      const hire = async (name: string) => {
        const employeeId = randomUUID();
        await db.execute(sql`
          insert into parties (id, org_id, kind, display_name, is_active, custom)
          values (${employeeId}, ${org.orgId}, 'person', ${name}, true, '{}'::jsonb)`);
        await db.execute(sql`
          insert into employee_roles (id, org_id, party_id, worker_comp_group_id)
          values (${randomUUID()}, ${org.orgId}, ${employeeId}, ${wcbGroupId})`);
        await db.execute(sql`
          insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                        is_active, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, 'CAD', '26000', 'year', '2026-01-01', true,
                  ${actorId}, ${actorId})`);
        const employmentId = await seedWorkerEmployment(org.orgId, employeeId, org.subsidiaryId);
        await db.execute(sql`
          insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id,
                                                 country, province, pay_basis, federal_claim_code,
                                                 provincial_claim_code, is_active, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, ${employmentId}, ${scheduleId}, 'CA', 'ON', 'salary', 1, 1,
                  true, ${actorId}, ${actorId})`);
        await seedVacationTerms(org.orgId, employmentId, actorId, "0", "accrue");
        return employeeId;
      };
      const adjustedId = await hire("Robin Crew");
      const peerId = await hire("Casey Peer");

      const run = await createPayRun({
        orgId: org.orgId,
        actorId,
        payScheduleId: scheduleId,
        periodStart: "2026-07-05",
        periodEnd: "2026-07-18",
      });
      const base = {
        orgId: org.orgId,
        documentId: run.documentId,
        actorId,
        allowedSubsidiaryIds: null,
      };
      const reason =
        "Issued catch-up for disability earnings the levy group omitted in an earlier quarter";

      // Employee-side programmes and unconfigured shapes refuse by name.
      await assert.rejects(
        mutatePayRunAdjustment({
          ...base,
          reason,
          mutation: {
            action: "employer_levy_adjustment",
            employeePartyId: adjustedId,
            programKey: "cpp" as never,
            amount: "17.82",
            sourceKey: "source-card:00001:313",
            reason,
            sourceReference: "adjustment cheque 43129",
            idempotencyKey: randomUUID(),
          },
        }),
        /employer-only levy programme/,
      );
      await assert.rejects(
        mutatePayRunAdjustment({
          ...base,
          reason,
          mutation: {
            action: "employer_levy_adjustment",
            employeePartyId: adjustedId,
            programKey: "ca_wcb",
            workerCompGroupId: otherGroupId,
            amount: "17.82",
            sourceKey: "source-card:00002:313",
            reason,
            sourceReference: "adjustment cheque 43129",
            idempotencyKey: randomUUID(),
          },
        }),
        /not this employee's group on the run's pay date/,
      );
      await assert.rejects(
        mutatePayRunAdjustment({
          ...base,
          reason,
          mutation: {
            action: "employer_levy_adjustment",
            employeePartyId: adjustedId,
            programKey: "ca_eht",
            workerCompGroupId: wcbGroupId,
            amount: "26.32",
            sourceKey: "source-card:00003:305",
            reason,
            sourceReference: "adjustment cheque 42984",
            idempotencyKey: randomUUID(),
          },
        }),
        /has no worker-compensation group/,
      );

      const wcbInput = {
        action: "employer_levy_adjustment" as const,
        employeePartyId: adjustedId,
        programKey: "ca_wcb" as const,
        workerCompGroupId: wcbGroupId,
        amount: "17.82",
        sourceKey: "source-card:43129:313",
        reason,
        sourceReference: "adjustment cheque 43129",
        idempotencyKey: randomUUID(),
      };
      assert.deepEqual(await mutatePayRunAdjustment({ ...base, reason, mutation: wcbInput }), {
        changed: true,
        replayed: false,
      });
      assert.deepEqual(
        await mutatePayRunAdjustment({ ...base, reason, mutation: wcbInput }),
        { changed: false, replayed: true },
        "the same request key replays the saved adjustment",
      );
      await assert.rejects(
        mutatePayRunAdjustment({
          ...base,
          reason,
          mutation: { ...wcbInput, amount: "17.83" },
        }),
        PayRunAdjustmentIdempotencyConflict,
      );
      await assert.rejects(
        mutatePayRunAdjustment({
          ...base,
          reason,
          mutation: { ...wcbInput, idempotencyKey: randomUUID() },
        }),
        /already has an audited recording/,
        "the same issued source record cannot be recorded twice under a new request key",
      );
      assert.deepEqual(
        await mutatePayRunAdjustment({
          ...base,
          reason,
          mutation: {
            action: "employer_levy_adjustment",
            employeePartyId: adjustedId,
            programKey: "ca_eht",
            amount: "26.32",
            sourceKey: "source-card:42984:305",
            reason,
            sourceReference: "adjustment cheque 42984",
            idempotencyKey: randomUUID(),
          },
        }),
        { changed: true, replayed: false },
      );

      const result = await calculatePayRun({
        orgId: org.orgId,
        documentId: run.documentId,
        actorId,
      });
      assert.deepEqual(result.errors, [], `calculation refused: ${JSON.stringify(result.errors)}`);
      const stubs = await db.execute<{
        employee_party_id: string;
        factors: Record<string, string>;
        net_pay: string;
      }>(
        sql`
        select employee_party_id, factors, net_pay::text from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${run.documentId}
      `,
        "objects",
      );
      const adjusted = stubs.find((row) => row.employee_party_id === adjustedId)!;
      const peer = stubs.find((row) => row.employee_party_id === peerId)!;
      // Assessed factors stay the native assessment of the stub's own lines;
      // issued operator amounts are retained separately, never as assessment.
      assert.equal(adjusted.factors.WCB, "13.2000");
      assert.equal(adjusted.factors.WCB_EARN, "1000.0000");
      assert.equal(adjusted.factors.WCB_ADJ, "17.8200");
      assert.equal(adjusted.factors.EHT, "19.5000");
      assert.equal(adjusted.factors.EHT_EARN, "1000.0000");
      assert.equal(adjusted.factors.EHT_ADJ, "26.3200");
      assert.equal(peer.factors.WCB, "13.2000");
      assert.equal(peer.factors.EHT, "19.5000");
      assert.equal(
        cmp(adjusted.net_pay, peer.net_pay),
        0,
        "employer-only adjustments never move net pay",
      );

      await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      const glLines = await db.execute<{ account_id: string; amount: string }>(
        sql`
        select account_id, amount from document_lines
         where org_id = ${org.orgId} and document_id = ${run.documentId}
      `,
        "objects",
      );
      assert.equal(cmp(sum(glLines.map((row) => row.amount)), "0"), 0, "projection balances");
      assert.equal(
        sum(glLines.filter((row) => row.account_id === wcbPayable).map((row) => row.amount)),
        "-44.2200",
      );
      assert.equal(
        sum(glLines.filter((row) => row.account_id === ehtPayable).map((row) => row.amount)),
        "-65.3200",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

/**
 * A supplemental run whose only entries are issued employer levy amounts
 * calculates a zero-earning stub: assessed factors stay at their canonical
 * zero, each issued amount materializes exactly once on the
 * employer-contribution lines, and net pay is zero. Deleting an issued
 * entry is terminal for its source record: neither the spent request key
 * nor any fresh key can record that source again (retained audit lookup),
 * and a second live recording refuses the same way.
 */
test(
  "zero-earning supplemental run books issued levy entries only; deletion and source-key reuse are governed",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await grantScratchPermissions(org.orgId, actorId, ["payroll.manage"]);
    try {
      const account = async (number: string, name: string, type: string) => {
        const id = randomUUID();
        await db.execute(sql`
          insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                                reconcilable, required_dimensions, custom, subsidiary_include_children)
          values (${id}, ${org.orgId}, ${number}, ${name}, ${type}, false, true, false, false,
                  '[]'::jsonb, '{}'::jsonb, true)`);
        return id;
      };
      const wageExpense = await account("6000", "Wages expense", "expense");
      const burdenExpense = await account("6010", "Payroll burden", "expense");
      const netPayable = await account("2300", "Wages payable", "liability_current");
      const craPayable = await account("2310", "CRA remittances payable", "liability_current");
      const wcbPayable = await account("2330", "WSIB payable", "liability_current");
      const ehtPayable = await account("2340", "EHT payable", "liability_current");
      await seedPayrollAccountingConfiguration(org.orgId, {
        wageExpenseAccountId: wageExpense,
        burdenExpenseAccountId: burdenExpense,
        netPayAccountId: netPayable,
        wagesTo: "expense",
        slotAccounts: {
          CA: { cpp: craPayable, ei: craPayable, qpip: craPayable, income_tax: craPayable },
        },
      });

      await seedPayrollComponents(org.orgId, actorId, "CA");
      await seedOntarioEhtFixture(org.orgId, actorId, "0");
      await setPackSlotAccount(org.orgId, actorId, "CA", "wcb", wcbPayable);
      await setPackSlotAccount(org.orgId, actorId, "CA", "eht", ehtPayable);

      const wcbGroupId = randomUUID();
      await db.execute(sql`
        insert into worker_comp_groups (id, org_id, code, name, rate_percent, max_assessable, is_active)
        values (${wcbGroupId}, ${org.orgId}, 'CLASS-A', 'Construction class A', '1.32', '121700', true)`);

      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
                ${actorId}, ${actorId})`);

      const employeeId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'person', 'Robin Crew', true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into employee_roles (id, org_id, party_id, worker_comp_group_id)
        values (${randomUUID()}, ${org.orgId}, ${employeeId}, ${wcbGroupId})`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                      is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'CAD', '25', 'hour', '2026-01-01', true,
                ${actorId}, ${actorId})`);
      const employmentId = await seedWorkerEmployment(org.orgId, employeeId, org.subsidiaryId);
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id,
                                               country, province, pay_basis, federal_claim_code,
                                               provincial_claim_code, is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, ${employmentId}, ${scheduleId}, 'CA', 'ON', 'hourly', 1, 1,
                true, ${actorId}, ${actorId})`);
      await seedVacationTerms(org.orgId, employmentId, actorId, "0", "accrue");

      const run = await createPayRun({
        orgId: org.orgId,
        actorId,
        payScheduleId: scheduleId,
        periodStart: "2026-07-05",
        periodEnd: "2026-07-18",
        payDate: "2026-07-21",
        runType: "supplemental",
      });
      const base = {
        orgId: org.orgId,
        documentId: run.documentId,
        actorId,
        allowedSubsidiaryIds: null,
      };
      const reason = "Recorded as issued per owner decision; source adjustment card 43129";
      const wcbInput = {
        action: "employer_levy_adjustment" as const,
        employeePartyId: employeeId,
        programKey: "ca_wcb" as const,
        workerCompGroupId: wcbGroupId,
        amount: "17.82",
        sourceKey: "source-card:43129:313",
        reason,
        sourceReference: "card export line 1244",
        idempotencyKey: randomUUID(),
      };
      assert.deepEqual(await mutatePayRunAdjustment({ ...base, reason, mutation: wcbInput }), {
        changed: true,
        replayed: false,
      });
      assert.deepEqual(
        await mutatePayRunAdjustment({
          ...base,
          reason,
          mutation: {
            action: "employer_levy_adjustment",
            employeePartyId: employeeId,
            programKey: "ca_eht",
            amount: "26.32",
            sourceKey: "source-card:42984:305",
            reason,
            sourceReference: "card export line 1242",
            idempotencyKey: randomUUID(),
          },
        }),
        { changed: true, replayed: false },
      );

      const raceRuns = await Promise.all(
        [0, 1].map(() =>
          createPayRun({
            orgId: org.orgId,
            actorId,
            payScheduleId: scheduleId,
            periodStart: "2026-07-05",
            periodEnd: "2026-07-18",
            payDate: "2026-07-21",
            runType: "supplemental",
          }),
        ),
      );
      const racingInputs = raceRuns.map((target) => ({
        ...base,
        documentId: target.documentId,
        mutation: {
          action: "employer_levy_adjustment" as const,
          employeePartyId: employeeId,
          programKey: "ca_eht" as const,
          amount: "1.00",
          sourceKey: "export:concurrent-issued-row",
          reason,
          sourceReference: "Reviewed employer-only export row",
          idempotencyKey: randomUUID(),
        },
      }));
      const race = await Promise.allSettled(
        racingInputs.map((input) => mutatePayRunAdjustment(input)),
      );
      assert.equal(
        race.filter((result) => result.status === "fulfilled").length,
        1,
        "two independent run locks cannot admit the same source twice",
      );
      const loser = race.find((result) => result.status === "rejected") as PromiseRejectedResult;
      assert.ok(loser.reason instanceof PayRunAdjustmentIdempotencyConflict);
      assert.equal(loser.reason.status, 409);
      const admitted = await db.execute<{ id: string; events: string }>(
        sql`
        select a.id::text, (select count(*)::text from audit_log event
          where event.org_id=a.org_id and event.table_name='pay_run_adjustments' and event.row_id=a.id) as events
         from pay_run_adjustments a where a.org_id=${org.orgId}
          and a.id in (${racingInputs[0]!.mutation.idempotencyKey},${racingInputs[1]!.mutation.idempotencyKey})
      `,
        "objects",
      );
      assert.equal(admitted.length, 1);
      assert.equal(
        admitted[0]!.events,
        "1",
        "only the winning source admission creates an audit event",
      );
      await assert.rejects(
        mutatePayRunAdjustment({
          ...racingInputs[0]!,
          allowedSubsidiaryIds: new Set(),
          mutation: {
            ...racingInputs[0]!.mutation,
            sourceKey: "export:out-of-scope",
            idempotencyKey: randomUUID(),
          },
        }),
        /pay run not found/,
      );

      const stubOf = async () =>
        (
          await db.execute<{ factors: Record<string, string>; gross: string; net_pay: string }>(
            sql`
        select factors, gross::text, net_pay::text from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${run.documentId}
           and employee_party_id = ${employeeId}
      `,
            "objects",
          )
        )[0];
      const result = await calculatePayRun({
        orgId: org.orgId,
        documentId: run.documentId,
        actorId,
      });
      assert.deepEqual(result.errors, [], `calculation refused: ${JSON.stringify(result.errors)}`);
      const stub = await stubOf();
      assert.ok(stub, "a zero-earning supplemental stub is calculated for the issued entries");
      assert.equal(cmp(stub.gross, "0"), 0);
      assert.equal(cmp(stub.net_pay, "0"), 0);
      // Canonical zero assessed bases are retained, not omitted; assessed
      // premiums are zero and the issued amounts ride separately.
      assert.equal(cmp(stub.factors.WCB_EARN!, "0"), 0);
      assert.equal(cmp(stub.factors.EHT_EARN!, "0"), 0);
      assert.equal(
        stub.factors.WCB,
        undefined,
        "zero-assessed premium factor retains its native conditional shape",
      );
      assert.equal(
        stub.factors.EHT,
        undefined,
        "zero-assessed premium factor retains its native conditional shape",
      );
      assert.equal(stub.factors.WCB_ADJ, "17.8200");
      assert.equal(stub.factors.EHT_ADJ, "26.3200");
      const lineSums = await db.execute<{ kind: string; total: string; lines: number }>(
        sql`
        select l.kind, coalesce(sum(l.amount), 0)::text as total, count(*)::int as lines
          from pay_stub_lines l join pay_stubs s on s.org_id = l.org_id and s.id = l.stub_id
         where l.org_id = ${org.orgId} and s.pay_run_document_id = ${run.documentId}
         group by l.kind
      `,
        "objects",
      );
      // Sole levy projection: each issued entry materializes exactly once —
      // one employer-contribution line per programme, totalling the issued
      // premiums and nothing more.
      assert.equal(lineSums.find((row) => row.kind === "employer_contribution")?.total, "44.1400");
      assert.equal(lineSums.find((row) => row.kind === "employer_contribution")?.lines, 2);
      assert.equal(
        lineSums.find((row) => row.kind === "earning"),
        undefined,
      );

      // Deleting the issued entry invalidates the calculated snapshot and
      // tombstones its source record: the spent request key cannot replay
      // and no fresh key can record that source again.
      assert.deepEqual(
        await mutatePayRunAdjustment({
          ...base,
          mutation: { action: "delete", adjustmentId: wcbInput.idempotencyKey },
        }),
        { changed: true, replayed: false },
      );
      assert.equal(
        await stubOf(),
        undefined,
        "deleting an issued entry invalidates calculated stubs",
      );
      await assert.rejects(
        mutatePayRunAdjustment({ ...base, reason, mutation: wcbInput }),
        PayRunAdjustmentIdempotencyConflict,
        "a corrected request key cannot replay",
      );
      await assert.rejects(
        mutatePayRunAdjustment({
          ...base,
          reason,
          mutation: { ...wcbInput, idempotencyKey: randomUUID() },
        }),
        /already has an audited recording/,
        "a deleted source record cannot be re-recorded under a fresh key",
      );

      const recalculated = await calculatePayRun({
        orgId: org.orgId,
        documentId: run.documentId,
        actorId,
      });
      assert.deepEqual(
        recalculated.errors,
        [],
        `recalculation refused: ${JSON.stringify(recalculated.errors)}`,
      );
      const finalStub = await stubOf();
      assert.equal(finalStub!.factors.WCB_ADJ, undefined, "the deleted issued entry stays deleted");
      assert.equal(finalStub!.factors.EHT_ADJ, "26.3200");
      assert.equal(cmp(finalStub!.net_pay, "0"), 0);
      await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      const glLines = await db.execute<{ account_id: string; amount: string }>(
        sql`
        select account_id, amount from document_lines
         where org_id = ${org.orgId} and document_id = ${run.documentId}
      `,
        "objects",
      );
      assert.equal(cmp(sum(glLines.map((row) => row.amount)), "0"), 0, "projection balances");
      assert.equal(
        cmp(
          sum(glLines.filter((row) => row.account_id === wcbPayable).map((row) => row.amount)),
          "0",
        ),
        0,
      );
      assert.equal(
        sum(glLines.filter((row) => row.account_id === ehtPayable).map((row) => row.amount)),
        "-26.3200",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
