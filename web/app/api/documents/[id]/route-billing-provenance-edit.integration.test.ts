import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// F-t04-003: a draft invoice generated from a T&M billing request carries
// billed-time provenance (time_entries.invoiced_by_line_id -> its lines).
// The generic editor replaces lines by delete-and-reinsert, so saving the
// draft — e.g. after pricing its $0 lines — died on the provenance FK as a
// raw 500 with an empty body. Only the session gate is stubbed; handler,
// service, and storage are real.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __billingProvenanceEditState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/authz') return virtual(`
      export async function getAuthz() {
        const s = globalThis.__billingProvenanceEditState;
        return { user: { orgId: s.orgId, id: s.actorId, isSuperAdmin: false }, permissions: [], allowedSubsidiaryIds: null };
      }
      export function can() { return true }
      export function guardSubsidiaryScope() { return null }
      export function subsidiariesInScope() { return true }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { documentRevisionCounterSql } = await import('../../../../lib/documents.ts')
const { createBillingRequest } = await import('../../../../lib/billing-requests.ts')
const { generateInvoiceFromBillingRequest } = await import('../../../../lib/billing.ts')
const { PATCH } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function revision(orgId: string, id: string): Promise<string> {
  return (await db.execute<{ revision: string }>(sql`select ${documentRevisionCounterSql(sql`revision_seq`)} as revision from documents where id=${id} and org_id=${orgId}`)).rows[0]!.revision
}

async function patchDoc(orgId: string, id: string, body: unknown): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(orgId, () => PATCH(
      new Request(`http://documents.test/api/documents/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    ))
    return { status: response.status, json: await response.json().catch(() => null) }
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } }
  }
}

type FixtureOrg = { orgId: string; subsidiaryId: string; date: string; customerId: string; accounts: { revenue: string }; items: { service: string } }

/** A T&M project with approved, unpriced 8h time entries, billed to a draft invoice. */
async function billedTimeInvoice(org: FixtureOrg, actor: string, entryCount = 1) {
  await db.execute(sql`update orgs set settings = jsonb_set(settings, '{controlAccounts,projectRevenue}', to_jsonb(${org.accounts.revenue}::text), true) where id = ${org.orgId}`)
  const project = randomUUID(), employee = randomUUID()
  await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom) values (${project},${org.orgId},${org.subsidiaryId},'TM','Time job',${org.customerId},'active',true,'{}'::jsonb)`)
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id) values (${employee},${org.orgId},'employee','Billable worker',${org.subsidiaryId})`)
  const entries: string[] = []
  for (let i = 0; i < entryCount; i++) {
    const entry = randomUUID()
    await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,project_id,is_billable,status) values (${entry},${org.orgId},${employee},${org.date},8,${project},true,'approved')`)
    entries.push(entry)
  }
  const req = await createBillingRequest(org.orgId, actor, { projectId: project, basis: 'time_selection', selectedTimeEntryIds: entries, cutoffDate: org.date, backupRequired: false })
  const invoice = await generateInvoiceFromBillingRequest(org.orgId, actor, req.id)
  return { project, entry: entries[0]!, entries, invoiceId: invoice.id }
}

