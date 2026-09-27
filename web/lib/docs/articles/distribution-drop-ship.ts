import type { DocArticle } from '../types'

export const distributionDropShip: DocArticle = {
  slug: 'distribution-drop-ship',
  title: 'Drop-ship Orders',
  category: 'transactions',
  order: 10,
  summary:
    'Route an issued stock line to a vendor, create its purchase order, confirm the vendor shipment, and invoice the customer through the existing order workflow.',
  updated: '2026-09-27',
  keywords: ['drop ship', 'drop shipping', 'vendor shipment', 'direct shipment', 'purchase order'],
  related: ['sales-workflow', 'purchasing-workflow', 'distribution-pick-ship'],
  body: `# Drop-ship Orders

Drop shipping lets a vendor ship an item directly to your customer. The sales
order remains the customer commitment, and the purchase order records what the
vendor must ship. OpenBooks keeps the two order lines paired so the vendor's
confirmation fulfils the customer order without bringing the item into your
warehouse.

## Turn it on

Turn on **Drop Shipping** under Company Settings → Features. The feature also
requires Orders. People who route sales lines need the fulfil-orders
permission; creating the vendor purchase order needs purchase-order creation
access; confirming the vendor shipment needs permission to post inventory.

## Route a sales-order line

Issue the sales order first. On an unfulfilled stock line, choose **Route for
vendor shipment**. A line with fulfilled quantity cannot be routed. Routing
removes its open quantity from warehouse backorders and stock availability,
because the vendor will supply it directly to the customer.

Choose **Create drop-ship PO**, then select an active vendor. OpenBooks creates
the purchase order through the standard order workflow, copies the customer's
default shipping address onto the drop-ship record, and pairs each purchase
line with its routed sales line. The purchase cost comes from the item's
configured default or standard cost; configure a cost before creating the PO
if neither is available.

## Confirm the vendor shipment

After the vendor ships, open the drop-ship purchase order and choose **Confirm
vendor shipment**. Confirmation checks the open quantities, item costing
profile, received-not-billed account and COGS account. It records a purchase
receipt and a sales fulfilment together, then posts the receipt value from
received-not-billed to cost of goods sold. No inventory movement or cost layer
is created. Repeating the same confirmation request returns the original
receipt and fulfilment.

The vendor bill continues through the regular purchase-order matching flow;
the receipt value clears received-not-billed and any difference posts to
purchase price variance. Invoice the customer by converting the sales order
through the normal invoice workflow.

## Correct a confirmation

Void either the receipt or its paired fulfilment through the controlled void
workflow. OpenBooks reverses both documents and the confirmation journal in
one transaction, and restores the purchase and sales order quantities. A
confirmation cannot be voided after the related quantity has been billed or
when its reversal period is closed.
`,
}
