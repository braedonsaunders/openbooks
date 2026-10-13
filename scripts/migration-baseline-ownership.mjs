const OWNER = 'openbooks_schema_owner';

/** This plan is used only inside verified, maintenance-mode baseline adoption.
 * It changes ownership, never table contents or private maintenance authority. */
export async function baselineBusinessOwnerPlan(client, runtimeRole) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole) || runtimeRole === OWNER) {
    throw new Error('Business-owner isolation requires the exact constrained runtime login');
  }
  const posture = (await client.query(`select
    (select rolsuper from pg_roles where rolname=session_user) as privileged,
    to_regnamespace('tenant_retirement') is not null as private_authority_present,
    to_regclass('public.orgs') is not null as business_present,
    current_user as operator`)).rows[0];
  if (!posture?.privileged || posture.private_authority_present || !posture.business_present) {
    throw new Error('Business-owner isolation requires a privileged baseline adoption before private authority is created');
  }
  const runtime = (await client.query(`select rolcanlogin and not rolsuper and not rolbypassrls
    and not rolcreatedb and not rolcreaterole and not rolreplication
    and not exists(select 1 from pg_roles dangerous where pg_has_role(pg_roles.oid,dangerous.oid,'MEMBER')
      and (dangerous.rolsuper or dangerous.rolbypassrls or dangerous.rolcreatedb or dangerous.rolcreaterole
        or dangerous.rolreplication or dangerous.rolname in
        ('pg_read_server_files','pg_write_server_files','pg_execute_server_program'))) as safe
    from pg_roles where rolname=$1`,[runtimeRole])).rows[0];
  if (!runtime?.safe) throw new Error('Business-owner isolation requires an existing unprivileged runtime login');
  const role = (await client.query(`select not rolcanlogin and not rolsuper and not rolbypassrls
    and not rolcreatedb and not rolcreaterole and not rolreplication and not rolinherit
    and not exists(select 1 from pg_auth_members where roleid=pg_roles.oid)
    and not exists(select 1 from pg_roles dangerous where pg_has_role(pg_roles.oid,dangerous.oid,'MEMBER')
      and (dangerous.rolsuper or dangerous.rolbypassrls or dangerous.rolcreatedb or dangerous.rolcreaterole
        or dangerous.rolreplication or dangerous.rolname in
        ('pg_read_server_files','pg_write_server_files','pg_execute_server_program'))) as safe
    from pg_roles where rolname=$1`,[OWNER])).rows[0];
  if (role && !role.safe) throw new Error('Business schema owner attributes or incoming memberships require owner reconciliation');
  const objects = (await client.query(`select c.relowner::regrole::text as owner,
    (case c.relkind when 'v' then 'alter view ' when 'm' then 'alter materialized view '
      when 'S' then 'alter sequence ' when 'f' then 'alter foreign table ' else 'alter table ' end)
    ||format('%I.%I',n.nspname,c.relname)||' owner to openbooks_schema_owner' as statement
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','openbooks_query') and c.relkind in ('r','p','v','m','S','f')
      and not(c.relkind='S' and exists(select 1 from pg_depend d where d.classid='pg_class'::regclass
        and d.objid=c.oid and d.refclassid='pg_class'::regclass and d.deptype in ('a','i')))
    union all select p.proowner::regrole::text,
      'alter function '||p.oid::regprocedure::text||' owner to openbooks_schema_owner'
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','openbooks_query') and p.prokind='f'
      and not(n.nspname='public' and p.proname='app_bypass_rls_active')
      and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
    order by statement`)).rows;
  if (!objects.length || objects.length>10000 || objects.some(row => ![posture.operator,OWNER].includes(row.owner))) {
    throw new Error('Business objects have unresolved ownership; preserve their catalog before reconciliation');
  }
  return {owner:OWNER,runtimeRole,createRole:!role,
    previousOwners:[...new Set(objects.map(row=>row.owner))].sort(),objectCount:objects.length,
    statements:objects.filter(row=>row.owner!==OWNER).map(row=>row.statement)};
}

export async function applyBaselineBusinessOwnerPlan(client,plan) {
  if (plan.createRole) await client.query('create role openbooks_schema_owner nologin nosuperuser nobypassrls nocreatedb nocreaterole noreplication noinherit');
  await client.query('lock table public.orgs in share row exclusive mode');
  for (const statement of plan.statements) await client.query(statement);
  await client.query('alter schema public owner to openbooks_schema_owner');
  if ((await client.query("select to_regnamespace('openbooks_query') is not null as present")).rows[0].present) {
    await client.query('alter schema openbooks_query owner to openbooks_schema_owner');
  }
  const grant=(await client.query("select format('grant create on database %I to openbooks_schema_owner',current_database()) as statement")).rows[0].statement;
  await client.query(grant);
  // The definer inherits the runtime's temporary-context rights. The runtime
  // never inherits or assumes business ownership.
  await client.query(`grant "${plan.runtimeRole}" to openbooks_schema_owner with inherit true, set false, admin false`);
  const result=await baselineBusinessOwnerPlan(client,plan.runtimeRole);
  if (result.statements.length || result.previousOwners.some(owner=>owner!==OWNER)) {
    throw new Error('Business ownership isolation did not complete; adoption is rolled back');
  }
  return {owner:result.owner,runtimeRole:result.runtimeRole,previousOwners:plan.previousOwners,
    objectCount:result.objectCount,changedObjects:plan.statements.length};
}
