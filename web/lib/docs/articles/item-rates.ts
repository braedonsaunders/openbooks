import type { DocArticle } from '../types'

export const itemRates: DocArticle = {
  slug: 'item-rates',
  title: 'Item Rates and Equipment',
  category: 'projects',
  order: 2,
  summary:
    'Configure effective-dated cost and bill rates on items, assign rate books, and track equipment recovery, billing, utilization, and return.',
  updated: '2026-07-19',
  keywords: ['item rates', 'equipment', 'rate book', 'cost rate', 'bill rate', 'charge-out', 'ROI', 'time and materials'],
  body: `# Item Rates and Equipment

OpenBooks keeps the financial definition of a charge on an **item** and the
physical unit that performs the work in **Equipment**. One excavator charge item
can therefore supply the same rates to many individually tracked excavators,
while each unit retains its own purchase price, serial number, usage, recovery,
billed revenue, and optional fixed-asset link.

This separation avoids duplicating rates on every unit and keeps **Fixed Assets**
focused on capitalization and depreciation.

---

## Configure an equipment charge item

Create or open an item under **Items & Services** and choose **Equipment charge**.
Set its income, expense, and cost-recovery accounts, then add a rate version in
the **Item rates** section.

Every rate version has:

- an effective date and rate book;
- a base usage unit;
- independent cost and bill rates;
- any number of rate units, each expressed as a quantity of the base unit; and
- a pricing policy and invoice presentation.

For a day-based item, a common ladder is **day = 1**, **week = 4**, and **month =
12**. Cost rates may be zero even when bill rates are positive. This supports
equipment that is billed to a customer without creating an internal cost-recovery
journal.

### Capped ladder

**Capped ladder** decomposes usage from the largest unit down and promotes a
remainder only when the smaller-unit total exceeds the next package price. The
comparison is strict: if three daily charges equal the weekly charge, the three
daily components remain.

### Lowest-cost combination

**Lowest-cost combination** evaluates all configured units and chooses the least
expensive exact package combination. Use it when the rate units do not form a
simple day/week/month ladder.

---

## Rate books and assignment priority

Manage rate-book headers and assignments under **Settings → Company Setup →
Billing**. Assign a book to a project or customer with optional effective dates.
When a project charge is created, OpenBooks resolves the most specific active
book in this order:

1. project assignment;
2. customer assignment;
3. equipment-unit override;
4. organization assignment; and
5. organization default rate book.

The resolved rate version, quantities, rates, component breakdown, cost amount,
and bill amount are snapshotted on the transaction. Later rate changes therefore
do not rewrite historical project costs or invoices.

Project charges currently post in the organization base currency. A candidate
rate book in another currency is skipped rather than being treated as though its
amounts were base currency.

---

## Equipment register

Open **Accounting → Equipment** to create a unit. An active unit requires an
**Equipment charge** item. You may also link:

- a fixed asset, when the unit is capitalized and depreciated;
- a rate-book override, when the unit has negotiated rates; and
- purchase price and capacity, for ROI and utilization analysis.

Choose an equipment unit when adding a project charge. OpenBooks selects its
item automatically, resolves the effective rates, posts cost recovery when the
cost is nonzero, and carries the bill value into time-and-materials billing.

The equipment drawer reports purchase price, recovered cost, billed revenue,
ROI, and utilization. Purchase price is financial acquisition context; the
linked fixed asset remains the authoritative depreciation record.

For reusable analysis and exports, choose **Equipment** in the custom report
builder. Its fields include charge item, fixed-asset and rate-book links,
purchase price, capacity, usage, cost recovery, billable value, billed revenue,
and posted depreciation. Transaction-line reports also expose the equipment
unit and snapshotted cost and bill rates.

---

## Migration checks

When migrating equipment rates, import each shared charge definition as one
equipment-charge item, create effective rate versions, and link all applicable
units to that item. Map the legacy **Applies To** text to the item description
and the legacy category to the item category. A daily, weekly, and monthly
schedule becomes rate units of **1**, **4**, and **12** base days under the
**Capped ladder** policy; use a zero cost rate when the source only supplied bill
rates. Each physical equipment record references the migrated charge item rather
than copying its rate fields.

Create one project-charge line per equipment unit and usage interval. Do not
combine several physical units into a single duration quantity: quantity measures
the selected unit's usage, while the equipment link identifies the unit that
earned the recovery and revenue. Reconcile representative usage quantities around
each tier boundary, including equality cases, before cutover.`,
}
