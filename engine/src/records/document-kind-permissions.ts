/**
 * Permission keys for document kinds: the single source shared by the web
 * document registry (web/lib/document-kinds.ts derives DOC_KINDS'
 * permNamespace and its permission helpers from here) and the flows
 * documents adapter. Client-safe: no imports.
 */

export type DocumentPermissionNamespace = "ap" | "ar" | "cash_sales" | "gl";

/** Permission namespace of every drawer-registry document kind. */
export const DOCUMENT_PERMISSION_NAMESPACE: Readonly<Record<string, DocumentPermissionNamespace>> = {
  vendor_bill: "ap",
  vendor_credit: "ap",
  customer_invoice: "ar",
  customer_credit: "ar",
  // Cash sales and refunds carry their own `cash_sales.*` grants — separate
  // from `ar.*` so till operators can sell and refund without holding the
  // receivables book — while every helper below keeps working: the keys are
  // derived from the namespace (`cash_sales.read`, `cash_sales.create`,
  // `cash_sales.post`), the same hierarchical shape as every other module.
  cash_sale: "cash_sales",
  cash_refund: "cash_sales",
  rma: "ar",
  card_charge: "ap",
  card_refund: "ap",
  check: "ap",
  deposit: "gl",
  transfer: "gl",
  project_charge: "gl",
  internal_billing: "gl",
  pay_run: "gl",
};

export type DocumentKindPermissions = { read: string; edit: string; approve: string };

function namespaceOf(kind: string): DocumentPermissionNamespace {
  const namespace = DOCUMENT_PERMISSION_NAMESPACE[kind];
  if (!namespace) throw new Error(`unknown document kind "${kind}"`);
  return namespace;
}

/** Permission key for reading a kind (ap.read / ar.read / gl.read). */
export function readPermission(kind: string): string {
  return `${namespaceOf(kind)}.read`;
}

/** Permission key for the create/submit action on a kind. */
export function createPermission(kind: string): string {
  if (kind === "rma") return "orders.fulfill";
  const namespace = namespaceOf(kind);
  return namespace === "gl" ? "gl.post" : `${namespace}.create`;
}

/** Permission key for the post action on a kind. */
export function postPermission(kind: string): string {
  const namespace = namespaceOf(kind);
  return namespace === "gl" ? "gl.post" : `${namespace}.post`;
}

/**
 * Read grant through the generic document endpoints. Project charges are a
 * Projects-domain record, so they read through projects.read rather than the
 * GL namespace their posting rule lives under.
 */
export function documentReadPermission(kind: string): string {
  if (kind === "rma") return "orders.fulfill";
  if (kind === "project_charge") return "projects.read";
  return readPermission(kind);
}

/** Edit grant through the generic document endpoints (project charges: projects.manage). */
export function documentEditPermission(kind: string): string {
  if (kind === "rma") return "orders.fulfill";
  if (kind === "project_charge") return "projects.manage";
  return createPermission(kind);
}

/**
 * Document kinds outside the drawer registry, with the grant their
 * kind-specific surface checks:
 * - journal: /journal requires gl.read; void requires gl.post.
 * - vendor_payment: /payments requires ap.pay; void requires ap.pay.
 * - customer_payment: /receipts requires ar.pay; void requires ar.pay.
 * - expense_report: /expenses requires expenses.read; writes expenses.create.
 * - sales_order / quote: estimates require ar.read; void requires ar.create.
 * - purchase_order: purchase_orders.read reads; void requires purchase_orders.create.
 * - field_ticket: /field-tickets requires time.read; writes time.manage.
 * - pick_list / shipment: /picks and /shipments require orders.fulfill, and
 *   every fulfilment write (release, ship, void) requires it too.
 */
const NON_REGISTRY_DOCUMENT_PERMISSIONS: Readonly<Record<string, DocumentKindPermissions>> = {
  journal: { read: "gl.read", edit: "gl.post", approve: "gl.post" },
  vendor_payment: { read: "ap.pay", edit: "ap.pay", approve: "ap.pay" },
  customer_payment: { read: "ar.pay", edit: "ar.pay", approve: "ar.pay" },
  expense_report: { read: "expenses.read", edit: "expenses.create", approve: "ap.post" },
  sales_order: { read: "ar.read", edit: "ar.create", approve: "ar.create" },
  quote: { read: "ar.read", edit: "ar.create", approve: "ar.create" },
  purchase_order: { read: "purchase_orders.read", edit: "purchase_orders.create", approve: "purchase_orders.create" },
  field_ticket: { read: "time.read", edit: "time.manage", approve: "time.manage" },
  pick_list: { read: "orders.fulfill", edit: "orders.fulfill", approve: "orders.fulfill" },
  shipment: { read: "orders.fulfill", edit: "orders.fulfill", approve: "orders.fulfill" },
};

/**
 * Read/edit/approve grants for a document kind as a flow subject: registry
 * kinds through the helpers above (project charges approve with their
 * projects.manage edit grant), other kinds through the table above, null
 * for a kind neither covers.
 */
export function documentKindPermissions(kind: string): DocumentKindPermissions | null {
  if (DOCUMENT_PERMISSION_NAMESPACE[kind]) {
    return {
      read: documentReadPermission(kind),
      edit: documentEditPermission(kind),
      approve: kind === "project_charge" ? documentEditPermission(kind) : postPermission(kind),
    };
  }
  return NON_REGISTRY_DOCUMENT_PERMISSIONS[kind] ?? null;
}

/** Read grant through the generic documents endpoints; null when the kind is not served there. */
export function documentRouteReadPermission(kind: string): string | null {
  return documentKindPermissions(kind)?.read ?? null;
}

/** Edit grant for a registry document kind through the generic endpoints. */
export function documentRouteEditPermission(kind: string): string | null {
  return DOCUMENT_PERMISSION_NAMESPACE[kind] ? documentEditPermission(kind) : null;
}
