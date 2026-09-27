import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrg } from '@openbooks/engine/src/platform/db.ts'
import { receiveInventory } from '@openbooks/engine/src/inventory/movements.ts'
import { activePickReservations } from '@openbooks/engine/src/inventory/pick-reservations.ts'
import { createScratchOrg, createScratchUser, dropScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'
import {
  FulfillmentRefusal,
  createPickList,
  createShipment,
  releasePickList,
  setShipmentCarrier,
} from '@openbooks/engine/src/sales/fulfillment.ts'
import { completeShipment, saveFulfillmentCustom } from './shipments'

const DB = Boolean(process.env.OPENBOOKS_DB_URL)

test('completing a shipment issues from the picked bins through the fulfilment path, once', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const userId = await withBypassContext(() => createScratchUser(org.orgId, 'Shipper', 'admin'))
    const [binA, binB, orderId, lineId, carrierId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()]
    await withBypassContext(async () => {
      await db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
               || '{"warehousing": true, "fulfillment": true}'::jsonb) where id = ${org.orgId}`)
      await db.execute(sql`
        insert into stock_locations (id, org_id, location_id, parent_id, code, kind, is_active)
        values (${binA}, ${org.orgId}, ${org.locationId}, ${org.stockLocationId}, 'A1', 'bin', true),
               (${binB}, ${org.orgId}, ${org.locationId}, ${org.stockLocationId}, 'A2', 'bin', true)`)
      for (const stockLocationId of [binA, binB]) {
        await receiveInventory(org.orgId, userId, {
          itemId: org.items.fifo, stockLocationId, quantity: '5', unitCost: '2',
          subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
        })
      }
      await db.execute(sql`
        insert into documents (id, org_id, kind, document_number, party_id, document_date, currency, status,
                               subsidiary_id, subtotal, tax_total, total, created_by)
        values (${orderId}, ${org.orgId}, 'sales_order', 'SO-9101', ${org.customerId}, ${org.date}, 'CAD', 'draft',
                ${org.subsidiaryId}, '0', '0', '0', ${userId})`)
      await db.execute(sql`
        insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, description,
                                    quantity, unit, unit_price, amount, tax_amount, stock_location_id)
        values (${lineId}, ${org.orgId}, ${orderId}, 1, ${org.items.fifo}, ${org.accounts.revenue}, 'Widget',
                '8', 'ea', '10', '80', '0', ${org.stockLocationId})`)
      await db.execute(sql`
        update documents set status = 'approved', subtotal = '80', total = '80'
         where id = ${orderId} and org_id = ${org.orgId}`)
      await db.execute(sql`
        insert into carriers (id, org_id, code, name, services, tracking_url_template)
        values (${carrierId}, ${org.orgId}, 'PARCEL', 'Parcel Co', array['Ground', 'Express'],
                'https://track.example/{tracking}')`)
    })

    const scoped = { allowedSubsidiaryIds: null }
    const inTx = <T>(run: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) =>
      withOrg(org.orgId, () => db.transaction(run))
    const pickList = await inTx((tx) => createPickList(tx, org.orgId, userId, {
      salesOrderId: orderId,
      lines: [
        { salesOrderLineId: lineId, binId: binA, quantity: '5' },
        { salesOrderLineId: lineId, binId: binB, quantity: '3' },
      ],
      ...scoped,
    }))
    await releasePickList(org.orgId, userId, { pickListId: pickList.id, ...scoped })
    const shipment = await inTx((tx) => createShipment(tx, org.orgId, userId, { pickListId: pickList.id, documentDate: org.date, ...scoped }))
    // A custom field defined on shipments saves through the customization
    // validation (unknown keys dropped) and is final once the shipment is.
    await withBypassContext(() => db.execute(sql`
      insert into custom_field_defs (org_id, target_table, target_kind, key, label, field_type)
      values (${org.orgId}, 'documents', 'shipment', 'dock_door', 'Dock door', 'text')`))
    const saveCustom = () => inTx((tx) => saveFulfillmentCustom(tx, org.orgId, userId, {
      documentId: shipment.id, kind: 'shipment', custom: { dock_door: 'D-4', stray: 'dropped' },
    }))
    assert.deepEqual(await saveCustom(), { dock_door: 'D-4' })
    const complete = () => withOrg(org.orgId, () => completeShipment(org.orgId, userId, { shipmentId: shipment.id, ...scoped }))

    await assert.rejects(complete(), (error: unknown) =>
      error instanceof FulfillmentRefusal && error.code === 'carrier_required'
        && error.message === `Add a carrier and service to ${shipment.documentNumber} before completing it`
        && /Warehouse → Carriers/.test(error.remedy ?? ''))

    await inTx((tx) => setShipmentCarrier(tx, org.orgId, userId, {
      shipmentId: shipment.id, carrierId, service: 'Ground', trackingNumber: '1Z 999', ...scoped,
    }))
    const completed = await complete()
    assert.equal(completed.replayed, false)

    const evidence = await withBypassContext(async () => (await db.execute<{ state: unknown }>(sql`
      select jsonb_build_object(
        'issued', (select jsonb_agg(jsonb_build_array(sl.code, trim_scale(dl.quantity)::text) order by sl.code)
                     from document_lines dl join stock_locations sl on sl.id = dl.stock_location_id
                    where dl.document_id = ${completed.fulfillmentId}),
        'movements', (select jsonb_agg(jsonb_build_array(sl.code, trim_scale(-m.quantity)::text) order by sl.code)
                        from inventory_movements m join stock_locations sl on sl.id = m.stock_location_id
                        join document_lines dl on dl.id = m.document_line_id
                       where dl.document_id = ${completed.fulfillmentId} and m.kind = 'issue'),
        'fulfilled', (select trim_scale(quantity_fulfilled)::text from document_lines where id = ${lineId}),
        'linked', (select count(*)::int from document_links
                    where from_document_id = ${orderId} and to_document_id = ${completed.fulfillmentId} and link_type = 'fulfills'),
        'custom', (select custom from documents where id = ${shipment.id}),
        'stages', (select jsonb_object_agg(d.kind, jsonb_build_array(fd.stage, d.status, fd.sales_fulfillment_id = ${completed.fulfillmentId}))
                     from fulfillment_documents fd join documents d on d.id = fd.document_id
                    where fd.document_id in (${pickList.id}, ${shipment.id}))
      ) as state`)).rows[0]!.state)
    assert.deepEqual(evidence, {
      issued: [['A1', '5'], ['A2', '3']],
      movements: [['A1', '5'], ['A2', '3']],
      fulfilled: '8',
      linked: 1,
      custom: { dock_door: 'D-4' },
      stages: { pick_list: ['done', 'approved', null], shipment: ['done', 'approved', true] },
    })
    assert.deepEqual(await withOrg(org.orgId, () => activePickReservations(db, org.orgId, { salesOrderLineIds: [lineId] })), [],
      'completion ends the reservation')

    const replay = await complete()
    assert.deepEqual(
      { ...replay, replayed: undefined },
      { ...completed, replayed: undefined },
      'a retry answers with the fulfilment already recorded',
    )
    assert.equal(replay.replayed, true)
    await assert.rejects(saveCustom(), { code: 'wrong_stage' })
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
