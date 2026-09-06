# Goods receipts (purchase_receipt)

## Why

Stock lines on a purchase order bill on a three-way match: the vendor bill can
only cover quantity that has been received (`quantity_fulfilled`), both through
order conversion and through AP capture. Until 2026-09-06 nothing in the
product produced that receipt leg: the only writer of `quantity_fulfilled` was
sales fulfillment. Every purchase order carrying an inventory, assembly or kit
line was therefore unbillable ("Fulfilled quantities do not cover any line
yet" / `receipt_quantity_shortfall`), and stock could only be received by
posting a bill with no order behind it.

## The document

`purchase_receipt` is an immutable operational document created from an
approved purchase order, the inbound counterpart of `sales_fulfillment`:

- created through the order's conversion surface (`POST
  /api/purchase-orders/{id}/convert` with `targetKind: "purchase_receipt"`,
  which receives every stock line's remaining quantity) or directly through
  `receivePurchaseOrder` in `web/lib/order-cycle.ts` with explicit partial
  quantities and lot/serial selections;
- one `RCPT-` numbered document per receipt, linked to the order with a
  `fulfills` edge, lines carrying `custom.receipt = { sourceLineId, lotId,
  serialId }` as the immutable evidence the inventory kernel reads;
- idempotent: a stable command key replays the stored receipt, and the same key
  with a different payload is refused (409). The conversion surface derives its
  key from the observed source state so concurrent clicks share one receipt;
- the source order's lines are advanced under the header lock (`quantity_fulfilled
  + qty <= quantity` write predicate), so two racing partial receipts cannot
  over-receive;
- only stock lines are receivable: service, non-inventory, other-charge,
  equipment-charge, labor, absence and discount kinds bill on a two-way match
  and are refused by name;
- every received item must name a received-not-billed account in its costing
  profile. Receiving before billing has no other GL home, so a missing account
  refuses the receipt rather than debiting inventory against nothing.

## Accounting

| Event | Debit | Credit |
| --- | --- | --- |
| Goods receipt (order price × qty) | Inventory asset | Received not billed |
| Vendor bill for received stock | Received not billed | Accounts payable |
| Bill price ≠ order price | Purchase price variance (± ) | Received not billed (∓) |

The receipt posts through `receiveInventory` with `postJournal: true` and the
item's clearing account as offset, creating the cost layer at the order price.
When the bill posts, `applyBillInventoryReceipts` finds the bill line's
`custom.purchaseOrderLineId` (order conversion) or
`custom.apCaptureEvidence.purchaseOrderLineId` (AP capture), looks up posted
goods-receipt movements for that order line, and — instead of receiving the
stock again — books the difference between the billed amount and the received
value for the billed quantity to the item's variance account, clearing received
not billed to zero for that quantity. The variance entry number is
deterministic (`INV-PPV-<bill line id>`), so a posting-effect replay cannot book
it twice. A bill line for received stock on an item with no variance account
refuses to post when the prices differ, by name.

Orders whose stock was never received through a goods receipt keep the legacy
behaviour: the bill is the receipt (DR received-not-billed or inventory / CR AP
plus the receipt journal), unchanged.

Vendor-credit returns accept goods-receipt movements as their source receipt
alongside bill receipts.

## Not covered

- Reversing a goods receipt (received in error) has no dedicated action yet,
  the same gap `sales_fulfillment` carries; the inventory reverse action can
  reverse the movement but does not roll back `quantity_fulfilled`. A
  controlled receipt reversal is the next slice.
- Receipt-side landed cost and foreign-currency order prices follow the
  existing bill-side conventions (document amounts are used as functional
  cost), which this document does not change.
