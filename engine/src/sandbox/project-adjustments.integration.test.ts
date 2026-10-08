import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { installEngineSeams } from "../composition/install.ts";
import {
  assertDedicatedFixtureDatabase, createScratchOrg, createScratchUser, dropScratchOrg,
} from "../testing/fixtures.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import { createSandbox, deleteSandbox, refreshSandbox } from "./lifecycle.ts";

installEngineSeams();
const DB = !!process.env.OPENBOOKS_DB_URL;
const adjustmentTables = ["project_financial_adjustments", "project_overhead_adjustments"] as const;

for (const masked of [false, true]) test(
  `${masked ? "masked" : "full"} sandbox preserves project adjustment ownership and reversal lineage through refresh and deletion`,
  { skip: !DB }, async () => {
    await assertDedicatedFixtureDatabase();
    const org = await createScratchOrg();
    const name = `Project adjustments ${randomUUID()}`;
    let failed = false;
    let failure: unknown;
    try {
      const actorId = await createScratchUser(org.orgId, "Project adjustment owner", "admin");
      const projectId = randomUUID();
      assert.equal((await db.execute(sql`insert into projects
        (id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
        values(${projectId},${org.orgId},${org.subsidiaryId},'ADJUSTMENT-JOB',
          'Recorded project',${org.customerId},'active',true,'{}'::jsonb) returning id`)).rows.length, 1);

      for (const table of adjustmentTables) {
        // Imported identifiers need not increase with time. Insert valid history
        // in lineage order with descending identifiers to expose ID-order copies.
        const ids = [randomUUID(), randomUUID(), randomUUID()].sort().reverse();
        const amount = table === "project_financial_adjustments" ? "75.1250" : "12.3750";
        for (let i = 0; i < ids.length; i++) {
          const measureColumn = table === "project_financial_adjustments" ? sql`,measure` : sql``;
          const measureValue = table === "project_financial_adjustments" ? sql`,'actual_cost'` : sql``;
          assert.equal((await db.execute(sql`insert into ${sql.raw(table)}
            (id,org_id,project_id,adjustment_date,amount,reason,source_system,source_ref,
              reverses_adjustment_id,evidence,created_by,updated_by${measureColumn})
            values(${ids[i]},${org.orgId},${projectId},${org.date},
              ${i === 1 ? `-${amount}` : amount},'Reviewed allocation correction',
              'recorded-allocation',${`allocation-${i}`},${i === 0 ? null : ids[i - 1]},
              '{"approval":"Reviewed allocation"}'::jsonb,${actorId},${actorId}${measureValue})
            returning id`)).rows.length, 1);
        }
      }
      const source = async () => Promise.all(adjustmentTables.map(async table =>
        (await db.execute(sql`select to_jsonb(a) as row from ${sql.raw(table)} a
          where org_id=${org.orgId} order by id`)).rows));
      const original = await source();
      const created = await createSandbox({ productionOrgId: org.orgId, name,
        tier: masked ? "masked" : "full", masked, createdBy: actorId,
        lifecycleAuthority: { actorId } });
      const target = created.sandboxOrgId;
      const copiedProject = (await db.execute<{ id: string }>(sql`select
        ob_rebase(${projectId}::uuid,sandbox_seed) as id from orgs where id=${target}`)).rows[0]!.id;

      const assertCopy = async () => {
        assert.equal((await db.execute(sql`select id from projects
          where org_id=${target} and id=${copiedProject}`)).rows.length, 1);
        for (const table of adjustmentTables) {
          const actual = (await db.execute(sql`select to_jsonb(a) as row from ${sql.raw(table)} a
            where org_id=${target} order by id`)).rows;
          const expected = (await db.execute(sql`select to_jsonb(a)||jsonb_build_object(
            'id',ob_rebase(a.id,o.sandbox_seed),'org_id',o.id,
            'project_id',ob_rebase(a.project_id,o.sandbox_seed),
            'reverses_adjustment_id',ob_rebase(a.reverses_adjustment_id,o.sandbox_seed)) as row
            from ${sql.raw(table)} a join orgs o on o.sandbox_of=a.org_id
            where o.id=${target} order by ob_rebase(a.id,o.sandbox_seed)`)).rows;
          assert.equal(actual.length, 3);
          assert.deepEqual(actual, expected,
            "amounts, dates, attribution, reasons and evidence retain exact history with rebased ownership and reversal links");
          assert.equal((await db.execute(sql`select a.id from ${sql.raw(table)} a
            join ${sql.raw(table)} parent on parent.org_id=a.org_id and parent.id=a.reverses_adjustment_id
            where a.org_id=${target} and a.project_id=parent.project_id and a.amount=-parent.amount`)).rows.length, 2);
        }
        assert.deepEqual(await source(), original);
        assert.equal((await db.execute<{ status: string }>(sql`select status from sandboxes
          where id=${created.sandboxId}`)).rows[0]!.status, "ready");
      };
      await assertCopy();
      for (const table of adjustmentTables) {
        const row = (await db.execute<{ id: string; amount: string }>(sql`select id,amount::text as amount
          from ${sql.raw(table)} where org_id=${target} and reverses_adjustment_id is null`)).rows[0]!;
        for (const tenant of [org.orgId, target]) {
          for (const mutation of [sql`update ${sql.raw(table)} set amount=amount+1 where org_id=${tenant}`,
            sql`delete from ${sql.raw(table)} where org_id=${tenant}`]) {
            await assert.rejects(withOrgTransaction(tenant, async () => {
              await db.execute(sql`select set_config('openbooks.clone','on',true),
                set_config('openbooks.migration','on',true),set_config('openbooks.amend','on',true)`);
              await db.execute(mutation);
            }), error => errorChainMatches(error, /adjustments are append-only; post a reversing adjustment/));
          }
        }
        // A source project pointer cannot grant ownership in the copied tenant.
        await assert.rejects(withOrgTransaction(target, () => db.execute(sql`
          insert into ${sql.raw(table)} select (jsonb_populate_record(null::${sql.raw(table)},
            to_jsonb(a)||jsonb_build_object('id',${randomUUID()}::uuid,'project_id',${projectId}::uuid,
              'source_ref','foreign-project'))).*
          from ${sql.raw(table)} a where org_id=${target} and id=${row.id}`)),
        error => errorChainMatches(error, /adjustment must belong to the project organization/));
        await assert.rejects(withOrgTransaction(target, () => db.execute(sql`
          insert into ${sql.raw(table)} select (jsonb_populate_record(null::${sql.raw(table)},
            to_jsonb(a)||jsonb_build_object('id',${randomUUID()}::uuid,'amount',-a.amount+1,
              'reverses_adjustment_id',a.id,'source_ref','incorrect-reversal'))).*
          from ${sql.raw(table)} a where org_id=${target} and id=${row.id}`)),
        error => errorChainMatches(error, /reversing.*adjustment must exactly offset the same project/));
      }
      await assertCopy();
      await refreshSandbox(created.sandboxId, { keepCustomizations: false, authority: { actorId } });
      await assertCopy();
      await deleteSandbox(created.sandboxId, { actorId });
      for (const table of [...adjustmentTables, "projects"])
        assert.equal((await db.execute(sql`select id from ${sql.raw(table)} where org_id=${target}`)).rows.length, 0);
      assert.equal((await db.execute(sql`select id from orgs where id=${target}`)).rows.length, 0);
      assert.deepEqual(await source(), original);
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    } finally {
      try {
        for (const shell of (await db.execute<{ id: string }>(sql`select id from sandboxes
          where production_org_id=${org.orgId} and name=${name}`)).rows)
          await deleteSandbox(shell.id, { systemReason: "Remove project adjustment clone fixture" });
        await dropScratchOrg(org.orgId);
      } catch (cleanupError) {
        if (failed) throw new AggregateError([failure, cleanupError],
          "Project adjustment assertions and cleanup both failed", { cause: failure });
        throw cleanupError;
      }
    }
  },
);
