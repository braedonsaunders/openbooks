import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Installation-owned operator configuration (migration 0173).
 *
 * The only table in this schema that belongs to the DEPLOYMENT rather than to
 * an organization, so it is deliberately org-less: per-org backup archives,
 * sandbox clones and org teardown all select tables by their `org_id` column
 * and therefore skip this one — which is what an operator setting wants.
 *
 * One singleton row, pinned by a CHECK on the primary key, so "the settings"
 * is addressable without a lookup and a second row is impossible. RLS is
 * bypass-only: a tenant session matches no row at all, and only trusted
 * server-side code inside withBypass/withBypassContext (behind the
 * super-admin gate) can read or write it.
 *
 * Credentials inside `settings` are sealed by engine/src/secrets.ts before
 * they are stored — this table never holds a plaintext secret.
 */
export const platformSettings = pgTable("platform_settings", {
  /** Always PLATFORM_SETTINGS_ID; a database CHECK admits no other value. */
  id: text("id").primaryKey().default("platform"),
  /** Operator settings by area, e.g. `{ feedback: { … } }`. */
  settings: jsonb("settings").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by"),
});

/** The one row's primary key. */
export const PLATFORM_SETTINGS_ID = "platform" as const;
