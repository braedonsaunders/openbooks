/**
 * Client-safe order-cycle constants — shared by the server engine
 * (web/lib/order-cycle.ts) and the client OrderDrawer. Kept free of any
 * server-only imports (no db, no 'server-only') so it can be bundled for the
 * browser without dragging the DB client into the client bundle.
 */

export const ORDER_KINDS = ['quote', 'sales_order', 'purchase_order'] as const
export type OrderKind = (typeof ORDER_KINDS)[number]
/** Immutable operational document created when stock physically leaves on a
 * sales order. It is deliberately not an ORDER_KIND: it cannot be edited or
 * converted as another commercial commitment. */
export const SALES_FULFILLMENT_KIND = 'sales_fulfillment' as const
/** Immutable operational document created when stock physically arrives on a
 * purchase order (the goods receipt). It brings the stock in at the order
 * price against received-not-billed; the vendor bill later clears that. Not
 * an ORDER_KIND: it cannot be edited or converted. */
export const PURCHASE_RECEIPT_KIND = 'purchase_receipt' as const

/**
 * What a given order kind is allowed to convert into.
 * `labelKey` is a message key resolved in the `purchaseOrders.shared` catalog
 * namespace — translate at the render site (see OrderDrawer), never here.
 */
export const CONVERSION_TARGETS: Record<
  OrderKind,
  { kind: string; labelKey: string; prefix: string; link: string }[]
> = {
  quote: [
    { kind: 'sales_order', labelKey: 'kinds.salesOrder', prefix: 'SO-', link: 'created_from' },
    { kind: 'customer_invoice', labelKey: 'kinds.invoice', prefix: 'INV-', link: 'bills' },
  ],
  sales_order: [{ kind: 'customer_invoice', labelKey: 'kinds.invoice', prefix: 'INV-', link: 'bills' }],
  purchase_order: [
    { kind: 'purchase_receipt', labelKey: 'kinds.receipt', prefix: 'RCPT-', link: 'fulfills' },
    { kind: 'vendor_bill', labelKey: 'kinds.bill', prefix: 'BILL-', link: 'bills' },
  ],
}
