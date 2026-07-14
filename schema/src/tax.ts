import {
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * Tax codes with dated rates. Canada-first (GST/HST/PST, ITC recoverability)
 * but jurisdiction-generic. Compound provincial cases (QST-on-GST legacy)
 * handled via tax groups summing component codes.
 */
export const taxCodes = pgTable("tax_codes", {
  id: id(),
  orgId: orgRef(),
  code: text("code").notNull(), // "HST-ON", "GST", "EXEMPT"
  name: text("name").notNull(),
  country: text("country"),
  region: text("region"),
  appliesTo: text("applies_to", { enum: ["sales", "purchases", "both"] }).notNull().default("both"),
  collectedAccountId: uuid("collected_account_id"), // liability (sales tax collected)
  paidAccountId: uuid("paid_account_id"), // recoverable ITC asset
  /** Non-recoverable portion is expensed to the line's account instead. */
  recoverablePercent: money("recoverable_percent").notNull().default("100"),
  isActive: boolean("is_active").notNull().default(true),
  ...auditColumns,
});

export const taxRates = pgTable(
  "tax_rates",
  {
    id: id(),
    orgId: orgRef(),
    taxCodeId: uuid("tax_code_id").notNull(),
    ratePercent: money("rate_percent").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    ...auditColumns,
  },
  (t) => [index("tax_rates_code").on(t.taxCodeId)],
);

export const taxGroups = pgTable("tax_groups", {
  id: id(),
  orgId: orgRef(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
});

export const taxGroupMembers = pgTable("tax_group_members", {
  id: id(),
  taxGroupId: uuid("tax_group_id").notNull(),
  taxCodeId: uuid("tax_code_id").notNull(),
  sequence: integer("sequence").notNull().default(1),
});

/**
 * Maps GL activity to tax return lines (GST34: line 101 sales, 103 collected,
 * 106 ITCs…). Replaces NetSuite's Tax Report Mapper custom record.
 */
export const taxReportLines = pgTable("tax_report_lines", {
  id: id(),
  orgId: orgRef(),
  reportCode: text("report_code").notNull(), // "CA_GST34"
  lineCode: text("line_code").notNull(), // "101"
  label: text("label").notNull(),
  taxCodeId: uuid("tax_code_id"),
  basis: text("basis", { enum: ["tax_amount", "taxable_base"] }).notNull(),
  sign: integer("sign").notNull().default(1),
  ...auditColumns,
});
