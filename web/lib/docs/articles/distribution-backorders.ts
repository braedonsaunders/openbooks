import type { DocArticle } from '../types'

export const distributionBackorders: DocArticle = {
  slug: 'distribution-backorders',
  title: 'Backorders',
  category: 'transactions',
  order: 5,
  summary:
    'See which sales-order stock lines are still owed to customers, and cancel a remainder the business will no longer ship, with a recorded reason.',
  updated: '2026-09-27',
  keywords: ['backorder', 'backorders', 'open quantity', 'cancel remainder', 'sales order', 'fulfillment', 'shipment'],
  related: ['sales-workflow'],
  body: `# Backorders

A backorder is the part of an issued sales order that has not shipped yet. Every
stock line on a sales order accounts for its whole ordered quantity in three
parts:

- **Fulfilled** — quantity already shipped on a shipment;
- **Cancelled** — quantity the business will no longer ship; and
- **Open** — everything else, still owed to the customer.

Open quantity is always the ordered quantity less fulfilled and cancelled
quantity. The same rule drives fulfillment, billing, the order drawer, the
Backorders report and the assistant, so they never disagree.

A stock line is a line whose item has an inventory costing profile. Service and
other non-stock lines are billed from the order and are never backordered.

---

## Turn backorders on

Backorders are part of **Fulfillment**, which needs **Orders** and
**Warehousing**. Turn Warehousing and Fulfillment on under Company Settings →
Features. While Fulfillment is off, the Backorders tab and report are hidden;
any quantity already cancelled stays cancelled and keeps limiting fulfillment
and billing.

Viewing and cancelling backorders on a sales order needs the fulfil-orders
permission. The Backorders report needs report access, and the assistant's
backorder read needs receivables read access.

---

## See the position

- **On one order** — open an issued sales order and choose the **Backorders**
  tab. Each backordered line shows its ordered, fulfilled, cancelled and open
  quantity.
- **Across all orders** — open Reports, then **Backorders** under Sales & orders.
  The report lists every issued sales-order stock line with open quantity, by
  customer, item and stock location, and can be filtered, saved as a view and
  exported like any other report.

Voiding a shipment returns its quantity to the order line, so the line's open
quantity rises by the same amount; cancelled quantity is unchanged.

---

## Cancel a remainder

When the customer no longer wants the rest of a line, or the business can no
longer supply it, choose **Cancel remainder** on the line in the Backorders tab
and enter the reason. The line's whole open quantity is cancelled.

A cancellation:

- is recorded with the quantity, the reason, the person and the time, and is
  written to the audit log;
- stops fulfillment from shipping the cancelled quantity; and
- lowers the quantity the line can be billed for to the ordered quantity less
  the cancelled quantity. An order whose lines are billed up to that point
  counts as fully converted.

Cancellations are permanent. OpenBooks refuses to cancel more than the line's
open quantity, a line on an order that is not issued, and a line that is not a
stock line. If a remainder was cancelled by mistake, enter a new sales order for
the quantity the customer still wants.
`,
}
