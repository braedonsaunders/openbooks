import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accountingPeriods } from "./core";
import { accounts } from "./coa";
import { journalEntries } from "./ledger";
import { parties } from "./parties";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * Capitalized contract costs (ASC 340-40 / IFRS 15 costs to obtain a
 * contract): incremental sales commissions (and, where elected, fulfilment
 * costs) held as an asset and amortized on a systematic basis consistent with
 * the transfer of the related goods or services.
 *
 * Policy is effective-dated: the row with the latest effective_from on or
 * before the capitalization date governs, so a policy change never
 * reinterprets history. Amortization rows are immutable posted history —
 * corrections arrive as impairment, never edits.
 */

export const CONTRACT_COST_BASES = ["contract_term", "customer_life"] as const;
export const CUSTOMER_LIFE_SOURCES = ["manual", "derived"] as const;
export const CONTRACT_COST_TYPES = ["commission", "fulfilment"] as const;
export const CONTRACT_COST_METHODS = ["straight_line", "pattern"] as const;
export const CONTRACT_COST_STATUSES = [
  "active",
  "fully_amortized",
  "impaired",
  "expensed",
] as const;

/** Effective-dated capitalization policy: which costs capitalize, over what
 *  benefit period, and into which accounts. */
export const contractCostPolicies = pgTable(
  "contract_cost_policies",
  {
    id: id(),
    orgId: orgRef(),
    effectiveFrom: date("effective_from").notNull(),
    capitalizeCommissions: boolean("capitalize_commissions").notNull().default(true),
    capitalizeFulfilment: boolean("capitalize_fulfilment").notNull().default(false),
    practicalExpedient: boolean("practical_expedient").notNull().default(true),
    basis: text("basis", { enum: CONTRACT_COST_BASES }).notNull().default("contract_term"),
    customerLifeSource: text("customer_life_source", { enum: CUSTOMER_LIFE_SOURCES }).notNull().default("manual"),
    customerLifeMonths: integer("customer_life_months"),
    renewalCommensurateThresholdPercent: numeric("renewal_commensurate_threshold_percent", { precision: 19, scale: 4 }).notNull().default("50.0000"),
    assetAccountId: uuid("asset_account_id"),
    amortizationExpenseAccountId: uuid("amortization_expense_account_id"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("contract_cost_policies_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("contract_cost_policies_effective_unique").on(t.orgId, t.effectiveFrom),
    check("contract_cost_policies_life_months_positive", sql`${t.customerLifeMonths} IS NULL OR ${t.customerLifeMonths} > 0`),
    foreignKey({
      name: "contract_cost_policies_asset_account_fk",
      columns: [t.orgId, t.assetAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    foreignKey({
      name: "contract_cost_policies_amort_account_fk",
      columns: [t.orgId, t.amortizationExpenseAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
  ],
);

/** One capitalized cost: the asset, its amortization window, and its source.
 *  `revenueContractId` stays null until an imported commission is linked to
 *  its contract — those rows are the workspace's unlinked queue. */
export const contractCostAssets = pgTable(
  "contract_cost_assets",
  {
    id: id(),
    orgId: orgRef(),
    revenueContractId: uuid("revenue_contract_id"),
    repPartyId: uuid("rep_party_id"),
    customerPartyId: uuid("customer_party_id"),
    costType: text("cost_type", { enum: CONTRACT_COST_TYPES }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    capitalizedOn: date("capitalized_on").notNull(),
    amortStartOn: date("amort_start_on").notNull(),
    amortEndOn: date("amort_end_on").notNull(),
    method: text("method", { enum: CONTRACT_COST_METHODS }).notNull(),
    status: text("status", { enum: CONTRACT_COST_STATUSES }).notNull().default("active"),
    source: jsonb("source").$type<Record<string, unknown>>().notNull().default({}),
    capitalizeEntryId: uuid("capitalize_entry_id"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("contract_cost_assets_org_id_id_unique").on(t.orgId, t.id),
    index("contract_cost_assets_contract").on(t.orgId, t.revenueContractId),
    index("contract_cost_assets_status").on(t.orgId, t.status),
    check("contract_cost_assets_amount_positive", sql`${t.amountMinor} > 0`),
    check("contract_cost_assets_term_ordered", sql`${t.amortStartOn} <= ${t.amortEndOn}`),
    foreignKey({
      name: "contract_cost_assets_rep_fk",
      columns: [t.repPartyId],
      foreignColumns: [parties.id],
    }),
    foreignKey({
      name: "contract_cost_assets_customer_fk",
      columns: [t.customerPartyId],
      foreignColumns: [parties.id],
    }),
    foreignKey({
      name: "contract_cost_assets_capitalize_entry_fk",
      columns: [t.orgId, t.capitalizeEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
  ],
);

/** Posted amortization per asset and period: immutable, one row per
 *  asset+period, each tracing to its balanced journal entry. */
export const contractCostAmortization = pgTable(
  "contract_cost_amortization",
  {
    id: id(),
    orgId: orgRef(),
    assetId: uuid("asset_id").notNull(),
    periodId: uuid("period_id").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    journalEntryId: uuid("journal_entry_id").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("contract_cost_amortization_org_id_id_unique").on(t.orgId, t.id),
    uniqueIndex("contract_cost_amortization_one_per_period").on(t.orgId, t.assetId, t.periodId),
    uniqueIndex("contract_cost_amortization_entry_unique").on(t.orgId, t.journalEntryId),
    index("contract_cost_amortization_asset").on(t.orgId, t.assetId),
    check("contract_cost_amortization_amount_positive", sql`${t.amountMinor} > 0`),
    foreignKey({
      name: "contract_cost_amortization_asset_fk",
      columns: [t.orgId, t.assetId],
      foreignColumns: [contractCostAssets.orgId, contractCostAssets.id],
    }),
    foreignKey({
      name: "contract_cost_amortization_period_fk",
      columns: [t.orgId, t.periodId],
      foreignColumns: [accountingPeriods.orgId, accountingPeriods.id],
    }),
    foreignKey({
      name: "contract_cost_amortization_entry_fk",
      columns: [t.orgId, t.journalEntryId],
      foreignColumns: [journalEntries.orgId, journalEntries.id],
    }),
  ],
);
