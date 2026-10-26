import { sql, type SQL } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";

/**
 * How each reference to an account behaves when the account is merged.
 *
 * - `redirect`: configuration that drives future postings (item and
 *   category defaults, tax codes, party roles, open subledger records).
 *   It moves to the surviving account, audited before/after.
 * - `history`: recorded facts (posted lines, imported statements, issued
 *   pay stubs). They keep the merged account; the merge never rewrites them.
 *
 * A rule may narrow a redirect to rows that are still open (`redirectWhere`)
 * — every other row is history — and may name rows that block the merge
 * (`blockWhere`) because they are in flight and can neither move nor stay.
 *
 * Every foreign key to `accounts` is discovered from the live catalog at
 * merge time. A referencing column with no rule here refuses the merge when
 * it actually references the source, so a newly added table can never be
 * silently skipped (and a catalog test names any unclassified column).
 */
export interface AccountReferenceRule {
  label: string;
  disposition: "redirect" | "history";
  /** Only rows matching this predicate (row alias `r`) move; the rest stay as history. */
  redirectWhere?: SQL;
  /** Rows matching this predicate (row alias `r`) block the merge with this remedy. */
  blockWhere?: { predicate: SQL | ((effectiveDate: string) => SQL); remedy: string };
}

const documentStatus = (statuses: string[], via: "document_id" | "document_line_id") =>
  via === "document_id"
    ? sql`exists (select 1 from documents d where d.org_id = r.org_id and d.id = r.document_id and d.status in ${statuses})`
    : sql`exists (select 1 from document_lines dl join documents d on d.org_id = dl.org_id and d.id = dl.document_id
                   where dl.org_id = r.org_id and dl.id = r.document_line_id and d.status in ${statuses})`;

const DOCUMENT_IN_FLIGHT_REMEDY =
  "Post these documents, or return them to draft, before merging the account; drafts move to the surviving account automatically.";

const draftDocumentRule = (
  label: string,
  via: "document_id" | "document_line_id",
): AccountReferenceRule => ({
  label,
  disposition: "redirect",
  redirectWhere: documentStatus(["draft"], via),
  blockWhere: {
    predicate: documentStatus(["pending_approval", "approved"], via),
    remedy: DOCUMENT_IN_FLIGHT_REMEDY,
  },
});

const config = (label: string): AccountReferenceRule => ({ label, disposition: "redirect" });
const history = (label: string): AccountReferenceRule => ({ label, disposition: "history" });

const retained = (
  label: string,
  predicate: SQL | ((effectiveDate: string) => SQL),
  remedy: string,
): AccountReferenceRule => ({ label, disposition: "history", blockWhere: { predicate, remedy } });

const bookMapping = (label: string) =>
  retained(
    label,
    (effectiveDate) => sql`r.effective_to is null or r.effective_to >= ${effectiveDate}::date`,
    "End the book account mapping before the merge date and add a new dated mapping using the surviving account. Existing mappings keep their recorded accounts.",
  );

const periodEndPolicy = (label: string) =>
  retained(
    label,
    (effectiveDate) => sql`not exists (select 1 from period_end_journal_policies p
    where p.org_id = r.org_id and p.effective_from > r.effective_from and p.effective_from <= ${effectiveDate}::date)`,
    "Add a period-end journal policy using the surviving account, effective on or before the merge date. Earlier policy versions remain unchanged.",
  );

const equityAccountPolicy = (label: string) =>
  retained(
    label,
    (effectiveDate) => sql`not exists (select 1 from equity_account_policies p
    where p.org_id = r.org_id and p.subsidiary_id = r.subsidiary_id
      and p.effective_from > r.effective_from and p.effective_from <= ${effectiveDate}::date)`,
    "Add an equity account policy using the surviving account, effective on or before the merge date (Setup → Equity accounts). Earlier policy versions remain unchanged.",
  );

