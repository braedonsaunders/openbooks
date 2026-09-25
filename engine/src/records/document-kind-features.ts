/** Optional Features switchboard gates for document kinds. Shared by engine
 * jobs and the client-safe web document registry. */
export const DOC_KIND_FEATURE: Partial<Record<string, string>> = {
  quote: "orders",
  sales_order: "orders",
  purchase_order: "orders",
  expense_report: "expenses",
  field_ticket: "fieldTickets",
  pay_run: "payroll",
  project_charge: "projects",
};
