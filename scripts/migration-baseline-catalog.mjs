/** Catalog evidence for a migration cut. SQL bodies are compared byte for byte. */
import { createHash } from "node:crypto";

export const BASELINE_REGISTRIES = Object.freeze({
  currencies: ["code", "name", "minor_units"],
  // The singleton must exist; installation-owned settings are never exported
  // or compared to a fresh installation during adoption.
  platform_settings: ["id"],
  openbooks_query_catalog_relations: ["relation", "added_in"],
  openbooks_document_close_modules: ["kind", "close_module", "added_in"],
  openbooks_schedule_board_types: ["key", "row_kind", "capabilities", "added_in"],
  marketplace_nexus_state_rules: ["state", "include_in_threshold", "needs_review", "source"],
});

/** Installation migration evidence. It records how one database reached its
 * schema and is never application schema, dump content or catalog evidence. */
export const MIGRATION_LEDGER_TABLES = Object.freeze([
  "_applied_migrations",
  "_applied_migration_baselines",
  "_migration_execution_corrections",
]);
const ledgerNames = MIGRATION_LEDGER_TABLES.map((name) => `'${name}'`).join(",");
const ledgerOids = MIGRATION_LEDGER_TABLES.map(
  (name) => `coalesce(to_regclass('public.${name}'),0::oid)`,
).join(",");

export const baselineDigest = (value) => createHash("sha256").update(value).digest("hex");

/** Application schemas, including the maintenance-owned private authority. */
const APPLICATION_SCHEMAS = "'public', 'openbooks_query', 'tenant_retirement'";

/** PostgreSQL system functions whose EXECUTE access differs from PUBLIC
 * defaults. Query-console hardening withholds administrative functions from
 * the read role; that access is part of the release schema. */
const CATALOG_FUNCTION_PRIVILEGES = `select p.proname as name,
    pg_get_function_identity_arguments(p.oid) as arguments,
    has_function_privilege('public', p.oid, 'EXECUTE') as public_execute,
    case when to_regrole('openbooks_read') is null then null
      else has_function_privilege('openbooks_read', p.oid, 'EXECUTE') end as read_execute
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='pg_catalog' and not (has_function_privilege('public', p.oid, 'EXECUTE')
    and (to_regrole('openbooks_read') is null or has_function_privilege('openbooks_read', p.oid, 'EXECUTE')))
  order by 1,2`;

