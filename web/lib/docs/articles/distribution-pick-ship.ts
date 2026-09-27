import type { DocArticle } from '../types'

export const distributionPickShip: DocArticle = {
  slug: 'distribution-pick-ship',
  title: 'Pick Lists and Shipments',
  category: 'transactions',
  order: 9,
  summary:
    'Reserve bin stock for an issued sales order on a pick list, pack it onto a shipment with a carrier and tracking number, and complete the shipment to record the sales fulfilment.',
  updated: '2026-09-27',
  keywords: [
    'pick', 'pick list', 'picking', 'shipment', 'ship', 'carrier', 'service level', 'tracking number',
    'tracking link', 'carton', 'bin', 'reservation', 'fulfillment', 'distribution',
  ],
  related: ['sales-workflow', 'distribution-warehouses', 'distribution-backorders'],
  body: `# Pick Lists and Shipments

Pick lists and shipments carry an issued sales order from the warehouse shelf
to the customer's door:

1. A **pick list** says which bins to take each order line's stock from, and
   once released it reserves that stock for the order.
2. A **shipment** records what was picked, the cartons it was packed in, the
   carrier, the service and the tracking number.
3. **Completing** the shipment records the sales fulfilment: the stock leaves
   the picked bins and cost of goods sold is recognised, exactly as when an
   order is fulfilled any other way.
4. The customer is **invoiced** from the sales order through the usual order
   to invoice conversion. A shipment never bills anyone by itself.

Pick lists (numbered **PICK-**) and shipments (numbered **SHP-**) are ordinary
documents: they keep their own history, links to the sales order and to each
other, and every change is written to the audit log.

---

## Turn it on

Turn on **Warehousing** and then **Fulfillment** under Company Settings →
Features. Fulfillment needs Orders and Warehousing and is off by default. Once
it is on, **Pick Lists** and **Shipments** appear under Operations, beside the
Warehouse page.

Working with pick lists and shipments needs the fulfil-orders permission.
Completing a shipment moves stock, so it also needs the permission to post
inventory. People only see the pick lists and shipments of sales orders in the
subsidiaries they may access.

---

## Pick lists

Create a pick list for a sales order that has been issued. Choose the order's
stock lines to pick and, for each, the bin to take it from and the quantity;
add the lot or serial when the item is tracked. A line may be picked from
several bins, one pick line per bin.

OpenBooks refuses a pick list, and says why, when:

- the order is not issued (a draft order must be issued first);
- a line is a service or other non-stock line;
- a line has no warehouse to ship from (assign one to the line in the order
  drawer first);
- the lines ship from different warehouses (create one pick list per
  warehouse);
- a bin is not inside the line's warehouse, or is inactive;
- the warehouse does not allow outbound stock in its current status;
- a lot or serial belongs to a different item; or
- the quantity is more than the line still has open after what other pick
  lists already hold for it. The refusal names those pick lists and the most
  you can still pick.

A new pick list is a **draft**. A draft counts against the order line's open
quantity, so two pick lists cannot promise the same units, but it does not
yet hold any bin stock.

### Release

**Release** the pick list to start holding its bins. Release goes through
Flows: when an approval rule applies to pick lists, the pick list waits in
**Approvals** until it is approved; otherwise it is released immediately.

At release, OpenBooks checks every bin again: the stock on hand there for the
order's legal entity, less what other released pick lists already hold, must
cover the pick list. If it does not, release is refused with the bin, the item,
what is on hand, what other pick lists hold and what this one asks for; pick
from another bin, receive or transfer stock into the bin, or ship what is
available and leave the rest on backorder.

A released pick list's reservation never exceeds what the order line still
has open. If the order is fulfilled or its remainder cancelled some other way,
the reservation shrinks with it.

### Void a pick list

A draft or released pick list can be voided with a reason, which frees its
bins. A pick list awaiting approval must be rejected in Approvals first, and
one that already has a shipment is freed by voiding that shipment first.

---

## Shipments

Create a shipment from a released pick list. By default it ships everything
the pick list still reserves; you can instead ship less of a line, and record
the **carton** each line is packed in. A pick list has one shipment at a time;
to start over, void the draft shipment and create another. The ship-to address
is copied from the customer's default shipping address when the shipment is
created, so later address changes do not rewrite it.

While the shipment is a draft, choose its **carrier**, one of that carrier's
**services** and, when the carrier has issued one, the **tracking number**.
Only active carriers can be chosen, and only services the carrier lists. When
the carrier has a tracking link template, the shipment shows a tracking link
built from the tracking number.

Voiding a draft shipment needs a reason; its pick list keeps holding the bins
so you can ship again.

### Complete

**Complete** the shipment once it has left the building. Completion needs a
carrier and service, a pick list that is still released and open, and an
order that is still issued. In one step it:

- records the sales fulfilment for the order, dated with the shipment's date,
  issuing each line from the bin it was picked from and recognising cost of
  goods sold;
- marks the shipment and its pick list done, which ends the pick list's
  reservation; and
- links the shipment to the fulfilment it recorded.

Completing the same shipment twice returns the fulfilment already recorded;
stock is never issued twice. Anything the pick list reserved but the shipment
did not ship stays open on the order line and appears as a backorder.

A completed shipment is final and cannot be voided or edited. To reverse it,
void the sales fulfilment it recorded, which is linked from both the shipment
and the sales order. Bill the shipped quantity by converting the sales order
to an invoice as usual.

### Tracking email

From a completed shipment that has a tracking number you can email the
customer the shipment number, carrier, service, tracking number and tracking
link. It goes to the customer's email address unless you enter another
recipient, through your organization's own email delivery (set it up under
Admin → Email first), and every send is recorded in the email log.

---

## Carriers

Carriers are set up on the Warehouse page, under **Carriers**. Each carrier
has a code, a name, the list of **services** it offers (for example Ground or
Overnight, at least one), and an optional **tracking link template**: the
carrier's tracking page address with **{tracking}** where the tracking number
goes, for example https://carrier.example/track?number={tracking}. OpenBooks
refuses a template that is not a web address or has no **{tracking}** in it.

Carriers are never deleted, because shipments keep the carrier they name.
Clear **Active** on a carrier you no longer use: it can no longer be chosen on
a shipment, and shipments that already name it are unchanged.

---

## Turning Fulfillment off

Turning Fulfillment off, or turning off Orders or Warehousing that it
depends on, hides the Pick Lists and Shipments pages, the carrier setup and
the assistant's pick-list and shipment answers, and OpenBooks refuses every
pick-list, shipment and carrier change until Warehousing and Fulfillment are
turned back on under Company Settings → Features. Nothing is deleted: pick
lists, shipments, carriers, the fulfilments already recorded and the audit
history stay exactly as they were, and reappear when the feature is turned
back on.
`,
}
