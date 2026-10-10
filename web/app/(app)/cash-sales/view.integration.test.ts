import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { SessionUser } from '../../../lib/auth'

/**
 * Cash sales loader contract: an open draft carries the caller's create and
 * post grants to the shared DocumentDrawer, so a cash_sales.create holder can
 * edit, save and delete the draft while posting stays behind cash_sales.post.
 * The list's New control offers both cash kinds, each as an unsaved create.
 *
 * Only session copy and translations are doubled; the loader, feature gate
 * and permission checks run against a scratch org.
 */
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __cashSalesViewUser: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
const { stubModules } = await import('../../../testing/stub-modules')
stubModules({ intl: true, extra: { 'server-only': 'export {}' } })
registerHooks({
  resolve(specifier, context, next) {
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual('export async function currentUser(){return globalThis.__cashSalesViewUser.user}')
    }
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { loadCashSales } = await import('./view')

const sessionFor = (orgId: string, actor: string): SessionUser => ({
  id: actor, orgId, name: 'Cashier', email: 'cashier@scratch.test',
  roles: [], isSuperAdmin: false, envKind: 'production',
  productionOrgId: orgId, homeOrgId: orgId, homeUserId: actor,
})

async function role(orgId: string, key: string, permissions: string[]): Promise<string> {
  const userId = await withBypassContext(() => createScratchUser(orgId, key, key))
  await withBypassContext(() => db.execute(sql`
    update app_roles set permissions = ${JSON.stringify(permissions)}::jsonb
     where org_id = ${orgId} and key = ${key}`))
  return userId
}

test('a cash sale draft is editable for its create grant and postable only with post', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(() => db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"cashSales":true}'::jsonb, true)
       where id = ${org.orgId}`))
    const cashier = await role(org.orgId, 'cashier', ['cash_sales.read', 'cash_sales.create'])
    const supervisor = await role(org.orgId, 'till_supervisor', ['cash_sales.read', 'cash_sales.create', 'cash_sales.post'])
    const viewer = await role(org.orgId, 'till_viewer', ['cash_sales.read'])
    const draftId = crypto.randomUUID()
    await withBypassContext(() => db.execute(sql`
      insert into documents (id, org_id, kind, document_number, document_date, currency, subsidiary_id, created_by)
      values (${draftId}, ${org.orgId}, 'cash_sale', ${`CS-${draftId}`}, ${org.date}, 'USD', ${org.subsidiaryId}, ${cashier})`))

    const load = (user: string, sp: Record<string, string>) => {
      state.user = sessionFor(org.orgId, user)
      return withOrgContext(org.orgId, () => loadCashSales(sp))
    }

    const asCashier = await load(cashier, { doc: draftId })
    assert.ok(asCashier.drawer, 'the draft opens')
    assert.equal(asCashier.drawer.canCreate, true, 'cash_sales.create edits, saves and deletes the draft')
    assert.equal(asCashier.drawer.canPost, false, 'posting stays behind cash_sales.post')
    assert.deepEqual(
      asCashier.newButton.items.map((item) => item.kind),
      ['cash_sale', 'cash_refund'],
      'the list New control offers both cash kinds',
    )

    const asSupervisor = await load(supervisor, { doc: draftId })
    assert.equal(asSupervisor.drawer?.canCreate, true)
    assert.equal(asSupervisor.drawer?.canPost, true)

    const asViewer = await load(viewer, { doc: draftId })
    assert.equal(asViewer.drawer?.canCreate, false, 'a read-only role sees the draft read-only')
    assert.equal(asViewer.drawer?.canPost, false)

    const create = await load(cashier, { doc: 'new', kind: 'cash_sale' })
    assert.equal(create.drawer?.createMode, true, 'New opens the unsaved-create drawer')
    assert.equal(create.drawer?.canCreate, true)
    const count = await withBypassContext(() => db.execute<{ n: string }>(sql`
      select count(*)::text as n from documents where org_id = ${org.orgId} and kind = 'cash_sale'`))
    assert.equal(count.rows[0]?.n, '1', 'opening New allocates no document')
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
