import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  FulfillmentRefusal,
  getFulfillmentDocument,
  lockShipmentForCompletion,
  markShipmentComplete,
} from '@openbooks/engine/src/sales/fulfillment.ts'
import {
  insertEmailLog,
  markEmailFailed,
  markEmailSent,
  markEmailUncertain,
  resolveOrgEmailTransport,
} from '@openbooks/engine/src/delivery/email-config.ts'
import { deriveEmailDeliveryKey, sendVia, shipmentTrackingEmail } from '@openbooks/emails'
import { fulfillSalesOrderInTx } from './order-cycle'

type Scope = ReadonlySet<string> | null

export interface CompletedShipment {
  shipmentId: string
  shipmentNumber: string
  fulfillmentId: string
  fulfillmentNumber: string
  replayed: boolean
}

/**
 * Complete a draft shipment in one transaction: record its sales fulfilment
 * through the existing fulfilment path — issuing each line from its picked
 * bin and relieving COGS — then mark the shipment and its pick list done,
 * which ends the pick list's reservation. The fulfilment takes the
 * shipment's date and an idempotency key derived from the shipment, and a
 * completed shipment answers with the fulfilment it already recorded, so a
 * retry never ships twice. Invoicing
 * stays the order's fulfilment-governed conversion.
 */
export async function completeShipment(
  orgId: string,
  userId: string,
  input: { shipmentId: string; allowedSubsidiaryIds: Scope },
): Promise<CompletedShipment> {
  return db.transaction(async (tx) => {
    const locked = await lockShipmentForCompletion(tx, orgId, input.shipmentId, input.allowedSubsidiaryIds)
    const shipmentNumber = locked.shipment.document_number
    if (locked.shipment.stage === 'done' && locked.shipment.sales_fulfillment_id) {
      const recorded = (await tx.execute<{ document_number: string }>(sql`
        select document_number from documents
         where org_id = ${orgId} and id = ${locked.shipment.sales_fulfillment_id}`)).rows[0]
      return {
        shipmentId: locked.shipment.id,
        shipmentNumber,
        fulfillmentId: locked.shipment.sales_fulfillment_id,
        fulfillmentNumber: recorded?.document_number ?? '',
        replayed: true,
      }
    }
    const fulfillment = await fulfillSalesOrderInTx(tx, orgId, userId, locked.salesOrderId, {
      fulfillmentDate: locked.shipment.document_date,
      idempotencyKey: `shipment:${locked.shipment.id}`,
      lines: locked.lines.map((line) => ({
        sourceLineId: line.salesOrderLineId,
        quantity: line.quantity,
        lotId: line.lotId,
        serialId: line.serialId,
        stockLocationId: line.binId,
      })),
    })
    await markShipmentComplete(tx, orgId, userId, {
      shipment: { id: locked.shipment.id, documentNumber: shipmentNumber },
      pickListId: locked.pickListId,
      salesFulfillmentId: fulfillment.id,
    })
    return {
      shipmentId: locked.shipment.id,
      shipmentNumber,
      fulfillmentId: fulfillment.id,
      fulfillmentNumber: fulfillment.documentNumber,
      replayed: false,
    }
  })
}

/**
 * Email the customer a completed shipment's carrier, service and tracking
 * link through the organization's own email transport. The send is recorded
 * in email_log whatever its outcome, and a refusal names what to fix.
 */
export async function sendShipmentTracking(
  orgId: string,
  userId: string,
  input: { shipmentId: string; to?: string; message?: string; allowedSubsidiaryIds: Scope },
): Promise<{ to: string; subject: string }> {
  const shipment = await getFulfillmentDocument(db, orgId, input.shipmentId, input.allowedSubsidiaryIds)
  if (!shipment || shipment.kind !== 'shipment') {
    throw new FulfillmentRefusal('Shipment not found', 'not_found', 404)
  }
  if (shipment.stage !== 'done') {
    throw new FulfillmentRefusal(
      `${shipment.documentNumber} is not complete yet`,
      'wrong_stage',
      409,
      `Complete ${shipment.documentNumber} before sending its tracking`,
    )
  }
  if (!shipment.carrier || !shipment.carrierService || !shipment.trackingNumber) {
    throw new FulfillmentRefusal(
      `${shipment.documentNumber} has no tracking number`,
      'carrier_required',
      422,
      'A completed shipment cannot change; send the tracking number to the customer directly',
    )
  }
  const party = (await db.execute<{ email: string | null; org_name: string }>(sql`
    select p.email, o.name as org_name
      from orgs o
      left join parties p on p.org_id = o.id and p.id = ${shipment.customer?.id ?? null}
     where o.id = ${orgId}`)).rows[0]
  const to = (input.to?.trim() || party?.email?.trim() || '')
  if (!to) {
    throw new FulfillmentRefusal(
      'No recipient email',
      'invalid_input',
      422,
      "Enter a recipient, or add an email address to the customer's record",
    )
  }
  const transport = await resolveOrgEmailTransport(orgId)
  if (!transport) {
    throw new FulfillmentRefusal(
      'Email delivery is not configured',
      'invalid_input',
      422,
      'Set up email delivery in Admin → Email',
    )
  }
  const body = shipmentTrackingEmail({
    orgName: party?.org_name || 'OpenBooks',
    shipmentNumber: shipment.documentNumber,
    orderNumber: shipment.salesOrder?.number,
    partyName: shipment.customer?.name || undefined,
    carrierName: shipment.carrier.name,
    service: shipment.carrierService,
    trackingNumber: shipment.trackingNumber,
    trackingUrl: shipment.trackingUrl ?? undefined,
    message: input.message,
  })
  const logId = await insertEmailLog({
    orgId,
    recipients: [to],
    subject: body.subject,
    status: 'queued',
    categoryKey: 'document',
    meta: { recordType: 'shipment', recordId: shipment.id },
    actor: { kind: 'user', userId },
  })
  let uncertaintyRecorded = false
  try {
    const outcome = await sendVia(
      transport,
      { to, subject: body.subject, html: body.html, text: body.text },
      { deliveryKey: deriveEmailDeliveryKey({ orgId, scope: `direct:${logId}`, to }) },
    )
    if (outcome.kind === 'sent') {
      await markEmailSent(orgId, logId, outcome.providerMessageId)
    } else {
      // Acceptance unknown: record it as uncertain, never as sent or failed.
      uncertaintyRecorded = true
      await markEmailUncertain(orgId, logId, outcome.reason)
      throw new Error(outcome.reason)
    }
  } catch (error) {
    if (!uncertaintyRecorded) {
      await markEmailFailed(orgId, logId, error instanceof Error ? error.message : String(error))
    }
    throw error
  }
  return { to, subject: body.subject }
}
