/**
 * Client-safe order-cycle constants — shared by the server engine
 * (web/lib/order-cycle.ts) and the client OrderDrawer. Kept free of any
 * server-only imports (no db, no 'server-only') so it can be bundled for the
 * browser without dragging the DB client into the client bundle.
 */

export const ORDER_KINDS = ['quote', 'sales_order', 'purchase_order'] as const
export type OrderKind = (typeof ORDER_KINDS)[number]

/** What a given order kind is allowed to convert into. */
export const CONVERSION_TARGETS: Record<
  OrderKind,
  { kind: string; label: string; prefix: string; link: string }[]
> = {
  quote: [
    { kind: 'sales_order', label: 'Sales order', prefix: 'SO-', link: 'created_from' },
    { kind: 'customer_invoice', label: 'Invoice', prefix: 'INV-', link: 'bills' },
  ],
  sales_order: [{ kind: 'customer_invoice', label: 'Invoice', prefix: 'INV-', link: 'bills' }],
  purchase_order: [{ kind: 'vendor_bill', label: 'Bill', prefix: 'BILL-', link: 'bills' }],
}
