import { FEATURES } from "../organization/feature-registry.ts";
import { sampleCompanyFeatures } from "./features.ts";

export interface DemoFeatureEvidence {
  mode: "workflow" | "configuration" | "workspace" | "unsupported";
  tables: readonly string[];
  limitation?: string;
}
const workflow = (...tables: string[]): DemoFeatureEvidence => ({ mode: "workflow", tables });
const configuration = (...tables: string[]): DemoFeatureEvidence => ({ mode: "configuration", tables });
const workspace = (...tables: string[]): DemoFeatureEvidence => ({ mode: "workspace", tables });

/** Coverage is explicit so a newly shipped switch cannot disappear from demos. */
export const DEMO_FEATURE_EVIDENCE: Record<string, DemoFeatureEvidence> = {
  crm: workflow("crm_opportunities"), orders: workflow("documents"),
  revenueRecognition: configuration("recognition_rules"),
  subscriptionBilling: workflow("subscriptions"), advancedSubscriptions: configuration("subscription_plan_versions"),
  usageBilling: workflow("usage_records"), saasMetrics: workflow("saas_metrics_facts_monthly"),
  onlinePayments: { ...configuration("psp_provider_configs"), limitation: "Payment credentials must be configured; no real charges are made." },
  projects: workflow("projects"), timeTracking: workflow("time_entries"), fieldTime: configuration("time_kiosks"),
  fieldTickets: workflow("field_tickets"), projectScheduling: workflow("project_tasks", "schedule_calendars"),
  subcontracts: workflow("subcontracts", "subcontract_sov_lines"), preBilling: workflow("prebills"),
  resourcing: workflow("res_demand_lines"), resourceRequests: workflow("res_requests"), retainerBilling: workflow("res_retainers"),
  payroll: { ...configuration("pay_schedules", "employee_payroll_profiles", "pay_components", "pay_runs"), limitation: "US pack installed. Employer registrations, employee pay terms, and statutory inputs must be reviewed before calculation." },
  hrm: workflow("worker_employments", "worker_employment_versions"), hrmCompensation: configuration("hrm_pay_bands"),
  hrmPerformance: workflow("hrm_review_cycles", "hrm_goals"), hrmDocuments: configuration("hrm_document_templates"),
  hrmCertifications: workflow("hrm_worker_qualifications"), hrmSurveys: configuration("hrm_surveys", "hrm_survey_questions"),
  hrmRecruiting: workflow("hrm_requisitions"), hrmConstructionCompliance: configuration("hrm_rate_schedules", "hrm_rate_schedule_lines"),
  propertyManagement: workflow("managed_properties", "property_units", "property_leases", "lease_schedule_lines", "cam_pools"),
  subcontractorCompliance: workflow("compliance_records"), inventory: workflow("item_inventory_profiles", "inventory_movements", "cost_layers"),
  warehousing: workflow("warehouses", "stock_locations"), fulfillment: workflow("fulfillment_documents", "fulfillment_lines"),
  dropShipping: workflow("drop_ship_orders", "drop_ship_lines"), returnAuthorizations: workflow("rma_documents", "rma_lines"),
  customerPartNumbers: configuration("customer_item_refs"), barcodeScanning: configuration("item_identifiers"),
  manufacturing: workflow("bom_components", "mfg_routings", "mfg_work_orders"), manufacturingMrp: configuration("mfg_item_policies", "mfg_mrp_runs"),
  equipment: workflow("equipment_units"), expenses: workflow("documents"),
  multiSubsidiary: configuration("subsidiaries"), multiCurrency: configuration("fx_rates"),
  banking: workflow("bank_statements", "bank_statement_lines", "reconciliations"),
  bankFeeds: { ...configuration("bank_feed_connections"), limitation: "Disconnected synthetic feed; bank authentication requires configuration." },
  fixedAssets: workflow("asset_categories", "fixed_assets"), budgets: workflow("budget_scenarios", "budget_lines"),
  continuousClose: workspace("journal_entries"), advancedClose: configuration("close_blueprints", "close_blueprint_steps"),
  allocations: configuration("allocation_rules", "allocation_rule_versions", "allocation_rule_targets"),
  allocationsAtEntry: configuration("allocation_rules"), allocationsAtPosting: configuration("allocation_rules"),
  nonprofit: configuration("nonprofit_frameworks"), fundAccounting: configuration("segment_definitions", "funds"),
  grantManagement: workflow("grants"), pledges: workflow("pledges", "pledge_installments"), encumbrances: workflow("encumbrances"),
  functionalExpenses: configuration("functional_mappings"), form990: configuration("nonprofit_frameworks", "functional_mappings"),
  flows: configuration("flows"), automations: configuration("automations"), automationDateTriggers: configuration("automations"),
  automationFieldTriggers: { mode: "unsupported", tables: ["automations"], limitation: "Field-change recipes can be drafted, but event-trigger execution is not supported by the current automation engine." },
  automationWebhooks: { mode: "unsupported", tables: ["automations"], limitation: "Outbound webhook delivery is not supported by the current automation engine; this recipe remains a draft." },
  automationSimulator: workspace("automations"), apps: configuration("apps", "app_versions", "app_files"), scripts: configuration("user_scripts"),
  apiAccess: configuration("api_keys"), mcpAccess: configuration("api_keys"), queryConsole: workspace("journal_entries"),
  homeAnnouncements: workspace(), aiGovernanceLedger: configuration("ai_capabilities"),
};

export function demoFeatureEvidence(industryKey: string): Record<string, DemoFeatureEvidence> {
  const features = sampleCompanyFeatures(industryKey);
  const evidence: Record<string, DemoFeatureEvidence> = {};
  for (const feature of FEATURES) {
    if (!features[feature.key]) continue;
    const entry = DEMO_FEATURE_EVIDENCE[feature.key];
    if (!entry) throw new Error(`Demo coverage is missing the ${feature.key} feature; add its native scenario and evidence before preparing demos.`);
    evidence[feature.key] = entry;
  }
  return evidence;
}
