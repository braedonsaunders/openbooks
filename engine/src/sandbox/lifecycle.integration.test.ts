import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { createScratchOrg, dropScratchOrg } from "../test-fixtures.ts";
import { createSandbox, deleteSandbox, refreshSandbox } from "./lifecycle.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("a clean-schema full sandbox clones tenant evidence without pre-seed collisions or residue", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const sandboxName = `Lifecycle ${randomUUID()}`;
  let sandboxId: string | null = null;
  let sandboxOrgId: string | null = null;
  try {
    const created = await createSandbox({
      productionOrgId: org.orgId,
      name: sandboxName,
      tier: "full",
      masked: false,
    });
    sandboxId = created.sandboxId;
    sandboxOrgId = created.sandboxOrgId;

    const state = (await db.execute<{
        status: string;
        storage_rows: number;
        env_kind: string;
        sandbox_of: string;
      }>(sql`
      select sandbox.status, sandbox.storage_rows, org.env_kind, org.sandbox_of
        from sandboxes sandbox
        join orgs org on org.id = sandbox.org_id
       where sandbox.id = ${sandboxId}`));
    assert.equal(state.rows[0]?.status, "ready");
    assert.ok(Number(state.rows[0]?.storage_rows) > 0);
    assert.equal(state.rows[0]?.env_kind, "sandbox");
    assert.equal(state.rows[0]?.sandbox_of, org.orgId);

    const controls = (await db.execute<{ key: string; account_id: string; org_id: string | null }>(sql`
      select control.key, control.value as account_id, account.org_id
        from orgs sandbox
        cross join lateral jsonb_each_text(
          sandbox.settings -> 'controlAccounts'
        ) control
        left join accounts account on account.id = control.value::uuid
       where sandbox.id = ${sandboxOrgId}
       order by control.key
    `));
    assert.ok(controls.rows.length >= 3);
    assert.ok(
      controls.rows.every(
        (row) =>
          row.org_id === sandboxOrgId &&
          !Object.values(org.accounts).includes(row.account_id),
      ),
    );

    const segments = (await db.execute<{ key: string; source_id: string; clone_id: string }>(sql`
      select source.key,
             source.id as source_id,
             clone.id as clone_id
        from segment_definitions source
        join segment_definitions clone
          on clone.key = source.key
         and clone.org_id = ${sandboxOrgId}
       where source.org_id = ${org.orgId}
       order by source.key`));
    const sourceSegmentCount = (await db.execute<{ count: number }>(sql`
      select count(*)::int as count
        from segment_definitions
       where org_id = ${org.orgId}`));
    assert.equal(segments.rows.length, sourceSegmentCount.rows[0]?.count);
    assert.equal(new Set(segments.rows.map((row) => row.key)).size, segments.rows.length);
    assert.ok(segments.rows.every((row) => row.source_id !== row.clone_id));

    await refreshSandbox(sandboxId, { keepCustomizations: false });
    const refreshed = (await db.execute<{ status: string; last_error: string | null }>(sql`
      select status, last_error from sandboxes where id = ${sandboxId}`));
    assert.deepEqual(refreshed.rows, [{ status: "ready", last_error: null }]);
    const refreshedControls = await db.execute(sql`
      select count(*)::int as count
        from orgs sandbox
        cross join lateral jsonb_each_text(
          sandbox.settings -> 'controlAccounts'
        ) control
        join accounts account
          on account.id = control.value::uuid
         and account.org_id = sandbox.id
       where sandbox.id = ${sandboxOrgId}
    `);
    assert.equal(
      Number((refreshedControls.rows[0] as { count: number }).count),
      controls.rows.length,
    );

    await deleteSandbox(sandboxId);
    sandboxId = null;
    const residue = (await db.execute<{ orgs: number; segments: number; entries: number }>(sql`
      select
        (select count(*)::int from orgs where id = ${sandboxOrgId}) as orgs,
        (select count(*)::int from segment_definitions where org_id = ${sandboxOrgId}) as segments,
        (select count(*)::int from journal_entries where org_id = ${sandboxOrgId}) as entries`));
    assert.deepEqual(residue.rows, [{ orgs: 0, segments: 0, entries: 0 }]);
  } finally {
    if (sandboxId) {
      await deleteSandbox(sandboxId).catch(() => undefined);
    } else {
      const failed = (await db.execute<{ id: string }>(sql`
        select id from sandboxes
         where production_org_id = ${org.orgId}
           and name = ${sandboxName}`));
      for (const row of failed.rows) {
        await deleteSandbox(row.id).catch(() => undefined);
      }
    }
    await dropScratchOrg(org.orgId);
  }
});