// Object OIDs, owners, runtime-login grants and creation timestamps are
// installation-specific. Definitions, PUBLIC/read access, security attributes
// and registry membership must survive the cut unchanged.
export async function baselineCatalog(client) {
  const scope = `n.nspname in (${APPLICATION_SCHEMAS})`;
  const queries = {
    relations: `select n.nspname as schema, c.relname as name, c.relkind as kind,
      c.relrowsecurity as rls, c.relforcerowsecurity as force_rls, c.reloptions as options,
      case when c.relkind in ('v','m') then pg_get_viewdef(c.oid, false) end as view
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where ${scope}
      and c.relkind not in ('i','I')
      and c.relname not in (${ledgerNames})
      and c.oid not in (select indexrelid from pg_index where indrelid in (${ledgerOids}))
      order by n.nspname,c.relname`,
    columns: `select n.nspname as schema,c.relname as relation,a.attname as name,
      format_type(a.atttypid,a.atttypmod) as type,a.attnotnull as not_null,
      a.attidentity as identity,a.attgenerated as generated,a.attcollation::regcollation::text as collation,
      pg_get_expr(d.adbin,d.adrelid) as default
      from pg_attribute a join pg_class c on c.oid=a.attrelid
      join pg_namespace n on n.oid=c.relnamespace
      left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where ${scope} and c.relkind in ('r','p','v','m') and c.relname not in (${ledgerNames})
      and a.attnum>0 and not a.attisdropped order by n.nspname,c.relname,a.attname`,
    constraints: `select n.nspname as schema,c.conname as name,
      c.conrelid::regclass::text as relation,c.contype as type,c.convalidated as validated,
      c.condeferrable as deferrable,c.condeferred as deferred,
      pg_get_constraintdef(c.oid,true) as definition
      from pg_constraint c join pg_namespace n on n.oid=c.connamespace where ${scope}
      and c.conrelid not in (${ledgerOids})
      order by n.nspname,c.conrelid::regclass::text,c.conname`,
    indexes: `select n.nspname as schema,c.relname as name,pg_get_indexdef(c.oid) as definition,
      i.indisvalid as valid,i.indisready as ready
      from pg_index i join pg_class c on c.oid=i.indexrelid
      join pg_namespace n on n.oid=c.relnamespace where ${scope}
      and i.indrelid not in (${ledgerOids})
      order by n.nspname,c.relname`,
    functions: `select n.nspname as schema,p.proname as name,
      pg_get_function_identity_arguments(p.oid) as arguments,pg_get_functiondef(p.oid) as definition
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where ${scope}
      and not exists (select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
      and p.prokind <> 'a' order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)`,
    triggers: `select n.nspname as schema,c.relname as relation,t.tgname as name,
      t.tgenabled as enabled,pg_get_triggerdef(t.oid,false) as definition
      from pg_trigger t join pg_class c on c.oid=t.tgrelid
      join pg_namespace n on n.oid=c.relnamespace where ${scope} and not t.tgisinternal
      order by n.nspname,c.relname,t.tgname`,
    policies: `select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
      from pg_policies where schemaname in (${APPLICATION_SCHEMAS})
      order by schemaname,tablename,policyname`,
    enums: `select n.nspname as schema,t.typname as name,e.enumlabel as label
      from pg_enum e join pg_type t on t.oid=e.enumtypid
      join pg_namespace n on n.oid=t.typnamespace where ${scope}
      order by n.nspname,t.typname,e.enumsortorder`,
    sequences: `select schemaname,sequencename,data_type,start_value,min_value,max_value,
      increment_by,cycle,cache_size from pg_sequences where schemaname in (${APPLICATION_SCHEMAS})
      order by schemaname,sequencename`,
    function_acl: `select n.nspname as schema,p.proname as name,
      pg_get_function_identity_arguments(p.oid) as arguments,
      case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
      a.privilege_type,a.is_grantable from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      cross join lateral aclexplode(coalesce(p.proacl,acldefault('f'::"char",p.proowner))) a
      where ${scope} and (a.grantee=0 or pg_get_userbyid(a.grantee)='openbooks_read')
      and not exists (select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
      order by 1,2,3,4,5,6`,
    extensions: `select e.extname as name,e.extversion as version,n.nspname as schema
      from pg_extension e join pg_namespace n on n.oid=e.extnamespace
      where e.extname <> 'plpgsql' order by e.extname`,
    schema_acl: `select n.nspname as schema,
      case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
      a.privilege_type,a.is_grantable from pg_namespace n
      cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n'::"char",n.nspowner))) a
      where ${scope} and (a.grantee=0 or pg_get_userbyid(a.grantee)='openbooks_read') order by 1,2,3,4`,
    acl: `select n.nspname as schema,c.relname as name,
      case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
      a.privilege_type,a.is_grantable
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      cross join lateral aclexplode(coalesce(c.relacl,acldefault(case when c.relkind='S' then 'S'::"char" else 'r'::"char" end,c.relowner))) a
      where ${scope} and (a.grantee=0 or pg_get_userbyid(a.grantee)='openbooks_read')
      and c.relname not in (${ledgerNames}) order by 1,2,3,4,5`,
    catalog_function_privileges: CATALOG_FUNCTION_PRIVILEGES,
  };
  const catalog = {};
  await client.query("set search_path = public, pg_catalog");
  await client.query("set timezone = 'UTC'");
  for (const [section, query] of Object.entries(queries))
    catalog[section] = (await client.query(query)).rows;
  for (const [table, columns] of Object.entries(BASELINE_REGISTRIES)) {
    catalog[table] = (
      await client.query(`select ${columns.join(",")} from public.${table} order by ${columns[0]}`)
    ).rows;
  }
  return catalog;
}

