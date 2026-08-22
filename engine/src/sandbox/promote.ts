import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, schema, withOrg } from "../db.ts";
import { assertUuid } from "./catalog.ts";

/**
 * Promotion — config flows UP (sandbox → production) as a reviewable change set;
 * business/ledger data never does. A change set diffs the sandbox's
 * customization layer against production and, on approval, applies it to
 * production in one transaction. This is openbooks' native, versioned
 * config-promotion artifact.
 *
 * Scope: self-contained customization tables whose content is jsonb/text (not
 * cross-environment FKs) — scripts, custom fields, forms, saved reports/views,
 * roles, account groups. Identity-bound tables (users, role_assignments) are
 * intentionally excluded.
 */
const PROMOTABLE = [
  "user_scripts",
  "custom_field_defs",
  "form_layouts",
  "list_views",
  "saved_reports",
  "saved_views",
  "statement_layouts",
  "report_definitions",
  "account_groups",
  "app_roles",
];

const STRUCTURAL = new Set(["id", "org_id", "created_at", "updated_at", "created_by", "updated_by"]);

function contentSig(row: Record<string, unknown> | null): string {
  if (!row) return "";
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(row).sort()) if (!STRUCTURAL.has(k)) o[k] = row[k];
  return JSON.stringify(o);
}

export async function buildChangeSet(
  sandboxId: string,
  name: string,
  createdBy?: string | null,
): Promise<{ changeSetId: string; itemCount: number }> {
  const s = (await db.execute(sql`
    select org_id, production_org_id from sandboxes where id = ${sandboxId}`)) as any;
  const row = s.rows[0];
  if (!row) throw new Error(`sandbox not found: ${sandboxId}`);
  const sbx = assertUuid(row.org_id);
  const prod = assertUuid(row.production_org_id);
  const seedRes = (await db.execute(sql`select sandbox_seed from orgs where id = ${row.org_id}`)) as any;
  const seed = assertUuid(seedRes.rows[0].sandbox_seed);

  const [cs] = await db
    .insert(schema.changeSets)
    .values({ orgId: prod, sandboxOrgId: sbx, name, status: "draft", createdBy: createdBy ?? null })
    .returning({ id: schema.changeSets.id });

  // Which promotable tables actually exist and carry org_id + id.
  const present = (await db.execute(sql`
    select table_name from information_schema.columns
     where table_schema = 'public' and column_name = 'org_id'
       and table_name = any(${PROMOTABLE})`)) as any;
  const tables = present.rows.map((r: any) => r.table_name);

  let itemCount = 0;
  for (const t of tables) {
    // Inserts + updates: every sandbox row, matched to its production origin.
    const diff = (await db.execute(sql.raw(`
      select s.id as sbx_id, p.id as prod_id, row_to_json(s) as sbx_row, row_to_json(p) as prod_row
        from "${t}" s
        left join "${t}" p on p.org_id = '${prod}' and ob_rebase(p.id, '${seed}') = s.id
       where s.org_id = '${sbx}'`))) as any;
    for (const d of diff.rows as any[]) {
      if (contentSig(d.sbx_row) === contentSig(d.prod_row)) continue; // unchanged
      const targetId = d.prod_id ?? randomUUID();
      const payload = { ...d.sbx_row, id: targetId, org_id: prod, created_by: null, updated_by: null };
      await db.insert(schema.changeSetItems).values({
        orgId: prod,
        changeSetId: cs.id,
        tableName: t,
        targetId,
        op: d.prod_id ? "update" : "insert",
        payload,
      });
      itemCount++;
    }
    // Deletes: production rows with no sandbox counterpart.
    const dels = (await db.execute(sql.raw(`
      select p.id from "${t}" p
       where p.org_id = '${prod}'
         and not exists (select 1 from "${t}" s where s.org_id = '${sbx}' and s.id = ob_rebase(p.id, '${seed}'))`))) as any;
    for (const dr of dels.rows as any[]) {
      await db.insert(schema.changeSetItems).values({
        orgId: prod,
        changeSetId: cs.id,
        tableName: t,
        targetId: dr.id,
        op: "delete",
        payload: null,
      });
      itemCount++;
    }
  }
  return { changeSetId: cs.id, itemCount };
}

/** Apply a draft change set to production in one transaction. */
export async function applyChangeSet(changeSetId: string): Promise<void> {
  const cs = (await db.execute(sql`select org_id, status from change_sets where id = ${changeSetId}`)) as any;
  const c = cs.rows[0];
  if (!c) throw new Error(`change set not found: ${changeSetId}`);
  if (c.status !== "draft") throw new Error(`change set is ${c.status}, not draft`);
  const prod = assertUuid(c.org_id);

  const items = (await db.execute(sql`
    select table_name, target_id, op, payload from change_set_items
     where change_set_id = ${changeSetId} and org_id = ${prod} order by created_at`)) as any;

  await withOrg(prod, async () => {
    for (const it of items.rows as any[]) {
      const t = it.table_name as string;
      const target = assertUuid(it.target_id);
      if (it.op === "delete") {
        await db.execute(sql.raw(`delete from "${t}" where id = '${target}' and org_id = '${prod}'`));
        continue;
      }
      // update = delete-then-insert (idempotent); insert = plain insert.
      await db.execute(sql.raw(`delete from "${t}" where id = '${target}' and org_id = '${prod}'`));
      await db.execute(
        sql`insert into ${sql.raw(`"${t}"`)} select * from jsonb_populate_record(null::${sql.raw(`"${t}"`)}, ${JSON.stringify(it.payload)}::jsonb)`,
      );
    }
    await db.execute(sql`update change_sets set status = 'applied', applied_at = now() where id = ${changeSetId} and org_id = ${prod}`);
  });
}
