import type { DocArticle } from '../types'

export const distributionReturns: DocArticle = {
  slug: 'distribution-returns',
  title: 'Return Authorizations',
  category: 'transactions',
  order: 10,
  summary: 'Authorize a customer return against a shipped quantity, record arrivals, inspect each line, and choose whether accepted goods are restocked, scrapped or returned to a vendor.',
  updated: '2026-09-27',
  keywords: ['return authorization', 'RMA', 'customer return', 'inspection', 'restock', 'scrap'],
  related: ['distribution-pick-ship', 'sales-workflow'],
  body: `# Return Authorizations

Return Authorizations track a customer's return from approval through receiving and inspection. Each line references a posted customer shipment, so the authorized quantity cannot exceed the quantity still available to return.

## Authorize and receive

Create an RMA from **Operations → Returns**, select a customer, legal entity, item and returnable shipment for each line, and save it. The authorization is released through the configured approval flow. If the shipment has already been fully returned, OpenBooks names the credit that consumed its quantity.

When goods arrive, record the quantity received on each line. OpenBooks refuses an arrival above its authorized amount. A requested authorization can instead be rejected with a reason.

## Inspect and decide

For each received line, enter the accepted quantity and choose a disposition:

- **Restock** puts accepted units back into the selected bin at the cost recorded when they left inventory.
- **Scrap** receives the units into quarantine and writes them down from that location.
- **Vendor return** receives the units into quarantine and creates a linked vendor credit draft for the operator to complete against its receipt.

Inspection creates one customer credit for accepted goods. Apply or refund that credit through the normal receivables workflow. Reopening an inspected RMA returns its existing credit instead of creating another one.

Return Authorizations are off by default. Turn on **Return Authorizations** in Company Settings → Features to show the page and its assistant reads. Turning it off preserves the authorization, credits and audit history.
`,
}
