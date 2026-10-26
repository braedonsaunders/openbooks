const CRM_SETUP_ENTITIES = new Set([
  "crm-account-statuses",
  "crm-opportunity-statuses",
  "crm-lead-sources",
]);

/** CRM setup records retain their module permission through generic CRUD. */
export function setupEntityRoutePermission(entityKey: unknown): string {
  return typeof entityKey === "string" && CRM_SETUP_ENTITIES.has(entityKey)
    ? "crm.setup.manage"
    : "admin.setup.manage";
}
