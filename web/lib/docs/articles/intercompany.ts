import type { DocArticle } from "../types";

export const intercompany: DocArticle = {
  slug: "intercompany",
  title: "Intercompany Transactions, Netting and Fulfillment",
  category: "accounting",
  order: 7,
  summary:
    "Representing customers and vendors, paired intercompany orders and invoices with transfer pricing, governed netting and settlement runs, bank transfers between entities, cross-subsidiary fulfillment and intercompany reconciliation.",
  updated: "2026-10-11",
  keywords: [
    "intercompany",
    "representing customer",
    "representing vendor",
    "due to",
    "due from",
    "pairing",
    "transfer pricing",
    "cost plus",
    "netting",
    "settlement",
    "elimination",
    "cross-subsidiary fulfillment",
    "reconciliation",
    "multi-subsidiary",
  ],
  related: ["allocations", "fixed-assets-depreciation", "setup-accounting-group"],
  body: `# Intercompany Transactions, Netting and Fulfillment

When one legal entity sells to, buys from, ships for or pays another entity of
the same organization, both entities record the event in their own books and
consolidation must remove it. OpenBooks handles this with four capabilities,
each a switch under **Multi-subsidiary** in **Company Settings → Features**:

| Feature | What it adds |
|---|---|
| **Intercompany transactions** | Representing customers and vendors, paired intercompany documents, transfer pricing, the pairing workspace |
| **Intercompany netting** | Netting and settlement runs, bank transfers between entities |
| **Cross-subsidiary fulfillment** | Shipping one entity's sales order from another entity's warehouse (also needs Inventory and Orders) |

The **Intercompany reconciliation** report is available whenever
Multi-subsidiary is on. Switching a feature off keeps every record and its
history.

## Intercompany pairs

Every pair of entities that trade needs an **intercompany pair** in
**Setup → Accounting → Intercompany Pairs**. A pair names, for each entity:

- the **due-from / due-to** account that carries its running position with
  the other entity — the account multi-entity journals and cross-charges use;
- optionally an **intercompany receivable** and an **intercompany payable**
  account — the control accounts intercompany invoices and bills post to.

All of these must be marked **Eliminate on consolidation**, so the period's
consolidation eliminates them. Netting needs each entity to use its own
accounts for each counterparty: an account shared by two pairs of the same
entity cannot say which counterparty a balance belongs to, and netting refuses
it by name.

## Representing customers and vendors

In **Setup → Accounting → Intercompany Representing Parties**, choose for a
subsidiary the customer and the vendor that stand for it when sister entities
trade with it. A subsidiary has at most one representing customer and one
representing vendor, and a party represents at most one subsidiary. The setup
refuses:

- a party that already transacts with the subsidiary it would represent —
  a subsidiary cannot be its own customer or vendor;
- a party without an active customer (or vendor) role;
- a party whose currency is not the functional currency of the represented
  subsidiary or of a subsidiary it trades with.

The customer or vendor record shows which subsidiary it represents.

### How intercompany documents post

An invoice, credit memo, bill or vendor credit whose party represents another
subsidiary is intercompany. Its open item posts to the pair's intercompany
receivable or payable account for the document's own entity — not the
party's default account — and the document carries that account for its whole
life. Posting refuses, naming the remedy, when:

- the party represents the document's own subsidiary;
- Intercompany transactions is off while the representation is active (turn
  it on, or end the representation);
- no active pair joins the two entities, or the pair has no intercompany
  receivable or payable account for this entity;
- the document chose a different receivable or payable account.

Revenue and expense lines post to the accounts the lines name. To eliminate
intercompany revenue and expense as well, post intercompany lines to revenue
and expense accounts marked Eliminate on consolidation.

## Paired intercompany transactions

The **Intercompany** workspace lists every intercompany sales order, invoice
and credit memo, and every intercompany purchase order, bill and vendor
credit, in three views:

- **Unpaired** — no counterpart yet. **Create counterpart** writes the other
  entity's mirror as a draft through its native writer: a purchase order for
  a sales order (or the reverse), a bill for an invoice, a vendor credit for a
  credit memo, line for line at the same prices and currency, to the
  representing customer or vendor. **Link** pairs it with an existing
  document of the other entity, with a reason.
- **Mismatched** — the two documents disagree on currency, total or the
  quantity of any item, or one side was voided.
- **Paired** — in agreement; a pair whose documents agree but whose
  lifecycles differ (a posted invoice against a draft bill) shows as
  awaiting its counterpart.

A document belongs to at most one live pair. Unlinking keeps the pair in
history with its reason. Generated counterparts are drafts: the buying or
selling entity reviews and posts them through its own lifecycle and
approvals. To bill against a paired purchase order, convert the order to a
bill in the buying entity and link that bill to the invoice.

## Transfer pricing

**Setup → Accounting → Intercompany Transfer Pricing** holds effective-dated
policies for a selling entity — for one buying entity, or for every buyer
without its own policy. A policy prices either from a **price level** (the
item's schedule for that level and currency, honouring quantity breaks) or as
**cost plus** a markup percentage, and names the eliminated revenue and cost
accounts the cross-charge posts to. Active windows for the same entities
cannot overlap. A policy that has priced a charge keeps its terms: end it and
add a new policy from the change date.

## Netting and settlement runs

**Intercompany → Netting** settles open intercompany balances as of a date for
a set of subsidiaries. For every pair inside the set and every currency, the
run reads each entity's open intercompany receivables and payables and its
due-to/due-from position, then:

1. **Nets** inside each entity what it is owed by the counterparty against
   what it owes it, oldest items first. Each entity nets only its own books.
2. Optionally **settles in cash**: the remaining net amount moves between the
   entities' bank accounts, never more than either entity's books show.
3. Reports any **difference** between the two entities' views; it stays open.

Preview a run before proposing it. The proposal is stored with a fingerprint
and is what gets approved and posted. **Submit** fires the run's approval: an
enabled flow for intercompany netting runs parks it pending approval, and
with none configured it is approved at once. The person who proposed or
submitted a run cannot decide its approval unless the gate allows
self-approval. **Post** re-reads every balance and refuses if anything changed
since the proposal; cancel and propose again.

Posting writes one balanced entry per pair and currency in which each entity
balances on its own. Each cleared invoice or bill is applied through a
settlement application, so aging and statements show it settled. Settled
foreign-currency open items post their realized exchange difference in each
entity's functional currency, like a payment; a due-to/due-from position is
released at its carrying amount and the difference to the spot rate is
realized the same way. Runs refuse closed periods, missing exchange rates
(all of them named at once), a missing realized FX gain/loss account, and
missing bank accounts for cash settlement. A posted run can be reversed on a
date with a reason: the settlements are mirrored and the items reopen.

## Bank transfers between entities

A transfer inside one entity remains an ordinary bank transfer in Banking.
**Intercompany → Transfers** moves cash from one entity's bank account to
another's: the paying entity credits its bank, the receiving entity debits
its bank, and the posting adds the pair's due-to/due-from legs so each entity
balances on its own. Both accounts must hold the same currency. A transfer
can be reversed on a date with a reason.

## Cross-subsidiary fulfillment

With Cross-subsidiary fulfillment on, a sales order line may name a warehouse
owned by another entity; the warehouse picker shows the owning entity. When
the order is fulfilled, the owning entity relieves its own stock at its own
cost — its cost layers and cost of goods sold — and charges the selling
entity the transfer price from its transfer pricing policy. The cross-charge
posts the selling entity's cost at the transfer price and the fulfilling
entity's intercompany revenue to the policy's eliminated accounts, with the
pair's due-to/due-from legs, so consolidated cost of sales is the group's
actual cost. Fulfillment refuses when no active pair joins the entities or no
transfer pricing policy is in effect.

Returns credited against such a shipment restore the fulfilling entity's
stock at the cost it left at and reverse the cross-charge in proportion.
Voiding the shipment reverses its cross-charge. Cross-subsidiary lines ship
through order fulfillment; pick lists and availability remain per entity, so
the owning entity's stock appears in its own availability.

## Intercompany reconciliation

**Reports → Intercompany reconciliation** shows, as of a date, each pair's
balances by currency in both entities' ledgers — intercompany receivable,
payable and due-to/due-from position — and the difference left to
reconcile. Exchange revaluation and settlement entries carry no
transaction-currency exposure and are excluded. The period close checklist
flags unreconciled pairs on its intercompany step.

## Permissions

| Permission | Allows |
|---|---|
| **intercompany.read** | The workspace, netting runs, transfers and the reconciliation report |
| **intercompany.manage** | Generating, linking and unlinking pairs; proposing, submitting and cancelling runs |
| **intercompany.settle** | Posting and reversing runs; posting and reversing transfers |
| **intercompany.approve** | Deciding a netting run's approval gate |
`,
};
