import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/platform/db.ts";
import { ManufacturingFeatureDisabledError } from "@openbooks/engine/src/manufacturing/errors.ts";
import { manufacturingFeatureEnabled } from "@openbooks/engine/src/manufacturing/gate.ts";
import { postManufacturingEntry } from "@openbooks/engine/src/manufacturing/journal.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "@openbooks/engine/src/testing/fixtures.ts";
import { JOURNAL_ENTRY_TABLE } from "@/lib/customization/entity-list-query/journal-entries";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const evidence = { workOrderNumber: "WO-200", bomRevision: "BOM-1", routingVersion: "RT-1" };

async function features(orgId: string, state: Record<string, boolean>) {
  await withBypassContext(async () => {
    const rows = await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||${JSON.stringify(state)}::jsonb) where id=${orgId} returning id`);
    assert.equal(rows.rows.length, 1, "feature update must match its scratch organization");
  });
}
async function post(org: ScratchOrg, actorId: string) {
  return withBypassContext(async () => await db.transaction((tx) => postManufacturingEntry(tx, {
    orgId: org.orgId, bookId: org.bookId, subsidiaryId: org.subsidiaryId, actorId, currency: "CAD",
    periodId: org.periodId, date: org.date, entryNumber: `MFG-${randomUUID()}`, memo: "Production cost",
    lines: [{ accountId: org.accounts.invAsset, amount: "10.00" }, { accountId: org.accounts.cogs, amount: "-10.00" }], custom: evidence,
  })));
}
async function snapshot(orgId: string, id: string) {
  return withBypassContext(async () => ({
    entry: (await db.execute(sql`select * from journal_entries where org_id=${orgId} and id=${id}`)).rows[0],
    lines: (await db.execute(sql`select * from journal_lines where org_id=${orgId} and entry_id=${id} order by line_number`)).rows,
  }));
}
async function listed(orgId: string, id: string) {
  return withBypassContext(async () => (await db.execute(sql`select e.id from ${sql.raw(JOURNAL_ENTRY_TABLE)} e where e.org_id=${orgId} and e.id=${id}`)).rows.map((row) => row.id));
}
async function refuses(posting: Promise<unknown>) {
  await assert.rejects(posting, (error: unknown) => error instanceof ManufacturingFeatureDisabledError
    && /manufacturing/i.test(error.message) && error.message.includes("Turn it on in Company Settings → Features"));
}

test("manufacturing is off by default, parent-fenced, and preserves posted history", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Shop lead", "admin"));
    assert.equal(await withBypassContext(() => manufacturingFeatureEnabled(org.orgId, "manufacturing")), false);
    await refuses(post(org, actorId));
    await features(org.orgId, { manufacturing: true, inventory: false });
    assert.equal(await withBypassContext(() => manufacturingFeatureEnabled(org.orgId, "manufacturing")), false);
    await refuses(post(org, actorId));
    const refusedCount = await withBypassContext(async () => (await db.execute(sql`select count(*)::int as n from journal_entries where org_id=${org.orgId} and origin='manufacturing'`)).rows[0]!.n);
    assert.equal(refusedCount, 0);
    await features(org.orgId, { manufacturing: true, inventory: true });
    const first = await post(org, actorId); const original = await snapshot(org.orgId, first);
    assert.deepEqual(await listed(org.orgId, first), [first]);
    await features(org.orgId, { manufacturing: false });
    await refuses(post(org, actorId));
    assert.deepEqual(await snapshot(org.orgId, first), original);
    assert.deepEqual(await listed(org.orgId, first), [first]);
    await features(org.orgId, { manufacturing: true });
    assert.deepEqual(await snapshot(org.orgId, first), original);
    const second = await post(org, actorId);
    assert.notEqual(second, first);
    assert.deepEqual(await listed(org.orgId, second), [second]);
  } finally { await dropScratchOrg(org.orgId); }
});
