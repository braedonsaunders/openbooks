'use client'

import type { ComponentProps } from 'react'
import { DocumentDrawer } from './document-drawer'
import { ReturnWorkflowPanel } from '../app/(app)/returns/ReturnWorkflowPanel'
import type { ReturnAuthorization } from '@openbooks/engine/sales/returns/contracts'
import { PaymentLinksPanel } from './payment-links-panel'
import { AppliedPaymentsPanel, type AppliedPayment } from './applied-payments-panel'
import { CreditApplicationsPanel } from './credit-applications-panel'
import { FieldTicketDrawer } from '../app/(app)/field-tickets/FieldTicketDrawer'
import { ExpenseDrawer } from '../app/(app)/expenses/ExpenseDrawer'
import { OrderDrawer } from '../app/(app)/_order/OrderDrawer'
import { PickListDrawer } from '../app/(app)/picks/PickListDrawer'
import { ShipmentDrawer } from '../app/(app)/shipments/ShipmentDrawer'
import type { NativeListDrawerData } from '../lib/list/drawer-routes'

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
        })
      | null
    if (!drawer) return null
    const { remountKey, paymentLinks, appliedPayments, creditApplications, workflow, workflowCanInspect, workflowCanManage, workflowCanWaiveFee, workflowCurrency, vendors, ...rest } = drawer
    return (
      <DocumentDrawer
        key={remountKey}
        {...rest}
        afterContent={
          paymentLinks || appliedPayments || creditApplications || workflow ? (
            <>
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
}

/** One renderer for server deep links and client-loaded list records. The
 * native record owns its dialog; no loading dialog wraps a second dialog. */
export function NativeListDrawer({ widget, drawer }: NativeListDrawerData) {
  return renderers[widget]({ drawer })
}
