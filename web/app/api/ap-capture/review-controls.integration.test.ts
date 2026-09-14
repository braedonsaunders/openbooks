import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { SessionUser } from '../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __captureReviewControls: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__captureReviewControls.user}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { PATCH } = await import('./[id]/route')

async function fixture() {
  const org = await createScratchOrg()
  const actor = await createScratchUser(org.orgId, 'Capture auditor', 'reviewer')
  await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
  session.user = { id: actor, orgId: org.orgId, name: 'Auditor', email: 'auditor@example.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }
  const folder = randomUUID(), file = randomUUID(), capture = randomUUID()
  const normalized = {
    vendorName: 'Review vendor', vendorTaxId: null, invoiceNumber: 'REVIEW-1', invoiceDate: org.date, dueDate: null,
    purchaseOrderNumber: null, currency: 'CAD', subtotal: '100.0000', taxTotal: '0.0000', total: '100.0000', memo: null,
    lines: [{ description: 'Expense', productCode: null, quantity: '1.0000', unit: null, unitPrice: '100.0000', amount: '100.0000', taxAmount: '0.0000', accountId: org.accounts.cogs, itemId: null, purchaseOrderLineId: null, confidence: null }],
  }
  await db.execute(sql`insert into folders(id,org_id,name) values (${folder},${org.orgId},'Capture evidence')`)
  await db.execute(sql`insert into files(id,org_id,folder_id,name,content_type,size_bytes) values (${file},${org.orgId},${folder},'review.pdf','application/pdf',0)`)
  await db.execute(sql`insert into ap_capture_items(id,org_id,file_id,status,original_filename,content_hash,document_kind,normalized,vendor_candidate_id,created_by,updated_by)
    values (${capture},${org.orgId},${file},'needs_review','review.pdf',${randomUUID()},'vendor_credit',${JSON.stringify(normalized)}::jsonb,${org.vendorId},${actor},${actor})`)
  const run = randomUUID()
  await db.execute(sql`insert into ap_capture_runs(id,org_id,capture_item_id,attempt,provider,model,status,finished_at)
    values (${run},${org.orgId},${capture},1,'fixture','fixture','succeeded',now())`)
  await db.execute(sql`insert into ap_capture_fields(org_id,run_id,field_key,raw_value)
    values (${org.orgId},${run},'total','100.00')`)
  const patch = (body: object) => withOrgContext(org.orgId, () => PATCH(new Request('http://audit.local/api/ap-capture/'+capture, {
    method: 'PATCH', body: JSON.stringify({ normalized, vendorId: org.vendorId, ...body }),
  }), { params: Promise.resolve({ id: capture }) }))
  const snapshot = async () => (await db.execute(sql`select to_jsonb(ci) as item,
    (select count(*) from ap_capture_corrections where org_id=${org.orgId}) as corrections,
    (select count(*) from ap_capture_events where org_id=${org.orgId}) as events
    from ap_capture_items ci where ci.org_id=${org.orgId} and ci.id=${capture}`)).rows
  const close = async () => {
    session.user = null
    await dropScratchOrg(org.orgId)
    assert.equal((await db.execute(sql`select id from orgs where id=${org.orgId}`)).rows.length, 0)
    const guards = await db.execute<{ tgenabled: string }>(sql`select tgenabled from pg_trigger
      where tgrelid in ('public.ap_capture_fields'::regclass, 'public.ap_capture_runs'::regclass,
        'public.ap_capture_corrections'::regclass, 'public.ap_capture_events'::regclass)
      and tgname in ('ap_capture_fields_append_only','ap_capture_runs_immutable',
        'ap_capture_corrections_append_only','ap_capture_events_append_only')`)
    assert.equal(guards.rows.length, 4)
    assert.ok(guards.rows.every(row => row.tgenabled === 'O'), 'all capture retention guards remain enabled')
  }
  return { org, capture, normalized, patch, snapshot, close }
}

test('capture review preserves an omitted document kind and validates supplied kinds', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await fixture()
  try {
    const result = await f.patch({})
    assert.equal(result.status, 200, await result.clone().text())
    assert.equal(((await f.snapshot())[0]!.item as Record<string, unknown>).document_kind, 'vendor_credit')
    const before = await f.snapshot()
    assert.equal((await f.patch({ documentKind: 'customer_invoice' })).status, 422)
    assert.deepEqual(await f.snapshot(), before)
    assert.equal((await f.patch({ documentKind: 'vendor_bill' })).status, 200)
    assert.equal(((await f.snapshot())[0]!.item as Record<string, unknown>).document_kind, 'vendor_bill')
  } finally { await f.close() }
})

test('manual capture corrections refuse malformed financial values without changing evidence', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await fixture()
  try {
    const before = await f.snapshot()
    for (const normalized of [
      { ...f.normalized, lines: [{ ...f.normalized.lines[0], amount: 'not-money' }] },
      { ...f.normalized, total: '100USD' },
      { ...f.normalized, lines: {} },
      { ...f.normalized, lines: [{ ...f.normalized.lines[0], accountId: 'malformed' }] },
    ]) {
      const result = await f.patch({ normalized })
      assert.equal(result.status, 422)
      assert.deepEqual(await f.snapshot(), before)
    }
    assert.equal((await f.patch({})).status, 200, 'valid exact decimal edits remain usable')
  } finally { await f.close() }
})
