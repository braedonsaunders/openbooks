import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { can, requirePermission } from '../../../lib/authz'
import { isUuid, mergeHref } from '../../../lib/list-params'

/**
 * Minimal subscription record for the subscription drawer (list-drawer
 * route): the plan, the customer, the billing rhythm, the bill-to/payer
 * overrides behind the next invoice, and the revenue contract link when the
 * subscription feeds one. Read-only; mutations travel through the
 * subscriptions API the collections table already uses.
 */
export interface SubscriptionDrawerData {
  id: string
  remountKey: string
  planName: string
  customer: { id: string; name: string }
  status: 'active' | 'paused' | 'suspended' | 'canceled'
  startOn: string
  nextBillOn: string
  interval: string
  intervalCount: number
  quantity: string
  amount: string
  currency: string
  autoPost: boolean
  billTo: { id: string; name: string } | null
  payer: { id: string; name: string } | null
  lastInvoice: { id: string; number: string } | null
  contract: { id: string; number: string } | null
  lastError: string | null
  canManage: boolean
  closeHref: string
  /** Active customers for the bill-to/payer pickers (empty without manage). */
  customers: { id: string; name: string }[]
}

type SubscriptionDrawerRow = {
  id: string
  status: string
  startOn: string
  nextBillOn: string
  interval: string
  intervalCount: number
  quantity: string
  amount: string
  currency: string
  autoPost: boolean
  planName: string
  customerId: string
  customerName: string
  billToId: string | null
  billToName: string | null
  payerId: string | null
  payerName: string | null
  lastInvoiceId: string | null
  lastInvoiceNumber: string | null
  lastError: string | null
  contractId: string | null
  contractNumber: string | null
}

export async function loadSubscriptionDrawer(
  sp: Record<string, string | string[] | undefined>,
): Promise<{ drawer: SubscriptionDrawerData | null }> {
  const authz = await requirePermission('ar.read')
  const orgId = authz.user.orgId
  const rawId = typeof sp.subscription === 'string' ? sp.subscription : undefined
  const id = rawId && isUuid(rawId) ? rawId : undefined
  if (!id) return { drawer: null }
  const rows = (
    await db.execute<SubscriptionDrawerRow>(sql`
      select s.id, s.status, s.start_on::text as "startOn", s.next_bill_on::text as "nextBillOn",
             p.interval, p.interval_count as "intervalCount", s.quantity::text as quantity,
             coalesce(s.price_override, p.amount)::text as amount,
             p.currency_code as currency, s.auto_post as "autoPost", p.name as "planName",
             s.customer_id as "customerId", c.display_name as "customerName",
             s.bill_to_party_id as "billToId", bt.display_name as "billToName",
             s.payer_party_id as "payerId", py.display_name as "payerName",
             s.last_invoice_id as "lastInvoiceId", d.document_number as "lastInvoiceNumber",
             s.last_error as "lastError",
             rc.id as "contractId", rc.contract_number as "contractNumber"
        from subscriptions s
        join subscription_plans p on p.id = s.plan_id and p.org_id = s.org_id
        left join parties c on c.id = s.customer_id and c.org_id = s.org_id
        left join parties bt on bt.id = s.bill_to_party_id and bt.org_id = s.org_id
        left join parties py on py.id = s.payer_party_id and py.org_id = s.org_id
        left join documents d on d.id = s.last_invoice_id and d.org_id = s.org_id
        left join revenue_contracts rc on rc.subscription_id = s.id and rc.org_id = s.org_id
       where s.org_id = ${orgId} and s.id = ${id}
       limit 1`)
  ).rows
  const row = rows[0]
  if (!row) return { drawer: null }
  // The override editor shares the subscriptions write right (ar.create),
  // never a second gate: whoever edits subscriptions edits overrides.
  const canManage = can(authz, 'ar.create')
  const customers = canManage
    ? (
        await db.execute<{ id: string; name: string }>(sql`
          select p.id, p.display_name as name from parties p
           where p.org_id = ${orgId} and p.is_active
             and exists (select 1 from customer_roles cr
                          where cr.org_id = p.org_id and cr.party_id = p.id and cr.is_active)
           order by p.display_name limit 500`)
      ).rows
    : []
  return {
    drawer: {
      id: row.id,
      remountKey: row.id,
      planName: row.planName,
      customer: { id: row.customerId, name: row.customerName ?? row.customerId },
      status: (['active', 'paused', 'suspended', 'canceled'] as const).includes(row.status as 'active')
        ? (row.status as SubscriptionDrawerData['status'])
        : 'active',
      startOn: row.startOn,
      nextBillOn: row.nextBillOn,
      interval: row.interval,
      intervalCount: row.intervalCount,
      quantity: row.quantity,
      amount: row.amount,
      currency: row.currency,
      autoPost: row.autoPost,
      billTo: row.billToId ? { id: row.billToId, name: row.billToName ?? row.billToId } : null,
      payer: row.payerId ? { id: row.payerId, name: row.payerName ?? row.payerId } : null,
      lastInvoice: row.lastInvoiceId
        ? { id: row.lastInvoiceId, number: row.lastInvoiceNumber ?? row.lastInvoiceId.slice(0, 8) }
        : null,
      contract: row.contractId
        ? { id: row.contractId, number: row.contractNumber ?? row.contractId.slice(0, 8) }
        : null,
      lastError: row.lastError,
      canManage,
      closeHref: mergeHref('/collections', sp, { subscription: undefined, mode: undefined, form: undefined }),
      customers,
    },
  }
}
