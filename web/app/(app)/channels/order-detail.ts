import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { getOrderEconomics, loadChannelOrder } from '@openbooks/engine/commerce'
import { listChannelOrderEvents, reviveFulfilmentPayload, reviveRefundPayload } from '@openbooks/engine/commerce'
import { getPostingPolicy } from '@openbooks/engine/commerce'
import { isoDateOf } from '@openbooks/engine/platform/civil-date'

/**
 * Channel order drawer payload: the normalized order plus its posting
 * outcome, all JSON-safe (minor-unit totals travel as strings and become
 * house-formatted majors in the drawer).
 */
export interface ChannelOrderDrawerData {
  id: string
  orderNumber: string
  channelId: string
  channelName: string
  externalId: string
  status: string
  orderedAt: string
  financialStatus: string
  fulfilmentStatus: string
  customerName: string | null
  customerEmail: string | null
  currency: string
  currencyUnits: Record<string, number | null>
  presentmentCurrency: string
  presentmentRate: string | null
  subtotalMinor: string
  discountMinor: string
  shippingMinor: string
  taxMinor: string
  totalMinor: string
  tags: string[]
  source: string | null
  cancelledAt: string | null
  lines: { title: string; sku: string | null; quantity: string; unitMinor: string; discountMinor: string; taxMinor: string }[]
  shipping: { title: string; amountMinor: string }[]
  tenders: { gateway: string; amountMinor: string; giftCard: boolean; reference: string | null }[]
  policyMode: string | null
  document: { id: string; kind: string; number: string | null; status: string } | null
  documentHref: string | null
  timeline: ChannelOrderTimelineItem[]
  summary: { id: string; summaryDate: string; documentNumber: string | null } | null
  exception: { code: string; reason: string; remedy: string } | null
  canManage: boolean
  remountKey: string
  economics: {
    currency: string
    revenueMinor: string
    cm1Minor: string
    cm2Minor: string
    cm3Minor: string
    marginPct: string | null
    estimatedAny: boolean
    mixedCurrency: boolean
    storedValueMinor: string
    components: { component: string; sourceKind: string; currency: string; amountMinor: string; estimated: boolean }[]
  } | null
}

function documentHrefFor(kind: string, id: string): string | null {
  if (kind === 'cash_sale' || kind === 'cash_refund') return `/cash-sales?doc=${id}`
  if (kind === 'sales_order') return `/sales-orders?order=${id}`
  if (kind === 'customer_invoice') return `/ar/invoices?doc=${id}`
  return null
}

/**
 * One lifecycle entry behind the sale: a refund with its total, a
 * fulfilment with its tracking and shipped lines, a cancellation with its
 * reason, or a push to the storefront. Raw values only — the drawer
 * composes labels in the operator's locale.
 */
