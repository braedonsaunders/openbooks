import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '../../../../lib/auth'

/**
 * Vendor-bill release policy (owner decision: auto-release stays the default,
 * made explicit). With the org switch OFF (the default) a vendor bill with
 * no approval flow auto-releases on submit and the audit trail says why.
 * With the switch ON and no matching flow, the release is refused by name
 * and the bill stays submitted — never released. A matching flow gates
 * normally, and already-released history is untouched.
 */
const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __vendorBillApprovalUser: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next-intl/server') return virtual('export async function getTranslations(){return (key)=>key}; export async function getLocale(){return "en"}')
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual('export async function currentUser(){return globalThis.__vendorBillApprovalUser.user}')
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { seedApprovalFlow } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { VENDOR_BILL_APPROVAL_REQUIRED_MESSAGE } = await import('@openbooks/engine/src/flows/index.ts')
const { POST } = await import('./route')

const AUTO_RELEASE_REASON = 'released without approval: no approval flow configured'

const request = (body: unknown) => new Request('http://vendor-bill.local/api/documents/actions', { method: 'POST', body: JSON.stringify(body) })

function actorFor(id: string, orgId: string): SessionUser {
  return { id, orgId, name: 'AP clerk', email: 'ap@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: orgId, homeOrgId: orgId, homeUserId: id }
}

async function seedClerk(orgId: string, permissions: string[]): Promise<string> {
  const actor = await withBypassContext(() => createScratchUser(orgId, 'AP clerk', 'ap_clerk'))
  await withBypassContext(() => db.execute(sql`update app_roles set permissions=${JSON.stringify(permissions)}::jsonb where org_id=${orgId} and key='ap_clerk'`))
  return actor
}

async function seedDraftBill(orgId: string, actor: string, subsidiaryId: string, vendorId: string, date: string): Promise<string> {
  const id = randomUUID()
  await withBypassContext(() => db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${id}, ${orgId}, 'vendor_bill', 'draft', ${`BILL-${id.slice(0, 8)}`},
            ${subsidiaryId}, ${vendorId}, ${date}, ${date},
            'CAD', '1', '100', '0', '100', ${actor})`))
  return id
}

/** Pooled scratch orgs can carry settings from an earlier lease: pin the switch. */
async function setRequirement(orgId: string, required: boolean): Promise<void> {
  await withBypassContext(() => db.execute(sql`
    update orgs
       set settings = jsonb_set(
         coalesce(settings, '{}'::jsonb), '{approvals}',
         coalesce(settings->'approvals', '{}'::jsonb) || jsonb_build_object('requireVendorBillApproval', ${required}::boolean),
         true)
     where id = ${orgId}`))
}

async function docState(orgId: string, id: string) {
  return withBypassContext(async () =>
    (await db.execute<{ status: string; submittedBy: string | null }>(sql`
      select status, submitted_by as "submittedBy" from documents where id = ${id} and org_id = ${orgId}`)).rows[0]!,
  )
}

async function auditTrail(orgId: string, id: string) {
  return withBypassContext(async () =>
    (await db.execute<{ action: string; changes: Record<string, unknown> }>(sql`
      select action, changes from audit_log where org_id = ${orgId} and table_name = 'documents' and row_id = ${id} order by action`)).rows,
  )
}

test('vendor-bill submit with the requirement OFF auto-releases and evidences why', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await setRequirement(org.orgId, false)
    const actor = await seedClerk(org.orgId, ['ap.read', 'ap.create'])
    const billId = await seedDraftBill(org.orgId, actor, org.subsidiaryId, org.vendorId, org.date)
    state.user = actorFor(actor, org.orgId)

    const submitted = await withOrgContext(org.orgId, () => POST(request({ action: 'submit', documentId: billId })))
    assert.equal(submitted.status, 200, JSON.stringify(await submitted.clone().json()))
    assert.equal((await submitted.json() as { autoApproved?: boolean }).autoApproved, true)
    assert.equal((await docState(org.orgId, billId)).status, 'approved')

    const trail = await auditTrail(org.orgId, billId)
    const approvals = trail.filter((row) => row.action === 'approve')
    assert.equal(approvals.length, 1, `one auto-approval evidences the release, got ${JSON.stringify(trail)}`)
    assert.equal(approvals[0]!.changes.reason, AUTO_RELEASE_REASON)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('vendor-bill submit with the requirement ON and no flow is refused by name', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await setRequirement(org.orgId, true)
    const actor = await seedClerk(org.orgId, ['ap.read', 'ap.create'])
    const billId = await seedDraftBill(org.orgId, actor, org.subsidiaryId, org.vendorId, org.date)
    state.user = actorFor(actor, org.orgId)

    const refused = await withOrgContext(org.orgId, () => POST(request({ action: 'submit', documentId: billId })))
    assert.equal(refused.status, 422, JSON.stringify(await refused.clone().json()))
    assert.equal((await refused.json() as { error?: string }).error, VENDOR_BILL_APPROVAL_REQUIRED_MESSAGE)

    // Stays submitted (the submitter is recorded), never released.
    const after = await docState(org.orgId, billId)
    assert.equal(after.status, 'draft')
    assert.equal(after.submittedBy, actor)

    const trail = await auditTrail(org.orgId, billId)
    assert.ok(!trail.some((row) => row.action === 'approve'), `nothing released, got ${JSON.stringify(trail)}`)
    const submits = trail.filter((row) => row.action === 'submit')
    assert.equal(submits.length, 1)
    assert.equal(submits[0]!.changes.approval_required, true)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('vendor-bill submit with the requirement ON and a matching flow gates normally', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await setRequirement(org.orgId, true)
    const actor = await seedClerk(org.orgId, ['ap.read', 'ap.create'])
    const approver = await withBypassContext(() => createScratchUser(org.orgId, 'Approver', 'approver'))
    await withBypassContext(() => seedApprovalFlow(org.orgId, {
      subjectKind: 'vendor_bill',
      assignees: [{ type: 'user', userId: approver }],
      mode: 'any',
    }))
    const billId = await seedDraftBill(org.orgId, actor, org.subsidiaryId, org.vendorId, org.date)
    state.user = actorFor(actor, org.orgId)

    const gated = await withOrgContext(org.orgId, () => POST(request({ action: 'submit', documentId: billId })))
    assert.equal(gated.status, 200, JSON.stringify(await gated.clone().json()))
    const body = await gated.json() as { requestId?: string | null }
    assert.ok(body.requestId, `gated submit returns the flow run id, got ${JSON.stringify(body)}`)
    assert.equal((await docState(org.orgId, billId)).status, 'pending_approval')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('vendor-bill direct post with the requirement ON and no flow refuses before posting', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await setRequirement(org.orgId, true)
    const actor = await seedClerk(org.orgId, ['ap.read', 'ap.create', 'ap.post'])
    const billId = await seedDraftBill(org.orgId, actor, org.subsidiaryId, org.vendorId, org.date)
    state.user = actorFor(actor, org.orgId)

    const refused = await withOrgContext(org.orgId, () => POST(request({ action: 'post', documentId: billId })))
    assert.equal(refused.status, 422, JSON.stringify(await refused.clone().json()))
    assert.equal((await refused.json() as { error?: string }).error, VENDOR_BILL_APPROVAL_REQUIRED_MESSAGE)
    assert.equal((await docState(org.orgId, billId)).status, 'draft')
    const journals = await withBypassContext(() => db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries where org_id = ${org.orgId}`))
    assert.equal(journals.rows[0]?.n, 0, 'a refused release posts nothing')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('turning the requirement ON leaves already-released bills untouched', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await setRequirement(org.orgId, false)
    const actor = await seedClerk(org.orgId, ['ap.read', 'ap.create'])
    const billId = await seedDraftBill(org.orgId, actor, org.subsidiaryId, org.vendorId, org.date)
    state.user = actorFor(actor, org.orgId)
    await withOrgContext(org.orgId, () => POST(request({ action: 'submit', documentId: billId })))
    assert.equal((await docState(org.orgId, billId)).status, 'approved')

    // The switch flips after the release: history is not reinterpreted.
    await setRequirement(org.orgId, true)
    const again = await withOrgContext(org.orgId, () => POST(request({ action: 'submit', documentId: billId })))
    assert.equal(again.status, 422)
    assert.match((await again.json() as { error?: string }).error ?? '', /not draft/)
    assert.equal((await docState(org.orgId, billId)).status, 'approved')
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
