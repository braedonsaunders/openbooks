import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '../../../../lib/auth'

/**
 * Unsaved-create loader contract for the three document lists.
 *
 * `?doc=new&kind=` renders the shared DocumentDrawer in createMode over a
 * blank in-memory payload — never a loadDocument('new') read — with the same
 * pickers, config, and form layout as an edit. A kind outside the page, a
 * missing kind, or a missing per-kind create permission opens no drawer, so
 * no visible New action can dead-end. The banking New menu itself lists only
 * per-kind-creatable actions (gl.post for deposits/transfers, ap.create for
 * the rest).
 *
 * Only session copy and translations are doubled; the loaders, kind gates,
 * and permission checks run REAL against a scratch org.
 */
const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __documentCreateViewUser: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next-intl/server') {
      return virtual('export async function getTranslations(){return (key)=>key}; export async function getLocale(){return "en"}')
    }
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual('export async function currentUser(){return globalThis.__documentCreateViewUser.user}')
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { loadBankingTransactions } = await import('./view')
const { loadArInvoices } = await import('../../ar/invoices/view')
const { loadApBills } = await import('../../ap/bills/view')

const sessionFor = (orgId: string, actor: string): SessionUser => ({
  id: actor, orgId, name: 'Loader', email: 'loader@scratch.test',
  roles: [], isSuperAdmin: false, envKind: 'production',
  productionOrgId: orgId, homeOrgId: orgId, homeUserId: actor,
})

async function setup() {
  const org = await withBypassContext(() => createScratchOrg())
  const apUser = await withBypassContext(() => createScratchUser(org.orgId, 'AP clerk', 'ap_clerk'))
  const glUser = await withBypassContext(() => createScratchUser(org.orgId, 'GL clerk', 'gl_clerk'))
  const arUser = await withBypassContext(() => createScratchUser(org.orgId, 'AR clerk', 'ar_clerk'))
  await withBypassContext(() =>
    db.execute(sql`update app_roles set permissions='["banking.read","ap.read","ap.create"]'::jsonb where org_id=${org.orgId} and key='ap_clerk'`),
  )
  await withBypassContext(() =>
    db.execute(sql`update app_roles set permissions='["banking.read","gl.post","gl.read"]'::jsonb where org_id=${org.orgId} and key='gl_clerk'`),
  )
  await withBypassContext(() =>
    db.execute(sql`update app_roles set permissions='["ar.read","ar.create"]'::jsonb where org_id=${org.orgId} and key='ar_clerk'`),
  )
  return { org, apUser, glUser, arUser }
}

const kindsOf = (items: { kind: string }[]) => items.map((i) => i.kind)

test('banking New menu lists only per-kind-creatable actions', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, apUser, glUser } = await setup()
  try {
    state.user = sessionFor(org.orgId, apUser)
    const apOnly = await withOrgContext(org.orgId, () => loadBankingTransactions({}))
    assert.deepEqual(kindsOf(apOnly.newButton.items).sort(), ['card_charge', 'card_refund', 'check'])
    assert.equal(apOnly.canCreate, true)

    state.user = sessionFor(org.orgId, glUser)
    const glOnly = await withOrgContext(org.orgId, () => loadBankingTransactions({}))
    assert.deepEqual(kindsOf(glOnly.newButton.items).sort(), ['deposit', 'transfer'])
    assert.equal(glOnly.canCreate, true)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('banking create drawer opens per-kind or not at all', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, apUser } = await setup()
  try {
    state.user = sessionFor(org.orgId, apUser)
    await withOrgContext(org.orgId, async () => {
      // No per-kind permission → no drawer (no dead-end).
      const refused = await loadBankingTransactions({ doc: 'new', kind: 'transfer' })
      assert.equal(refused.drawerOpen, false)
      assert.equal(refused.drawer, null)
      // Foreign kind → no drawer.
      const foreign = await loadBankingTransactions({ doc: 'new', kind: 'customer_invoice' })
      assert.equal(foreign.drawerOpen, false)
      // Missing kind → no drawer.
      const missing = await loadBankingTransactions({ doc: 'new' })
      assert.equal(missing.drawerOpen, false)
      // Creatable kind → blank create drawer, same machinery as an edit.
      const open = await loadBankingTransactions({ doc: 'new', kind: 'check', mode: 'edit' })
      assert.equal(open.drawerOpen, true)
      const drawer = open.drawer!
      assert.equal(drawer.createMode, true)
      assert.equal(drawer.remountKey, 'new:check')
      assert.equal(drawer.initialMode, 'edit')
      assert.equal(drawer.config.kind, 'check')
      assert.equal(drawer.recordType, 'check')
      const payload = drawer.payload as { doc: Record<string, unknown>; lines: unknown[] }
      assert.equal(payload.doc.kind, 'check')
      assert.equal(payload.doc.status, 'draft')
      assert.deepEqual(payload.lines, [])
      assert.ok(payload.doc.document_date, 'seed carries a document date')
      assert.ok(payload.doc.currency, 'seed carries a currency')
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('ar and ap create drawers open over blank seeds', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, arUser, apUser } = await setup()
  try {
    state.user = sessionFor(org.orgId, arUser)
    await withOrgContext(org.orgId, async () => {
      const open = await loadArInvoices({ doc: 'new', kind: 'customer_invoice', mode: 'edit' })
      assert.equal(open.drawerOpen, true)
      assert.equal(open.drawer!.createMode, true)
      assert.equal(open.drawer!.remountKey, 'new:customer_invoice')
      const payload = open.drawer!.payload as { doc: Record<string, unknown>; lines: unknown[] }
      assert.equal(payload.doc.kind, 'customer_invoice')
      assert.equal(payload.doc.status, 'draft')
      assert.deepEqual(payload.lines, [])
      const foreign = await loadArInvoices({ doc: 'new', kind: 'vendor_bill' })
      assert.equal(foreign.drawerOpen, false)
    })
    state.user = sessionFor(org.orgId, apUser)
    await withOrgContext(org.orgId, async () => {
      const open = await loadApBills({ doc: 'new', kind: 'vendor_bill', mode: 'edit' })
      assert.equal(open.drawerOpen, true)
      assert.equal((open.drawer as { createMode: boolean }).createMode, true)
      const foreign = await loadApBills({ doc: 'new', kind: 'transfer' })
      assert.equal(foreign.drawerOpen, false)
    })
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
