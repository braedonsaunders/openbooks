import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";
import {
  seedHourlyPayrollOrg,
  seedHourlyPayrollEmployee,
  seedHourlyPayrollTime,
} from "../testing/payroll-hourly-fixture.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { previewPayRunGl } from "./run-commit.ts";
import { payrollSettings, payrollSettingsForPayRun } from "./run-setup.ts";
import { upsertPayrollEmployerFact } from "./employer-fact-store.ts";
import { setPackSlotAccount } from "./packs.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "GL preview resolves organization posting policy through scoped run ownership",
  { skip: !DB },
  async () => {
    const fx = await withBypassContext(() => seedHourlyPayrollOrg());
    try {
      await withOrgContext(fx.orgId, async () => {
        const childId = randomUUID();
        assert.equal(
          (
            await db.execute(
              sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${childId},${fx.orgId},${fx.subsidiaryId},'Payroll entity','CAD','CA') returning id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.equal(
          (
            await db.execute(
              sql`update pay_schedules set subsidiary_id=${childId}
        where org_id=${fx.orgId} and id=${fx.scheduleId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        const employee = await seedHourlyPayrollEmployee(
          { ...fx, subsidiaryId: childId },
          "Child employee",
          childId,
        );
        const filingAccountId = randomUUID();
        assert.equal(
          (
            await db.execute(
              sql`insert into payroll_filing_accounts(id,org_id,subsidiary_id,country,program_type,account_number,name,is_active)
        values(${filingAccountId},${fx.orgId},${childId},'CA','ca_rp','123456789RP0001','Child payroll employer account',true)
        returning id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.equal(
          (
            await db.execute(
              sql`update employee_payroll_profiles set filing_account_id=${filingAccountId}
        where org_id=${fx.orgId} and employee_party_id=${employee.partyId} returning employee_party_id`,
              "objects",
            )
          ).length,
          1,
        );
        await upsertPayrollEmployerFact({
          orgId: fx.orgId,
          actorId: fx.actorId,
          subsidiaryId: childId,
          country: "CA",
          factKey: "eht_exemption_share_on",
          effectiveFrom: "2026-01-01",
          value: "0",
          changeReason: "Declare the child legal employer exemption allocation",
        });
        await setPackSlotAccount(fx.orgId, fx.actorId, "CA", "eht", fx.accounts.otherPayable);
        await seedHourlyPayrollTime(fx, employee.partyId, ["2026-07-14"]);
        const allowed = new Set([childId]);
        const run = await createPayRun({
          orgId: fx.orgId,
          actorId: fx.actorId,
          payScheduleId: fx.scheduleId,
          periodStart: "2026-07-12",
          periodEnd: "2026-07-18",
          allowedSubsidiaryIds: allowed,
        });
        const input = { orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId };
        const calculated = await calculatePayRun(input);
        assert.deepEqual(calculated.errors, []);
        assert.equal(calculated.employees, 1);
        assert.equal(
          (
            await db.execute<{ subsidiary_id: string }>(
              sql`select subsidiary_id from documents
        where org_id=${fx.orgId} and id=${input.documentId}`,
              "objects",
            )
          )[0]?.subsidiary_id,
          childId,
        );
        await assert.rejects(
          () => payrollSettings(fx.orgId, allowed),
          /payroll settings not found/,
        );
        const settings = await payrollSettings(fx.orgId);
        assert.deepEqual(
          await payrollSettingsForPayRun(fx.orgId, input.documentId, allowed),
          settings,
        );
        const unrestricted = await previewPayRunGl(fx.orgId, input.documentId);
        assert.ok(unrestricted.legs.length > 0);
        assert.deepEqual(await previewPayRunGl(fx.orgId, input.documentId, allowed), unrestricted);
        for (const scope of [new Set<string>(), new Set([fx.subsidiaryId])]) {
          await assert.rejects(
            () => payrollSettingsForPayRun(fx.orgId, input.documentId, scope),
            /pay run not found/,
          );
          await assert.rejects(
            () => previewPayRunGl(fx.orgId, input.documentId, scope),
            /pay run not found/,
          );
        }
        await assert.rejects(
          () => payrollSettingsForPayRun(fx.orgId, randomUUID(), allowed),
          /pay run not found/,
        );
        await assert.rejects(
          () => payrollSettingsForPayRun(randomUUID(), input.documentId, allowed),
          /pay run not found/,
        );
        // A later ownership change must invalidate the complete-population read.
        assert.equal(
          (
            await db.execute(
              sql`update parties set subsidiary_id=${fx.subsidiaryId}
        where org_id=${fx.orgId} and id=${employee.partyId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        await assert.rejects(
          () => payrollSettingsForPayRun(fx.orgId, input.documentId, allowed),
          /pay run not found/,
        );
        await assert.rejects(
          () => previewPayRunGl(fx.orgId, input.documentId, allowed),
          /pay run not found/,
        );
        assert.equal(
          (
            await db.execute(
              sql`update parties set subsidiary_id=${childId}
        where org_id=${fx.orgId} and id=${employee.partyId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.equal(
          (
            await db.execute(
              sql`update documents set subsidiary_id=null
        where org_id=${fx.orgId} and id=${input.documentId} returning id`,
              "objects",
            )
          ).length,
          1,
        );
        await assert.rejects(
          () => payrollSettingsForPayRun(fx.orgId, input.documentId, allowed),
          /pay run not found/,
        );
      });
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "GL preview refuses one valued lineless stub beside another complete employee",
  { skip: !DB },
  async () => {
    const fx = await withBypassContext(() => seedHourlyPayrollOrg());
    try {
      const employees = await withBypassContext(async () => {
        const first = await seedHourlyPayrollEmployee(fx, "Complete employee", fx.subsidiaryId);
        const second = await seedHourlyPayrollEmployee(fx, "Incomplete employee", fx.subsidiaryId);
        const account = randomUUID();
        assert.equal(
          (
            await db.execute(
              sql`
        insert into payroll_filing_accounts(id,org_id,subsidiary_id,country,program_type,account_number,name,is_active)
        values(${account},${fx.orgId},${fx.subsidiaryId},'CA','ca_rp','123456789RP0001','Payroll employer account',true)
        returning id`,
              "objects",
            )
          ).length,
          1,
        );
        assert.equal(
          (
            await db.execute(
              sql`update employee_payroll_profiles set filing_account_id=${account}
        where org_id=${fx.orgId} and employee_party_id in (${first.partyId},${second.partyId})
        returning employee_party_id`,
              "objects",
            )
          ).length,
          2,
        );
        for (const employee of [first, second]) {
          await seedHourlyPayrollTime(fx, employee.partyId, ["2026-07-13", "2026-07-14"]);
        }
        return [first, second] as const;
      });
      await withOrgContext(fx.orgId, async () => {
        const run = await createPayRun({
          orgId: fx.orgId,
          actorId: fx.actorId,
          payScheduleId: fx.scheduleId,
          periodStart: "2026-07-12",
          periodEnd: "2026-07-18",
        });
        const calculated = await calculatePayRun({
          orgId: fx.orgId,
          actorId: fx.actorId,
          documentId: run.documentId,
        });
        assert.deepEqual(calculated.errors, []);
        assert.equal(calculated.employees, 2);
        const preview = await previewPayRunGl(fx.orgId, run.documentId);
        assert.ok(preview.legs.length > 0);
        const stubs = await db.execute<{
          id: string;
          employee: string;
          gross: string;
          line_count: number;
        }>(
          sql`
        select s.id,s.employee_party_id as employee,s.gross::text as gross,
          (select count(*)::int from pay_stub_lines l where l.org_id=s.org_id and l.stub_id=s.id) as line_count
        from pay_stubs s where s.org_id=${fx.orgId} and s.pay_run_document_id=${run.documentId}`,
          "objects",
        );
        assert.equal(stubs.length, 2);
        assert.ok(stubs.every((stub) => stub.gross === "480.0000" && stub.line_count > 0));
        const incomplete = stubs.find((stub) => stub.employee === employees[1].partyId)!;
        // Damage only the editable, calculated fixture output. No committed history is changed.
        const removed = await db.execute(
          sql`delete from pay_stub_lines where org_id=${fx.orgId}
        and stub_id=${incomplete.id} returning id`,
          "objects",
        );
        assert.equal(removed.length, incomplete.line_count);
        const snapshot = async () =>
          (
            await db.execute<{ state: unknown }>(
              sql`
        select jsonb_build_object(
          'run',(select to_jsonb(r) from pay_runs r where org_id=${fx.orgId} and document_id=${run.documentId}),
          'stubs',(select jsonb_agg(to_jsonb(s) order by id) from pay_stubs s where org_id=${fx.orgId} and pay_run_document_id=${run.documentId}),
          'lines',(select jsonb_agg(to_jsonb(l) order by l.id) from pay_stub_lines l join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id
            where s.org_id=${fx.orgId} and s.pay_run_document_id=${run.documentId}),
          'journals',(select jsonb_agg(to_jsonb(e) order by id) from journal_entries e where org_id=${fx.orgId} and source_document_id=${run.documentId})
        ) as state`,
              "objects",
            )
          )[0]!.state;
        const before = await snapshot();
        await assert.rejects(
          () => previewPayRunGl(fx.orgId, run.documentId),
          /calculated pay stub has financial totals but no native lines.*recalculate/i,
        );
        assert.deepEqual(
          await snapshot(),
          before,
          "refusing a partial projection must not alter any output or ledger state",
        );
        const complete = stubs.find((stub) => stub.employee === employees[0].partyId)!;
        assert.equal(
          (
            await db.execute<{ n: number }>(
              sql`select count(*)::int as n from pay_stub_lines
        where org_id=${fx.orgId} and stub_id=${complete.id}`,
              "objects",
            )
          )[0]!.n,
          complete.line_count,
        );
      });
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
