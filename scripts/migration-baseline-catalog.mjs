/** Catalog evidence for a migration cut. SQL bodies are compared byte for byte. */
import { createHash } from "node:crypto";

export const BASELINE_REGISTRIES = Object.freeze({
  currencies: ["code", "name", "minor_units"],
  // The singleton must exist; installation-owned settings are never exported
  // or compared to a fresh installation during adoption.
  platform_settings: ["id"],
  openbooks_query_catalog_relations: ["relation", "added_in"],
  openbooks_document_close_modules: ["kind", "close_module", "added_in"],
});

export const baselineDigest = (value) => createHash("sha256").update(value).digest("hex");

// Object OIDs, owners, runtime-login grants and creation timestamps are
// installation-specific. Definitions, PUBLIC/read access, security attributes
// and registry membership must survive the cut unchanged.
export async function baselineCatalog(client) {
  const scope = "n.nspname in ('public', 'openbooks_query')";
  const queries = {
    relations: `select n.nspname as schema, c.relname as name, c.relkind as kind,
      c.relrowsecurity as rls, c.relforcerowsecurity as force_rls, c.reloptions as options,
      case when c.relkind in ('v','m') then pg_get_viewdef(c.oid, false) end as view
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where ${scope}
      and c.relkind not in ('i','I')
      and c.relname not in ('_applied_migrations','_applied_migration_baselines')
      and c.oid not in (select indexrelid from pg_index where indrelid in
        (coalesce(to_regclass('public._applied_migrations'),0::oid),coalesce(to_regclass('public._applied_migration_baselines'),0::oid)))
      order by n.nspname,c.relname`,
    columns: `select n.nspname as schema,c.relname as relation,a.attname as name,
      format_type(a.atttypid,a.atttypmod) as type,a.attnotnull as not_null,
      a.attidentity as identity,a.attgenerated as generated,a.attcollation::regcollation::text as collation,
      pg_get_expr(d.adbin,d.adrelid) as default
      from pg_attribute a join pg_class c on c.oid=a.attrelid
      join pg_namespace n on n.oid=c.relnamespace
      left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where ${scope} and c.relkind in ('r','p','v','m') and c.relname not in ('_applied_migrations','_applied_migration_baselines')
      and a.attnum>0 and not a.attisdropped order by n.nspname,c.relname,a.attname`,
    constraints: `select n.nspname as schema,c.conname as name,
      c.conrelid::regclass::text as relation,c.contype as type,c.convalidated as validated,
      c.condeferrable as deferrable,c.condeferred as deferred,
      pg_get_constraintdef(c.oid,true) as definition
      from pg_constraint c join pg_namespace n on n.oid=c.connamespace where ${scope}
      and c.conrelid <> coalesce(to_regclass('public._applied_migrations'),0::oid)
      and c.conrelid <> coalesce(to_regclass('public._applied_migration_baselines'),0::oid)
      order by n.nspname,c.conrelid::regclass::text,c.conname`,
    indexes: `select n.nspname as schema,c.relname as name,pg_get_indexdef(c.oid) as definition,
      i.indisvalid as valid,i.indisready as ready
      from pg_index i join pg_class c on c.oid=i.indexrelid
      join pg_namespace n on n.oid=c.relnamespace where ${scope}
      and i.indrelid <> coalesce(to_regclass('public._applied_migrations'),0::oid)
      and i.indrelid <> coalesce(to_regclass('public._applied_migration_baselines'),0::oid)
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
      from pg_policies where schemaname in ('public','openbooks_query')
      order by schemaname,tablename,policyname`,
    enums: `select n.nspname as schema,t.typname as name,e.enumlabel as label
      from pg_enum e join pg_type t on t.oid=e.enumtypid
      join pg_namespace n on n.oid=t.typnamespace where ${scope}
      order by n.nspname,t.typname,e.enumsortorder`,
    sequences: `select schemaname,sequencename,data_type,start_value,min_value,max_value,
      increment_by,cycle,cache_size from pg_sequences where schemaname in ('public','openbooks_query')
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
      and c.relname not in ('_applied_migrations','_applied_migration_baselines') order by 1,2,3,4,5`,
  };
  const catalog = {};
  await client.query("set search_path = public, pg_catalog");
  await client.query("set timezone = 'UTC'");
  for (const [section, query] of Object.entries(queries)) catalog[section] = (await client.query(query)).rows;
  for (const [table, columns] of Object.entries(BASELINE_REGISTRIES)) {
    catalog[table] = (await client.query(`select ${columns.join(",")} from public.${table} order by ${columns[0]}`)).rows;
  }
  return catalog;
}

export function assertBaselineCatalogsEqual(expected, actual) {
  const sections = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const optionalUnavailable = expected.extensions?.some((row) => row.name === "pg_trgm")
    && !actual.extensions?.some((row) => row.name === "pg_trgm");
  for (const section of sections) {
    const comparable = (rows) => section === "relations"
      ? rows?.map((row) => normalizeGeneratedQueryView(row, expected.openbooks_query_catalog_relations ?? []))
      : section === "extensions" && optionalUnavailable
      ? rows?.filter((row) => row.name !== "pg_trgm")
      : section === "indexes" && optionalUnavailable
        ? rows?.filter((row) => !/\b(?:gin|gist)_trgm_ops\b/.test(row.definition)) : rows;
    if (JSON.stringify(comparable(expected[section])) !== JSON.stringify(comparable(actual[section]))) {
      throw new Error(`baseline catalog differs in ${section}; inspect the replay and fresh catalog evidence before cutting the release`);
    }
  }
}

export function baselineRegistrySql(catalog) {
  const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
  return Object.entries(BASELINE_REGISTRIES).map(([table, columns]) => {
    if (!catalog[table]?.length) throw new Error(`baseline system registry is empty: ${table}`);
    return `INSERT INTO public.${table} (${columns.join(", ")}) VALUES\n`
      + catalog[table].map((row) => `  (${columns.map((column) => literal(row[column])).join(", ")})`).join(",\n") + ";\n";
  }).join("\n");
}

/** Generic query projections depend on physical column order, not financial meaning. */
export function normalizeGeneratedQueryView(row, registry) {
  if (row.schema !== "openbooks_query" || row.kind !== "v" || !registry.some((entry) => entry.relation === row.name)) return row;
  const match = /^ SELECT ([a-z_][a-z0-9_]*(?:,\n    [a-z_][a-z0-9_]*)*)\n(   FROM [\s\S]+)$/.exec(row.view ?? "");
  if (!match) return row;
  return { ...row, view: ` SELECT ${match[1].split(/,\n    /).sort().join(",\n    ")}\n${match[2]}` };
}
