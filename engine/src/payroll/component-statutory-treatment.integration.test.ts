import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import { withSimClock } from "../platform/clock.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import { createSandbox, deleteSandbox } from "../sandbox/lifecycle.ts";
import { seedAdoption } from "./filing-test-fixtures.ts";
import { recordHistoricalEmployerAssignment } from "./employer-assignment-history.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { mutatePayRunAdjustment } from "./run-adjustments.ts";
import { setPackSlotAccount } from "./packs.ts";
import { type PayRunCalculationSourceSnapshot } from "./run-calculation-evidence.ts";

const skip = !process.env.OPENBOOKS_DB_URL;

test(
  "dated absence selects the default treatment and committed clone evidence keeps its original identity and digest",
  { skip },
  async () => {
    const f = await withBypassContext(() => seedAdoption());
    let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
    try {
      await withSimClock("2026-07-21", () =>
        withOrgContext(f.orgId, async () => {
          const groupId = randomUUID();
          await db.execute(sql`insert into worker_comp_groups(id,org_id,code,name,rate_percent,max_assessable,created_by,updated_by)
        values(${groupId},${f.orgId},'GENERAL','General classification','1.32','121700',${f.actorId},${f.actorId})`);
          await db.execute(sql`update employee_roles set worker_comp_group_id=${groupId}
        where org_id=${f.orgId} and party_id=${f.employeeId}`);
          await db.execute(sql`update employee_payroll_profiles set wcb_exempt=true
        where org_id=${f.orgId} and employee_party_id=${f.employeeId}`);
          const componentId = (
            await db.execute<{ id: string }>(
              sql`select id from pay_components
        where org_id=${f.orgId} and system_key='base_pay'`,
              "objects",
            )
          )[0]!.id;
          const defaultId = (
            await db.execute<{ id: string }>(
              sql`update pay_component_statutory_treatments
        set program_exclusions=array['wcb'] where org_id=${f.orgId} and pay_component_id=${componentId}
          and worker_comp_group_id is null returning id`,
              "objects",
            )
          )[0]!.id;
          const groupTreatmentId = (
            await db.execute<{ id: string }>(
              sql`insert into pay_component_statutory_treatments
        (org_id,pay_component_id,worker_comp_group_id,effective_from,program_exclusions,vacationable)
        values(${f.orgId},${componentId},${groupId},'2026-01-01','{}',true) returning id`,
              "objects",
            )
          )[0]!.id;
          const liability = (
            await db.execute<{ id: string }>(
              sql`select liability_account_id::text as id from pay_components
        where org_id=${f.orgId} and country='CA' and system_key='ei'`,
              "objects",
            )
          )[0]!.id;
          await setPackSlotAccount(f.orgId, f.actorId, "CA", "wcb", liability);
          const run = await createPayRun({
            orgId: f.orgId,
            actorId: f.actorId,
            payScheduleId: f.scheduleId,
            periodStart: "2026-07-01",
            periodEnd: "2026-07-07",
            payDate: "2026-07-08",
          });
          const command = { orgId: f.orgId, actorId: f.actorId, documentId: run.documentId };
          await mutatePayRunAdjustment({
            ...command,
            mutation: { action: "add", employeePartyId: f.employeeId, componentId, amount: "1000" },
          });
          const evidence = async () =>
            (
              await db.execute<{ snapshot: PayRunCalculationSourceSnapshot; digest: string }>(
                sql`
        select calculation_source_snapshot as snapshot,calculation_source_digest as digest from pay_runs
        where org_id=${f.orgId} and document_id=${run.documentId}`,
                "objects",
              )
            )[0]!;
          assert.deepEqual((await calculatePayRun(command)).errors, []);
          assert.ok(
            (await evidence()).snapshot.payComponentStatutoryTreatments?.some(
              (row) => row.id === groupTreatmentId,
            ),
          );
          await recordHistoricalEmployerAssignment({
            orgId: f.orgId,
            actorId: f.actorId,
            employeePartyId: f.employeeId,
            kind: "worker_comp",
            assignmentId: null,
            expectedCurrentId: groupId,
            effectiveFrom: "2026-07-08",
            effectiveTo: "2026-07-08",
            sourceReference: "Reviewed original classification report",
            reason: "No compensation group applied on the original date",
            allowedSubsidiaryIds: null,
            dryRun: false,
          });
          await assert.rejects(
            db.transaction((tx) =>
              tx.execute(sql`insert into payroll_employee_employer_assignments
        (org_id,employee_party_id,subsidiary_id,assignment_kind,tax_year,effective_from,effective_to,
          worker_comp_group_id,expected_current_id,source_reference,reason,created_by)
        values(${f.orgId},${f.employeeId},${f.subsidiaryId},'worker_comp',2025,'2026-07-09','2026-07-09',
          null,${groupId},'Reviewed classification report','Invalid tax year must refuse',${f.actorId})`),
            ),
            (error) => errorChainMatches(error, /payroll_employee_employer_assignments_check/),
          );
          await assert.rejects(commitPayRun(command), /recalculate/i);
          assert.deepEqual((await calculatePayRun(command)).errors, []);
          const original = await evidence();
          assert.ok(
            original.snapshot.payComponentStatutoryTreatments?.some(
              (row) => row.id === defaultId && row.employeeWorkerCompGroupId === null,
            ),
          );
          assert.equal(
            original.snapshot.payComponentStatutoryTreatments?.some(
              (row) => row.id === groupTreatmentId,
            ),
            false,
          );
          assert.equal(
            (
              await db.execute<{ id: string | null }>(
                sql`select public.payroll_worker_comp_group_at(
        ${f.orgId}::uuid,${f.employeeId}::uuid,'2026-07-09'::date)::text as id`,
                "objects",
              )
            )[0]!.id,
            groupId,
          );
          await commitPayRun(command);
          await db.execute(sql`update pay_component_statutory_treatments set effective_to='2026-07-31'
        where org_id=${f.orgId} and id=${defaultId}`);
          await assert.rejects(
            db.transaction((tx) =>
              tx.execute(sql`update pay_component_statutory_treatments
        set program_exclusions='{}' where org_id=${f.orgId} and id=${defaultId}`),
            ),
            (error) => errorChainMatches(error, /cannot be changed over committed history/),
          );
          await assert.rejects(
            db.transaction((tx) =>
              tx.execute(sql`update pay_component_statutory_treatments
        set vacationable=false where org_id=${f.orgId} and id=${defaultId}`),
            ),
            (error) => errorChainMatches(error, /cannot be changed over committed history/),
          );
          await assert.rejects(
            db.transaction((tx) =>
              tx.execute(sql`update pay_components
        set vacationable=false where org_id=${f.orgId} and id=${componentId}`),
            ),
            (error) => errorChainMatches(error, /creation-only default.*dated.*Payroll Setup/),
          );
          sandbox = await withBypassContext(() =>
            createSandbox({
              productionOrgId: f.orgId,
              name: "Statutory policy review",
              tier: "full",
              masked: false,
            }),
          );
          const target = sandbox.sandboxOrgId;
          await withBypassContext(async () => {
            const copied = (
              await db.execute<{
                snapshot: PayRunCalculationSourceSnapshot;
                digest: string;
                policy_id: string;
              }>(
                sql`
          select run.calculation_source_snapshot as snapshot,run.calculation_source_digest as digest,
            public.ob_rebase(${defaultId}::uuid,org.sandbox_seed)::text as policy_id
          from orgs org join pay_runs run on run.org_id=org.id
          where org.id=${target} and run.document_id=public.ob_rebase(${run.documentId}::uuid,org.sandbox_seed)`,
                "objects",
              )
            )[0]!;
            assert.deepEqual(copied.snapshot, original.snapshot);
            assert.equal(copied.digest, original.digest);
            assert.notEqual(copied.policy_id, defaultId);
            // Later source-window closure cannot remove the clone's consumed version protection.
            await db.execute(sql`update pay_component_statutory_treatments set effective_to='2026-07-30'
          where org_id=${f.orgId} and id=${defaultId}`);
            await assert.rejects(
              db.transaction((tx) =>
                tx.execute(sql`update pay_component_statutory_treatments
          set program_exclusions='{}' where org_id=${target} and id=${copied.policy_id}`),
              ),
              (error) => errorChainMatches(error, /cannot be changed over committed history/),
            );
          });
        }),
      );
      await withBypassContext(() => deleteSandbox(sandbox!.sandboxId));
      sandbox = undefined;
    } finally {
      if (sandbox) await withBypassContext(() => dropScratchOrgReporting(sandbox!.sandboxOrgId));
      await withBypassContext(() => dropScratchOrgReporting(f.orgId));
    }
  },
);