const activeAmortization = (label: string) =>
  retained(
    label,
    sql`r.status in ('draft', 'active', 'on_hold')`,
    "Complete or cancel the amortization schedules before merging their accounts. Schedules and release plans keep their recorded accounts.",
  );

const capitalizedAsset = sql`exists (select 1 from asset_proposal_allocations a
  join asset_proposal_acceptances p on p.org_id = a.org_id and p.id = a.acceptance_id
  where a.org_id = r.org_id and a.asset_id = r.id and a.cip_cost_id is null and p.status = 'posted')
  or exists (select 1 from asset_cip_capitalization_lines l
  join asset_cip_capitalizations c on c.org_id = l.org_id and c.id = l.capitalization_id
  where l.org_id = r.org_id and l.asset_id = r.id and c.status = 'posted')`;

const allocationVersionStatus = (statuses: string[], direct: boolean) =>
  direct
    ? sql`r.status in ${statuses}`
    : sql`exists (select 1 from allocation_rule_versions v where v.org_id = r.org_id and v.id = r.version_id and v.status in ${statuses})`;

const ALLOCATION_PUBLISHED_REMEDY =
  "Draft a new version of the allocation rule that uses the surviving account, publish it, and retire the current version before merging.";

/** Rules for every known `table.column` foreign key to accounts. */
export const ACCOUNT_REFERENCE_RULES: Readonly<Record<string, AccountReferenceRule>> = {
  // Dated policies and source evidence retain their original account identity.
  "accounting_book_account_maps.source_account_id": bookMapping("Book account mappings (source)"),
  "accounting_book_account_maps.target_account_id": bookMapping("Book account mappings (target)"),
  "accounting_books.currency_difference_account_id": retained(
    "Book currency difference accounts",
    sql`true`,
    "Change the book currency difference account through its replication settings before merging the account.",
  ),
  "period_end_journal_policies.retained_earnings_account_id": periodEndPolicy(
    "Period-end retained earnings policies",
  ),
  "period_end_journal_policies.income_summary_account_id": periodEndPolicy(
    "Period-end income summary policies",
  ),
  "intercompany_transfer_pricing_policies.revenue_account_id": retained(
    "Transfer pricing revenue policies",
    sql`r.is_active`,
    "End and deactivate the transfer pricing policy and create a new dated policy using the surviving account before merging.",
  ),
  "intercompany_transfer_pricing_policies.cost_account_id": retained(
    "Transfer pricing cost policies",
    sql`r.is_active`,
    "End and deactivate the transfer pricing policy and create a new dated policy using the surviving account before merging.",
  ),
  "expense_amortization_templates.deferral_account_id": retained(
    "Amortization template deferrals",
    sql`r.is_active`,
    "Deactivate the amortization template and add a new dated version using the surviving account before merging.",
  ),
  "expense_amortization_templates.destination_account_id": retained(
    "Amortization template expenses",
    sql`r.is_active`,
    "Deactivate the amortization template and add a new dated version using the surviving account before merging.",
  ),
  "expense_amortization_schedules.deferral_account_id": activeAmortization(
    "Amortization schedule deferrals",
  ),
  "expense_amortization_schedules.destination_account_id": activeAmortization(
    "Amortization schedule expenses",
  ),
  "expense_amortization_schedule_lines.destination_account_id": retained(
    "Amortization release plans",
    sql`r.status = 'planned' and exists (select 1 from expense_amortization_schedules s
      where s.org_id = r.org_id and s.id = r.schedule_id and s.status in ('draft', 'active', 'on_hold'))`,
    "Complete or cancel the amortization schedules before merging their release accounts. Existing release plans remain unchanged.",
  ),
  "asset_capitalization_rules.account_id": retained(
    "Asset capitalization rules",
    sql`r.is_active`,
    "End and deactivate the capitalization rule and add a new dated rule using the surviving account before merging.",
  ),
  "asset_proposals.account_id": retained(
    "Asset proposal source accounts",
    sql`r.status = 'pending'`,
    "Accept or reject the pending asset proposals before merging their source account.",
  ),
  "asset_cip_costs.account_id": history("Construction source costs"),
  "asset_cip_capitalization_lines.target_account_id": history(
    "Construction capitalization accounts",
  ),
  "asset_proposal_allocations.target_account_id": history("Asset proposal allocation accounts"),
  "intercompany_netting_lines.account_id": retained(
    "Intercompany netting accounts",
    sql`exists (select 1 from intercompany_netting_runs n where n.org_id = r.org_id and n.id = r.run_id
      and n.status in ('proposed', 'pending_approval', 'approved'))`,
    "Post or cancel the intercompany netting run before merging the account. To change its accounts, cancel it and propose a new run.",
  ),
  "intercompany_fund_transfers.from_bank_account_id": history(
    "Intercompany fund transfers (source bank)",
  ),
  "intercompany_fund_transfers.to_bank_account_id": history(
    "Intercompany fund transfers (destination bank)",
  ),

  // Documents: drafts move; in-flight approvals block; posted and voided documents are history.
  "document_lines.account_id": draftDocumentRule("Document lines", "document_id"),
  "document_lines.recovery_account_id": draftDocumentRule(
    "Document line recovery accounts",
    "document_id",
  ),
  "document_line_tax_components.collected_account_id": draftDocumentRule(
    "Document tax components (collected)",
    "document_line_id",
  ),
  "document_line_tax_components.paid_account_id": draftDocumentRule(
    "Document tax components (paid)",
    "document_line_id",
  ),
  "document_line_tax_components.withholding_account_id": draftDocumentRule(
    "Document tax components (withholding)",
    "document_line_id",
  ),
  "document_tenders.account_id": draftDocumentRule("Cash sale tenders", "document_id"),

  // Allocation rules: draft versions move; a published version blocks; retired versions are history.
  "allocation_rule_versions.offset_account_id": {
    label: "Allocation rule offsets",
    disposition: "redirect",
    redirectWhere: allocationVersionStatus(["draft"], true),
    blockWhere: {
      predicate: allocationVersionStatus(["published"], true),
      remedy: ALLOCATION_PUBLISHED_REMEDY,
    },
  },
  "allocation_rule_targets.target_account_id": {
    label: "Allocation rule targets",
    disposition: "redirect",
    redirectWhere: allocationVersionStatus(["draft"], false),
    blockWhere: {
      predicate: allocationVersionStatus(["published"], false),
      remedy: ALLOCATION_PUBLISHED_REMEDY,
    },
  },

  // Open subledger records move; settled ones are history.
  "encumbrances.account_id": {
    label: "Encumbrances",
    disposition: "redirect",
    redirectWhere: sql`r.status = 'open'`,
  },
  "fixed_assets.asset_account_id": {
    label: "Fixed assets (asset)",
    disposition: "redirect",
    redirectWhere: sql`r.status in ('draft', 'in_service', 'fully_depreciated') and not (${capitalizedAsset})`,
    blockWhere: {
      predicate: sql`(r.status = 'construction' and r.acquisition_cost <> 0)
        or (r.status in ('draft', 'in_service', 'fully_depreciated') and (${capitalizedAsset}))`,
      remedy:
        "Capitalize or unlink outstanding construction costs first. For assets created from posted costs, reverse the acceptance or capitalization while still in draft, or complete their native disposal before merging the asset account.",
    },
  },
  "fixed_assets.accumulated_depreciation_account_id": {
    label: "Fixed assets (accumulated depreciation)",
    disposition: "redirect",
    redirectWhere: sql`r.status in ('draft', 'in_service', 'fully_depreciated')`,
  },
  "fixed_assets.depreciation_expense_account_id": {
    label: "Fixed assets (depreciation expense)",
    disposition: "redirect",
    redirectWhere: sql`r.status in ('draft', 'in_service', 'fully_depreciated')`,
  },
  "lease_agreements.cost_clearing_account_id": {
    label: "Lease agreements",
    disposition: "redirect",
    redirectWhere: sql`r.status in ('draft', 'active')`,
  },
  "change_orders.income_account_id": {
    label: "Change orders",
    disposition: "redirect",
    redirectWhere: sql`r.status in ('draft', 'approved')`,
  },
  "fund_releases.release_account_id": {
    label: "Fund releases",
    disposition: "redirect",
    redirectWhere: sql`r.status = 'draft'`,
    blockWhere: {
      predicate: sql`r.status = 'pending_approval'`,
      remedy: "Decide the pending fund releases before merging the account.",
    },
  },
  "payment_runs.bank_account_id": {
    label: "Payment runs",
    disposition: "redirect",
    redirectWhere: sql`r.status = 'draft'`,
    blockWhere: {
      predicate: sql`r.status in ('pending_approval', 'approved', 'processing', 'generated', 'delivered', 'partially_failed')`,
      remedy: "Complete or cancel the payment runs in progress before merging the bank account.",
    },
  },
  "payment_links.bank_account_id": {
    label: "Payment links",
    disposition: "redirect",
    redirectWhere: sql`r.status = 'active'`,
  },
  "reconciliations.account_id": {
    label: "Bank reconciliations",
    disposition: "history",
    blockWhere: {
      predicate: sql`r.status <> 'signed_off'`,
      remedy:
        "Finish and sign off, or discard, the open reconciliation of the source account before merging.",
    },
  },

  // Approved commercial terms keep their account identity. Accrued obligations
  // must be settled or reversed before the referenced account can be merged.
  ...Object.fromEntries(
    ["accrual_account_id", "offset_account_id", "fx_account_id"].map((column) => [
      `rebate_agreements.${column}`,
      {
        label: "Rebate agreement accounts",
        disposition: "history" as const,
        blockWhere: {
          predicate: sql`exists(select 1 from rebate_claims claim where claim.org_id=r.org_id and claim.agreement_id=r.id and claim.status in ('draft','approved','document_pending'))
        or exists(select 1 from rebate_accruals fact where fact.org_id=r.org_id and fact.agreement_id=r.id group by fact.party_id
          having sum(fact.amount)<>coalesce((select sum(claim.amount) from rebate_claims claim where claim.org_id=r.org_id and claim.agreement_id=r.id and claim.party_id=fact.party_id and claim.status='settled'),0))`,
          remedy:
            "Generate and settle the remaining rebate claims, or reverse their settlements, before merging the agreement account. Create future agreements using the surviving account.",
        },
      },
    ]),
  ),
  "account_translation_policies.account_id": history("Account translation policy history"),
  "segment_balancing_policies.clearing_account_id": {
    label: "Segment balancing policies",
    disposition: "history",
    blockWhere: {
      predicate: (effectiveDate) =>
        sql`not exists(select 1 from segment_balancing_policies successor where successor.org_id=r.org_id and successor.segment_key=r.segment_key and successor.effective_from>r.effective_from and successor.effective_from<=${effectiveDate}::date)`,
      remedy:
        "Record a successor balancing policy using the surviving account, effective on or before the merge date. Earlier policy versions remain unchanged.",
    },
  },

  // Posted and imported facts.
  "pay_stub_lines.expense_account_id": history("Pay stub lines (expense)"),
  "pay_stub_lines.liability_account_id": history("Pay stub lines (liability)"),
  "pay_stub_lines.non_cash_account_id": history("Pay stub lines (non-cash)"),
  "bank_statements.account_id": history("Bank statements"),
  "bank_statement_lines.account_id": history("Bank statement lines"),
  "source_reconciliation_state.account_id": history("Source reconciliation evidence"),
  "security_deposit_transactions.bank_account_id": history("Security deposit transactions (bank)"),
  "security_deposit_transactions.offset_account_id": history(
    "Security deposit transactions (offset)",
  ),
  "psp_settlement_batches.bank_account_id": history("Payment processor settlements (bank)"),
  "psp_settlement_batches.fee_account_id": history("Payment processor settlements (fees)"),
  "psp_settlement_batches.dispute_account_id": history("Payment processor settlements (disputes)"),
  "psp_settlement_batches.fx_account_id": history("Payment processor settlements (FX)"),
  "psp_settlement_batches.clearing_account_id": history("Payment processor settlements (clearing)"),
  "mfg_subcontract_service_bills.wip_account_id": history("Subcontract service bills"),

  // Configuration that drives future postings.
  "allocation_rules.offset_account_id": config("Allocation rules (offset)"),
  "asset_categories.asset_account_id": config("Asset categories (asset)"),
  "asset_categories.accumulated_depreciation_account_id": config(
    "Asset categories (accumulated depreciation)",
  ),
  "asset_categories.depreciation_expense_account_id": config(
    "Asset categories (depreciation expense)",
  ),
  "asset_categories.gain_loss_account_id": config("Asset categories (gain or loss)"),
  "budget_lines.account_id": config("Budget lines"),
  "customer_roles.ar_account_id": config("Customer receivable accounts"),
  "vendor_roles.ap_account_id": config("Vendor payable accounts"),
  "vendor_roles.default_expense_account_id": config("Vendor default expense accounts"),
  "employee_roles.expense_account_id": config("Employee expense accounts"),
  "entitlement_plans.liability_account_id": config("Entitlement plans"),
  "fund_pairs.due_from_account_id": config("Interfund pairs (due from)"),
  "fund_pairs.due_to_account_id": config("Interfund pairs (due to)"),
  "intercompany_pairs.due_from_account_id": config("Intercompany pairs (due from)"),
  "intercompany_pairs.due_to_account_id": config("Intercompany pairs (due to)"),
  "intercompany_pairs.from_receivable_account_id": config("Intercompany pairs (source receivable)"),
  "intercompany_pairs.from_payable_account_id": config("Intercompany pairs (source payable)"),
  "intercompany_pairs.to_receivable_account_id": config(
    "Intercompany pairs (destination receivable)",
  ),
  "intercompany_pairs.to_payable_account_id": config("Intercompany pairs (destination payable)"),
  "hrm_benefit_program_sources.account_id": config("Benefit program source accounts"),
  "information_return_box_rules.account_id": config("Information return box rules"),
  "item_inventory_profiles.adjustment_account_id": config("Item inventory profiles (adjustment)"),
  "item_inventory_profiles.asset_account_id": config("Item inventory profiles (asset)"),
  "item_inventory_profiles.cogs_account_id": config("Item inventory profiles (cost of goods sold)"),
  "item_inventory_profiles.received_not_billed_account_id": config(
    "Item inventory profiles (received not billed)",
  ),
  "item_inventory_profiles.variance_account_id": config("Item inventory profiles (variance)"),
  "items.cost_recovery_account_id": config("Items (cost recovery)"),
  "items.deferred_account_id": config("Items (deferred revenue)"),
  "items.expense_account_id": config("Items (expense)"),
  "items.income_account_id": config("Items (income)"),
  "items.payroll_expense_account_id": config("Items (payroll expense)"),
  "lease_charges.income_account_id": config("Lease charges"),
  "managed_properties.default_bank_account_id": config("Managed properties (bank)"),
  "managed_properties.cam_income_account_id": config("Managed properties (CAM income)"),
  "managed_properties.deposit_liability_account_id": config(
    "Managed properties (deposit liability)",
  ),
  "managed_properties.rent_income_account_id": config("Managed properties (rent income)"),
  "pay_components.expense_account_id": config("Pay components (expense)"),
  "pay_components.liability_account_id": config("Pay components (liability)"),
  "pay_components.non_cash_account_id": config("Pay components (non-cash)"),
  "pay_component_department_expenses.expense_account_id": config(
    "Pay component department expense accounts",
  ),
  "payment_bank_profiles.bank_account_id": config("Payment bank profiles"),
  "payment_cards.liability_account_id": config("Payment cards"),
  "payment_surcharge_rules.fee_income_account_id": config("Payment surcharge rules"),
  "performance_obligations.deferred_account_id": config("Performance obligations (deferred)"),
  "performance_obligations.recognized_account_id": config("Performance obligations (recognized)"),
  "provision_obligations.expense_account_id": config("Provisions (expense)"),
  "provision_obligations.liability_account_id": config("Provisions (liability)"),
  "psp_provider_configs.default_bank_account_id": config("Payment processor settings (bank)"),
  "recognition_rules.deferred_account_id": config("Revenue recognition rules (deferred)"),
  "recognition_rules.recognized_account_id": config("Revenue recognition rules (recognized)"),
  "sftp_import_schedules.account_id": config("Statement import schedules"),
  "bank_feed_connections.account_id": config("Bank feed connections"),
  "subcontract_sov_lines.expense_account_id": config("Subcontract schedule of values"),
  "subscription_components.income_account_id": config("Subscription components"),
  "subscription_plan_version_components.income_account_id": config("Subscription plan components"),
  "subsidiary_ownership_interests.distribution_income_account_id": config(
    "Ownership interests (distribution income)",
  ),
  "subsidiary_ownership_interests.fair_value_adjustment_account_id": config(
    "Ownership interests (fair value adjustment)",
  ),
  "subsidiary_ownership_interests.distribution_account_id": config(
    "Ownership interests (distributions)",
  ),
  "subsidiary_ownership_interests.equity_income_account_id": config(
    "Ownership interests (equity income)",
  ),
  "subsidiary_ownership_interests.goodwill_account_id": config("Ownership interests (goodwill)"),
  "subsidiary_ownership_interests.investment_account_id": config(
    "Ownership interests (investment)",
  ),
  "subsidiary_ownership_interests.nci_equity_account_id": config(
    "Ownership interests (NCI equity)",
  ),
  "subsidiary_ownership_interests.nci_income_account_id": config(
    "Ownership interests (NCI income)",
  ),
  "tax_codes.collected_account_id": config("Tax codes (collected)"),
  "tax_codes.paid_account_id": config("Tax codes (paid)"),
  "tax_codes.withholding_account_id": config("Tax codes (withholding)"),
  "prebill_lines.income_account_id": retained(
    "Pre-bill lines",
    sql`exists (
    select 1 from prebills p where p.org_id = r.org_id and p.id = r.prebill_id
      and p.status in ('draft', 'review', 'approved', 'customer_review'))`,
    "Convert the prebill to an invoice, or void it and create a new prebill after correcting the source income account. Prebill pricing and accounting snapshots remain unchanged.",
  ),
  "promotions.discount_account_id": config("Promotions"),
  "restocking_fee_policies.income_account_id": config("Restocking fee policies"),
  "sales_channel_account_maps.account_id": config("Sales channel account maps"),
  "equity_account_policies.common_stock_account_id": equityAccountPolicy(
    "Equity account policies (common stock)",
  ),
  "equity_account_policies.preferred_stock_account_id": equityAccountPolicy(
    "Equity account policies (preferred stock)",
  ),
  "equity_account_policies.apic_account_id": equityAccountPolicy(
    "Equity account policies (additional paid-in capital)",
  ),
  "equity_account_policies.apic_share_based_account_id": equityAccountPolicy(
    "Equity account policies (paid-in capital, share-based payments)",
  ),
  "equity_account_policies.compensation_expense_account_id": equityAccountPolicy(
    "Equity account policies (stock compensation expense)",
  ),
  "equity_account_policies.treasury_stock_account_id": equityAccountPolicy(
    "Equity account policies (treasury stock)",
  ),
  "equity_account_policies.convertible_instruments_account_id": equityAccountPolicy(
    "Equity account policies (convertible instruments)",
  ),
  "equity_account_policies.interest_expense_account_id": equityAccountPolicy(
    "Equity account policies (convertible note interest expense)",
  ),
  "equity_account_policies.accrued_interest_account_id": equityAccountPolicy(
    "Equity account policies (accrued convertible note interest)",
  ),
  "equity_account_policies.early_exercise_deposit_account_id": equityAccountPolicy(
    "Equity account policies (early-exercise deposits)",
  ),
  "equity_securities.consideration_account_id": history("Equity issuance consideration"),
  "equity_security_events.consideration_account_id": history("Equity event consideration"),
  "stored_value_programs.liability_account_id": config("Stored value programs (liability)"),
  "stored_value_programs.breakage_income_account_id": config("Stored value programs (breakage)"),
  "stored_value_accounts.liability_account_id": config("Stored value accounts"),
  "contract_cost_policies.asset_account_id": config("Contract cost policies (asset)"),
  "contract_cost_policies.amortization_expense_account_id": config(
    "Contract cost policies (amortization)",
  ),
  "shipping_settings.shipping_expense_account_id": config("Shipping settings (expense)"),
  "shipping_settings.carrier_payable_account_id": config("Shipping settings (carrier payable)"),
  "marketplace_facilitators.clearing_account_id": config("Marketplace facilitators"),
  "internal_billing_rules.debit_account_id": config("Internal billing rules (debit)"),
  "internal_billing_rules.credit_account_id": config("Internal billing rules (credit)"),
  "project_revenue_accruals.unbilled_account_id": config("Project revenue accruals (unbilled)"),
  "project_revenue_accruals.revenue_account_id": config("Project revenue accruals (revenue)"),
  "withholding_enrollments.liability_account_id": config("Contractor withholding enrollments"),
  "mfg_subcontract_service.wip_account_id": config("Subcontract service work in process"),
  "pos_registers.cash_account_id": config("Point-of-sale registers (cash)"),
  "pos_registers.card_account_id": config("Point-of-sale registers (card)"),
  "pos_registers.other_account_id": config("Point-of-sale registers (other tenders)"),
  "pos_cash_reasons.account_id": config("Point-of-sale cash reasons"),
  // An open shortfall trues up to the account it was charged to when stock arrives.
  "inventory_provisional_costs.offset_account_id": retained(
    "Inventory provisional costs (offset)",
    sql`r.remaining_quantity > 0`,
    "Receive the short stock to settle its provisional cost before merging the account. Settled shortfalls keep their recorded account.",
  ),
  "historical_translation_contributions.account_id": history(
    "Historical translation contributions",
  ),
  "fx_revaluation_rate_evidence.account_id": history("Revaluation closing rate evidence"),
  "expense_receipt_captures.confirmed_account_id": history("Confirmed receipt captures"),
};

