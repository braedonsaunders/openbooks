import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { sql } from "drizzle-orm";
import { db, pool, withBypass, withBypassContext } from "../db.ts";
import { createScratchOrg, dropScratchOrg, listOrgIdTables, orgRowCounts } from "../test-fixtures.ts";
import { SIM_ORG_PREFIX } from "./db-guard.ts";
import { professionalServices } from "./profiles/professional-services.ts";
import { provisionOrg, resetOrg, wipeSimOrg } from "./world.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
after(() => pool.end());

/** Compare complete persisted rows, not only counts: sibling edits are as
 * destructive as sibling deletes. Include every current tenant table. */
async function snapshotOrg(orgId: string): Promise<Record<string, unknown>> {
  return withBypassContext(async () => {
    const tables = await listOrgIdTables();
    const snapshot: Record<string, unknown> = {};
    for (const table of ["orgs", ...tables]) {
      assert.match(table, /^[a-z_][a-z0-9_]*$/);
      const rows = await db.execute(sql`
        select to_jsonb(t)::text as row from ${sql.raw(`public."${table}"`)} t
        where ${sql.raw(table === "orgs" ? "id" : "org_id")} = ${orgId}
        order by to_jsonb(t)::text`);
      if (rows.rows.length) snapshot[table] = rows.rows;
    }
    return snapshot;
  });
}

test("SIM teardown removes posted history durably, preserves siblings, and never enters the Scratch guard", { skip: !DB, timeout: 120_000 }, async () => {
  const sibling = await withBypassContext(() => createScratchOrg());
  let simId: string | undefined;
  try {
    const sim = await provisionOrg({
      ...professionalServices,
      name: `Teardown ${randomUUID()}`,
      vendors: [], customers: [], workforce: [],
    }, { startDate: "2026-07-01", endDate: "2026-07-31" });
    simId = sim.orgId;
    const before = await orgRowCounts(simId);
    assert.ok((before.journal_entries ?? 0) > 0, "provisioning posts opening journals");
    assert.ok((before.journal_lines ?? 0) > 0, "posted lines reference accounts");
    assert.ok((before.audit_log ?? 0) > 0, "append-only history must be exercised");
    const simBeforeRefusal = await snapshotOrg(simId);
    await assert.rejects(dropScratchOrg(simId), /dropScratchOrg refused/);
    assert.deepEqual(await snapshotOrg(simId), simBeforeRefusal);
    const siblingBefore = await snapshotOrg(sibling.orgId);
    await assert.rejects(resetOrg(sibling.orgId), /dropSimOrg refused/);
    await assert.rejects(wipeSimOrg(sibling.orgId), /dropSimOrg refused/);
    assert.deepEqual(await snapshotOrg(sibling.orgId), siblingBefore);
    const rollback = new Error("outer transaction rolls back");
    await assert.rejects(withBypass(async () => {
      await resetOrg(sim.orgId);
      throw rollback;
    }), rollback);
    assert.deepEqual(await orgRowCounts(simId), {}, "every tenant table is durably empty");
    assert.deepEqual(await snapshotOrg(sibling.orgId), siblingBefore, "all sibling rows are unchanged");
    await resetOrg(simId);
    await wipeSimOrg(simId);
    assert.deepEqual(await orgRowCounts(simId), {}, "repeat deletion proves the org remains absent");
  } finally {
    if (simId) await resetOrg(simId);
    await dropScratchOrg(sibling.orgId);
  }
});

test("both SIM entry points refuse missing tags, malformed tags, Scratch identities, and unprefixed names without mutation", { skip: !DB, timeout: 120_000 }, async () => {
  const identities = [
    { name: `${SIM_ORG_PREFIX}Untagged`, settings: {} },
    { name: `${SIM_ORG_PREFIX}String tag`, settings: { simHarness: "true" } },
    { name: `${SIM_ORG_PREFIX}False tag`, settings: { simHarness: false } },
    { name: "Scratch Simulator guard", settings: {} },
    { name: "Ordinary tenant", settings: { simHarness: true } },
  ];
  for (const identity of identities) {
    const orgId = randomUUID();
    await withBypassContext(() => db.execute(sql`
      insert into orgs (id, name, base_currency, country, settings, env_kind)
      values (${orgId}, ${identity.name}, 'CAD', 'CA', ${JSON.stringify(identity.settings)}::jsonb, 'production')`));
    try {
      const before = await snapshotOrg(orgId);
      await assert.rejects(resetOrg(orgId), /dropSimOrg refused/);
      await assert.rejects(wipeSimOrg(orgId), /dropSimOrg refused/);
      assert.deepEqual(await snapshotOrg(orgId), before, "refusal precedes sandbox demotion or deletion");
    } finally {
      // INSERT also seeds built-in segments. Clean only this test-owned
      // identity with the sandbox cascade; never rename or retag a refusal.
      await withBypass(async () => {
        await db.execute(sql`set local openbooks.sandbox_wipe = 'on'`);
        await db.execute(sql`update orgs set env_kind = 'sandbox' where id = ${orgId}`);
        await db.execute(sql`delete from segment_definitions where org_id = ${orgId}`);
        await db.execute(sql`delete from orgs where id = ${orgId}`);
      });
    }
  }
});