export interface ChannelOrderTimelineItem {
  id: string
  kind: string
  outbound: boolean
  status: string
  occurredAt: string
  amountMinor: string | null
  restocks: boolean
  tracking: string | null
  summary: string | null
  reason: string | null
  document: { id: string; kind: string; number: string | null } | null
  documentHref: string | null
  exception: { code: string; reason: string; remedy: string } | null
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

async function loadOrderTimeline(orgId: string, orderId: string): Promise<ChannelOrderTimelineItem[]> {
  const events = await listChannelOrderEvents(orgId, orderId)
  if (events.length === 0) return []
  const docIds = [...new Set(events.map((event) => event.postingDocumentId).filter((id): id is string => !!id))]
  const docs = docIds.length > 0
    ? (await db.execute<{ id: string; kind: string; document_number: string | null }>(
        sql`select id, kind, document_number from documents where org_id = ${orgId} and id = any(${docIds}::uuid[])`,
      )).rows
    : []
  const docById = new Map(docs.map((doc) => [doc.id, doc]))
  return events.map((event) => {
    const doc = (event.postingDocumentId && docById.get(event.postingDocumentId)) || null
    const document = doc ? { id: doc.id, kind: doc.kind, number: doc.document_number } : null
    const base = {
      id: event.id,
      status: event.postingStatus,
      occurredAt: event.occurredAt,
      document,
      documentHref: doc ? documentHrefFor(doc.kind, doc.id) : null,
      exception: event.postingStatus === 'exception' && event.exceptionCode
        ? { code: event.exceptionCode, reason: event.exceptionReason ?? '', remedy: event.exceptionRemedy ?? '' }
        : null,
    }
    if (event.kind === 'refund') {
      const refund = reviveRefundPayload(event.payload)
      return {
        ...base,
        kind: 'refund',
        outbound: false,
        amountMinor: String(refund.totalMinor),
        restocks: refund.lines.some((line) => line.restock),
        tracking: null,
        summary: null,
        reason: textOf(refund.reason),
      }
    }
    if (event.kind === 'fulfilment') {
      if ((event.payload.direction ?? 'inbound') === 'outbound') {
        return { ...base, kind: 'fulfilment', outbound: true, amountMinor: null, restocks: false, tracking: null, summary: null, reason: null }
      }
      const fulfilment = reviveFulfilmentPayload(event.payload)
      const tracking = [fulfilment.carrierName, fulfilment.trackingNumber].filter(Boolean).join(' · ') || null
      const summary = fulfilment.lines
        .map((line) => `${line.quantity} × ${line.sku ?? line.lineExternalId ?? '?'}`)
        .join(', ') || null
      return {
        ...base,
        kind: 'fulfilment',
        outbound: false,
        amountMinor: null,
        restocks: false,
        tracking,
        summary,
        reason: null,
      }
    }
    if (event.kind === 'cancellation') {
      const payload = event.payload as { reason?: unknown }
      return {
        ...base,
        kind: 'cancellation',
        outbound: false,
        amountMinor: null,
        restocks: false,
        tracking: null,
        summary: null,
        reason: textOf(payload.reason),
      }
    }
    return {
      ...base,
      kind: event.kind,
      outbound: false,
      amountMinor: null,
      restocks: false,
      tracking: null,
      summary: null,
      reason: null,
    }
  })
}

export async function loadChannelOrderDrawer(
  orgId: string,
  orderId: string,
  canManage: boolean,
): Promise<ChannelOrderDrawerData | null> {
  const order = await loadChannelOrder(orgId, orderId)
  if (!order) return null
  const [channelRow, docRow, summaryRow] = await Promise.all([
    db.execute<{ name: string }>(sql`select name from sales_channels where org_id = ${orgId} and id = ${order.channelId}`),
    order.postingDocumentId
      ? db.execute<{ kind: string; document_number: string | null; status: string }>(
          sql`select kind, document_number, status from documents where org_id = ${orgId} and id = ${order.postingDocumentId}`,
        )
      : Promise.resolve({ rows: [] as { kind: string; document_number: string | null; status: string }[] }),
    order.summaryId
      ? db.execute<{ summary_date: string; document_number: string | null }>(
          sql`select s.summary_date::text as summary_date, d.document_number
                from channel_daily_summaries s
                left join documents d on d.org_id = s.org_id and d.id = s.posting_document_id
               where s.org_id = ${orgId} and s.id = ${order.summaryId}`,
        )
      : Promise.resolve({ rows: [] as { summary_date: string; document_number: string | null }[] }),
  ])
  const policy = await getPostingPolicy(orgId, order.channelId, isoDateOf(new Date())).catch(() => null)
  // Margin facts may predate this drawer (orders posted before margin
  // tracking, or a recompute that never ran): absence renders the teaching
  // empty state with a refresh action, never a failure.
  const economics = await loadOrderEconomics(orgId, order.id, order.postingDocumentId)
  const timeline = await loadOrderTimeline(orgId, order.id)
  // Display precision for every currency on the drawer from the
  // authoritative registry; a missing row refuses at render, never guesses.
  const unitCodes = new Set<string>([order.shopCurrency])
  for (const component of economics?.components ?? []) unitCodes.add(component.currency)
  const unitRows = (await db.execute<{ code: string; minor_units: number | null }>(sql`
    select code, minor_units from currencies
     where code in (${sql.join([...unitCodes].map((code) => sql`${code}`), sql`, `)})
  `)).rows
  const currencyUnits: Record<string, number | null> = {}
  for (const code of unitCodes) {
    currencyUnits[code] = unitRows.find((row) => row.code === code)?.minor_units ?? null
  }
  const doc = order.postingDocumentId && docRow.rows[0]
    ? { id: order.postingDocumentId, kind: docRow.rows[0].kind, number: docRow.rows[0].document_number, status: docRow.rows[0].status }
    : null
  const summary = order.summaryId && summaryRow.rows[0]
    ? { id: order.summaryId, summaryDate: summaryRow.rows[0].summary_date, documentNumber: summaryRow.rows[0].document_number }
    : null
  return {
    id: order.id,
    orderNumber: order.externalNumber,
    channelId: order.channelId,
    channelName: channelRow.rows[0]?.name ?? '',
    externalId: order.externalId,
    status: order.postingStatus,
    orderedAt: order.orderedAt,
    financialStatus: order.financialStatus,
    fulfilmentStatus: order.fulfilmentStatus,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    currency: order.shopCurrency,
    currencyUnits,
    presentmentCurrency: order.presentmentCurrency,
    presentmentRate: order.presentmentRate,
    subtotalMinor: String(order.subtotalMinor),
    discountMinor: String(order.discountMinor),
    shippingMinor: String(order.shippingMinor),
    taxMinor: String(order.taxMinor),
    totalMinor: String(order.totalMinor),
    tags: order.tags,
    source: order.source,
    cancelledAt: order.cancelledAt,
    lines: order.lines.map((line) => ({
      title: line.title,
      sku: line.sku,
      quantity: line.quantity,
      unitMinor: String(line.priceMinor),
      discountMinor: String(line.discountMinor),
      taxMinor: String(line.taxLines.reduce((sum, tax) => sum + tax.amountMinor, 0n)),
    })),
    shipping: order.shippingLines.map((line) => ({ title: line.title, amountMinor: String(line.amountMinor) })),
    tenders: order.tenders.map((tender) => ({
      gateway: tender.gateway,
      amountMinor: String(tender.amountMinor),
      giftCard: tender.giftCardExternalId != null,
      reference: tender.authorizationRef,
    })),
    policyMode: policy?.mode ?? null,
    document: doc,
    documentHref: doc ? documentHrefFor(doc.kind, doc.id) : null,
    timeline,
    summary,
    exception: order.postingStatus === 'exception' && order.exceptionCode
      ? { code: order.exceptionCode, reason: order.exceptionReason ?? '', remedy: order.exceptionRemedy ?? '' }
      : null,
    canManage,
    remountKey: order.id,
    economics,
  }
}

async function loadOrderEconomics(
  orgId: string,
  orderId: string,
  postingDocumentId: string | null,
): Promise<ChannelOrderDrawerData['economics']> {
  const facts = await getOrderEconomics(orgId, orderId).catch(() => null)
  if (!facts || facts.facts.length === 0) return null
  const grouped = new Map<string, { component: string; sourceKind: string; currency: string; amountMinor: bigint; estimated: boolean }>()
  for (const fact of facts.facts) {
    const key = `${fact.component}|${fact.sourceKind}|${fact.currency}`
    const existing = grouped.get(key)
    if (existing) {
      existing.amountMinor += fact.amountMinor
      existing.estimated = existing.estimated || fact.estimated
    } else {
      grouped.set(key, {
        component: fact.component,
        sourceKind: fact.sourceKind,
        currency: fact.currency,
        amountMinor: fact.amountMinor,
        estimated: fact.estimated,
      })
    }
  }
  // Gift-card tenders settle a liability the sale already funded, so they
  // read beside the margin as context, never as a cost.
  const tenders = postingDocumentId
    ? await db.execute<{ total: string }>(sql`
        select coalesce(sum(amount_minor), 0)::text as total from document_tenders
         where org_id = ${orgId} and document_id = ${postingDocumentId} and kind = 'stored_value'`)
    : null
  return {
    currency: facts.currency,
    revenueMinor: facts.revenue.toString(),
    cm1Minor: facts.cm1.toString(),
    cm2Minor: facts.cm2.toString(),
    cm3Minor: facts.cm3.toString(),
    marginPct: facts.marginPct,
    estimatedAny: facts.estimatedAny,
    mixedCurrency: facts.mixedCurrency,
    storedValueMinor: tenders?.rows[0]?.total ?? '0',
    components: [...grouped.values()].map((row) => ({
      component: row.component,
      sourceKind: row.sourceKind,
      currency: row.currency,
      amountMinor: row.amountMinor.toString(),
      estimated: row.estimated,
    })),
  }
}
