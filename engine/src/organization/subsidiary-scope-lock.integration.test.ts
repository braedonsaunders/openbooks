import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool, withBypass } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import {
  lockProjectForScope,
  ScopeNotFoundError,
  withScopeSnapshot,
} from "./subsidiary-scope.ts";

async function seedProject(orgId: string, subsidiaryId: string): Promise<string> {
  const projectId = randomUUID();
  const code = `SCOPE-LOCK-${projectId.slice(0, 8)}`;
  await db.execute(sql`
    insert into projects (id, org_id, subsidiary_id, code, name, status, is_active)
    values (${projectId}, ${orgId}, ${subsidiaryId}, ${code}, ${code}, 'active', true)
  `);
  return projectId;
}

async function assertNotFound(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ScopeNotFoundError, `expected ScopeNotFoundError, got ${error}`);
    assert.equal((error as ScopeNotFoundError).status, 404);
    assert.equal((error as Error).message, "not found");
    return true;
  });
}

test("lockProjectForScope returns the locked project only when it is in scope", async () => {
  const scratch = await withBypass(() => createScratchOrg());
  try {
    const hiddenSubsidiary = randomUUID();
    await withBypass(() => db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      values (${hiddenSubsidiary}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Hidden lock entity', 'CAD', 'CA')
    `));
    const visibleProject = await withBypass(() => seedProject(scratch.orgId, scratch.subsidiaryId));
    const hiddenProject = await withBypass(() => seedProject(scratch.orgId, hiddenSubsidiary));
    const scope = new Set([scratch.subsidiaryId]);

    const visible = await withBypass(() => db.transaction((tx) =>
      lockProjectForScope(tx, scratch.orgId, visibleProject, scope)));
    assert.deepEqual(visible, { id: visibleProject, subsidiaryId: scratch.subsidiaryId });

    await withBypass(() => assertNotFound(db.transaction((tx) =>
      lockProjectForScope(tx, scratch.orgId, hiddenProject, scope))));
    await withBypass(() => assertNotFound(db.transaction((tx) =>
      lockProjectForScope(tx, scratch.orgId, randomUUID(), scope))));

    const unrestricted = await withBypass(() => db.transaction((tx) =>
      lockProjectForScope(tx, scratch.orgId, hiddenProject, null)));
    assert.deepEqual(unrestricted, { id: hiddenProject, subsidiaryId: hiddenSubsidiary });

    const shared = await withBypass(() => db.transaction((tx) =>
      lockProjectForScope(tx, scratch.orgId, visibleProject, scope, "share")));
    assert.deepEqual(shared, { id: visibleProject, subsidiaryId: scratch.subsidiaryId });
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId));
  }
});

test("lockProjectForScope rechecks scope after a concurrent rehome", async () => {
  const scratch = await withBypass(() => createScratchOrg());
  try {
    const otherSubsidiary = randomUUID();
    await withBypass(() => db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      values (${otherSubsidiary}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Rehome target entity', 'CAD', 'CA')
    `));
    const projectId = await withBypass(() => seedProject(scratch.orgId, scratch.subsidiaryId));
    const scope = new Set([scratch.subsidiaryId]);

    const before = await withBypass(() => db.transaction((tx) =>
      lockProjectForScope(tx, scratch.orgId, projectId, scope)));
    assert.deepEqual(before, { id: projectId, subsidiaryId: scratch.subsidiaryId });

    // A concurrent reassignment moves the project out of scope between reads.
    await withBypass(() => db.execute(sql`
      update projects set subsidiary_id = ${otherSubsidiary}
       where id = ${projectId} and org_id = ${scratch.orgId}
    `));

    await withBypass(() => assertNotFound(db.transaction((tx) =>
      lockProjectForScope(tx, scratch.orgId, projectId, scope))));
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId));
  }
});

test("withScopeSnapshot holds one snapshot across queries", async () => {
  const scratch = await withBypass(() => createScratchOrg());
  try {
    const projectId = await withBypass(() => seedProject(scratch.orgId, scratch.subsidiaryId));
    const otherSubsidiary = randomUUID();
    await withBypass(() => db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      values (${otherSubsidiary}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Snapshot target entity', 'CAD', 'CA')
    `));
    const readSubsidiary = async () =>
      (await db.execute<{ subsidiary_id: string }>(sql`
        select subsidiary_id from projects where id = ${projectId} and org_id = ${scratch.orgId}
      `)).rows[0]!.subsidiary_id;

    // A concurrent reassignment commits mid-snapshot on its own connection
    // (it cannot reuse the test's bypass scope from inside the snapshot);
    // the snapshot keeps seeing the first read, and a fresh read afterwards
    // sees the move — proving the write did commit and the snapshot did not.
    const moveMidSnapshot = async () => {
      const client = await pool.connect();
      try {
        await client.query("select set_config('app.bypass_rls', 'on', true)");
        await client.query("update projects set subsidiary_id = $1 where id = $2 and org_id = $3", [
          otherSubsidiary,
          projectId,
          scratch.orgId,
        ]);
      } finally {
        client.release();
      }
    };
    const seen = await withScopeSnapshot(scratch.orgId, async () => {
      const first = await readSubsidiary();
      await moveMidSnapshot();
      const second = await readSubsidiary();
      return { first, second };
    });
    assert.equal(seen.first, scratch.subsidiaryId);
    assert.equal(seen.second, scratch.subsidiaryId, "the snapshot must not see the concurrent commit");
    assert.equal(await withBypass(readSubsidiary), otherSubsidiary);

    // A throw rolls the snapshot back: no partial unit ever commits.
    await assert.rejects(
      withScopeSnapshot(scratch.orgId, async () => {
        await db.execute(sql`
          update projects set name = ${"abandoned"} where id = ${projectId} and org_id = ${scratch.orgId}
        `);
        throw new Error("boom");
      }),
      /boom/,
    );
    const name = (await withBypass(() => db.execute<{ name: string }>(sql`
      select name from projects where id = ${projectId} and org_id = ${scratch.orgId}
    `))).rows[0]!.name;
    assert.match(name, /^SCOPE-LOCK-/);
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId));
  }
});
