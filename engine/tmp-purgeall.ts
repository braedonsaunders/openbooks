import { db } from "./src/db.ts";
import { sql } from "drizzle-orm";

const ORG_ID_TABLES: string[] = ((): any => null) as any; // placeholder
async function orgIdTables(): Promise<string[]> {
  return ((await db.execute(sql`select table_name from information_schema.columns where column_name='org_id' and table_schema='public' and table_name<>'orgs'`)).rows as any[]).map(r=>String(r.table_name));
}
async function purge(orgId: string, tbls: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local openbooks.amend='on'`); await tx.execute(sql`set local openbooks.sandbox_wipe='on'`);
    await tx.execute(sql`update orgs set env_kind='sandbox' where id=${orgId}`);
    await tx.execute(sql`update inventory_movements set status='pending' where org_id=${orgId}`);
    await tx.execute(sql`delete from file_blobs where version_id in (select v.id from file_versions v join files f on f.id=v.file_id where f.org_id=${orgId})`);
    await tx.execute(sql`delete from file_versions where file_id in (select id from files where org_id=${orgId})`);
    await tx.execute(sql`delete from tax_group_members where tax_group_id in (select id from tax_groups where org_id=${orgId})`);
  });
  let remaining = tbls;
  for (let pass=0; pass<8 && remaining.length; pass++) {
    const failed:string[]=[];
    for (const t of remaining) {
      try { await db.transaction(async (tx) => {
        await tx.execute(sql`set local openbooks.amend='on'`); await tx.execute(sql`set local openbooks.sandbox_wipe='on'`);
        await tx.execute(sql`set constraints all deferred`);
        await tx.execute(sql.raw(`delete from "${t}" where org_id = '${orgId}'`));
      }); } catch { failed.push(t); }
    }
    if (failed.length===remaining.length) { remaining=failed; break; }
    remaining=failed;
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local openbooks.amend='on'`); await tx.execute(sql`set local openbooks.sandbox_wipe='on'`);
    await tx.execute(sql`set constraints all deferred`);
    await tx.execute(sql`update time_entries set invoiced_by_line_id=null, cost_journal_entry_id=null where org_id=${orgId}`);
    for (const t of ["time_entries","document_lines","documents","journal_entries","projects","time_types","items","parties","accounting_periods","accounting_books","fiscal_calendars","accounts","subsidiaries","project_types", ...remaining]) {
      await tx.execute(sql.raw(`delete from "${t}" where org_id = '${orgId}'`));
    }
    await tx.execute(sql`delete from orgs where id=${orgId}`);
  });
}

(async () => {
  const keepers = ['c0b4e32c','b64f1e87','d0c5e2c1'];
  const all = (await db.execute(sql`select id, name from orgs where name like 'SIM ·%' order by name`)).rows as any[];
  const del = all.filter(o => !keepers.some(k => String(o.id).startsWith(k)));
  const tbls = await orgIdTables();
  console.log(`purging ${del.length} SIM orgs (${tbls.length} org_id tables scanned)...`);
  let ok=0, fail=0;
  for (const o of del) {
    try { await purge(String(o.id), tbls); ok++; console.log(`  ✓ ${String(o.id).slice(0,8)}  ${o.name}`); }
    catch(e:any){ fail++; console.log(`  ✗ ${String(o.id).slice(0,8)}  ${(e.cause?.message ?? e.message).split("\n")[0].slice(0,110)}`); }
  }
  console.log(`\ndeleted ${ok}, failed ${fail}`);
  process.exit(0);
})();
