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
import { findUnownedCustomReferences, loadFieldDefs, validateCustomValues } from './custom-fields'
import { fulfillSalesOrderInTx } from './order-cycle'

type Scope = ReadonlySet<string> | null
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Save header custom-field values on a draft pick list or shipment through
 * the same customization validation every document edit uses: values merge
 * over the stored bag, are validated against the record type's definitions
 * (unknown keys dropped, required fields enforced), references must belong
 * to this organization, and an explicit null clears a value. Once the
 * document leaves draft its values are final, like its lines.
 */
export async function saveFulfillmentCustom(
  tx: Tx,
  orgId: string,
  actorId: string,
  input: { documentId: string; kind: 'pick_list' | 'shipment'; custom: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const current = (await tx.execute<{ custom: Record<string, unknown> | null; document_number: string; status: string; stage: string }>(sql`
    select d.custom, d.document_number, d.status, fd.stage
      from documents d
      join fulfillment_documents fd on fd.document_id = d.id and fd.org_id = d.org_id
     where d.org_id = ${orgId} and d.id = ${input.documentId} and d.kind = ${input.kind}
     for update of d`)).rows[0]
  if (!current) throw new FulfillmentRefusal(`${input.kind === 'pick_list' ? 'Pick list' : 'Shipment'} not found`, 'not_found', 404)
  if (current.status !== 'draft' || current.stage !== 'open') {
    throw new FulfillmentRefusal(
      `${current.document_number} is ${current.stage === 'done' ? 'complete' : current.status}; custom fields change only on a draft`,
      'wrong_stage',
      409,
    )
  }
  const defs = await loadFieldDefs('documents', input.kind)
  const existing = current.custom ?? {}
  const validated = validateCustomValues(defs, { ...existing, ...input.custom })
  if (!validated.ok) throw new FulfillmentRefusal(Object.values(validated.errors)[0]!, 'invalid_input', 422)
  const supplied: Record<string, unknown> = {}
  for (const key of Object.keys(input.custom)) {
    if (validated.cleaned[key] !== undefined) supplied[key] = validated.cleaned[key]
  }
  const [unowned] = await findUnownedCustomReferences(orgId, defs, supplied)
  if (unowned) throw new FulfillmentRefusal(`${unowned.label} not found in this organization`, 'not_found', 404)
  const next: Record<string, unknown> = { ...existing, ...validated.cleaned }
  for (const def of defs) {
    if (Object.prototype.hasOwnProperty.call(input.custom, def.key) && input.custom[def.key] == null) delete next[def.key]
  }
  const saved = await tx.execute<{ id: string }>(sql`
    update documents set custom = ${JSON.stringify(next)}::jsonb, updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${input.documentId} and status = 'draft'
    returning id`)
  if (saved.rows.length === 0) {
    throw new FulfillmentRefusal(`${current.document_number} changed while its custom fields were being saved`, 'changed_concurrently', 409, 'Reload and try again')
  }
  const audited = await tx.execute<{ id: string }>(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'documents', ${input.documentId}, 'update',
            ${JSON.stringify({ mode: 'custom_fields_set', before: existing, after: next })}::jsonb, ${actorId})
    returning id`)
  if (audited.rows.length === 0) throw new Error('custom-field change was not audited')
  return next
}

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
