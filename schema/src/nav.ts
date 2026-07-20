import { jsonb, pgTable, uniqueIndex } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Org-level menu customization, shared by the top menu and optional sidebar.
 * One row per org; no row = computed defaults from the code registry.
 * config: { version: 2, groups: [{ id, label, items: [
 *   { kind:'module', moduleKey, label?, iconKey?, hidden? } |
 *   { kind:'link', href, label, iconKey?, hidden? } ] }] }
 */
export const orgNavConfigs = pgTable(
  "org_nav_configs",
  {
    id: id(),
    orgId: orgRef(),
    config: jsonb("config").notNull(),
    ...auditColumns,
  },
  (t) => [uniqueIndex("org_nav_configs_org").on(t.orgId)],
);

// FKs (integrator): alter table org_nav_configs add foreign key (org_id) references orgs(id);
