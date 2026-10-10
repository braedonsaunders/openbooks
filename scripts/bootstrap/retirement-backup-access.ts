import type pg from "pg";

/** Provision dump access without transferring ownership or maintenance authority.
 * The caller supplies the configured dedicated BYPASSRLS login, never a fixed
 * installation role. A constrained installer may verify pre-provisioned rights. */
export async function ensureRetirementBackupAccess(client: pg.PoolClient | pg.Client, roleName: string, options: { verifyOnly?: boolean } = {}): Promise<boolean> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(roleName)) throw new Error("Invalid retirement backup role name");
  const role = `"${roleName}"`;
  await client.query(options.verifyOnly ? "begin read only" : "begin");
  try {
    await client.query("set local lock_timeout='5s'");
    const schema = (await client.query<{ present: boolean }>("select to_regnamespace('tenant_retirement') is not null as present")).rows[0];
    if (!schema?.present) { await client.query("commit"); return false; }
    const posture = (await client.query<{ safe: boolean }>(`select rolcanlogin and rolbypassrls and not rolsuper
      and not rolcreatedb and not rolcreaterole and not rolreplication as safe from pg_roles where rolname=$1`, [roleName])).rows[0];
    if (!posture?.safe) throw new Error("Retirement backup requires a dedicated LOGIN NOSUPERUSER BYPASSRLS role without role, database or replication administration");
    const owners = (await client.query<{ name: string; inherited: boolean }>(`with owners(oid) as (
      select nspowner from pg_namespace where nspname='tenant_retirement'
      union select c.relowner from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='tenant_retirement'
      union select p.proowner from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='tenant_retirement'
    ) select r.rolname::text as name,pg_has_role($1,r.oid,'MEMBER') as inherited from owners join pg_roles r using(oid) order by r.rolname`, [roleName])).rows;
    if (!owners.length || owners.some(owner => owner.inherited)) throw new Error("Retirement backup login must not own or belong to any private authority owner role");
    const assertReadOnly = async () => {
      const unsafe = (await client.query<{ unsafe: boolean }>(`select has_schema_privilege($1,'tenant_retirement','CREATE')
        or has_schema_privilege($1,'tenant_retirement','USAGE WITH GRANT OPTION')
        or exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='tenant_retirement'
          and case when c.relkind='S' then has_sequence_privilege($1,c.oid,'USAGE,UPDATE,SELECT WITH GRANT OPTION')
            when c.relkind in ('r','p','v','m','f') then has_table_privilege($1,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,SELECT WITH GRANT OPTION')
              or has_any_column_privilege($1,c.oid,'INSERT,UPDATE,REFERENCES,SELECT WITH GRANT OPTION') else false end)
        or exists(select 1 from pg_default_acl d join pg_namespace n on n.oid=d.defaclnamespace
          cross join lateral aclexplode(d.defaclacl) a where n.nspname='tenant_retirement' and d.defaclobjtype in ('r','S')
          and (case when a.grantee=0 then true else pg_has_role($1,a.grantee,'USAGE') end) and (a.privilege_type<>'SELECT' or a.is_grantable)) as unsafe`, [roleName])).rows[0];
      if (unsafe?.unsafe !== false) throw new Error("Retirement backup login has write, grant-option or schema-create privileges; preserve its grants and obtain database-owner reconciliation");
    };
    await assertReadOnly();
    const missingGrant = () => new Error("Retirement backup SELECT grants are incomplete; before the snapshot, have the private owner or controlled database administrator run: node scripts/bootstrap.mjs --retirement-backup-access-only (OPENBOOKS_DB_URL must be that privileged provisioning connection; preserve the configured runtime and bypass URLs). Then retry --retirement-backup-access-only --verify. Do not exclude tenant_retirement from the backup.");
    if (!(await client.query<{ allowed: boolean }>("select has_schema_privilege($1,'tenant_retirement','USAGE') as allowed", [roleName])).rows[0]?.allowed) {
      if (options.verifyOnly) throw missingGrant();
      await client.query(`grant usage on schema tenant_retirement to ${role}`);
    }
    const objects = (await client.query<{ statement: string }>(`select 'grant select on '
      ||case when c.relkind='S' then 'sequence ' else 'table ' end||format('%I.%I',n.nspname,c.relname)||' to '||quote_ident($1::text) as statement
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='tenant_retirement' and c.relkind in ('r','p','v','m','f','S')
      and not case when c.relkind='S' then has_sequence_privilege($1,c.oid,'SELECT') else has_table_privilege($1,c.oid,'SELECT') end
      order by c.relname`, [roleName])).rows;
    if (options.verifyOnly && objects.length) throw missingGrant();
    for (const object of objects) await client.query(object.statement);
    // Defaults must name the actual object creators, not the bootstrap login.
    // SELECT on sequences preserves identity state in pg_dump without nextval/setval.
    for (const owner of owners) for (const [kind, objects] of [["r", "tables"], ["S", "sequences"]] as const) {
      const granted = (await client.query<{ allowed: boolean }>(`select exists(select 1 from pg_default_acl d
        join pg_namespace n on n.oid=d.defaclnamespace cross join lateral aclexplode(d.defaclacl) a
        where n.nspname='tenant_retirement' and d.defaclrole=(select oid from pg_roles where rolname=$1)
        and d.defaclobjtype=$2 and a.grantee=(select oid from pg_roles where rolname=$3)
        and a.privilege_type='SELECT' and not a.is_grantable) as allowed`, [owner.name, kind, roleName])).rows[0]?.allowed;
      if (!granted) {
        if (options.verifyOnly) throw missingGrant();
        const quotedOwner = `"${owner.name.replaceAll('"', '""')}"`;
        await client.query(`alter default privileges for role ${quotedOwner} in schema tenant_retirement grant select on ${objects} to ${role}`);
      }
    }
    await assertReadOnly();
    const missing = (await client.query<{ missing: boolean }>(`select exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='tenant_retirement' and c.relkind in ('r','p','v','m','f','S')
      and not case when c.relkind='S' then has_sequence_privilege($1,c.oid,'SELECT') else has_table_privilege($1,c.oid,'SELECT') end) as missing`, [roleName])).rows[0];
    if (missing?.missing !== false) throw missingGrant();
    await client.query("commit");
    return true;
  } catch (error) {
    await client.query("rollback");
    if ((error as { code?: string }).code === "42501") throw new Error("The private retirement owner or a controlled database administrator must provision backup SELECT grants before the pre-migration snapshot; use bootstrap --retirement-backup-access-only with that provisioning connection, then retry the full backup", { cause: error });
    throw error;
  }
}
