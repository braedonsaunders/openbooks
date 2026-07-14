import { sql } from "drizzle-orm";
import { numeric, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** uuidv7 primary key — time-ordered, index-friendly. */
export const id = () =>
  uuid("id").primaryKey().default(sql`uuid_generate_v7()`);

/** Every row belongs to an org; RLS policies key off this. */
export const orgRef = () => uuid("org_id").notNull();

/** Money in a specific currency. 4 decimal places covers all ISO minor units. */
export const money = (name: string) => numeric(name, { precision: 19, scale: 4 });

/** FX rates need more precision than money. */
export const fxRate = (name: string) => numeric(name, { precision: 19, scale: 10 });

export const auditColumns = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid("created_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by"),
};

/** ISO 4217 alpha code, e.g. 'CAD'. */
export const currencyCode = (name = "currency_code") => text(name);
