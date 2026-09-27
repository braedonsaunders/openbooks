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
 * its audit history. Later sections add imports to the top import block, never
 * after a test registration, so test discovery completes before execution.
 */

const DB = Boolean(process.env.OPENBOOKS_DB_URL)
const state: { authz: unknown } = { authz: null }
Object.assign(globalThis, { __distributionFence: state })
const AUTHZ_DOUBLE = `data:text/javascript,${encodeURIComponent(`
const current = () => globalThis.__distributionFence.authz
export async function getAuthz() { return current() }
export function assertCan() {}
export async function guardPermission() { return current() }
export async function requirePermission() { return current() }
export function can() { return true }
export function guardUnrestrictedScope() { return null }
export async function guardRootSubsidiaryScope() { return null }
export function guardSubsidiaryScope() { return null }
`)}`
// Report loaders read their copy through next-intl; outside a Next request the
// key stands in for the translation.
const INTL_DOUBLE = `data:text/javascript,${encodeURIComponent(`
export async function getTranslations() { return (key) => key }
export async function getLocale() { return 'en' }
`)}`
registerHooks({ resolve(specifier, context, next) {
  const parent = context.parentURL ?? ''
  const authzImport = specifier === './authz' || specifier.endsWith('/lib/authz')
  const fenced = ['/lib/api/route', '/lib/feature-gates', '/warehouse/view', '/api/admin/setup/', '/reports/',
    '/api/reports/statement/', '/picks/view', '/shipments/view', '/sales-orders/view', '/returns/view', '/api/returns/'].some((path) => parent.includes(path))
  if (authzImport && fenced) return { shortCircuit: true, url: AUTHZ_DOUBLE }
  const reportCopy = ['/reports/', '/lib/availability-report'].some((path) => parent.includes(path))
  if (specifier === 'next-intl/server' && reportCopy) return { shortCircuit: true, url: INTL_DOUBLE }
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
const availability = await import('@openbooks/engine/src/inventory/availability.ts')
const { replenishmentProposals } = await import('@openbooks/engine/src/inventory/replenishment.ts')
const { loadAvailability } = await import('../app/(app)/reports/availability/view')
const { loadReplenishment } = await import('../app/(app)/reports/replenishment/view')
const { loadReportsHub } = await import('../app/(app)/reports/view')
const statementExport = await import('../app/api/reports/statement/[kind]/export/route')
const returnsRoute = await import('../app/api/returns/route')
const returnRoute = await import('../app/api/returns/[id]/route')
const returnReceiveRoute = await import('../app/api/returns/[id]/receive/route')
const returnInspectRoute = await import('../app/api/returns/[id]/inspect/route')
const returnRejectRoute = await import('../app/api/returns/[id]/reject/route')
const returnEmailRoute = await import('../app/api/returns/[id]/email/route')
const returnSourcesRoute = await import('../app/api/returns/sources/route')
const { loadReturns } = await import('../app/(app)/returns/view')
const returnEngine = await import('@openbooks/engine/src/sales/returns.ts')
const { RETURNS_TOOLS } = await import('./assistant/tools-returns')
const pickRoutes = await import('../app/api/picks/route')
const pickRoute = await import('../app/api/picks/[id]/route')
const pickReleaseRoute = await import('../app/api/picks/[id]/release/route')
const pickVoidRoute = await import('../app/api/picks/[id]/void/route')
const pickCandidatesRoute = await import('../app/api/picks/candidates/route')
const shipmentRoutes = await import('../app/api/shipments/route')
const shipmentRoute = await import('../app/api/shipments/[id]/route')
const shipmentCompleteRoute = await import('../app/api/shipments/[id]/complete/route')
const shipmentVoidRoute = await import('../app/api/shipments/[id]/void/route')
const shipmentTrackingRoute = await import('../app/api/shipments/[id]/send-tracking/route')
const backordersRoute = await import('../app/api/sales-orders/[id]/backorders/route')
const { loadPicks } = await import('../app/(app)/picks/view')
const { loadShipments } = await import('../app/(app)/shipments/view')
const { orderFulfillmentActions } = await import('../app/(app)/sales-orders/view')
const { enabledListSource } = await import('./list/sources')
const { guardReportEntity, hiddenReportEntityKeys } = await import('./report-authz')
const { FULFILLMENT_TOOLS } = await import('./assistant/tools-fulfillment')
const fulfillment = await import('@openbooks/engine/src/sales/fulfillment.ts')
const { backorderPosition, cancelOrderLineRemainder } = await import('@openbooks/engine/src/sales/backorders.ts')
const { salesOrderLineRemainders } = await import('@openbooks/engine/src/records/order-line-remainders.ts')

const FEATURES_REMEDY = /turn on Warehousing in Company Settings → Features/

async function setFeature(orgId: string, key: string, on: boolean) {
  const result = await withBypassContext(() => db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || jsonb_build_object(${key}::text, ${on}::boolean))
     where id = ${orgId} returning id`))
  assert.equal(result.rows.length, 1, `feature setting for ${key} must be stored`)
}

async function withFencedOrg(run: (org: ScratchOrg, actorId: string) => Promise<void>) {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actorId = await withBypassContext(async () => (await seedFlowActors(org.orgId)).adminId)
    state.authz = {
      user: { orgId: org.orgId, id: actorId, roles: [] },
      permissions: new Set(['assistant.use', 'items.read', 'items.warehouses', 'items.post', 'admin.setup.manage', 'orders.fulfill', 'ar.create', 'ar.read']),
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
    assert.deepEqual(await WAREHOUSE_TOOLS[0]!.execute({}, state.authz as never), { ok: false, error: 'warehousing_feature_disabled' })

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

// ---- Availability and replenishment -----------------------------------------

const STOCK_REPORTS = ['/reports/availability', '/reports/replenishment']

async function hubHrefs(): Promise<string[]> {
  return (await loadReportsHub()).groups.flatMap((group) => group.cards.map((card) => card.href))
}

test('availability and replenishment vanish with warehousing, and releasable backorders with fulfillment', { skip: !DB }, async () => {
  await withFencedOrg(async (org) => {
    const toolNamed = (name: string) => WAREHOUSE_TOOLS.find((tool) => tool.name === name)!
    const itemTool = toolNamed('get_item_availability')
    const replenishmentTool = toolNamed('list_replenishment_proposals')
    const query = { subsidiaryId: org.subsidiaryId }

    await setFeature(org.orgId, 'warehousing', true)
    await setFeature(org.orgId, 'fulfillment', true)
    assert.deepEqual((await hubHrefs()).filter((href) => STOCK_REPORTS.includes(href)), STOCK_REPORTS, 'both hub cards show while Warehousing is on')
    assert.equal((await loadAvailability({})).showReleasable, true)

    await setFeature(org.orgId, 'fulfillment', false)
    const withoutFulfillment = await loadAvailability({})
    assert.deepEqual([withoutFulfillment.showReleasable, withoutFulfillment.releasable], [false, []], 'the releasable section is absent')
    await assert.rejects(withBypassContext(() => availability.releasableBackorders(db, org.orgId, query)), (error: unknown) =>
      error instanceof availability.AvailabilityRefusal && error.code === 'fulfillment_disabled'
        && error.remedy === 'turn on Fulfillment in Company Settings → Features')

    await setFeature(org.orgId, 'warehousing', false)
    for (const load of [loadAvailability, loadReplenishment]) {
      await assert.rejects(load({}), (error: unknown) =>
        String((error as { digest?: string }).digest).includes('/feature-required?feature=warehousing'))
    }
    assert.deepEqual((await hubHrefs()).filter((href) => STOCK_REPORTS.includes(href)), [], 'the hub cards disappear')
    for (const kind of ['availability', 'replenishment']) {
      const response = await statementExport.GET(json('GET', `/api/reports/statement/${kind}/export?format=csv`), { params: Promise.resolve({ kind }) })
      assert.equal(response.status, 404, `${kind} export answers a bare 404`)
    }
    await engineRefusal(() => availability.getAvailableToPromise(db, org.orgId, { ...query, itemId: org.items.fifo }))
    await engineRefusal(() => replenishmentProposals(db, org.orgId, query))
    assert.deepEqual(await itemTool.execute({ itemId: org.items.fifo }, state.authz as never), { ok: false, error: 'warehousing_feature_disabled' })
    assert.deepEqual(await replenishmentTool.execute({}, state.authz as never), { ok: false, error: 'warehousing_feature_disabled' })
  })
})

// ---- Fulfillment ----------------------------------------------------------

const FULFILLMENT_REMEDY = 'Turn on Warehousing and Fulfillment on Company Settings → Features'

async function fulfillmentEvidence(orgId: string) {
  return withBypassContext(async () => (await db.execute<{ state: unknown }>(sql`select jsonb_build_object(
    'carriers', (select jsonb_agg(to_jsonb(c) order by id) from carriers c where org_id = ${orgId}),
    'documents', (select jsonb_agg(to_jsonb(d) - 'revision_seq' order by id) from documents d where org_id = ${orgId} and kind in ('pick_list', 'shipment')),
    'stages', (select jsonb_agg(to_jsonb(f) order by document_id) from fulfillment_documents f where org_id = ${orgId}),
    'lines', (select jsonb_agg(to_jsonb(l) order by line_id) from fulfillment_lines l where org_id = ${orgId}),
    'cancellations', (select jsonb_agg(to_jsonb(x) order by id) from order_line_cancellations x where org_id = ${orgId}),
    'audit', (select jsonb_agg(to_jsonb(a) order by id) from audit_log a where org_id = ${orgId} and table_name in ('fulfillment_documents', 'document_lines', 'carriers'))
  ) as state`)).rows[0]!.state)
}

async function fulfillmentRefusal(run: () => Promise<unknown>) {
  await assert.rejects(withBypassContext(run), (error: unknown) =>
    error instanceof fulfillment.FulfillmentRefusal && error.code === 'feature_disabled' && error.remedy === FULFILLMENT_REMEDY)
}

test('fulfillment off hides picks, shipments and backorders at every layer and preserves their rows', { skip: !DB }, async () => {
  await withFencedOrg(async (org, actorId) => {
    state.authz = { ...(state.authz as object), permissions: new Set(['assistant.use', 'items.read', 'items.post', 'orders.fulfill', 'ar.read', 'admin.setup.manage']) }
    await setFeature(org.orgId, 'warehousing', true)
    await setFeature(org.orgId, 'fulfillment', true)
    const [bin, orderId, lineId] = [randomUUID(), randomUUID(), randomUUID()]
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into stock_locations (id, org_id, location_id, parent_id, code, kind, is_active)
        values (${bin}, ${org.orgId}, ${org.locationId}, ${org.stockLocationId}, 'F-A1', 'bin', true)`)
      await receiveInventory(org.orgId, actorId, {
        itemId: org.items.fifo, stockLocationId: bin, quantity: '10', unitCost: '2',
        subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
      })
      await db.execute(sql`
        insert into documents (id, org_id, kind, document_number, party_id, document_date, currency, status, subsidiary_id, subtotal, tax_total, total)
        values (${orderId}, ${org.orgId}, 'sales_order', 'SO-FENCE', ${org.customerId}, ${org.date}, 'CAD', 'draft', ${org.subsidiaryId}, '0', '0', '0')`)
      await db.execute(sql`
        insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price, amount, tax_amount, stock_location_id)
        values (${lineId}, ${org.orgId}, ${orderId}, 1, ${org.items.fifo}, ${org.accounts.revenue}, '8', '10', '80', '0', ${org.stockLocationId})`)
      await db.execute(sql`update documents set status = 'approved', subtotal = '80', total = '80' where id = ${orderId}`)
    })
    assert.ok((await navHrefs(org.orgId)).includes('/picks'), 'the nav entry is present while the feature is on')
    const carrier = await setupWrite('POST', 'carriers', { code: 'PARCEL', name: 'Parcel Co', services: ['Ground'], trackingUrlTemplate: 'https://track.example/{tracking}' })
    assert.equal(carrier.status, 200, JSON.stringify(await carrier.clone().json()))
    const carrierId = String((await carrier.json()).id)
    const scope = { allowedSubsidiaryIds: null }
    const pickList = await withBypassContext(() => db.transaction((tx) => fulfillment.createPickList(tx, org.orgId, actorId, {
      salesOrderId: orderId, lines: [{ salesOrderLineId: lineId, binId: bin, quantity: '5' }], ...scope,
    })))
    await withBypassContext(() => fulfillment.releasePickList(org.orgId, actorId, { pickListId: pickList.id, ...scope }))
    const shipment = await withBypassContext(() => db.transaction((tx) => fulfillment.createShipment(tx, org.orgId, actorId, { pickListId: pickList.id, ...scope })))
    await withBypassContext(() => db.transaction((tx) => fulfillment.setShipmentCarrier(tx, org.orgId, actorId, { shipmentId: shipment.id, carrierId, service: 'Ground', ...scope })))
    await withBypassContext(() => db.transaction((tx) => cancelOrderLineRemainder(tx, org.orgId, actorId, {
      documentId: orderId, lineId, quantity: '1', reason: 'customer reduced the order', ...scope,
    })))
    const openAfterCancel = async () => (await withBypassContext(() => salesOrderLineRemainders(db, org.orgId, { lineId })))[0]!.open
    assert.equal(await openAfterCancel(), '7.00000000')
    const before = await fulfillmentEvidence(org.orgId)

    const assertUnreachable = async (feature: string) => {
      const hrefs = await navHrefs(org.orgId)
      assert.equal(hrefs.includes('/picks') || hrefs.includes('/shipments'), false, 'both nav entries disappear')
      for (const load of [loadPicks, loadShipments]) {
        await assert.rejects(load({}), (error: unknown) => String((error as { digest?: string }).digest).includes(`/feature-required?feature=${feature}`))
      }
      const on = (id: string) => ({ params: Promise.resolve({ id }) })
      const responses = [
        await pickRoutes.POST(json('POST', '/api/picks', { salesOrderId: orderId, lines: [{ salesOrderLineId: lineId, binId: bin, quantity: '1' }] })),
        await pickRoute.GET(json('GET', `/api/picks/${pickList.id}`), on(pickList.id)),
        await pickReleaseRoute.POST(json('POST', `/api/picks/${pickList.id}/release`), on(pickList.id)),
        await pickVoidRoute.POST(json('POST', `/api/picks/${pickList.id}/void`, { reason: 'x' }), on(pickList.id)),
        await pickCandidatesRoute.GET(json('GET', `/api/picks/candidates?salesOrderId=${orderId}`)),
        await shipmentRoutes.POST(json('POST', '/api/shipments', { pickListId: pickList.id })),
        await shipmentRoute.GET(json('GET', `/api/shipments/${shipment.id}`), on(shipment.id)),
        await shipmentRoute.PATCH(json('PATCH', `/api/shipments/${shipment.id}`, { cartons: [] }), on(shipment.id)),
        await shipmentCompleteRoute.POST(json('POST', `/api/shipments/${shipment.id}/complete`), on(shipment.id)),
        await shipmentVoidRoute.POST(json('POST', `/api/shipments/${shipment.id}/void`, { reason: 'x' }), on(shipment.id)),
        await shipmentTrackingRoute.POST(json('POST', `/api/shipments/${shipment.id}/send-tracking`, {}), on(shipment.id)),
        await backordersRoute.GET(json('GET', `/api/sales-orders/${orderId}/backorders`), on(orderId)),
        await backordersRoute.POST(json('POST', `/api/sales-orders/${orderId}/backorders`, { lineId, quantity: '1', reason: 'x' }), on(orderId)),
      ]
      for (const response of responses) {
        assert.equal(response.status, 404)
        assert.deepEqual(await response.json(), { error: 'not_found' })
      }
      await fulfillmentRefusal(() => db.transaction((tx) => fulfillment.createPickList(tx, org.orgId, actorId, {
        salesOrderId: orderId, lines: [{ salesOrderLineId: lineId, binId: bin, quantity: '1' }], ...scope,
      })))
      await fulfillmentRefusal(() => fulfillment.releasePickList(org.orgId, actorId, { pickListId: pickList.id, ...scope }))
      await fulfillmentRefusal(() => db.transaction((tx) => fulfillment.voidShipment(tx, org.orgId, actorId, { shipmentId: shipment.id, reason: 'x', ...scope })))
      await fulfillmentRefusal(() => fulfillment.getFulfillmentDocument(db, org.orgId, shipment.id, null))
      await assert.rejects(withBypassContext(() => backorderPosition(db, org.orgId, { documentId: orderId, ...scope })), { code: 'feature_disabled' })
      assert.equal((await setupWrite('PATCH', 'carriers', { id: carrierId, name: 'Renamed' })).status, 404)
      assert.equal((await setupWrite('POST', 'carriers', { code: 'OTHER', name: 'Other', services: ['Ground'] })).status, 404)
      assert.equal(await enabledListSource(org.orgId, 'pick_list'), null)
      assert.equal(await enabledListSource(org.orgId, 'shipment'), null)
      assert.ok((await hiddenReportEntityKeys(state.authz as never)).includes('backorders'))
      assert.equal((await guardReportEntity(state.authz as never, { entity: 'backorders' }))?.status, 404)
      assert.deepEqual(await orderFulfillmentActions(state.authz as never), { backorders: false, pickLists: false, returnAuthorizations: false },
        'the order drawer offers no fulfillment actions')
      const features = await resolvedFeatureState(org.orgId)
      for (const tool of FULFILLMENT_TOOLS) {
        assert.equal(canRunTool(state.authz as never, tool, features), false, `${tool.name} is withheld`)
      }
      await fulfillmentRefusal(() => FULFILLMENT_TOOLS[0]!.execute({}, state.authz as never))
      assert.equal(await openAfterCancel(), '7.00000000', 'cancelled quantity is still subtracted')
    }

    await setFeature(org.orgId, 'fulfillment', false)
    await assertUnreachable('fulfillment')
    // Fulfillment on but Warehousing off: fulfillment still resolves off.
    await setFeature(org.orgId, 'fulfillment', true)
    await setFeature(org.orgId, 'warehousing', false)
    await assertUnreachable('fulfillment')

    await setFeature(org.orgId, 'warehousing', true)
    assert.deepEqual(await fulfillmentEvidence(org.orgId), before, 'off and on again changes no carrier, pick list, shipment, cancellation or audit row')
    assert.equal(await openAfterCancel(), '7.00000000')
  })
})

