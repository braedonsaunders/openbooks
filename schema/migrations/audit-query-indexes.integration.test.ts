import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import pg from 'pg'
import { executeMigrationBody, migrationRunsWithoutTransaction } from '../../scripts/bootstrap-migration-client'

test('audit indexes build concurrently and resume without duplicate or invalid indexes', {
  skip: !process.env.OPENBOOKS_TEST_ADMIN_DB_URL,
}, async () => {
  const url = process.env.OPENBOOKS_TEST_ADMIN_DB_URL!
  assert.match(new URL(url).pathname, /^\/ob_/, 'index conformance must use a disposable test database')
  const pool = new pg.Pool({ connectionString: url, max: 1 })
  const client = await pool.connect()
  const filename = 'schema/migrations/generated/0468_audit_query_indexes.sql'
  const body = readFileSync(filename, 'utf8')
  assert.equal(migrationRunsWithoutTransaction(body), true)
  try {
    // These names belong only to the migration under test in this scratch database.
    await client.query('drop index if exists public.audit_log_org_at_id, public.audit_log_org_metadata')
    const apply = () => executeMigrationBody(client, body, { transactional: false, filename })
    await apply()
    const read = async () => (await client.query(`
      select c.relname, i.indisvalid, i.indisready, pg_get_indexdef(c.oid) as definition
      from pg_index i join pg_class c on c.oid=i.indexrelid
      where i.indrelid='public.audit_log'::regclass
        and c.relname in ('audit_log_org_at_id','audit_log_org_metadata') order by c.relname
    `)).rows
    const first = await read()
    assert.equal(first.length, 2)
    assert.ok(first.every((index) => index.indisvalid && index.indisready))
    assert.match(first[0].definition, /\(org_id, at DESC, id DESC\)/)
    assert.match(first[1].definition, /\(org_id, table_name, row_id\) INCLUDE \(id, action, actor_id, at\)/)
    await apply()
    assert.deepEqual(await read(), first)
  } finally {
    client.release()
    await pool.end()
  }
})
