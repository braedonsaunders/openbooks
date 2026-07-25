/**
 * Data remediation: rate-card scopes left pointing at the SOURCE org.
 *
 * `labor_rate_version_scopes.scope_value_id` is polymorphic — it names no table
 * — so a clone that rebases by inferred target left it holding the production
 * department ids. The scopes then matched nothing in the sandbox, and every
 * multi-department customer resolved an arbitrary card. Repoint them at the
 * sandbox's own departments, matched by name.
 *
 * Usage: npx tsx --conditions=react-server src/validation/fix-scope-refs.ts [--apply]
 */
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
const ORG = process.env.SANDBOX_ORG ?? "6d5799ad-a37c-4aea-9cd4-748e4dc59614";
const APPLY = process.argv.includes("--apply");

const env:any = await db.execute(sql`select env_kind from orgs where id=${ORG}`);
if (env.rows[0]?.env_kind !== "sandbox") throw new Error("refusing: target org is not a sandbox");

const foreign:any = await db.execute(sql`
  select o.name org, o.env_kind, d.name dept, count(*)::int n
    from labor_rate_version_scopes vs join departments d on d.id = vs.scope_value_id
    join orgs o on o.id = d.org_id
   where vs.org_id = ${ORG} and d.org_id <> ${ORG} group by 1,2,3 order by 4 desc`);
console.log("scopes pointing at ANOTHER org's departments:");
console.table(foreign.rows);

if (APPLY) {
  // The department a job's hours actually carry is the one to match, so prefer
  // the record that owns the ledger over any same-named duplicate.
  const r:any = await db.execute(sql`
    update labor_rate_version_scopes vs set scope_value_id = mine.id
      from departments theirs, lateral (
        select d.id from departments d
         where d.org_id = ${ORG} and lower(d.name) = lower(theirs.name)
         order by (select count(*) from time_entries te where te.department_id = d.id) desc, d.created_at
         limit 1) mine
     where vs.org_id = ${ORG} and vs.scope_value_id = theirs.id and theirs.org_id <> ${ORG}`);
  console.log("scopes repointed at this sandbox's departments:", r.rowCount);

  const left:any = await db.execute(sql`
    select count(*)::int n from labor_rate_version_scopes vs
      join departments d on d.id = vs.scope_value_id
     where vs.org_id = ${ORG} and d.org_id <> ${ORG}`);
  console.log("still foreign:", left.rows[0].n);
}
process.exit(0);
