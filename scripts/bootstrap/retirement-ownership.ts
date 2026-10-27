import pg from "pg";
import { pool, env } from "@openbooks/engine/platform/db";

/** Keep private maintenance authority outside business-object ownership.
 * Automatic provisioning applies only to empty privileged installations. */
export async function ensureRetirementAuthorityOwnership(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const present = (
      await client.query<{ present: boolean }>(`select
      to_regclass('public.orgs') is not null and to_regclass('tenant_retirement.runs') is not null as present`)
    ).rows[0];
    if (!present?.present) {
      await client.query("commit");
      return;
    }
    const state = (
      await client.query<{
        isolated: boolean;
        empty: boolean;
        creator: boolean;
        privileged: boolean;
        owner: string;
        database_owner: string;
      }>(`select not pg_has_role(business.relowner,authority.relowner,'MEMBER') as isolated,
      not exists(select 1 from public.orgs) as empty,
      authority.relowner=(select oid from pg_roles where rolname=current_user) as creator,
      (select rolsuper from pg_roles where rolname=session_user) as privileged,
      business.relowner::regrole::text as owner,
      (select r.rolname from pg_database d join pg_roles r on r.oid=d.datdba where d.datname=current_database()) as database_owner
      from pg_class business cross join pg_class authority
      where business.oid='public.orgs'::regclass and authority.oid='tenant_retirement.runs'::regclass`)
    ).rows[0];
    if (!state) throw new Error("Retirement authority ownership cannot be resolved");
    const hostManaged = env.OPENBOOKS_PRECREATED_ROLES === "1";
    // A host-managed installation's business owner is the database owner the
    // host provisioned; a fresh one has not yet received its objects.
    const roleName = hostManaged
      ? state.isolated
        ? state.owner
        : state.database_owner
      : "openbooks_schema_owner";
    const quotedOwner = pg.escapeIdentifier(roleName);
    if (state.isolated && state.owner !== roleName) {
      await client.query("commit");
      return;
    }
    if (!state.isolated && (!state.empty || !state.creator || !state.privileged)) {
      throw new Error(
        "Retirement authority requires a separate business schema owner. Preserve this installation and obtain database-owner reconciliation; automatic ownership provisioning is limited to an empty installation created by this privileged login.",
      );
    }
    const role = (
      await client.query<{ safe: boolean }>(
        `select ($2::boolean or (not rolcanlogin and not rolinherit)) and not rolsuper
      and not rolbypassrls and not rolcreatedb and not rolcreaterole and not rolreplication
      and ($2::boolean or not exists(select 1 from pg_auth_members where roleid=pg_roles.oid)) as safe
      from pg_roles where rolname=$1`,
        [roleName, hostManaged],
      )
    ).rows[0];
    if (role && !role.safe)
      throw new Error(
        "The business schema owner has incompatible attributes or memberships; preserve it and obtain database-owner reconciliation.",
      );
    if (!state.isolated) {
      await client.query("set local lock_timeout='5s'");
      await client.query("lock table public.orgs in share row exclusive mode");
      if (
        (
          await client.query<{ populated: boolean }>(
            "select exists(select 1 from public.orgs) as populated",
          )
        ).rows[0]?.populated
      ) {
        throw new Error(
          "An organization appeared during fresh ownership provisioning; preserve the installation and reconcile its ownership through the database owner.",
        );
      }
    }
    if (!role) {
      if (hostManaged)
        throw new Error(
          "The host-managed business owner is missing; preserve the installation and ask its database owner to reconcile provisioning",
        );
      await client.query(
        "create role openbooks_schema_owner nologin nosuperuser nobypassrls nocreatedb nocreaterole noreplication noinherit",
      );
    }
    // Use the same catalog-driven business ownership boundary as native test
    // provisioning. Private authority stays untouched. The bypass predicate
    // recognizes the installer by ownership, so it passes to the business
    // owner (never the runtime role, which owns nothing) and later bootstraps
    // that run as that owner keep their installation-wide context. Only a
    // privileged session can reassign it from the maintenance login.
    const objects = await client.query<{ statement: string }>(
      `select
      (case c.relkind when 'v' then 'alter view ' when 'm' then 'alter materialized view '
        when 'S' then 'alter sequence ' when 'f' then 'alter foreign table ' else 'alter table ' end)
      ||format('%I.%I',n.nspname,c.relname)||' owner to '||quote_ident($1::text) as statement
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','openbooks_query') and c.relkind in ('r','p','v','m','S','f')
        and c.relowner<>(select oid from pg_roles where rolname=$1)
        and not exists(select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')
        and not(c.relkind='S' and exists(select 1 from pg_depend d
          where d.classid='pg_class'::regclass and d.objid=c.oid
            and d.refclassid='pg_class'::regclass and d.deptype in ('a','i')))
      union all select 'alter function '||p.oid::regprocedure::text||' owner to '||quote_ident($1::text)
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','openbooks_query') and p.proowner<>(select oid from pg_roles where rolname=$1)
        and not(n.nspname='public' and p.proname='app_bypass_rls_active' and not $2::boolean)
        and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')`,
      [roleName, state.privileged],
    );
    for (const row of objects.rows) await client.query(row.statement);
    await client.query(`alter schema public owner to ${quotedOwner}`);
    // The query catalog refresh recreates its schema as the business owner,
    // which constrained deployments permit through database ownership.
    const grant = (
      await client.query<{ statement: string }>(
        "select format('grant create on database %I to %I', current_database(), $1::text) as statement",
        [roleName],
      )
    ).rows[0]!.statement;
    await client.query(grant);
    if (
      (
        await client.query<{ present: boolean }>(
          "select to_regnamespace('openbooks_query') is not null as present",
        )
      ).rows[0]?.present
    ) {
      await client.query(`alter schema openbooks_query owner to ${quotedOwner}`);
    }
    const proof = (
      await client.query<{ isolated: boolean }>(`select
      not pg_has_role(b.relowner,a.relowner,'MEMBER') as isolated from pg_class b cross join pg_class a
      where b.oid='public.orgs'::regclass and a.oid='tenant_retirement.runs'::regclass`)
    ).rows[0];
    if (!proof?.isolated)
      throw new Error("Fresh ownership provisioning did not isolate maintenance authority");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
