import { db } from './engine/src/db.ts'
import { sql } from 'drizzle-orm'
try {
  await db.execute(sql`create extension if not exists pg_trgm`)
  console.log('created ok')
} catch (e) { console.error('ERR:', (e as any).code, '-', (e as Error).message) }
// is it maybe already installed?
try {
  const r = await db.execute(sql`select extname from pg_extension where extname in ('pg_trgm','fuzzystrmatch','unaccent')`) as any
  console.log('installed extensions:', r.rows)
  const avail = await db.execute(sql`select name, default_version, installed_version from pg_available_extensions where name='pg_trgm'`) as any
  console.log('available:', avail.rows)
  const who = await db.execute(sql`select current_user, (select rolsuper from pg_roles where rolname=current_user) as super`) as any
  console.log('role:', who.rows[0])
} catch(e){ console.error('probe err', (e as Error).message) }
process.exit(0)
