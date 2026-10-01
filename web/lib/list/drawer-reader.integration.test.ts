import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { stubModules } from '../../testing/stub-modules'
import type { SessionUser } from '../auth'

const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __listDrawerSession: session })
stubModules({ navigation: false, intl: 'export async function getTranslations(){return key=>key}', authz: false, features: false })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) {
    return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__listDrawerSession.user}' }
  }
  return next(specifier, context)
} })
const { sql } = await import('drizzle-orm')
const { db, withOrgContext, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { GET } = await import('../../app/api/lists/[source]/drawer/route')
const { loadApBills } = await import('../../app/(app)/ap/bills/view')

test('detail-only list route preserves native controls, tenant scope, subsidiary scope and feature refusals', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const foreign = await withBypassContext(() => createScratchOrg())
  try {
    const user = await withBypassContext(() => createScratchUser(org.orgId, 'Accounts preparer', 'drawer_reviewer'))
    const hidden = randomUUID()
    const visibleBill = randomUUID(), hiddenBill = randomUUID(), foreignBill = randomUUID(), wrongKind = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`update app_roles set permissions='["ap.read","time.read"]'::jsonb,
        subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb
        where org_id=${org.orgId} and key='drawer_reviewer'`)
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_active) values(${hidden},${org.orgId},${org.subsidiaryId},'Hidden entity','CAD','CA',true)`)
      for (const [id, owner, sub, kind] of [
        [visibleBill, org.orgId, org.subsidiaryId, 'vendor_bill'],
        [hiddenBill, org.orgId, hidden, 'vendor_bill'],
        [foreignBill, foreign.orgId, foreign.subsidiaryId, 'vendor_bill'],
        [wrongKind, org.orgId, org.subsidiaryId, 'customer_invoice'],
      ]) {
        await db.execute(sql`insert into documents(id,org_id,kind,document_number,subsidiary_id,document_date,currency,fx_rate,subtotal,tax_total,total,status)
          values(${id},${owner},${kind},${id},${sub},${org.date},'CAD',1,10,0,10,'draft')`)
      }
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}', '{"fieldTickets":false}'::jsonb) where id=${org.orgId}`)
    })
    session.user = { id: user, orgId: org.orgId, name: 'Accounts preparer', email: 'drawer@scratch.test', roles: [], isSuperAdmin: false,
      envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: user }
    const invoke = (source: string, search: string) => withOrgContext(org.orgId, () => GET(new Request(`http://localhost/api/lists/${source}/drawer?${search}`), { params: Promise.resolve({ source }) }))
    const response = await invoke('vendor_bill', 'doc=' + visibleBill)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    const body = await response.json()
    const native = await withOrgContext(org.orgId, () => loadApBills({ doc: visibleBill }))
    assert.deepEqual(body, JSON.parse(JSON.stringify({ widget: 'document-drawer', drawer: native.drawer })), 'forms, options and workflow controls are the exact native payload')
    assert.equal(body.drawer.canPost, false, 'read permission cannot grant posting')
    assert.equal(body.drawer.canCreate, false)
    for (const id of [hiddenBill, foreignBill, wrongKind, randomUUID()]) {
      const refused = await invoke('vendor_bill', 'doc=' + id)
      assert.equal(refused.status, 404)
      assert.ok(!JSON.stringify(await refused.json()).includes(id), 'a refusal exposes no record data')
    }
    assert.equal((await invoke('vendor_bill', 'doc=new')).status, 400, 'creation stays on the native page')
    assert.equal((await invoke('vendor_bill', 'doc=' + visibleBill + '&form=invalid')).status, 400)
    assert.equal((await invoke('field_ticket', 'ticket=' + randomUUID())).status, 404, 'disabled feature fails closed')
    assert.equal((await invoke('customer_invoice', 'doc=' + wrongKind)).status, 403, 'other record namespaces require their own permission')
    assert.equal((await invoke('__proto__', 'doc=' + visibleBill)).status, 404)
  } finally {
    session.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
    await withBypassContext(() => dropScratchOrg(foreign.orgId))
  }
})
