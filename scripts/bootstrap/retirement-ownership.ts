import { pool } from "../../engine/src/platform/db.ts";

/** Keep private maintenance authority outside business-object ownership.
 * Automatic provisioning applies only to empty privileged installations. */
export async function ensureRetirementAuthorityOwnership(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const present = (await client.query<{ present: boolean }>(`select
      to_regclass('public.orgs') is not null and to_regclass('tenant_retirement.runs') is not null as present`)).rows[0];
    if (!present?.present) { await client.query("commit"); return; }
    const state = (await client.query<{
      isolated: boolean; empty: boolean; creator: boolean; privileged: boolean; owner: string;
    }>(`select not pg_has_role(business.relowner,authority.relowner,'MEMBER') as isolated,
      not exists(select 1 from public.orgs) as empty,
      authority.relowner=(select oid from pg_roles where rolname=current_user) as creator,
      (select rolsuper from pg_roles where rolname=session_user) as privileged,
      business.relowner::regrole::text as owner
      from pg_class business cross join pg_class authority
      where business.oid='public.orgs'::regclass and authority.oid='tenant_retirement.runs'::regclass`)).rows[0];
    if (!state) throw new Error("Retirement authority ownership cannot be resolved");
    const roleName = "openbooks_schema_owner";
    if (state.isolated && state.owner !== roleName) { await client.query("commit"); return; }
    if (!state.isolated && (!state.empty || !state.creator || !state.privileged)) {
      throw new Error("Retirement authority requires a separate business schema owner. Preserve this installation and obtain database-owner reconciliation; automatic ownership provisioning is limited to an empty installation created by this privileged login.");
    }
    const role = (await client.query<{ safe: boolean }>(`select not rolcanlogin and not rolsuper
      and not rolbypassrls and not rolcreatedb and not rolcreaterole and not rolreplication
      and not rolinherit and not exists(select 1 from pg_auth_members where roleid=pg_roles.oid) as safe
      from pg_roles where rolname=$1`, [roleName])).rows[0];
    if (role && !role.safe) throw new Error("The business schema owner has incompatible attributes or memberships; preserve it and obtain database-owner reconciliation.");
    if (!state.isolated) {
      await client.query("set local lock_timeout='5s'");
      await client.query("lock table public.orgs in share row exclusive mode");
      if ((await client.query<{ populated: boolean }>("select exists(select 1 from public.orgs) as populated")).rows[0]?.populated) {
        throw new Error("An organization appeared during fresh ownership provisioning; preserve the installation and reconcile its ownership through the database owner.");
      }
    }
    if (!role) await client.query("create role openbooks_schema_owner nologin nosuperuser nobypassrls nocreatedb nocreaterole noreplication noinherit");
    // Use the same catalog-driven business ownership boundary as native test
    // provisioning. Private authority and the bypass predicate stay untouched.
    const objects = await client.query<{ statement: string }>(`select
      (case c.relkind when 'v' then 'alter view ' when 'm' then 'alter materialized view '
        when 'S' then 'alter sequence ' when 'f' then 'alter foreign table ' else 'alter table ' end)
      ||format('%I.%I',n.nspname,c.relname)||' owner to '||quote_ident($1::text) as statement
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','openbooks_query') and c.relkind in ('r','p','v','m','S','f')
        and c.relowner<>(select oid from pg_roles where rolname=$1)
        and not(c.relkind='S' and exists(select 1 from pg_depend d
          where d.classid='pg_class'::regclass and d.objid=c.oid
            and d.refclassid='pg_class'::regclass and d.deptype in ('a','i')))
      union all select 'alter function '||p.oid::regprocedure::text||' owner to '||quote_ident($1::text)
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','openbooks_query') and p.proowner<>(select oid from pg_roles where rolname=$1)
        and not(n.nspname='public' and p.proname='app_bypass_rls_active')`, [roleName]);
    for (const row of objects.rows) await client.query(row.statement);
    await client.query("alter schema public owner to openbooks_schema_owner");
    if ((await client.query<{ present: boolean }>("select to_regnamespace('openbooks_query') is not null as present")).rows[0]?.present) {
      await client.query("alter schema openbooks_query owner to openbooks_schema_owner");
    }
    const proof = (await client.query<{ isolated: boolean }>(`select
      not pg_has_role(b.relowner,a.relowner,'MEMBER') as isolated from pg_class b cross join pg_class a
      where b.oid='public.orgs'::regclass and a.oid='tenant_retirement.runs'::regclass`)).rows[0];
    if (!proof?.isolated) throw new Error("Fresh ownership provisioning did not isolate maintenance authority");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { client.release(); }
}
