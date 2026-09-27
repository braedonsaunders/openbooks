import type { DocArticle } from '../types'

export const distributionAvailability: DocArticle = {
  slug: 'distribution-availability',
  title: 'Availability and replenishment',
  category: 'transactions',
  order: 6,
  summary:
    'See how much of each item is on hand, committed to sales orders and available to promise, which backorders stock could ship now, and what to reorder.',
  updated: '2026-09-27',
  keywords: ['availability', 'available to promise', 'ATP', 'committed', 'replenishment', 'reorder point', 'preferred stock level', 'purchase order', 'backorder'],
  related: ['distribution-warehouses', 'distribution-backorders', 'purchasing-workflow'],
  body: `# Availability and replenishment

Availability answers "how much can we still promise?" for each stocked item,
and Replenishment answers "what should we order?". Both read one legal entity
at a time, because each entity owns its own stock, and both are in the
Inventory group on the Reports hub.

---

## Turn them on

Both reports are part of **Warehousing**. Turn it on under Company Settings →
Features. The releasable-backorders section of the Availability report also
needs **Fulfillment**. Both reports need permission to read items; creating
purchase orders from Replenishment also needs permission to create them and
the **Orders** feature.

---

## Availability

For each stocked item, in the item's base unit:

- **On hand** — the quantity the entity holds at the chosen warehouse (the
  warehouse and every zone, bin and staging location in it), or at every
  location when no warehouse is chosen. It is the same figure stock movements
  are checked against.
- **Committed** — the open quantity of issued sales-order lines at those
  locations. Open quantity is the ordered quantity less what has shipped and
  what has been cancelled, so committed falls as orders ship or remainders
  are cancelled.
- **Available** — on hand less committed. A negative figure means the orders
  at these locations already exceed the stock.
- **Unallocated** — open demand on order lines with no stock location. It is
  owed but cannot be netted against any one location, so it is shown on its
  own rather than left out.

An order line raised in another unit (a box of twelve, say) counts in the
item's base unit, converted the same way shipping converts it. If a line uses
a unit the item has no conversion for, the report says which order line and
unit, and you add the conversion under Unit conversions on the item's
Inventory costing section.

On the Warehouse page, each warehouse's on-hand value opens this report for
that warehouse.

### Releasable backorders

With Fulfillment on, the report lists the open sales-order lines that stock on
hand could ship now. Each warehouse's stock goes to its open lines by order
date, then document number, and each line shows the quantity the remaining
stock covers. This is a proposal: nothing is allocated, reserved or shipped.

---

## Replenishment

For each active stocked item, the report projects supply:

projected = on hand − committed − unallocated + on order

where **on order** is the open quantity of issued purchase orders not yet
received. When projected supply is at or below the item's **reorder point**,
the report proposes the quantity that brings it back to the **preferred stock
level**. Set both on the item's Inventory costing section. Every line shows
its evidence: each term above, both levels, the proposed quantity, and the
vendor of the entity's last receipt of the item.

Items without both levels are listed as having no reorder point, and an item
whose preferred level is below its reorder point is flagged; neither is ever
proposed.

### Create purchase orders

Select proposal lines and choose **Create purchase orders**. OpenBooks creates
one draft purchase order per vendor for the selected lines, at the proposed
quantity, for you to price, review and issue. Nothing is ordered
automatically. A selected line with no vendor stops the action and is named,
so deselect it and create its purchase order on Purchase orders. If a vendor's
order is refused, the orders already created are kept, and creating again with
the same selection, before you leave the page, creates only the rest.
`,
}
