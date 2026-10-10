import 'server-only'

import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { adjustInventory } from '@openbooks/engine/src/inventory/movements.ts'
import { db, withOrgContext, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { submitAndReleaseIfUngated } from '@openbooks/engine/src/flows/submit.ts'
import { controlDeps } from '@openbooks/engine/src/ledger/document-service.ts'
import { postDocument } from '@openbooks/engine/src/ledger/posting-document.ts'
import { postedDocumentControlAccount } from '@openbooks/engine/src/ledger/posting-control-account.ts'
import { runPostDocumentEffects } from '@openbooks/engine/src/ledger/posting-dispatch.ts'
import { runRecordFlows } from '@openbooks/engine/src/flows/index.ts'
import { canonicalDecimal, compareDecimal } from '@openbooks/engine/src/money/exact-decimal.ts'
import { quantumScale, roundDiv, toUnits } from '@openbooks/engine/money'
import {
  recordRestockingFeeWaiver,
  resolveRestockingFee,
  restockingFeeCreditLines,
  type ResolveRestockingFeeResult,
} from '@openbooks/engine/sales/restocking-fees'
import {
  UnknownCurrencyPrecisionError,
  currencyPrecisionRemedy,
  resolveCurrencyQuantum,
} from '@openbooks/engine/sales/currency-precision'
import { returnableSources } from '@openbooks/engine/src/inventory/returnable-sources.ts'
import { postedReturnEvidenceScope, SALES_FULFILLMENT_DOCUMENT_KIND } from '@openbooks/engine/inventory'
import { subsidiaryScopeAllows } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import {
  authorizeReturn,
  completeReturnInspection,
  getReturnAuthorization,
  listReturnAuthorizations,
  receiveReturn,
  recordReturnInspection,
  rejectReturn,
  validateReturnInspection,
  ReturnRefusal,
  type InspectionLine,
  type ReturnAuthorization,
} from '@openbooks/engine/src/sales/returns.ts'
import { createDocument } from './documents.ts'
import type { DocumentEditInput, DocumentLineInput } from '@openbooks/engine/src/ledger/document-input.ts'
import {
  deriveEmailDeliveryKey,
  returnDecisionEmail,
  returnReceivedEmail,
  sendVia,
} from '@openbooks/emails'
import {
  insertEmailLog,
  markEmailFailed,
  markEmailSent,
  markEmailUncertain,
  resolveOrgEmailTransport,
} from '@openbooks/engine/src/delivery/email-config.ts'

export type ReturnSourceSelection = {
  lineNumber: number
  sourceIssueMovementId: string
  lotId?: string | null
  serialId?: string | null
}

/**
 * Return lines arrive priced (operator drawer) or quantity-only (portal self-
 * service, after engine validation). Either way the transaction re-derives
 * account, item, price and tax from the locked source shipment, so no caller
 * prices the return.
 */
export type ReturnLineRequest = DocumentLineInput | { quantity: string };

export async function createReturnAuthorization(input: {
  orgId: string
  actorId: string
  key: string
  body: Omit<DocumentEditInput, 'lines'> & { lines?: ReturnLineRequest[] }
  sourceSelections: ReturnSourceSelection[]
  requestBody: unknown
  allowedSubsidiaryIds: ReadonlySet<string> | null
  /**
   * Customer scope asserted by the caller (a portal session): the RMA names
   * this customer party, proven owned before the write, so the draft binds
   * against the customer instead of the actor's subsidiary roles.
   */
  onBehalfOfPartyId?: string | null
}): Promise<ReturnAuthorization> {
  const result = await withOrgTransaction(input.orgId, async () => {
    const requestedLines = input.body.lines ?? []
    if (requestedLines.length === 0 || input.sourceSelections.length !== requestedLines.length) {
      throw new ReturnRefusal('Choose one posted shipment for every return line', 'invalid_input', 422, 'Add return lines and select a customer shipment on each line')
    }
    const documentLines: NonNullable<DocumentEditInput['lines']> = []
    for (let index = 0; index < requestedLines.length; index++) {
      const selection = input.sourceSelections.find((candidate) => candidate.lineNumber === index + 1)
      if (!selection) throw new ReturnRefusal(`Return line ${index + 1} has no shipment source`, 'invalid_input', 422, 'Choose a customer shipment for every line')
      const source = (await db.execute<{
        item_id: string
        account_id: string | null
        description: string | null
        unit: string | null
        stock_location_id: string
      }>(sql`
        -- A fulfillment line carries the order line's account, which may be
        -- empty when the order relied on the item's income account; invoicing
        -- from the order resolves the same fallback.
        select movement.item_id, coalesce(source_line.account_id, item.income_account_id) as account_id,
               source_line.description, source_line.unit, movement.stock_location_id
          from inventory_movements movement
          join document_lines source_line on source_line.id = movement.document_line_id and source_line.org_id = movement.org_id
          left join items item on item.id = movement.item_id and item.org_id = movement.org_id
         where movement.org_id = ${input.orgId} and movement.id = ${selection.sourceIssueMovementId}
      `)).rows[0]
      if (!source) {
        throw new ReturnRefusal(`Return line ${index + 1} shipment is unavailable`, 'source_unavailable', 422, 'Choose a posted customer shipment with a sale line')
      }
      if (!source.account_id) {
        throw new ReturnRefusal(`Return line ${index + 1} shipment has no sale line account and its item has no income account`, 'source_unavailable', 422, 'Set an income account on the item, then authorize the return again')
      }
      documentLines.push({
        ...requestedLines[index]!,
        accountId: source.account_id,
        itemId: source.item_id,
        description: source.description,
        unit: source.unit,
        unitPrice: '0',
        amount: '0',
        taxCodeId: null,
        taxGroupId: null,
        taxOverridden: false,
        taxAmount: null,
        stockLocationId: source.stock_location_id,
      })
    }
    const body: DocumentEditInput = { ...input.body, lines: documentLines }
    const draft = await createDocument({
      orgId: input.orgId,
      userId: input.actorId,
      kind: 'rma',
      key: input.key,
      body,
      subsidiaryId: body.subsidiaryId ?? null,
      requestBody: input.requestBody,
      onBehalfOfPartyId: input.onBehalfOfPartyId ?? null,
    })
    if (draft.status === 'created') {
      await runRecordFlows({ kind: 'on_create', source: 'ui' }, 'rma', draft.id, { orgId: input.orgId, userId: input.actorId })
      if (draft.deferredUpdate) await runRecordFlows(draft.deferredUpdate, 'rma', draft.id, { orgId: input.orgId, userId: input.actorId })
    }
    return authorizeReturn(db, input.orgId, input.actorId, draft.id, input.sourceSelections, input.allowedSubsidiaryIds)
  })
  return result
}

export async function receiveReturnAuthorization(input: {
  orgId: string
  actorId: string
  documentId: string
  receivedLines: Array<{ lineId: string; received: string }>
  allowedSubsidiaryIds: ReadonlySet<string> | null
}): Promise<ReturnAuthorization> {
  return withOrgTransaction(input.orgId, () => receiveReturn(
    db, input.orgId, input.actorId, input.documentId, input.receivedLines, input.allowedSubsidiaryIds,
  ))
}

export async function rejectReturnAuthorization(input: {
  orgId: string
  actorId: string
  documentId: string
  reason: string
  allowedSubsidiaryIds: ReadonlySet<string> | null
}): Promise<void> {
  return withOrgTransaction(input.orgId, () => rejectReturn(
    db, input.orgId, input.actorId, input.documentId, input.reason, input.allowedSubsidiaryIds,
  ))
}

type SourceLine = Record<string, unknown> & {
  item_id: string
  account_id: string | null
  description: string | null
  quantity: string
  unit_price: string
  amount: string
  tax_code_id: string | null
  tax_group_id: string | null
  tax_amount: string
  stock_location_id: string | null
  lot_id: string | null
  serial_id: string | null
  source_stock_location_id: string
  source_document_number: string | null
  order_line_id: string | null
  customer_credit_id: string | null
}

type BilledOrderLine = Record<string, unknown> & {
  order_number: string | null
  invoice_lines: number
  pricing_profiles: number
  invoice_numbers: string | null
  account_id: string | null
  tax_code_id: string | null
  tax_group_id: string | null
  billed_quantity: string
  returned_quantity: string
  unit_price: string | null
  amount: string | null
  tax_amount: string | null
}

/**
 * Units of one sales-order line already credited within the current preview or
 * inspection, so two RMA lines drawn from the same order line cannot together
 * credit more than the order billed.
 */
type OrderLineClaims = Map<string, string>

/**
 * Price the customer credit for one accepted RMA line from what the customer
 * was actually charged.
 *
 * A direct invoice that moved stock itself carries its own price, so the credit
 * is the proportional share of that invoice line. An order-governed shipment
 * does not: a sales fulfillment line is a zero-priced record of goods leaving
 * the warehouse, and the invoice that billed those goods moves no stock. For a
 * fulfillment the credit is therefore priced from the posted customer invoice
 * lines converted from the same sales-order line, at their average billed
 * price and tax, posted to the income account and tax profile they billed. A
 * shipment nobody has invoiced yet, or units beyond what was invoiced and not
 * already returned, are refused rather than credited at zero or at a price the
 * customer was never charged.
 */
async function customerCreditLine(
  orgId: string,
  rmaId: string,
  line: InspectionLine,
  sourceIssueMovementId: string,
  claims: OrderLineClaims,
): Promise<DocumentLineInput | null> {
  if (line.accepted === '0') return null
  const source = (await db.execute<SourceLine>(sql`
    select source_line.item_id, source_line.account_id, source_line.description,
           source_line.quantity::text, source_line.unit_price::text,
           round(source_line.amount * ${line.accepted}::numeric / nullif(source_line.quantity, 0), 4)::text as amount,
           source_line.tax_code_id, source_line.tax_group_id,
           round(source_line.tax_amount * ${line.accepted}::numeric / nullif(source_line.quantity, 0), 4)::text as tax_amount,
           source_line.stock_location_id, movement.stock_location_id as source_stock_location_id,
           movement.lot_id, movement.serial_id, source_document.document_number as source_document_number,
           case when source_document.kind = ${SALES_FULFILLMENT_DOCUMENT_KIND}
                then source_line.custom->'fulfillment'->>'sourceLineId' end as order_line_id,
           rma.customer_credit_id
      from inventory_movements movement
      join document_lines source_line on source_line.id = movement.document_line_id and source_line.org_id = movement.org_id
      join documents source_document on source_document.id = source_line.document_id and source_document.org_id = source_line.org_id
      join rma_documents rma on rma.source_document_id = source_document.id and rma.org_id = source_document.org_id
     where movement.org_id = ${orgId} and movement.id = ${sourceIssueMovementId}
       and rma.document_id = ${rmaId} and movement.kind = 'issue' and movement.status = 'posted'
       and source_line.item_id is not null
  `)).rows[0]
  if (!source) {
    throw new ReturnRefusal(`RMA line ${line.lineId} has no customer sale line to credit`, 'source_unavailable', 422, 'Choose a customer invoice or sales fulfillment line with a posted stock issue')
  }
  const inventoryReturnSource = {
    movementId: sourceIssueMovementId,
    sourceStockLocationId: source.source_stock_location_id,
    lotId: source.lot_id,
    serialId: source.serial_id,
  }
  if (source.order_line_id === null) {
    if (!source.account_id) {
      throw new ReturnRefusal(`RMA line ${line.lineId} has no customer sale line to credit`, 'source_unavailable', 422, 'Choose a customer invoice or sales fulfillment line with a posted stock issue')
    }
    return {
      itemId: source.item_id,
      accountId: source.account_id,
      description: source.description,
      quantity: line.accepted,
      unitPrice: source.unit_price,
      amount: source.amount,
      taxCodeId: source.tax_code_id,
      taxGroupId: source.tax_group_id,
      taxOverridden: true,
      taxAmount: source.tax_amount,
      stockLocationId: line.dispositionLocationId,
      inventoryReturnSource,
    }
  }

  const orderLineId = source.order_line_id
  const priorClaim = claims.get(orderLineId) ?? '0'
  const billed = (await db.execute<BilledOrderLine>(sql`
    with order_line as (
      select ol.id, ol.document_id, od.document_number
        from document_lines ol
        join documents od on od.id = ol.document_id and od.org_id = ol.org_id
       where ol.org_id = ${orgId} and ol.id::text = ${orderLineId}
    ),
    invoice_line as (
      -- Only posted invoices bill the customer: drafts have not, and voided or
      -- reversed invoices no longer do.
      select il.quantity, il.amount, il.tax_amount, il.unit_price, il.account_id,
             il.tax_code_id, il.tax_group_id, invoice.document_number
        from order_line
        join document_lines il on il.org_id = ${orgId}
         and il.custom->'convertedFrom'->>'lineId' = order_line.id::text
         and il.custom->'convertedFrom'->>'documentId' = order_line.document_id::text
        join documents invoice on invoice.id = il.document_id and invoice.org_id = il.org_id
       where invoice.kind = 'customer_invoice' and invoice.status = 'posted'
    ),
    returned as (
      -- Units of this order line already brought back on posted, unreversed
      -- customer credits (from any of its shipments), excluding this return's
      -- own credit so a retried inspection does not count itself.
      select coalesce(sum(abs(prior.quantity)), 0) as quantity
        from order_line
        join document_lines shipped_line on shipped_line.org_id = ${orgId}
         and shipped_line.custom->'fulfillment'->>'sourceLineId' = order_line.id::text
        join inventory_movements shipped on shipped.org_id = shipped_line.org_id
         and shipped.document_line_id = shipped_line.id and shipped.kind = 'issue' and shipped.status = 'posted'
        join inventory_movements prior on prior.org_id = shipped.org_id
        join document_lines credit_line on credit_line.id = prior.document_line_id and credit_line.org_id = prior.org_id
       where ${postedReturnEvidenceScope({ orgId, returnKind: 'receipt', evidenceKey: 'sourceIssueMovementId', sourceId: sql`shipped.id::text` })}
         and credit_line.document_id is distinct from ${source.customer_credit_id}::uuid
    )
    select (select document_number from order_line) as order_number,
           count(invoice_line.*)::int as invoice_lines,
           count(distinct concat_ws('|', coalesce(invoice_line.account_id::text, ''),
             coalesce(invoice_line.tax_code_id::text, ''), coalesce(invoice_line.tax_group_id::text, '')))::int as pricing_profiles,
           string_agg(distinct invoice_line.document_number, ', ') as invoice_numbers,
           min(invoice_line.account_id::text) as account_id,
           min(invoice_line.tax_code_id::text) as tax_code_id,
           min(invoice_line.tax_group_id::text) as tax_group_id,
           coalesce(sum(invoice_line.quantity), 0)::text as billed_quantity,
           (select quantity from returned)::text as returned_quantity,
           case when count(distinct invoice_line.unit_price) = 1 then min(invoice_line.unit_price)
                else round(sum(invoice_line.amount) / nullif(sum(invoice_line.quantity), 0), 8) end::text as unit_price,
           round(sum(invoice_line.amount) * ${line.accepted}::numeric / nullif(sum(invoice_line.quantity), 0), 4)::text as amount,
           round(sum(invoice_line.tax_amount) * ${line.accepted}::numeric / nullif(sum(invoice_line.quantity), 0), 4)::text as tax_amount
      from invoice_line
  `)).rows[0]
  const shipment = source.source_document_number ?? 'the shipment'
  const order = billed?.order_number ?? 'its sales order'
  if (!billed || billed.invoice_lines === 0 || billed.amount === null || billed.tax_amount === null || billed.unit_price === null) {
    throw new ReturnRefusal(
      `RMA line ${line.lineId} returns goods shipped on ${shipment} that no posted customer invoice has billed from ${order}, so there is no price to credit`,
      'source_unavailable', 422,
      `Invoice the shipped goods from ${order} and post that invoice, then inspect the return again`,
    )
  }
  if (billed.pricing_profiles !== 1 || !billed.account_id) {
    throw new ReturnRefusal(
      `RMA line ${line.lineId} returns goods from ${order} that were billed on ${billed.invoice_numbers} with different income accounts or tax profiles, so one credit price cannot be chosen`,
      'source_unavailable', 422,
      `Void the invoice that billed this line of ${order} on a different income account or tax profile, invoice the goods again from ${order}, then inspect the return again`,
    )
  }
  const creditable = (await db.execute<{ quantity: string; claim: string }>(sql`
    select (${billed.billed_quantity}::numeric - ${billed.returned_quantity}::numeric - ${priorClaim}::numeric)::text as quantity,
           (${priorClaim}::numeric + ${line.accepted}::numeric)::text as claim`)).rows[0]!
  if (compareDecimal(line.accepted, creditable.quantity) > 0) {
    throw new ReturnRefusal(
      `RMA line ${line.lineId} accepts ${line.accepted} units from ${order}, but only ${creditable.quantity} of the units invoiced on ${billed.invoice_numbers} remain to be credited`,
      'exceeds_returnable_quantity', 409,
      `Accept no more than ${creditable.quantity}, or invoice the remaining shipped goods from ${order} and post that invoice before inspecting the return`,
    )
  }
  claims.set(orderLineId, creditable.claim)
  return {
    itemId: source.item_id,
    accountId: billed.account_id,
    description: source.description,
    quantity: line.accepted,
    unitPrice: billed.unit_price,
    amount: billed.amount,
    taxCodeId: billed.tax_code_id,
    taxGroupId: billed.tax_group_id,
    taxOverridden: true,
    taxAmount: billed.tax_amount,
    stockLocationId: line.dispositionLocationId,
    inventoryReturnSource,
  }
}

type CreditedReturnLine = { lineId: string; itemId: string | null; lineTotalMinor: bigint }

/**
 * The return currency's ISO quantum through the single Sales-owned
 * resolver, mapped to this surface's typed refusal. Credited line values
 * enter fee math as ISO minors of the credit currency (Setup stores fixed
 * policy amounts the same way); an unknown precision refuses before any
 * fee resolves instead of guessing hundredths.
 */
async function creditQuantum(currency: string): Promise<number> {
  try {
    return await resolveCurrencyQuantum(db, currency)
  } catch (error) {
    if (error instanceof UnknownCurrencyPrecisionError) {
      throw new ReturnRefusal(error.message, 'currency_precision_unknown', 422, currencyPrecisionRemedy(currency))
    }
    throw error
  }
}

/**
 * Resolve the restocking fee for accepted return value, shared by the fee
 * preview and the inspect write path so both price the same lines.
 */
async function resolveInspectionRestockingFee(input: {
  orgId: string
  returnDate: string
  currency: string
  credited: CreditedReturnLine[]
  waived: boolean
  waiveReason: string | null
}): Promise<ResolveRestockingFeeResult> {
  const itemIds = [...new Set(input.credited.map((line) => line.itemId).filter((id): id is string => id !== null))]
  const categories = itemIds.length === 0 ? [] : (await db.execute<{ id: string; category: string | null }>(sql`
    select id, category from items where org_id = ${input.orgId} and id in (select jsonb_array_elements_text(${JSON.stringify(itemIds)}::jsonb)::uuid)`)).rows
  const categoryByItem = new Map(categories.map((row) => [row.id, row.category]))
  return resolveRestockingFee(db, input.orgId, {
    returnDate: input.returnDate,
    currency: input.currency,
    lines: input.credited.map((line) => ({
      key: line.lineId,
      itemId: line.itemId,
      itemCategory: line.itemId ? categoryByItem.get(line.itemId) ?? null : null,
      lineTotalMinor: line.lineTotalMinor,
    })),
    waived: input.waived,
    waiveReason: input.waiveReason,
    // The inspect route authorizes the grant before requesting a waiver;
    // the preview never waives.
    canWaive: input.waived,
  })
}

/** Fee preview for the inspect form: what the accepted quantities would charge. */
export async function previewReturnRestockingFee(input: {
  orgId: string
  documentId: string
  lines: Array<{ lineId: string; accepted: string }>
  allowedSubsidiaryIds: ReadonlySet<string> | null
}): Promise<ResolveRestockingFeeResult> {
  const current = await getReturnAuthorization(db, input.orgId, input.documentId, input.allowedSubsidiaryIds)
  if (current.stage !== 'receiving' && current.stage !== 'inspected') {
    throw new ReturnRefusal('The return must be received before previewing fees', 'wrong_stage', 409, 'Receive the authorized goods first')
  }
  const header = (await db.execute<{ document_date: string; currency: string }>(sql`
    select document_date::text, currency from documents
     where org_id = ${input.orgId} and id = ${input.documentId} and kind = 'rma'`)).rows[0]
  if (!header) throw new ReturnRefusal('Return authorization not found', 'not_found', 404)
  const quantum = await creditQuantum(header.currency)
  const scale = quantumScale(quantum)
  const linesById = new Map(current.lines.map((line) => [line.lineId, line]))
  const credited: CreditedReturnLine[] = []
  const claims: OrderLineClaims = new Map()
  for (const { lineId, accepted } of input.lines) {
    const rmaLine = linesById.get(lineId)
    if (!rmaLine?.sourceIssueMovementId || accepted === '0') continue
    const credit = await customerCreditLine(input.orgId, current.id, {
      lineId, accepted, disposition: null, dispositionLocationId: null,
    }, rmaLine.sourceIssueMovementId, claims)
    if (credit) credited.push({ lineId, itemId: rmaLine.itemId ?? null, lineTotalMinor: roundDiv(toUnits(credit.amount), scale) })
  }
  return resolveInspectionRestockingFee({
    orgId: input.orgId,
    returnDate: header.document_date,
    currency: header.currency,
    credited,
    waived: false,
    waiveReason: null,
  })
}

async function createVendorReturnDrafts(input: {
  orgId: string
  actorId: string
  rma: ReturnAuthorization
  rmaDocumentDate: string
  inspectionLines: InspectionLine[]
}): Promise<string[]> {
  const byVendor = new Map<string, InspectionLine[]>()
  for (const decision of input.inspectionLines) {
    if (decision.disposition !== 'vendor-return' || lineIsZero(decision.accepted)) continue
    const vendorId = decision.vendorId
    if (!vendorId) throw new Error(`RMA line ${decision.lineId} requires a vendor`)
    const group = byVendor.get(vendorId) ?? []
    group.push(decision)
    byVendor.set(vendorId, group)
  }
  const created: string[] = []
  for (const [vendorId, lines] of byVendor) {
    const key = randomUUID()
    const result = await createDocument({
      orgId: input.orgId,
      userId: input.actorId,
      kind: 'vendor_credit',
      key,
      subsidiaryId: input.rma.subsidiaryId,
      requestBody: { kind: 'vendor_credit', rmaId: input.rma.id, vendorId },
      body: {
        partyId: vendorId,
        subsidiaryId: input.rma.subsidiaryId,
        documentDate: input.rmaDocumentDate,
        referenceNumber: input.rma.documentNumber,
        memo: `Vendor return requested from ${input.rma.documentNumber}`,
      },
    })
    if (result.status === 'created') {
      created.push(result.id)
      await runRecordFlows({ kind: 'on_create', source: 'ui' }, 'vendor_credit', result.id, { orgId: input.orgId, userId: input.actorId })
      if (result.deferredUpdate) await runRecordFlows(result.deferredUpdate, 'vendor_credit', result.id, { orgId: input.orgId, userId: input.actorId })
    }
    const link = await db.execute(sql`
      insert into document_links (org_id, from_document_id, to_document_id, link_type, created_by, updated_by)
      values (${input.orgId}, ${input.rma.id}, ${result.id}, 'created_from', ${input.actorId}, ${input.actorId})
      -- A retry may observe this same relationship after a vendor draft replay;
      -- the read below proves the expected edge exists before continuing.
      on conflict (org_id, from_document_id, to_document_id, link_type) do nothing
      returning id`)
    if (link.rows.length !== 1) {
      const existing = await db.execute(sql`
        select id from document_links where org_id = ${input.orgId} and from_document_id = ${input.rma.id}
          and to_document_id = ${result.id} and link_type = 'created_from'`)
      if (existing.rows.length !== 1) throw new Error('vendor credit link was not recorded')
    }
    for (const decision of lines) {
      const updated = await db.execute(sql`
        update rma_lines set vendor_credit_id = ${result.id}, updated_by = ${input.actorId}, updated_at = now()
         where org_id = ${input.orgId} and document_id = ${input.rma.id} and line_id = ${decision.lineId}
           and disposition = 'vendor-return' and vendor_credit_id is null`)
      if (updated.rowCount !== 1) {
        const existing = await db.execute(sql`
          select vendor_credit_id from rma_lines where org_id = ${input.orgId} and document_id = ${input.rma.id} and line_id = ${decision.lineId}`)
        if (existing.rows[0]?.vendor_credit_id !== result.id) throw new Error(`vendor credit for RMA line ${decision.lineId} was not recorded`)
      }
    }
  }
  return created
}

async function linkReturnDocument(rmaId: string, childId: string, orgId: string, actorId: string): Promise<void> {
  const inserted = await db.execute(sql`
    insert into document_links (org_id, from_document_id, to_document_id, link_type, created_by, updated_by)
    values (${orgId}, ${rmaId}, ${childId}, 'created_from', ${actorId}, ${actorId})
    -- A customer credit is created once per inspected RMA; a retry may
    -- encounter its already recorded edge, which is verified immediately.
    on conflict (org_id, from_document_id, to_document_id, link_type) do nothing
    returning id`)
  if (inserted.rowCount === 1) return
  const existing = await db.execute(sql`
    select id from document_links where org_id = ${orgId} and from_document_id = ${rmaId}
      and to_document_id = ${childId} and link_type = 'created_from'`)
  if (existing.rows.length !== 1) throw new Error('customer credit link was not recorded')
}

function lineIsZero(value: string): boolean {
  const exact = canonicalDecimal(value, 8)
  return exact !== null && compareDecimal(exact, '0') === 0
}

function customerCreditKey(rmaId: string): string {
  const bytes = createHash('sha256').update(`customer-return:${rmaId}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Inspect received goods, issue the customer credit, write off scrap, and stage vendor credits. */
export async function inspectReturnAuthorization(input: {
  orgId: string
  actorId: string
  documentId: string
  inspectionLines: InspectionLine[]
  allowedSubsidiaryIds: ReadonlySet<string> | null
  /** The inspect route authorizes the grant before passing these through. */
  waiveFee?: boolean
  waiveReason?: string | null
}): Promise<{ authorization: ReturnAuthorization; awaitingCreditApproval: boolean }> {
  let postedCreditId: string | null = null
  const result = await withOrgTransaction(input.orgId, async () => {
    const current = await getReturnAuthorization(db, input.orgId, input.documentId, input.allowedSubsidiaryIds)
    if (current.stage === 'done') return { authorization: current, awaitingCreditApproval: false }
    if (current.stage !== 'receiving' && current.stage !== 'inspected') {
      throw new ReturnRefusal(`${current.documentNumber} must be received before inspection`, 'wrong_stage', 409, 'Receive the authorized goods before inspection')
    }
    validateReturnInspection(current, input.inspectionLines)
    const header = (await db.execute<{ party_id: string; subsidiary_id: string; document_date: string; status: string; currency: string }>(sql`
      select party_id, subsidiary_id, document_date::text, status, currency
        from documents where org_id = ${input.orgId} and id = ${input.documentId} and kind = 'rma'`)).rows[0]
    if (!header) throw new ReturnRefusal('Return authorization not found', 'not_found', 404)
    const quantum = await creditQuantum(header.currency)
    const scale = quantumScale(quantum)
    let creditId = current.customerCreditId
    let awaitingCreditApproval = false
    if (!creditId) {
      const linesById = new Map(current.lines.map((line) => [line.lineId, line]))
      const creditLines: DocumentLineInput[] = []
      const credited: Array<{ lineId: string; itemId: string | null; lineTotalMinor: bigint }> = []
      const claims: OrderLineClaims = new Map()
      for (const decision of input.inspectionLines) {
        const rmaLine = linesById.get(decision.lineId)
        if (!rmaLine?.sourceIssueMovementId) throw new ReturnRefusal(`RMA line ${decision.lineId} has no return source`, 'source_unavailable', 422, 'Reload the authorized return lines')
        const line = await customerCreditLine(input.orgId, current.id, decision, rmaLine.sourceIssueMovementId, claims)
        if (line) {
          creditLines.push(line)
          credited.push({ lineId: decision.lineId, itemId: rmaLine.itemId ?? null, lineTotalMinor: roundDiv(toUnits(line.amount), scale) })
        }
      }
      if (creditLines.length === 0) throw new ReturnRefusal('Accept at least one unit before issuing a customer credit', 'invalid_input', 422, 'Accept a received quantity for at least one line')
      // The restocking fee rides on the accepted value: one income line per
      // fee-bearing return line, reducing the credit the customer receives.
      const fee = await resolveInspectionRestockingFee({
        orgId: input.orgId,
        returnDate: header.document_date,
        currency: header.currency,
        credited,
        waived: input.waiveFee === true,
        waiveReason: input.waiveReason ?? null,
      })
      for (const feeLine of restockingFeeCreditLines(fee)) creditLines.push(feeLine)
      if (input.waiveFee === true && BigInt(fee.unwaivedTotalMinor) > 0n) {
        await recordRestockingFeeWaiver(db, input.orgId, input.actorId, input.documentId, {
          totalMinor: fee.unwaivedTotalMinor,
          currency: fee.currency,
          minorUnits: fee.minorUnits,
          reason: (input.waiveReason ?? '').trim(),
        })
      }
      // A return against an invoice credits that invoice's own receivable
      // account, so the credit can be applied to it; a fulfillment-sourced
      // return resolves like any credit memo (customer default, else the
      // organization control).
      const sourceControlAccountId = current.sourceDocumentId
        ? await postedDocumentControlAccount(db, input.orgId, current.sourceDocumentId)
        : null
      const created = await createDocument({
        orgId: input.orgId,
        userId: input.actorId,
        kind: 'customer_credit',
        key: customerCreditKey(current.id),
        subsidiaryId: header.subsidiary_id,
        requestBody: { kind: 'customer_credit', rmaId: current.id, lines: input.inspectionLines },
        body: {
          partyId: header.party_id,
          subsidiaryId: header.subsidiary_id,
          documentDate: header.document_date,
          referenceNumber: current.documentNumber,
          memo: `Customer return under ${current.documentNumber}`,
          lines: creditLines,
          ...(sourceControlAccountId ? { custom: { controlAccountId: sourceControlAccountId } } : {}),
        },
      })
      creditId = created.id
      if (created.status === 'created') {
        await runRecordFlows({ kind: 'on_create', source: 'ui' }, 'customer_credit', created.id, { orgId: input.orgId, userId: input.actorId })
        if (created.deferredUpdate) await runRecordFlows(created.deferredUpdate, 'customer_credit', created.id, { orgId: input.orgId, userId: input.actorId })
      }
      const submission = await submitAndReleaseIfUngated('customer_credit', creditId, input.actorId)
      if (submission.flowError) throw new ReturnRefusal(submission.flowError, 'approval_routing_failed', 422, 'Correct the customer credit approval flow, then inspect again')
      awaitingCreditApproval = submission.gated
      const inspected = await recordReturnInspection(
        db, input.orgId, input.actorId, input.documentId, input.inspectionLines, creditId, input.allowedSubsidiaryIds,
      )
      await linkReturnDocument(inspected.id, creditId, input.orgId, input.actorId)
      await createVendorReturnDrafts({
        orgId: input.orgId,
        actorId: input.actorId,
        rma: inspected,
        rmaDocumentDate: header.document_date,
        inspectionLines: input.inspectionLines,
      })
      if (awaitingCreditApproval) return { authorization: await getReturnAuthorization(db, input.orgId, input.documentId, input.allowedSubsidiaryIds), awaitingCreditApproval: true }
    } else {
      const credit = (await db.execute<{ status: string }>(sql`
        select status from documents where org_id = ${input.orgId} and id = ${creditId} and kind = 'customer_credit'`)).rows[0]
      if (!credit) throw new ReturnRefusal('Return authorization customer credit not found', 'not_found', 404)
      if (credit.status === 'pending_approval') {
        return { authorization: current, awaitingCreditApproval: true }
      }
      if (credit.status !== 'approved' && credit.status !== 'posted') {
        throw new ReturnRefusal(`Customer credit is ${credit.status}; resolve it before completing the return`, 'wrong_stage', 409, 'Resolve or resubmit the customer credit, then inspect the return again')
      }
    }

    if (!creditId) throw new ReturnRefusal('Customer credit was not created', 'wrong_stage', 409, 'Reload the return authorization and inspect it again')
    const creditStatus = (await db.execute<{ status: string }>(sql`
      select status from documents where org_id = ${input.orgId} and id = ${creditId} and kind = 'customer_credit'`)).rows[0]?.status
    if (creditStatus === 'approved') {
      await postDocument(creditId, await controlDeps(input.orgId), {
        deferEffects: true,
        audit: { actorId: input.actorId, source: 'ui' },
      })
    } else if (creditStatus !== 'posted') {
      throw new ReturnRefusal(`Customer credit is ${creditStatus ?? 'missing'}`, 'wrong_stage', 409, 'Approve the customer credit before completing inspection')
    }
    postedCreditId = creditId
    return { authorization: await getReturnAuthorization(db, input.orgId, input.documentId, input.allowedSubsidiaryIds), awaitingCreditApproval: false }
  })
  if (!postedCreditId) return result
  // Posting commits its durable effect row first; stock receipts run after that
  // commit, before scrap leaves the quarantine location.
  await runPostDocumentEffects(postedCreditId, 'approved', { actorId: input.actorId })
  const authorization = await withOrgTransaction(input.orgId, async () => {
    const rma = await getReturnAuthorization(db, input.orgId, input.documentId, input.allowedSubsidiaryIds)
    if (rma.stage === 'done') return rma
    for (const line of rma.lines) {
      if (line.disposition !== 'scrap' || line.accepted === '0' || line.scrapMovementId || !line.itemId || !line.dispositionLocationId) continue
      const header = (await db.execute<{ subsidiary_id: string; document_date: string }>(sql`
        select subsidiary_id, document_date::text from documents where org_id = ${input.orgId} and id = ${input.documentId}`)).rows[0]
      if (!header) throw new ReturnRefusal('Return authorization not found', 'not_found', 404)
      const idempotencyKey = `rma-scrap:${input.documentId}:${line.lineId}`
      let movementId = await findScrapMovement(input.orgId, idempotencyKey, line)
      if (!movementId) {
        try {
          const acceptedQuantity = canonicalDecimal(line.accepted, 8)
          if (acceptedQuantity === null) throw new ReturnRefusal(`Accepted quantity for RMA line ${line.lineId} is unreadable`, 'invalid_quantity', 422, 'Reload the return authorization and enter an exact accepted quantity')
          movementId = (await adjustInventory(input.orgId, input.actorId, {
            itemId: line.itemId,
            stockLocationId: line.dispositionLocationId,
            quantityDelta: `-${acceptedQuantity}`,
            subsidiaryId: header.subsidiary_id,
            date: header.document_date,
            idempotencyKey,
            lotId: line.lotId,
            serialId: line.serialId,
            memo: `Scrap from return authorization ${rma.documentNumber}`,
          })).movementId
        } catch (error) {
          if (!isUniqueConstraintError(error)) throw error
          movementId = await findScrapMovement(input.orgId, idempotencyKey, line)
          if (!movementId) throw error
        }
      }
      if (!movementId) throw new ReturnRefusal(`Scrap movement for RMA line ${line.lineId} was not recorded`, 'changed_concurrently', 409, 'Reload the return authorization and retry inspection')
      const recorded = await db.execute(sql`
        update rma_lines set scrap_movement_id = ${movementId}, updated_by = ${input.actorId}, updated_at = now()
         where org_id = ${input.orgId} and document_id = ${input.documentId} and line_id = ${line.lineId}
           and disposition = 'scrap' and scrap_movement_id is null`)
      if (recorded.rowCount !== 1) {
        const current = await db.execute<{ scrap_movement_id: string | null }>(sql`
          select scrap_movement_id from rma_lines where org_id = ${input.orgId} and document_id = ${input.documentId} and line_id = ${line.lineId}`)
        if (current.rows[0]?.scrap_movement_id !== movementId) {
          throw new ReturnRefusal(`Scrap for RMA line ${line.lineId} changed concurrently`, 'changed_concurrently', 409, 'Reload the return authorization and retry inspection')
        }
      }
    }
    return completeReturnInspection(db, input.orgId, input.actorId, input.documentId, input.allowedSubsidiaryIds)
  })
  return { authorization, awaitingCreditApproval: false }
}

async function findScrapMovement(orgId: string, idempotencyKey: string, line: ReturnAuthorization['lines'][number]): Promise<string | null> {
  const row = (await db.execute<{ id: string; item_id: string; stock_location_id: string; quantity: string; lot_id: string | null; serial_id: string | null }>(sql`
    select id, item_id, stock_location_id, quantity::text, lot_id, serial_id
      from inventory_movements
     where org_id = ${orgId} and idempotency_key = ${idempotencyKey} and kind = 'issue' and status = 'posted'`)).rows[0]
  if (!row) return null
  if (row.item_id !== line.itemId || row.stock_location_id !== line.dispositionLocationId
    || row.lot_id !== line.lotId || row.serial_id !== line.serialId
    || compareDecimal(row.quantity, `-${line.accepted}`) !== 0) {
    throw new ReturnRefusal(`Scrap movement for RMA line ${line.lineId} conflicts with its inspection`, 'changed_concurrently', 409, 'Contact an administrator to review the inventory movement before retrying')
  }
  return row.id
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const shape = error as { code?: unknown; cause?: { code?: unknown } }
  return shape.code === '23505' || shape.cause?.code === '23505'
}

export async function sendReturnAuthorizationEmail(input: {
  orgId: string
  actorId: string
  documentId: string
  type: 'received' | 'decision'
  to?: string
  allowedSubsidiaryIds: ReadonlySet<string> | null
}): Promise<{ to: string; subject: string }> {
  const authorization = await loadReturnAuthorization(input.orgId, input.documentId, input.allowedSubsidiaryIds)
  const validStage = input.type === 'received'
    ? authorization.stage === 'receiving' || authorization.stage === 'inspected' || authorization.stage === 'done'
    : authorization.stage === 'done' || authorization.stage === 'rejected'
  if (!validStage) {
    throw new ReturnRefusal(
      `${authorization.documentNumber} is not ready for this email`,
      'wrong_stage',
      409,
      input.type === 'received' ? 'Record receipt of the customer goods before sending this message' : 'Complete inspection or reject the authorization before sending its decision',
    )
  }
  const party = (await db.execute<{ email: string | null; display_name: string | null; org_name: string }>(sql`
    select p.email, p.display_name, o.name as org_name
      from orgs o left join parties p on p.org_id = o.id and p.id = ${authorization.customerId}
     where o.id = ${input.orgId}`)).rows[0]
  const to = input.to?.trim() || party?.email?.trim() || ''
  if (!to) throw new ReturnRefusal('No recipient email', 'invalid_input', 422, "Enter a recipient or add an email address to the customer's record")
  const transport = await resolveOrgEmailTransport(input.orgId)
  if (!transport) throw new ReturnRefusal('Email delivery is not configured', 'invalid_input', 422, 'Set up email delivery in Admin → Email')
  const linkedCredit = authorization.customerCreditId
    ? (await db.execute<{ document_number: string }>(sql`select document_number from documents where org_id = ${input.orgId} and id = ${authorization.customerCreditId}`)).rows[0]?.document_number
    : null
  const reason = input.type === 'decision' && authorization.stage === 'rejected'
    ? (await db.execute<{ rejection_reason: string | null }>(sql`select rejection_reason from rma_documents where org_id = ${input.orgId} and document_id = ${input.documentId}`)).rows[0]?.rejection_reason
    : null
  const body = input.type === 'received'
    ? returnReceivedEmail({ orgName: party?.org_name || 'OpenBooks', recipientName: party?.display_name, rmaNumber: authorization.documentNumber })
    : returnDecisionEmail({ orgName: party?.org_name || 'OpenBooks', recipientName: party?.display_name, rmaNumber: authorization.documentNumber, customerCreditNumber: linkedCredit, reason })
  const logId = await insertEmailLog({
    orgId: input.orgId,
    recipients: [to],
    subject: body.subject,
    status: 'queued',
    categoryKey: 'document',
    meta: { recordType: 'rma', recordId: input.documentId, event: input.type },
    actor: { kind: 'user', userId: input.actorId },
  })
  let uncertaintyRecorded = false
  try {
    const outcome = await sendVia(transport, { to, subject: body.subject, html: body.html, text: body.text }, {
      deliveryKey: deriveEmailDeliveryKey({ orgId: input.orgId, scope: `direct:${logId}`, to }),
    })
    if (outcome.kind === 'sent') await markEmailSent(input.orgId, logId, outcome.providerMessageId)
    else {
      uncertaintyRecorded = true
      await markEmailUncertain(input.orgId, logId, outcome.reason)
      throw new Error(outcome.reason)
    }
  } catch (error) {
    if (!uncertaintyRecorded) await markEmailFailed(input.orgId, logId, error instanceof Error ? error.message : String(error))
    throw error
  }
  return { to, subject: body.subject }
}

export async function loadReturnAuthorization(
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<ReturnAuthorization> {
  return withOrgContext(orgId, () => getReturnAuthorization(db, orgId, documentId, allowedSubsidiaryIds))
}

export async function findReturnAuthorization(
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<ReturnAuthorization | null> {
  try {
    return await loadReturnAuthorization(orgId, documentId, allowedSubsidiaryIds)
  } catch (error) {
    if (error instanceof ReturnRefusal && error.code === 'not_found') return null
    throw error
  }
}

export async function loadReturnAuthorizations(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<ReturnAuthorization[]> {
  return withOrgContext(orgId, () => listReturnAuthorizations(db, orgId, allowedSubsidiaryIds))
}

export async function loadReturnableSources(input: {
  orgId: string
  partyId: string
  subsidiaryId: string
  itemId?: string
  stockLocationId?: string
  allowedSubsidiaryIds: ReadonlySet<string> | null
}): Promise<Awaited<ReturnType<typeof returnableSources>> | null> {
  if (!subsidiaryScopeAllows(input.allowedSubsidiaryIds, input.subsidiaryId)) return null
  return withOrgContext(input.orgId, async () => {
    const party = (await db.execute<{ subsidiary_id: string | null }>(sql`
      select subsidiary_id from parties where org_id = ${input.orgId} and id = ${input.partyId}`)).rows[0]
    if (!party || !subsidiaryScopeAllows(input.allowedSubsidiaryIds, party.subsidiary_id, { orgWideNull: true })) {
      return null
    }
    return returnableSources(db, input.orgId, {
      side: 'sales',
      partyId: input.partyId,
      itemId: input.itemId,
      stockLocationId: input.stockLocationId,
      subsidiaryIds: input.allowedSubsidiaryIds === null
        ? [input.subsidiaryId]
        : input.allowedSubsidiaryIds.has(input.subsidiaryId) ? [input.subsidiaryId] : [],
      limit: 200,
    })
  })
}

export async function loadReturnPartyScope(orgId: string, partyId: string): Promise<{ subsidiaryId: string | null } | null> {
  return withOrgContext(orgId, async () => {
    const row = (await db.execute<{ subsidiary_id: string | null }>(sql`
      select subsidiary_id from parties where org_id = ${orgId} and id = ${partyId}`)).rows[0]
    return row ? { subsidiaryId: row.subsidiary_id } : null
  })
}
