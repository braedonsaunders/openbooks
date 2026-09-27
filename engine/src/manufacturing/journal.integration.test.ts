import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { ManufacturingPostingError } from "./errors.ts";
import { postManufacturingEntry } from "./journal.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { JOURNAL_ENTRY_TABLE } from "../../../web/lib/customization/entity-list-query/journal-entries.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const evidence = { workOrderNumber: "WO-100", bomRevision: "BOM-3", routingVersion: "RT-2" };

async function post(org: ScratchOrg, actorId: string, custom: Record<string, unknown> = evidence) {
  return withBypassContext(async () => await db.transaction((tx) => postManufacturingEntry(tx, {
    orgId: org.orgId, bookId: org.bookId, subsidiaryId: org.subsidiaryId, actorId, currency: "CAD",
    periodId: org.periodId, date: org.date, entryNumber: `MFG-${randomUUID()}`, memo: "Production cost",
    lines: [{ accountId: org.accounts.invAsset, amount: "10.00" }, { accountId: org.accounts.cogs, amount: "-10.00" }], custom,
  })));
}

test("manufacturing posts require evidence and appear in the Journal list", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Shop lead", "admin"));
    await withBypassContext(async () => {
      const rows = await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"manufacturing":true}'::jsonb) where id=${org.orgId} returning id`);
      assert.equal(rows.rows.length, 1, "feature update must match its scratch organization");
    });
    const id = await post(org, actorId);
    const entry = (await withBypassContext(async () => await db.execute(sql`select origin,status,custom from journal_entries where org_id=${org.orgId} and id=${id}`))).rows[0]!;
    assert.equal(entry.origin, "manufacturing"); assert.equal(entry.status, "posted");
    const custom = entry.custom as Record<string, unknown>;
    assert.deepEqual([custom.work_order_number, custom.bom_revision, custom.routing_version], ["WO-100", "BOM-3", "RT-2"]);
    const visible = await withBypassContext(async () => (await db.execute(sql`select id from ${sql.raw(JOURNAL_ENTRY_TABLE)} e where e.org_id=${org.orgId} and e.id=${id}`)).rows.map((row) => row.id));
    assert.deepEqual(visible, [id]);
    const before = await withBypassContext(async () => (await db.execute(sql`select count(*)::int as n from journal_entries where org_id=${org.orgId} and origin='manufacturing'`)).rows[0]!.n);
    await assert.rejects(post(org, actorId, { ...evidence, bomRevision: " " }), (error: unknown) => error instanceof ManufacturingPostingError && error.message.includes("bomRevision"));
    const after = await withBypassContext(async () => (await db.execute(sql`select count(*)::int as n from journal_entries where org_id=${org.orgId} and origin='manufacturing'`)).rows[0]!.n);
    assert.equal(after, before);
  } finally { await dropScratchOrg(org.orgId); }
});
