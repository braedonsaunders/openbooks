import 'server-only'

import { listDrawerRoute, type ListDrawerSource, type NativeListDrawerData } from './drawer-routes'

type Params = Record<string, string | string[] | undefined>

/** Reuse the native page loader. Reading a drawer never instantiates the
 * list widget, so list counts, rows and filter options are not queried. */
export async function readListDrawer(source: ListDrawerSource, params: Params): Promise<NativeListDrawerData | null> {
  const readers = {
    vendor_bill: async () => (await import('../../app/(app)/ap/bills/view')).loadApBills(params),
    customer_invoice: async () => (await import('../../app/(app)/ar/invoices/view')).loadArInvoices(params),
  cash_sale: async () => (await import('../../app/(app)/cash-sales/view')).loadCashSales(params),
    bank_transaction: async () => (await import('../../app/(app)/banking/transactions/view')).loadBankingTransactions(params),
    quote: async () => (await import('../../app/(app)/estimates/view')).loadEstimates(params),
    sales_order: async () => (await import('../../app/(app)/sales-orders/view')).loadSalesOrders(params),
    purchase_order: async () => (await import('../../app/(app)/purchase-orders/view')).loadPurchaseOrders(params),
    rma: async () => (await import('../../app/(app)/returns/view')).loadReturns(params),
    expense_report: async () => (await import('../../app/(app)/expenses/reports/view')).loadExpenseReports(params),
    field_ticket: async () => (await import('../../app/(app)/field-tickets/view')).loadFieldTickets(params),
    pick_list: async () => (await import('../../app/(app)/picks/view')).loadPicks(params),
    shipment: async () => (await import('../../app/(app)/shipments/view')).loadShipments(params),
  }
  const data = await readers[source]()
  return data.drawer ? { widget: listDrawerRoute(source)!.widget, drawer: data.drawer } : null
}
