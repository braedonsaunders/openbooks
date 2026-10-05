import type { ReportEntity } from "./entities";

const shared = {
  category: "orders" as const,
  featureKey: "shippingHub",
};

// Label and adjustment costs store as integer minor units; the report reads
// major units through the global currency table (no org to pin — currencies
// is shared reference data). An unknown code falls back to two decimals, so
// the row stays visible with its stored currency beside it instead of
// dropping out of its own cost report.
const MINOR_TO_MAJOR = (amountMinor: string) =>
  `(${amountMinor}::numeric / (10 ^ coalesce(cur.minor_units, 2)))`;

export const SHIPPING_REPORT_ENTITIES: ReportEntity[] = [
  {
    ...shared,
    key: "shipment_labels",
    label: "Shipping labels",
    description:
      "Bought carrier labels with live cost, tracking state and their cost journal — voided labels stay visible with their reversal, never silently dropped.",
    from: `shipment_labels l
      JOIN fulfillment_documents f ON f.document_id = l.shipment_document_id AND f.org_id = l.org_id
      JOIN documents d ON d.id = l.shipment_document_id AND d.org_id = l.org_id
      LEFT JOIN documents o ON o.id = l.order_document_id AND o.org_id = l.org_id
      JOIN shipping_accounts a ON a.id = l.account_id AND a.org_id = l.org_id
      LEFT JOIN currencies cur ON cur.code = l.rate_currency`,
    orgColumn: "l.org_id",
    subsidiaryScope: { column: "d.subsidiary_id" },
    requiredPermission: "orders.fulfill",
    timeKey: "purchased_at",
    defaultPeriodField: "purchased_at",
    currencyColumn: "currency",
    columns: [
      { key: "id", label: "Label (id)", kind: "uuid", expr: "l.id" },
      { key: "shipment_number", label: "Shipment #", kind: "text", expr: "d.document_number" },
      { key: "order_number", label: "Order #", kind: "text", expr: "o.document_number" },
      { key: "shipment_id", label: "Shipment (id)", kind: "uuid", expr: "l.shipment_document_id" },
      { key: "account", label: "Carrier account", kind: "text", expr: "a.name" },
      { key: "provider", label: "Provider", kind: "text", expr: "l.provider" },
      { key: "carrier", label: "Carrier", kind: "text", expr: "l.carrier" },
      { key: "service", label: "Service", kind: "text", expr: "l.service" },
      { key: "tracking_number", label: "Tracking #", kind: "text", expr: "l.tracking_number" },
      {
        key: "tracking_status",
        label: "Tracking state",
        kind: "enum",
        expr: "l.tracking_status",
        options: ["unknown", "pre_transit", "in_transit", "out_for_delivery", "delivered", "exception", "returned", "cancelled"],
      },
      {
        key: "status",
        label: "Label state",
        kind: "enum",
        expr: "l.status",
        options: ["purchased", "voided", "refunded"],
      },
      {
        key: "amount",
        label: "Label cost",
        kind: "money",
        expr: MINOR_TO_MAJOR("l.rate_minor"),
        txnCurrency: true,
      },
      { key: "currency", label: "Currency", kind: "text", expr: "l.rate_currency" },
      { key: "purchased_at", label: "Purchased", kind: "timestamp", expr: "l.purchased_at" },
      { key: "purchased_date", label: "Purchase date", kind: "date", expr: "l.purchased_at::date" },
      { key: "voided_at", label: "Voided", kind: "timestamp", expr: "l.voided_at" },
      { key: "cost_entry_id", label: "Cost journal (id)", kind: "uuid", expr: "l.cost_entry_id" },
    ],
    cellLinks: [{
      column: "tracking_number",
      kind: "transaction",
      entryIdColumn: "cost_entry_id",
    }],
    defaultSort: { column: "purchased_at", direction: "desc" },
  },
  {
    ...shared,
    key: "shipping_adjustments",
    label: "Carrier adjustments",
    description:
      "Billing corrections the carrier or aggregator applied after purchase — weight, dimension and address corrections with the reason and posting state.",
    from: `shipping_adjustments a
      JOIN shipment_labels l ON l.id = a.label_id AND l.org_id = a.org_id
      JOIN documents d ON d.id = l.shipment_document_id AND d.org_id = l.org_id
      LEFT JOIN currencies cur ON cur.code = a.currency`,
    orgColumn: "a.org_id",
    subsidiaryScope: { column: "d.subsidiary_id" },
    requiredPermission: "shipping.manage",
    timeKey: "occurred_at",
    defaultPeriodField: "occurred_at",
    currencyColumn: "currency",
    columns: [
      { key: "id", label: "Adjustment (id)", kind: "uuid", expr: "a.id" },
      { key: "shipment_number", label: "Shipment #", kind: "text", expr: "d.document_number" },
      { key: "carrier", label: "Carrier", kind: "text", expr: "l.carrier" },
      { key: "service", label: "Service", kind: "text", expr: "l.service" },
      {
        key: "kind",
        label: "Reason",
        kind: "enum",
        expr: "a.kind",
        options: ["weight_correction", "dimension_correction", "address_correction", "fuel", "duplicate", "other"],
      },
      {
        key: "amount",
        label: "Adjustment",
        kind: "money",
        expr: MINOR_TO_MAJOR("a.amount_minor"),
        txnCurrency: true,
      },
      { key: "currency", label: "Currency", kind: "text", expr: "a.currency" },
      { key: "reason", label: "Detail", kind: "text", expr: "a.reason" },
      {
        key: "status",
        label: "Posting state",
        kind: "enum",
        expr: "a.status",
        options: ["pending", "posted", "disputed"],
      },
      { key: "occurred_at", label: "Occurred", kind: "timestamp", expr: "a.occurred_at" },
      { key: "entry_id", label: "Adjustment journal (id)", kind: "uuid", expr: "a.entry_id" },
    ],
    cellLinks: [{
      column: "shipment_number",
      kind: "transaction",
      entryIdColumn: "entry_id",
    }],
    defaultSort: { column: "occurred_at", direction: "desc" },
  },
];
