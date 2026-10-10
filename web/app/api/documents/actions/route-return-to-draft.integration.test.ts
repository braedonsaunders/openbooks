import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { SessionUser } from '../../../../lib/auth'

/**
 * Return to draft through /api/documents/actions: an approved, never-posted
 * vendor bill returns to draft under approve-level authority (ap.post for
 * bills) with a required reason. Anything else meets a named refusal —
 * never a void on a record that never touched the GL, never a 500.
 */
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __returnToDraftUser: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next-intl/server') return virtual('export async function getTranslations(){return (key)=>key}; export async function getLocale(){return "en"}')
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual('export async function currentUser(){return globalThis.__returnToDraftUser.user}')
    }
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST } = await import('./route')

const request = (body: unknown) => new Request('http://return-to-draft.local/api/documents/actions', { method: 'POST', body: JSON.stringify(body) })

function actorFor(id: string, orgId: string): SessionUser {
  return { id, orgId, name: 'AP clerk', email: 'ap@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: orgId, homeOrgId: orgId, homeUserId: id }
}

async function seedClerk(orgId: string, permissions: string[]): Promise<string> {
  const actor = await withBypassContext(() => createScratchUser(orgId, 'AP clerk', 'ap_clerk'))
  await withBypassContext(() => db.execute(sql`update app_roles set permissions=${JSON.stringify(permissions)}::jsonb where org_id=${orgId} and key='ap_clerk'`))
  return actor
}

async function seedBill(orgId: string, actor: string, subsidiaryId: string, vendorId: string, date: string, status: string): Promise<string> {
  const id = randomUUID()
  await withBypassContext(() => db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${id}, ${orgId}, 'vendor_bill', ${status}, ${`BILL-${id.slice(0, 8)}`},
            ${subsidiaryId}, ${vendorId}, ${date}, ${date},
            'CAD', '1', '100', '0', '100', ${actor})`))
  return id
}

async function docState(orgId: string, id: string) {
  return withBypassContext(async () =>
    (await db.execute<{ status: string; submittedBy: string | null }>(sql`
      select status, submitted_by as "submittedBy" from documents where id = ${id} and org_id = ${orgId}`)).rows[0]!,
  )
}

async function latestAudit(orgId: string, id: string) {
  return withBypassContext(async () =>
    (await db.execute<{ action: string; changes: Record<string, unknown> }>(sql`
      select action, changes from audit_log
       where org_id = ${orgId} and table_name = 'documents' and row_id = ${id}
       order by at desc, id desc limit 1`)).rows[0]!,
  )
}

test('return_to_draft needs the approve grant, then returns the bill with a before/after audit', async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => seedClerk(org.orgId, ['ap.read', 'ap.create']))
    const billId = await seedBill(org.orgId, actor, org.subsidiaryId, org.vendorId, org.date, 'approved')
    state.user = actorFor(actor, org.orgId)

    await withOrgContext(org.orgId, async () => {
      const refused = await POST(request({ action: 'return_to_draft', documentId: billId, reason: 'approved the wrong batch' }))
      assert.equal(refused.status, 403, JSON.stringify(await refused.clone().json()))
      assert.match(String((await refused.json() as { error: string }).error), /ap\.post/)
    })
    assert.equal((await docState(org.orgId, billId)).status, 'approved')

    await withBypassContext(() => db.execute(sql`update app_roles set permissions='["ap.read","ap.create","ap.post"]'::jsonb where org_id=${org.orgId} and key='ap_clerk'`))
    await withOrgContext(org.orgId, async () => {
      const returned = await POST(request({ action: 'return_to_draft', documentId: billId, reason: 'approved the wrong batch' }))
      assert.equal(returned.status, 200, JSON.stringify(await returned.clone().json()))
    })
    assert.deepEqual(await docState(org.orgId, billId), { status: 'draft', submittedBy: null })

    const audit = await latestAudit(org.orgId, billId)
    assert.equal(audit.action, 'update')
    const changes = audit.changes as { mode: string; reason: string; before: { document: { status: string } }; after: { document: { status: string } } }
    assert.equal(changes.mode, 'record_update')
    assert.equal(changes.reason, 'approved the wrong batch')
    assert.equal(changes.before.document.status, 'approved')
    assert.equal(changes.after.document.status, 'draft')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('return_to_draft refuses posted and draft documents with named remedies', async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => seedClerk(org.orgId, ['ap.read', 'ap.create', 'ap.post']))
    state.user = actorFor(actor, org.orgId)

    const postedId = await seedBill(org.orgId, actor, org.subsidiaryId, org.vendorId, org.date, 'posted')
    const draftId = await seedBill(org.orgId, actor, org.subsidiaryId, org.vendorId, org.date, 'draft')
    await withOrgContext(org.orgId, async () => {
      const posted = await POST(request({ action: 'return_to_draft', documentId: postedId, reason: 'approved the wrong batch' }))
      assert.equal(posted.status, 422)
      assert.match(String((await posted.json() as { error: string }).error), /void it or post a correction/)

      const draft = await POST(request({ action: 'return_to_draft', documentId: draftId, reason: 'approved the wrong batch' }))
      assert.equal(draft.status, 422)
      assert.match(String((await draft.json() as { error: string }).error), /already a draft/)
    })
    assert.equal((await docState(org.orgId, postedId)).status, 'posted')
    assert.equal((await docState(org.orgId, draftId)).status, 'draft')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('return_to_draft validates the reason at the boundary', async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => seedClerk(org.orgId, ['ap.read', 'ap.create', 'ap.post']))
    const billId = await seedBill(org.orgId, actor, org.subsidiaryId, org.vendorId, org.date, 'approved')
    state.user = actorFor(actor, org.orgId)

    await withOrgContext(org.orgId, async () => {
      for (const reason of ['no', '   ', '']) {
        const response = await POST(request({ action: 'return_to_draft', documentId: billId, reason }))
        assert.equal(response.status, 400, `reason ${JSON.stringify(reason)} must fail validation`)
      }
    })
    assert.equal((await docState(org.orgId, billId)).status, 'approved')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
