import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import type { SessionUser } from '../../../../lib/auth'

/**
 * Journal GET answers the detail from one transaction whose scope predicate
 * sits on the locked journal row, and DELETE enforces the caller scope
 * under the document lock (plus the PATCH-style revision fence): a
 * concurrent rehome cannot authorize entity A and then move the journal
 * before the read or the delete commits. Out-of-scope answers exactly like
 * missing.
 */
const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __journalScopeUser: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual('export async function currentUser(){return globalThis.__journalScopeUser.user}')
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, pool, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import('@openbooks/engine/src/testing/fixtures.ts')
const { documentRevisionCounterSql } = await import('@openbooks/engine/src/records/revision.ts')
const { GET, DELETE } = await import('./route')

function asUser(id: string, orgId: string): SessionUser {
  return {
    id, orgId, name: 'Scoped ledger', email: 'scoped-ledger@scratch.test', roles: [],
    isSuperAdmin: false, envKind: 'production', productionOrgId: orgId, homeOrgId: orgId, homeUserId: id,
  }
}

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Scoped ledger', 'reviewer'))
    await withBypassContext(() => db.execute(sql`update app_roles set permissions='["*"]'::jsonb, subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb where org_id=${org.orgId} and key='reviewer'`))
    const hidden = randomUUID()
    await withBypassContext(() => db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden entity','CAD','CA')`))
    const journal = async (number: string, subsidiaryId: string) => {
      const id = randomUUID()
      await withBypassContext(() => db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, subsidiary_id, document_date,
           currency, fx_rate, status, subtotal, tax_total, total, custom,
           created_by, updated_by)
        values (${id}, ${org.orgId}, 'journal', ${number}, ${subsidiaryId}, ${org.date},
                'CAD', 1, 'draft', 100, 0, 100, '{}'::jsonb, ${actor}, ${actor})`))
      return id
    }
    const visible = await journal('JE-VIS-1', org.subsidiaryId)
    const concealed = await journal('JE-HID-1', hidden)
    state.user = asUser(actor, org.orgId)
    return { org, visible, concealed }
  } catch (e) {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
    throw e
  }
}

async function revisionToken(documentId: string): Promise<string> {
  const row = (await db.execute<{ updatedAt: string }>(sql`
    select ${documentRevisionCounterSql(sql.raw('revision_seq'))} as "updatedAt"
      from documents where id = ${documentId}`))
  return row.rows[0]!.updatedAt
}

const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) })

test('journal GET waits on a journal rehome in flight instead of racing it', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, visible } = await fixture()
  const writer = await pool.connect()
  let pending: Promise<Response> | undefined
  try {
    const hidden = (await db.execute<{ id: string }>(sql`select id from subsidiaries where org_id=${org.orgId} and parent_id=${org.subsidiaryId} limit 1`)).rows[0]!.id
    await writer.query('begin')
    await writer.query("select set_config('app.bypass_rls','on',true), set_config('statement_timeout','10000',true)")
    const pid = (await writer.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
    await writer.query('update documents set subsidiary_id=$1 where id=$2', [hidden, visible])
    pending = withOrgContext(org.orgId, () => GET(new Request('http://journals.local/api'), ctxFor(visible)))
    let blocked = false
    for (let n = 0; n < 200; n++) {
      blocked = !!((await pool.query('select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))', [pid])).rowCount)
      if (blocked) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(blocked, 'the detail waits on the locked journal instead of reading the pre-rehome row')
    await writer.query('commit')
    const response = await pending
    assert.equal(response.status, 404, JSON.stringify(await response.clone().json()))
  } finally {
    await writer.query('rollback').catch(() => {})
    await pending?.catch(() => {})
    writer.release()
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('journal GET and DELETE enforce the caller subsidiary scope', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, visible, concealed } = await fixture()
  try {
    await withOrgContext(org.orgId, async () => {
      const seen = await GET(new Request('http://journals.local/api'), ctxFor(visible))
      assert.equal(seen.status, 200, JSON.stringify(await seen.clone().json()))

      const hiddenGet = await GET(new Request('http://journals.local/api'), ctxFor(concealed))
      assert.equal(hiddenGet.status, 404)
      assert.deepEqual(await hiddenGet.json(), { error: 'not found' })

      const hiddenDelete = await DELETE(
        new Request('http://journals.local/api', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ expectedUpdatedAt: await revisionToken(concealed) }),
        }),
        ctxFor(concealed),
      )
      assert.equal(hiddenDelete.status, 404, JSON.stringify(await hiddenDelete.clone().json()))
      assert.equal(
        (await db.execute<{ n: number }>(sql`select count(*)::int as n from documents where id=${concealed}`)).rows[0]!.n,
        1,
        'a refused delete keeps the journal',
      )

      const unfenced = await DELETE(
        new Request('http://journals.local/api', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }),
        ctxFor(visible),
      )
      assert.equal(unfenced.status, 409, 'delete without a revision token is fenced like PATCH')

      const deleted = await DELETE(
        new Request('http://journals.local/api', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ expectedUpdatedAt: await revisionToken(visible) }),
        }),
        ctxFor(visible),
      )
      assert.equal(deleted.status, 200, JSON.stringify(await deleted.clone().json()))
      assert.equal(
        (await db.execute<{ n: number }>(sql`select count(*)::int as n from documents where id=${visible}`)).rows[0]!.n,
        0,
      )
    })
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
