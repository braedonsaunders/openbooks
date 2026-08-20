import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  loadPaymentDocument,
  openItemsForParty,
  PAYMENT_KIND_SIDE,
  type PaymentKind,
} from '@openbooks/engine/src/payments.ts'
import { RecordListView } from '../../../components/record-list-view'
import { isUuid } from '../../../lib/list-params'
import { NewPaymentButton } from './NewPaymentButton'
import { PaymentDrawer, type OpenItemClient } from './PaymentDrawer'
import { resolveFormLayout } from '../../../lib/customization/resolve'
import { pickString } from '../../../lib/list-params'

/**
 * Payment/receipt list, shared by /payments (vendor_payment) and /receipts
 * (customer_payment). The whole list — search, filters, saved views, sortable
 * typed table, drill-through, pagination — is the universal RecordListView;
 * this component only resolves the payment-specific ?payment= flyout.
 */
export async function PaymentsSection({
  sp,
  basePath,
  kind,
  orgId,
  userId,
  canManage,
  userRoles,
}: {
  sp: Record<string, string | string[] | undefined>
  basePath: string
  kind: PaymentKind
  orgId: string
  userId: string
  canManage: boolean
  userRoles: readonly string[]
}) {
  const t = await getTranslations('payments')
  const side = PAYMENT_KIND_SIDE[kind]
  const newLabel = t('list.newLabel', { side })

  // -- flyout ---------------------------------------------------------------
  const paymentId = typeof sp.payment === 'string' && isUuid(sp.payment) ? sp.payment : undefined
  const loaded = paymentId ? await loadPaymentDocument(paymentId, kind) : null
  const openPayment = loaded && loaded.doc.org_id === orgId ? loaded : null
  let drawer: React.ReactNode = null
  if (openPayment) {
    const partyFilter =
      side === 'ap'
        ? sql`exists (select 1 from vendor_roles vr where vr.party_id = p.id and vr.is_active)`
        : sql`exists (select 1 from customer_roles cr where cr.party_id = p.id and cr.is_active)`
    const [parties, banks] = await Promise.all([
      db.execute(sql`
        select id, display_name from parties p
         where p.org_id = ${orgId} and ${partyFilter} and is_active
         order by display_name limit 2000`) as any,
      db.execute(sql`
        select id, number, name from accounts
         where org_id = ${orgId} and type = 'asset_bank' and is_active and not is_summary
         order by number nulls last, name`) as any,
    ])
    const openItems: OpenItemClient[] =
      openPayment.doc.status === 'draft' && openPayment.doc.party_id
        ? await openItemsForParty(openPayment.doc.party_id as string, side)
        : []
    const resolvedForm = await resolveFormLayout({
      orgId,
      userId,
      recordType: kind,
      userRoles: [...userRoles],
      headerDefs: [],
      lineDefs: [],
      explicitLayoutId: pickString(sp.form),
    })
    drawer = (
      <PaymentDrawer
        payment={openPayment as any}
        key={(openPayment as any).doc.id}
        initialMode={pickString(sp.mode) === 'edit' ? 'edit' : 'view'}
        initialOpenItems={openItems}
        parties={parties.rows}
        bankAccounts={banks.rows}
        side={side}
        basePath={basePath}
        layout={resolvedForm.layout}
      />
    )
  }

  return (
    <RecordListView
      recordType={kind}
      basePath={basePath}
      orgId={orgId}
      userId={userId}
      canManage={canManage}
      sp={sp}
      drawer={drawer}
      emptyAction={<NewPaymentButton kind={kind} basePath={basePath} label={newLabel} />}
    />
  )
}
