import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { validateCustomQuery } from '@openbooks/reports'
import { assertDedicatedFixtureDatabase, createScratchOrg, createScratchUser, dropScratchOrg } from '../../engine/src/testing/fixtures.ts'
import { withBypass } from '../../engine/src/platform/db.ts'
import { connectMigrationClient, executeMigrationBody, releaseMigrationClient, sanitizeMigrationContent } from '../../scripts/bootstrap-migration-client.ts'

const filename = '0593_saved_view_sort_canonicalization.sql'
const body = sanitizeMigrationContent(readFileSync(new URL(`./generated/${filename}`, import.meta.url), 'utf8'))
const preflight = readFileSync(new URL(`./preflight/${filename}`, import.meta.url), 'utf8')

test('saved-view normalization preserves sort precedence, tenant metadata and edit provenance with atomic audit evidence', async () => {
  await assertDedicatedFixtureDatabase()
  const first = await withBypass(() => createScratchOrg())
  const second = await withBypass(() => createScratchOrg())
  let client: Awaited<ReturnType<typeof connectMigrationClient>> | undefined
  try {
    const owners = await withBypass(async () => [
      await createScratchUser(first.orgId, 'First view owner', 'admin'),
      await createScratchUser(second.orgId, 'Second view owner', 'admin'),
    ])
    client = await connectMigrationClient({ bypass: true })
    await client.query('begin')
    // The isolated fixture restores the historical shape inside a rollback-only transaction.
    await client.query('alter table public.saved_views drop constraint saved_views_canonical_sort_model')
    const single = { column: 'posting_date', direction: 'asc' }
    const ordered = [{ column: 'amount', direction: 'desc' }, single]
    const base = { entity: 'ledger_lines', mode: 'rows', columns: ['posting_date', 'amount'], filters: null, limit: 50 }
    const cases = [
      [{ sort: single }, { sorts: [single] }],
      [{ sort: single, sorts: [] }, { sorts: [single] }],
      [{ sort: single, sorts: null }, { sorts: [single] }],
      [{ sort: single, sorts: ordered }, { sorts: ordered }],
      [{ sort: null }, {}],
      [{ sort: null, sorts: null }, {}],
      [{ sorts: null }, {}],
      [{ sort: null, sorts: ordered }, { sorts: ordered }],
      [{ sorts: ordered }, { sorts: ordered }],
    ]
    const ids: string[] = []
    for (const [index, [legacy]] of cases.entries()) {
      const id = randomUUID()
      ids.push(id)
      const orgId = index % 2 ? second.orgId : first.orgId
      await client.query(`insert into public.saved_views
        (id, org_id, slug, name, query, layout, scope, owner_id, allowed_roles, updated_at, updated_by)
        values ($1,$2,$3,$3,$4::jsonb,$5::jsonb,$6,$7,$8::jsonb,'2026-01-15T12:00:00Z',$7)`,
      [id, orgId, `ordered-view-${index}`, JSON.stringify({ ...base, ...legacy }), JSON.stringify({ orientation: 'landscape' }), index % 2 ? 'private' : 'shared', owners[index % 2], JSON.stringify(['admin'])])
    }
    const before = (await client.query('select * from public.saved_views where id = any($1::uuid[]) order by id', [ids])).rows
    await client.query('savepoint malformed_view')
    const badId = randomUUID()
    await client.query(`insert into public.saved_views (id,org_id,slug,name,query,owner_id)
      values ($1,$2,'malformed-sort','Malformed sort',$3::jsonb,$4)`, [badId, first.orgId, JSON.stringify({ ...base, sorts: 'amount' }), owners[0]])
    const findings = (await client.query(preflight)).rows
    assert.equal(findings.find(row => row.subject === badId)?.severity, 'refuse')
    await assert.rejects(executeMigrationBody(client, body, { transactional: true, filename }), /malformed sort configuration/)
    await client.query('rollback to savepoint malformed_view')
    assert.deepEqual((await client.query('select * from public.saved_views where id = any($1::uuid[]) order by id', [ids])).rows, before)
    assert.equal((await client.query(`select count(*)::int as n from public.audit_log where table_name='saved_views' and row_id=any($1::uuid[])`, [ids])).rows[0].n, 0)
    assert.deepEqual((await client.query(preflight)).rows, [])
    await executeMigrationBody(client, body, { transactional: true, filename })
    const after = (await client.query('select * from public.saved_views where id = any($1::uuid[]) order by id', [ids])).rows
    for (const [index, [, canonical]] of cases.entries()) {
      const previous = before.find(row => row.id === ids[index])!
      const next = after.find(row => row.id === ids[index])!
      assert.deepEqual(next.query, { ...base, ...canonical })
      assert.deepEqual({ ...next, query: previous.query }, previous, 'owner, tenant, scope, roles, layout and edit provenance remain identical')
      assert.doesNotThrow(() => validateCustomQuery(next.query), 'the native saved-view reader accepts the canonical plan')
    }
    const audits = (await client.query(`select row_id,changes,actor_id from public.audit_log where table_name='saved_views' and row_id=any($1::uuid[])`, [ids])).rows
    assert.equal(audits.length, 8, 'only changed representations produce one system audit each')
    for (const audit of audits) {
      assert.equal(audit.actor_id, null)
      assert.deepEqual(audit.changes.before.query, before.find(row => row.id === audit.row_id)!.query)
      assert.deepEqual(audit.changes.after.query, after.find(row => row.id === audit.row_id)!.query)
    }
    await client.query('savepoint obsolete_write')
    await assert.rejects(client.query('update public.saved_views set query=$1::jsonb where id=$2', [JSON.stringify({ ...base, sort: single }), ids[0]]), (error: unknown) => (error as { code?: string }).code === '23514')
    await client.query('rollback to savepoint obsolete_write')
    await client.query('rollback')
    assert.equal((await client.query('select count(*)::int as n from public.saved_views where id=any($1::uuid[])', [ids])).rows[0].n, 0, 'rollback removes both normalized records and their audit evidence')
    assert.equal((await client.query(`select count(*)::int as n from public.audit_log where table_name='saved_views' and row_id=any($1::uuid[])`, [ids])).rows[0].n, 0)
  } finally {
    if (client) {
      await client.query('rollback').catch(() => {})
      await releaseMigrationClient(client)
    }
    await withBypass(async () => {
      await dropScratchOrg(second.orgId)
      await dropScratchOrg(first.orgId)
    })
  }
})
