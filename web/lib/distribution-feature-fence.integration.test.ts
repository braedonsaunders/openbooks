import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'

/**
 * The distribution modules' OFF state, one fence for every surface: with the
 * feature off the nav entry is gone, the page redirects to the Features-page
 * explanation, every API route answers a bare 404, the engine refuses by name
 * with the Features remedy, Setup writes are refused, and the assistant tool
 * is withheld. Turning the feature off and on again preserves every row and
 * its audit history. Later distribution surfaces add their own section below
 * and reuse these helpers.
 */

const DB = Boolean(process.env.OPENBOOKS_DB_URL)
const state: { authz: unknown } = { authz: null }
Object.assign(globalThis, { __distributionFence: state })
const AUTHZ_DOUBLE = `data:text/javascript,${encodeURIComponent(`
const current = () => globalThis.__distributionFence.authz
export async function getAuthz() { return current() }
export async function guardPermission() { return current() }
export async function requirePermission() { return current() }
export function can() { return true }
export function guardUnrestrictedScope() { return null }
export async function guardRootSubsidiaryScope() { return null }
export function guardSubsidiaryScope() { return null }
`)}`
registerHooks({ resolve(specifier, context, next) {
  const parent = context.parentURL ?? ''
  const authzImport = specifier === './authz' || specifier.endsWith('/lib/authz')
  const fenced = ['/lib/api/route', '/lib/feature-gates', '/warehouse/view', '/api/admin/setup/'].some((path) => parent.includes(path))
  if (authzImport && fenced) return { shortCircuit: true, url: AUTHZ_DOUBLE }
  return next(specifier, context)
} })

const setup = await import('../app/api/admin/setup/[entity]/route')
const warehousesRoute = await import('../app/api/warehouses/route')
const warehouseRoute = await import('../app/api/warehouses/[id]/route')
const lifecycleRoute = await import('../app/api/warehouses/[id]/lifecycle/route')
const putawayRoute = await import('../app/api/warehouses/[id]/putaway/route')
const { loadWarehouse } = await import('../app/(app)/warehouse/view')
const { resolveNav } = await import('./nav/resolve')
const { resolvedFeatureState } = await import('./features')
const { canRunTool } = await import('./assistant/gate')
const { WAREHOUSE_TOOLS } = await import('./assistant/tools-warehouses')
const { receiveInventory } = await import('@openbooks/engine/src/inventory/movements.ts')
const { resolvePutawayLocation } = await import('@openbooks/engine/src/inventory/putaway.ts')
const warehouses = await import('@openbooks/engine/src/inventory/warehouses.ts')

const FEATURES_REMEDY = /turn on Warehousing in Company Settings → Features/

