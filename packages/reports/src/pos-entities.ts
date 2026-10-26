import type { ReportEntity } from "./entities";

// Point-of-sale reports read the register subledger: one row per drawer
// session for the Z history and cash over/short, one row per register sale
// or refund for sales by register and cashier. Register amounts are ledger
// units at ten-thousandths precision; the money expressions divide back to
// whole units in exact numeric arithmetic, the same conversion the session
// report uses. Every amount is in the session's currency, exposed as the
// `currency` column so mixed-currency totals are refused, and every join is
// pinned to the row's organization.
const UNITS = (column: string): string => `(${column}::numeric / 10000)`;

const shared = {
  category: "transactions",
  featureKey: "posRegister",
  // A session belongs to its register's legal entity; sales and refunds
  // inherit the session's entity.
  subsidiaryScope: { column: "s.subsidiary_id" },
  currencyColumn: "currency",
  timeKey: "business_date",
  defaultPeriodField: "business_date",
} as const;

export const POS_REPORT_ENTITIES: ReportEntity[] = [
  {
    ...shared,
    key: "pos_sessions",
    label: "Register sessions",
    description:
      "One row per register drawer session with its sales, refunds, opening float, expected and counted cash and over/short. Filter to closed sessions for the Z report history.",
    // Drawer counts and over/short are cash-control data: the same
    // permission the session reports require.
    requiredPermission: "pos.drawer",
    from: `pos_sessions s
      JOIN pos_registers r ON r.id = s.register_id AND r.org_id = s.org_id
      JOIN subsidiaries sub ON sub.id = s.subsidiary_id AND sub.org_id = s.org_id
      LEFT JOIN users ou ON ou.id = s.opened_by AND ou.org_id = s.org_id
      LEFT JOIN users cu ON cu.id = s.closed_by AND cu.org_id = s.org_id
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE pt.kind = 'sale') AS sale_count,
               count(*) FILTER (WHERE pt.kind = 'refund') AS refund_count,
               coalesce(sum(pt.total_minor) FILTER (WHERE pt.kind = 'sale'), 0) AS sales_total,
               coalesce(sum(pt.total_minor) FILTER (WHERE pt.kind = 'refund'), 0) AS refunds_total
          FROM pos_transactions pt
         WHERE pt.org_id = s.org_id AND pt.session_id = s.id
      ) t ON true`,
    orgColumn: "s.org_id",
    defaultSort: { column: "business_date", direction: "desc" },
    columns: [
      { key: "id", label: "Session key", kind: "uuid", expr: "s.id" },
      { key: "register_code", label: "Register code", kind: "text", expr: "r.code" },
      { key: "register", label: "Register", kind: "text", expr: "r.name" },
      {
        key: "session_number",
        label: "Session",
        kind: "number",
        identifier: true,
        expr: "s.session_number",
      },
      {
        key: "status",
        label: "Status",
        kind: "enum",
        expr: "s.status",
        options: ["open", "closed"],
      },
      { key: "business_date", label: "Business date", kind: "date", expr: "s.business_date" },
      { key: "opened_by", label: "Opened by", kind: "text", expr: "ou.name" },
      { key: "closed_by", label: "Closed by", kind: "text", expr: "cu.name" },
      {
        key: "opening_float",
        label: "Opening float",
        kind: "money",
        expr: UNITS("s.opening_float_minor"),
        txnCurrency: true,
      },
      { key: "sale_count", label: "Sales", kind: "number", expr: "t.sale_count" },
      {
        key: "sales_total",
        label: "Sales total",
        kind: "money",
        expr: UNITS("t.sales_total"),
        txnCurrency: true,
      },
      { key: "refund_count", label: "Refunds", kind: "number", expr: "t.refund_count" },
      {
        key: "refunds_total",
        label: "Refunds total",
        kind: "money",
        expr: UNITS("t.refunds_total"),
        txnCurrency: true,
      },
      {
        key: "expected_cash",
        label: "Expected cash",
        kind: "money",
        expr: UNITS("s.expected_cash_minor"),
        txnCurrency: true,
      },
      {
        key: "counted_cash",
        label: "Counted cash",
        kind: "money",
        expr: UNITS("s.counted_cash_minor"),
        txnCurrency: true,
      },
      {
        key: "over_short",
        label: "Over / short",
        kind: "money",
        expr: UNITS("s.over_short_minor"),
        txnCurrency: true,
      },
      { key: "currency", label: "Currency", kind: "text", expr: "s.currency" },
      { key: "subsidiary", label: "Subsidiary", kind: "text", expr: "sub.name" },
      { key: "close_note", label: "Closing note", kind: "text", expr: "s.close_note" },
    ],
  },
  {
    ...shared,
    key: "pos_transactions",
    label: "Register sales and refunds",
    description:
      "One row per register sale or refund with its receipt, register, session, cashier and customer. Group by register or cashier for sales by register and by cashier.",
    // Register sales and refunds are native cash sales and cash refunds.
    requiredPermission: "cash_sales.read",
    from: `pos_transactions pt
      JOIN pos_sessions s ON s.id = pt.session_id AND s.org_id = pt.org_id
      JOIN pos_registers r ON r.id = pt.register_id AND r.org_id = pt.org_id
      JOIN documents d ON d.id = pt.document_id AND d.org_id = pt.org_id
      JOIN subsidiaries sub ON sub.id = s.subsidiary_id AND sub.org_id = pt.org_id
      LEFT JOIN users u ON u.id = pt.created_by AND u.org_id = pt.org_id
      LEFT JOIN parties p ON p.id = d.party_id AND p.org_id = pt.org_id`,
    orgColumn: "pt.org_id",
    defaultSort: { column: "business_date", direction: "desc" },
    columns: [
      { key: "id", label: "Transaction key", kind: "uuid", expr: "pt.id" },
      { key: "receipt_number", label: "Receipt", kind: "text", expr: "d.document_number" },
      { key: "kind", label: "Type", kind: "enum", expr: "pt.kind", options: ["sale", "refund"] },
      {
        key: "document_status",
        label: "Document status",
        kind: "enum",
        expr: "d.status",
        options: ["draft", "pending_approval", "approved", "posted", "voided"],
      },
      { key: "business_date", label: "Business date", kind: "date", expr: "s.business_date" },
      { key: "register_code", label: "Register code", kind: "text", expr: "r.code" },
      { key: "register", label: "Register", kind: "text", expr: "r.name" },
      {
        key: "session_number",
        label: "Session",
        kind: "number",
        identifier: true,
        expr: "s.session_number",
      },
      { key: "cashier", label: "Cashier", kind: "text", expr: "u.name" },
      { key: "customer", label: "Customer", kind: "text", expr: "p.display_name" },
      {
        key: "total",
        label: "Total",
        kind: "money",
        expr: UNITS("pt.total_minor"),
        txnCurrency: true,
      },
      {
        key: "net_sales",
        label: "Net sales",
        kind: "money",
        txnCurrency: true,
        expr: `(CASE WHEN pt.kind = 'refund' THEN -${UNITS("pt.total_minor")} ELSE ${UNITS("pt.total_minor")} END)`,
      },
      {
        key: "cash_applied",
        label: "Cash applied",
        kind: "money",
        expr: UNITS("pt.cash_applied_minor"),
        txnCurrency: true,
      },
      {
        key: "change_given",
        label: "Change given",
        kind: "money",
        expr: UNITS("pt.change_minor"),
        txnCurrency: true,
      },
      { key: "currency", label: "Currency", kind: "text", expr: "s.currency" },
      { key: "subsidiary", label: "Subsidiary", kind: "text", expr: "sub.name" },
      { key: "document_id", label: "Document key", kind: "uuid", expr: "pt.document_id" },
    ],
  },
];
