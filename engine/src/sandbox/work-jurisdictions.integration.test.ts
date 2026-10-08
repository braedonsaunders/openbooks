import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withMaintenanceTransaction, withOrgTransaction } from "../platform/db.ts";
import { installEngineSeams } from "../composition/install.ts";
import {
  createScratchOrg, createScratchUser, dropScratchOrg, seedActiveEmployment,
  seedPayrollPerson, seedPayrollProfile, seedPayrollSchedule, seedPayrollTime,
  seedWorkerEmployment,
} from "../testing/fixtures.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import { createSandbox, deleteSandbox, refreshSandbox } from "./lifecycle.ts";

installEngineSeams();
const DB = !!process.env.OPENBOOKS_DB_URL;

async function cloneFlags() {
  await db.execute(sql`select set_config('openbooks.clone','on',true),
    set_config('openbooks.migration','on',true),set_config('openbooks.amend','on',true)`);
}

for (const masked of [false, true]) test(
  `${masked ? "masked" : "full"} sandbox preserves unknown work jurisdiction without disabling ordinary defaults or HR overrides`,
  { skip: !DB }, async () => {
    const org = await createScratchOrg();
    const name = `Work jurisdiction ${randomUUID()}`;
    let failed = false;
    let failure: unknown;
    try {
      const actorId = await createScratchUser(org.orgId, "Sandbox owner", "admin");
      const personId = randomUUID(), scheduleId = randomUUID(), unknownId = randomUUID();
      await seedPayrollPerson(org.orgId, personId, "Recorded worker", { subsidiaryId: org.subsidiaryId });
      await seedActiveEmployment(org.orgId, personId);
      const employmentId = await seedWorkerEmployment(org.orgId, personId, org.subsidiaryId);
      const time = (id: string, region: string | null = null) => seedPayrollTime(org.orgId, personId, actorId, {
        id, workedOn: org.date, hours: "2.5000", status: "approved", projectId: null,
        costingBasis: "actual", billingStatus: "unbilled", isBillable: false,
        workRegion: region, workRegionSource: region ? "imported_record" : null,
      });
      // Earlier work genuinely predates a tax profile; no guard or trigger is
      // disabled to manufacture its unknown historical jurisdiction.
      await time(unknownId);
      await time(randomUUID(), "QC");
      await seedPayrollSchedule(org.orgId, scheduleId, actorId, {
        name: "Weekly", frequency: "weekly", periodsPerYear: 52,
        anchorPeriodEnd: "2026-07-18", payDateOffsetDays: 3,
      });
      await seedPayrollProfile(org.orgId, personId, employmentId, scheduleId, actorId, {
        country: "CA", province: "ON", payBasis: "hourly",
      });
      const productionId = randomUUID();
      await withMaintenanceTransaction(null, async () => {
        await cloneFlags();
        await time(productionId);
        assert.deepEqual((await db.execute(sql`select work_region,work_region_source from time_entries
          where org_id=${org.orgId} and id=${productionId}`)).rows,
        [{ work_region: "ON", work_region_source: "payroll_profile" }],
        "even privileged clone flags cannot suppress defaults in production");
      });
      const source = async () => (await db.execute(sql`select to_jsonb(t) as row from time_entries t
        where org_id=${org.orgId} order by id`)).rows;
      const original = await source();
      const created = await createSandbox({ productionOrgId: org.orgId, name,
        tier: masked ? "masked" : "full", masked, createdBy: actorId,
        lifecycleAuthority: { actorId } });
      const target = created.sandboxOrgId;
      const ids = (await db.execute<{ unknown: string; person: string; actor: string }>(sql`select
        ob_rebase(${unknownId}::uuid,sandbox_seed) as unknown,
        ob_rebase(${personId}::uuid,sandbox_seed) as person,
        ob_rebase(${actorId}::uuid,sandbox_seed) as actor from orgs where id=${target}`)).rows[0]!;
      const assertCopy = async () => {
        assert.equal((await db.execute(sql`select id from time_entries where org_id=${target}`)).rows.length, 3);
        const actual = (await db.execute<{ matched: boolean }>(sql`select
          (t.employee_party_id=ob_rebase(s.employee_party_id,o.sandbox_seed)
           and t.worked_on=s.worked_on and t.hours=s.hours
           and row(t.work_region,t.work_subregion,t.work_region_source,t.work_region_reason)
               is not distinct from row(s.work_region,s.work_subregion,s.work_region_source,s.work_region_reason)) as matched
          from time_entries t join orgs o on o.id=t.org_id
          join time_entries s on s.org_id=o.sandbox_of and t.id=ob_rebase(s.id,o.sandbox_seed)
          where t.org_id=${target}`)).rows;
        assert.equal(actual.length, 3);
        assert.ok(actual.every(row => row.matched), "copy must not turn an unknown jurisdiction into a present-day declaration");
        assert.deepEqual(await source(), original);
      };
      await assertCopy();
      await withOrgTransaction(target, async () => {
        await cloneFlags();
        assert.equal((await db.execute<{ allowed: boolean }>(sql`select openbooks_clone_authority() as allowed`)).rows[0]!.allowed, false);
        const inserted = (await db.execute<{ work_region: string; work_region_source: string }>(sql`
          insert into time_entries(org_id,employee_party_id,worked_on,hours,status,is_billable,created_by,updated_by)
          values(${target},${ids.person},${org.date},'1','draft',false,${ids.actor},${ids.actor})
          returning work_region,work_region_source`)).rows;
        assert.deepEqual(inserted, [{ work_region: "ON", work_region_source: "payroll_profile" }]);
      });
      await assert.rejects(withOrgTransaction(target, () => db.execute(sql`update time_entries
        set work_region='BC' where org_id=${target} and id=${ids.unknown}`)),
      error => errorChainMatches(error, /Changing a time entry work jurisdiction requires an HR override reason/));
      await withOrgTransaction(target, async () => {
        assert.equal((await db.execute(sql`update time_entries set work_region='BC',
          work_region_source='hr_override',work_region_reason='Reviewed work location',updated_by=${ids.actor}
          where org_id=${target} and id=${ids.unknown} returning id`)).rows.length, 1);
        assert.equal((await db.execute(sql`select id from audit_log where org_id=${target}
          and row_id=${ids.unknown} and action='work_jurisdiction_override' and actor_id=${ids.actor}`)).rows.length, 1);
      });
      await refreshSandbox(created.sandboxId, { keepCustomizations: false, authority: { actorId } });
      await assertCopy();
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    } finally {
      try {
        for (const shell of (await db.execute<{ id: string }>(sql`select id from sandboxes
          where production_org_id=${org.orgId} and name=${name}`)).rows) await deleteSandbox(shell.id);
        await dropScratchOrg(org.orgId);
      } catch (cleanupError) {
        if (failed) throw new AggregateError([failure, cleanupError],
          "Work jurisdiction assertions and cleanup both failed", { cause: failure });
        throw cleanupError;
      }
    }
  },
);
