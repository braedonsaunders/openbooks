import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../../platform/db.ts";
import {
  dropScratchOrgReporting,
  seedPayrollTime,
  seedPayrollWage,
} from "../../testing/fixtures.ts";
import { seedAdoption, type AdoptionFixture } from "../filing-test-fixtures.ts";
import { createPayRun } from "../run-lifecycle.ts";
import { calculatePayRun } from "../run-calculation.ts";
import { commitPayRun } from "../run-commit.ts";
import { mutatePayRunAdjustment } from "../run-adjustments.ts";
import { createRetroPayRun } from "../retro-store.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
async function setup() {
  const fx = await seedAdoption();
  await db.execute(sql`update pay_schedules set frequency='weekly',periods_per_year=52,
    anchor_period_end='2026-01-07',pay_date_offset_days=2 where org_id=${fx.orgId} and id=${fx.scheduleId}`);
  const filingId = randomUUID();
  await db.execute(sql`insert into payroll_filing_accounts
    (id,org_id,subsidiary_id,country,program_type,account_number,name,remitter_type,is_default,is_active,created_by,updated_by)
    values(${filingId},${fx.orgId},${fx.subsidiaryId},'CA','ca_rp','123456789RP0001',
      'Canadian payroll account','regular',true,true,${fx.actorId},${fx.actorId})`);
  const rows = await db.execute(
    sql`update employee_payroll_profiles set cpp_exempt=false,ei_exempt=true,
    filing_account_id=${filingId} where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}
    returning employee_party_id`,
    "objects",
  );
  assert.equal(rows.length, 1);
  return fx;
}
async function stub(fx: AdoptionFixture, documentId: string) {
  const rows = await db.execute<{ gross: string; factors: Record<string, string> }>(
    sql`
    select gross::text,factors from pay_stubs where org_id=${fx.orgId}
      and pay_run_document_id=${documentId} and employee_party_id=${fx.employeeId}`,
    "objects",
  );
  assert.equal(rows.length, 1);
  return rows[0]!;
}

