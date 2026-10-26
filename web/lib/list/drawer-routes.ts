import {
  BENEFITS_PROGRAM_DRAWER_PARAMS,
  isBenefitsProgramDrawerSelection,
} from "../hrm/benefits-drawer-route";
import { isUuid } from "@openbooks/engine/platform/identifiers";

/** Native list drawers use the same loaders and renderers as their full-page
 * entry points. Full-page records (including pay-run wizards) are excluded. */
export const LIST_DRAWER_ROUTES = {
  vendor_bill: {
    path: "/ap/bills",
    param: "doc",
    widget: "document-drawer",
    permission: "ap.read",
  },
  customer_invoice: {
    path: "/ar/invoices",
    param: "doc",
    widget: "document-drawer",
    permission: "ar.read",
  },
  cash_sale: {
    path: "/cash-sales",
    param: "doc",
    widget: "document-drawer",
    permission: "cash_sales.read",
    feature: "cashSales",
  },
  bank_transaction: {
    path: "/banking/transactions",
    param: "doc",
    widget: "document-drawer",
    permission: "banking.read",
  },
  quote: {
    path: "/estimates",
    param: "estimate",
    widget: "order-drawer",
    permission: "ar.read",
    feature: "orders",
  },
  sales_order: {
    path: "/sales-orders",
    param: "order",
    widget: "order-drawer",
    permission: "ar.read",
    feature: "orders",
  },
  purchase_order: {
    path: "/purchase-orders",
    param: "order",
    widget: "order-drawer",
    permission: "purchase_orders.read",
    feature: "orders",
  },
  rma: {
    path: "/returns",
    param: "doc",
    widget: "document-drawer",
    permission: "orders.fulfill",
    feature: "returnAuthorizations",
  },
  // expenses.self opens the drawer too; the expense loader then reads only the holder's own reports.
  expense_report: {
    path: "/expenses/reports",
    param: "expense",
    widget: "expense-drawer",
    permission: "expenses.read",
    alternatePermissions: ["expenses.self"],
    feature: "expenses",
  },
  field_ticket: {
    path: "/field-tickets",
    param: "ticket",
    widget: "field-ticket-drawer",
    permission: "time.read",
    feature: "fieldTickets",
  },
  pick_list: {
    path: "/picks",
    param: "pick",
    widget: "pick-list-drawer",
    permission: "orders.fulfill",
    feature: "fulfillment",
  },
  shipment: {
    path: "/shipments",
    param: "shipment",
    widget: "shipment-drawer",
    permission: "orders.fulfill",
    feature: "fulfillment",
  },
  customer_payment: {
    path: "/receipts",
    param: "payment",
    widget: "payment-drawer",
    permission: "ar.pay",
  },
  subscription: {
    path: "/collections",
    param: "subscription",
    widget: "subscription-drawer",
    permission: "ar.read",
    feature: "subscriptionBilling",
  },
} as const;

export type ListDrawerSource = keyof typeof LIST_DRAWER_ROUTES;
export type ListDrawerWidget = (typeof LIST_DRAWER_ROUTES)[ListDrawerSource]["widget"];
export type NativeListDrawerData = { widget: ListDrawerWidget; drawer: unknown };
const PROPERTY_MANAGEMENT_DRAWER_PARAMS = [
  "property",
  "unit",
  "lease",
  "cam",
  "camAction",
  "propertyTab",
] as const;

export function listDrawerRoute(source: string) {
  return Object.hasOwn(LIST_DRAWER_ROUTES, source)
    ? LIST_DRAWER_ROUTES[source as ListDrawerSource]
    : null;
}

/** Only record chrome is shallow. Search, saved views and list filters still
 * cause a server read, so changing them cannot leave stale rows visible. */
export function isListDrawerHrefChange(currentHref: string, nextHref: string): boolean {
  const current = new URL(currentHref, "https://list.local");
  const next = new URL(nextHref, current);
  if (current.origin !== next.origin || current.pathname !== next.pathname) return false;
  if (current.pathname === "/hrm/benefits") {
    const before = current.searchParams.get("program");
    const after = next.searchParams.get("program");
    if ((!before && !after) || before === "new" || after === "new") return false;
    if (
      (before && !isBenefitsProgramDrawerSelection(current.searchParams)) ||
      (after && !isBenefitsProgramDrawerSelection(next.searchParams))
    )
      return false;
    for (const params of [current.searchParams, next.searchParams]) {
      for (const key of BENEFITS_PROGRAM_DRAWER_PARAMS) params.delete(key);
      params.sort();
    }
    return current.searchParams.toString() === next.searchParams.toString();
  }
  if (current.pathname === "/property-management") {
    const changed = PROPERTY_MANAGEMENT_DRAWER_PARAMS.some(
      (key) => current.searchParams.get(key) !== next.searchParams.get(key),
    );
    if (!changed) return false;
    for (const params of [current.searchParams, next.searchParams]) {
      for (const key of PROPERTY_MANAGEMENT_DRAWER_PARAMS) params.delete(key);
      params.sort();
    }
    return current.searchParams.toString() === next.searchParams.toString();
  }
  const route = Object.values(LIST_DRAWER_ROUTES).find((item) => item.path === current.pathname);
  if (!route) return false;
  const before = current.searchParams.get(route.param);
  const after = next.searchParams.get(route.param);
  if ((before && !isUuid(before)) || (after && !isUuid(after)) || (!before && !after)) return false;
  for (const params of [current.searchParams, next.searchParams]) {
    for (const key of [route.param, "drawerReturn", "form", "mode", "transactionTab"])
      params.delete(key);
    params.sort();
  }
  return current.searchParams.toString() === next.searchParams.toString();
}
