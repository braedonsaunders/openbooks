import type { DashboardLayoutData } from '@openbooks/schema'
import { CURATED_QUICK_ACTIONS } from './_quick-actions-shared'
import { documentCreateHref } from '@/lib/document-kinds'

/** Existing financial readers and permission gates own every displayed figure. */
export function essentialsDefaultLayout(): DashboardLayoutData {
  const ids = [
    'kpi-cash-balance', 'kpi-open-receivables', 'kpi-overdue-receivables', 'kpi-bills-due-30d',
    'kpi-revenue-mtd', 'kpi-expenses-mtd', 'kpi-net-income-mtd', 'kpi-items-to-reconcile',
  ]
  return {
    widgets: [
      { id: 'personal-actions', x: 0, y: 0, w: 12, h: 4 },
      ...ids.map((id, index) => ({ id, x: (index % 4) * 3, y: 4 + Math.floor(index / 4) * 2, w: 3, h: 2 })),
      { id: 'inbox-list', x: 0, y: 8, w: 6, h: 5 },
      { id: 'list-close-readiness', x: 6, y: 8, w: 6, h: 5 },
    ],
    quickActions: ['d-invoice', 'd-bill', 'd-expense', 'd-receipt', 'd-payment', 'd-bank-review']
      .flatMap((id) => CURATED_QUICK_ACTIONS.filter((action) => action.id === id))
      .map(({ id, labelKey, href, iconKey, tone }) => ({
        id, labelKey, iconKey, tone,
        href: id === 'd-invoice' ? documentCreateHref('/ar/invoices', 'customer_invoice')
          : id === 'd-bill' ? documentCreateHref('/ap/bills', 'vendor_bill')
            : id === 'd-payment' ? '/payments?paymentNew=1&mode=edit' : href,
      })),
  }
}
