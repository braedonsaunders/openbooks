import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { loadChannelOrder } from '@openbooks/engine/src/commerce/orders.ts'
import { getPostingPolicy } from '@openbooks/engine/src/commerce/posting-policies.ts'
import { isoDateOf } from '@openbooks/engine/src/platform/civil-date.ts'

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
  summary: { id: string; summaryDate: string; documentNumber: string | null } | null
  exception: { code: string; reason: string; remedy: string } | null
  canManage: boolean
  remountKey: string
}

function documentHrefFor(kind: string, id: string): string | null {
  if (kind === 'cash_sale' || kind === 'cash_refund') return `/cash-sales?doc=${id}`
  if (kind === 'sales_order') return `/sales-orders?order=${id}`
  if (kind === 'customer_invoice') return `/ar/invoices?doc=${id}`
  return null
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
    summary,
    exception: order.postingStatus === 'exception' && order.exceptionCode
      ? { code: order.exceptionCode, reason: order.exceptionReason ?? '', remedy: order.exceptionRemedy ?? '' }
      : null,
    canManage,
    remountKey: order.id,
  }
}
