import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import pg from 'pg'
import { executeMigrationBody, migrationRunsWithoutTransaction } from '../../scripts/bootstrap-migration-client'

test('audit indexes build concurrently and resume without duplicate or invalid indexes', {
  skip: !process.env.OPENBOOKS_TEST_ADMIN_DB_URL,
}, async () => {
  const url = process.env.OPENBOOKS_TEST_ADMIN_DB_URL!
  const control = new pg.Client({ connectionString: url })
  await control.connect()
  const database = `ob_audit_indexes_${randomBytes(8).toString('hex')}`
  const scratchUrl = new URL(url)
  scratchUrl.pathname = `/${database}`
  await control.query(`create database "${database}"`)
  const client = new pg.Client({ connectionString: scratchUrl.href })
  const filename = 'schema/migrations/generated/0468_audit_query_indexes.sql'
  const body = readFileSync(filename, 'utf8')
  assert.equal(migrationRunsWithoutTransaction(body), true)
  try {
    await client.connect()
    await client.query(`create table public.audit_log (
      id uuid primary key, org_id uuid not null, at timestamptz not null,
      table_name text, row_id uuid, action text, actor_id uuid
    )`)
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
    await client.end()
    try { await control.query(`drop database "${database}" with (force)`) }
    finally { await control.end() }
  }
})
