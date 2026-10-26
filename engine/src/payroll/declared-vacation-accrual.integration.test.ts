import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";
import {
  seedHourlyPayrollOrg,
  seedHourlyPayrollEmployee,
  seedHourlyPayrollTime,
} from "../testing/payroll-hourly-fixture.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { mutatePayRunAdjustment } from "./run-adjustments.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { declaredVacationAccrualEvidence } from "./run-vacation-accrual-input.ts";

test(
  "a declared cheque accrual below the effective vacation policy creates no stub or bank movement",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedHourlyPayrollOrg();
    try {
      const { partyId } = await seedHourlyPayrollEmployee(
        fx,
        "Vacation entitlement employee",
        fx.subsidiaryId,
      );
      await seedHourlyPayrollTime(fx, partyId, ["2026-07-13"]);
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-12",
        periodEnd: "2026-07-18",
      });
      await mutatePayRunAdjustment({
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: run.documentId,
        mutation: {
          action: "declared_vacation_accrual",
          employeePartyId: partyId,
          amount: "9.59",
          reason: "Review the declared cheque against the effective entitlement",
          sourceReference: "Issued cheque 8",
          idempotencyKey: randomUUID(),
        },
      });
      const result = await calculatePayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: run.documentId,
      });
      assert.match(JSON.stringify(result.errors), /below the effective policy accrual 9\.6000/);
      assert.equal(
        (
          await db.execute(
            sql`select id from pay_stubs where org_id=${fx.orgId} and pay_run_document_id=${run.documentId}`,
            "objects",
          )
        ).length,
        0,
      );
      assert.equal(
        (
          await db.execute(
            sql`select id from entitlement_ledger where org_id=${fx.orgId} and pay_run_document_id=${run.documentId}`,
            "objects",
          )
        ).length,
        0,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "one audited cheque accrual funds its own payout, replays once and leaves later vacation policy unchanged",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedHourlyPayrollOrg();
    try {
      const { partyId } = await seedHourlyPayrollEmployee(
        fx,
        "Declared accrual employee",
        fx.subsidiaryId,
      );
      await seedHourlyPayrollTime(fx, partyId, ["2026-07-13"]);
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-12",
        periodEnd: "2026-07-18",
      });
      const plan = (
        await db.execute<{ id: string; accrual_component_id: string; payout_component_id: string }>(
          sql`select id,accrual_component_id,payout_component_id from entitlement_plans where org_id=${fx.orgId} and system_key='vacation' and is_active`,
          "objects",
        )
      )[0]!;
      assert.ok(plan.accrual_component_id);
      assert.ok(plan.payout_component_id);
      const command = {
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: run.documentId,
        allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
        mutation: {
          action: "declared_vacation_accrual" as const,
          employeePartyId: partyId,
          amount: "2500.81",
          reason: "Review the original cheque's declared vacation liability",
          sourceReference: "Issued cheque 7",
          idempotencyKey: randomUUID(),
        },
      };
      assert.equal((await mutatePayRunAdjustment(command)).changed, true);
      assert.equal((await mutatePayRunAdjustment(command)).replayed, true);
      await assert.rejects(
        mutatePayRunAdjustment({
          ...command,
          mutation: { ...command.mutation, amount: "2500.82" },
        }),
        /idempotency|different|changed/i,
      );
      await assert.rejects(
        mutatePayRunAdjustment({
          ...command,
          mutation: { ...command.mutation, idempotencyKey: randomUUID() },
        }),
        /already has a declared/,
      );
      const spoof = declaredVacationAccrualEvidence(
        "Unreviewed generic note",
        "Issued cheque 8",
        randomUUID(),
      );
      for (const note of [spoof, spoof.replace('"kind"', '"k\\u0069nd"')]) {
        await assert.rejects(
          mutatePayRunAdjustment({
            ...command,
            mutation: {
              action: "add",
              employeePartyId: partyId,
              componentId: plan.accrual_component_id,
              amount: "2500.81",
              note,
            },
          }),
          /audited vacation-accrual command/,
        );
      }
      await mutatePayRunAdjustment({
        ...command,
        mutation: {
          action: "add",
          employeePartyId: partyId,
          componentId: plan.payout_component_id,
          amount: "2500.81",
          note: "Issued cheque vacation payout",
        },
      });
      const calculate = () =>
        calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
      assert.deepEqual((await calculate()).errors, []);
      const movements = () =>
        db.execute<{ kind: string; amount: string }>(
          sql`select kind,amount::text from entitlement_ledger where org_id=${fx.orgId} and plan_id=${plan.id} and pay_run_document_id=${run.documentId} order by kind`,
          "objects",
        );
      assert.deepEqual(await movements(), [
        { kind: "accrual", amount: "2500.8100" },
        { kind: "payout", amount: "-2500.8100" },
      ]);
      const stub = (
        await db.execute<{ gross: string; accrued: string }>(
          sql`select gross::text,vacation_accrued::text as accrued from pay_stubs where org_id=${fx.orgId} and pay_run_document_id=${run.documentId}`,
          "objects",
        )
      )[0]!;
      assert.deepEqual(stub, { gross: "2740.8100", accrued: "2500.8100" });
      assert.deepEqual((await calculate()).errors, []);
      assert.equal((await movements()).length, 2);
      await commitPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
      await assert.rejects(
        mutatePayRunAdjustment({
          ...command,
          mutation: { ...command.mutation, idempotencyKey: randomUUID() },
        }),
        /editable|committed/,
      );
      const source = (
        await db.execute<{
          snapshot: { declaredVacationAccruals: { amount: string; sourceReference: string }[] };
        }>(
          sql`select calculation_source_snapshot as snapshot from pay_runs where org_id=${fx.orgId} and document_id=${run.documentId}`,
          "objects",
        )
      )[0]!.snapshot;
      assert.equal(source.declaredVacationAccruals[0]!.amount, "2500.81");
      assert.equal(source.declaredVacationAccruals[0]!.sourceReference, "Issued cheque 7");
      await seedHourlyPayrollTime(fx, partyId, ["2026-07-20"]);
      const later = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-19",
        periodEnd: "2026-07-25",
      });
      assert.deepEqual(
        (
          await calculatePayRun({
            orgId: fx.orgId,
            actorId: fx.actorId,
            documentId: later.documentId,
          })
        ).errors,
        [],
      );
      assert.equal(
        (
          await db.execute<{ accrued: string }>(
            sql`select vacation_accrued::text as accrued from pay_stubs where org_id=${fx.orgId} and pay_run_document_id=${later.documentId}`,
            "objects",
          )
        )[0]!.accrued,
        "9.6000",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
