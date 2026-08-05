// Deep-links from the approvals hub to each document kind's native module
// drawer. Built on the shared report→transaction map (txn-links.ts) and
// extended with the order-cycle kinds approvals can gate but reports never
// link to. Client-safe: no server-only imports.

import { moduleDrawerHref } from './txn-links'

const ORDER_HREF: Record<string, (id: string) => string> = {
  quote: (id) => `/estimates?estimate=${id}`,
  sales_order: (id) => `/sales-orders?order=${id}`,
  purchase_order: (id) => `/purchase-orders?order=${id}`,
  close_run: (id) => `/close?run=${id}&stage=lock`,
}

/**
 * The URL that opens an approval subject's native record drawer, or null when
 * the kind has no module surface (the row renders as plain text).
 */
export function approvalRecordHref(
  kind: string | null | undefined,
  id: string | null | undefined,
): string | null {
  if (!kind || !id) return null
  const order = ORDER_HREF[kind]
  if (order) return order(id)
  return moduleDrawerHref(kind, id)
}