test(
  "native separate bonus keeps full CPP with a tax income reference and later regular pay retains its exemption",
  { skip: !DB },
  async () => {
    const fx = await withBypassContext(setup);
    try {
      await withOrgContext(fx.orgId, async () => {
        const components = await db.execute<{ id: string; system_key: string }>(
          sql`select id,system_key
          from pay_components where org_id=${fx.orgId} and system_key in ('base_pay','bonus')`,
          "objects",
        );
        const create = async (
          from: string,
          to: string,
          date: string,
          type: "regular" | "bonus",
          base: string,
          bonus: string,
        ) => {
          const run = await createPayRun({
            orgId: fx.orgId,
            actorId: fx.actorId,
            payScheduleId: fx.scheduleId,
            periodStart: from,
            periodEnd: to,
            payDate: date,
            runType: type,
          });
          const command = { orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId };
          for (const [key, amount] of [
            ["base_pay", base],
            ["bonus", bonus],
          ] as const) {
            if (amount === "0") continue;
            await mutatePayRunAdjustment({
              ...command,
              mutation: {
                action: "add",
                employeePartyId: fx.employeeId,
                componentId: components.find((c) => c.system_key === key)!.id,
                amount,
                replaceComponent: true,
                idempotencyKey: randomUUID(),
              },
            });
          }
          assert.deepEqual((await calculatePayRun(command)).errors, []);
          return command;
        };
        const prior = await create(
          "2026-01-01",
          "2026-01-07",
          "2026-01-09",
          "regular",
          "1000",
          "0",
        );
        await commitPayRun(prior);
        const bonus = await create("2026-01-08", "2026-01-14", "2026-01-15", "bonus", "0", "1000");
        const paid = await stub(fx, bonus.documentId);
        assert.equal(paid.gross, "1000.0000");
        assert.equal(paid.factors.I, "0.0000");
        assert.equal(paid.factors.B, "1000.0000");
        assert.equal(paid.factors.CA_BONUS_I_REFERENCE, "1000.0000");
        assert.equal(paid.factors.C, "59.5000");
        assert.equal(paid.factors.CPP_EXEMPTION, "0.0000");
        await commitPayRun(bonus);
        const regular = await create(
          "2026-01-08",
          "2026-01-14",
          "2026-01-16",
          "regular",
          "1000",
          "0",
        );
        const regularStub = await stub(fx, regular.documentId);
        assert.equal(regularStub.factors.C, "55.5000");
        assert.equal(regularStub.factors.CPP_EXEMPTION, "67.3000");
        await commitPayRun(regular);
        const mixed = await create(
          "2026-01-15",
          "2026-01-21",
          "2026-01-23",
          "regular",
          "1000",
          "500",
        );
        const mixedStub = await stub(fx, mixed.documentId);
        assert.equal(mixedStub.gross, "1500.0000");
        assert.equal(mixedStub.factors.C, "85.2500");
        assert.equal(mixedStub.factors.CPP_EXEMPTION, "67.3000");
        const retained = await stub(fx, bonus.documentId);
        assert.deepEqual(
          retained,
          paid,
          "later regular and mixed calculations never rewrite the committed bonus",
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(fx.orgId));
    }
  },
);

test(
  "native backdated wage retro pays its pensionable delta without a CPP period exemption",
  { skip: !DB },
  async () => {
    const fx = await withBypassContext(setup);
    try {
      await withOrgContext(fx.orgId, async () => {
        await seedPayrollTime(fx.orgId, fx.employeeId, fx.actorId, {
          workedOn: "2026-01-05",
          hours: "8",
          status: "approved",
          costingBasis: "actual",
          billingStatus: "unbilled",
          isBillable: false,
        });
        const source = await createPayRun({
          orgId: fx.orgId,
          actorId: fx.actorId,
          payScheduleId: fx.scheduleId,
          periodStart: "2026-01-01",
          periodEnd: "2026-01-07",
          payDate: "2026-01-09",
          runType: "regular",
        });
        const command = { orgId: fx.orgId, actorId: fx.actorId, documentId: source.documentId };
        assert.deepEqual((await calculatePayRun(command)).errors, []);
        await commitPayRun(command);
        const original = await stub(fx, source.documentId);
        assert.equal(original.gross, "240.0000");
        const closed = await db.execute(
          sql`update labor_cost_rates set effective_to='2025-12-31'
          where org_id=${fx.orgId} and employee_party_id=${fx.employeeId} and effective_from='2020-01-01'
          returning id`,
          "objects",
        );
        assert.equal(closed.length, 1);
        await seedPayrollWage(fx.orgId, fx.employeeId, fx.actorId, {
          currency: "CAD",
          rate: "35",
          basis: "hour",
          effectiveFrom: "2026-01-01",
        });
        const retro = await createRetroPayRun({
          orgId: fx.orgId,
          actorId: fx.actorId,
          payScheduleId: fx.scheduleId,
          payDate: "2026-02-13",
          employeePartyIds: [fx.employeeId],
          allowedSubsidiaryIds: null,
        });
        assert.equal(retro.total, "40.0000");
        const retroCommand = { ...command, documentId: retro.documentId };
        assert.deepEqual((await calculatePayRun(retroCommand)).errors, []);
        const paid = await stub(fx, retro.documentId);
        assert.equal(paid.gross, "40.0000");
        assert.equal(paid.factors.I, "0.0000");
        assert.equal(paid.factors.B, "40.0000");
        assert.equal(paid.factors.C, "2.3800");
        assert.equal(paid.factors.CPP_EXEMPTION, "0.0000");
        await commitPayRun(retroCommand);
        assert.deepEqual(
          await stub(fx, source.documentId),
          original,
          "retro preserves the original committed payroll",
        );
      });
    } finally {
      await withBypassContext(() => dropScratchOrgReporting(fx.orgId));
    }
  },
);