export function assertBaselineCatalogsEqual(expected, actual) {
  const sections = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const optionalUnavailable =
    expected.extensions?.some((row) => row.name === "pg_trgm") &&
    !actual.extensions?.some((row) => row.name === "pg_trgm");
  const cryptoUuidEquivalent =
    expected.extensions?.some((row) => row.name === "pgcrypto") &&
    actual.extensions?.some((row) => row.name === "pgcrypto");
  for (const section of sections) {
    const comparable = (rows) =>
      section === "relations"
        ? rows?.map((row) =>
            normalizeGeneratedQueryView(row, expected.openbooks_query_catalog_relations ?? []),
          )
        : section === "columns" && cryptoUuidEquivalent
          ? // PostgreSQL's built-in and pgcrypto UUID generators both produce v4
            // UUIDs. Their qualification differs with the creating search path.
            rows?.map((row) =>
              row.type === "uuid" &&
              /^(?:pg_catalog\.)?gen_random_uuid\(\)$/.test(row.default ?? "")
                ? { ...row, default: "gen_random_uuid()" }
                : row,
            )
          : section === "schema_acl"
            ? rows?.filter(
                (row) =>
                  !(
                    row.grantee === "openbooks_read" &&
                    row.privilege_type === "USAGE" &&
                    !row.is_grantable &&
                    rows.some(
                      (grant) =>
                        grant.schema === row.schema &&
                        grant.grantee === "PUBLIC" &&
                        grant.privilege_type === "USAGE",
                    )
                  ),
              )
            : section === "extensions" && optionalUnavailable
              ? rows?.filter((row) => row.name !== "pg_trgm")
              : section === "indexes" && optionalUnavailable
                ? rows?.filter((row) => !/\b(?:gin|gist)_trgm_ops\b/.test(row.definition))
                : rows;
    const ordered = (rows) =>
      ["schema_acl", "function_acl", "acl"].includes(section)
        ? rows?.toSorted((left, right) => {
            const a = JSON.stringify(left),
              b = JSON.stringify(right);
            return a < b ? -1 : a > b ? 1 : 0;
          })
        : rows;
    if (
      JSON.stringify(ordered(comparable(expected[section]))) !==
      JSON.stringify(ordered(comparable(actual[section])))
    ) {
      throw new Error(
        `baseline catalog differs in ${section}; inspect the replay and fresh catalog evidence before cutting the release`,
      );
    }
  }
}

/**
 * Statements reproducing this installation's changes to PostgreSQL system
 * function privileges, derived against the server's initial privileges.
 * Grants to installation-specific logins are refused: only PUBLIC and the
 * read role are release schema.
 */
export async function catalogPrivilegeSql(client) {
  const rows = (
    await client.query(`with current_acl as (
      select p.oid, a.grantee, a.privilege_type from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where n.nspname='pg_catalog' and a.grantee <> p.proowner),
    initial_acl as (
      select p.oid, a.grantee, a.privilege_type from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      left join pg_init_privs i on i.objoid=p.oid and i.classoid='pg_proc'::regclass and i.objsubid=0
      cross join lateral aclexplode(coalesce(i.initprivs, acldefault('f', p.proowner))) a
      where n.nspname='pg_catalog' and a.grantee <> p.proowner),
    changes as (
      select 'REVOKE' as action, * from (select * from initial_acl except select * from current_acl) revoked
      union all select 'GRANT', * from (select * from current_acl except select * from initial_acl) granted)
    select c.action, c.privilege_type, format('pg_catalog.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid)) as function,
      case when c.grantee=0 then 'PUBLIC' else pg_get_userbyid(c.grantee) end as grantee
    from changes c join pg_proc p on p.oid=c.oid order by 3,1,4,2`)
  ).rows;
  return rows
    .map((row) => {
      if (row.grantee !== "PUBLIC" && row.grantee !== "openbooks_read")
        throw new Error(
          `system function privilege for installation login ${row.grantee} cannot enter a release baseline: ${row.function}`,
        );
      return row.action === "REVOKE"
        ? `REVOKE ${row.privilege_type} ON FUNCTION ${row.function} FROM ${row.grantee};`
        : `GRANT ${row.privilege_type} ON FUNCTION ${row.function} TO ${row.grantee};`;
    })
    .join("\n");
}

export function baselineRegistrySql(catalog) {
  const quote = (text) => `'${text.replaceAll("'", "''")}'`;
  const literal = (value) => {
    if (value === null || value === undefined) return "NULL";
    if (Array.isArray(value))
      return quote(
        `{${value.map((item) => `"${String(item).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`,
      );
    return quote(String(value));
  };
  return Object.entries(BASELINE_REGISTRIES)
    .map(([table, columns]) => {
      if (!catalog[table]?.length) throw new Error(`baseline system registry is empty: ${table}`);
      return (
        `INSERT INTO public.${table} (${columns.join(", ")}) VALUES\n` +
        catalog[table]
          .map((row) => `  (${columns.map((column) => literal(row[column])).join(", ")})`)
          .join(",\n") +
        ";\n"
      );
    })
    .join("\n");
}

/** Generic query projections depend on physical column order, not financial meaning. */
export function normalizeGeneratedQueryView(row, registry) {
  if (
    row.schema !== "openbooks_query" ||
    row.kind !== "v" ||
    !registry.some((entry) => entry.relation === row.name)
  )
    return row;
  const match = /^ SELECT ([a-z_][a-z0-9_]*(?:,\n    [a-z_][a-z0-9_]*)*)\n(   FROM [\s\S]+)$/.exec(
    row.view ?? "",
  );
  if (!match) return row;
  return {
    ...row,
    view: ` SELECT ${match[1]
      .split(/,\n    /)
      .sort()
      .join(",\n    ")}\n${match[2]}`,
  };
}