test('return authorizations are hidden while off and retain their records and audit history', { skip: !DB }, async () => {
  await withFencedOrg(async (org, actorId) => {
    await setFeature(org.orgId, 'warehousing', true)
    await setFeature(org.orgId, 'fulfillment', true)
    await setFeature(org.orgId, 'returnAuthorizations', true)
    const sourceId = randomUUID()
    const rmaId = randomUUID()
    const auditId = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, currency,
                               status, subtotal, tax_total, total, created_by)
        values (${sourceId}, ${org.orgId}, 'customer_invoice', 'INV-RMA-FENCE', ${org.customerId}, ${org.subsidiaryId},
                ${org.date}, 'CAD', 'draft', '0', '0', '0', ${actorId})`)
      await db.execute(sql`
        insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, currency,
                               status, subtotal, tax_total, total, created_by)
        values (${rmaId}, ${org.orgId}, 'rma', 'RMA-FENCE', ${org.customerId}, ${org.subsidiaryId},
                ${org.date}, 'CAD', 'draft', '0', '0', '0', ${actorId})`)
      await db.execute(sql`
        insert into rma_documents (document_id, org_id, source_document_id, created_by, updated_by)
        values (${rmaId}, ${org.orgId}, ${sourceId}, ${actorId}, ${actorId})`)
      await db.execute(sql`
        insert into audit_log (id, org_id, table_name, row_id, action, changes, actor_id)
        values (${auditId}, ${org.orgId}, 'rma_documents', ${rmaId}, 'insert', '{"stage":"requested"}'::jsonb, ${actorId})`)
    })
    assert.ok((await navHrefs(org.orgId)).includes('/returns'))
    const before = await withBypassContext(() => db.execute(sql`
      select jsonb_build_object(
        'authorization', (select to_jsonb(r) from rma_documents r where org_id = ${org.orgId} and document_id = ${rmaId}),
        'audit', (select jsonb_agg(to_jsonb(a) order by id) from audit_log a where org_id = ${org.orgId} and table_name = 'rma_documents')
      ) as state`)).then((result) => result.rows[0]!.state)
    const listed = await withBypassContext(() => returnEngine.listReturnAuthorizations(db, org.orgId, null))
    assert.equal(listed.some((entry: { id: string }) => entry.id === rmaId), true)

    await setFeature(org.orgId, 'returnAuthorizations', false)
    assert.equal((await navHrefs(org.orgId)).includes('/returns'), false)
    await assert.rejects(loadReturns({}), (error: unknown) => String((error as { digest?: string }).digest).includes('/feature-required?feature=returnAuthorizations'))
    const params = { params: Promise.resolve({ id: rmaId }) }
    const responses = [
      await returnsRoute.GET(json('GET', '/api/returns')),
      await returnsRoute.POST(json('POST', '/api/returns', {})),
      await returnRoute.GET(json('GET', `/api/returns/${rmaId}`), params),
      await returnReceiveRoute.POST(json('POST', `/api/returns/${rmaId}/receive`, { lines: [] }), params),
      await returnInspectRoute.POST(json('POST', `/api/returns/${rmaId}/inspect`, { lines: [] }), params),
      await returnRejectRoute.POST(json('POST', `/api/returns/${rmaId}/reject`, { reason: 'No return' }), params),
      await returnEmailRoute.POST(json('POST', `/api/returns/${rmaId}/email`, { type: 'decision' }), params),
      await returnSourcesRoute.GET(json('GET', '/api/returns/sources')),
    ]
    for (const response of responses) {
      assert.equal(response.status, 404)
      assert.deepEqual(await response.json(), { error: 'not_found' })
    }
    await assert.rejects(withBypassContext(() => returnEngine.listReturnAuthorizations(db, org.orgId, null)),
      (error: unknown) => error instanceof returnEngine.ReturnRefusal && error.code === 'feature_disabled'
        && /Return Authorizations/.test(error.message) && /Company Settings → Features/.test(error.remedy ?? ''))
    const features = await resolvedFeatureState(org.orgId)
    for (const tool of RETURNS_TOOLS) assert.equal(canRunTool(state.authz as never, tool, features), false)
    await assert.rejects(RETURNS_TOOLS[0]!.execute({}, state.authz as never),
      (error: unknown) => error instanceof returnEngine.ReturnRefusal && error.code === 'feature_disabled')
    await setFeature(org.orgId, 'returnAuthorizations', true)
    const after = await withBypassContext(() => db.execute(sql`
      select jsonb_build_object(
        'authorization', (select to_jsonb(r) from rma_documents r where org_id = ${org.orgId} and document_id = ${rmaId}),
        'audit', (select jsonb_agg(to_jsonb(a) order by id) from audit_log a where org_id = ${org.orgId} and table_name = 'rma_documents')
      ) as state`)).then((result) => result.rows[0]!.state)
    assert.deepEqual(after, before, 'turning the feature off and on preserves authorization evidence and audit history')
  })
})
