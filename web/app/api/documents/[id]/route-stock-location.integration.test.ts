import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// F-t07-003 pickers: the generic document edit writer persists an explicit
// line warehouse and stamps the silent single-location default on blank
// stocked lines. Only the session gate is stubbed; handler, service, and
// storage are real.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __documentStockState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/authz')
      return virtual(`
        export async function getAuthz() {
          const s = globalThis.__documentStockState;
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
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { documentRevisionCounterSql } = await import('../../../../lib/documents.ts')
const { PATCH } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function makeDraftInvoice(org: { orgId: string; customerId: string; subsidiaryId: string; date: string }): Promise<string> {
  const id = randomUUID()
  await withBypassContext(() => db.execute(sql`
    insert into documents (id, org_id, kind, status, document_number, party_id, subsidiary_id, document_date, currency, subtotal, tax_total, total, custom)
    values (${id}, ${org.orgId}, 'customer_invoice', 'draft', ${'INV-' + id.slice(0, 8)}, ${org.customerId}, ${org.subsidiaryId}, ${org.date}, 'CAD', '0', '0', '0', '{}'::jsonb)`))
  return id
}

async function revision(orgId: string, id: string): Promise<string> {
  return (
    await withBypassContext(() => db.execute<{ revision: string }>(sql`
      select ${documentRevisionCounterSql(sql`revision_seq`)} as revision from documents where id = ${id} and org_id = ${orgId}`))
  ).rows[0]!.revision
}

async function patchDoc(orgId: string, id: string, body: unknown): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(orgId, () =>
      PATCH(
        new Request(`http://documents.test/api/documents/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id }) },
      ),
    )
    return { status: response.status, json: await response.json().catch(() => null) }
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } }
  }
}

async function storedLocations(orgId: string, id: string): Promise<(string | null)[]> {
  return (
    await withBypassContext(() => db.execute<{ stock_location_id: string | null }>(sql`
      select stock_location_id from document_lines where document_id = ${id} and org_id = ${orgId} order by line_number`))
  ).rows.map((row) => row.stock_location_id)
}

function line(itemId: string, accountId: string, stockLocationId?: string | null) {
  return {
    accountId,
    itemId,
    description: 'Widget',
    quantity: '1',
    amount: '89',
    ...(stockLocationId === undefined ? {} : { stockLocationId }),
  }
}

test('invoice PATCH persists an explicit line warehouse', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    state.orgId = org.orgId
    state.actorId = randomUUID()
    const id = await makeDraftInvoice(org)
    const res = await patchDoc(org.orgId, id, {
      expectedUpdatedAt: await revision(org.orgId, id),
      lines: [line(org.items.movingAvg, org.accounts.revenue, org.stockLocationId)],
    })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.deepEqual(await storedLocations(org.orgId, id), [org.stockLocationId])
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('invoice PATCH leaves a blank warehouse blank with several locations, stamps it with one', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    state.orgId = org.orgId
    state.actorId = randomUUID()
    const ambiguous = await makeDraftInvoice(org)
    const kept = await patchDoc(org.orgId, ambiguous, {
      expectedUpdatedAt: await revision(org.orgId, ambiguous),
      lines: [line(org.items.movingAvg, org.accounts.revenue)],
    })
    assert.equal(kept.status, 200, JSON.stringify(kept.json))
    assert.deepEqual(await storedLocations(org.orgId, ambiguous), [null])
    await withBypassContext(() => db.execute(sql`
      update stock_locations set is_active = false where id = ${org.stockLocationId2} and org_id = ${org.orgId}`))
    const stamped = await makeDraftInvoice(org)
    const res = await patchDoc(org.orgId, stamped, {
      expectedUpdatedAt: await revision(org.orgId, stamped),
      lines: [line(org.items.movingAvg, org.accounts.revenue)],
    })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.deepEqual(await storedLocations(org.orgId, stamped), [org.stockLocationId])
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('invoice PATCH stamps no default for a non-stocked line', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    state.orgId = org.orgId
    state.actorId = randomUUID()
    await withBypassContext(() => db.execute(sql`
      update stock_locations set is_active = false where id = ${org.stockLocationId2} and org_id = ${org.orgId}`))
    const id = await makeDraftInvoice(org)
    const res = await patchDoc(org.orgId, id, {
      expectedUpdatedAt: await revision(org.orgId, id),
      lines: [line(org.items.service, org.accounts.revenue)],
    })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.deepEqual(await storedLocations(org.orgId, id), [null])
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
