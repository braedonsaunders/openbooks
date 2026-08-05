import { sql } from "drizzle-orm";
import { db, pool } from "../engine/src/db.ts";

async function rows(query: ReturnType<typeof sql>): Promise<unknown[]> {
  return (await db.execute(query) as unknown as { rows: unknown[] }).rows;
}

async function main(): Promise<void> {
  const snapshot = {
    relations: await rows(sql`
      select c.relname as relation, c.relkind as kind,
             c.relrowsecurity as row_level_security,
             c.relforcerowsecurity as force_row_level_security
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind in ('r', 'p', 'v', 'm', 'S')
       order by c.relname
    `),
    columns: await rows(sql`
      select c.relname as relation, a.attnum as position, a.attname as column,
             format_type(a.atttypid, a.atttypmod) as data_type,
             a.attnotnull as not_null,
             a.attidentity as identity_kind,
             a.attgenerated as generated_kind,
             pg_get_expr(d.adbin, d.adrelid) as default_expression
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
        left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
       where n.nspname = 'public'
         and c.relkind in ('r', 'p', 'v', 'm')
         and a.attnum > 0
         and not a.attisdropped
       order by c.relname, a.attnum
    `),
    constraints: await rows(sql`
      select coalesce(c.conrelid::regclass::text, '') as relation,
             c.conname as constraint, c.contype as type,
             c.condeferrable as deferrable, c.condeferred as initially_deferred,
             c.convalidated as validated,
             pg_get_constraintdef(c.oid, true) as definition
        from pg_constraint c
        join pg_namespace n on n.oid = c.connamespace
       where n.nspname = 'public'
       order by coalesce(c.conrelid::regclass::text, ''), c.conname
    `),
    indexes: await rows(sql`
      select tablename as table_name, indexname as index,
             regexp_replace(indexdef, ' TABLESPACE [^ ]+$', '') as definition
        from pg_indexes
       where schemaname = 'public'
       order by tablename, indexname
    `),
    triggers: await rows(sql`
      select c.relname as relation, t.tgname as trigger,
             pg_get_triggerdef(t.oid, true) as definition
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and not t.tgisinternal
       order by c.relname, t.tgname
    `),
    functions: await rows(sql`
      select p.proname as function,
             pg_get_function_identity_arguments(p.oid) as arguments,
             pg_get_functiondef(p.oid) as definition
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
       order by p.proname, pg_get_function_identity_arguments(p.oid)
    `),
    policies: await rows(sql`
      select schemaname, tablename, policyname, permissive, roles, cmd,
             qual, with_check
        from pg_policies
       where schemaname = 'public'
       order by tablename, policyname
    `),
  };
  console.log(JSON.stringify(snapshot));
}

void (async () => {
  try {
    await main();
  } finally {
    await pool.end();
  }
})();
