import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// A party document's receivable/payable account choice is a structural
// header value (custom.controlAccountId), not a registered custom field: the
// real PATCH must persist it, refuse an account of the wrong type with a
// field error, and clear it back to the party default.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __controlAccountRoundTripState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '../../../../lib/authz' || specifier === '@/lib/authz') return virtual(`
      export async function getAuthz() {
        const s = globalThis.__controlAccountRoundTripState;
        return { user: { orgId: s.orgId, id: s.actorId, isSuperAdmin: false }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
      }
      export { can, guardSubsidiaryScope, subsidiariesInScope } from '${root}web/lib/authz.ts'
    `)
    if (specifier.startsWith('@openbooks/engine/')) return next(root + specifier.slice('@openbooks/'.length), context)
    return next(specifier, context)
  },
})
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { documentRevisionCounterSql } = await import('../../../../../engine/src/records/revision.ts')
const { PATCH } = await import('./route.ts')
const { installTrustedTestDatabaseBypass } = await import('@openbooks/engine/src/testing/database-bypass.ts')
installTrustedTestDatabaseBypass()

async function revision(orgId: string, id: string): Promise<string> {
  return (await db.execute<{ revision: string }>(sql`select ${documentRevisionCounterSql(sql`revision_seq`)} as revision from documents where id=${id} and org_id=${orgId}`)).rows[0]!.revision
}

async function patchDoc(orgId: string, id: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await withOrgContext(orgId, () => PATCH(
    new Request(`http://documents.test/api/documents/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  ))
  return { status: response.status, json: await response.json().catch(() => null) }
}

async function storedCustom(orgId: string, id: string): Promise<Record<string, unknown>> {
  return (await db.execute<{ custom: Record<string, unknown> }>(sql`select custom from documents where id=${id} and org_id=${orgId}`)).rows[0]!.custom
}

async function account(orgId: string, number: string, name: string, type: string): Promise<string> {
  const id = randomUUID()
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${id}, ${orgId}, ${number}, ${name}, ${type}, false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`)
  return id
}

async function draft(orgId: string, kind: string, number: string, partyId: string, subsidiaryId: string, date: string): Promise<string> {
  const id = randomUUID()
  await db.execute(sql`
    insert into documents (id, org_id, kind, status, document_number, document_date, party_id, subsidiary_id, currency, subtotal, tax_total, total, custom)
    values (${id}, ${orgId}, ${kind}, 'draft', ${number}, ${date}, ${partyId}, ${subsidiaryId}, 'CAD', '0', '0', '0', '{}'::jsonb)`)
  return id
}

test('an invoice receivable choice persists, refuses a non-receivable account, and clears to the default', async () => {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  try {
    const retainage = await account(org.orgId, '1110', 'Retainage Receivable', 'asset_receivable')
    const invoiceId = await draft(org.orgId, 'customer_invoice', 'INV-00001', org.customerId, org.subsidiaryId, org.date)

    const saved = await patchDoc(org.orgId, invoiceId, { expectedUpdatedAt: await revision(org.orgId, invoiceId), custom: { controlAccountId: retainage } })
    assert.equal(saved.status, 200, JSON.stringify(saved.json))
    assert.equal((await storedCustom(org.orgId, invoiceId)).controlAccountId, retainage)

    const kept = await patchDoc(org.orgId, invoiceId, { expectedUpdatedAt: await revision(org.orgId, invoiceId), memo: 'still retainage' })
    assert.equal(kept.status, 200, JSON.stringify(kept.json))
    assert.equal((await storedCustom(org.orgId, invoiceId)).controlAccountId, retainage)

    // An income account is not a receivable: refused by name, nothing stored.
    const refused = await patchDoc(org.orgId, invoiceId, { expectedUpdatedAt: await revision(org.orgId, invoiceId), custom: { controlAccountId: org.accounts.revenue } })
    assert.equal(refused.status, 422, JSON.stringify(refused.json))
    assert.match(JSON.stringify(refused.json), /receivable account/)
    assert.equal((await storedCustom(org.orgId, invoiceId)).controlAccountId, retainage)

    const cleared = await patchDoc(org.orgId, invoiceId, { expectedUpdatedAt: await revision(org.orgId, invoiceId), custom: { controlAccountId: null } })
    assert.equal(cleared.status, 200, JSON.stringify(cleared.json))
    assert.ok(!('controlAccountId' in (await storedCustom(org.orgId, invoiceId))), 'clearing must restore the default resolution')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('a bill payable choice accepts only payable accounts', async () => {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  try {
    const holdback = await account(org.orgId, '2010', 'Holdback Payable', 'liability_payable')
    const billId = await draft(org.orgId, 'vendor_bill', 'BILL-00001', org.vendorId, org.subsidiaryId, org.date)
    const receivable = await patchDoc(org.orgId, billId, { expectedUpdatedAt: await revision(org.orgId, billId), custom: { controlAccountId: org.accounts.ar } })
    assert.equal(receivable.status, 422, JSON.stringify(receivable.json))
    assert.match(JSON.stringify(receivable.json), /payable account/)
    const saved = await patchDoc(org.orgId, billId, { expectedUpdatedAt: await revision(org.orgId, billId), custom: { controlAccountId: holdback } })
    assert.equal(saved.status, 200, JSON.stringify(saved.json))
    assert.equal((await storedCustom(org.orgId, billId)).controlAccountId, holdback)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
