import { FEATURES } from "../organization/feature-registry.ts";
import { sampleCompanyFeatures } from "./features.ts";

export interface DemoFeatureEvidence {
  mode: "workflow" | "configuration" | "workspace" | "unsupported";
  tables: readonly string[];
  stage: "draft" | "configured" | "executed" | "workspace" | "unsupported";
  limitation?: string;
}
const workflow = (...tables: string[]): DemoFeatureEvidence => ({
  mode: "workflow",
  stage: "draft",
  tables,
});
const executed = (...tables: string[]): DemoFeatureEvidence => ({
  mode: "workflow",
  stage: "executed",
  tables,
});
const configuration = (...tables: string[]): DemoFeatureEvidence => ({
  mode: "configuration",
  stage: "configured",
  tables,
});
const workspace = (...tables: string[]): DemoFeatureEvidence => ({
  mode: "workspace",
  stage: "workspace",
  tables,
});

/** Coverage is explicit so a newly shipped switch cannot disappear from demos. */
export const DEMO_FEATURE_EVIDENCE: Record<string, DemoFeatureEvidence> = {
  einvoicing: {
    ...configuration("einvoice_settings"),
    limitation:
      "Synthetic seller address and profile; real registration, exemption treatment and payment instructions must be reviewed before issuance.",
  },
  contractorWithholding: {
    ...workspace("compliance_requirements", "compliance_records"),
    limitation:
      "The demonstration legal entity is US-based. Review subcontractor evidence here; UK CIS, Irish RCT and German withholding require an applicable legal entity and verified registrations before native calculation. No invented enrollment or statutory standing is installed.",
  },
  internalBilling: configuration("internal_billing_rules"),
  crossBorderTax: {
    ...executed("document_supply_evidence"),
    limitation:
      "Synthetic location evidence illustrates tax determination; it does not establish registration, VAT-ID validity or eligibility for a statutory scheme.",
  },
  salesManagement: configuration("crm_sales_teams", "crm_sales_quotas"),
  geographicTerritories: configuration("crm_sales_territories"),
  promotions: configuration("promotions"),
  cashSales: executed("documents", "document_tenders"),
  storedValue: configuration("stored_value_programs"),
  salesChannels: {
    ...configuration("sales_channels"),
    limitation:
      "Draft storefront configuration without credentials; no remote synchronization is activated.",
  },
  quoteToCash: configuration("quote_to_cash_settings", "quote_subscription_terms"),
  consolidatedBilling: configuration("consolidation_groups", "customer_billing_relationships"),
  billingHistoryImport: {
    ...configuration("billing_import_runs"),
    limitation: "Draft historical-import mapping; no remote billing account is accessed.",
  },
  autopay: {
    ...configuration("autopay_enrollments"),
    limitation:
      "Paused enrollment without a payment method; reviewed consent and provider credentials are required before collection.",
  },
  customerPortal: {
    ...configuration("customer_portal_settings"),
    limitation: "Native portal content is configured; no login link is sent.",
  },
  revenueContracts: workflow("revenue_contracts"),
  contractCosts: configuration("contract_cost_policies"),
  consignment: executed("consignment_stock", "consignment_events"),
  itemVariants: configuration("item_families", "item_family_options"),
  shippingHub: {
    ...configuration("package_presets"),
    limitation:
      "Package dimensions are ready for rate comparison; carrier credentials must be configured before purchasing a label.",
  },
  demandPlanning: configuration("demand_item_policies"),
  projectProgress: executed("projects", "project_tasks", "project_progress_entries"),
  unbilledRevenueAccrual: {
    ...workspace("projects", "time_entries"),
    limitation:
      "Draft work is ready for review; only approved eligible work can be accrued through the native revenue workflow.",
  },
  hrmTraining: configuration("hrm_training_courses"),
  hrmShiftPlanning: configuration("schedule_boards", "schedule_patterns"),
  hrmAttendance: configuration("schedule_attendance_devices"),
  hrmShiftClosing: {
    ...configuration("schedule_patterns", "schedule_attendance_devices"),
    limitation:
      "A staged shift roster board with an inactive pattern and a disconnected attendance device. Assign the pattern, publish reviewed shifts and import synthetic check-ins through the native workflow before closing a shift.",
  },
  compensationPackages: configuration("payroll_compensation_packages"),
  outboundWebhooks: {
    ...configuration("webhook_endpoints"),
    limitation:
      "Disabled endpoint with no subscribed events. Configure a reachable endpoint and rotate its secret through native setup before activation.",
  },

  crm: workflow("crm_opportunities"),
  orders: workflow("documents"),
  revenueRecognition: configuration("recognition_rules"),
  subscriptionBilling: workflow("subscriptions"),
  advancedSubscriptions: configuration("subscription_plan_versions"),
  usageBilling: executed("usage_records"),
  saasMetrics: executed("saas_metrics_facts_monthly"),
  onlinePayments: {
    ...configuration("psp_provider_configs"),
    limitation: "Payment credentials must be configured; no real charges are made.",
  },
  projects: workflow("projects"),
  timeTracking: workflow("time_entries"),
  fieldTime: configuration("time_kiosks"),
  fieldTickets: workflow("field_tickets"),
  projectScheduling: workflow("project_tasks", "schedule_calendars"),
  subcontracts: workflow("subcontracts", "subcontract_sov_lines"),
  preBilling: workflow("prebills"),
  resourcing: workflow("res_demand_lines"),
  resourceRequests: workflow("res_requests"),
  retainerBilling: workflow("res_retainers"),
  payroll: {
    ...configuration("pay_schedules", "employee_payroll_profiles", "pay_components", "pay_runs"),
    limitation:
      "US pack installed. Employer registrations, employee pay terms, and statutory inputs must be reviewed before calculation.",
  },
  hrm: workflow("worker_employments", "worker_employment_versions"),
  hrmCompensation: configuration("hrm_pay_bands"),
  hrmPerformance: workflow("hrm_review_cycles", "hrm_goals"),
  hrmDocuments: configuration("hrm_document_templates"),
  hrmCertifications: workflow("hrm_worker_qualifications"),
  hrmSurveys: configuration("hrm_surveys", "hrm_survey_questions"),
  hrmRecruiting: workflow("hrm_requisitions"),
  hrmConstructionCompliance: configuration("hrm_rate_schedules", "hrm_rate_schedule_lines"),
  propertyManagement: workflow(
    "managed_properties",
    "property_units",
    "property_leases",
    "lease_schedule_lines",
    "cam_pools",
  ),
  subcontractorCompliance: workflow("compliance_records"),
  informationReturns: {
    ...workflow("information_return_filings"),
    limitation:
      "Draft filing workspace; recipient TINs, box rules and filing thresholds must be reviewed before computing a return.",
  },
  inventory: executed("item_inventory_profiles", "inventory_movements", "cost_layers"),
  warehousing: workflow("warehouses", "stock_locations"),
  fulfillment: workflow("fulfillment_documents", "fulfillment_lines"),
  dropShipping: workflow("drop_ship_orders", "drop_ship_lines"),
  returnAuthorizations: executed("rma_documents", "rma_lines"),
  customerPartNumbers: configuration("customer_item_refs"),
  barcodeScanning: configuration("item_identifiers"),
  manufacturing: workflow("bom_components", "mfg_routings", "mfg_work_orders"),
  manufacturingMrp: configuration("mfg_item_policies", "mfg_mrp_runs"),
  equipment: workflow("equipment_units"),
  expenses: workflow("documents"),
  multiSubsidiary: configuration("subsidiaries"),
  multiCurrency: configuration("fx_rates"),
  intercompanyTransactions: {
    ...workspace("subsidiaries"),
    limitation:
      "The demonstration company operates one legal entity; designate representing customers and vendors once a second subsidiary and its intercompany pair exist.",
  },
  intercompanyNetting: {
    ...workspace("subsidiaries"),
    limitation:
      "No intercompany balances exist in the demonstration company, so the netting workspace starts empty.",
  },
  banking: executed("bank_statements", "bank_statement_lines", "reconciliations"),
  bankFeeds: {
    ...configuration("bank_feed_connections"),
    limitation: "Disconnected synthetic feed; bank authentication requires configuration.",
  },
  fixedAssets: workflow("asset_categories", "fixed_assets"),
  budgets: workflow("budget_scenarios", "budget_lines"),
  assetComponents: {
    ...workspace("fixed_assets"),
    limitation:
      "Compound assets are available on the seeded register; attach components from the asset drawer.",
  },
  assetProposals: {
    ...workspace("fixed_assets"),
    limitation:
      "No capitalization rule is seeded; add one in Setup before posted purchases generate proposals.",
  },
  constructionInProgress: {
    ...workspace("fixed_assets"),
    limitation:
      "No construction-in-progress record is seeded; create one against a construction-in-progress account before linking costs.",
  },
  assetMaintenance: {
    ...workspace("fixed_assets"),
    limitation: "No maintenance schedule is seeded; add schedules from the maintenance workspace.",
  },
  assetInsurance: {
    ...workspace("fixed_assets"),
    limitation:
      "No insurance policy is seeded; record policies with a real insurer before relying on renewal alerts.",
  },
  continuousClose: workspace("journal_entries"),
  advancedClose: configuration("close_blueprints", "close_blueprint_steps"),
  allocations: configuration(
    "allocation_rules",
    "allocation_rule_versions",
    "allocation_rule_targets",
  ),
  allocationsAtEntry: configuration("allocation_rules"),
  allocationsAtPosting: configuration("allocation_rules"),
  nonprofit: configuration("nonprofit_frameworks"),
  fundAccounting: configuration("segment_definitions", "funds"),
  grantManagement: workflow("grants"),
  pledges: workflow("pledges", "pledge_installments"),
  encumbrances: workflow("encumbrances"),
  functionalExpenses: configuration("functional_mappings"),
  form990: configuration("nonprofit_frameworks", "functional_mappings"),
  flows: configuration("flows"),
  automations: configuration("automations"),
  automationDateTriggers: configuration("automations"),
  automationFieldTriggers: {
    mode: "unsupported",
    stage: "unsupported",
    tables: ["automations"],
    limitation:
      "Field-change recipes can be drafted, but event-trigger execution is not supported by the current automation engine.",
  },
  automationWebhooks: {
    mode: "unsupported",
    stage: "unsupported",
    tables: ["automations"],
    limitation:
      "Outbound webhook delivery is not supported by the current automation engine; this recipe remains a draft.",
  },
  automationSimulator: workspace("automations"),
  apps: configuration("apps", "app_versions", "app_files"),
  scripts: configuration("user_scripts"),
  apiAccess: configuration("api_keys"),
  mcpAccess: configuration("api_keys"),
  queryConsole: workspace("journal_entries"),
  homeAnnouncements: workspace(),
  aiGovernanceLedger: configuration("ai_capabilities"),
  accountMerges: {
    ...workspace("accounts"),
    limitation:
      "No accounts are merged in the demonstration; preview a merge from an account to see its consequences before executing one.",
  },
  accountingContexts: {
    ...workspace("accounts"),
    limitation:
      "No statutory context is installed; create a context and its localized account numbers before running reports under it.",
  },
  segmentDependencies: {
    ...workspace("segment_definitions"),
    limitation:
      "No dependency rules are installed; segment values remain freely combinable until a rule is created.",
  },
  posRegister: {
    ...configuration("pos_registers"),
    limitation:
      "Open a drawer session with a counted float before ringing up sales; card tenders settle to a clearing account until a card processor is configured.",
  },
  multiBookAccounting: {
    ...configuration("accounting_book_currencies"),
    limitation:
      "The income tax basis book takes book-specific adjustments only; record its adjusting journals and account mappings before reporting from it.",
  },
  expenseAmortization: executed(
    "expense_amortization_templates",
    "expense_amortization_schedules",
    "expense_amortization_schedule_lines",
  ),
  expenseAmortizationAutoRun: {
    ...configuration("expense_amortization_schedules"),
    limitation:
      "Active schedules post their due amortization automatically each period; review a schedule before relying on automatic runs.",
  },
  rebateManagement: {
    ...configuration("rebate_agreements"),
    limitation:
      "Draft supplier and customer agreements; submit each through tenant Flows before posted purchases and sales accrue rebates.",
  },
  serviceDispatch: {
    ...executed(
      "service_requests",
      "service_quotes",
      "service_jobs",
      "service_visits",
      "service_visit_parts",
      "service_agreements",
      "service_billings",
    ),
    limitation:
      "Customer arrival and on-my-way notices are off until an email sender is configured; the synthetic customer's quote acceptance and site signatures are illustrative.",
  },
  equity: {
    ...executed(
      "equity_share_classes",
      "equity_class_amendments",
      "equity_plans",
      "equity_plan_reserve_changes",
      "equity_financing_rounds",
      "equity_securities",
      "equity_security_events",
      "equity_security_amendments",
      "equity_account_policies",
      "equity_compensation_runs",
      "equity_interest_runs",
      "equity_position_movements",
    ),
    limitation:
      "Synthetic founders, employees, investors and lender; board consents, 409A valuations, 83(b) filings and securities filings are illustrative and must be reviewed before relying on the cap table.",
  },
};

export function demoFeatureEvidence(industryKey: string): Record<string, DemoFeatureEvidence> {
  const features = sampleCompanyFeatures(industryKey);
  const evidence: Record<string, DemoFeatureEvidence> = {};
  for (const feature of FEATURES) {
    if (!features[feature.key]) continue;
    const entry = DEMO_FEATURE_EVIDENCE[feature.key];
    if (!entry)
      throw new Error(
        `Demo coverage is missing the ${feature.key} feature; add its native scenario and evidence before preparing demos.`,
      );
    evidence[feature.key] = entry;
  }
  return evidence;
}
