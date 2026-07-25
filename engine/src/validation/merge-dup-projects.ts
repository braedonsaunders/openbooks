/** Merge the duplicate project pairs the two connectors created (see migrate.ts
 *  findProjectByRef). Keeps the row holding the data, repoints every reference,
 *  folds the other connector's source ids into its custom, deletes the shell. */
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
const O = process.env.SANDBOX_ORG ?? "6d5799ad-a37c-4aea-9cd4-748e4dc59614";
const APPLY = process.argv.includes("--apply");
(async () => {
  const env: any = await db.execute(sql`select env_kind from orgs where id = ${O}`);
  if (env.rows[0]?.env_kind !== "sandbox") throw new Error("refusing: not a sandbox org");
  const pairs: any = await db.execute(sql`
    with ranked as (
      select p.id, p.name, p.custom,
             (select count(*) from time_entries te where te.project_id = p.id)
           + (select count(*) from document_lines dl where dl.project_id = p.id) as rows,
             row_number() over (partition by p.name order by
               (select count(*) from time_entries te where te.project_id = p.id)
             + (select count(*) from document_lines dl where dl.project_id = p.id) desc, p.id) rn
        from projects p where p.org_id = ${O})
    select k.id keep_id, d.id drop_id, k.name
      from ranked k join ranked d on d.name = k.name and k.rn = 1 and d.rn > 1`);
  console.log(`duplicate pairs: ${pairs.rows.length}${APPLY ? "" : "  (dry run — pass --apply)"}`);
  if (!APPLY) { process.exit(0); }
  let moved = 0;
  for (const p of pairs.rows) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('openbooks.sandbox_wipe','on',true)`);
      await tx.execute(sql`select set_config('openbooks.amend','on',true)`);
      // every table with an FK to projects (introspected from the live catalog)
      for (const t of ["time_entries", "document_lines", "journal_lines", "documents", "billing_requests",
                       "billing_schedules", "budget_lines", "compliance_records", "compliance_waivers",
                       "fixed_assets", "item_rate_book_assignments", "lien_waivers", "project_tasks"]) {
        await tx.execute(sql.raw(`update "${t}" set project_id = '${p.keep_id}' where org_id = '${O}' and project_id = '${p.drop_id}'`));
      }
      await tx.execute(sql`update projects set parent_id = ${p.keep_id} where org_id = ${O} and parent_id = ${p.drop_id}`);
      // carry the dropped row's source ids so future syncs from either connector match
      await tx.execute(sql`
        update projects k set custom = coalesce(k.custom,'{}'::jsonb) || coalesce((select d.custom from projects d where d.id = ${p.drop_id}),'{}'::jsonb) || coalesce(k.custom,'{}'::jsonb)
         where k.id = ${p.keep_id}`);
      await tx.execute(sql`delete from projects where id = ${p.drop_id} and org_id = ${O}`);
    });
    moved++;
  }
  const left: any = await db.execute(sql`select count(*)::int n from projects where org_id = ${O}`);
  console.log(`merged ${moved} | projects now ${left.rows[0].n}`);
  process.exit(0);
})();
