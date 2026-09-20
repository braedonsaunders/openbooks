import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// F-t07-003 pickers: the sales-order draft writer persists a validated line
// warehouse and stamps the silent single-location default. Only the session
// gate is stubbed; handler, service, and storage are real.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __orderStockState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
const authzStub = virtual(`
  export async function guardPermission() {
    const s = globalThis.__orderStockState;
    return { user: { orgId: s.orgId, id: s.actorId, roles: [] }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
  }
  export async function getAuthz() {
    const s = globalThis.__orderStockState;
    return { user: { orgId: s.orgId, id: s.actorId, roles: [] }, permissions: new Set(['*']), allowedSubsidiaryIds: null };
  }
  export function guardSubsidiaryScope() { return null }
  export function subsidiariesInScope() { return true }
  export function can() { return true }
`)
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    // The session gate is the only stub: feature-gates spells it './authz',
    // the order handlers '../../../lib/authz'. web/lib holds no other
    // authz module, so both spellings name the same gate.
    if (specifier === './authz' || specifier === '../../../lib/authz') return authzStub
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { documentRevisionCounterSql } = await import("../../../../../engine/src/records/revision.ts");
const { PATCH } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function makeDraftOrder(org: { orgId: string; subsidiaryId: string; date: string }): Promise<string> {
  const id = randomUUID()
  await withBypassContext(() => db.execute(sql`
    insert into documents (id, org_id, kind, document_number, subsidiary_id, document_date, currency, fx_rate, status, subtotal, tax_total, total, custom)
    values (${id}, ${org.orgId}, 'sales_order', ${'SO-' + id.slice(0, 8)}, ${org.subsidiaryId}, ${org.date}, 'CAD', 1, 'draft', '0', '0', '0', '{}'::jsonb)`))
  return id
}

async function revision(orgId: string, id: string): Promise<string> {
  return (
    await withBypassContext(() => db.execute<{ revision: string }>(sql`
      select ${documentRevisionCounterSql(sql`revision_seq`)} as revision from documents where id = ${id} and org_id = ${orgId}`))
  ).rows[0]!.revision
}

function errOf(json: unknown): string {
  return typeof json === 'object' && json !== null && 'error' in json ? String(json.error) : ''
}

async function patchOrder(orgId: string, id: string, body: unknown): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(orgId, () =>
      PATCH(
        new Request(`http://orders.test/api/sales-orders/${id}`, {
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
    itemId,
    accountId,
    description: 'Widget',
    quantity: '2',
    unit: 'ea',
    unitPrice: '89',
    ...(stockLocationId === undefined ? {} : { stockLocationId }),
  }
}

test('order draft PATCH persists an explicit line warehouse', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    state.orgId = org.orgId
    state.actorId = randomUUID()
    const id = await makeDraftOrder(org)
    const res = await patchOrder(org.orgId, id, {
      expectedUpdatedAt: await revision(org.orgId, id),
      lines: [line(org.items.movingAvg, org.accounts.revenue, org.stockLocationId)],
    })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.deepEqual(await storedLocations(org.orgId, id), [org.stockLocationId])
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('order draft PATCH refuses a foreign line warehouse with a domain error', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    state.orgId = org.orgId
    state.actorId = randomUUID()
    const id = await makeDraftOrder(org)
    const res = await patchOrder(org.orgId, id, {
      expectedUpdatedAt: await revision(org.orgId, id),
      lines: [line(org.items.movingAvg, org.accounts.revenue, randomUUID())],
    })
    assert.equal(res.status, 422, JSON.stringify(res.json))
    assert.match(errOf(res.json), /active warehouse/)
    assert.deepEqual(await storedLocations(org.orgId, id), [])
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('order draft PATCH leaves a blank warehouse blank with several locations, stamps it with one', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    state.orgId = org.orgId
    state.actorId = randomUUID()
    const ambiguous = await makeDraftOrder(org)
    const kept = await patchOrder(org.orgId, ambiguous, {
      expectedUpdatedAt: await revision(org.orgId, ambiguous),
      lines: [line(org.items.movingAvg, org.accounts.revenue)],
    })
    assert.equal(kept.status, 200, JSON.stringify(kept.json))
    assert.deepEqual(await storedLocations(org.orgId, ambiguous), [null])
    await withBypassContext(() => db.execute(sql`
      update stock_locations set is_active = false where id = ${org.stockLocationId2} and org_id = ${org.orgId}`))
    const stamped = await makeDraftOrder(org)
    const res = await patchOrder(org.orgId, stamped, {
      expectedUpdatedAt: await revision(org.orgId, stamped),
      lines: [line(org.items.movingAvg, org.accounts.revenue)],
    })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.deepEqual(await storedLocations(org.orgId, stamped), [org.stockLocationId])
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
