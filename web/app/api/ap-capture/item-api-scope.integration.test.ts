import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { SessionUser } from '../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __captureItemScope: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__captureItemScope.user}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { GET, PATCH } = await import('./[id]/route')
const { GET: GET_FILE } = await import('./[id]/file/route')
const { POST: MATERIALIZE } = await import('./[id]/materialize/route')
const { POST: ACTIONS } = await import('./actions/route')

const HIDDEN_VENDOR_NAME = 'Hidden Capture Vendor ZX'
const HIDDEN_PO_NUMBER = 'PO-HIDDEN-SCOPE-ZX'

/**
 * Restricted AP callers must get the same not-found the inbox already applies:
 * a capture whose vendor or PO sits outside allowedSubsidiaryIds is
 * unreachable by id. Auto-resolve must not persist those associations.
 * A 36-hyphen bulk id is HTTP 404, never a uuid bind inside HTTP 200.
 */
async function fixture() {
  const org = await createScratchOrg()
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Scoped reviewer', 'reviewer'))
  await withBypassContext(async () => {
    await db.execute(sql`
      update app_roles
         set permissions = '["*"]'::jsonb,
             subsidiary_restriction = ${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb
       where org_id = ${org.orgId} and key = 'reviewer'
    `)
  })
  session.user = {
    id: actor, orgId: org.orgId, name: 'Scoped reviewer', email: 'scoped@example.test',
    roles: [], isSuperAdmin: false, envKind: 'production',
    productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor,
  }
  const hiddenSub = randomUUID()
  const hiddenVendor = randomUUID()
  const hiddenPo = randomUUID()
  const folder = randomUUID()
  const hiddenFile = randomUUID()
  const visibleFile = randomUUID()
  const hiddenCapture = randomUUID()
  const visibleCapture = randomUUID()
  const normalized = {
    vendorName: 'Visible capture vendor', vendorTaxId: null, invoiceNumber: 'SCOPE-1', invoiceDate: org.date, dueDate: null,
    purchaseOrderNumber: null, currency: 'CAD', subtotal: '100.0000', taxTotal: '0.0000', total: '100.0000', memo: null,
    lines: [{ description: 'Expense', productCode: null, quantity: '1.0000', unit: null, unitPrice: '100.0000', amount: '100.0000', taxAmount: '0.0000', accountId: org.accounts.cogs, itemId: null, purchaseOrderLineId: null, confidence: null }],
  }
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${hiddenSub}, ${org.orgId}, ${org.subsidiaryId}, 'Hidden entity', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
    `)
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, subsidiary_id, custom)
      values (${hiddenVendor}, ${org.orgId}, 'vendor', ${HIDDEN_VENDOR_NAME}, true, ${hiddenSub}, '{}'::jsonb)
    `)
    await db.execute(sql`
      insert into vendor_roles (org_id, party_id, is_active) values (${org.orgId}, ${hiddenVendor}, true)
    `)
    await db.execute(sql`
      insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, currency, status, subtotal, tax_total, total)
      values (${hiddenPo}, ${org.orgId}, 'purchase_order', ${HIDDEN_PO_NUMBER}, ${hiddenVendor}, ${hiddenSub}, ${org.date}, 'CAD', 'approved', '100', '0', '100')
    `)
    await db.execute(sql`insert into folders (id, org_id, name) values (${folder}, ${org.orgId}, 'Capture evidence')`)
    await db.execute(sql`insert into files (id, org_id, folder_id, name, content_type, size_bytes) values (${hiddenFile}, ${org.orgId}, ${folder}, 'hidden.pdf', 'application/pdf', 0)`)
    await db.execute(sql`insert into files (id, org_id, folder_id, name, content_type, size_bytes) values (${visibleFile}, ${org.orgId}, ${folder}, 'visible.pdf', 'application/pdf', 0)`)
    await db.execute(sql`
      insert into ap_capture_items (id, org_id, file_id, status, original_filename, content_hash, document_kind, normalized, vendor_candidate_id, created_by, updated_by)
      values (${hiddenCapture}, ${org.orgId}, ${hiddenFile}, 'needs_review', 'hidden.pdf', ${randomUUID()}, 'vendor_bill', ${JSON.stringify({ ...normalized, vendorName: HIDDEN_VENDOR_NAME, invoiceNumber: 'SCOPE-HIDDEN' })}::jsonb, ${hiddenVendor}, ${actor}, ${actor})
    `)
    await db.execute(sql`
      insert into ap_capture_items (id, org_id, file_id, status, original_filename, content_hash, document_kind, normalized, vendor_candidate_id, created_by, updated_by)
      values (${visibleCapture}, ${org.orgId}, ${visibleFile}, 'needs_review', 'visible.pdf', ${randomUUID()}, 'vendor_bill', ${JSON.stringify(normalized)}::jsonb, ${org.vendorId}, ${actor}, ${actor})
    `)
  })
  const asJson = async (res: Response) => ({ status: res.status, body: await res.json().catch(() => null) })
  const getItem = (id: string) => withOrgContext(org.orgId, () => GET(new Request('http://scope.local/api/ap-capture/' + id), { params: Promise.resolve({ id }) }))
  const getFile = (id: string) => withOrgContext(org.orgId, () => GET_FILE(new Request('http://scope.local/api/ap-capture/' + id + '/file'), { params: Promise.resolve({ id }) }))
  const patch = (id: string, body: object) => withOrgContext(org.orgId, () => PATCH(new Request('http://scope.local/api/ap-capture/' + id, {
    method: 'PATCH', body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) }))
  const materialize = (id: string) => withOrgContext(org.orgId, () => MATERIALIZE(new Request('http://scope.local/api/ap-capture/' + id + '/materialize', { method: 'POST' }), { params: Promise.resolve({ id }) }))
  const actions = (body: object) => withOrgContext(org.orgId, () => ACTIONS(new Request('http://scope.local/api/ap-capture/actions', {
    method: 'POST', body: JSON.stringify(body),
  })))
  const associations = (id: string) => withOrgContext(org.orgId, async () => (await db.execute<{ vendor: string | null; po: string | null }>(sql`
    select vendor_candidate_id as vendor, purchase_order_id as po
      from ap_capture_items where org_id = ${org.orgId} and id = ${id}`)).rows[0]!)
  const revision = (id: string) => withOrgContext(org.orgId, async () => (await db.execute<{ updatedAt: string }>(sql`
    select (revision_seq)::text as "updatedAt" from ap_capture_items where org_id = ${org.orgId} and id = ${id}`)).rows[0]!.updatedAt)
  const close = async () => {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
  return { org, hiddenCapture, visibleCapture, hiddenVendor, hiddenPo, normalized, asJson, getItem, getFile, patch, materialize, actions, associations, revision, close }
}

