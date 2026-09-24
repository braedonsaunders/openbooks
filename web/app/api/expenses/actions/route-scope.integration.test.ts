import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import type { SessionUser } from '../../../../lib/auth'

/**
 * Expense submit/post/recall lock the expense report and recheck the caller
 * scope inside the write transaction: the unlocked expenseReport probe can
 * authorize report A while a concurrent A→B rehome lands before the
 * submit/post/recall commits. Out-of-scope answers exactly like missing.
 */
const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __expenseActionScopeUser: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual('export async function currentUser(){return globalThis.__expenseActionScopeUser.user}')
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, pool, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import('@openbooks/engine/src/testing/fixtures.ts')
const { documentRevisionCounterSql } = await import('@openbooks/engine/src/records/revision.ts')
const { POST } = await import('./route')

function asUser(id: string, orgId: string): SessionUser {
  return {
    id, orgId, name: 'Scoped spender', email: 'scoped-spender@scratch.test', roles: [],
    isSuperAdmin: false, envKind: 'production', productionOrgId: orgId, homeOrgId: orgId, homeUserId: id,
  }
}

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Scoped spender', 'reviewer'))
    await withBypassContext(() => db.execute(sql`update app_roles set permissions='["*"]'::jsonb, subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb where org_id=${org.orgId} and key='reviewer'`))
    const hidden = randomUUID()
    await withBypassContext(() => db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden entity','CAD','CA')`))
    const report = async (number: string, subsidiaryId: string) => {
      const id = randomUUID()
      await withBypassContext(() => db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, subsidiary_id, document_date,
           currency, fx_rate, status, subtotal, tax_total, total, custom, created_by, updated_by)
        values (${id}, ${org.orgId}, 'expense_report', ${number}, ${subsidiaryId}, ${org.date},
                'CAD', 1, 'draft', 0, 0, 0, '{}'::jsonb, ${actor}, ${actor})`))
      return id
    }
    const visible = await report('EXP-VIS-1', org.subsidiaryId)
    const concealed = await report('EXP-HID-1', hidden)
    state.user = asUser(actor, org.orgId)
    return { org, actor, visible, concealed }
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

const actionCall = (body: unknown) =>
  POST(new Request('http://expenses.local/api/expenses/actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))

test('expense submit, post, and recall refuse an out-of-scope report', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, visible, concealed } = await fixture()
  try {
    await withOrgContext(org.orgId, async () => {
      for (const body of [
        { action: 'submit', documentId: concealed },
        { action: 'post', documentId: concealed },
        { action: 'recall', documentId: concealed, expectedUpdatedAt: await revisionToken(concealed) },
      ]) {
        const refused = await actionCall(body)
        assert.equal(
          refused.status, 404,
          `${(body as { action: string }).action} on an out-of-scope report must 404: ${JSON.stringify(await refused.clone().json())}`,
        )
        assert.deepEqual(await refused.json(), { error: 'expense report not found' })
      }
      // The in-scope twin reaches the engine instead of the scope refusal.
      const own = await actionCall({ action: 'submit', documentId: visible })
      assert.notEqual(own.status, 404, JSON.stringify(await own.clone().json()))
    })
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('expense submit waits on a report rehome in flight instead of racing it', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, actor } = await fixture()
  const writer = await pool.connect()
  let pending: Promise<Response> | undefined
  try {
    const moving = randomUUID()
    const hidden = (await db.execute<{ id: string }>(sql`select id from subsidiaries where org_id=${org.orgId} and parent_id=${org.subsidiaryId} limit 1`)).rows[0]!.id
    await withBypassContext(() => db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, subsidiary_id, document_date,
         currency, fx_rate, status, subtotal, tax_total, total, custom, created_by, updated_by)
      values (${moving}, ${org.orgId}, 'expense_report', 'EXP-MOV-1', ${org.subsidiaryId}, ${org.date},
              'CAD', 1, 'draft', 0, 0, 0, '{}'::jsonb, ${actor}, ${actor})`))
    await writer.query('begin')
    await writer.query("select set_config('app.bypass_rls','on',true), set_config('statement_timeout','10000',true)")
    const pid = (await writer.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
    await writer.query('update documents set subsidiary_id=$1 where id=$2', [hidden, moving])
    pending = withOrgContext(org.orgId, () => actionCall({ action: 'submit', documentId: moving }))
    let blocked = false
    for (let n = 0; n < 200; n++) {
      blocked = !!((await pool.query('select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))', [pid])).rowCount)
      if (blocked) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(blocked, 'the submit waits on the locked report instead of riding the pre-rehome probe')
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
