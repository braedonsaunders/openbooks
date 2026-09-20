import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { SessionUser } from '../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __captureOCC: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__captureOCC.user}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { PATCH } = await import('./[id]/route')

/**
 * Two review tabs correcting one capture: the second save carries the
 * revision it read before the first save committed, so it must fail with a
 * 409 instead of silently reverting the first tab's corrections (which would
 * materialize into a wrong vendor bill). Same contract as document, payment,
 * and prebill-line edits.
 */
test('a stale capture revision refuses instead of reverting a newer correction', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    // createScratchUser seeds app_roles outside any bypass of its own; scope
    // the call (and every seed write below) explicitly now that importing the
    // route module has replaced the ambient test bypass process-wide.
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Capture reviewer', 'reviewer'))
    await withBypassContext(async () => {
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
    })
    session.user = { id: actor, orgId: org.orgId, name: 'Reviewer', email: 'reviewer@example.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
    const folder = randomUUID(), file = randomUUID(), capture = randomUUID()
    const normalized = {
      vendorName: 'OCC vendor', vendorTaxId: null, invoiceNumber: 'OCC-1', invoiceDate: org.date, dueDate: null,
      purchaseOrderNumber: null, currency: 'CAD', subtotal: '100.0000', taxTotal: '0.0000', total: '100.0000', memo: null,
      lines: [{ description: 'Expense', productCode: null, quantity: '1.0000', unit: null, unitPrice: '100.0000', amount: '100.0000', taxAmount: '0.0000', accountId: org.accounts.cogs, itemId: null, purchaseOrderLineId: null, confidence: null }],
    }
    await withBypassContext(async () => {
      await db.execute(sql`insert into folders(id,org_id,name) values (${folder},${org.orgId},'Capture evidence')`)
      await db.execute(sql`insert into files(id,org_id,folder_id,name,content_type,size_bytes) values (${file},${org.orgId},${folder},'occ.pdf','application/pdf',0)`)
      await db.execute(sql`insert into ap_capture_items(id,org_id,file_id,status,original_filename,content_hash,document_kind,normalized,vendor_candidate_id,created_by,updated_by)
        values (${capture},${org.orgId},${file},'needs_review','occ.pdf',${randomUUID()},'vendor_bill',${JSON.stringify(normalized)}::jsonb,${org.vendorId},${actor},${actor})`)
    })
    const revision = async () => withOrgContext(org.orgId, async () => (await db.execute<{ updatedAt: string }>(sql`
      select (revision_seq)::text as "updatedAt"
        from ap_capture_items where org_id = ${org.orgId} and id = ${capture}`)).rows[0]!.updatedAt)
    const patch = (body: object) => withOrgContext(org.orgId, () => PATCH(new Request('http://occ.local/api/ap-capture/' + capture, {
      method: 'PATCH', body: JSON.stringify({ normalized, vendorId: org.vendorId, ...body }),
    }), { params: Promise.resolve({ id: capture }) }))

    const stale = await revision()
    // Tab A saves with the fresh token (renames the vendor).
    const tabA = await patch({ expectedUpdatedAt: stale, normalized: { ...normalized, vendorName: 'Tab A vendor' } })
    assert.equal(tabA.status, 200, await tabA.clone().text())
    // Tab B still holds the pre-A token (fixes the total): it must lose loudly.
    const tabB = await patch({ expectedUpdatedAt: stale, normalized: { ...normalized, total: '99.0000', subtotal: '99.0000' } })
    assert.equal(tabB.status, 409)
    // The live row is exactly what tab A wrote — no silent revert.
    const live = await withOrgContext(org.orgId, async () => (await db.execute<{ vendor: unknown; total: unknown }>(sql`
      select normalized->>'vendorName' as vendor, normalized->>'total' as total
        from ap_capture_items where org_id = ${org.orgId} and id = ${capture}`)).rows[0]!)
    assert.equal(live.vendor, 'Tab A vendor')
    assert.equal(live.total, '100.0000')
    // A missing token is rejected before any work happens.
    assert.equal((await patch({})).status, 409)
  } finally {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
})
