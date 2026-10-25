/**
 * 0006 gives imported tax groups readable codes: a group whose code ends in
 * its own source id suffix takes its plain name when free, otherwise
 * "<name> (tax group)", and every rename is audited. A suffix that does not
 * match the row's own source record refuses the upgrade by name.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { createScratchOrg, type ScratchOrg } from "@openbooks/engine/testing/fixtures";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

const migrationSql = readFileSync(
  new URL("./0006_tax_group_readable_codes.sql", import.meta.url),
  "utf8",
);

async function addTaxCode(o: ScratchOrg, code: string, sourceId: string | null, kind: string | null): Promise<string> {
  const custom = kind
    ? { nsId: sourceId, source: { system: "source-erp", externalId: sourceId }, sourceRecordKind: kind }
    : {};
  const rows = await db.execute<{ id: string }>(sql`
    insert into tax_codes (org_id, code, name, custom)
    values (${o.orgId}, ${code}, ${code.replace(/ \[grp:\d+\]$/, "")}, ${JSON.stringify(custom)}::jsonb)
    returning id`, "objects");
  return rows[0]!.id;
}

async function codeOf(id: string): Promise<string> {
  const rows = await db.execute<{ code: string }>(sql`select code from tax_codes where id = ${id}`, "objects");
  return rows[0]!.code;
}

test("tax groups lose their source id suffix and every rename is audited", { skip: !DB, timeout: 120_000 }, async () => {
  const o = await createScratchOrg();
  await addTaxCode(o, "HST", "8", "salestaxitem");
  const shared = await addTaxCode(o, "HST [grp:2529]", "2529", "taxgroup");
  const free = await addTaxCode(o, "GST_CA_8 [grp:2679]", "2679", "taxgroup");
  const notGroup = await addTaxCode(o, "MANUAL [grp:1]", null, null);

  await db.execute(sql.raw(migrationSql));

  assert.equal(await codeOf(shared), "HST (tax group)", "a name already used by a tax item gains a readable qualifier");
  assert.equal(await codeOf(free), "GST_CA_8", "a free name is used as is");
  assert.equal(await codeOf(notGroup), "MANUAL [grp:1]", "codes that are not imported groups are left alone");

  const audit = await db.execute<{ row_id: string; changes: { code: [string, string]; reason: string } }>(sql`
    select row_id, changes from audit_log
     where org_id = ${o.orgId} and table_name = 'tax_codes' order by row_id`, "objects");
  assert.deepEqual(
    audit.map((row) => [row.row_id, row.changes.code, row.changes.reason]).sort(),
    [
      [shared, ["HST [grp:2529]", "HST (tax group)"], "tax_group_readable_code"],
      [free, ["GST_CA_8 [grp:2679]", "GST_CA_8"], "tax_group_readable_code"],
    ].sort(),
  );

  await db.execute(sql.raw(migrationSql));
  const after = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_log where org_id = ${o.orgId} and table_name = 'tax_codes'`, "objects");
  assert.equal(after[0]!.n, 2, "a second run finds nothing to rename");
});

test("a suffix that names a different source record refuses the upgrade", { skip: !DB, timeout: 120_000 }, async () => {
  const o = await createScratchOrg();
  const mismatched = await addTaxCode(o, "PST [grp:999]", "2821", "taxgroup");
  await assert.rejects(
    () => db.transaction(async (tx) => { await tx.execute(sql.raw(migrationSql)); }),
    (error: unknown) => /does not match its own source record/.test(String((error as { cause?: unknown }).cause ?? error)),
  );
  assert.equal(await codeOf(mismatched), "PST [grp:999]");
  await db.execute(sql`delete from tax_codes where id = ${mismatched}`);
});
