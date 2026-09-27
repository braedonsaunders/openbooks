import type { DocArticle } from '../types'

export const distributionWarehouses: DocArticle = {
  slug: 'distribution-warehouses',
  title: 'Warehouses and Putaway',
  category: 'transactions',
  order: 8,
  summary:
    'Give each warehouse a name, an address and a lifecycle that every stock movement respects, and let ordered putaway rules decide which bin received stock goes to.',
  updated: '2026-09-27',
  keywords: ['warehouse', 'bin', 'zone', 'staging', 'putaway', 'suspend', 'retire', 'distribution', 'tie-out'],
  related: ['purchasing-workflow', 'sales-workflow'],
  body: `# Warehouses and Putaway

A warehouse is a stock location of kind **warehouse**. Its zones, bins and
staging areas sit beneath it in the stock-location hierarchy, and that
hierarchy alone decides which warehouse a bin belongs to. Which legal entity
owns the stock is recorded on the stock itself, and which entities may use a
location is the restriction on its location, so a warehouse carries no owner
of its own.

Turn it on in **Company Settings → Features → Warehousing** (off by default;
it requires Inventory). The **Warehouse** page then appears under Operations.

## Lifecycle

Every warehouse has one status, and every stock movement is checked against it
at the moment it posts:

| Status | Receipts and other inbound stock | Issues and outbound stock | Stock counts |
|---|---|---|---|
| Draft | Refused | Refused | Refused |
| Active | Allowed | Allowed | Allowed |
| Suspended | Refused | Allowed | Allowed |
| Retired | Refused | Refused | Refused |

A new warehouse starts in **Draft** and takes no stock until you activate it.
**Suspend** a warehouse to stop receiving into it while it is still drawn down
and counted; **reactivate** it to resume. **Retire** a warehouse once it is
empty: retirement is refused while anything remains on hand, and the refusal
lists every item and quantity still there. A retired warehouse never reopens;
create a new warehouse instead. Suspending and retiring ask for a reason, and
every status change is recorded in the audit log with who made it, when, the
status before and after, and the reason.

Turning Warehousing off hides the Warehouse page but does not lift a
suspension or a retirement: a suspended warehouse still refuses receipts, and
the refusal tells you to turn Warehousing back on and reactivate it.
Warehouses that were already in use before Warehousing existed start out
active and behave exactly as they did.

## Putaway rules

Putaway rules decide where received stock goes inside a warehouse. They are
tried in order of their sequence number, and a rule may apply to one item or
to every item:

- **Fixed bin** puts stock in one bin while the item on hand there plus the
  new quantity stays within the rule's capacity (no capacity means no limit).
- **Empty bin** takes the first active bin under the target zone, by bin code,
  that holds nothing at all.
- **Bulk zone** puts stock in the zone itself while the item on hand there
  plus the new quantity stays within the capacity, which a bulk-zone rule must
  have.

The same rules and the same stock always choose the same location. When no
rule can take the quantity, the refusal names the item, the quantity, the
warehouse and every rule it tried with the reason each one declined, so you
know which rule to add or widen.

## Stock awaiting putaway

Stock received into a warehouse's **staging** locations is listed under
**Stock awaiting putaway**. **Put away** moves it to the location the rules
choose, through the ordinary transfer, at its carried cost.

## Tie-out

The Warehouse page shows the on-hand value held in each warehouse, plus any
stock held outside every warehouse, beside the posted balance of the
inventory control accounts. The difference should be zero; open the control
balance to see the ledger lines behind it.
`,
}