async function setFeature(orgId: string, key: string, on: boolean) {
  await withBypassContext(() => db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || jsonb_build_object(${key}::text, ${on}::boolean))
     where id = ${orgId}`))
}

async function withFencedOrg(run: (org: ScratchOrg, actorId: string) => Promise<void>) {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actorId = await withBypassContext(async () => (await seedFlowActors(org.orgId)).adminId)
    state.authz = {
      user: { orgId: org.orgId, id: actorId, roles: [] },
      permissions: new Set(['assistant.use', 'items.read', 'items.warehouses', 'items.post', 'admin.setup.manage']),
      allowedSubsidiaryIds: null,
    }
    await run(org, actorId)
  } finally {
    state.authz = null
    await dropScratchOrg(org.orgId)
  }
}

function json(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://fence.local${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function setupWrite(method: 'POST' | 'PATCH', entity: string, body: Record<string, unknown>) {
  const request = json(method, `/api/admin/setup/${entity}`, body, method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {})
  return setup[method](request, { params: Promise.resolve({ entity }) })
}

async function navHrefs(orgId: string): Promise<string[]> {
  const groups = await resolveNav(orgId, () => true, ['admin'], (key) => key, () => true)
  return groups.flatMap((group) => group.items.map((item) => item.href))
}

async function engineRefusal(run: () => Promise<unknown>) {
  await assert.rejects(withBypassContext(run), (error: unknown) =>
    error instanceof warehouses.WarehouseRefusal && error.code === 'warehousing_disabled' && FEATURES_REMEDY.test(error.remedy))
}

async function evidence(orgId: string) {
  return withBypassContext(async () => (await db.execute<{ state: unknown }>(sql`select jsonb_build_object(
    'warehouses', (select jsonb_agg(to_jsonb(w) order by stock_location_id) from warehouses w where org_id = ${orgId}),
    'rules', (select jsonb_agg(to_jsonb(r) order by id) from putaway_rules r where org_id = ${orgId}),
    'audit', (select jsonb_agg(to_jsonb(a) order by id) from audit_log a where org_id = ${orgId} and table_name in ('warehouses', 'putaway_rules'))
  ) as state`)).rows[0]!.state)
}

// ---- Warehousing ----------------------------------------------------------

test('warehousing off hides every surface, preserves its rows, and keeps a suspension in force', { skip: !DB }, async () => {
  await withFencedOrg(async (org, actorId) => {
    await setFeature(org.orgId, 'warehousing', true)
    assert.ok((await navHrefs(org.orgId)).includes('/warehouse'), 'the nav entry is present while the feature is on')
    const warehouse = await withBypassContext(() => warehouses.createWarehouse(org.orgId, actorId, {
      code: 'WH-OFF', name: 'Fenced warehouse', locationId: org.locationId,
    }))
    const bin = randomUUID()
    await withBypassContext(() => db.execute(sql`
      insert into stock_locations (id, org_id, location_id, parent_id, code, kind, is_active)
      values (${bin}, ${org.orgId}, ${org.locationId}, ${warehouse.id}, 'OFF-A1', 'bin', true)`))
    const rule = await setupWrite('POST', 'putaway-rules', {
      warehouseId: warehouse.id, sequence: 1, strategy: 'fixed-bin', targetLocationId: bin,
    })
    assert.equal(rule.status, 200, JSON.stringify(await rule.clone().json()))
    const ruleId = String((await rule.json()).id)
    await withBypassContext(() => warehouses.activateWarehouse(org.orgId, actorId, { warehouseId: warehouse.id }))
    await withBypassContext(() => warehouses.suspendWarehouse(org.orgId, actorId, { warehouseId: warehouse.id, reason: 'annual stocktake' }))
    const before = await evidence(org.orgId)

    await setFeature(org.orgId, 'warehousing', false)
    assert.equal((await navHrefs(org.orgId)).includes('/warehouse'), false, 'the nav entry disappears')
    await assert.rejects(loadWarehouse({}), (error: unknown) =>
      String((error as { digest?: string }).digest).includes('/feature-required?feature=warehousing'))

    const id = warehouse.id
    const params = { params: Promise.resolve({ id }) }
    const responses = [
      await warehousesRoute.GET(json('GET', '/api/warehouses')),
      await warehousesRoute.POST(json('POST', '/api/warehouses', { code: 'WH-NEW', name: 'New', locationId: org.locationId })),
      await warehouseRoute.GET(json('GET', `/api/warehouses/${id}`), params),
      await warehouseRoute.PATCH(json('PATCH', `/api/warehouses/${id}`, { name: 'Renamed' }), params),
      await lifecycleRoute.POST(json('POST', `/api/warehouses/${id}/lifecycle`, { action: 'activate' }), params),
      await putawayRoute.POST(json('POST', `/api/warehouses/${id}/putaway`, {
        stagingLocationId: bin, itemId: org.items.fifo, subsidiaryId: org.subsidiaryId, quantity: '1', idempotencyKey: randomUUID(),
      }), params),
    ]
    for (const response of responses) {
      assert.equal(response.status, 404)
      assert.deepEqual(await response.json(), { error: 'not_found' })
    }

    await engineRefusal(() => warehouses.listWarehouses(db, org.orgId))
    await engineRefusal(() => warehouses.createWarehouse(org.orgId, actorId, { code: 'WH-NEW', name: 'New', locationId: org.locationId }))
    await engineRefusal(() => warehouses.activateWarehouse(org.orgId, actorId, { warehouseId: id }))
    await engineRefusal(() => resolvePutawayLocation(db, org.orgId, { itemId: org.items.fifo, quantity: '1', warehouseId: id, subsidiaryId: org.subsidiaryId }))

    assert.equal((await setupWrite('PATCH', 'warehouses', { id, name: 'Renamed' })).status, 404)
    assert.equal((await setupWrite('PATCH', 'putaway-rules', { id: ruleId, warehouseId: id, sequence: 2, strategy: 'fixed-bin', targetLocationId: bin })).status, 404)
    assert.equal((await setupWrite('POST', 'putaway-rules', { warehouseId: id, sequence: 3, strategy: 'fixed-bin', targetLocationId: bin })).status, 404)

    const features = await resolvedFeatureState(org.orgId)
    for (const tool of WAREHOUSE_TOOLS) {
      assert.equal(canRunTool(state.authz as never, tool, features), false, `${tool.name} is withheld`)
    }
    await engineRefusal(() => WAREHOUSE_TOOLS[0]!.execute({}, state.authz as never))

    await assert.rejects(
      withBypassContext(() => receiveInventory(org.orgId, actorId, {
        itemId: org.items.fifo, stockLocationId: bin, quantity: '1', unitCost: '1.00',
        subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
      })),
      (error: unknown) => error instanceof warehouses.WarehouseRefusal
        && error.remedy === 'turn on Warehousing in Company Settings → Features, then reactivate WH-OFF'
        && /WH-OFF is suspended and refuses inbound movements/.test(error.message),
    )

    await setFeature(org.orgId, 'warehousing', true)
    assert.deepEqual(await evidence(org.orgId), before, 'off and on again changes no warehouse, rule, status or audit row')
  })
})
