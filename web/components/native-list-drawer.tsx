'use client'

import type { ComponentProps } from 'react'
import { DocumentDrawer } from './document-drawer'
import { TaxProviderStatusChip, type TaxProviderChipRow } from './tax-provider-chip'
import { ReturnWorkflowPanel } from '../app/(app)/returns/ReturnWorkflowPanel'
import type { ReturnAuthorization } from '@openbooks/engine/sales/returns/contracts'
import { PaymentLinksPanel } from './payment-links-panel'
import { SupplyEvidencePanel } from './supply-evidence-panel'
import { AppliedPaymentsPanel, type AppliedPayment } from './applied-payments-panel'
import { CreditApplicationsPanel } from './credit-applications-panel'
import { FieldTicketDrawer } from '../app/(app)/field-tickets/FieldTicketDrawer'
import { ExpenseDrawer } from '../app/(app)/expenses/ExpenseDrawer'
import { OrderDrawer } from '../app/(app)/_order/OrderDrawer'
import { PickListDrawer } from '../app/(app)/picks/PickListDrawer'
import { ShipmentDrawer } from '../app/(app)/shipments/ShipmentDrawer'
import { PaymentDrawer } from '../app/(app)/payments/PaymentDrawer'
import { SubscriptionDrawer } from '../app/(app)/collections/SubscriptionDrawer'
import type { NativeListDrawerData } from '../lib/list/drawer-routes'
import type { ReceiptDrawerPayload } from '../app/(app)/receipts/view'
import type { SubscriptionDrawerData } from '../app/(app)/collections/subscription-drawer'

const renderers = {
  'document-drawer': (props: { drawer: unknown }) => {
    const drawer = props.drawer as
      | (ComponentProps<typeof DocumentDrawer> & {
          remountKey: string
          paymentLinks?: { documentId: string; canManage: boolean } | null
          appliedPayments?: { payments: AppliedPayment[]; currency: string } | null
          creditApplications?: {
            documentId: string
            side: 'ap' | 'ar'
            partyId: string | null
            canApply: boolean
          } | null
          workflow?: ReturnAuthorization | null
          workflowCanInspect?: boolean
          workflowCanManage?: boolean
          workflowCanWaiveFee?: boolean
          workflowCurrency?: string | null
          vendors?: { id: string; display_name: string }[]
          supplyEvidence?: { documentId: string; status: string; canManage: boolean } | null
          taxProvider?: {
            documentNumber: string
            provider: string
            rows: TaxProviderChipRow[]
            canRetry: boolean
          } | null
        })
      | null
    if (!drawer) return null
    const { remountKey, paymentLinks, appliedPayments, creditApplications, workflow, workflowCanInspect, workflowCanManage, workflowCanWaiveFee, workflowCurrency, vendors, supplyEvidence, taxProvider, ...rest } = drawer
    return (
      <DocumentDrawer
        key={remountKey}
        {...rest}
        afterContent={
          paymentLinks || appliedPayments || creditApplications || workflow || supplyEvidence || taxProvider ? (
            <>
              {supplyEvidence ? (
                <SupplyEvidencePanel
                  documentId={supplyEvidence.documentId}
                  status={supplyEvidence.status}
                  canManage={supplyEvidence.canManage}
                />
              ) : null}
              {taxProvider ? (
                <TaxProviderStatusChip
                  documentNumber={taxProvider.documentNumber}
                  provider={taxProvider.provider}
                  rows={taxProvider.rows}
                  canRetry={taxProvider.canRetry}
                />
              ) : null}
              {appliedPayments ? (
                <AppliedPaymentsPanel payments={appliedPayments.payments} currency={appliedPayments.currency} />
              ) : null}
              {creditApplications ? (
                <CreditApplicationsPanel
                  documentId={creditApplications.documentId}
                  side={creditApplications.side}
                  partyId={creditApplications.partyId}
                  canApply={creditApplications.canApply}
                />
              ) : null}
              {paymentLinks ? (
                <PaymentLinksPanel documentId={paymentLinks.documentId} canManage={paymentLinks.canManage} />
              ) : null}
              {workflow ? (
                <ReturnWorkflowPanel
                  authorization={workflow}
                  canInspect={workflowCanInspect === true}
                  canManage={workflowCanManage === true}
                  canWaiveFee={workflowCanWaiveFee === true}
                  currency={workflowCurrency ?? undefined}
                  stockLocations={rest.stockLocations ?? []}
                  vendors={vendors ?? []}
                />
              ) : null}
            </>
          ) : null
        }
      />
    )
  },
  'field-ticket-drawer': (props: { drawer: unknown }) => {
    const drawer = props.drawer as ComponentProps<typeof FieldTicketDrawer> | null
    if (!drawer) return null
    return <FieldTicketDrawer {...drawer} />
  },
  'expense-drawer': (props: { drawer: unknown }) => {
    const drawer = props.drawer as (ComponentProps<typeof ExpenseDrawer> & { remountKey: string }) | null
    if (!drawer) return null
    const { remountKey, ...rest } = drawer
    return <ExpenseDrawer key={remountKey} {...rest} />
  },
  'order-drawer': (props: { drawer: unknown }) => {
    const drawer = props.drawer as (ComponentProps<typeof OrderDrawer> & { remountKey: string }) | null
    if (!drawer) return null
    const { remountKey, ...rest } = drawer
    return <OrderDrawer key={remountKey} {...rest} />
  },
  'pick-list-drawer': (props: { drawer: unknown }) => {
    const drawer = props.drawer as ComponentProps<typeof PickListDrawer>['data'] | null
    if (!drawer) return null
    return <PickListDrawer key={drawer.document.id} data={drawer} />
  },
  'shipment-drawer': (props: { drawer: unknown }) => {
    const drawer = props.drawer as (ComponentProps<typeof ShipmentDrawer>['data'] & { initialMode?: 'view' | 'edit' }) | null
    if (!drawer) return null
    const { initialMode, ...data } = drawer
    return <ShipmentDrawer key={data.document.id} data={data} initialMode={initialMode} />
  },
  'payment-drawer': (props: { drawer: unknown }) => {
    const payload = props.drawer as ReceiptDrawerPayload | null
    if (!payload || payload.flyout.mode !== 'record') return null
    const flyout = payload.flyout
    return (
      <PaymentDrawer
        key={String(flyout.payment.doc.id)}
        payment={flyout.payment}
        initialMode={payload.initialMode}
        initialOpenItems={flyout.initialOpenItems}
        parties={flyout.parties}
        bankAccounts={flyout.bankAccounts}
        side={flyout.side}
        basePath={payload.basePath}
        layout={flyout.layout}
        storedValue={flyout.storedValue}
        closeHref={payload.closeHref}
      />
    )
  },
  'subscription-drawer': (props: { drawer: unknown }) => {
    const drawer = props.drawer as SubscriptionDrawerData | null
    if (!drawer) return null
    return <SubscriptionDrawer key={drawer.remountKey} drawer={drawer} closeHref={drawer.closeHref} />
  },
}

/** One renderer for server deep links and client-loaded list records. The
 * native record owns its dialog; no loading dialog wraps a second dialog. */
export function NativeListDrawer({ widget, drawer }: NativeListDrawerData) {
  return renderers[widget]({ drawer })
}
