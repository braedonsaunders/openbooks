import {
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

export const rebateAgreements = pgTable(
  "rebate_agreements",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: ["draft", "approved"] })
      .notNull()
      .default("draft"),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    side: text("side", { enum: ["customer", "vendor"] }).notNull(),
    activity: text("activity", { enum: ["sale", "purchase", "downstream_sale"] }).notNull(),
    partyId: uuid("party_id"),
    classId: uuid("class_id"),
    itemId: uuid("item_id"),
    currency: text("currency").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to").notNull(),
    method: text("method", {
      enum: ["percent", "per_unit", "fixed_cost", "guaranteed_margin"],
    }).notNull(),
    tierBasis: text("tier_basis", { enum: ["amount", "quantity"] }).notNull(),
    tiers: jsonb("tiers").$type<{ threshold: string; rate: string }[]>().notNull(),
    targetUnitCost: money("target_unit_cost"),
    marginPercent: money("margin_percent"),
    stacking: text("stacking", { enum: ["stack", "best"] }).notNull(),
    selectionGroup: text("selection_group").notNull(),
    accrualAccountId: uuid("accrual_account_id").notNull(),
    offsetAccountId: uuid("offset_account_id").notNull(),
    fxAccountId: uuid("fx_account_id").notNull(),
    taxTreatment: text("tax_treatment", { enum: ["outside_scope", "taxable"] }).notNull(),
    settlementTaxCodeId: uuid("settlement_tax_code_id"),
    reason: text("reason").notNull(),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("rebate_agreements_org_id_id").on(t.orgId, t.id),
    uniqueIndex("rebate_agreements_org_code").on(t.orgId, t.code),
  ],
);
export const rebateCostAttestations = pgTable(
  "rebate_cost_attestations",
  {
    id: id(),
    orgId: orgRef(),
    documentLineId: uuid("document_line_id").notNull(),
    costAmount: money("cost_amount").notNull(),
    resaleAmount: money("resale_amount"),
    currency: text("currency").notNull(),
    evidence: text("evidence").notNull(),
    actorId: uuid("actor_id").notNull(),
    revision: integer("revision").notNull(),
    lineBasis: jsonb("line_basis").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("rebate_cost_line_revision").on(t.orgId, t.documentLineId, t.revision)],
);
export const rebateAccruals = pgTable(
  "rebate_accruals",
  {
    id: id(),
    orgId: orgRef(),
    agreementId: uuid("agreement_id").notNull(),
    documentLineId: uuid("document_line_id").notNull(),
    partyId: uuid("party_id").notNull(),
    amount: money("amount").notNull(),
    baseAmount: money("base_amount").notNull(),
    fxRate: numeric("fx_rate", { precision: 19, scale: 10 }).notNull(),
    journalEntryId: uuid("journal_entry_id").notNull(),
    accruedOn: date("accrued_on").notNull(),
    revision: integer("revision").notNull(),
    basis: jsonb("basis").notNull(),
    actorId: uuid("actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("rebate_accrual_line_revision").on(
      t.orgId,
      t.agreementId,
      t.documentLineId,
      t.revision,
    ),
  ],
);
export const rebateClaims = pgTable("rebate_claims", {
  id: id(),
  orgId: orgRef(),
  agreementId: uuid("agreement_id").notNull(),
  partyId: uuid("party_id").notNull(),
  amount: money("amount").notNull(),
  baseAmount: money("base_amount").notNull(),
  cutoffOn: date("cutoff_on").notNull(),
  status: text("status", {
    enum: ["draft", "approved", "document_pending", "settled", "cancelled"],
  })
    .notNull()
    .default("draft"),
  reason: text("reason").notNull(),
  basis: jsonb("basis").notNull(),
  approvedBy: uuid("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  settlementDocumentId: uuid("settlement_document_id"),
  settlementEntryId: uuid("settlement_entry_id"),
  settlementOn: date("settlement_on"),
  settlementBasis: jsonb("settlement_basis"),
  ...auditColumns,
});
export const rebateSettlementReversals = pgTable("rebate_settlement_reversals", {
  id: id(),
  orgId: orgRef(),
  claimId: uuid("claim_id").notNull(),
  originalEntryId: uuid("original_entry_id").notNull(),
  reversalEntryId: uuid("reversal_entry_id").notNull(),
  reversedOn: date("reversed_on").notNull(),
  reason: text("reason").notNull(),
  actorId: uuid("actor_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
