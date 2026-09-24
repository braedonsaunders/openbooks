import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '../../../../../lib/auth'

/**
 * Party bank-account writes lock the party and recheck the caller scope
 * inside the write transaction: an unlocked precheck can authorize party A
 * while a concurrent A→B rehome lands before the write commits, which would
 * plant fraud-sensitive bank details on another entity's party (or disclose
 * them). A denied write answers exactly like a missing party and writes
 * nothing.
 */
const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __bankScopeUser: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual('export async function currentUser(){return globalThis.__bankScopeUser.user}')
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, pool, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST: createAccount } = await import('./route')

function asUser(id: string, orgId: string): SessionUser {
  return {
    id, orgId, name: 'Scoped banker', email: 'scoped-banker@scratch.test', roles: [],
    isSuperAdmin: false, envKind: 'production', productionOrgId: orgId, homeOrgId: orgId, homeUserId: id,
  }
}

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Scoped banker', 'reviewer'))
    await withBypassContext(() => db.execute(sql`update app_roles set permissions='["parties.manage"]'::jsonb, subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb where org_id=${org.orgId} and key='reviewer'`))
    const hidden = randomUUID()
    await withBypassContext(() => db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden entity','CAD','CA')`))
    const party = async (name: string, subsidiaryId: string) => {
      const id = randomUUID()
      await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom) values (${id},${org.orgId},'vendor',${name},${subsidiaryId},true,'{}'::jsonb)`))
      return id
    }
    const visible = await party('Visible vendor', org.subsidiaryId)
    const concealed = await party('Hidden vendor', hidden)
    state.user = asUser(actor, org.orgId)
    return { org, actor, hidden, visible, concealed }
  } catch (e) {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
    throw e
  }
}

const createRequest = (partyId: string) =>
  new Request(`http://bank.local/api/parties/${partyId}/bank-accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bankName: 'Scope Bank', accountNumber: '00112233' }),
  })

async function accountCount(orgId: string, partyId: string): Promise<number> {
  return Number((await db.execute<{ count: string }>(
    sql`select count(*)::text as count from party_bank_accounts where org_id=${orgId} and party_id=${partyId}`,
  )).rows[0]!.count)
}

test('bank-account create refuses an out-of-scope party and writes nothing', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, visible, concealed } = await fixture()
  try {
    await withOrgContext(org.orgId, async () => {
      const refused = await createAccount(createRequest(concealed), { params: Promise.resolve({ id: concealed }) })
      assert.equal(refused.status, 404, JSON.stringify(await refused.clone().json()))
      assert.equal(await accountCount(org.orgId, concealed), 0, 'a refused create writes no bank details')
      const accepted = await createAccount(createRequest(visible), { params: Promise.resolve({ id: visible }) })
      assert.equal(accepted.status, 201, JSON.stringify(await accepted.clone().json()))
      assert.equal(await accountCount(org.orgId, visible), 1)
    })
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('bank-account create waits on a party rehome in flight instead of racing it', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, hidden } = await fixture()
  const writer = await pool.connect()
  let pending: Promise<Response> | undefined
  try {
    const moving = randomUUID()
    await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom) values (${moving},${org.orgId},'vendor','Moving vendor',${org.subsidiaryId},true,'{}'::jsonb)`))
    await writer.query('begin')
    await writer.query("select set_config('app.bypass_rls','on',true), set_config('statement_timeout','10000',true)")
    const pid = (await writer.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
    await writer.query('update parties set subsidiary_id=$1 where id=$2 and org_id=$3', [hidden, moving, org.orgId])
    pending = withOrgContext(org.orgId, () => createAccount(createRequest(moving), { params: Promise.resolve({ id: moving }) }))
    let blocked = false
    for (let n = 0; n < 200; n++) {
      blocked = !!((await pool.query('select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))', [pid])).rowCount)
      if (blocked) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(blocked, 'the create waits on the locked party instead of planting details on the pre-rehome row')
    await writer.query('commit')
    const response = await pending
    assert.equal(response.status, 404, JSON.stringify(await response.clone().json()))
    assert.equal(await accountCount(org.orgId, moving), 0, 'the create refused after the rehome committed writes nothing')
  } finally {
    await writer.query('rollback').catch(() => {})
    await pending?.catch(() => {})
    writer.release()
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
