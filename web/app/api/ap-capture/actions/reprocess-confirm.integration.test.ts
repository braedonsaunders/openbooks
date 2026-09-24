import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { SessionUser } from '../../../../lib/auth'

/**
 * A-S22: reprocessing re-extracts from the provider and overwrites the
 * capture's normalized values, so an operator's review corrections would be
 * silently discarded. The actions route requires an explicit
 * confirmDiscardCorrections flag for corrected captures — naming the loss —
 * and records the discard count on the queue event. Uncorrected captures
 * reprocess untouched.
 */
const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __captureReprocessConfirm: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === '../../../../lib/authz' && context.parentURL?.includes('/api/ap-capture/')) {
    return { shortCircuit: true, url: 'data:text/javascript,export async function guardPermission(){return {user:globalThis.__captureReprocessConfirm.user,permissions:new Set(["ap.create"]),allowedSubsidiaryIds:null}};export function guardSubsidiaryScope(){return null}' }
  }
  if (specifier === '@openbooks/jobs') {
    return { shortCircuit: true, url: 'data:text/javascript,export async function enqueueApCapture(){return null}' }
  }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { PATCH } = await import('../[id]/route')
const { POST: act } = await import('./route')

const json = (body: unknown) =>
  new Request('http://audit.local/api/ap-capture/actions', { method: 'POST', body: JSON.stringify(body) })

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg())
  const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Capture auditor', 'admin'))
  session.user = { id: actor, orgId: org.orgId, name: 'Auditor', email: 'auditor@example.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
  const folder = randomUUID(), file = randomUUID(), capture = randomUUID()
  const normalized = {
    vendorName: 'Review vendor', vendorTaxId: null, invoiceNumber: 'REVIEW-1', invoiceDate: org.date, dueDate: null,
    purchaseOrderNumber: null, currency: 'CAD', subtotal: '100.0000', taxTotal: '0.0000', total: '100.0000', memo: null,
    lines: [{ description: 'Expense', productCode: null, quantity: '1.0000', unit: null, unitPrice: '100.0000', amount: '100.0000', taxAmount: '0.0000', accountId: null, itemId: null, purchaseOrderLineId: null, confidence: null }],
  }
  await withBypassContext(() => db.execute(sql`insert into folders(id,org_id,name) values (${folder},${org.orgId},'Capture evidence')`))
  await withBypassContext(() => db.execute(sql`insert into files(id,org_id,folder_id,name,content_type,size_bytes) values (${file},${org.orgId},${folder},'review.pdf','application/pdf',0)`))
  await withBypassContext(() => db.execute(sql`insert into ap_capture_items(id,org_id,file_id,status,original_filename,content_hash,document_kind,normalized,created_by,updated_by)
    values (${capture},${org.orgId},${file},'needs_review','review.pdf',${randomUUID()},'vendor_bill',${JSON.stringify(normalized)}::jsonb,${actor},${actor})`))
  const correct = async (total: string) => {
    const revision = (await withOrgContext(org.orgId, () => db.execute<{ updatedAt: string }>(sql`
      select (revision_seq)::text as "updatedAt" from ap_capture_items where org_id = ${org.orgId} and id = ${capture}`))).rows[0]!.updatedAt
    return withOrgContext(org.orgId, () => PATCH(new Request('http://audit.local/api/ap-capture/' + capture, {
      method: 'PATCH', body: JSON.stringify({ normalized: { ...normalized, total }, expectedUpdatedAt: revision }),
    }), { params: Promise.resolve({ id: capture }) }))
  }
  const reprocess = async (extra: Record<string, unknown> = {}) =>
    act(json({ action: 'reprocess', ids: [capture], ...extra }))
  const state = async () => (await withOrgContext(org.orgId, () => db.execute<{
    status: string; corrections: number; queued: number; discard: unknown;
  }>(sql`select ci.status,
    (select count(*)::int from ap_capture_corrections where org_id = ${org.orgId} and capture_item_id = ${capture}) as corrections,
    (select count(*)::int from ap_capture_events where org_id = ${org.orgId} and capture_item_id = ${capture} and event_kind = 'reprocess_queued') as queued,
    (select detail from ap_capture_events where org_id = ${org.orgId} and capture_item_id = ${capture} and event_kind = 'reprocess_queued' order by at desc limit 1) as discard
    from ap_capture_items ci where ci.org_id = ${org.orgId} and ci.id = ${capture}`))).rows[0]!
  return { org, capture, correct, reprocess, state, close: async () => { session.user = null; await dropScratchOrg(org.orgId) } }
}

test('reprocessing a corrected capture requires confirmation naming the loss', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await fixture()
  try {
    assert.equal((await f.correct('105.0000')).status, 200)
    const corrected = (await f.state()).corrections
    assert.ok(corrected >= 1, 'the PATCH records the operator correction')

    const refused = await f.reprocess()
    const first = ((await refused.json()) as { results: Array<{ ok: boolean; error?: string; errorCode?: string; corrections?: number }> }).results[0]!
    assert.equal(first.ok, false)
    assert.equal(first.errorCode, 'confirm_required')
    assert.equal(first.corrections, corrected)
    assert.match(first.error ?? '', new RegExp(`discards ${corrected} operator correction`))
    assert.equal((await f.state()).status, 'needs_review', 'refused reprocess queues nothing')

    const confirmed = await f.reprocess({ confirmDiscardCorrections: true })
    const done = ((await confirmed.json()) as { results: Array<{ ok: boolean; error?: string }> }).results[0]!
    assert.equal(done.ok, true, JSON.stringify(done))
    const after = await f.state()
    assert.equal(after.status, 'queued')
    assert.deepEqual(after.discard, { discardedCorrections: corrected })
  } finally { await f.close() }
})

test('reprocessing an uncorrected capture needs no confirmation', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await fixture()
  try {
    const queued = await f.reprocess()
    const first = ((await queued.json()) as { results: Array<{ ok: boolean; error?: string }> }).results[0]!
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal((await f.state()).status, 'queued')
  } finally { await f.close() }
})