/**
 * Columns the merge owns itself rather than through a rule: the chart's own
 * hierarchy and merge links, the merge record, localizations kept for the
 * source's historical presentation, and journal lines (balances move by
 * reclass; drafts move explicitly).
 */
export const ACCOUNT_REFERENCE_OWNED: ReadonlySet<string> = new Set([
  "accounts.parent_id",
  "accounts.merged_into_id",
  "account_merges.source_account_id",
  "account_merges.target_account_id",
  "account_localizations.account_id",
  "journal_lines.account_id",
]);

/**
 * JSON configuration that names accounts by id: control-account roles,
 * saved report and list filters, bank and capture rules. A match is an exact
 * JSON string value equal to the account id, so only genuine references move.
 * `scope` restricts the rows considered (alias `r`).
 */
export interface AccountJsonReference {
  key: string;
  label: string;
  table: string;
  column: string;
  /** Row filter beyond the organization (alias `r`). */
  scope?: SQL;
  /** Column holding the organization id; `id` for the organization row itself. */
  orgColumn: "org_id" | "id";
  /** Nested key holding the references; the whole column when omitted. */
  path?: string;
  /** Rows matching this predicate block the merge with this remedy. */
  blockWhere?: { predicate: SQL; remedy: string };
}

export const ACCOUNT_JSON_REFERENCES: readonly AccountJsonReference[] = [
  {
    key: "orgs.settings.controlAccounts",
    label: "Company control accounts",
    table: "orgs",
    column: "settings",
    orgColumn: "id",
    path: "controlAccounts",
  },
  {
    key: "subsidiaries.control_accounts",
    label: "Subsidiary control accounts",
    table: "subsidiaries",
    column: "control_accounts",
    orgColumn: "org_id",
  },
  {
    key: "saved_reports.params",
    label: "Saved report filters",
    table: "saved_reports",
    column: "params",
    orgColumn: "org_id",
  },
  {
    key: "saved_views.query",
    label: "Saved list views",
    table: "saved_views",
    column: "query",
    orgColumn: "org_id",
  },
  {
    key: "bank_match_rules.outcome",
    label: "Bank matching rules",
    table: "bank_match_rules",
    column: "outcome",
    orgColumn: "org_id",
  },
  {
    key: "ap_capture_rules.output",
    label: "Bill capture rules",
    table: "ap_capture_rules",
    column: "output",
    orgColumn: "org_id",
  },
  {
    key: "cam_pools.expense_account_ids",
    label: "CAM expense pools",
    table: "cam_pools",
    column: "expense_account_ids",
    orgColumn: "org_id",
    scope: sql`r.status in ('draft', 'open')`,
    blockWhere: {
      predicate: sql`r.status in ('finalized', 'invoiced')`,
      remedy:
        "Keep the finalized or invoiced pool as historical evidence and use a new editable CAM pool with the surviving account for future allocations.",
    },
  },
  {
    key: "allocation_rule_versions.account_scope",
    label: "Allocation rule account scopes",
    table: "allocation_rule_versions",
    column: "account_scope",
    orgColumn: "org_id",
    scope: sql`r.status in ('draft', 'published')`,
    blockWhere: { predicate: sql`r.status = 'published'`, remedy: ALLOCATION_PUBLISHED_REMEDY },
  },
];