test('a billing-request invoice draft saves after its lines are priced', { skip: !DB }, async () => {
  await withBypassContext(async () => {
  const org = await createScratchOrg()
  try {
    state.orgId = org.orgId
    state.actorId = await createScratchUser(org.orgId, 'Billing controller', 'reviewer')
    const { entry, invoiceId } = await billedTimeInvoice(org, state.actorId)
    const generated = (await db.execute<{ id: string; item_id: string | null; amount: string }>(sql`select id, item_id, amount::text as amount from document_lines where org_id=${org.orgId} and document_id=${invoiceId} order by line_number`)).rows
    assert.equal(generated.length, 1)
    assert.equal(generated[0]!.item_id, null)
    assert.equal(generated[0]!.amount, '0.0000')

    // The tester's flow: price the $0 line through the supported picker path.
    const saved = await patchDoc(org.orgId, invoiceId, {
      expectedUpdatedAt: await revision(org.orgId, invoiceId),
      lines: [{
        accountId: org.accounts.revenue,
        itemId: org.items.service,
        description: 'Billable work',
        quantity: '8',
        unitPrice: '95',
        amount: '760',
      }],
    })
    assert.equal(saved.status, 200, `pricing the generated line must save, got ${saved.status}: ${JSON.stringify(saved.json)}`)
    const stored = (await db.execute<{ item_id: string; amount: string; bill_rate: string; bill_amount: string }>(sql`select item_id, amount::text as amount, bill_rate::text as bill_rate, bill_amount::text as bill_amount from document_lines where org_id=${org.orgId} and document_id=${invoiceId}`)).rows
    assert.equal(stored.length, 1)
    assert.equal(stored[0]!.item_id, org.items.service)
    assert.equal(stored[0]!.amount, '760.0000')
    // The billable-value snapshot follows the edit, so project financials
    // read the priced line instead of a stale zero.
    assert.equal(stored[0]!.bill_rate, '95.0000')
    assert.equal(stored[0]!.bill_amount, '760.0000')
    // Provenance survives the line replacement: the entry stays billed to
    // this invoice instead of stranding or silently unbilled time.
    const provenance = (await db.execute<{ status: string; line_document: string | null }>(sql`select billing_status as status, (select document_id::text from document_lines where id = te.invoiced_by_line_id and org_id = te.org_id) as line_document from time_entries te where id=${entry} and org_id=${org.orgId}`)).rows[0]!
    assert.equal(provenance.status, 'billed')
    assert.equal(provenance.line_document, invoiceId)
    const total = (await db.execute<{ total: string }>(sql`select total::text as total from documents where id=${invoiceId} and org_id=${org.orgId}`)).rows[0]!.total
    assert.equal(total, '760.0000')
  } finally {
    await dropScratchOrg(org.orgId)
  }
  })
})

test('removing a billed-time line from the draft frees its entry', { skip: !DB }, async () => {
  await withBypassContext(async () => {
  const org = await createScratchOrg()
  try {
    state.orgId = org.orgId
    state.actorId = await createScratchUser(org.orgId, 'Billing controller', 'reviewer')
    const { entries, invoiceId } = await billedTimeInvoice(org, state.actorId, 2)
    // Generated lines order by (worked_on, id) with random UUIDs, so either
    // entry may sit on line 1 — capture the order before the edit deletes
    // the generated rows.
    const order = (await db.execute<{ time_entry_id: string }>(sql`select time_entry_id from document_lines where document_id = ${invoiceId} and org_id = ${org.orgId} and time_entry_id is not null order by line_number`)).rows.map((row) => row.time_entry_id)
    assert.deepEqual([...order].sort(), [...entries].sort())
    const saved = await patchDoc(org.orgId, invoiceId, {
      expectedUpdatedAt: await revision(org.orgId, invoiceId),
      lines: [{
        accountId: org.accounts.revenue,
        description: 'Manual replacement',
        quantity: '1',
        unitPrice: '100',
        amount: '100',
      }],
    })
    assert.equal(saved.status, 200, `replacing the generated lines must save, got ${saved.status}: ${JSON.stringify(saved.json)}`)
    // The replacement inherits positionally, not by creation order: the entry
    // on line 1 stays billed to the invoice, the dropped line's entry returns
    // to unbilled instead of pointing at a deleted row or stranding.
    const keptId = order[0]!
    const freedId = entries.find((id) => id !== keptId)!
    const kept = (await db.execute<{ status: string; line_document: string | null }>(sql`select billing_status as status, (select document_id::text from document_lines where id = te.invoiced_by_line_id and org_id = te.org_id) as line_document from time_entries te where id=${keptId} and org_id=${org.orgId}`)).rows[0]!
    assert.deepEqual(kept, { status: 'billed', line_document: invoiceId })
    const freed = (await db.execute<{ status: string; link: string | null }>(sql`select billing_status as status, invoiced_by_line_id::text as link from time_entries where id=${freedId} and org_id=${org.orgId}`)).rows[0]!
    assert.deepEqual(freed, { status: 'unbilled', link: null })
  } finally {
    await dropScratchOrg(org.orgId)
  }
  })
})
