import { FEATURES, featureRequirements } from "../organization/feature-registry.ts";

/** The industry demos collectively expose the complete product switchboard. */
export const DEMO_FEATURES_BY_INDUSTRY: Record<string, readonly string[]> = {
  general_business: ["crm", "orders", "onlinePayments", "banking", "bankFeeds", "fixedAssets", "budgets", "continuousClose", "advancedClose", "multiSubsidiary", "multiCurrency", "allocations", "allocationsAtEntry", "allocationsAtPosting", "expenses", "equipment", "flows", "automations", "automationDateTriggers", "automationFieldTriggers", "automationWebhooks", "automationSimulator", "homeAnnouncements", "apps", "scripts", "apiAccess", "mcpAccess", "queryConsole", "aiGovernanceLedger"],
  construction_contractor: ["projects", "timeTracking", "fieldTime", "fieldTickets", "projectScheduling", "subcontracts", "wipBilling", "subcontractorCompliance", "equipment", "payroll", "hrm", "hrmConstructionCompliance", "hrmCertifications", "flows"],
  professional_services: ["projects", "timeTracking", "resourcing", "resourceRequests", "retainerBilling", "revenueRecognition", "wipBilling", "hrm", "hrmCompensation", "hrmPerformance", "hrmDocuments", "hrmSurveys", "hrmRecruiting", "flows"],
  engineering_architecture: ["projects", "timeTracking", "resourcing", "projectScheduling", "subcontracts", "wipBilling", "fixedAssets"],
  it_software_saas: ["subscriptionBilling", "advancedSubscriptions", "usageBilling", "saasMetrics", "revenueRecognition", "crm", "onlinePayments"],
  accounting_firm: ["projects", "timeTracking", "resourcing", "resourceRequests", "retainerBilling", "revenueRecognition", "wipBilling", "advancedClose", "flows"],
  wholesale_distribution: ["inventory", "orders", "warehousing", "fulfillment", "dropShipping", "returnAuthorizations", "customerPartNumbers", "barcodeScanning", "multiCurrency"],
  property_management: ["propertyManagement", "fixedAssets", "multiSubsidiary", "revenueRecognition", "onlinePayments"],
  nonprofit: ["nonprofit", "fundAccounting", "grantManagement", "pledges", "encumbrances", "functionalExpenses", "form990", "budgets", "allocations", "allocationsAtEntry", "allocationsAtPosting"],
  manufacturing: ["inventory", "orders", "warehousing", "manufacturing", "manufacturingMrp", "fixedAssets", "equipment"],
  healthcare_practice: ["hrm", "hrmCertifications", "hrmDocuments", "payroll", "inventory", "fixedAssets", "crm"],
};

/** Explicit demo overrides; dependency closure uses the authoritative registry. */
export function sampleCompanyFeatures(industryKey: string): Record<string, boolean> {
  const selected = DEMO_FEATURES_BY_INDUSTRY[industryKey];
  if (!selected) throw new Error(`Unknown sample-company industry: ${industryKey}`);
  const enabled = new Set([...selected, "banking", "budgets", "continuousClose", "expenses", "flows", "homeAnnouncements", "apps", "aiGovernanceLedger"]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const feature of FEATURES) {
      if (!enabled.has(feature.key)) continue;
      for (const required of featureRequirements(feature)) {
        if (!enabled.has(required)) { enabled.add(required); changed = true; }
      }
    }
  }
  return Object.fromEntries(FEATURES.map((feature) => [feature.key, enabled.has(feature.key)]));
}
