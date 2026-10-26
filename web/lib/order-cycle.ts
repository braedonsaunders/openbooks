import "server-only";

/**
 * Order-cycle documents (quote / sales_order / purchase_order) are NON-posting
 * commitment documents: they live in `documents` with lines, but never hit the
 * GL. They "pull forward" into a posting document (customer_invoice / vendor_bill)
 * or a downstream order (quote → sales_order) via `convertOrder`, which copies
 * the un-billed remainder of each line, records a `document_links` edge, and
 * advances `quantity_billed` on the source so partial conversions are safe and
 * idempotent-at-the-line-level.
 *
 * Status model (reuses the existing documents.status enum, no schema change):
 *   draft     — being built
 *   approved  — issued / open (the order is live; convertible)
 *   voided    — cancelled
 * "Converted" is derived: an order is fully converted when every line's
 * quantity_billed reaches quantity − quantity_cancelled. A cancelled
 * remainder is never shipped or billed; the open-quantity rule lives in
 * engine/src/records/order-line-remainders.ts.
 */

export { ORDER_KINDS, CONVERSION_TARGETS } from "./order-kinds";
export type { OrderKind } from "./order-kinds";
export {
  ConversionError,
  FULFILLMENT_BIN_OUTSIDE_WAREHOUSE,
  ITEM_MISSING_RNB_ACCOUNT,
  ORDER_CONVERSION_NOTHING_BILLABLE,
  ORDER_LINE_ITEM_WITHOUT_COSTING_PROFILE,
  ORDER_LINE_WAREHOUSE_REQUIRED,
  missingOrderLineWarehouses,
} from "./order-cycle-shared";
export type {
  ConversionWithheldLine,
  KitComponentFulfillmentInput,
  SalesFulfillmentLineInput,
  UnwarehousedOrderLine,
} from "./order-cycle-shared";
export {
  OrderDraftConflictError,
  OrderDraftError,
  createOrderDraft,
  draftDocumentId,
} from "./order-cycle-draft";
export { fulfillSalesOrder, fulfillSalesOrderInTx } from "./order-cycle-fulfill";
export type { SalesFulfillmentInput } from "./order-cycle-fulfill";
export {
  receivePurchaseOrder,
  receivePurchaseOrderInTx,
  receivePurchaseOrderRemainder,
} from "./order-cycle-receive";
export type { PurchaseReceiptInput, PurchaseReceiptLineInput } from "./order-cycle-receive";
export { assignOrderLineWarehouse } from "./order-cycle-warehouse-assignment";
export type { AssignOrderLineWarehouseInput } from "./order-cycle-warehouse-assignment";
export { conversionWouldCopyInventoryKinds, convertOrder } from "./order-cycle-convert";