const skip = !process.env.OPENBOOKS_DB_URL

test('a restricted caller cannot reach another entity’s capture by id', { skip }, async () => {
  const f = await fixture()
  try {
    const missing = randomUUID()
    const visible = await f.asJson(await f.getItem(f.visibleCapture))
    assert.equal(visible.status, 200, JSON.stringify(visible.body))

    const hiddenGet = await f.asJson(await f.getItem(f.hiddenCapture))
    const missingGet = await f.asJson(await f.getItem(missing))
    assert.deepEqual(hiddenGet, missingGet)
    assert.equal(hiddenGet.status, 404)
    assert.equal(hiddenGet.body?.error, 'not_found')

    const hiddenFile = await f.asJson(await f.getFile(f.hiddenCapture))
    const missingFile = await f.asJson(await f.getFile(missing))
    assert.deepEqual(hiddenFile, missingFile)
    assert.equal(hiddenFile.status, 404)
    assert.equal(hiddenFile.body?.error, 'not_found')

    const patchBody = { normalized: f.normalized, expectedUpdatedAt: '1' }
    const hiddenPatch = await f.asJson(await f.patch(f.hiddenCapture, patchBody))
    const missingPatch = await f.asJson(await f.patch(missing, patchBody))
    assert.deepEqual(hiddenPatch, missingPatch)
    assert.equal(hiddenPatch.status, 404)
    assert.equal(hiddenPatch.body?.error, 'not_found')

    const hiddenMat = await f.asJson(await f.materialize(f.hiddenCapture))
    const missingMat = await f.asJson(await f.materialize(missing))
    assert.deepEqual(hiddenMat, missingMat)
    assert.equal(hiddenMat.body?.error, 'Capture item not found')

    for (const action of ['reject', 'materialize'] as const) {
      const hiddenAct = await f.asJson(await f.actions({ action, ids: [f.hiddenCapture] }))
      const missingAct = await f.asJson(await f.actions({ action, ids: [missing] }))
      assert.equal(hiddenAct.status, missingAct.status)
      assert.equal(hiddenAct.body?.results?.[0]?.ok, false)
      assert.equal(hiddenAct.body?.results?.[0]?.error, missingAct.body?.results?.[0]?.error)
    }
  } finally {
    await f.close()
  }
})

test('bulk actions refuse a 36-hyphen id as HTTP 404 not_found', { skip }, async () => {
  const f = await fixture()
  try {
    const res = await f.asJson(await f.actions({ action: 'reject', ids: ['-'.repeat(36)] }))
    assert.equal(res.status, 404)
    assert.equal(res.body?.error, 'not_found')
    assert.equal(res.body?.results, undefined)
  } finally {
    await f.close()
  }
})

test('PATCH that auto-resolves an out-of-scope vendor or PO returns 404 and does not persist those ids', { skip }, async () => {
  const f = await fixture()
  try {
    const before = await f.associations(f.visibleCapture)
    assert.equal(before.vendor, f.org.vendorId)
    assert.equal(before.po, null)

    const vendorAttempt = await f.asJson(await f.patch(f.visibleCapture, {
      expectedUpdatedAt: await f.revision(f.visibleCapture),
      normalized: { ...f.normalized, vendorName: HIDDEN_VENDOR_NAME },
    }))
    assert.equal(vendorAttempt.status, 404, JSON.stringify(vendorAttempt.body))
    assert.equal(vendorAttempt.body?.error, 'not_found')
    assert.deepEqual(await f.associations(f.visibleCapture), before)

    const poAttempt = await f.asJson(await f.patch(f.visibleCapture, {
      expectedUpdatedAt: await f.revision(f.visibleCapture),
      normalized: { ...f.normalized, purchaseOrderNumber: HIDDEN_PO_NUMBER },
    }))
    assert.equal(poAttempt.status, 404, JSON.stringify(poAttempt.body))
    assert.equal(poAttempt.body?.error, 'not_found')
    assert.deepEqual(await f.associations(f.visibleCapture), before)
  } finally {
    await f.close()
  }
})
