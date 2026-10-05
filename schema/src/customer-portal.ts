import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { orgs } from "./core";
import { parties } from "./parties";
import { auditColumns, id, orgRef } from "./helpers";

/** Drizzle mirror of migration 0534_customer_portal. */
export const customerPortalLinks = pgTable(
  "customer_portal_links",
  {
    id: id(),
    orgId: orgRef(),
    partyId: uuid("party_id").notNull(),
    contactEmail: text("contact_email").notNull(),
    tokenHash: text("token_hash").notNull(),
    purpose: text("purpose").notNull().default("magic_link"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("customer_portal_links_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("customer_portal_links_token_hash_unique").on(t.tokenHash),
    index("customer_portal_links_party_scan").on(t.orgId, t.partyId, t.expiresAt),
    check(
      "customer_portal_links_email_nonblank",
      sql`length(btrim(${t.contactEmail})) > 0`,
    ),
    check("customer_portal_links_hash_nonblank", sql`length(btrim(${t.tokenHash})) > 0`),
    foreignKey({ name: "customer_portal_links_org_fk", columns: [t.orgId], foreignColumns: [orgs.id] }),
    foreignKey({
      name: "customer_portal_links_party_tenant_fk",
      columns: [t.orgId, t.partyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
  ],
);

export const customerPortalSettings = pgTable(
  "customer_portal_settings",
  {
    id: id(),
    orgId: orgRef(),
    effectiveFrom: date("effective_from").notNull(),
    portalName: text("portal_name").notNull().default("Customer portal"),
    sections: jsonb("sections").notNull().default({}),
    returnWindowDays: integer("return_window_days").notNull().default(30),
    returnReasons: jsonb("return_reasons").notNull().default([]),
    returnResolutions: jsonb("return_resolutions").notNull().default({}),
    saveOffers: jsonb("save_offers").notNull().default([]),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("customer_portal_settings_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("customer_portal_settings_effective_unique").on(t.orgId, t.effectiveFrom),
    index("customer_portal_settings_effective_scan").on(t.orgId, t.effectiveFrom),
    check(
      "customer_portal_settings_window_nonnegative",
      sql`${t.returnWindowDays} >= 0`,
    ),
    foreignKey({
      name: "customer_portal_settings_org_fk",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }),
  ],
);

export const customerPortalEvents = pgTable(
  "customer_portal_events",
  {
    id: id(),
    orgId: orgRef(),
    partyId: uuid("party_id").notNull(),
    linkId: uuid("link_id"),
    action: text("action").notNull(),
    reasonCode: text("reason_code"),
    detail: jsonb("detail").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
  },
  (t) => [
    uniqueIndex("customer_portal_events_org_id_id_unique").on(t.orgId, t.id),
    index("customer_portal_events_party_scan").on(t.orgId, t.partyId, t.createdAt),
    check("customer_portal_events_action_nonblank", sql`length(btrim(${t.action})) > 0`),
    foreignKey({
      name: "customer_portal_events_org_fk",
      columns: [t.orgId],
      foreignColumns: [orgs.id],
    }),
    foreignKey({
      name: "customer_portal_events_party_tenant_fk",
      columns: [t.orgId, t.partyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    foreignKey({
      name: "customer_portal_events_link_tenant_fk",
      columns: [t.orgId, t.linkId],
      foreignColumns: [customerPortalLinks.orgId, customerPortalLinks.id],
    }),
  ],
);
