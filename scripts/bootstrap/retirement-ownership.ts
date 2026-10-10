import { pool } from "../../engine/src/platform/db.ts";

/** Fresh installations keep maintenance authority independent of business
 * table ownership. Existing installations must already prove that boundary. */
export async function ensureRetirementAuthorityOwnership(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const present = (await client.query<{ present: boolean }>(`select
      to_regclass('public.orgs') is not null and to_regclass('tenant_retirement.runs') is not null as present`)).rows[0];
    if (!present?.present) {
      await client.query("commit");
      return;
    }
    const state = (await client.query<{
      isolated: boolean; empty: boolean; creator: boolean; privileged: boolean; owner: string;
    }>(`select
      not pg_has_role(business.relowner, authority.relowner, 'MEMBER') as isolated,
      not exists(select 1 from public.orgs) as empty,
      authority.relowner=(select oid from pg_roles where rolname=current_user) as creator,
      (select rolsuper from pg_roles where rolname=session_user) as privileged,
      authority.relowner::regrole::text as owner
      from pg_class business cross join pg_class authority
      where business.oid=to_regclass('public.orgs')
        and authority.oid=to_regclass('tenant_retirement.runs')`)).rows[0];
    const roleName = "openbooks_retirement_owner";
    const role = (await client.query<{ safe: boolean }>(`select
      not rolcanlogin and not rolsuper and rolbypassrls and not rolcreatedb
        and not rolcreaterole and not rolreplication and not rolinherit
        and not exists(select 1 from pg_auth_members where roleid=pg_roles.oid) as safe
      from pg_roles where rolname=$1`, [roleName])).rows[0];
    if (role && !role.safe) throw new Error("The retirement owner role has incompatible attributes or memberships; preserve it and obtain database-owner reconciliation.");
    if (!state || state.isolated) {
      if (state?.owner === "openbooks_retirement_owner") {
        await client.query("grant select on all tables in schema public to openbooks_retirement_owner");
      }
      await client.query("commit");
      return;
    }
    if (!state.empty || !state.creator || !state.privileged) {
      throw new Error("Retirement authority ownership requires a separate maintenance owner. Preserve this installation and obtain database-owner reconciliation; automatic ownership provisioning is limited to an empty fresh installation created by this privileged login.");
    }
    if (!role) await client.query("create role openbooks_retirement_owner nologin nosuperuser bypassrls nocreatedb nocreaterole noreplication noinherit");
    const objects = await client.query<{ statement: string; creator: boolean }>(`select
      format('alter table %I.%I owner to %I', n.nspname,c.relname,$1::text) as statement,
      c.relowner=(select oid from pg_roles where rolname=current_user) as creator
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='tenant_retirement' and c.relkind in ('r','p')
      union all select format('alter function %s owner to %I',p.oid::regprocedure,$1::text),
      p.proowner=(select oid from pg_roles where rolname=current_user)
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='tenant_retirement'`, [roleName]);
    if (!objects.rows.length || objects.rows.some(row => !row.creator)) throw new Error("Fresh retirement authority objects have unexpected ownership; preserve them and reconcile through the database owner.");
    // The definer reads native ownership and work evidence but receives no
    // business-table write grants and cannot be assumed by an application role.
    await client.query("grant usage on schema public to openbooks_retirement_owner");
    await client.query("grant select on all tables in schema public to openbooks_retirement_owner");
    for (const row of objects.rows) await client.query(row.statement);
    await client.query("alter schema tenant_retirement owner to openbooks_retirement_owner");
    const proof = (await client.query<{ isolated: boolean }>(`select
      not pg_has_role(b.relowner,a.relowner,'MEMBER') as isolated
      from pg_class b cross join pg_class a
      where b.oid='public.orgs'::regclass and a.oid='tenant_retirement.runs'::regclass`)).rows[0];
    if (!proof?.isolated) throw new Error("Fresh retirement authority ownership did not establish the required isolation");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
