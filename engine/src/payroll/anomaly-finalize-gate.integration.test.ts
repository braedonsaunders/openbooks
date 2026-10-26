import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import {
  dropScratchOrgReporting,
  grantScratchPermissions,
  seedPayrollSchedule,
  seedPayrollSettings,
  seedWorkerEmployment,
} from "../testing/fixtures.ts";
import {
  seedHourlyPayrollEmployee,
  seedHourlyPayrollOrg,
  seedHourlyPayrollTime,
} from "../testing/payroll-hourly-fixture.ts";
import { transitionFlag } from "../hrm/ai/anomalies.ts";
import { payrollAnomalyFinalizeCheck } from "./anomaly-finalize-gate.ts";
import { PayrollError } from "./error.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const period = { periodStart: "2026-07-12", periodEnd: "2026-07-18" };
const missingRun = (error: unknown) =>
  error instanceof PayrollError && error.message === "pay run not found";

test(
  "anomaly finalization uses the native active schedule owner and refuses unavailable ownership",
  { skip: !DB },
  async () => {
    const fx = await withBypassContext(() => seedHourlyPayrollOrg());
    try {
      await withOrgContext(fx.orgId, async () => {
        await seedPayrollSettings(fx.orgId, { features: { payroll: true } });
        const rootRun = await createPayRun({
          orgId: fx.orgId,
          actorId: fx.actorId,
          payScheduleId: fx.scheduleId,
          ...period,
        });
        const check = (documentId: string) =>
          payrollAnomalyFinalizeCheck(db, { orgId: fx.orgId, documentId });
        assert.deepEqual(
          (
            await db.execute<{ subsidiary: string; schedule_subsidiary: string | null }>(
              sql`
        select d.subsidiary_id as subsidiary, ps.subsidiary_id as schedule_subsidiary
        from documents d join pay_runs r on r.org_id=d.org_id and r.document_id=d.id
        join pay_schedules ps on ps.org_id=r.org_id and ps.id=r.pay_schedule_id
        where d.org_id=${fx.orgId} and d.id=${rootRun.documentId}`,
              "objects",
            )
          )[0],
          { subsidiary: fx.subsidiaryId, schedule_subsidiary: null },
        );
        assert.deepEqual(await check(rootRun.documentId), {
          periodFrom: period.periodStart,
          periodTo: period.periodEnd,
          openBlockCount: 0,
          openBlocks: [],
        });

        const childId = randomUUID();
        assert.equal(
          (
            await db.execute(
              sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${childId},${fx.orgId},${fx.subsidiaryId},'Child employer','CAD','CA') returning id`,
              "objects",
            )
          ).length,
          1,
        );
        const childScheduleId = randomUUID();
        await seedPayrollSchedule(fx.orgId, childScheduleId, fx.actorId, {
          name: "Child weekly",
          frequency: "weekly",
          periodsPerYear: 52,
          anchorPeriodEnd: period.periodEnd,
          payDateOffsetDays: 3,
          subsidiaryId: childId,
        });
        const childRun = await createPayRun({
          orgId: fx.orgId,
          actorId: fx.actorId,
          payScheduleId: childScheduleId,
          allowedSubsidiaryIds: new Set([childId]),
          ...period,
        });
        for (const scope of [new Set<string>(), new Set([fx.subsidiaryId])]) {
          await assert.rejects(
            () =>
              createPayRun({
                orgId: fx.orgId,
                actorId: fx.actorId,
                payScheduleId: childScheduleId,
                allowedSubsidiaryIds: scope,
                periodStart: "2026-07-19",
                periodEnd: "2026-07-25",
              }),
            (error) => error instanceof PayrollError && error.message === "pay schedule not found",
          );
        }
        assert.equal(
          (
            await db.execute<{ subsidiary: string }>(
              sql`select subsidiary_id as subsidiary
        from documents where org_id=${fx.orgId} and id=${childRun.documentId}`,
              "objects",
            )
          )[0]?.subsidiary,
          childId,
        );
        assert.deepEqual(await check(childRun.documentId), await check(rootRun.documentId));

        assert.equal(
          (
            await db.execute(
              sql`update documents set subsidiary_id=${childId}
        where org_id=${fx.orgId} and id=${rootRun.documentId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        await assert.rejects(() => check(rootRun.documentId), /same legal entity/);
        assert.equal(
          (
            await db.execute(
              sql`update documents set subsidiary_id=null
        where org_id=${fx.orgId} and id=${rootRun.documentId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        await assert.rejects(() => check(rootRun.documentId), /same legal entity/);
        assert.equal(
          (
            await db.execute(
              sql`update documents set subsidiary_id=${fx.subsidiaryId}
        where org_id=${fx.orgId} and id=${rootRun.documentId} returning id`,
              "objects",
            )
          ).length,
          1,
        );

        for (const scheduleId of [fx.scheduleId, childScheduleId]) {
          const documentId =
            scheduleId === fx.scheduleId ? rootRun.documentId : childRun.documentId;
          assert.equal(
            (
              await db.execute(
                sql`update pay_schedules set is_active=false
          where org_id=${fx.orgId} and id=${scheduleId} returning id`,
                "objects",
              )
            ).length,
            1,
          );
          await assert.rejects(() => check(documentId), missingRun);
          assert.equal(
            (
              await db.execute(
                sql`update pay_schedules set is_active=true
          where org_id=${fx.orgId} and id=${scheduleId} returning id`,
                "objects",
              )
            ).length,
            1,
          );
        }
        // The native root cannot be deactivated; exercise unavailable ownership on its child.
        for (const subsidiaryId of [childId]) {
          const documentId =
            subsidiaryId === fx.subsidiaryId ? rootRun.documentId : childRun.documentId;
          assert.equal(
            (
              await db.execute(
                sql`update subsidiaries set is_active=false
          where org_id=${fx.orgId} and id=${subsidiaryId} returning id`,
                "objects",
              )
            ).length,
            1,
          );
          await assert.rejects(() => check(documentId), missingRun);
          assert.equal(
            (
              await db.execute(
                sql`update subsidiaries set is_active=true
          where org_id=${fx.orgId} and id=${subsidiaryId} returning id`,
                "objects",
              )
            ).length,
            1,
          );
        }

        // Deferred references model unavailable imported identities without retaining invalid fixture rows.
        for (const missing of ["schedule", "owner"] as const) {
          const rollback = new Error("Discard unavailable reference fixture");
          await assert.rejects(
            () =>
              db.transaction(async (tx) => {
                if (missing === "schedule") {
                  await tx.execute(sql`set constraints pay_runs_pay_schedule_id_fkey deferred`);
                  assert.equal(
                    (
                      await tx.execute(
                        sql`update pay_runs set pay_schedule_id=${randomUUID()}
              where org_id=${fx.orgId} and document_id=${childRun.documentId} returning document_id`,
                        "objects",
                      )
                    ).length,
                    1,
                  );
                } else {
                  await tx.execute(sql`set constraints pay_schedules_subsidiary_id_fkey deferred`);
                  assert.equal(
                    (
                      await tx.execute(
                        sql`update pay_schedules set subsidiary_id=${randomUUID()}
              where org_id=${fx.orgId} and id=${childScheduleId} returning id`,
                        "objects",
                      )
                    ).length,
                    1,
                  );
                }
                await assert.rejects(
                  () =>
                    payrollAnomalyFinalizeCheck(tx, {
                      orgId: fx.orgId,
                      documentId: childRun.documentId,
                    }),
                  missingRun,
                );
                throw rollback;
              }),
            (error) => error === rollback,
          );
        }
        await assert.rejects(() => check(randomUUID()), missingRun);
        await assert.rejects(
          () =>
            payrollAnomalyFinalizeCheck(db, {
              orgId: randomUUID(),
              documentId: rootRun.documentId,
            }),
          missingRun,
        );
        assert.deepEqual(await check(childRun.documentId), await check(rootRun.documentId));
      });
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "retained employment and overlapping period blockers refuse native commit until reviewed",
  { skip: !DB },
  async () => {
    const fx = await withBypassContext(() => seedHourlyPayrollOrg());
    try {
      await withOrgContext(fx.orgId, async () => {
        await seedPayrollSettings(fx.orgId, { features: { payroll: true } });
        await grantScratchPermissions(fx.orgId, fx.actorId, ["payroll.manage"]);
        const employee = await seedHourlyPayrollEmployee(fx, "Retained employee", fx.subsidiaryId);
        const accountId = randomUUID();
        assert.equal(
          (
            await db.execute(
              sql`insert into payroll_filing_accounts
        (id,org_id,subsidiary_id,country,program_type,account_number,name,is_active)
        values(${accountId},${fx.orgId},${fx.subsidiaryId},'CA','ca_rp','123456789RP0001','Payroll employer account',true)
        returning id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.equal(
          (
            await db.execute(
              sql`update employee_payroll_profiles set filing_account_id=${accountId}
        where org_id=${fx.orgId} and employee_party_id=${employee.partyId} returning employee_party_id`,
              "objects",
            )
          ).length,
          1,
        );
        await seedHourlyPayrollTime(fx, employee.partyId, ["2026-07-14"]);
        const run = await createPayRun({
          orgId: fx.orgId,
          actorId: fx.actorId,
          payScheduleId: fx.scheduleId,
          ...period,
        });
        const input = {
          orgId: fx.orgId,
          actorId: fx.actorId,
          documentId: run.documentId,
          allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
        };
        const calculated = await calculatePayRun(input);
        assert.deepEqual(calculated.errors, []);
        assert.equal(calculated.employees, 1);
        assert.deepEqual(
          await db.execute<{ employment: string }>(
            sql`select employment_id as employment
        from pay_stubs where org_id=${fx.orgId} and pay_run_document_id=${run.documentId}`,
            "objects",
          ),
          [{ employment: employee.employmentId }],
        );

        const otherScheduleId = randomUUID();
        await seedPayrollSchedule(fx.orgId, otherScheduleId, fx.actorId, {
          name: "Other weekly",
          frequency: "weekly",
          periodsPerYear: 52,
          anchorPeriodEnd: period.periodEnd,
          payDateOffsetDays: 3,
        });
        const otherRun = await createPayRun({
          orgId: fx.orgId,
          actorId: fx.actorId,
          payScheduleId: otherScheduleId,
          ...period,
        });
        const priorEmploymentId = await seedWorkerEmployment(
          fx.orgId,
          employee.partyId,
          fx.subsidiaryId,
        );
        const outsider = await seedHourlyPayrollEmployee(
          fx,
          "Unretained employee",
          fx.subsidiaryId,
        );
        const flag = async (
          employmentId: string | null,
          from: string,
          to: string,
          runDocumentId: string | null = null,
          severity = "block",
        ) => {
          const id = randomUUID();
          assert.equal(
            (
              await db.execute(
                sql`insert into payroll_anomaly_flags
          (id,org_id,run_document_id,employment_id,pay_period_from,pay_period_to,kind,severity,detail,explanation,created_by)
          values(${id},${fx.orgId},${runDocumentId},${employmentId},${from},${to},'duplicate_bank',${severity},
            ${JSON.stringify({ key: id })}::jsonb,'Review payment destination',${fx.actorId}) returning id`,
                "objects",
              )
            ).length,
            1,
          );
          return id;
        };
        const employmentFlag = await flag(
          employee.employmentId,
          period.periodStart,
          period.periodEnd,
        );
        const boundaryFlag = await flag(
          employee.employmentId,
          period.periodEnd,
          "2026-07-25",
          run.documentId,
        );
        await flag(priorEmploymentId, period.periodStart, period.periodEnd);
        await flag(outsider.employmentId, period.periodStart, period.periodEnd);
        await flag(employee.employmentId, "2026-07-05", "2026-07-11");
        await flag(employee.employmentId, "2026-07-19", "2026-07-25");
        await flag(
          employee.employmentId,
          period.periodStart,
          period.periodEnd,
          otherRun.documentId,
        );
        await flag(null, period.periodStart, period.periodEnd, otherRun.documentId);
        await flag(employee.employmentId, period.periodStart, period.periodEnd, null, "warn");
        const check = () => payrollAnomalyFinalizeCheck(db, input);
        const expected = [employmentFlag, boundaryFlag]
          .sort()
          .map((id) => ({ id, kind: "duplicate_bank" }));
        assert.deepEqual((await check()).openBlocks, expected);
        assert.equal((await check()).openBlockCount, 2);

        assert.equal(
          (
            await db.execute(
              sql`update employee_payroll_profiles set pay_schedule_id=${otherScheduleId}
        where org_id=${fx.orgId} and employee_party_id=${employee.partyId} returning employee_party_id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.deepEqual(
          (await check()).openBlocks,
          expected,
          "a current profile change cannot erase the retained employment's period review",
        );
        assert.equal(
          (
            await db.execute(
              sql`update employee_payroll_profiles set pay_schedule_id=${fx.scheduleId}
        where org_id=${fx.orgId} and employee_party_id=${employee.partyId} returning employee_party_id`,
              "objects",
            )
          ).length,
          1,
        );
        // Keep the unretained employment outside the native recalculation roster.
        assert.equal(
          (
            await db.execute(
              sql`update employee_payroll_profiles set pay_schedule_id=${otherScheduleId}
        where org_id=${fx.orgId} and employee_party_id=${outsider.partyId} returning employee_party_id`,
              "objects",
            )
          ).length,
          1,
        );
        const recalculated = await calculatePayRun(input);
        assert.deepEqual(recalculated.errors, []);
        assert.equal(recalculated.employees, 1);
        const snapshot = async () =>
          (
            await db.execute<{ state: unknown }>(
              sql`select jsonb_build_object(
        'run',(select to_jsonb(r) from pay_runs r where org_id=${fx.orgId} and document_id=${run.documentId}),
        'document',(select to_jsonb(d) from documents d where org_id=${fx.orgId} and id=${run.documentId}),
        'stubs',(select jsonb_agg(to_jsonb(s) order by id) from pay_stubs s where org_id=${fx.orgId} and pay_run_document_id=${run.documentId}),
        'stub_lines',(select jsonb_agg(to_jsonb(l) order by l.id) from pay_stub_lines l
          join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id where s.org_id=${fx.orgId} and s.pay_run_document_id=${run.documentId}),
        'lines',(select jsonb_agg(to_jsonb(l) order by id) from document_lines l where org_id=${fx.orgId} and document_id=${run.documentId}),
        'claims',(select jsonb_agg(to_jsonb(t) order by id) from time_entries t where org_id=${fx.orgId} and employee_party_id=${employee.partyId})
      ) as state`,
              "objects",
            )
          )[0]!.state;
        const before = await snapshot();
        for (const scope of [new Set<string>(), new Set([randomUUID()])]) {
          await assert.rejects(
            () => commitPayRun({ ...input, allowedSubsidiaryIds: scope }),
            missingRun,
          );
          assert.deepEqual(
            await snapshot(),
            before,
            "an unauthorized caller cannot observe the anomaly roster or change payroll output",
          );
        }
        await assert.rejects(() => commitPayRun(input), /2 blocking payroll check\(s\) are open/);
        assert.deepEqual(
          await snapshot(),
          before,
          "the refusal preserves calculated output, document lines and time claims",
        );
        const acknowledged = await transitionFlag(db, {
          orgId: fx.orgId,
          actorId: fx.actorId,
          flagId: employmentFlag,
          to: "acknowledged",
          reason: "Payment destination reviewed and accepted",
        });
        assert.equal(acknowledged.status, "acknowledged");
        assert.deepEqual((await check()).openBlocks, [
          { id: boundaryFlag, kind: "duplicate_bank" },
        ]);
        await assert.rejects(() => commitPayRun(input), /1 blocking payroll check\(s\) are open/);
        assert.deepEqual(await snapshot(), before);
        const resolved = await transitionFlag(db, {
          orgId: fx.orgId,
          actorId: fx.actorId,
          flagId: boundaryFlag,
          to: "resolved",
          reason: "Run-specific payment destination corrected and reviewed",
        });
        assert.equal(resolved.status, "resolved");
        assert.equal((await check()).openBlockCount, 0);
        const committed = await commitPayRun(input);
        assert.ok(committed.lines > 0);
        assert.equal(
          (
            await db.execute<{ status: string }>(
              sql`select run_status as status from pay_runs
        where org_id=${fx.orgId} and document_id=${run.documentId}`,
              "objects",
            )
          )[0]?.status,
          "committed",
        );
        assert.equal(
          (
            await db.execute<{ n: number }>(
              sql`select count(*)::int as n from time_entries
        where org_id=${fx.orgId} and payroll_batch_ref=${run.documentId}::text`,
              "objects",
            )
          )[0]?.n,
          1,
        );
      });
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
