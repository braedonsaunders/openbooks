import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { ManufacturingPostingError } from "./errors.ts";
import { postManufacturingEntry, type ManufacturingPostInput } from "./journal.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { JOURNAL_ENTRY_TABLE } from "../../../web/lib/customization/entity-list-query/journal-entries.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const evidence = { workOrderNumber: "WO-100", bomRevision: "BOM-3", routingVersion: "RT-2" };

async function post(org: ScratchOrg, actorId: string, custom: Record<string, unknown> = evidence) {
  return withBypassContext(async () => await db.transaction((tx) => postManufacturingEntry(tx, {
    orgId: org.orgId, bookId: org.bookId, subsidiaryId: org.subsidiaryId, actorId, currency: "CAD",
    periodId: org.periodId, date: org.date, entryNumber: `MFG-${randomUUID()}`, memo: "Production cost",
    lines: [{ accountId: org.accounts.invAsset, amount: "10.00" }, { accountId: org.accounts.cogs, amount: "-10.00" }], custom: custom as ManufacturingPostInput["custom"],
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
    const before = await withBypassContext(async () => (await db.execute<{ n: number }>(sql`select count(*)::int as n from journal_entries where org_id=${org.orgId} and origin='manufacturing'`)).rows[0]!.n);
    await assert.rejects(post(org, actorId, { ...evidence, bomRevision: " " }), (error: unknown) => error instanceof ManufacturingPostingError && error.message.includes("bomRevision"));
    const after = await withBypassContext(async () => (await db.execute<{ n: number }>(sql`select count(*)::int as n from journal_entries where org_id=${org.orgId} and origin='manufacturing'`)).rows[0]!.n);
    assert.equal(after, before);
  } finally { await dropScratchOrg(org.orgId); }
});

test("manufacturing period-pool posts persist only the settlement marker", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Shop lead", "admin"));
    await withBypassContext(async () => {
      const rows = await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"manufacturing":true}'::jsonb) where id=${org.orgId} returning id`);
      assert.equal(rows.rows.length, 1, "feature update must match its scratch organization");
    });
    const before = await withBypassContext(async () => (await db.execute<{ n: number }>(sql`select count(*)::int as n from journal_entries where org_id=${org.orgId} and origin='manufacturing'`)).rows[0]!.n);
    const id = await post(org, actorId, { scope: "period-pool" });
    const entry = (await withBypassContext(async () => await db.execute(sql`select origin,status,custom from journal_entries where org_id=${org.orgId} and id=${id}`))).rows[0]!;
    assert.equal(entry.origin, "manufacturing"); assert.equal(entry.status, "posted");
    assert.deepEqual(entry.custom, { settlement_scope: "period-pool" });
    const after = await withBypassContext(async () => (await db.execute<{ n: number }>(sql`select count(*)::int as n from journal_entries where org_id=${org.orgId} and origin='manufacturing'`)).rows[0]!.n);
    assert.equal(after, before + 1);
  } finally { await dropScratchOrg(org.orgId); }
});

test("manufacturing period-pool refuses extra keys without writing", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Shop lead", "admin"));
    await withBypassContext(async () => {
      const rows = await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"manufacturing":true}'::jsonb) where id=${org.orgId} returning id`);
      assert.equal(rows.rows.length, 1, "feature update must match its scratch organization");
    });
    const snapshot = async () => {
      const result: Record<string, unknown[]> = {};
      for (const table of ["journal_entries", "journal_lines", "audit_log", "inventory_movements"]) {
        result[table] = (await withBypassContext(async () => await db.execute(sql`select * from ${sql.identifier(table)} where org_id=${org.orgId} order by id`))).rows;
      }
      return result;
    };
    const before = await snapshot();
    await assert.rejects(post(org, actorId, { scope: "period-pool", poolNote: "overtime" }), (error: unknown) =>
      error instanceof ManufacturingPostingError &&
      error.message.includes("poolNote") &&
      error.message.includes("remove") &&
      error.message.includes('"work-order"'));
    assert.deepEqual(await snapshot(), before);
  } finally { await dropScratchOrg(org.orgId); }
});
