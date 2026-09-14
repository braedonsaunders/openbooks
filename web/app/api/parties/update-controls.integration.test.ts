import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { SessionUser } from '../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __partyUpdateControlsSession: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__partyUpdateControlsSession.user}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})

const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { PATCH, GET } = await import('./[id]/route')
const { GET: transactions } = await import('./[id]/transactions/route')

const params = (id: string) => ({ params: Promise.resolve({ id }) })
const patchRequest = (body: unknown) => new Request('http://audit.local', { method: 'PATCH', body: JSON.stringify(body) })

async function fixture() {
  const org = await createScratchOrg()
  const actor = await createScratchUser(org.orgId, 'Party auditor', 'reviewer')
  await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
  session.user = { id: actor, orgId: org.orgId, name: 'Auditor', email: 'auditor@example.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
  return { org, actor }
}

async function revision(orgId: string, partyId: string): Promise<string> {
  const res = await withOrgContext(orgId, () => GET(new Request('http://audit.local'), params(partyId)))
  assert.equal(res.status, 200)
  return (await res.json()).party.updated_at as string
}

test('impossible hired-on dates are refused with 422 and store nothing', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await fixture()
  try {
    await withOrgContext(org.orgId, async () => {
      const bad = await PATCH(patchRequest({ roles: { employee: { enabled: true, hiredOn: '2026-02-30' } }, expectedUpdatedAt: await revision(org.orgId, org.customerId) }), params(org.customerId))
      assert.equal(bad.status, 422, await bad.clone().text())
      assert.equal((await db.execute<{ n: string }>(sql`select count(*)::text as n from employee_roles where org_id=${org.orgId} and party_id=${org.customerId}`)).rows[0]!.n, '0')
      const good = await PATCH(patchRequest({ roles: { employee: { enabled: true, hiredOn: '2026-02-28' } }, expectedUpdatedAt: await revision(org.orgId, org.customerId) }), params(org.customerId))
      assert.equal(good.status, 200, await good.clone().text())
      assert.equal((await db.execute<{ hired_on: string }>(sql`select hired_on::text from employee_roles where org_id=${org.orgId} and party_id=${org.customerId}`)).rows[0]!.hired_on, '2026-02-28')
    })
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})

test('routine party saves preserve the reserved source sync-identity bridge', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org } = await fixture()
  try {
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`update parties set custom='{"source":{"system":"fixture-source","externalId":"C-1"}}'::jsonb where id=${org.customerId} and org_id=${org.orgId}`)
      const res = await PATCH(patchRequest({ displayName: 'Renamed customer', custom: {}, expectedUpdatedAt: await revision(org.orgId, org.customerId) }), params(org.customerId))
      assert.equal(res.status, 200, await res.clone().text())
      const custom = (await db.execute<{ custom: Record<string, unknown> }>(sql`select custom from parties where id=${org.customerId}`)).rows[0]!.custom
      assert.deepEqual(custom, { source: { system: 'fixture-source', externalId: 'C-1' } })
    })
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})

test('transaction filter enums stay inside the caller subsidiary scope', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, actor } = await fixture()
  try {
    await withOrgContext(org.orgId, async () => {
      const hidden = randomUUID()
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden entity','CAD','CA')`)
      await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,document_date,currency,status,subsidiary_id,created_by,updated_by) values
        (${randomUUID()},${org.orgId},'sales_order','VIS-1',${org.customerId},${org.date},'CAD','draft',${org.subsidiaryId},${actor},${actor}),
        (${randomUUID()},${org.orgId},'customer_invoice','HID-1',${org.customerId},${org.date},'CAD','draft',${hidden},${actor},${actor})`)
      await db.execute(sql`update app_roles set subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb where org_id=${org.orgId} and key='reviewer'`)
      const res = await transactions(new Request('http://audit.local/api'), params(org.customerId))
      assert.equal(res.status, 200, await res.clone().text())
      const body = await res.json()
      assert.equal(body.rows.length, 1)
      assert.deepEqual(body.kinds, ['sales_order'])
    })
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})
