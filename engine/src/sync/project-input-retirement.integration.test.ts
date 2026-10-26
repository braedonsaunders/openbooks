import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { loadWageTimeEntries } from "../payroll/wage-hours.ts";
import { sourceTimeAvailableSql } from "../projects/source-time-availability.ts";
import { stubMigrationSource } from "./integration-seeds.ts";
import { syncProjectFinancialInputs } from "./project-financial-inputs.ts";
import { retireSourceProjectInputs } from "./project-input-retirement.ts";

test(
  "source deletion requires positive evidence, preserves history and fences future consumption",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    const employeeId = randomUUID(),
      projectId = randomUUID(),
      unknownProjectId = randomUUID(),
      unbilledId = randomUUID(),
      billedId = randomUUID(),
      connectionId = randomUUID(),
      runId = randomUUID();
    let confirmed = false;
    const source = {
      ...stubMigrationSource(),
      projectFinancialInputs: async () => ({ projects: [], timeEntryBillingStates: [] }),
      projectInputDeletions: async () =>
        confirmed
          ? {
              projects: [{ sourceRef: "project-1", deletedAt: "10/20/2026 2:00 PM" }],
              timeEntries: [
                { sourceRef: "time-1", deletedAt: "10/20/2026 2:00 PM" },
                { sourceRef: "time-2", deletedAt: "10/20/2026 2:00 PM" },
              ],
            }
          : { projects: [], timeEntries: [] },
    };
    const options = { orgId: org.orgId, connectionId, runId, apply: true };
    try {
      await withOrg(org.orgId, async () => {
        await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
        values(${employeeId},${org.orgId},'person','Source time worker',${org.subsidiaryId},true,'{}'::jsonb)`);
        for (const [id, ref] of [
          [projectId, "project-1"],
          [unknownProjectId, "project-unknown"],
        ]) {
          await db.execute(sql`insert into projects(id,org_id,subsidiary_id,name,status,is_active,custom)
          values(${id},${org.orgId},${org.subsidiaryId},${ref},'active',true,${JSON.stringify({ migrationTest: ref })}::jsonb)`);
        }
        for (const [id, ref, billing] of [
          [unbilledId, "time-1", "unbilled"],
          [billedId, "time-2", "billed"],
        ]) {
          await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,project_id,status,billing_status,costing_basis,is_billable,custom)
          values(${id},${org.orgId},${employeeId},${org.date},2,${projectId},'approved',${billing},'actual',true,${JSON.stringify({ migrationTest: ref })}::jsonb)`);
        }
        const refused = await syncProjectFinancialInputs(source, options);
        assert.equal(refused.targetOnlyProjects, 2);
        assert.equal(
          refused.targetOnlyTimeEntries,
          2,
          "an omitted source record is not deletion authority",
        );
        confirmed = true;
        const applied = await syncProjectFinancialInputs(source, options);
        assert.deepEqual(applied.preservedSourceDeletions, { projects: 1, timeEntries: 2 });
        assert.equal(applied.targetOnlyProjects, 1, "an unconfirmed project still blocks parity");
        assert.equal(applied.targetOnlyTimeEntries, 0);
        assert.equal(applied.applied, true);
        const time = await db.execute<{
          id: string;
          status: string;
          hours: string;
          billing_status: string;
          custom: { sourceRetirement: { deletedOn: string } };
        }>(
          sql`
        select id,status,hours::text,billing_status,custom from time_entries where org_id=${org.orgId} order by id`,
          "objects",
        );
        assert.equal(time.length, 2, "source retirement retains both records");
        assert.equal(time.find((row) => row.id === unbilledId)!.status, "approved");
        assert.equal(
          time.find((row) => row.id === billedId)!.status,
          "approved",
          "billed evidence retains its original lifecycle",
        );
        assert.ok(
          time.every(
            (row) =>
              row.hours === "2.0000" && row.custom.sourceRetirement.deletedOn === "2026-10-20",
          ),
        );
        for (const [day, expected] of [
          ["2026-10-19", 2],
          ["2026-10-20", 0],
        ] as const) {
          const available = (
            await db.execute<{ n: number }>(
              sql`select count(*)::int as n from time_entries
          where org_id=${org.orgId} and status='approved' and ${sourceTimeAvailableSql(sql`custom`, sql`${day}`)}`,
              "objects",
            )
          )[0]!.n;
          assert.equal(
            available,
            expected,
            "deletion does not reinterpret availability before its effective date",
          );
        }
        const wage = await loadWageTimeEntries(db, {
          orgId: org.orgId,
          employeePartyIds: [employeeId],
          periodStart: org.date,
          periodEnd: org.date,
          documentId: randomUUID(),
        });
        assert.equal(wage.length, 0, "source-retired time cannot enter another pay run");
      });
      const deletedSourceRefusal = (error: unknown) => {
        const cause = (error as { cause?: { code?: string; message?: string } }).cause;
        assert.equal(cause?.code, "23514");
        assert.match(cause?.message ?? "", /deleted in its authoritative source/);
        return true;
      };
      await assert.rejects(
        withOrg(org.orgId, async () => {
          await db.execute(
            sql`update time_entries set payroll_batch_ref=${randomUUID()} where org_id=${org.orgId} and id=${billedId}`,
          );
        }),
        deletedSourceRefusal,
      );
      await assert.rejects(
        withOrg(org.orgId, async () => {
          await db.execute(
            sql`update time_entries set hours=3 where org_id=${org.orgId} and id=${unbilledId}`,
          );
        }),
        deletedSourceRefusal,
      );
      await withOrg(org.orgId, async () => {
        const before = (
          await db.execute<{ n: number }>(
            sql`select count(*)::int as n from audit_log where org_id=${org.orgId} and request_id=${runId}`,
            "objects",
          )
        )[0]!.n;
        assert.equal(before, 3);
        await syncProjectFinancialInputs(source, options);
        const after = (
          await db.execute<{ n: number }>(
            sql`select count(*)::int as n from audit_log where org_id=${org.orgId} and request_id=${runId}`,
            "objects",
          )
        )[0]!.n;
        assert.equal(after, before, "replay preserves one retirement and audit per record");
      });
      await assert.rejects(
        withOrg(org.orgId, () =>
          retireSourceProjectInputs({
            ...options,
            actorId: null,
            source: source.name,
            refKey: source.refKey,
            projects: [
              { id: unknownProjectId, sourceRef: "project-unknown", deletedAt: "2026-10-20" },
              { id: randomUUID(), sourceRef: "project-1", deletedAt: "2026-10-20" },
            ],
            timeEntries: [],
          }),
        ),
        /changed before retirement/,
      );
      await withOrg(org.orgId, async () => {
        const rolledBack = (
          await db.execute<{ is_active: boolean; custom: Record<string, unknown> }>(
            sql`select is_active,custom from projects where org_id=${org.orgId} and id=${unknownProjectId}`,
            "objects",
          )
        )[0]!;
        assert.equal(rolledBack.is_active, true);
        assert.equal(
          rolledBack.custom.sourceRetirement,
          undefined,
          "a failed batch cannot leave a partial retirement",
        );
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