/** One foreign-key column referencing accounts, as found in the live catalog. */
export interface AccountReferenceColumn {
  table: string;
  column: string;
}

/**
 * Every single-account foreign key column into `accounts` in the public
 * schema, excluding the organization half of composite keys.
 */
export async function discoverAccountReferenceColumns(
  executor: SqlExecutor,
): Promise<AccountReferenceColumn[]> {
  const rows = await executor.execute<{ table_name: string; column_name: string }>(
    sql`
    select distinct cls.relname::text as table_name, a.attname::text as column_name
      from pg_constraint c
      join pg_class cls on cls.oid = c.conrelid
      join pg_namespace n on n.oid = cls.relnamespace and n.nspname = 'public'
      join lateral unnest(c.conkey) as k(attnum) on true
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
     where c.contype = 'f'
       and c.confrelid = 'public.accounts'::regclass
       and a.attname <> 'org_id'
       -- The merge writes redirected references; a generated column is computed, never written.
       and a.attgenerated = ''
     order by 1, 2`,
    "objects",
  );
  return rows.map((row) => ({ table: row.table_name, column: row.column_name }));
}

/** The classification of a discovered column: a rule, merge-owned, or unclassified. */
export function classifyAccountReference(
  column: AccountReferenceColumn,
): AccountReferenceRule | "owned" | null {
  const key = `${column.table}.${column.column}`;
  if (ACCOUNT_REFERENCE_OWNED.has(key)) return "owned";
  return ACCOUNT_REFERENCE_RULES[key] ?? null;
}
