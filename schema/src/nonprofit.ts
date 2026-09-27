import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accounts } from "./coa";
import { auditColumns, id, orgRef } from "./helpers";
import { segmentValues } from "./segments";

/** Accounting attributes for a value in the fund transaction segment. */
export const funds = pgTable(
  "funds",
  {
    id: id(),
    orgId: orgRef(),
    kind: text("kind", {
      enum: ["operating", "restricted", "endowment", "plant", "board_designated"],
    }).notNull(),
    restrictionClass: text("restriction_class").notNull(),
    budgetaryControl: text("budgetary_control", {
      enum: ["off", "advisory", "hard"],
    })
      .notNull()
      .default("off"),
    custom: jsonb("custom").$type<Record<string, unknown>>().notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("funds_org_id_id_unique").on(t.orgId, t.id),
    foreignKey({
      name: "funds_segment_value_fkey",
      columns: [t.orgId, t.id],
      foreignColumns: [segmentValues.orgId, segmentValues.id],
    }),
    check(
      "funds_kind_check",
      sql`${t.kind} in ('operating', 'restricted', 'endowment', 'plant', 'board_designated')`,
    ),
    check(
      "funds_budgetary_control_check",
      sql`${t.budgetaryControl} in ('off', 'advisory', 'hard')`,
    ),
    index("funds_org_restriction_class").on(t.orgId, t.restrictionClass),
  ],
);

/** Active due-to/due-from accounts between two fund values. */
export const fundPairs = pgTable(
  "fund_pairs",
  {
    id: id(),
    orgId: orgRef(),
    fromFundId: uuid("from_fund_id").notNull(),
    toFundId: uuid("to_fund_id").notNull(),
    dueFromAccountId: uuid("due_from_account_id").notNull(),
    dueToAccountId: uuid("due_to_account_id").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("fund_pairs_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("fund_pairs_org_from_to_unique").on(t.orgId, t.fromFundId, t.toFundId),
    foreignKey({
      name: "fund_pairs_from_fund_fkey",
      columns: [t.orgId, t.fromFundId],
      foreignColumns: [funds.orgId, funds.id],
    }),
    foreignKey({
      name: "fund_pairs_to_fund_fkey",
      columns: [t.orgId, t.toFundId],
      foreignColumns: [funds.orgId, funds.id],
    }),
    foreignKey({
      name: "fund_pairs_due_from_account_fkey",
      columns: [t.orgId, t.dueFromAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    foreignKey({
      name: "fund_pairs_due_to_account_fkey",
      columns: [t.orgId, t.dueToAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    check("fund_pairs_distinct_funds_check", sql`${t.fromFundId} <> ${t.toFundId}`),
    index("fund_pairs_org_to_fund").on(t.orgId, t.toFundId),
  ],
);
